import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { parseAccountAction, parseAccountAck, type AccountAction, type AccountAck, type NotificationSetupState } from "../managed-sessions/live-workspace-contracts.js";

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

export type AccountRequest = { action: AccountAction; sender: string; ack?: AccountAck };
export type AccountRoom = { action: Extract<AccountAction, { operation: "room.ensure" }>; sender: string; verified: boolean; departure?: string; retired: boolean };
export type AccountTransmission = { requestId: string; recipient: string; deviceId: string; transactionId: string; payload: AccountAck };
export type RuleProgress = { roomId: string; ruleId: string; payload: unknown; state: NotificationSetupState };
/** Separate durable policy state: never reads or changes assistant questions/watermarks. */
export class AccountStore {
	private readonly db: DatabaseSync;
	private transactionDepth = 0;
	constructor(filename: string, ownerUserId: string) {
		this.db = new DatabaseSync(filename, { timeout: 100 });
		try {
			this.db.exec(`PRAGMA synchronous=FULL; PRAGMA secure_delete=ON; PRAGMA max_page_count=32768;
				PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE;
				CREATE TABLE IF NOT EXISTS identity(owner TEXT NOT NULL);
				CREATE TABLE IF NOT EXISTS account_requests(id TEXT PRIMARY KEY, sender TEXT NOT NULL, payload TEXT NOT NULL);
				CREATE TABLE IF NOT EXISTS notification_rules(id TEXT PRIMARY KEY, room TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL);
				CREATE TABLE IF NOT EXISTS account_rooms(room TEXT PRIMARY KEY, payload TEXT NOT NULL, sender TEXT NOT NULL, verified INTEGER NOT NULL DEFAULT 0, departure TEXT, retired INTEGER NOT NULL DEFAULT 0);
				CREATE TABLE IF NOT EXISTS account_outbox(id TEXT PRIMARY KEY, recipient TEXT NOT NULL, device TEXT NOT NULL, txn TEXT NOT NULL, payload TEXT NOT NULL);
				CREATE TABLE IF NOT EXISTS account_invites(room TEXT PRIMARY KEY, events TEXT NOT NULL);
				CREATE TABLE IF NOT EXISTS account_departures(event TEXT PRIMARY KEY, room TEXT NOT NULL);
				CREATE INDEX IF NOT EXISTS account_requests_room ON account_requests(json_extract(payload,'$.roomId'));
				COMMIT;`);
			this.atomic(() => {
				const columns = this.db.prepare("PRAGMA table_info(account_requests)").all().map(row => row.name);
				if (!columns.includes("ack")) this.db.exec("ALTER TABLE account_requests ADD COLUMN ack TEXT");
				if (!columns.includes("attempt")) this.db.exec("ALTER TABLE account_requests ADD COLUMN attempt INTEGER NOT NULL DEFAULT 0");
				const saved = this.db.prepare("SELECT owner FROM identity").get();
				if (saved && saved.owner !== ownerUserId) throw Error("Managed account owner changed; explicit recovery required");
				if (!saved) this.db.prepare("INSERT INTO identity VALUES (?)").run(ownerUserId);
				this.db.exec("UPDATE notification_rules SET state='uncertain' WHERE state='attempted'");
			});
		} catch (error) { this.db.close(); throw error; }
	}
	close(): void { this.db.close(); }
	/** Synchronous, all-or-nothing account intake before the shared cursor. */
	intakeBatch(fn: () => void): void { this.atomic(fn); }
	private atomic<T>(fn: () => T): T {
		if (this.transactionDepth) return fn();
		this.db.exec("BEGIN IMMEDIATE"); this.transactionDepth++;
		try { const result = fn(); this.db.exec("COMMIT"); return result; }
		catch (error) { this.db.exec("ROLLBACK"); throw error; }
		finally { this.transactionDepth--; }
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
					if (old.ack) this.queueAck(old.ack, configured.find(h => h.hostId === action.hostId)!);
					continue;
				}
				if (Number(this.db.prepare("SELECT count(*) AS n FROM account_requests").get()!.n) >= 16384) throw Error("Managed account intake capacity exhausted");
				this.db.prepare("INSERT INTO account_requests(id,sender,payload) VALUES (?,?,?)").run(action.requestId, sender, JSON.stringify(action)); count++;
			}
			for (const { action } of accepted) this.freezeRetirements(action.roomId);
			return count;
		});
	}
	/** Negative authority may precede verification; it never grants cleanup authority. */
	private freezeRetirements(roomId: string): void {
		const room = this.room(roomId); if (!room || room.action.kind === "coordinator" || room.action.kind === "host_space") return;
		if (room.retired) { this.invalidateEnsures(roomId); return; }
		for (const row of this.db.prepare("SELECT payload,sender FROM account_requests WHERE json_extract(payload,'$.roomId')=?").all(roomId)) {
			const action = parseAccountAction(JSON.parse(String(row.payload)));
			if (row.sender !== room.sender || action.hostId !== room.action.hostId) continue;
			if (action.operation === "room.retire" && room.action.kind === "conversation" && action.conversationId === room.action.conversationId ||
				action.operation === "space.retire" && ["project_space", "worktree_space"].includes(room.action.kind) && action.hostSpaceId === room.action.hostSpaceId) {
				this.db.prepare("UPDATE account_rooms SET retired=1 WHERE room=?").run(roomId);
				this.invalidateEnsures(roomId);
			}
		}
	}
	private invalidateEnsures(roomId: string): void {
		this.db.prepare("DELETE FROM account_outbox WHERE id IN (SELECT id FROM account_requests WHERE json_extract(payload,'$.roomId')=? AND json_extract(payload,'$.operation')='room.ensure')").run(roomId);
		this.db.prepare("UPDATE account_requests SET ack=NULL WHERE json_extract(payload,'$.roomId')=? AND json_extract(payload,'$.operation')='room.ensure'").run(roomId);
	}
	get(requestId: string): AccountRequest | undefined {
		const row = this.db.prepare("SELECT * FROM account_requests WHERE id=?").get(requestId);
		if (!row) return;
		return { action: parseAccountAction(JSON.parse(String(row.payload))), sender: String(row.sender), ...(row.ack ? { ack: parseAccountAck(JSON.parse(String(row.ack))) } : {}) };
	}
	/** Round-robin pending work; a broken room cannot monopolize the consumer. */
	nextRequest(hosts: readonly AccountHost[]): AccountRequest | undefined {
		if (!hosts.length) return;
		return this.atomic(() => {
			const scope = hosts.map(() => "(sender=? AND json_extract(payload,'$.hostId')=?)").join(" OR ");
			const row = this.db.prepare(`SELECT id FROM account_requests WHERE (ack IS NULL OR json_extract(ack,'$.status')='pending') AND (${scope}) ORDER BY attempt,id LIMIT 1`).get(...hosts.flatMap(h => [h.botUserId, h.hostId]));
			if (!row) return;
			this.db.prepare("UPDATE account_requests SET attempt=(SELECT COALESCE(MAX(attempt),0)+1 FROM account_requests) WHERE id=?").run(String(row.id));
			return this.get(String(row.id));
		});
	}
	private queueAck(ack: AccountAck, host: AccountHost): void {
		const previous = this.db.prepare("SELECT * FROM account_outbox WHERE id=?").get(ack.requestId);
		const payload = JSON.stringify(ack);
		// Uncertain sends retain the transaction and payload. A new progress value
		// or an intentional redelivery after a successful send gets a new transaction.
		if (previous && previous.payload === payload && previous.recipient === host.botUserId && previous.device === host.deviceId) return;
		this.db.prepare("INSERT OR REPLACE INTO account_outbox VALUES (?,?,?,?,?)").run(ack.requestId, host.botUserId, host.deviceId, `pi-account-${randomUUID()}`, payload);
	}
	acknowledge(requestId: string, host: AccountHost, status: AccountAck["status"], code?: AccountAck["code"]): void {
		this.atomic(() => this.writeAck(requestId, host, status, code));
	}
	private writeAck(requestId: string, host: AccountHost, status: AccountAck["status"], code?: AccountAck["code"]): void {
			const request = this.get(requestId); if (!request || request.action.hostId !== host.hostId || request.sender !== host.botUserId) throw Error("Account acknowledgement scope changed");
			const { version, payloadDigest, hostId } = request.action;
			const departureEventId = code === "departed" ? this.room(request.action.roomId)?.departure : undefined;
			const ack = parseAccountAck({ version, requestId, payloadDigest, hostId, status, ...(code ? { code } : {}), ...(departureEventId ? { departureEventId } : {}) });
			this.db.prepare("UPDATE account_requests SET ack=? WHERE id=?").run(JSON.stringify(ack), requestId); this.queueAck(ack, host);
	}
	transmission(hosts?: readonly AccountHost[]): AccountTransmission | undefined {
		if (hosts && !hosts.length) return;
		return this.atomic(() => {
			const scope = hosts?.map(() => "(recipient=? AND device=? AND json_extract(payload,'$.hostId')=?)").join(" OR ");
			const row = this.db.prepare(`SELECT * FROM account_outbox ${scope ? `WHERE ${scope}` : ""} ORDER BY rowid LIMIT 1`).get(...(hosts?.flatMap(h => [h.botUserId, h.deviceId, h.hostId]) ?? [])); if (!row) return;
			// Rotate independent recipients without changing an uncertain transmission.
			this.db.prepare("DELETE FROM account_outbox WHERE id=?").run(String(row.id));
			this.db.prepare("INSERT INTO account_outbox VALUES (?,?,?,?,?)").run(String(row.id), String(row.recipient), String(row.device), String(row.txn), String(row.payload));
			return { requestId: String(row.id), recipient: String(row.recipient), deviceId: String(row.device), transactionId: String(row.txn), payload: parseAccountAck(JSON.parse(String(row.payload))) };
		});
	}
	transmitted(value: AccountTransmission): void {
		this.atomic(() => this.db.prepare("DELETE FROM account_outbox WHERE id=? AND txn=?").run(value.requestId, value.transactionId));
	}
	room(roomId: string): AccountRoom | undefined {
		const row = this.db.prepare("SELECT * FROM account_rooms WHERE room=?").get(roomId); if (!row) return;
		const action = parseAccountAction(JSON.parse(String(row.payload)));
		if (action.operation !== "room.ensure" || action.roomId !== roomId || typeof row.verified !== "number" || ![0, 1].includes(row.verified) || typeof row.retired !== "number" || ![0, 1].includes(row.retired) ||
			(row.departure !== null && (typeof row.departure !== "string" || !/^\$[^\s]{1,254}$/.test(row.departure)))) throw Error("Invalid saved account room");
		return { action, sender: String(row.sender), verified: row.verified === 1, retired: row.retired === 1, ...(row.departure ? { departure: String(row.departure) } : {}) };
	}
	pinRoom(action: Extract<AccountAction, { operation: "room.ensure" }>, sender: string): AccountRoom {
		return this.atomic(() => {
			const old = this.room(action.roomId);
			const identity = (a: typeof action) => { const { requestId, payloadDigest, notificationSetup, ...identity } = a; return identity; };
			if (old) {
				if (old.sender !== sender || !isDeepStrictEqual(identity(old.action), identity(action))) throw Error("Managed account room identity changed");
				if (action.notificationSetup === "preserve" && old.action.notificationSetup !== "preserve") {
					this.db.prepare("UPDATE account_rooms SET payload=? WHERE room=?").run(JSON.stringify(action), action.roomId);
					return this.room(action.roomId)!;
				}
				return old;
			}
			if (Number(this.db.prepare("SELECT count(*) AS n FROM account_rooms").get()!.n) >= 8192) throw Error("Managed account room capacity exhausted");
			this.db.prepare("INSERT INTO account_rooms(room,payload,sender) VALUES (?,?,?)").run(action.roomId, JSON.stringify(action), sender);
			this.freezeRetirements(action.roomId);
			return this.room(action.roomId)!;
		});
	}
	verified(roomId: string): void { this.atomic(() => this.db.prepare("UPDATE account_rooms SET verified=1 WHERE room=?").run(roomId)); }
	departed(roomId: string, eventId: string): void {
		if (!/^\$[^\s]{1,254}$/.test(eventId)) throw Error("Invalid account departure event");
		this.atomic(() => {
			const room = this.room(roomId); if (!room || this.db.prepare("SELECT 1 FROM account_departures WHERE event=?").get(eventId)) return;
			if (Number(this.db.prepare("SELECT count(*) AS n FROM account_departures").get()!.n) >= 16384) throw Error("Account departure capacity exhausted");
			this.db.prepare("INSERT INTO account_departures VALUES (?,?)").run(eventId, roomId);
			this.db.prepare("UPDATE account_rooms SET departure=?, retired=? WHERE room=?").run(eventId, room.action.kind === "conversation" || room.retired ? 1 : 0, roomId);
			this.db.prepare("DELETE FROM account_invites WHERE room=?").run(roomId);
			this.invalidateEnsures(roomId);
		});
	}
	saveInvite(roomId: string, events: unknown): void {
		if (roomId.length > 255 || Buffer.byteLength(JSON.stringify(events)) > 16384) throw Error("Account invitation exceeds bounds");
		this.atomic(() => {
			if (!this.db.prepare("SELECT 1 FROM account_invites WHERE room=?").get(roomId) && Number(this.db.prepare("SELECT count(*) AS n FROM account_invites").get()!.n) >= 8192) throw Error("Account invitation capacity exhausted");
			this.db.prepare("INSERT OR REPLACE INTO account_invites VALUES (?,?)").run(roomId, JSON.stringify(events));
		});
	}
	invite(roomId: string): unknown | undefined { const row = this.db.prepare("SELECT events FROM account_invites WHERE room=?").get(roomId); return row ? JSON.parse(String(row.events)) : undefined; }
	retire(roomId: string): void {
		this.atomic(() => {
			const room = this.room(roomId); if (!room?.verified || room.action.kind === "coordinator" || room.action.kind === "host_space") throw Error("Account retirement authority unavailable");
			this.db.prepare("UPDATE account_rooms SET retired=1 WHERE room=?").run(roomId);
		});
	}
	restored(roomId: string, departure: string, requestId: string, host: AccountHost): void {
		this.atomic(() => {
			const room = this.room(roomId);
			if (!room?.verified || room.action.kind !== "coordinator" || room.retired || room.departure !== departure) throw Error("Coordinator departure changed");
			this.db.prepare("UPDATE account_rooms SET departure=NULL WHERE room=?").run(roomId);
			this.invalidateEnsures(roomId);
			this.writeAck(requestId, host, "complete");
		});
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
