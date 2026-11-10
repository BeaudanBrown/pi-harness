import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { dispatchAllowed } from "../config/agent/extensions/matrix-bridge/dispatch-fence.js";
import { BridgeRelay } from "../config/agent/extensions/matrix-bridge/relay.js";
import { BridgeMatrix } from "../config/agent/extensions/matrix-bridge/matrix.js";
import { authorizeInput } from "../config/agent/extensions/matrix-bridge/input.js";
import { POLL_RESPONSE } from "../config/agent/extensions/matrix-bridge/interaction.js";
import { BOT, OWNER, SetupHttp } from "./fixtures/matrix-bridge/setup-http.js";

async function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "bridge-archive-")), cwd = join(root, "workspace"); mkdirSync(cwd);
  let now = Date.now(); t.mock.method(Date, "now", () => now);
  const http = new SetupHttp(), config = { hostId: "host", stateDirectory: join(root, "state"), socket: join(root, "runtime/bridge.sock"), roots: [root], operatorUserId: OWNER };
  let opens = 0, relay = new BridgeRelay(config, new BridgeMatrix(http.bot, BOT), async () => { opens++; });
  const register = (id: string) => {
    const file = join(root, `${id}.jsonl`), timestamp = new Date().toISOString();
    writeFileSync(file, [ { type: "session", version: 3, id, cwd, timestamp }, { type: "custom", id: "boundary", parentId: null, timestamp, customType: "matrix-bridge.boundary", data: { nativeId: id } } ].map(value => JSON.stringify(value) + "\n").join(""));
    return relay.store.register({ file, nativeId: id, cwd, boundary: "boundary", title: id });
  };
  const a = register("a"), b = register("b"); await relay.organization!.pump();
  for (const room of http.rooms.keys()) http.member(room, "join"); now += 6000; await relay.organization!.pump(); relay.store.intake("ready", []);
  t.after(async () => { await relay.stop(); rmSync(root, { recursive: true, force: true }); });
  const binding = (key = a.key) => relay.store.binding(key)!;
  const event = (id: string, body: string, sender = OWNER, key = a.key) => ({ id, room: binding(key).room!, event: { event_id: id, sender, type: "m.room.message", content: { msgtype: "m.text", body } } });
  return { root, a, b, http, get relay() { return relay; }, binding, event, get opens() { return opens; },
    advance: () => { now += 6000; },
    command: async (id: string, body: string, sender = OWNER, key = a.key) => { await relay.syncOnce(); relay.store.intake(id, [event(id, body, sender, key)]); await relay.pump(); },
    restart: async () => { await relay.stop(); relay = new BridgeRelay(config, new BridgeMatrix(http.bot, BOT), async () => { opens++; }); now += 6000; },
    archive: (key = a.key, archived = true) => relay.archive(key, archived, binding(key).archiveRevision ?? 0),
  };
}
function linked(http: SetupHttp, parent: string, child: string): boolean {
  return Array.isArray(http.rooms.get(parent)!.find(event => event.type === "m.space.child" && event.state_key === child)?.content.via);
}
function room(http: SetupHttp, kind: string): string { return [...http.rooms.keys()].find(id => http.kind(id) === kind)!; }

test("the synchronous native dispatch fence reads committed identity/policy only and fails closed without creating a missing ledger", async t => {
  const f = await fixture(t), binding = f.binding(), fence = { ledger: join(f.root, "state/bridge.sqlite"), binding: binding.key, file: binding.file, nativeId: binding.nativeId };
  assert.equal(dispatchAllowed(fence, 0), true); assert.equal(dispatchAllowed({ ...fence, nativeId: "foreign" }, 0), false);
  f.archive(); assert.equal(dispatchAllowed(fence, 0), false); f.archive(binding.key, false); assert.equal(dispatchAllowed(fence, 2), false);
  await f.relay.syncOnce(); assert.equal(dispatchAllowed(fence, 0), false); assert.equal(dispatchAllowed(fence, 2), true);
  const missing = join(f.root, "missing.sqlite"); assert.equal(dispatchAllowed({ ...fence, ledger: missing }, 2), false); assert.equal(existsSync(missing), false);
  const alias = join(f.root, "alias.sqlite"); symlinkSync(fence.ledger, alias); assert.equal(dispatchAllowed({ ...fence, ledger: alias }, 2), false);
  const bad = join(f.root, "bad.sqlite"); writeFileSync(bad, "corrupt", { mode: 0o600 }); assert.equal(dispatchAllowed({ ...fence, ledger: bad }, 2), false); assert.equal(readFileSync(bad, "utf8"), "corrupt");
});

