import assert from "node:assert/strict";
import { chmodSync, cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { canonical, exportSnapshot, inventory, readSnapshot, requireReadOnly, type Snapshot } from "../config/agent/extensions/matrix-bridge/migration-files.js";
import { convert } from "../config/agent/extensions/matrix-bridge/migration-convert.js";
import { checkMigration, importSnapshot } from "../config/agent/extensions/matrix-bridge/migration.js";
import { BridgeStore } from "../config/agent/extensions/matrix-bridge/store.js";
import { BridgeOrganization } from "../config/agent/extensions/matrix-bridge/organization.js";
import { BridgeMatrix, syncIntoStore } from "../config/agent/extensions/matrix-bridge/matrix.js";
import { BridgeRelay, connect } from "../config/agent/extensions/matrix-bridge/relay.js";
import { offerHistory } from "../config/agent/extensions/matrix-bridge/history.js";
import { MatrixHttp } from "../config/agent/extensions/matrix-shared/http.js";
import { SetupHttp } from "./fixtures/matrix-bridge/setup-http.js";

const frozen = process.env.PI_BRIDGE_MIGRATION_FIXTURE;
assert.ok(frozen, "PI_BRIDGE_MIGRATION_FIXTURE must name the immutable packaged fixture (no skipped filesystem check)");
const source = resolve(frozen);
function temporary(t: TestContext): string { const root = mkdtempSync(join(tmpdir(), "bridge-migration-")); t.after(() => rmSync(root, { recursive: true, force: true })); return root; }
function changed(snapshot: Snapshot, path: string, update: (value: Record<string, unknown>) => void): Snapshot {
  return { ...snapshot, json: name => { const value = snapshot.json(name); if (name === path) update(value); return value; } };
}
function imported(t: TestContext) {
  const root = temporary(t), target = join(root, "new-state"), value = importSnapshot(source, target);
  return { root, target, value, db: join(target, "bridge.sqlite") };
}
function setup(store: BridgeStore, http: SetupHttp): BridgeOrganization {
  const account = store.progress<{ bot: string; operator: string }>("migration-account")!;
  const nodes = convert(readSnapshot(source, true)).progress;
  for (const [key, value] of Object.entries(nodes)) if (key.startsWith("setup-node:")) {
    const node = value as { room: string; stamp: { kind: string } };
    if (!http.rooms.has(node.room)) http.rooms.set(node.room, [http.event("m.room.create", "", account.bot, { room_version: "12", "m.federate": false, ...(node.stamp.kind === "conversation" ? {} : { type: "m.space" }) }), http.event("m.room.member", account.operator, account.operator, { membership: "join" })]);
  }
  return new BridgeOrganization(store, http.bot, { hostId: "fixture", botUserId: account.bot, operatorUserId: account.operator }, async () => { throw Error("Must retain imported grouping, not discover/recreate it"); });
}

test("migration accepts a kernel read-only snapshot and refuses writable/chmod-only sources", t => {
  requireReadOnly(source);
  const snapshot = readSnapshot(source, true), report = convert(snapshot).report;
  assert.equal(report.bindings.length, 7);
  const root = temporary(t), copy = join(root, "copy"); cpSync(source, copy, { recursive: true });
  chmodSync(copy, 0o500); assert.throws(() => readSnapshot(copy), /Writable\/live/); chmodSync(copy, 0o700);
  assert.equal(snapshot.inventory.digest, inventory(source).digest);
  assert.ok(report.bindings.find(row => row.nativeId === "native-missing")!.findings.some(text => /unavailable/.test(text)));
  assert.ok(report.findings.some(text => /damaged/.test(text)));
});

test("export is complete, deterministic, no-replace and leaves original bytes and unrelated files alone", t => {
  const root = temporary(t), target = join(root, "backup"), before = inventory(source);
  writeFileSync(join(root, "unrelated"), "retain");
  const first = exportSnapshot(source, target), second = exportSnapshot(source, target);
  assert.deepEqual(first, second); assert.deepEqual(inventory(target, false), before);
  for (const item of before.files) assert.deepEqual(readFileSync(join(target, item.path)), readFileSync(join(source, item.path)));
  assert.equal(readFileSync(join(root, "unrelated"), "utf8"), "retain");
  writeFileSync(join(target, "state/unrelated.txt"), "foreign change");
  assert.throws(() => exportSnapshot(source, target), /Different or incomplete/);
  assert.equal(readFileSync(join(target, "state/unrelated.txt"), "utf8"), "foreign change");
  assert.deepEqual(inventory(source), before);
});

test("export interruption preserves partial work and only a complete published marker is retryable", t => {
  for (const boundary of ["export-file", "export-before-marker", "before-publish", "after-publish"]) {
    const root = temporary(t), target = join(root, "backup");
    assert.throws(() => exportSnapshot(source, target, point => { if (point === boundary) throw Error("injected death boundary"); }), /injected/);
    assert.equal(existsSync(target), boundary === "after-publish");
    if (boundary !== "after-publish") assert.equal(readdirSync(root).filter(name => name.startsWith(".backup-partial-")).length, 1);
    assert.equal(exportSnapshot(source, target).digest, inventory(source).digest);
  }
});

test("import retains native IDs, generation exclusions, original rooms, raw terminal evidence and exact cutoffs", t => {
  const f = imported(t), before = inventory(source), store = new BridgeStore(f.db, "fixture"); t.after(() => store.close());
  assert.equal(store.bindings().length, 5);
  assert.equal(store.cursor(), "original-sync-cutoff");
  const live = store.bindings().find(row => row.nativeId === "native-live")!;
  assert.equal(live.room, "!live:example.org"); assert.equal(live.file, "/migration-fixture/native/native-live.jsonl");
  assert.equal(live.boundary, "projection-receipt"); assert.equal(store.progress(`projection:${live.key}`), "projection-receipt");
  assert.equal(live.enabled, true); assert.equal(live.resumePending, true);
  assert.equal(store.bindings().some(row => row.nativeId === "native-previous"), false);
  assert.equal(store.bindings().find(row => row.nativeId === "native-archived")!.archived, true);
  for (const name of ["retired", "disabled"]) assert.equal(store.bindings().find(row => row.nativeId === `native-${name}`)!.enabled, false);
  assert.deepEqual(inventory(source), before);
  assert.ok(store.progress(`migration-legacy:${store.bindings().find(row => row.nativeId === "native-retired")!.key}`));
});

test("imported inputs distinguish never-attempted from uncertain without replay; original polls/images stay retained", t => {
  const f = imported(t), store = new BridgeStore(f.db, "fixture"); t.after(() => store.close());
  const live = store.bindings().find(row => row.nativeId === "native-live")!;
  assert.equal(store.status(live.key).interrupted, 4); assert.equal(store.status(live.key).queued, 0); assert.equal(store.nextInput(live.key), undefined);
  assert.deepEqual(store.progress("migration-input:$input-accepted"), { originalStatus: "accepted", unattempted: true });
  assert.deepEqual(store.progress("migration-input:$input-delivered"), { originalStatus: "delivered", unattempted: false });
  assert.equal(store.activeInteraction(live.key), undefined);
  assert.equal((store.progress<Array<{ pollEventId: string }>>(`migration-polls:${live.key}`))![0]!.pollEventId, "$original-poll");
  const db = new DatabaseSync(f.db, { readOnly: true });
  try {
    const images = db.prepare("SELECT data FROM images WHERE input=? ORDER BY offset").all("$input-delivered");
    const original = readSnapshot(source).inventory.files.find(item => item.path.endsWith(".blob"))!;
    assert.deepEqual(Buffer.concat(images.map(row => Buffer.from(row.data as Uint8Array))), readFileSync(join(source, original.path)));
  } finally { db.close(); }
  store.resumeAfterSync(live.key, 0);
  store.intake("fresh", [{ id: "$fresh", room: live.room!, event: { sender: "@operator:example.org" } }]);
  assert.equal(store.authorize("$fresh", { text: "fresh intent", sender: "@operator:example.org" }), true);
  assert.equal(store.takeInput(live.key, "$fresh")?.id, "$fresh");
  assert.equal(store.takeInput(live.key, "$input-accepted"), undefined);
});

test("lost-ack legacy sends retry original frozen transactions/content, including first-chunk-only notification", async t => {
  const f = imported(t), http = new SetupHttp(); let store = new BridgeStore(f.db, "fixture"); t.after(() => store.close());
  const live = store.bindings().find(row => row.nativeId === "native-live")!, matrix = new BridgeMatrix(http.bot, "@bot:example.org");
  http.rooms.set(live.room!, []);
  const original = convert(readSnapshot(source, true)).outputs;
  assert.equal(original.length, 2);
  assert.deepEqual(original[0]!.content["m.mentions"], { room: true }); assert.deepEqual(original[1]!.content["m.mentions"], {});
  const event = await matrix.send(live.room!, store.outputs(live.key)[0]!); // Intentionally lose local acknowledgement.
  store.close(); store = new BridgeStore(f.db, "fixture");
  const retry = store.outputs(live.key)[0]!;
  assert.equal(await matrix.send(live.room!, retry), event); store.sent(retry.id, event);
  assert.equal(http.sent.size, 1); assert.deepEqual(retry.content, original[0]!.content); assert.equal(retry.id, original[0]!.id);
  assert.equal(store.outputs(live.key).length, 1);
});

test("original imported rooms organize without new stamps, replacements, invitations, account cleanup or artifact upload", async t => {
  const f = imported(t), store = new BridgeStore(f.db, "fixture"), http = new SetupHttp(), organization = setup(store, http);
  t.after(async () => { await organization.stop(); store.close(); });
  await organization.pump();
  assert.equal(http.count("/createRoom"), 0); assert.equal(http.count("/invite"), 0);
  assert.ok(http.calls.some(call => call.method === "PUT" && call.path.includes("m.space.child")));
  assert.equal(http.calls.some(call => /leave|forget|kick|upload|sendToDevice/.test(call.path)), false);
  for (const name of ["live", "dormant", "archived"]) assert.equal(organization.status(store.bindings().find(row => row.nativeId === `native-${name}`)!.key).stage, "ready");
  const archived = store.bindings().find(row => row.nativeId === "native-archived")!;
  store.setArchived(archived.key, false, 0); await organization.pump();
  assert.equal(store.binding(archived.key)!.room, archived.room);
  assert.equal(http.count("/createRoom"), 0);
});

test("inaccessible/foreign original rooms stay pending, never replaced or reinvited", async t => {
  for (const mode of ["missing", "foreign", "departed"] as const) {
    const f = imported(t), store = new BridgeStore(f.db, "fixture"), http = new SetupHttp(), organization = setup(store, http);
    t.after(async () => { await organization.stop(); store.close(); });
    const live = store.bindings().find(row => row.nativeId === "native-live")!;
    if (mode === "missing") http.rooms.delete(live.room!);
    if (mode === "foreign") http.rooms.get(live.room!)![0]!.sender = "@foreign:example.org";
    if (mode === "departed") http.rooms.set(live.room!, http.rooms.get(live.room!)!.filter(event => event.type !== "m.room.member"));
    await organization.pump();
    assert.notEqual(organization.status(live.key).stage, "ready");
    assert.equal(store.binding(live.key)!.room, "!live:example.org");
    assert.equal(http.count("/createRoom"), 0); assert.equal(http.count("/invite"), 0);
  }
});

test("disabled, retired and historical generations cannot register or enable by native launch; fresh identities still can", t => {
  const f = imported(t), store = new BridgeStore(f.db, "fixture"); t.after(() => store.close());
  for (const nativeId of ["native-retired", "native-disabled", "native-previous"]) {
    const policy = store.progress<{ file: string }>(`migration-native:${nativeId}`)!;
    assert.throws(() => store.register({ nativeId, file: policy.file, cwd: "/migration-fixture/work", title: nativeId, boundary: null }), /Historical migration identity/);
    const old = store.bindings().find(row => row.nativeId === nativeId);
    if (old) assert.equal(store.setEnabled(old.key, true), false);
  }
  const live = store.bindings().find(row => row.nativeId === "native-live")!;
  assert.equal(store.register(live).room, live.room);
  assert.throws(() => store.register({ ...live, file: `${live.file}.moved` }), /disabled or moved/);
  assert.equal(store.register({ nativeId: "fresh-native-fork", file: join(f.root, "fresh.jsonl"), cwd: f.root, title: "fresh", boundary: null }).enabled, true);
});

test("persisted automatic enrollment after migration cannot project disabled history", t => {
  const root = temporary(t), file = join(root, "native.jsonl"), store = new BridgeStore(join(root, "bridge.sqlite"), "test"); t.after(() => store.close());
  const binding = store.register({ nativeId: "disabled", file, cwd: root, title: "disabled", boundary: "boundary" });
  store.saveProgress("migration-native:disabled", { file, disabled: true, reason: "historical" });
  store.setEnabled(binding.key, false);
  const entries = [{ type: "session", id: "disabled", cwd: root, version: 3 }, { type: "custom", id: "boundary", customType: "old-managed-boundary", data: {} }, { type: "custom", id: "auto-enroll", customType: "matrix-bridge.enrollment", data: { nativeId: "disabled", enabled: true } }, { type: "message", id: "private", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "must stay local" }] } }];
  writeFileSync(file, entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
  offerHistory(store, store.binding(binding.key)!);
  assert.equal(store.binding(binding.key)!.enabled, false); assert.equal(store.outputs(binding.key).length, 0);
  assert.equal(store.progress(`projection:${binding.key}`), "private");
});

