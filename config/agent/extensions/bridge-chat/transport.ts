import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { MatrixHttp, MatrixError } from "../matrix-shared/http.js";

import { MAX_QUESTION, MAX_ANSWER, MAX_AGE_MS, MAX_PENDING, MAX_RECORDS } from "./limits.js";
export { MAX_QUESTION, MAX_ANSWER, MAX_AGE_MS, MAX_PENDING, MAX_RECORDS };
export const FAILURE = "I couldn't complete that request. Please send a new !pi command to try again.";
export type ChatConfig = { homeserver: string; ownerUserId: string; remoteOwnerUserIds: string[]; roomIds: string[]; allJoinedRooms: boolean; modelSocket: string };
export function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid object");
	return value as Record<string, unknown>;
}
export function validateConfig(value: unknown): ChatConfig {
	const c = object(value);
	const mxid = (v: unknown) => typeof v === "string" && v.length <= 512 && /^@[^\s:]+:[^\s]+$/.test(v);
	if (typeof c.homeserver !== "string" || !mxid(c.ownerUserId) || typeof c.allJoinedRooms !== "boolean" ||
		!Array.isArray(c.remoteOwnerUserIds) || c.remoteOwnerUserIds.length > 8 || !c.remoteOwnerUserIds.every(mxid) ||
		!Array.isArray(c.roomIds) || c.roomIds.length > 256 || !c.roomIds.every(r => typeof r === "string" && r.startsWith("!") && r.length <= 512) ||
		(!c.allJoinedRooms && !c.roomIds.length) || typeof c.modelSocket !== "string" || !c.modelSocket.startsWith("/")) throw Error("Invalid chat configuration");
	return c as ChatConfig;
}
export function command(event: unknown, senders: Set<string>, floor: number, now: number): string | undefined {
	try {
		const e = object(event), c = object(e.content), u = object(e.unsigned ?? {});
		if (e.type !== "m.room.message" || typeof e.sender !== "string" || !senders.has(e.sender) ||
			typeof e.event_id !== "string" || !e.event_id.startsWith("$") || e.event_id.length > 512 ||
			!Number.isSafeInteger(e.origin_server_ts) || Number(e.origin_server_ts) <= Math.max(floor, now - MAX_AGE_MS) || Number(e.origin_server_ts) > now + 30000 ||
			Object.hasOwn(u, "redacted_because") || c.msgtype !== "m.text" ||
			["m.relates_to", "m.new_content", "file", "url"].some(k => Object.hasOwn(c, k)) ||
			typeof c.body !== "string" || !/^!pi[ \t\r\n]/.test(c.body)) return;
		const q = c.body.slice(4).trim();
		if (!q || Buffer.byteLength(q) > MAX_QUESTION || q.includes("\0") || Buffer.from(q).toString("utf8") !== q) return;
		return q;
	} catch { return; }
}
export interface ChatMatrix {
	usable(room: string, owner: string, signal?: AbortSignal): Promise<boolean>;
	send(room: string, txn: string, text: string, signal?: AbortSignal): Promise<unknown>;
}
export class OwnerMatrix implements ChatMatrix {
	readonly http: MatrixHttp;
	constructor(config: { homeserver: string; accessToken: string }, fetcher: typeof fetch = fetch) {
		// Unlike engineering delivery, unknown bridge send outcomes are NEVER retried.
		this.http = new MatrixHttp(config, fetcher, { maxAttempts: 1 });
	}
	async usable(room: string, owner: string, signal?: AbortSignal): Promise<boolean> {
		const prefix = `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/state/`;
		try { await this.http.request("GET", prefix + "m.room.encryption/", undefined, signal); return false; }
		catch (e) { if (!(e instanceof MatrixError) || e.status !== 404) throw e; }
		const creation = object(await this.http.request("GET", prefix + "m.room.create/", undefined, signal));
		const member = object(await this.http.request("GET", prefix + "m.room.member/" + encodeURIComponent(owner), undefined, signal));
		return creation.type !== "m.space" && member.membership === "join";
	}
	async sync(cursor: string, senders: string[], pending: number, signal?: AbortSignal): Promise<unknown> {
		const filter = { presence: { types: [] }, account_data: { types: [] }, room: {
			include_leave: true, account_data: { types: [] }, ephemeral: { types: [] }, state: { types: [] },
			timeline: { types: ["m.room.message"], senders, limit: 50 },
		} };
		const query = new URLSearchParams({ timeout: pending || !cursor ? "0" : "15000", set_presence: "offline", filter: JSON.stringify(filter) });
		if (cursor) query.set("since", cursor);
		return (await this.http.sync(query, signal)).response;
	}
	send(room: string, txn: string, text: string, signal?: AbortSignal): Promise<unknown> {
		return this.http.request("PUT", `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/send/m.room.message/${encodeURIComponent(txn)}`,
			{ msgtype: "m.text", body: "Pi: " + text, "m.mentions": {} }, signal);
	}
}

