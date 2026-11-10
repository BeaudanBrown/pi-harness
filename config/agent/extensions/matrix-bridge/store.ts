import { createHash } from "node:crypto";
import { lstatSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type SessionRegistration = { file: string; nativeId: string; cwd: string; title: string; boundary: string | null };
export type Binding = SessionRegistration & { key: string; room?: string; archived: boolean; enabled: boolean; grouping?: Record<string, string> };
export type RawEvent = { id: string; room: string; event: Record<string, unknown> };
export type Prompt = { text: string; sender: string; deliverAs?: "steer" | "followUp"; control?: "abort" | "stop"; image?: { mimeType: string; data: string } };
export type InputState = "received" | "queued" | "handed" | "settled" | "interrupted" | "ignored";
export type Input = { id: string; binding: string; event: Record<string, unknown>; prompt?: Prompt; state: InputState };
export type Output = { id: string; binding: string; source: string; type: string; content: Record<string, unknown>; eventId?: string };
export const identity = (domain: string, ...values: string[]): string => createHash("sha256").update(JSON.stringify(["pi-bridge-v1", domain, ...values])).digest("hex");

function privatePath(filename: string): void {
  mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
  const directory = lstatSync(dirname(filename));
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid!() || (directory.mode & 0o077)) throw Error("Bridge state directory must be private and user-owned");
  try {
    const file = lstatSync(filename);
    if (!file.isFile() || file.nlink !== 1 || file.uid !== process.getuid!() || (file.mode & 0o077)) throw Error("Bridge database must be a private regular file");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

/** Transactional delivery ledger. Runtime/window observations deliberately do not live here. */
export class BridgeStore {
  private readonly db: DatabaseSync;
  constructor(filename: string, hostId: string) {
    privatePath(filename);
    const mask = process.umask(0o077);
    try { this.db = new DatabaseSync(filename, { timeout: 1000 }); } finally { process.umask(mask); }
    try {
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
        CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS bindings(key TEXT PRIMARY KEY, file TEXT NOT NULL UNIQUE, room TEXT UNIQUE, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS inputs(id TEXT PRIMARY KEY, binding TEXT NOT NULL REFERENCES bindings(key), position INTEGER NOT NULL,
          event TEXT NOT NULL, prompt TEXT, state TEXT NOT NULL CHECK(state IN ('received','queued','handed','settled','interrupted','ignored')));
        CREATE INDEX IF NOT EXISTS input_queue ON inputs(binding,state,position);
        CREATE TABLE IF NOT EXISTS outputs(id TEXT PRIMARY KEY, binding TEXT NOT NULL REFERENCES bindings(key), source TEXT NOT NULL,
          ordinal INTEGER NOT NULL, type TEXT NOT NULL, content TEXT NOT NULL, event_id TEXT, UNIQUE(binding,source,ordinal));
        CREATE INDEX IF NOT EXISTS output_queue ON outputs(binding) WHERE event_id IS NULL;
        CREATE TABLE IF NOT EXISTS progress(key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
      this.atomic(() => {
        const oldHost = this.getMeta("host");
        if (oldHost !== undefined && oldHost !== hostId) throw Error("Bridge database belongs to another host");
        const version = this.getMeta("version");
        if (version !== undefined && version !== "1") throw Error("Unsupported bridge database version");
        this.setMeta("host", hostId); this.setMeta("version", "1");
        this.db.exec("UPDATE inputs SET state='interrupted' WHERE state='handed'");
      });
    } catch (error) { this.db.close(); throw error; }
  }
  close(): void { this.db.close(); }
  private atomic<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const value = fn(); this.db.exec("COMMIT"); return value; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  private getMeta(key: string): string | undefined { return this.db.prepare("SELECT value FROM meta WHERE key=?").get(key)?.value as string | undefined; }
  private setMeta(key: string, value: string): void { this.db.prepare("INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value); }
  cursor(): string | undefined { return this.getMeta("cursor"); }
  binding(key: string): Binding | undefined {
    const row = this.db.prepare("SELECT value FROM bindings WHERE key=?").get(key);
    return row ? JSON.parse(String(row.value)) as Binding : undefined;
  }
  byRoom(room: string): Binding | undefined {
    const row = this.db.prepare("SELECT value FROM bindings WHERE room=?").get(room);
    return row ? JSON.parse(String(row.value)) as Binding : undefined;
  }
  bindings(): Binding[] { return this.db.prepare("SELECT value FROM bindings ORDER BY key").all().map(row => JSON.parse(String(row.value)) as Binding); }
  register(session: SessionRegistration): Binding {
    const key = identity("binding", session.file, session.nativeId);
    const previous = this.binding(key);
    if (previous) {
      if (previous.cwd !== session.cwd) throw Error("Native session cwd changed; binding unchanged");
      // Original boundary wins on reconnect, including a tree/fork copied marker.
      const next = { ...previous, title: session.title }; this.saveBinding(next); return next;
    }
    const binding: Binding = { ...session, key, archived: false, enabled: true };
    this.db.prepare("INSERT INTO bindings VALUES (?,?,NULL,?)").run(key, binding.file, JSON.stringify(binding));
    return binding;
  }
  saveBinding(binding: Binding): void {
    const old = this.binding(binding.key);
    if (!old || old.file !== binding.file || old.nativeId !== binding.nativeId || old.cwd !== binding.cwd) throw Error("Binding identity is immutable");
    this.db.prepare("UPDATE bindings SET room=?,value=? WHERE key=?").run(binding.room ?? null, JSON.stringify(binding), binding.key);
  }
  setEnabled(key: string, enabled: boolean): void {
    this.atomic(() => {
      const binding = this.binding(key); if (!binding) throw Error("Unknown binding");
      this.saveBinding({ ...binding, enabled });
      if (!enabled) this.db.prepare("UPDATE inputs SET state='ignored' WHERE binding=? AND state IN ('received','queued')").run(key);
    });
  }
  setRoom(key: string, room: string): void {
    const binding = this.binding(key); if (!binding) throw Error("Unknown binding");
    if (binding.room && binding.room !== room) throw Error("Room binding is immutable");
    this.saveBinding({ ...binding, room });
  }
  /** Raw intake and cursor are atomic; room membership is checked before authorization/dispatch. */
  intake(cursor: string, events: RawEvent[], checkpoints: Record<string, unknown> = {}): void {
    this.atomic(() => {
      let position = Number(this.getMeta("position") ?? 0);
      for (const input of events) {
        const binding = this.byRoom(input.room); if (!binding) continue;
        this.db.prepare("INSERT OR IGNORE INTO inputs VALUES (?,?,?, ?,NULL,'received')").run(input.id, binding.key, ++position, JSON.stringify(input.event));
      }
      for (const [key, value] of Object.entries(checkpoints)) this.saveProgress(key, value);
      this.setMeta("position", String(position)); this.setMeta("cursor", cursor);
    });
  }
  private decodeInput(row: Record<string, unknown>): Input {
    return { id: String(row.id), binding: String(row.binding), state: row.state as InputState, event: JSON.parse(String(row.event)) as Record<string, unknown>, ...(row.prompt ? { prompt: JSON.parse(String(row.prompt)) as Prompt } : {}) };
  }
  received(key: string): Input[] {
    return this.db.prepare("SELECT * FROM inputs WHERE binding=? AND state='received' ORDER BY position LIMIT 100").all(key).map(row => this.decodeInput(row));
  }
  authorize(id: string, prompt: Prompt | undefined): void {
    this.db.prepare("UPDATE inputs SET state=?,prompt=? WHERE id=? AND state='received'").run(prompt ? "queued" : "ignored", prompt ? JSON.stringify(prompt) : null, id);
  }
  unreportedInputs(key: string): Input[] {
    return this.db.prepare("SELECT * FROM inputs WHERE binding=? AND state='interrupted' AND NOT EXISTS (SELECT 1 FROM outputs WHERE outputs.binding=inputs.binding AND outputs.source='uncertain:' || inputs.id) ORDER BY position LIMIT 100").all(key).map(row => this.decodeInput(row));
  }
  nextInput(key: string): Input | undefined {
    const row = this.db.prepare("SELECT * FROM inputs WHERE binding=? AND state IN ('received','queued') ORDER BY position LIMIT 1").get(key);
    return row ? this.decodeInput(row) : undefined;
  }
  inputChunk(key: string, id: string, offset: number): { text: string; done: boolean } {
    if (!Number.isSafeInteger(offset) || offset < 0) throw Error("Invalid input offset");
    const row = this.db.prepare("SELECT prompt FROM inputs WHERE binding=? AND id=? AND state IN ('handed','interrupted','settled')").get(key, id);
    if (!row?.prompt || offset > String(row.prompt).length) throw Error("Unknown native input");
    const value = String(row.prompt);
    return { text: value.slice(offset, offset + 4096), done: offset + 4096 >= value.length };
  }
  interruptBefore(key: string, id: string): void {
    this.db.prepare("UPDATE inputs SET state='interrupted' WHERE binding=? AND state IN ('queued','handed') AND position < (SELECT position FROM inputs WHERE binding=? AND id=?)").run(key, key, id);
  }
  interruptInput(key: string, id: string): void {
    this.db.prepare("UPDATE inputs SET state='interrupted' WHERE binding=? AND id=? AND state IN ('handed','queued')").run(key, id);
  }
  takeInput(key: string, expectedId?: string): Input | undefined {
    return this.atomic(() => {
      const binding = this.binding(key);
      if (!binding?.enabled || binding.archived) return undefined;
      const row = this.db.prepare("SELECT * FROM inputs WHERE binding=? AND state IN ('received','queued') ORDER BY position LIMIT 1").get(key);
      if (!row || row.state === "received" || expectedId !== undefined && row.id !== expectedId) return undefined;
      this.db.prepare("UPDATE inputs SET state='handed' WHERE id=?").run(row.id!);
      return { ...this.decodeInput(row), state: "handed" };
    });
  }
  knowsEvent(id: string, room: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM inputs JOIN bindings ON bindings.key=inputs.binding WHERE inputs.id=? AND bindings.room=?").get(id, room));
  }
  ownsInput(key: string, id: string, sender: string): boolean {
    const row = this.db.prepare("SELECT prompt FROM inputs WHERE binding=? AND id=? AND prompt IS NOT NULL").get(key, id);
    return Boolean(row && (JSON.parse(String(row.prompt)) as Prompt).sender === sender);
  }
  settle(key: string, id: string): void { this.db.prepare("UPDATE inputs SET state='settled' WHERE binding=? AND id=? AND state IN ('handed','interrupted')").run(key, id); }
  disconnect(key: string): void { this.db.prepare("UPDATE inputs SET state='interrupted' WHERE binding=? AND state='handed'").run(key); }
  status(key: string): Record<InputState, number> {
    const counts: Record<InputState, number> = { received: 0, queued: 0, handed: 0, settled: 0, interrupted: 0, ignored: 0 };
    for (const row of this.db.prepare("SELECT state,count(*) AS n FROM inputs WHERE binding=? GROUP BY state").all(key)) counts[row.state as InputState] = Number(row.n);
    return counts;
  }
  outputs(key: string, source?: string): Output[] {
    const rows = source === undefined ? this.db.prepare("SELECT * FROM outputs WHERE binding=? AND event_id IS NULL ORDER BY rowid LIMIT 100").all(key) :
      this.db.prepare("SELECT * FROM outputs WHERE binding=? AND source=? ORDER BY ordinal").all(key, source);
    return rows.map(row => ({ id: String(row.id), binding: key, source: String(row.source), type: String(row.type), content: JSON.parse(String(row.content)) as Record<string, unknown>, ...(row.event_id ? { eventId: String(row.event_id) } : {}) }));
  }
  /** Materialize once. Never re-render a possibly sent source after an upgrade. */
  offer(key: string, source: string, render: () => Array<{ type: string; content: Record<string, unknown> }>): Output[] {
    return this.atomic(() => {
      const existing = this.outputs(key, source); if (existing.length) return existing;
      for (const [ordinal, output] of render().entries()) {
        this.db.prepare("INSERT INTO outputs VALUES (?,?,?,?,?,?,NULL)").run(identity("output", key, source, String(ordinal)), key, source, ordinal, output.type, JSON.stringify(output.content));
      }
      return this.outputs(key, source);
    });
  }
  sent(id: string, eventId: string): void {
    const old = this.db.prepare("SELECT event_id FROM outputs WHERE id=?").get(id);
    if (!old || old.event_id && old.event_id !== eventId) throw Error("Conflicting Matrix output receipt");
    this.db.prepare("UPDATE outputs SET event_id=? WHERE id=?").run(eventId, id);
  }
  progress<T>(key: string): T | undefined {
    const row = this.db.prepare("SELECT value FROM progress WHERE key=?").get(key);
    return row ? JSON.parse(String(row.value)) as T : undefined;
  }
  saveProgress(key: string, value: unknown): void {
    this.db.prepare("INSERT INTO progress VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, JSON.stringify(value));
  }
}