test("deterministic import is interruption-safe, leaves partial siblings, and never overwrites a foreign destination", t => {
  for (const boundary of ["import-before-commit", "import-after-commit", "import-receipt", "before-publish", "after-publish"]) {
    const root = temporary(t), target = join(root, "new-state");
    assert.throws(() => importSnapshot(source, target, point => { if (point === boundary) throw Error("injected crash"); }), /injected crash/);
    assert.equal(existsSync(target), boundary === "after-publish");
    const first = importSnapshot(source, target), bytes = readFileSync(join(target, "bridge.sqlite"));
    assert.equal(first.started, false); assert.equal(first.pristine, true);
    assert.deepEqual(importSnapshot(source, target), first); assert.deepEqual(readFileSync(join(target, "bridge.sqlite")), bytes);
    const second = join(root, "second"); importSnapshot(source, second);
    assert.deepEqual(readFileSync(join(second, "bridge.sqlite")), bytes);
  }
  const root = temporary(t), foreign = join(root, "foreign"); cpSync(source, foreign, { recursive: true });
  const original = readdirSync(foreign); assert.throws(() => importSnapshot(source, foreign)); assert.deepEqual(readdirSync(foreign), original);
});

test("first runtime writer permanently fences stale rollback; duplicate import/check never changes new work", t => {
  const f = imported(t); assert.equal(f.value.started, false);
  const store = new BridgeStore(f.db, "fixture"), live = store.bindings().find(row => row.nativeId === "native-live")!;
  store.saveProgress("fresh-new-work", { completed: "later receipt" });
  store.intake("newer-cursor", [{ id: "$new", room: live.room!, event: { body: "new work" } }]); store.close();
  const before = readFileSync(f.db), value = importSnapshot(source, f.target);
  assert.equal(value.started, true); assert.equal(value.pristine, false); assert.match(value.rollback, /never restore stale queues/);
  assert.deepEqual(readFileSync(f.db), before); assert.deepEqual(checkMigration(source, f.target), value);
});