test("archive atomically holds pending/uncertain input and original polls; restore never replays them", async t => {
  const f = await fixture(t), store = f.relay.store, binding = f.binding(), bytes = readFileSync(binding.file);
  store.intake("old", [f.event("$handed", "old handed"), f.event("$queued", "old queued"), f.event("$received", "old received")]);
  store.authorize("$handed", { text: "old handed", sender: OWNER }); store.takeInput(binding.key);
  store.authorize("$queued", { text: "old queued", sender: OWNER });
  const question = store.offerInteraction(binding.key, "question", { kind: "question", nativeEntry: "question", question: "Continue?", options: ["Yes", "No"] });
  f.archive(); assert.equal(store.interaction(question.id)?.state, "cancelled"); assert.equal(store.takeInput(binding.key), undefined);
  assert.throws(() => store.inputChunk(binding.key, "$handed", 0), /Unknown/); assert.equal(store.status(binding.key).interrupted, 2);
  store.intake("archived", [f.event("$during", "during archive")]);
  assert.equal(f.binding().room, binding.room); assert.deepEqual(readFileSync(binding.file), bytes); assert.equal(f.opens, 0);
  f.archive(binding.key, false); assert.equal(f.binding().resumePending, true); assert.throws(() => store.setArchived(binding.key, true, 0), /changed/);
  await f.relay.syncOnce(); assert.equal(f.binding().resumePending, false); await f.relay.pump(); assert.equal(f.opens, 0);
  assert.equal(store.nextInput(binding.key), undefined); assert.equal(store.interaction(question.id)?.state, "cancelled");
  await f.command("$fresh", "fresh intent"); assert.equal(f.opens, 1);
});

test("only explicit current-operator commands change archive state, including restore while archived", async t => {
  const f = await fixture(t), other = "@collaborator:example.test"; f.http.set(f.binding().room!, "m.room.member", other, { membership: "join" });
  await f.command("$other", "!archive", other); assert.equal(f.binding().archived, false);
  await f.command("$archive", "!archive"); assert.equal(f.binding().archived, true); const revision = f.binding().archiveRevision;
  await f.command("$again", "!archive"); assert.equal(f.binding().archiveRevision, revision);
  await f.command("$text", "please continue"); assert.equal(f.opens, 0);
  f.http.member(f.binding().room!, "leave"); await f.command("$departed", "!restore"); assert.equal(f.binding().archived, true);
  f.http.member(f.binding().room!, "join"); await f.command("$restore", "!restore"); assert.equal(f.binding().archived, false); assert.equal(f.binding().resumePending, true);
  assert.equal(f.opens, 0); assert.ok([...f.http.sent.values()].some(event => String(event.content.body).includes("Only the configured operator")));
});

for (const kind of ["prompt", "vote"]) test(`archive crossing awaited membership authorization cannot queue a stale ${kind}`, async t => {
  const f = await fixture(t), store = f.relay.store, binding = f.binding();
  const question = store.offerInteraction(binding.key, "question", { kind: "question", nativeEntry: "question", question: "Continue?", options: ["Yes"] }); await f.relay.pump();
  const poll = store.outputs(binding.key, `interaction:${question.id}`)[0]!.eventId!;
  store.intake("race", [kind === "prompt" ? f.event("$race", "race") : { id: "$race", room: binding.room!, event: { event_id: "$race", sender: OWNER, type: POLL_RESPONSE, content: { "m.relates_to": { rel_type: "m.reference", event_id: poll }, [POLL_RESPONSE]: { answers: ["answer-0"] } } } }]);
  let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
  t.mock.method(f.relay.matrix, "joined", async () => { await barrier; return true; });
  const pending = authorizeInput(store, f.relay.matrix, binding, store.received(binding.key)[0]!);
  f.archive(); f.archive(binding.key, false); release(); await pending;
  assert.equal(store.takeInput(binding.key), undefined); assert.equal(store.status(binding.key).queued, 0); assert.equal(f.opens, 0);
});

