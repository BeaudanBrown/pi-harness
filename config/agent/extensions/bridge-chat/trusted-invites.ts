import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ownedBridgeRoom } from "../matrix-shared/bridge-room.js";
import { MatrixError, MatrixHttp, matrixDelay } from "../matrix-shared/http.js";
import { isMatrixRoomId } from "../matrix-shared/room-id.js";

export type TrustedBridgeBots = Record<string, string>;
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const events = (value: unknown): Record<string, unknown>[] => {
  if (!Array.isArray(value) || value.length > 4096) throw Error("Invalid invitation state");
  return value.map(object);
};
export function trustedBridgeBots(value: unknown): TrustedBridgeBots {
  const entries = Object.entries(object(value));
  if (!value || typeof value !== "object" || Array.isArray(value) || entries.length > 64 ||
      entries.some(([host, bot]) => !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(host) || typeof bot !== "string" || bot.length > 255 || !/^@[^\s:\x00-\x1f]+:[^\s\x00-\x1f]+$/.test(bot)) ||
      new Set(entries.map(([, bot]) => bot)).size !== entries.length) throw Error("Invalid trusted bridge bot configuration");
  return Object.fromEntries(entries) as TrustedBridgeBots;
}
type Invite = { room: string; host: string; bot: string; node: string; kind: string; phase: string };

/** Only first invitation acceptance. No to-device protocol, model access,
 * notification writes, leave/forget, unban, restore or repair authority. */