test("unknown versions, partial authority, duplicate identities, and unfrozen evidence fail closed or report unresolved", () => {
  const snapshot = readSnapshot(source, true);
  assert.throws(() => convert(changed(snapshot, "state/registry.json", value => { value.schemaVersion = "2.0.0"; })), /Unsupported/);
  assert.throws(() => convert(changed(snapshot, "state/registry.json", value => { value.hostId = "foreign"; })), /foreign/);
  assert.throws(() => convert(changed(snapshot, "state/registry.json", value => { (value.conversations as unknown[]).push((value.conversations as unknown[])[0]); })), /Duplicate runtime/);
  const incomplete = { ...snapshot, inventory: { ...snapshot.inventory, files: snapshot.inventory.files.filter(file => !file.path.endsWith("/archives.json")) } };
  assert.throws(() => convert(incomplete), /archive evidence is missing/);
  const result = convert(snapshot), live = result.report.bindings.find(row => row.nativeId === "native-live")!;
  assert.ok(live.findings.some(text => /Unfrozen output unresolved/.test(text))); assert.ok(live.findings.some(text => /polls retained inactive/.test(text)));
  assert.ok(result.report.findings.some(text => /Notice outbox/.test(text)));
  assert.ok(!canonical(result.report).includes("private text"));
  assert.ok(result.report.bindings.every(row => row.findings.length <= 16));
});