test("a sync already in flight before restore cannot release the fresh-input fence", async t => {
  const f = await fixture(t); f.archive(); let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; }), sync = f.http.bot.sync.bind(f.http.bot);
  t.mock.method(f.http.bot, "sync", async (...args: Parameters<typeof sync>) => { await barrier; return sync(...args); });
  const pending = f.relay.syncOnce(); f.archive(f.a.key, false); release(); await pending;
  assert.equal(f.binding().resumePending, true); await f.relay.syncOnce(); assert.equal(f.binding().resumePending, false);
});

test("archive during an awaited wake-membership check cannot open a detached native session", async t => {
  const f = await fixture(t), binding = f.binding(); f.relay.store.intake("queued", [f.event("$queued", "queued")]); f.relay.store.authorize("$queued", { text: "queued", sender: OWNER });
  let release!: () => void, entered!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; }), observed = new Promise<void>(resolve => { entered = resolve; });
  t.mock.method(f.relay.matrix, "joined", async () => { entered(); await barrier; return true; });
  const pending = f.relay.pump(); await observed; f.archive(); f.archive(binding.key, false); release(); await pending; assert.equal(f.opens, 0);
});

test("an old operator command cannot replay across archive revisions or a daemon restart", async t => {
  const f = await fixture(t); f.relay.store.intake("old", [f.event("$old-restore", "!restore")]); f.archive(); await f.restart();
  await f.relay.pump(); assert.equal(f.binding().archived, true);
  await f.command("$current-restore", "!restore"); assert.equal(f.binding().archived, false);
  f.relay.store.intake("stale-archive", [f.event("$old-archive", "!archive")]); f.archive(); f.archive(f.a.key, false); await f.restart();
  await f.relay.pump(); assert.equal(f.binding().archived, false);
});

test("restore's new sync boundary holds offline backlog, survives restart, and does not reopen old polls", async t => {
  const f = await fixture(t), binding = f.binding();
  const question = f.relay.store.offerInteraction(binding.key, "question", { kind: "question", nativeEntry: "question", question: "Continue?", options: ["Yes"] }); await f.relay.pump();
  const poll = f.relay.store.outputs(binding.key, `interaction:${question.id}`)[0]!.eventId!;
  f.archive(); f.archive(binding.key, false); await f.restart(); assert.equal(f.binding().resumePending, true);
  f.http.nextSync = { next_batch: "restored-boundary", rooms: { join: { [binding.room!]: { timeline: { events: [f.event("$backlog", "old offline input").event, f.event("$backlog-command", "!archive").event,
    { event_id: "$old-vote", sender: OWNER, type: POLL_RESPONSE, content: { "m.relates_to": { rel_type: "m.reference", event_id: poll }, [POLL_RESPONSE]: { answers: ["answer-0"] } } }], limited: false } } } } };
  await f.relay.syncOnce(); await f.relay.pump(); assert.equal(f.opens, 0); assert.equal(f.binding().resumePending, false); assert.equal(f.binding().archived, false);
  assert.equal(f.relay.store.interaction(question.id)?.state, "cancelled"); await f.command("$fresh", "new intent"); assert.equal(f.opens, 1);
});