export class TrustedInvitations {
  private readonly db: DatabaseSync;
  private readonly scope: string;
  private readonly parameters: string[];
  private running = false;
  private pumping = false;
  constructor(filename: string, readonly http: MatrixHttp, readonly owner: string, readonly hosts: TrustedBridgeBots) {
    trustedBridgeBots(hosts);
    if (Object.values(hosts).includes(owner) || http.retry.maxAttempts !== 1) throw Error("Invitations require an independent owner single-attempt transport");
    const directory = lstatSync(dirname(filename));
    if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid!() || directory.mode & 0o077) throw Error("Invitation state must be private");
    try { const file = lstatSync(filename); if (!file.isFile() || file.nlink !== 1 || file.uid !== process.getuid!() || file.mode & 0o077) throw Error("Unsafe invitation journal"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const mask = process.umask(0o077);
    try { this.db = new DatabaseSync(filename, { timeout: 100 }); } finally { process.umask(mask); }
    const entries = Object.entries(hosts).sort(([a], [b]) => a.localeCompare(b));
    this.scope = entries.map(() => "(host=? AND bot=?)").join(" OR ") || "0";
    this.parameters = entries.flat();
    try {
      this.db.exec(`PRAGMA synchronous=FULL; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE;
        CREATE TABLE IF NOT EXISTS identity(id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL, policy TEXT NOT NULL, cursor TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS invitations(room TEXT PRIMARY KEY, host TEXT NOT NULL, bot TEXT NOT NULL, node TEXT NOT NULL, kind TEXT NOT NULL,
          phase TEXT NOT NULL CHECK(phase IN ('offered','attempted','joined','departed','blocked')), next_at INTEGER NOT NULL DEFAULT 0);
        COMMIT;`);
      const policy = createHash("sha256").update(JSON.stringify(entries)).digest("hex");
      const old = this.db.prepare("SELECT owner,policy FROM identity WHERE id=1").get();
      if (old && old.owner !== owner) throw Error("Invitation journal belongs to another operator");
      if (!old) this.db.prepare("INSERT INTO identity VALUES (1,?,?, '')").run(owner, policy);
      else if (old.policy !== policy) this.db.prepare("UPDATE identity SET policy=?,cursor='' WHERE id=1").run(policy); // Never clear departures on policy change.
    } catch (error) { this.db.close(); throw error; }
  }
  close(): void { this.db.close(); }
  cursor(): string { return String(this.db.prepare("SELECT cursor FROM identity WHERE id=1").get()!.cursor); }
  status(): Record<string, number> {
    return Object.fromEntries(this.db.prepare("SELECT phase,count(*) AS n FROM invitations GROUP BY phase").all().map(row => [String(row.phase), Number(row.n)]));
  }
  private proof(room: string, raw: unknown): Omit<Invite, "phase"> | undefined {
    try {
      if (!isMatrixRoomId(room)) return;
      const snapshot = events(object(object(raw).invite_state).events);
      const members = snapshot.filter(event => event.type === "m.room.member" && event.state_key === this.owner);
      if (members.length !== 1 || object(members[0]!.content).membership !== "invite" || typeof members[0]!.sender !== "string") return;
      const bot = members[0]!.sender, stamp = ownedBridgeRoom(snapshot, bot);
      if (this.hosts[stamp.host] !== bot) return;
      return { room, bot, host: stamp.host, node: stamp.node, kind: stamp.kind };
    } catch { return; } // Arbitrary/unsupported invitations do not gain authority.
  }
  /** One transaction commits negative membership, offers and the independent cursor. */
  ingest(value: unknown): void {
    const batch = object(value), rooms = object(batch.rooms), cursor = batch.next_batch;
    if (typeof cursor !== "string" || !cursor || cursor.length > 16384) throw Error("Invalid invitation sync cursor");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const [room, raw] of Object.entries(object(rooms.invite))) {
        const invite = this.proof(room, raw); if (!invite) continue;
        const old = this.db.prepare("SELECT * FROM invitations WHERE room=?").get(room);
        if (!old) this.db.prepare("INSERT INTO invitations(room,host,bot,node,kind,phase) VALUES (?,?,?,?,?,'offered')").run(room, invite.host, invite.bot, invite.node, invite.kind);
        else if (old.host !== invite.host || old.bot !== invite.bot || old.node !== invite.node || old.kind !== invite.kind) this.db.prepare("UPDATE invitations SET phase='blocked' WHERE room=?").run(room);
      }
      for (const section of ["join", "leave"] as const) for (const [room, raw] of Object.entries(object(rooms[section]))) {
        if (!this.db.prepare("SELECT 1 FROM invitations WHERE room=?").get(room)) continue;
        // The authenticated account sync section is current membership evidence,
        // including kicks omitted by a sender-filtered membership timeline.
        if (section === "leave") this.db.prepare("UPDATE invitations SET phase='departed' WHERE room=?").run(room);
        else this.db.prepare("UPDATE invitations SET phase='joined' WHERE room=? AND phase IN ('offered','attempted')").run(room);
        const snapshot = object(raw);
        for (const event of [...events(object(snapshot.state).events ?? []), ...events(object(snapshot.timeline).events ?? [])]) {
          if (event.type !== "m.room.member" || event.state_key !== this.owner) continue;
          const membership = object(event.content).membership;
          if (membership === "leave" || membership === "ban") this.db.prepare("UPDATE invitations SET phase='departed' WHERE room=?").run(room);
          else if (membership === "join" && event.sender === this.owner) this.db.prepare("UPDATE invitations SET phase='joined' WHERE room=? AND phase NOT IN ('departed','blocked')").run(room);
        }
      }
      this.db.prepare("UPDATE identity SET cursor=? WHERE id=1").run(cursor); this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  private query(room?: string): URLSearchParams {
    return new URLSearchParams({ timeout: room || !this.cursor() ? "0" : "15000", set_presence: "offline", filter: JSON.stringify({
      presence: { types: [] }, account_data: { types: [] }, room: { include_leave: true, ...(room ? { rooms: [room] } : {}),
        account_data: { types: [] }, ephemeral: { types: [] }, state: { types: [] }, timeline: { types: ["m.room.member"], senders: [this.owner], limit: 1 } },
    }) });
  }
  async syncOnce(signal?: AbortSignal): Promise<void> {
    const query = this.query(); if (this.cursor()) query.set("since", this.cursor());
    const { response } = await this.http.sync(query, signal); this.ingest(response);
  }
  async pump(signal?: AbortSignal): Promise<void> {
    if (this.pumping || signal?.aborted) return; this.pumping = true;
    try {
      const rows = this.db.prepare(`SELECT * FROM invitations WHERE phase='offered' AND next_at<=? AND (${this.scope}) ORDER BY next_at,rowid LIMIT 8`).all(Date.now(), ...this.parameters) as unknown as Invite[];
      await Promise.all(rows.map(async row => {
        this.db.prepare("UPDATE invitations SET next_at=? WHERE room=?").run(Date.now() + 5000, row.room);
        try {
          const bounded = signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000);
          // A fresh room-scoped snapshot is a membership recheck, not a cursor
          // advance. It cannot claim CAS against a simultaneous human action.
          const { response } = await this.http.sync(this.query(row.room), bounded);
          const rooms = object(object(response).rooms);
          if (object(rooms.leave)[row.room]) { this.db.prepare("UPDATE invitations SET phase='departed' WHERE room=?").run(row.room); return; }
          if (object(rooms.join)[row.room]) { this.db.prepare("UPDATE invitations SET phase='joined' WHERE room=? AND phase='offered'").run(row.room); return; }
          const current = this.proof(row.room, object(rooms.invite)[row.room]);
          if (!current || current.host !== row.host || current.bot !== row.bot || current.node !== row.node || current.kind !== row.kind) return;
          // Only this transition permits a POST. Lost ACKs/restarts never retry it.
          if (this.db.prepare("UPDATE invitations SET phase='attempted' WHERE room=? AND phase='offered'").run(row.room).changes !== 1) return;
          const result = object(await this.http.request("POST", `/_matrix/client/v3/rooms/${encodeURIComponent(row.room)}/join`, {}, bounded));
          if (result.room_id !== row.room) throw Error("Invalid invitation acceptance receipt");
          this.db.prepare("UPDATE invitations SET phase='joined' WHERE room=? AND phase='attempted'").run(row.room);
        } catch (error) {
          if (error instanceof MatrixError && [401, 403, 429].includes(error.status ?? 0)) this.db.prepare("UPDATE invitations SET phase='offered' WHERE room=? AND phase='attempted'").run(row.room);
          this.db.prepare("UPDATE invitations SET next_at=? WHERE room=?").run(Date.now() + Math.max(5000, error instanceof MatrixError ? error.retryAfterMs ?? 0 : 0), row.room);
        }
      }));
    } finally { this.pumping = false; }
  }
  /** Independent of the assistant's cursor/model loop and its requests database. */
  async run(signal: AbortSignal, report: (status: Record<string, number>, unavailable: boolean) => void): Promise<void> {
    if (this.running) throw Error("Invitation consumer is already running"); this.running = true;
    let lastReport: string | undefined;
    try {
      while (!signal.aborted) {
        let unavailable = false;
        try { await this.syncOnce(signal); await this.pump(signal); } catch { unavailable = true; }
        if (signal.aborted) break;
        const status = this.status(), current = JSON.stringify({ status, unavailable });
        if (current !== lastReport) { report(status, unavailable); lastReport = current; }
        await matrixDelay(unavailable ? 5000 : 1000, signal).catch(() => {});
      }
    } finally { this.running = false; }
  }
}