test("malformed or future legacy room cursor evidence cannot silently lose its cutoff", () => {
  for (const cursor of [undefined, null, { status: "future" }, { status: "established" }, { status: "established", since: "" }, { status: "established", since: "x".repeat(2049) }, { status: "established", since: "valid", extra: true }, { status: "bootstrap", since: "unclassified" }]) {
    assert.throws(() => convert(changed(readSnapshot(source, true), "state/registry.json", value => {
      (value.conversations as Array<Record<string, unknown>>)[0]!.matrixCursor = cursor;
    })), /cursor/i);
  }
  assert.throws(() => convert(changed(readSnapshot(source, true), "state/inbox.json", value => { value.lastBatch = null; })), /global inbox cutoff/);
});

test("a sent or cancelled projection cannot collide with a pending original transaction", () => {
  for (const status of ["sent", "cancelled"]) {
    assert.throws(() => convert(changed(readSnapshot(source, true), "state/registry.json", value => {
      const projections = ((value.conversations as Array<Record<string, unknown>>)[0]!.projection as Array<Record<string, unknown>>);
      const frozen = projections[0]!, chunks = frozen.chunks as Array<Record<string, unknown>>;
      if (status === "sent") { chunks[0]!.status = "sent"; chunks[1]!.transactionId = chunks[0]!.transactionId; }
      else projections.push({ ...frozen, status: "cancelled", chunks: [chunks[0]!] });
    })), /transaction/i);
  }
});

