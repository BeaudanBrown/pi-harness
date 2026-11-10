import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, appendFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BridgeRelay, connect, type RelayConfig } from "../config/agent/extensions/matrix-bridge/relay.js";
import { BridgeMatrix } from "../config/agent/extensions/matrix-bridge/matrix.js";
import { MatrixHttp } from "../config/agent/extensions/matrix-shared/http.js";
import { object, type Peer } from "../config/agent/extensions/matrix-bridge/wire.js";

const room = "!test:example.org", bot = "@bridge:example.org", friend = "@friend:example.org";
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "bridge-relay-")), file = join(root, "native.jsonl");
  const entries = [
    { type: "session", version: 3, id: "native", cwd: root },
    { type: "message", id: "old", message: { role: "user", content: "PRE-BINDING SECRET" } },
    { type: "custom", id: "boundary", customType: "matrix-bridge.boundary", data: { nativeId: "native" } },
    { type: "message", id: "between", message: { role: "user", content: "UNREGISTERED SECRET after an old/copied native marker" } },
  ];
  writeFileSync(file, entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
  const config: RelayConfig = { hostId: "test-host", stateDirectory: join(root, "state"), socket: join(root, "bridge.sock"), roots: [root] };
  const sent = new Map<string, { event: string; content: Record<string, unknown> }>(), attempts: string[] = [];
  const syncs: Record<string, unknown>[] = [];
  let loseSend = false;
  const matrix = new BridgeMatrix(new MatrixHttp({ homeserver: "https://example.org", accessToken: "only-the-daemon-receives-this" }, async (url, init) => {
    assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer only-the-daemon-receives-this");
    const path = new URL(String(url)).pathname;
    if (path.endsWith("/sync")) return Response.json(syncs.shift() ?? { next_batch: "next", rooms: {} });
    if (path.includes("/state/m.room.member/")) return Response.json({ membership: decodeURIComponent(path.split("/").at(-1)!) === friend ? "join" : "leave" });
    if (path.includes("/send/")) {
      const id = path.split("/").at(-1)!, content = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const prior = sent.get(id); if (prior) assert.deepEqual(content, prior.content);
      const result = prior ?? { event: `$sent-${sent.size}`, content }; sent.set(id, result); attempts.push(id);
      if (loseSend) { loseSend = false; throw Error("server accepted output but connection broke"); }
      return Response.json({ event_id: result.event });
    }
    throw Error(`Unexpected Matrix path ${path}`);
  }, { maxAttempts: 1 }), bot);
  return { root, file, config, matrix, sent, attempts, syncs, loseNextSend: () => { loseSend = true; } };
}
async function attach(f: ReturnType<typeof fixture>, handler: (method: string, params: Record<string, unknown>) => Promise<unknown>): Promise<{ peer: Peer; key: string }> {
  const peer = await connect(f.config.socket, handler);
  const result = object(await peer.request("register", { file: f.file, nativeId: "native", boundary: "boundary", title: "Test", idle: true }));
  return { peer, key: String(result.key) };
}
const message = (event_id: string, sender = friend, body = "hello") => ({ event_id, sender, type: "m.room.message", content: { msgtype: "m.text", body } });

test("private bridge intake deduplicates, enforces current membership and never replays a lost native handoff", { timeout: 15000 }, async () => {
  const f = fixture(); let relay = new BridgeRelay(f.config, f.matrix, async () => { throw Error("must not relaunch a live writer"); });
  let peer: Peer | undefined;
  const acted: string[] = [];
  try {
    await relay.start(false);
    const first = await attach(f, async (method, params) => {
      assert.equal(method, "input"); acted.push(String(params.id));
      peer!.close(); // Native effect happened, but the bridge cannot receive its acknowledgement.
      return { accepted: true };
    }); peer = first.peer;
    relay.store.setRoom(first.key, room); relay.store.intake("before", []);
    f.syncs.push({ next_batch: "one", rooms: { join: { [room]: { timeline: { events: [message("$first"), message("$first"), message("$bot", bot), message("$outsider", "@outsider:example.org")] } } } } });
    await relay.syncOnce(); await relay.pump();
    assert.deepEqual(acted, ["$first"]);
    assert.equal(relay.store.status(first.key).interrupted, 1);
    assert.equal(relay.store.status(first.key).ignored, 2);
    await relay.stop(); relay = new BridgeRelay(f.config, f.matrix, async () => {}); await relay.start(false);
    const replacement = await attach(f, async (_method, params) => { acted.push(String(params.id)); return { accepted: true }; }); peer = replacement.peer;
    relay.store.intake("two", [{ id: "$first", room, event: message("$first") }, { id: "$fresh", room, event: message("$fresh") }]);
    await relay.pump();
    assert.deepEqual(acted, ["$first", "$fresh"]);
    const notices = [...f.sent.values()].filter(output => String(output.content.body).includes("will not be replayed"));
    assert.equal(notices.length, 1);
    await relay.pump(); assert.equal([...f.sent.values()].filter(output => String(output.content.body).includes("will not be replayed")).length, 1);
    assert.ok(!JSON.stringify([...f.sent.values()]).includes("SECRET"));
  } finally { peer?.close(); await relay.stop(); rmSync(f.root, { recursive: true, force: true }); }
});

