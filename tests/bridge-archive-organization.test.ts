import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { BridgeRelay } from "../config/agent/extensions/matrix-bridge/relay.js";
import { BridgeMatrix } from "../config/agent/extensions/matrix-bridge/matrix.js";
import { BOT, OWNER, SetupHttp } from "./fixtures/matrix-bridge/setup-http.js";

async function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "bridge-archive-")), cwd = join(root, "workspace"); mkdirSync(cwd);
  let now = Date.now(); t.mock.method(Date, "now", () => now);
  const http = new SetupHttp(), config = { hostId: "host", stateDirectory: join(root, "state"), socket: join(root, "runtime/bridge.sock"), roots: [root], operatorUserId: OWNER };
  let opens = 0, relay = new BridgeRelay(config, new BridgeMatrix(http.bot, BOT));
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
    restart: async () => { await relay.stop(); relay = new BridgeRelay(config, new BridgeMatrix(http.bot, BOT)); now += 6000; },
    archive: (key = a.key, archived = true) => relay.archive(key, archived, binding(key).archiveRevision ?? 0),
  };
}
function linked(http: SetupHttp, parent: string, child: string): boolean {
  return Array.isArray(http.rooms.get(parent)!.find(event => event.type === "m.space.child" && event.state_key === child)?.content.via);
}
function room(http: SetupHttp, kind: string): string { return [...http.rooms.keys()].find(id => http.kind(id) === kind)!; }

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
