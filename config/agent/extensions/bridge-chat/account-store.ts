import { DatabaseSync } from "node:sqlite";
import { parseAccountAction, type AccountAction, type NotificationSetupState } from "../managed-sessions/live-workspace-contracts.js";

export const ACCOUNT_REQUEST_EVENT = "lol.bepis.pi.account.request.v1";
export const ACCOUNT_ACK_EVENT = "lol.bepis.pi.account.ack.v1";
export type AccountHost = { hostId: string; botUserId: string; deviceId: string };
export function accountHosts(value: unknown): AccountHost[] {
	if (!Array.isArray(value) || value.length > 64) throw Error("Invalid managed account host configuration");
	const hosts = value.map((raw) => {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw Error("Invalid managed account host configuration");
		const h = raw as Record<string, unknown>;
		if (Object.keys(h).sort().join(",") !== "botUserId,deviceId,hostId" || typeof h.hostId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(h.hostId) ||
			typeof h.botUserId !== "string" || h.botUserId.length > 255 || !/^@[^\s:]+:[^\s]+$/.test(h.botUserId) ||
			typeof h.deviceId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(h.deviceId)) throw Error("Invalid managed account host configuration");
		return { hostId: h.hostId, botUserId: h.botUserId, deviceId: h.deviceId };
	});
	if (new Set(hosts.map(h => h.hostId)).size !== hosts.length || new Set(hosts.map(h => h.botUserId)).size !== hosts.length) throw Error("Managed account host mapping must be one-to-one");
	return hosts;
}

export type AccountRequest = { action: AccountAction; sender: string };
export type RuleProgress = { roomId: string; ruleId: string; payload: unknown; state: NotificationSetupState };
/** Separate durable policy state: never reads or changes assistant questions/watermarks. */
export class AccountStore {
	private readonly db: DatabaseSync;
	constructor(filename: string, ownerUserId: string) {
		this.db = new DatabaseSync(filename, { timeout: 100 });
		try {
			this.db.exec(`PRAGMA synchronous=FULL; PRAGMA secure_delete=ON; PRAGMA max_page_count=32768;
				PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE;
				CREATE TABLE IF NOT EXISTS identity(owner TEXT NOT NULL);
				CREATE TABLE IF NOT EXISTS account_requests(id TEXT PRIMARY KEY, sender TEXT NOT NULL, payload TEXT NOT NULL);
				CREATE TABLE IF NOT EXISTS notification_rules(id TEXT PRIMARY KEY, room TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL);
				COMMIT;`);
			this.atomic(() => {
				const saved = this.db.prepare("SELECT owner FROM identity").get();
				if (saved && saved.owner !== ownerUserId) throw Error("Managed account owner changed; explicit recovery required");
				if (!saved) this.db.prepare("INSERT INTO identity VALUES (?)").run(ownerUserId);
				this.db.exec("UPDATE notification_rules SET state='uncertain' WHERE state='attempted'");
			});
		} catch (error) { this.db.close(); throw error; }
	}
	close(): void { this.db.close(); }
	private atomic<T>(fn: () => T): T {
		this.db.exec("BEGIN IMMEDIATE");
		try { const result = fn(); this.db.exec("COMMIT"); return result; }
		catch (error) { this.db.exec("ROLLBACK"); throw error; }
	}
	/** Call before committing the transport's shared sync cursor. Duplicate batches are safe. */
	ingest(events: unknown, configured: readonly AccountHost[]): number {
		if (!Array.isArray(events) || events.length > 1024) throw Error("Managed account intake exceeds bounds");
		const accepted: Array<{ action: AccountAction; sender: string }> = [];
		for (const raw of events) {
			if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
			const event = raw as Record<string, unknown>;
			if (event.type !== ACCOUNT_REQUEST_EVENT || typeof event.sender !== "string") continue;
			const host = configured.find(h => h.botUserId === event.sender); if (!host) continue;
			try { const action = parseAccountAction(event.content); if (action.hostId === host.hostId) accepted.push({ action, sender: event.sender }); }
			catch { /* Invalid/forged frames neither gain authority nor produce an arbitrary reply. */ }
		}
		return this.atomic(() => {
			let count = 0;
			for (const { action, sender } of accepted) {
				const old = this.get(action.requestId);
				if (old) {
					if (old.sender !== sender || old.action.payloadDigest !== action.payloadDigest) throw Error("Conflicting managed account identity");
					continue;
				}
				if (Number(this.db.prepare("SELECT count(*) AS n FROM account_requests").get()!.n) >= 16384) throw Error("Managed account intake capacity exhausted");
				this.db.prepare("INSERT INTO account_requests(id,sender,payload) VALUES (?,?,?)").run(action.requestId, sender, JSON.stringify(action)); count++;
			}
			return count;
		});
	}
	get(requestId: string): AccountRequest | undefined {
		const row = this.db.prepare("SELECT * FROM account_requests WHERE id=?").get(requestId);
		if (!row) return;
		return { action: parseAccountAction(JSON.parse(String(row.payload))), sender: String(row.sender) };
	}
	rule(ruleId: string): RuleProgress | undefined {
		const row = this.db.prepare("SELECT * FROM notification_rules WHERE id=?").get(ruleId);
		if (!row) return;
		return { roomId: String(row.room), ruleId, payload: JSON.parse(String(row.payload)), state: String(row.state) as NotificationSetupState };
	}
	prepareRule(roomId: string, ruleId: string, payload: unknown): RuleProgress {
		if (roomId.length > 255 || ruleId.length > 255 || Buffer.byteLength(JSON.stringify(payload)) > 4096) throw Error("Notification rule exceeds bounds");
		return this.atomic(() => {
			const old = this.rule(ruleId);
			if (old) {
				if (old.roomId !== roomId || JSON.stringify(old.payload) !== JSON.stringify(payload)) throw Error("Notification rule identity changed");
				return old;
			}
			if (Number(this.db.prepare("SELECT count(*) AS n FROM notification_rules").get()!.n) >= 8192) throw Error("Notification rule capacity exhausted");
			this.db.prepare("INSERT INTO notification_rules VALUES (?,?,?,'unattempted')").run(ruleId, roomId, JSON.stringify(payload));
			return this.rule(ruleId)!;
		});
	}
	transitionRule(ruleId: string, state: Exclude<NotificationSetupState, "unattempted">): void {
		this.atomic(() => {
			const old = this.rule(ruleId); if (!old) throw Error("Unknown notification rule");
			const allowed = old.state === "unattempted" ? ["attempted", "preserved"] : old.state === "attempted" || old.state === "uncertain" ? ["confirmed", "uncertain"] : [];
			if (!allowed.includes(state)) throw Error("Invalid notification rule transition");
			this.db.prepare("UPDATE notification_rules SET state=? WHERE id=?").run(state, ruleId);
		});
	}
}