test("frozen legacy wire types/default dispositions remain exact rather than passing through the new renderer", () => {
  for (const [kind, disposition, msgtype, mentions] of [["notice", "notify", "m.text", { room: true }], ["checkpoint", "silent", "m.text", {}], ["assistant_commentary", undefined, "m.text", {}], ["branch_marker", undefined, "m.notice", {}], ["local_user", undefined, "m.text", undefined]] as const) {
    const snapshot = changed(readSnapshot(source, true), "state/registry.json", value => {
      const live = (value.conversations as Array<Record<string, unknown>>)[0]!;
      const projection = (live.projection as Array<Record<string, unknown>>)[0]!;
      projection.kind = kind; projection.disposition = disposition; projection.chunks = (projection.chunks as unknown[]).slice(0, 1); live.projection = [projection];
    });
    const output = convert(snapshot).outputs[0]!;
    assert.deepEqual(output.content, { msgtype, body: "frozen original 0", ...(msgtype === "m.text" ? { format: "org.matrix.custom.html", formatted_body: "<p>frozen original 0</p>" } : {}), ...(mentions ? { "m.mentions": mentions, "lol.bepis.pi.notification": { version: 1, disposition: kind === "branch_marker" || kind === "assistant_commentary" ? "silent" : disposition } } : {}) });
  }
});

