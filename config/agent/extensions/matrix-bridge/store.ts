import { createHash } from "node:crypto";
import { lstatSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { IMAGE_CHUNK_BYTES } from "./wire.js";
import { interactionSpec, pollStart, pollEnd, POLL_START, type Interaction, type InteractionSpec, type NativeControl } from "./interaction.js";
import { taskApprovalText, type TaskRecord } from "./task-contract.js";

export type SessionRegistration = { file: string; nativeId: string; cwd: string; title: string; boundary: string | null };
export type Binding = SessionRegistration & { key: string; room?: string; archived: boolean; archiveRevision?: number; resumePending?: boolean; enabled: boolean; grouping?: Record<string, string> };
export type RawEvent = { id: string; room: string; event: Record<string, unknown> };
export type ImageInfo = { mimeType: string; sha256: string; byteLength: number };
export type Prompt = { text: string; sender: string; deliverAs?: "steer" | "followUp"; control?: NativeControl; argument?: string; question?: string; image?: ImageInfo };
export type InputState = "received" | "queued" | "handed" | "settled" | "interrupted" | "ignored";
export type Input = { id: string; binding: string; position: number; event: Record<string, unknown>; prompt?: Prompt; state: InputState; held?: boolean; archiveRevision?: number; interaction?: string };
export type Output = { id: string; binding: string; source: string; type: string; content: Record<string, unknown>; eventId?: string };
export const identity = (domain: string, ...values: string[]): string => createHash("sha256").update(JSON.stringify(["pi-bridge-v1", domain, ...values])).digest("hex");

export function refuseLegacyStore(directory: string): void {
  // Read-only startup preflight, repeated at writer open. Presence is negative
  // evidence, including dangling links. Never load or convert an old store.
  for (const marker of ["registry.json", "v1-to-v2-migration.json", "archives.json", "archives.json.initialized", "retirements"]) {
    try { lstatSync(join(directory, marker)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    throw Error("Legacy managed store refused; use approved offline migration into a distinct state directory");
  }
}
function privatePath(filename: string): void {
  refuseLegacyStore(dirname(filename));
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
        CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
      const oldHost = this.getMeta("host"), version = this.getMeta("version");
      if (oldHost !== undefined && oldHost !== hostId) throw Error("Bridge database belongs to another host");
      if (version !== undefined && !["1", "2", "3", "4"].includes(version)) throw Error("Unsupported bridge database version");
      this.db.exec(`CREATE TABLE IF NOT EXISTS bindings(key TEXT PRIMARY KEY, file TEXT NOT NULL UNIQUE, room TEXT UNIQUE, value TEXT NOT NULL);
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
        if (version !== undefined && !["1", "2", "3", "4"].includes(version)) throw Error("Unsupported bridge database version");
        if (!this.db.prepare("PRAGMA table_info(inputs)").all().some(column => column.name === "interaction")) this.db.exec("ALTER TABLE inputs ADD COLUMN interaction TEXT");
        if (!this.db.prepare("PRAGMA table_info(inputs)").all().some(column => column.name === "held")) this.db.exec("ALTER TABLE inputs ADD COLUMN held INTEGER NOT NULL DEFAULT 0");
        if (!this.db.prepare("PRAGMA table_info(inputs)").all().some(column => column.name === "archive_revision")) this.db.exec("ALTER TABLE inputs ADD COLUMN archive_revision INTEGER NOT NULL DEFAULT -1");
        this.db.exec(`CREATE TABLE IF NOT EXISTS interactions(id TEXT PRIMARY KEY, binding TEXT NOT NULL REFERENCES bindings(key), source TEXT NOT NULL, value TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('active','answered','cancelled')), answer TEXT, UNIQUE(binding,source));
          CREATE INDEX IF NOT EXISTS interaction_state ON interactions(binding,state);
          CREATE INDEX IF NOT EXISTS output_receipt ON outputs(event_id) WHERE event_id IS NOT NULL;
          CREATE TABLE IF NOT EXISTS images(input TEXT NOT NULL REFERENCES inputs(id), offset INTEGER NOT NULL, size INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY(input,offset));
          CREATE TABLE IF NOT EXISTS tasks(key TEXT PRIMARY KEY, binding TEXT NOT NULL REFERENCES bindings(key), phase TEXT NOT NULL, value TEXT NOT NULL);
          CREATE INDEX IF NOT EXISTS task_phase ON tasks(phase);`);
        this.setMeta("host", hostId); this.setMeta("version", "4");
        // A runtime writer opening an imported ledger conservatively closes the
        // pre-cutover rollback window. Read-only migration checks do not use us.
        if (this.getMeta("migration")) this.setMeta("migration_started", "true");
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
  enrollmentBlocked(file: string, nativeId: string): boolean {
    const native = this.progress<{ file?: string; disabled: boolean }>(`migration-native:${nativeId}`);
    const path = this.progress<{ nativeId?: string; disabled: boolean }>(`migration-file:${identity("file", file)}`);
    return Boolean(native && (native.disabled || native.file !== file) || path && (path.disabled || path.nativeId !== nativeId));
  }
  register(session: SessionRegistration): Binding {
    if (this.enrollmentBlocked(session.file, session.nativeId)) throw Error("Historical migration identity is disabled or moved; original room retained and local Pi remains available");
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
  setEnabled(key: string, enabled: boolean): boolean {
    return this.atomic(() => {
      const binding = this.binding(key); if (!binding) throw Error("Unknown binding");
      enabled = enabled && !this.enrollmentBlocked(binding.file, binding.nativeId);
      this.saveBinding({ ...binding, enabled });
      if (!enabled) this.db.prepare("UPDATE inputs SET state='ignored' WHERE binding=? AND state IN ('received','queued')").run(key);
      return enabled;
    });
  }
  setArchived(key: string, archived: boolean, expectedRevision: number): Binding {
    return this.atomic(() => {
      const binding = this.binding(key); if (!binding) throw Error("Unknown native binding");
      if ((binding.archiveRevision ?? 0) !== expectedRevision) throw Error("Archive state changed; inspect current status before confirming again");
      if (binding.archived === archived) return binding;
      const next = { ...binding, archived, archiveRevision: expectedRevision + 1, resumePending: true };
      this.saveBinding(next);
      this.db.prepare("UPDATE inputs SET held=1 WHERE binding=? AND state IN ('received','queued','handed')").run(key);
      this.db.prepare("UPDATE inputs SET state='interrupted' WHERE binding=? AND state IN ('queued','handed')").run(key);
      this.cancelInteractions(key);
      this.materialize(key, `archive:${next.archiveRevision}`, [{ type: "m.room.message", content: { msgtype: "m.notice", "m.mentions": {}, body: archived ?
        "Archived: future remote input/wake is disabled. Existing work may finish and publish. History, membership and files remain; this room may still appear in All Rooms. Archive grouping updates in the background. A fresh Matrix sync is required before remote restore; check !status." :
        "Restored: original grouping updates in the background. Held/uncertain messages will not replay. Fresh remote input resumes after Matrix sync catches up; check !status before sending a new instruction." } }]);
      return next;
    });
  }
  resumeAfterSync(key: string, revision: number): void {
    const binding = this.binding(key);
    if (binding?.resumePending && (binding.archiveRevision ?? 0) === revision) this.saveBinding({ ...binding, resumePending: false });
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
        this.db.prepare("INSERT OR IGNORE INTO inputs(id,binding,position,event,prompt,state,interaction,held,archive_revision) VALUES (?,?,?,?,NULL,'received',?,?,?)")
          .run(input.id, binding.key, ++position, JSON.stringify(input.event), this.activeInteraction(binding.key)?.id ?? null, binding.archived || binding.resumePending ? 1 : 0, binding.resumePending ? -1 : binding.archiveRevision ?? 0);
      }
      for (const [key, value] of Object.entries(checkpoints)) this.saveProgress(key, value);
      this.setMeta("position", String(position)); this.setMeta("cursor", cursor);
    });
  }
  private decodeInput(row: Record<string, unknown>): Input {
    return { id: String(row.id), binding: String(row.binding), position: Number(row.position), state: row.state as InputState, archiveRevision: Number(row.archive_revision), ...(row.held ? { held: true } : {}), event: JSON.parse(String(row.event)) as Record<string, unknown>, ...(row.prompt ? { prompt: JSON.parse(String(row.prompt)) as Prompt } : {}), ...(row.interaction ? { interaction: String(row.interaction) } : {}) };
  }
  received(key: string): Input[] {
    return this.db.prepare("SELECT * FROM inputs WHERE binding=? AND state='received' ORDER BY position LIMIT 100").all(key).map(row => this.decodeInput(row));
  }
  authorize(id: string, prompt: Prompt | undefined, options: { interaction?: string; image?: Buffer } = {}): boolean {
    return this.atomic(() => {
      const input = this.db.prepare("SELECT binding,held FROM inputs WHERE id=? AND state='received'").get(id); if (!input) return false;
      const binding = this.binding(String(input.binding));
      if (prompt && (input.held || !binding?.enabled || binding.archived || binding.resumePending)) {
        this.db.prepare("UPDATE inputs SET state='interrupted' WHERE id=?").run(id); return false;
      }
      if (prompt && options.interaction && this.db.prepare("UPDATE interactions SET state='answered',answer=? WHERE id=? AND binding=? AND state='active'").run(id, options.interaction, input.binding!).changes !== 1) prompt = undefined;
      if (prompt && options.image) {
        if (!prompt.image || prompt.image.sha256 !== createHash("sha256").update(options.image).digest("hex") || prompt.image.byteLength !== options.image.length) throw Error("Image authorization integrity mismatch");
        const insert = this.db.prepare("INSERT INTO images VALUES (?,?,?,?)");
        for (let offset = 0; offset < options.image.length; offset += IMAGE_CHUNK_BYTES) insert.run(id, offset, options.image.length, options.image.subarray(offset, offset + IMAGE_CHUNK_BYTES));
      }
      this.db.prepare("UPDATE inputs SET state=?,prompt=? WHERE id=?").run(prompt ? "queued" : "ignored", prompt ? JSON.stringify(prompt) : null, id);
      return Boolean(prompt);
    });
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
    const row = this.db.prepare("SELECT prompt FROM inputs WHERE binding=? AND id=? AND state='handed' AND held=0").get(key, id);
    if (!row?.prompt || offset > String(row.prompt).length) throw Error("Unknown native input");
    const value = String(row.prompt);
    return { text: value.slice(offset, offset + 4096), done: offset + 4096 >= value.length };
  }
  imageChunk(key: string, id: string, offset: number): { data: string; sha256: string; offset: number; done: boolean } {
    if (!Number.isSafeInteger(offset) || offset < 0) throw Error("Invalid image offset");
    const row = this.db.prepare("SELECT images.data,images.size FROM images JOIN inputs ON inputs.id=images.input WHERE inputs.id=? AND inputs.binding=? AND inputs.state='handed' AND images.offset=?").get(id, key, offset);
    if (!row || offset >= Number(row.size)) throw Error("Image transfer is unavailable or withdrawn");
    const bytes = Buffer.from(row.data as Uint8Array);
    return { data: bytes.toString("base64"), sha256: createHash("sha256").update(bytes).digest("hex"), offset, done: offset + bytes.length === Number(row.size) };
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
      if (!binding?.enabled || binding.archived || binding.resumePending) return undefined;
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
  settle(key: string, id: string): void {
    this.atomic(() => { if (this.db.prepare("UPDATE inputs SET state='settled' WHERE binding=? AND id=? AND state IN ('handed','interrupted')").run(key, id).changes) this.db.prepare("DELETE FROM images WHERE input=?").run(id); });
  }
  finishInput(key: string, id: string, message: string, source = `result:${id}`): void {
    this.atomic(() => {
      if (!this.db.prepare("SELECT 1 FROM inputs WHERE binding=? AND id=?").get(key, id)) throw Error("Unknown input result");
      this.db.prepare("UPDATE inputs SET state='settled' WHERE binding=? AND id=?").run(key, id);
      this.db.prepare("DELETE FROM images WHERE input=?").run(id);
      this.materialize(key, source, [{ type: "m.room.message", content: { msgtype: "m.notice", body: message, "m.mentions": {}, "m.relates_to": { "m.in_reply_to": { event_id: id } } } }]);
    });
  }
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
      return this.materialize(key, source, render());
    });
  }
  private materialize(key: string, source: string, outputs: Array<{ type: string; content: Record<string, unknown> }>): Output[] {
    const existing = this.outputs(key, source); if (existing.length) return existing;
    for (const [ordinal, output] of outputs.entries()) this.db.prepare("INSERT INTO outputs VALUES (?,?,?,?,?,?,NULL)").run(identity("output", key, source, String(ordinal)), key, source, ordinal, output.type, JSON.stringify(output.content));
    return this.outputs(key, source);
  }
  private decodeInteraction(row?: Record<string, unknown>): Interaction | undefined {
    return row ? { ...JSON.parse(String(row.value)) as InteractionSpec, id: String(row.id), binding: String(row.binding), source: String(row.source), state: row.state as Interaction["state"], ...(row.answer ? { answer: String(row.answer) } : {}) } : undefined;
  }
  interaction(id: string): Interaction | undefined { return this.decodeInteraction(this.db.prepare("SELECT * FROM interactions WHERE id=?").get(id)); }
  activeInteraction(key: string): Interaction | undefined { return this.decodeInteraction(this.db.prepare("SELECT * FROM interactions WHERE binding=? AND state='active' LIMIT 1").get(key)); }
  interactionPosition(interaction: Interaction): number | undefined {
    const event = this.outputs(interaction.binding, `interaction:${interaction.id}`)[0]?.eventId;
    const row = event ? this.db.prepare("SELECT position FROM inputs WHERE binding=? AND id=?").get(interaction.binding, event) : undefined;
    return row ? Number(row.position) : undefined;
  }
  interactionByEvent(key: string, eventId: string): Interaction | undefined {
    return this.decodeInteraction(this.db.prepare("SELECT interactions.* FROM interactions JOIN outputs ON outputs.source='interaction:' || interactions.id AND outputs.binding=interactions.binding WHERE interactions.binding=? AND outputs.event_id=?").get(key, eventId));
  }
  offerInteraction(key: string, source: string, value: InteractionSpec): Interaction {
    return this.atomic(() => this.materializeInteraction(key, source, value));
  }
  private materializeInteraction(key: string, source: string, value: InteractionSpec): Interaction {
    const id = identity("interaction", key, source), existing = this.interaction(id); if (existing) return existing;
    const spec = interactionSpec(value);
    this.cancelInteractions(key);
    if (spec.nativeEntry) {
      this.saveProgress(`question-cutoff:${key}`, Number(this.getMeta("position") ?? 0));
      this.db.prepare("UPDATE inputs SET state='interrupted' WHERE binding=? AND state='queued'").run(key);
    }
    this.db.prepare("INSERT INTO interactions VALUES (?,?,?,?,'active',NULL)").run(id, key, source, JSON.stringify(spec));
    this.materialize(key, `interaction:${id}`, [pollStart(spec)]);
    return this.interaction(id)!;
  }
  task(key: string): TaskRecord | undefined {
    const row = this.db.prepare("SELECT value FROM tasks WHERE key=?").get(key); return row ? JSON.parse(String(row.value)) as TaskRecord : undefined;
  }
  tasks(phases: TaskRecord["phase"][]): TaskRecord[] {
    return this.db.prepare(`SELECT value FROM tasks WHERE phase IN (${phases.map(() => "?").join(",")}) ORDER BY rowid LIMIT 100`).all(...phases).map(row => JSON.parse(String(row.value)) as TaskRecord);
  }
  saveTask(record: TaskRecord): void {
    const old = this.task(record.plan.key);
    if (!old || JSON.stringify(old.plan) !== JSON.stringify(record.plan)) throw Error("Frozen task identity is immutable");
    this.db.prepare("UPDATE tasks SET phase=?,value=? WHERE key=?").run(record.phase, JSON.stringify(record), record.plan.key);
  }
  requestTask(record: TaskRecord): TaskRecord {
    return this.atomic(() => {
      const old = this.task(record.plan.key);
      if (old && (JSON.stringify(old.plan.intent) !== JSON.stringify(record.plan.intent) || JSON.stringify(old.plan.source) !== JSON.stringify(record.plan.source))) throw Error("Changed task intent is not a retry");
      if (old?.approval || old?.request.id === record.request.id) return old;
      record = { ...record, plan: old?.plan ?? record.plan };
      if (old?.request.interaction) this.cancelInteractions(record.plan.source.key, old.request.interaction);
      this.db.prepare("INSERT INTO tasks VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET phase=excluded.phase,value=excluded.value").run(record.plan.key, record.plan.source.key, record.phase, JSON.stringify(record));
      return record;
    });
  }
  publishTaskApproval(key: string, request: string, at: number): void {
    this.atomic(() => {
      const record = this.task(key); if (!record || record.request.id !== request || record.request.surface !== "matrix") throw Error("Task approval publication is stale");
      if (record.phase !== "approval") return;
      const binding = this.binding(record.plan.source.key);
      if (record.request.expires < at || !binding?.enabled || binding.archived) throw Error("Task approval expired or its source is unavailable");
      if (record.request.interaction) {
        if (this.interaction(record.request.interaction)?.state !== "active") this.saveTask({ ...record, phase: "declined" });
        return; // Never revive an earlier poll.
      }
      const interaction = this.materializeInteraction(binding.key, `task-approval:${request}`,
        { kind: "approval", question: taskApprovalText(record.plan) + "\nOnly the configured operator may approve this request.", options: ["Approve", "Cancel"], approval: key });
      this.saveTask({ ...record, request: { ...record.request, interaction: interaction.id } });
    });
  }
  decideTask(key: string, request: string, accepted: boolean, receipt: NonNullable<TaskRecord["approval"]>, inputId?: string): boolean {
    return this.atomic(() => {
      const record = this.task(key); if (!record || record.phase !== "approval" || record.request.id !== request || !Number.isSafeInteger(record.request.expires) || record.request.expires < receipt.at) return false;
      const binding = this.binding(record.plan.source.key); if (!binding?.enabled) return false;
      if (receipt.via === "matrix") {
        const interaction = record.request.interaction ? this.interaction(record.request.interaction) : undefined;
        const input = inputId ? this.db.prepare("SELECT * FROM inputs WHERE id=?").get(inputId) : undefined;
        if (record.request.surface !== "matrix" || binding.archived || !input || input.state !== "received" || input.binding !== binding.key ||
            JSON.parse(String(input.event)).sender !== receipt.sender || receipt.sender !== record.request.operator || receipt.event !== inputId ||
            !interaction || interaction.binding !== binding.key || interaction.state !== "active" || interaction.kind !== "approval" || interaction.approval !== key) return false;
        this.db.prepare("UPDATE interactions SET state='answered',answer=? WHERE id=?").run(inputId!, interaction.id);
        this.db.prepare("UPDATE inputs SET state='settled' WHERE id=?").run(inputId!);
      } else if (record.request.surface !== "local" || inputId !== undefined) return false;
      this.saveTask({ ...record, phase: accepted ? "approved" : "declined", ...(accepted ? { approval: receipt } : {}) });
      return true;
    });
  }
  cancelInteractions(key: string, id?: string): void { this.db.prepare("UPDATE interactions SET state='cancelled' WHERE binding=? AND state='active' AND (? IS NULL OR id=?)").run(key, id ?? null, id ?? null); }
  closeInteractions(key: string): void {
    const rows = this.db.prepare("SELECT interactions.* FROM interactions JOIN outputs start ON start.binding=interactions.binding AND start.source='interaction:' || interactions.id WHERE interactions.binding=? AND interactions.state!='active' AND start.type=? AND start.event_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM outputs WHERE binding=? AND source='interaction-end:' || interactions.id) LIMIT 100").all(key, POLL_START, key);
    for (const row of rows) {
      const value = this.decodeInteraction(row)!, start = this.outputs(key, `interaction:${value.id}`)[0];
      if (value.options && start?.eventId) this.offer(key, `interaction-end:${value.id}`, () => [pollEnd(start.eventId!)]);
    }
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