type Row = { id: string; room: string; created: number; phase: string; question: string; answer: string };
export class Store {
	readonly db: DatabaseSync;
	constructor(filename: string) {
		this.db = new DatabaseSync(filename, { timeout: 100 });
		try {
			this.db.exec(`PRAGMA synchronous=FULL; PRAGMA secure_delete=ON; PRAGMA max_page_count=4096;
				PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE;
				CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
				CREATE TABLE IF NOT EXISTS rooms(id TEXT PRIMARY KEY, floor INTEGER NOT NULL DEFAULT 0);
				CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY, room TEXT NOT NULL, created INTEGER NOT NULL,
				phase TEXT NOT NULL, question TEXT NOT NULL DEFAULT '', answer TEXT NOT NULL DEFAULT ''); COMMIT;`);
			this.atomic(() => {
				this.db.prepare("UPDATE requests SET phase='ready', question='', answer=? WHERE phase='running'").run(FAILURE);
				this.db.exec("UPDATE requests SET phase='uncertain', question='', answer='' WHERE phase='sending'");
			});
		} catch (e) { this.db.close(); throw e; }
	}
	close(): void { this.db.close(); }
	atomic<T>(fn: () => T): T {
		this.db.exec("BEGIN IMMEDIATE");
		try { const result = fn(); this.db.exec("COMMIT"); return result; }
		catch (e) { this.db.exec("ROLLBACK"); throw e; }
	}
	get(key: string, fallback = ""): string { return String(this.db.prepare("SELECT value FROM meta WHERE key=?").get(key)?.value ?? fallback); }
	put(key: string, value: string | number): void { this.db.prepare("INSERT OR REPLACE INTO meta VALUES (?,?)").run(key, String(value)); }
	pending(): number { return Number(this.db.prepare("SELECT count(*) AS n FROM requests WHERE phase IN ('queued','ready','running','sending')").get()!.n); }
	resetPolicy(): void { this.atomic(() => this.db.exec("UPDATE requests SET phase='discarded', question='', answer='' WHERE phase IN ('queued','ready')")); }
	ingest(value: unknown, config: ChatConfig, now: number, fresh = false): number {
		const batch = object(value), rooms = object(batch.rooms ?? {}), joined = object(rooms.join ?? {}), left = object(rooms.leave ?? {});
		if (typeof batch.next_batch !== "string" || !batch.next_batch || batch.next_batch.length > 16384 || Object.keys(joined).length > 10000 || Object.keys(left).length > 10000) throw Error("Sync shape");
		const cursor = batch.next_batch, floor = Number(this.get("floor", String(now)));
		const senders = new Set([config.ownerUserId, ...config.remoteOwnerUserIds]);
		return this.atomic(() => {
			let dropped = 0;
			this.db.prepare("DELETE FROM requests WHERE created < ? AND phase IN ('done','uncertain','discarded')").run(now - 7 * 86400000);
			if (fresh) { this.db.exec("DELETE FROM rooms"); this.put("floor", now); }
			for (const [room, raw] of Object.entries(joined)) {
				if (!room.startsWith("!") || room.length > 512) throw Error("Room shape");
				const timeline = object(object(raw).timeline ?? {}), events = timeline.events ?? [];
				if (!Array.isArray(events) || events.length > 50) throw Error("Timeline shape");
				const known = this.db.prepare("SELECT floor FROM rooms WHERE id=?").get(room);
				this.db.prepare("INSERT OR IGNORE INTO rooms(id) VALUES (?)").run(room);
				if (fresh || !known || timeline.limited !== false) {
					const timestamps = events.map(e => { try { return object(e).origin_server_ts; } catch { return undefined; } }).filter(v => Number.isSafeInteger(v) && Number(v) >= 0) as number[];
					this.db.prepare("UPDATE rooms SET floor=MAX(floor, ?) WHERE id=?").run(Math.max(now, ...timestamps), room); continue;
				}
				if (!config.allJoinedRooms && !config.roomIds.includes(room)) continue;
				for (const e of events) {
					const question = command(e, senders, Math.max(floor, Number(known.floor)), now);
					if (question === undefined) continue;
					const event = object(e), id = createHash("sha256").update(JSON.stringify([room, event.event_id])).digest("hex");
					if (this.db.prepare("SELECT 1 FROM requests WHERE id=?").get(id)) continue;
					if (this.pending() >= MAX_PENDING || Number(this.db.prepare("SELECT count(*) AS n FROM requests").get()!.n) >= MAX_RECORDS) {
						dropped++;
						this.db.prepare("UPDATE rooms SET floor=MAX(floor, ?) WHERE id=?").run(Number(event.origin_server_ts), room);
						continue;
					}
					this.db.prepare("INSERT INTO requests(id,room,created,phase,question) VALUES (?,?,?,'queued',?)").run(id, room, Number(event.origin_server_ts), question);
				}
			}
			for (const room of Object.keys(left)) this.db.prepare("DELETE FROM rooms WHERE id=?").run(room);
			if (Number(this.db.prepare("SELECT count(*) AS n FROM rooms").get()!.n) > 10000) throw Error("Room capacity");
			this.put("cursor", cursor); return dropped;
		});
	}
	phase(id: string, phase: string, answer = ""): void {
		this.atomic(() => this.db.prepare("UPDATE requests SET phase=?, question='', answer=? WHERE id=?").run(phase, answer, id));
	}
	async step(matrix: ChatMatrix, execute: (question: string) => Promise<string>, config: ChatConfig, now: () => number = Date.now, signal?: AbortSignal): Promise<void> {
		const row = this.db.prepare("SELECT * FROM requests WHERE phase IN ('queued','ready') ORDER BY created,id LIMIT 1").get() as Row | undefined;
		if (!row) return;
		const { id, room } = row;
		if ((row.phase === "ready" && now() - row.created > MAX_AGE_MS) || (!config.allJoinedRooms && !config.roomIds.includes(room))) { this.phase(id, "discarded"); return; }
		try { if (!await matrix.usable(room, config.ownerUserId, signal)) { this.phase(id, "discarded"); return; } }
		catch { if (now() - row.created > MAX_AGE_MS) this.phase(id, "discarded"); return; }
		let result = row.answer;
		if (row.phase === "queued") {
			this.phase(id, "running");
			try {
				result = now() - row.created <= MAX_AGE_MS ? await execute(row.question) : "That request expired. Please send a new !pi command.";
				if (typeof result !== "string" || !result || Buffer.byteLength(result) > MAX_ANSWER) throw Error("Answer size");
			} catch { result = FAILURE; }
			this.phase(id, "ready", result);
		}
		if (signal?.aborted) return;
		try { if (!await matrix.usable(room, config.ownerUserId, signal)) { this.phase(id, "discarded"); return; } } catch { return; }
		this.phase(id, "sending", result);
		try {
			const sent = object(await matrix.send(room, "pi-" + id, result, signal));
			if (typeof sent.event_id !== "string" || !sent.event_id.startsWith("$")) throw Error("Acknowledgement");
		} catch { this.phase(id, "uncertain"); console.log('{"event":"send_uncertain"}'); return; }
		this.phase(id, "done"); console.log('{"event":"matrix_reply_accepted","remoteDeliveryVerified":false}');
	}
}