test("historical transaction syntax and frozen payload validation match the old sender exactly", () => {
  const snapshot = (transactionId: string, body = "original") => changed(readSnapshot(source, true), "state/registry.json", value => {
    const live = (value.conversations as Array<Record<string, unknown>>)[0]!, projection = (live.projection as Array<Record<string, unknown>>)[0]!;
    const chunk = (projection.chunks as Array<Record<string, unknown>>)[0]!;
    chunk.transactionId = transactionId; chunk.body = body;
  });
  assert.equal(convert(snapshot("original~._-receipt")).outputs[0]!.id, "original~._-receipt");
  assert.throws(() => convert(snapshot("not:accepted-by-old-sender")), /transaction identity/);
  assert.throws(() => convert(snapshot("original", "bad\u0000payload")), /string/i);
});

test("old repair-held output remains frozen but cannot become a live retry during migration", () => {
  const result = convert(changed(readSnapshot(source, true), "state/registry.json", value => {
    const live = (value.conversations as Array<Record<string, unknown>>)[0]!, projection = (live.projection as Array<{ entryId: string }>)[0]!;
    live.repairQueueHolds = [{ kind: "projection", id: projection.entryId, operationId: "old-unconsumed-decision" }];
  }));
  assert.equal(result.outputs.length, 0);
  assert.equal(Object.keys(result.progress).filter(key => key.startsWith("migration-held-output:")).length, 2);
  assert.ok(result.report.bindings.some(row => row.findings.some(text => /remains held/.test(text))));
});

test("missing/corrupt media is explicit, and bot/state inbox events cannot generate interrupted-input spam", () => {
  const original = readSnapshot(source, true), snapshot = changed(original, "state/inbox.json", value => {
    const job = (value.jobs as Array<{ response: { rooms: { join: Record<string, { timeline: { events: unknown[] } }> } } }>)[0]!;
    job.response.rooms.join["!live:example.org"]!.timeline.events.push({ event_id: "$old-bot", type: "m.room.message", sender: "@bot:example.org", content: { msgtype: "m.text", body: "old bot answer" } }, { event_id: "$old-membership", type: "m.room.member", sender: "@operator:example.org", content: { membership: "join" } });
  });
  const result = convert({ ...snapshot, file: path => path.endsWith(".blob") ? Buffer.from("corrupt") : snapshot.file(path) });
  assert.equal(result.images.length, 0); assert.ok(result.report.bindings.some(row => row.findings.some(text => /integrity mismatch/.test(text))));
  assert.equal(result.inputs.find(row => row.id === "$old-bot")!.state, "ignored");
  assert.equal(result.inputs.find(row => row.id === "$old-membership")!.state, "ignored");
});

test("an empty/wrong ledger cannot resurrect matching historical native markers; genuine native forks remain new identities", async t => {
  const root = temporary(t), socket = join(root, "bridge.sock"), relay = new BridgeRelay({ hostId: "host", stateDirectory: join(root, "state"), socket, roots: [root] }, new BridgeMatrix(new SetupHttp().bot, "@bot:example.test"), async () => { throw Error("No wake expected"); });
  await relay.start(false); const peer = await connect(socket, async () => ({})); t.after(async () => { peer.close(); await relay.stop(); });
  for (const nativeId of ["old-native", "fresh-fork"]) {
    const file = join(root, `${nativeId}.jsonl`);
    writeFileSync(file, [{ type: "session", id: nativeId, version: 3, cwd: root }, { type: "custom", id: "historical", customType: "managed-session.binding", data: { sessionId: "old-native" } }, { type: "custom", id: "boundary", customType: "matrix-bridge.boundary", data: { nativeId } }].map(row => JSON.stringify(row)).join("\n") + "\n");
    const register = peer.request("register", { file, nativeId, boundary: "boundary", title: "test" });
    if (nativeId === "old-native") { await assert.rejects(register, /explicit offline migration/); assert.equal(relay.store.bindings().length, 0); }
    else { await register; assert.equal(relay.store.bindings()[0]!.nativeId, "fresh-fork"); }
  }
});