test("output recovery freezes payloads and transaction IDs; native private content and local-only turns never project", async () => {
  const f = fixture(); let relay = new BridgeRelay(f.config, f.matrix, async () => {});
  let peer: Peer | undefined;
  try {
    await relay.start(false);
    const registration = await attach(f, async () => ({})); peer = registration.peer;
    relay.store.setRoom(registration.key, room);
    const append = (entry: unknown) => appendFileSync(f.file, JSON.stringify(entry) + "\n");
    append({ type: "message", id: "answer", message: { role: "assistant", stopReason: "stop", content: [{ type: "thinking", thinking: "THINKING SECRET" }, { type: "text", text: "Published answer" }] } });
    append({ type: "message", id: "tool", message: { role: "toolResult", content: [{ type: "text", text: "TOOL SECRET" }] } });
    append({ type: "custom", id: "off", customType: "matrix-bridge.enrollment", data: { nativeId: "native", enabled: false } });
    append({ type: "message", id: "private", message: { role: "user", content: "LOCAL ONLY SECRET" } });
    append({ type: "custom", id: "on", customType: "matrix-bridge.enrollment", data: { nativeId: "native", enabled: true } });
    f.loseNextSend(); await relay.pump();
    assert.equal(f.attempts.length, 1);
    await relay.stop(); relay = new BridgeRelay(f.config, f.matrix, async () => {}); await relay.start(false);
    await relay.pump();
    assert.equal(f.attempts.length, 2); assert.equal(new Set(f.attempts).size, 1);
    assert.equal(f.sent.size, 1);
    assert.equal([...f.sent.values()][0]!.content.body, "Published answer");
    assert.ok(!JSON.stringify([...f.sent.values()]).includes("SECRET"));
    assert.equal(readFileSync(f.file, "utf8").includes("LOCAL ONLY SECRET"), true);
  } finally { peer?.close(); await relay.stop(); rmSync(f.root, { recursive: true, force: true }); }
});

test("already-bound input/output remain usable while independent setup HTTP is blocked", async t => {
  const f = fixture(); f.config.operatorUserId = friend;
  let unblock!: () => void, requested = false;
  const blocked = new Promise<unknown>((_resolve, reject) => { unblock = () => reject(Error("setup unavailable")); });
  const request = f.matrix.http.request.bind(f.matrix.http);
  t.mock.method(f.matrix.http, "request", (...args: Parameters<typeof request>) => {
    if (args[1].endsWith("/state")) { requested = true; return blocked; }
    return request(...args);
  });
  const relay = new BridgeRelay(f.config, f.matrix, async () => { throw Error("must not launch"); });
  let peer: Peer | undefined;
  try {
    await relay.start(false);
    const handed: string[] = [];
    const registration = await attach(f, async (_method, params) => { handed.push(String(params.id)); return { accepted: true }; }); peer = registration.peer;
    relay.store.setRoom(registration.key, room);
    appendFileSync(f.file, JSON.stringify({ type: "message", id: "answer", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Available while setup is pending" }] } }) + "\n");
    relay.store.intake("input", [{ id: "$during-setup", room, event: message("$during-setup") }]);
    const pending = relay.organization!.pump(); assert.equal(requested, true);
    await relay.pump();
    assert.deepEqual(handed, ["$during-setup"]); assert.equal(f.sent.size, 1);
    const view = object(await peer.request("status", { key: registration.key }));
    assert.equal(view.error, null); assert.equal(object(view.setup).stage, "room");
    unblock(); await pending;
    assert.match(String(object(object(await peer.request("status", { key: registration.key })).setup).error), /setup unavailable/);
  } finally { unblock(); peer?.close(); await relay.stop(); rmSync(f.root, { recursive: true, force: true }); }
});

test("a second daemon cannot replace the live private socket", async () => {
  const f = fixture(); const relay = new BridgeRelay(f.config, f.matrix, async () => {});
  try {
    await relay.start(false);
    assert.throws(() => new BridgeRelay(f.config, f.matrix, async () => {}), /already running/);
    const peer = await connect(f.config.socket, async () => ({}));
    assert.deepEqual(await peer.request("list", {}), []); peer.close();
  } finally { await relay.stop(); rmSync(f.root, { recursive: true, force: true }); }
});
