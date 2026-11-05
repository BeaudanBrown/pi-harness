import { accountSchedulingDiagnostics, type AccountWorkClass, type AccountDiagnosticItem, type AccountSchedulingDiagnostics } from "../matrix-shared/account-diagnostics.js";
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
	private turn = 0;
	private readonly lanes = ["control", "interactive", "interactive", "ordinary", "maintenance"];
	private readonly laneSql = `CASE WHEN json_extract(payload,'$.operation') IN ('room.retire','space.retire','room.membership.cancel') THEN 'control'
		WHEN json_extract(ack,'$.code')='unverified' THEN 'maintenance'
		WHEN json_extract(payload,'$.operation') LIKE '%membership.%' THEN 'interactive' ELSE 'ordinary' END`;
	constructor(filename: string, ownerUserId: string, private readonly now = Date.now) {
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
				CREATE TABLE IF NOT EXISTS account_schedule(id INTEGER PRIMARY KEY CHECK(id=1), retry_at INTEGER NOT NULL);
				INSERT OR IGNORE INTO account_schedule VALUES (1,0);
				CREATE INDEX IF NOT EXISTS account_requests_room ON account_requests(json_extract(payload,'$.roomId'));
				COMMIT;`);
			this.atomic(() => {
				const columns = this.db.prepare("PRAGMA table_info(account_requests)").all().map(row => row.name);
				if (!columns.includes("ack")) this.db.exec("ALTER TABLE account_requests ADD COLUMN ack TEXT");
				if (!columns.includes("revision")) {
					if (this.db.prepare("SELECT 1 FROM account_requests WHERE ack IS NOT NULL LIMIT 1").get()) throw Error("Unversioned account progress requires explicit recovery");
					this.db.exec("ALTER TABLE account_requests ADD COLUMN revision INTEGER NOT NULL DEFAULT 0");
				}
				if (!columns.includes("attempt")) this.db.exec("ALTER TABLE account_requests ADD COLUMN attempt INTEGER NOT NULL DEFAULT 0");
				if (!columns.includes("membership_admitted")) this.db.exec("ALTER TABLE account_requests ADD COLUMN membership_admitted INTEGER NOT NULL DEFAULT 0");
				if (!columns.includes("membership_attempt")) this.db.exec("ALTER TABLE account_requests ADD COLUMN membership_attempt INTEGER NOT NULL DEFAULT 0");
				for (const table of ["account_requests", "account_outbox"]) {
					const fields = this.db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name);
					if (!fields.includes("next_at")) this.db.exec(`ALTER TABLE ${table} ADD COLUMN next_at INTEGER NOT NULL DEFAULT 0 CHECK(next_at>=0)`);
					if (!fields.includes("retries")) this.db.exec(`ALTER TABLE ${table} ADD COLUMN retries INTEGER NOT NULL DEFAULT 0 CHECK(retries BETWEEN 0 AND 8)`);
				}
				if (!this.db.prepare("PRAGMA table_info(account_rooms)").all().some(row => row.name === "observed_join")) this.db.exec("ALTER TABLE account_rooms ADD COLUMN observed_join TEXT");
				const saved = this.db.prepare("SELECT owner FROM identity").get();
				if (saved && saved.owner !== ownerUserId) throw Error("Managed account owner changed; explicit recovery required");
				if (!saved) this.db.prepare("INSERT INTO identity VALUES (?)").run(ownerUserId);
				if (this.db.prepare("SELECT 1 FROM notification_rules WHERE id GLOB 'pi-managed-silent-[0-9a-f]*' LIMIT 1").get()) throw Error("Legacy notification override requires explicit recovery");
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
					// A duplicate can be host redelivery after an uncertain ack send.
					// Drain those frozen bytes/transaction before treating it as fresh demand.
					if (action.operation === "room.membership.inspect" && old.ack?.status === "complete" && !this.db.prepare("SELECT 1 FROM account_outbox WHERE id=?").get(action.requestId)) {
						this.db.prepare("UPDATE account_requests SET ack=NULL,next_at=?,retries=0 WHERE id=?").run(this.now(), action.requestId);
						this.db.prepare("DELETE FROM account_outbox WHERE id=?").run(action.requestId);
					} else if (old.ack) this.queueAck(old.ack, configured.find(h => h.hostId === action.hostId)!);
					continue;
				}
				if (Number(this.db.prepare("SELECT count(*) AS n FROM account_requests").get()!.n) >= 16384) throw Error("Managed account intake capacity exhausted");
				this.db.prepare("INSERT INTO account_requests(id,sender,payload,next_at) VALUES (?,?,?,?)").run(action.requestId, sender, JSON.stringify(action), this.now()); count++;
				if (["room.membership.authorize", "room.membership.confirm", "room.membership.cancel"].includes(action.operation)) this.wakeRoom(action.roomId);
			}
			for (const { action } of accepted) this.freezeRetirements(action.roomId);
			return count;
		});
	}
	/** Negative authority may precede verification; it never grants cleanup authority. */
	private freezeRetirements(roomId: string): void {
		const room = this.room(roomId); if (!room || room.action.kind === "coordinator" || room.action.kind === "host_space") return;
		if (room.retired) return;
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
		this.db.prepare("UPDATE account_requests SET ack=NULL,next_at=?,retries=0 WHERE json_extract(payload,'$.roomId')=? AND json_extract(payload,'$.operation')='room.ensure'").run(this.now(), roomId);
	}
	get(requestId: string): AccountRequest | undefined {
		const row = this.db.prepare("SELECT * FROM account_requests WHERE id=?").get(requestId);
		if (!row) return;
		return { action: parseAccountAction(JSON.parse(String(row.payload))), sender: String(row.sender), ...(row.ack ? { ack: parseAccountAck(JSON.parse(String(row.ack))) } : {}) };
	}
	private wakeRoom(roomId: string): void {
		this.db.prepare("UPDATE account_requests SET next_at=?,retries=0 WHERE json_extract(payload,'$.roomId')=? AND (ack IS NULL OR json_extract(ack,'$.status')='pending')").run(this.now(), roomId);
	}
	deferTransport(milliseconds: number): void {
		if (!Number.isFinite(milliseconds) || milliseconds < 0) return;
		this.atomic(() => this.db.prepare("UPDATE account_schedule SET retry_at=MAX(retry_at,?) WHERE id=1").run(this.now() + Math.ceil(milliseconds)));
	}
	private cooldown(): number { return Number(this.db.prepare("SELECT retry_at FROM account_schedule WHERE id=1").get()!.retry_at); }
	/** Read only through the owning connection; no selection, cursor or hint writes. */
	diagnostics(hosts: readonly AccountHost[], state: AccountSchedulingDiagnostics["state"], active: { work?: string; ack?: string } = {}): AccountSchedulingDiagnostics {
		const now = this.now(), cooldown = this.cooldown(), items: AccountDiagnosticItem[] = [];
		if (hosts.length) {
			const scope = hosts.map(() => "(sender=? AND json_extract(payload,'$.hostId')=?)").join(" OR ");
			for (const r of this.db.prepare(`SELECT id,next_at,(${this.laneSql}) AS lane,json_extract(ack,'$.status') AS status,json_extract(ack,'$.code') AS code FROM account_requests WHERE ${scope}`).all(...hosts.flatMap(h => [h.botUserId, h.hostId]))) {
				const dueAt = Number(r.next_at) || now;
				items.push({ kind: r.lane as AccountWorkClass, state: active.work === r.id ? "inFlight" : r.status && r.status !== "pending" ? "settled" : state === "suspended" ? "blocked" : Math.max(dueAt, cooldown) > now ? "parked" : "due", dueAt, progress: typeof r.code === "string" ? r.code : undefined });
			}
			const scopeAck = hosts.map(() => "(recipient=? AND device=? AND json_extract(payload,'$.hostId')=?)").join(" OR ");
			for (const r of this.db.prepare(`SELECT id,next_at FROM account_outbox WHERE ${scopeAck}`).all(...hosts.flatMap(h => [h.botUserId, h.deviceId, h.hostId]))) {
				const dueAt = Number(r.next_at) || now;
				items.push({ kind: "acknowledgement", state: active.ack === r.id ? "inFlight" : state === "suspended" ? "blocked" : Math.max(dueAt, cooldown) > now ? "parked" : "due", dueAt });
			}
		}
		return accountSchedulingDiagnostics(now, state, cooldown, items);
	}
	dueDelay(hosts: readonly AccountHost[]): number {
		if (!hosts.length || this.cooldown() > this.now()) return 1000;
		const requestScope = hosts.map(() => "(sender=? AND json_extract(payload,'$.hostId')=?)").join(" OR ");
		const ackScope = hosts.map(() => "(recipient=? AND device=? AND json_extract(payload,'$.hostId')=?)").join(" OR ");
		const work = this.db.prepare(`SELECT MIN(next_at) AS due FROM account_requests WHERE (ack IS NULL OR json_extract(ack,'$.status')='pending') AND (${requestScope})`).get(...hosts.flatMap(h => [h.botUserId, h.hostId]))!.due;
		const ack = this.db.prepare(`SELECT MIN(next_at) AS due FROM account_outbox WHERE ${ackScope}`).get(...hosts.flatMap(h => [h.botUserId, h.deviceId, h.hostId]))!.due;
		return Math.max(0, Math.min(1000, work === null ? Infinity : Number(work) - this.now(), ack === null ? Infinity : Number(ack) - this.now()));
	}
	/** Weighted lanes, oldest due first; scheduling hints never authorize effects. */
	nextRequest(hosts: readonly AccountHost[]): AccountRequest | undefined {
		if (!hosts.length || this.cooldown() > this.now()) return;
		return this.atomic(() => {
			const scope = hosts.map(() => "(sender=? AND json_extract(payload,'$.hostId')=?)").join(" OR ");
			for (let i = 0; i < this.lanes.length; i++) {
				const index = (this.turn + i) % this.lanes.length;
				const row = this.db.prepare(`SELECT id,retries FROM account_requests WHERE (ack IS NULL OR json_extract(ack,'$.status')='pending') AND (${scope}) AND next_at<=? AND (${this.laneSql})=? ORDER BY next_at,COALESCE(json_extract(payload,'$.expiresAt'),9223372036854775807),attempt,id LIMIT 1`).get(...hosts.flatMap(h => [h.botUserId, h.hostId]), this.now(), this.lanes[index]);
				if (!row) continue;
				const retries = Math.min(8, Number(row.retries) + 1);
				this.db.prepare("UPDATE account_requests SET attempt=(SELECT COALESCE(MAX(attempt),0)+1 FROM account_requests),next_at=?,retries=? WHERE id=?").run(this.now() + Math.min(300_000, 30_000 * 2 ** (retries - 1)), retries, String(row.id));
				this.turn = (index + 1) % this.lanes.length;
				return this.get(String(row.id));
			}
		});
	}
	private queueAck(ack: AccountAck, host: AccountHost): void {
		const previous = this.db.prepare("SELECT * FROM account_outbox WHERE id=?").get(ack.requestId);
		const payload = JSON.stringify(ack);
		// Uncertain sends retain the transaction and payload. A new progress value
		// or an intentional redelivery after a successful send gets a new transaction.
		if (previous && previous.payload === payload && previous.recipient === host.botUserId && previous.device === host.deviceId) return;
		this.db.prepare("INSERT OR REPLACE INTO account_outbox(id,recipient,device,txn,payload,next_at,retries) VALUES (?,?,?,?,?,?,0)").run(ack.requestId, host.botUserId, host.deviceId, `pi-account-${randomUUID()}`, payload, this.now());
	}
	acknowledge(requestId: string, host: AccountHost, status: AccountAck["status"], code?: AccountAck["code"]): void {
		this.atomic(() => this.writeAck(requestId, host, status, code));
	}
	private writeAck(requestId: string, host: AccountHost, status: AccountAck["status"], code?: AccountAck["code"]): void {
			const request = this.get(requestId); if (!request || request.action.hostId !== host.hostId || request.sender !== host.botUserId) throw Error("Account acknowledgement scope changed");
			const { version, payloadDigest, hostId } = request.action;
			const departureEventId = code === "departed" ? this.room(request.action.roomId)?.departure : undefined;
			const previous = Number(this.db.prepare("SELECT revision FROM account_requests WHERE id=?").get(requestId)!.revision);
			if (!Number.isSafeInteger(previous) || previous < 0) throw Error("Invalid account progress revision");
			const inspected = request.action.operation === "room.membership.inspect" ? this.room(request.action.roomId) : undefined;
			const membershipRepair = inspected && inspected.sender === request.sender && inspected.action.conversationId === (request.action as Extract<AccountAction, { operation: "room.membership.inspect" }>).conversationId
				? { capability: "original-room-repair-v1", retired: inspected.retired, ...(inspected.departure ? { departureEventId: inspected.departure } : {}) } : undefined;
			const next = { version, requestId, payloadDigest, hostId, status, ...(code ? { code } : {}), ...(departureEventId ? { departureEventId } : {}), ...(membershipRepair ? { membershipRepair } : {}) };
			const unchanged = request.ack && isDeepStrictEqual(request.ack, { ...next, revision: previous });
			const ack = parseAccountAck({ ...next, revision: unchanged ? previous : previous + 1 });
			this.db.prepare("UPDATE account_requests SET ack=?,revision=? WHERE id=?").run(JSON.stringify(ack), ack.revision, requestId); this.queueAck(ack, host);
	}
	transmission(hosts?: readonly AccountHost[]): AccountTransmission | undefined {
		if (hosts && !hosts.length || this.cooldown() > this.now()) return;
		return this.atomic(() => {
			const scope = hosts?.map(() => "(recipient=? AND device=? AND json_extract(payload,'$.hostId')=?)").join(" OR ");
			const row = this.db.prepare(`SELECT * FROM account_outbox WHERE next_at<=? ${scope ? `AND (${scope})` : ""} ORDER BY next_at,rowid LIMIT 1`).get(this.now(), ...(hosts?.flatMap(h => [h.botUserId, h.deviceId, h.hostId]) ?? [])); if (!row) return;
			const retries = Math.min(8, Number(row.retries) + 1);
			// Freeze retry timing before HTTP without changing uncertain bytes/txn.
			this.db.prepare("UPDATE account_outbox SET next_at=?,retries=? WHERE id=?").run(this.now() + Math.min(300_000, 30_000 * 2 ** (retries - 1)), retries, String(row.id));
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
			const departure = this.db.prepare("SELECT event FROM account_departures WHERE room=? ORDER BY rowid DESC LIMIT 1").get(action.roomId)?.event;
			this.db.prepare("INSERT INTO account_rooms(room,payload,sender,departure,retired) VALUES (?,?,?,?,?)").run(action.roomId, JSON.stringify(action), sender, departure ?? null, departure && action.kind === "conversation" ? 1 : 0);
			this.freezeRetirements(action.roomId);
			return this.room(action.roomId)!;
		});
	}
	verified(roomId: string): void { this.atomic(() => {
		if (!this.room(roomId)?.verified) { this.db.prepare("UPDATE account_rooms SET verified=1 WHERE room=?").run(roomId); this.wakeRoom(roomId); }
	}); }
	/** Scheduling evidence only: a sync join never grants repair/room authority. */
	observedJoin(roomId: string, eventId: string): void {
		if (!/^\$[^\s]{1,254}$/.test(eventId)) throw Error("Invalid observed account join");
		this.atomic(() => {
			const row = this.db.prepare("SELECT observed_join FROM account_rooms WHERE room=?").get(roomId);
			if (!row || row.observed_join === eventId) return;
			this.db.prepare("UPDATE account_rooms SET observed_join=? WHERE room=?").run(eventId, roomId); this.wakeRoom(roomId);
		});
	}
	tracksMembership(roomId: string): boolean {
		return Boolean(this.room(roomId) || this.invite(roomId) || this.db.prepare("SELECT 1 FROM account_departures WHERE room=? LIMIT 1").get(roomId));
	}
	departed(roomId: string, eventId: string): void {
		if (!/^\$[^\s]{1,254}$/.test(eventId)) throw Error("Invalid account departure event");
		this.atomic(() => {
			const room = this.room(roomId); if (!this.tracksMembership(roomId) || this.db.prepare("SELECT 1 FROM account_departures WHERE event=?").get(eventId)) return;
			if (Number(this.db.prepare("SELECT count(*) AS n FROM account_departures").get()!.n) >= 16384) throw Error("Account departure capacity exhausted");
			this.db.prepare("INSERT INTO account_departures VALUES (?,?)").run(eventId, roomId);
			if (room) this.db.prepare("UPDATE account_rooms SET departure=?, retired=? WHERE room=?").run(eventId, room.retired || room.action.kind === "conversation" && !this.protectsDeparture(room, eventId) ? 1 : 0, roomId);
			this.db.prepare("DELETE FROM account_invites WHERE room=?").run(roomId);
			this.invalidateEnsures(roomId);
		});
	}
	/** Only an authenticated, unexpired exact request may protect a not-yet-retired room. */
	private protectsDeparture(room: AccountRoom, eventId: string): boolean {
		if (room.retired || !room.verified) return false;
		return this.db.prepare("SELECT id FROM account_requests WHERE json_extract(payload,'$.roomId')=? AND json_extract(payload,'$.operation')='room.membership.restore'").all(room.action.roomId).some(row => {
			const r = this.get(String(row.id))!; const a = r.action;
			return a.operation === "room.membership.restore" && this.db.prepare("SELECT membership_admitted FROM account_requests WHERE id=?").get(a.requestId)?.membership_admitted === 1 && !this.membershipCancelled(r) && r.sender === room.sender && a.hostId === room.action.hostId && a.conversationId === room.action.conversationId && a.hostSpaceId === room.action.hostSpaceId &&
				(a.membership === "leave" ? a.membershipEventId : a.departureEventId) === eventId && a.expiresAt > this.now() && a.expiresAt <= this.now() + 600_000 && (!r.ack || r.ack.status === "pending") &&
				(room.departure === undefined || room.departure === a.departureEventId || room.departure === eventId);
		});
	}
	private membershipCancelled(request: AccountRequest): boolean {
		const action = request.action; if (action.operation !== "room.membership.restore") return true;
		return this.db.prepare("SELECT id FROM account_requests WHERE json_extract(payload,'$.roomId')=? AND json_extract(payload,'$.operation')='room.membership.cancel'").all(action.roomId).some(row => {
			const cancel = this.get(String(row.id))!; const a = cancel.action;
			return a.operation === "room.membership.cancel" && cancel.sender === request.sender && a.hostId === action.hostId && a.conversationId === action.conversationId && a.operationId === action.operationId;
		});
	}
	assertMembershipRepair(requestId: string): AccountRoom {
		const r = this.get(requestId); const a = r?.action;
		if (!r || a?.operation !== "room.membership.restore") throw Error("Membership repair request is unavailable");
		const room = this.room(a.roomId);
		if (!room?.verified || room.retired || this.membershipCancelled(r) || !["conversation", "coordinator"].includes(room.action.kind) || r.sender !== room.sender || a.hostId !== room.action.hostId ||
			a.conversationId !== room.action.conversationId || a.hostSpaceId !== room.action.hostSpaceId || a.expiresAt <= this.now() || a.expiresAt > this.now() + 600_000 ||
			(room.departure !== a.departureEventId && !(a.membership === "leave" && room.departure === a.membershipEventId))) throw Error("Membership repair expired, terminal or changed");
		return room;
	}
	recheckDepartures(): void {
		this.atomic(() => {
			for (const row of this.db.prepare("SELECT room FROM account_rooms WHERE retired=0 AND departure IS NOT NULL AND json_extract(payload,'$.kind')='conversation'").all()) {
				const room = this.room(String(row.room))!;
				if (!this.protectsDeparture(room, room.departure!)) {
					this.db.prepare("UPDATE account_rooms SET retired=1 WHERE room=?").run(room.action.roomId); this.invalidateEnsures(room.action.roomId);
				}
			}
		});
	}
	membershipAuthorization(requestId: string): Extract<AccountAction, { operation: "room.membership.authorize" }> | undefined {
		const request = this.get(requestId); if (request?.action.operation !== "room.membership.restore") return;
		let found: Extract<AccountAction, { operation: "room.membership.authorize" }> | undefined;
		for (const row of this.db.prepare("SELECT id FROM account_requests WHERE json_extract(payload,'$.roomId')=? AND json_extract(payload,'$.operation')='room.membership.authorize'").all(request.action.roomId)) {
			const r = this.get(String(row.id))!; const a = r.action;
			if (a.operation === "room.membership.authorize" && r.sender === request.sender && a.hostId === request.action.hostId && a.conversationId === request.action.conversationId && a.restoreRequestId === requestId) {
				if (found) throw Error("Membership authorization scope changed"); found = a;
			}
		}
		return found;
	}
	membershipJoinAttempted(requestId: string): boolean {
		return this.db.prepare("SELECT membership_attempt FROM account_requests WHERE id=?").get(requestId)?.membership_attempt === 1;
	}
	membershipConfirmation(requestId: string): string | undefined {
		const request = this.get(requestId); if (request?.action.operation !== "room.membership.restore") return;
		let found: string | undefined;
		for (const row of this.db.prepare("SELECT id FROM account_requests WHERE json_extract(payload,'$.roomId')=? AND json_extract(payload,'$.operation')='room.membership.confirm'").all(request.action.roomId)) {
			const r = this.get(String(row.id))!; const a = r.action;
			if (a.operation === "room.membership.confirm" && r.sender === request.sender && a.hostId === request.action.hostId && a.conversationId === request.action.conversationId && a.restoreRequestId === requestId) {
				if (found) throw Error("Membership confirmation scope changed"); found = a.membershipEventId;
			}
		}
		return found;
	}
	beginMembershipJoin(requestId: string): boolean {
		return this.atomic(() => {
			this.assertMembershipRepair(requestId);
			if (this.db.prepare("SELECT membership_attempt FROM account_requests WHERE id=?").get(requestId)?.membership_attempt !== 0) return false;
			this.db.prepare("UPDATE account_requests SET membership_attempt=1 WHERE id=?").run(requestId); return true;
		});
	}
	admitMembershipRepair(requestId: string): void {
		this.atomic(() => {
			this.assertMembershipRepair(requestId);
			this.db.prepare("UPDATE account_requests SET membership_admitted=1 WHERE id=?").run(requestId);
			const action = this.get(requestId)!.action as Extract<AccountAction, { operation: "room.membership.restore" }>;
			// Remember the exact observed departure so a delayed sync cannot undo restoration.
			if (action.membership === "leave") this.departed(action.roomId, action.membershipEventId);
			this.assertMembershipRepair(requestId);
		});
	}
	saveInvite(roomId: string, events: unknown): void {
		if (roomId.length > 255 || Buffer.byteLength(JSON.stringify(events)) > 16384) throw Error("Account invitation exceeds bounds");
		this.atomic(() => {
			if (!this.db.prepare("SELECT 1 FROM account_invites WHERE room=?").get(roomId) && Number(this.db.prepare("SELECT count(*) AS n FROM account_invites").get()!.n) >= 8192) throw Error("Account invitation capacity exhausted");
			const payload = JSON.stringify(events);
			if (this.db.prepare("SELECT events FROM account_invites WHERE room=?").get(roomId)?.events === payload) return;
			this.db.prepare("INSERT OR REPLACE INTO account_invites VALUES (?,?)").run(roomId, payload); this.wakeRoom(roomId);
		});
	}
	invite(roomId: string): unknown | undefined { const row = this.db.prepare("SELECT events FROM account_invites WHERE room=?").get(roomId); return row ? JSON.parse(String(row.events)) : undefined; }
	retire(roomId: string): void {
		this.atomic(() => {
			const room = this.room(roomId); if (!room?.verified || room.action.kind === "coordinator" || room.action.kind === "host_space") throw Error("Account retirement authority unavailable");
			this.db.prepare("UPDATE account_rooms SET retired=1 WHERE room=?").run(roomId);
		});
	}
	restored(roomId: string, departure: string | undefined, requestId: string, host: AccountHost): void {
		this.atomic(() => {
			const room = this.room(roomId);
			const request = this.get(requestId);
			if (request?.action.operation === "room.membership.restore") this.assertMembershipRepair(requestId);
			if (!room?.verified || room.retired || room.departure !== departure || (request?.action.operation !== "room.membership.restore" && room.action.kind !== "coordinator")) throw Error("Membership departure changed");
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