test("imported sends cannot change bot/operator accounts, and rejected startup releases owned daemon resources", async t => {
  const f = imported(t), http = new SetupHttp(), config = { hostId: "fixture", stateDirectory: f.target, socket: join(f.root, "socket"), roots: [f.root], operatorUserId: "@operator:example.org" };
  for (const [bot, operator] of [["@foreign:example.org", config.operatorUserId], ["@bot:example.org", "@foreign:example.org"]]) {
    assert.throws(() => new BridgeRelay({ ...config, operatorUserId: operator }, new BridgeMatrix(http.bot, bot!), async () => ({})), /Migrated bot\/operator identity changed/);
  }
  const relay = new BridgeRelay(config, new BridgeMatrix(http.bot, "@bot:example.org"), async () => ({}));
  await relay.stop(); assert.equal(http.count(""), 0);
  assert.equal(checkMigration(source, f.target).started, true, "startup failure is not proof that an imported writer never opened");
});

test("imported delivery waits only for exact original room ownership, not hierarchy/checkout availability", async t => {
  const f = imported(t), http = new SetupHttp(), relay = new BridgeRelay({ hostId: "fixture", stateDirectory: f.target, socket: join(f.root, "socket"), roots: [f.root], operatorUserId: "@operator:example.org" }, new BridgeMatrix(http.bot, "@bot:example.org"), async () => { throw Error("No native wake expected"); });
  const seeded = setup(relay.store, http); await seeded.stop();
  t.after(async () => relay.stop());
  let now = Date.now(); t.mock.method(Date, "now", () => now);
  await relay.pump(); assert.equal(http.sent.size, 0, "never send private history to an unverified imported room");
  http.rooms.get("!live:example.org")![0]!.sender = "@foreign:example.org";
  await relay.organization!.pump(); await relay.pump(); assert.equal(http.sent.size, 0);
  http.rooms.get("!live:example.org")![0]!.sender = "@bot:example.org";
  http.rooms.delete("!checkout:example.org"); now += 6000;
  await relay.organization!.pump(); await relay.pump();
  assert.equal(http.count("/createRoom"), 0); assert.equal(http.count("/invite"), 0);
  const original = convert(readSnapshot(source, true)).outputs;
  assert.ok(original.every(output => http.sent.has(output.id)), "frozen original-room sends survive failed checkout grouping");
  const live = relay.store.bindings().find(row => row.nativeId === "native-live")!;
  assert.equal(relay.store.status(live.key).interrupted, 4);
  assert.ok([...http.sent.values()].some(event => String(event.content.body).includes("never dispatched")));
});

test("original room cutoffs recover under the cutover hold; departed disabled rooms cannot pin the new cursor", async t => {
  const f = imported(t), store = new BridgeStore(f.db, "fixture"); t.after(() => store.close());
  let round = 0; const calls: string[] = [];
  const event = (id: string) => ({ event_id: id, type: "m.room.message", sender: "@operator:example.org", content: { msgtype: "m.text", body: id } });
  const http = new MatrixHttp({ homeserver: "https://example.org", accessToken: "fixture" }, (async (value: URL | RequestInfo) => {
    const url = new URL(String(value)); calls.push(url.pathname);
    if (url.pathname.endsWith("/sync")) {
      round++; return new Response(JSON.stringify({ next_batch: round > 2 ? "fresh-sync" : "cutover-sync", rooms: { join: { "!live:example.org": { timeline: { events: [event(round > 2 ? "$after-cutover" : "$during-cutover")], limited: false } } } } }));
    }
    assert.ok(url.pathname.endsWith("/messages"));
    assert.ok(!url.pathname.includes("retired") && !url.pathname.includes("disabled"), "do not request history in historical departed rooms");
    return new Response(JSON.stringify({ start: url.searchParams.get("from"), end: url.searchParams.get("to"), chunk: url.pathname.includes("live") ? [event("$before-global-cutoff")] : [] }));
  }) as typeof fetch, { maxAttempts: 1 });
  const matrix = new BridgeMatrix(http, "@bot:example.org"), live = store.bindings().find(row => row.nativeId === "native-live")!;
  assert.deepEqual(await syncIntoStore(matrix, store), []); assert.equal(store.cursor(), "original-sync-cutoff");
  assert.equal(store.binding(live.key)!.resumePending, true);
  assert.deepEqual(await syncIntoStore(matrix, store), []); assert.equal(store.cursor(), "cutover-sync");
  assert.equal(store.binding(live.key)!.resumePending, false);
  assert.ok(store.received(live.key).filter(row => row.id !== "$after-cutover").every(row => row.held));
  assert.deepEqual(await syncIntoStore(matrix, store), []); assert.equal(store.cursor(), "fresh-sync");
  assert.equal(store.received(live.key).find(row => row.id === "$after-cutover")!.held, undefined);
  assert.equal(calls.filter(path => path.endsWith("/messages")).length, 3);
});