test("archive links its destination before removing live presentation and unlinks only the final live checkout", async t => {
  const f = await fixture(t), a = f.binding(), b = f.binding(f.b.key), checkout = room(f.http, "checkout"), project = room(f.http, "project"), source = readFileSync(a.file);
  const count = f.http.rooms.size; f.archive(); f.advance(); await f.relay.organization!.pump(); const archive = room(f.http, "archive");
  assert.equal(f.http.rooms.size, count + 1); assert.ok(linked(f.http, archive, a.room!)); assert.equal(linked(f.http, checkout, a.room!), false);
  assert.ok(linked(f.http, project, checkout)); assert.ok(linked(f.http, checkout, b.room!));
  const writes = f.http.calls.filter(call => call.method === "PUT" && call.path.endsWith(encodeURIComponent(a.room!)));
  const destination = writes.findIndex(call => call.path.includes(encodeURIComponent(archive)) && Array.isArray(call.body?.via));
  const removal = writes.findIndex(call => call.path.includes(encodeURIComponent(checkout)) && Object.keys(call.body!).length === 0); assert.ok(destination >= 0 && destination < removal);
  f.archive(b.key); f.advance(); await f.relay.organization!.pump(); assert.equal(linked(f.http, project, checkout), false);
  f.archive(a.key, false); f.advance(); await f.relay.organization!.pump(); assert.ok(linked(f.http, project, checkout)); assert.ok(linked(f.http, checkout, a.room!)); assert.equal(linked(f.http, archive, a.room!), false);
  assert.ok(linked(f.http, archive, b.room!)); assert.equal(f.binding().room, a.room); assert.deepEqual(readFileSync(a.file), source);
  assert.ok(!f.http.calls.some(call => /\/(leave|forget|kick|ban)$/.test(call.path)));
});

test("a policy change during a hierarchy write reconciles the latest desired grouping, never deleting rooms", async t => {
  const f = await fixture(t), binding = f.binding(); let release!: () => void, entered!: () => void, blocked = false;
  const barrier = new Promise<void>(resolve => { release = resolve; }), observed = new Promise<void>(resolve => { entered = resolve; }), request = f.http.bot.request.bind(f.http.bot);
  t.mock.method(f.http.bot, "request", async (...args: Parameters<typeof request>) => {
    if (!blocked && args[0] === "PUT" && args[1].includes("/state/m.space.child/")) { blocked = true; entered(); await barrier; }
    return request(...args);
  });
  f.archive(); f.advance(); const pending = f.relay.organization!.pump(); await observed;
  f.relay.store.offer(f.b.key, "healthy", () => [{ type: "m.room.message", content: { msgtype: "m.notice", body: "Other-room output during blocked archive setup" } }]); await f.relay.pump();
  assert.ok([...f.http.sent.values()].some(event => event.content.body === "Other-room output during blocked archive setup"));
  f.archive(binding.key, false); release(); await pending;
  f.advance(); await f.relay.organization!.pump(); assert.ok(linked(f.http, room(f.http, "checkout"), binding.room!)); assert.equal(linked(f.http, room(f.http, "archive"), binding.room!), false);
  assert.equal(f.binding().room, binding.room); assert.ok(!f.http.calls.some(call => /\/(leave|forget|kick|ban)$/.test(call.path)));
});

test("offline and lost hierarchy acknowledgement preserve desired policy and original identities across restart", async t => {
  const f = await fixture(t), binding = f.binding(), count = f.http.rooms.size; f.http.outage = true; f.archive(); f.advance(); await f.relay.organization!.pump();
  assert.equal(f.binding().archived, true); assert.equal(f.relay.organization!.status(binding.key).stage, "grouping"); assert.equal(f.opens, 0);
  f.http.outage = false; await f.restart(); f.http.linkFailure = true; await f.relay.organization!.pump();
  const archive = room(f.http, "archive"); assert.ok(archive); await f.restart(); await f.relay.organization!.pump();
  assert.equal(f.http.rooms.size, count + 1); assert.ok(linked(f.http, archive, binding.room!)); assert.equal(f.binding().room, binding.room);
  f.archive(binding.key, false); f.archive(binding.key, true); f.archive(binding.key, false); f.advance(); await f.relay.organization!.pump();
  assert.ok(linked(f.http, room(f.http, "checkout"), binding.room!)); assert.equal(linked(f.http, archive, binding.room!), false); assert.equal(f.http.rooms.size, count + 1);
});