test("ambiguous copied native identities require an explicit current-file map, never a guessed active binding", () => {
  const original = readSnapshot(source, true), file = original.inventory.files.find(item => item.path === "native/native-live.jsonl")!, copy = "native/copied-live.jsonl";
  const snapshot: Snapshot = { ...original, inventory: { ...original.inventory, files: [...original.inventory.files, { ...file, path: copy }] }, file: path => original.file(path === copy ? file.path : path), original: path => path === copy ? "/migration-fixture/native/copied-live.jsonl" : original.original(path) };
  assert.equal(convert(snapshot).bindings.some(binding => binding.nativeId === "native-live"), false);
  const mapped = { ...snapshot, inventory: { ...snapshot.inventory, source: { ...snapshot.inventory.source, currentFiles: { "native-live": "/migration-fixture/native/native-live.jsonl" } } } };
  assert.equal(convert(mapped).bindings.find(binding => binding.nativeId === "native-live")!.file, "/migration-fixture/native/native-live.jsonl");
});

test("pre-start rollback eligibility observes original native bytes and detects added as well as changed history", t => {
  const snapshot = readSnapshot(join(source, "pristine"), true), original = snapshot.inventory.source.roots.find(root => root.role === "native")!.original;
  assert.equal(original, "/tmp/pi-bridge-migration-pristine-169-native");
  // Exclusive creation: never adopt/remove a pre-existing directory at this
  // fixture-declared path. Other fixtures use wholly different original paths.
  mkdirSync(original, { mode: 0o700 }); t.after(() => rmSync(original, { recursive: true, force: true }));
  cpSync(join(source, "pristine/native"), original, { recursive: true }); chmodSync(original, 0o700);
  const target = join(temporary(t), "state");
  const initial = importSnapshot(snapshot.root, target);
  assert.equal(initial.started, false); assert.equal(initial.pristine, true); assert.equal(initial.nativeUnchanged, true);
  assert.equal(initial.rollback, "pre-start-only; separate approval required");
  writeFileSync(join(original, "new-native.jsonl"), "new post-capture work", { mode: 0o600 });
  assert.equal(checkMigration(snapshot.root, target).nativeUnchanged, false);
  rmSync(join(original, "new-native.jsonl"));
  const file = join(original, "session.jsonl"); chmodSync(file, 0o600); writeFileSync(file, readFileSync(file, "utf8") + "new work\n");
  const changed = checkMigration(snapshot.root, target);
  assert.equal(changed.started, false); assert.equal(changed.nativeUnchanged, false); assert.match(changed.rollback, /never restore stale queues/);
});

test("inventory independently rejects original-root aliases and symlinks even without the mount check", t => {
  const root = temporary(t), copy = join(root, "snapshot"); cpSync(source, copy, { recursive: true });
  const descriptor = join(copy, "source.json"), spec = JSON.parse(readFileSync(descriptor, "utf8")), original = spec.roots[0].original;
  chmodSync(descriptor, 0o600); spec.roots[0].original = join(copy, spec.roots[0].name); writeFileSync(descriptor, JSON.stringify(spec));
  assert.throws(() => inventory(copy, false), /Live source alias/);
  spec.roots[0].original = original; writeFileSync(descriptor, JSON.stringify(spec));
  chmodSync(join(copy, "native"), 0o700); symlinkSync(descriptor, join(copy, "native", "alias.jsonl"));
  assert.throws(() => inventory(copy, false), /symlink|special|non-regular/);
});
