import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { BridgeRelay } from "../config/agent/extensions/matrix-bridge/relay.js";
import { connect } from "../config/agent/extensions/matrix-bridge/wire.js";
import { POLL_START, POLL_RESPONSE } from "../config/agent/extensions/matrix-bridge/interaction.js";
import { InteractionHttp, ROOM, USER, textEvent } from "./fixtures/matrix-bridge/interaction-http.js";
import { piProcess, until } from "./bridge-pi-fixture.js";

async function fixture(empty = false) {
  const root = mkdtempSync(join(tmpdir(), "bridge-upstream-")), socket = join(root, "bridge.sock"), file = join(root, "native.jsonl"), extension = join(root, "bridge.ts");
  if (!empty) writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: "native", timestamp: new Date().toISOString(), cwd: root }) + "\n");
  writeFileSync(extension, `import {installAdapter} from ${JSON.stringify(resolve("config/agent/extensions/matrix-bridge/adapter.ts"))};
    process.env.BRIDGE_PROBE_HOLD_RELEASE=${JSON.stringify(join(root, "release-model"))};
    export default pi => { installAdapter(pi,{config:${JSON.stringify({ socket, roots: [root] })},interactive:()=>true});
      pi.registerCommand("native-command",{handler:async args=>pi.appendEntry("probe.command",{args})});
    };`);
  const http = new InteractionHttp();
  const relay = new BridgeRelay({ hostId: "host", stateDirectory: join(root, "state"), socket, roots: [root] }, http.matrix);
  await relay.start(false); relay.store.intake("ready", []);
  mkdirSync(join(root, "home", ".pi"), { recursive: true });
  writeFileSync(join(root, "home", ".pi", "settings.json"), JSON.stringify({ compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 128 } }));
  const live = piProcess(root, file, extension);
  const state = async () => (await live.send("get_state")).data as { isStreaming: boolean; model?: { id: string }; thinkingLevel?: string; pendingMessageCount: number; sessionFile?: string };
  await live.send("get_state");
  const entries = (path = file): any[] => existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
  const remote = (id: string) => entries().find(entry => entry.type === "custom_message" && entry.customType === "matrix-bridge.input" && entry.details.events.some((event: any) => event.id === id));
  const text = (id: string, body: string) => relay.store.intake(id, [{ id, room: ROOM, event: textEvent(id, body) }]);
  const idle = () => until(async () => !(await state()).isStreaming);
  const delivered = (id: string) => until(async () => { await relay.pump(); return Boolean(remote(id)); });
  if (!empty) { await until(() => relay.store.bindings().length === 1); relay.store.setRoom(relay.store.bindings()[0]!.key, ROOM); await relay.syncOnce(); }
  return { root, socket, file, http, relay, live, state, entries, remote, text, idle, delivered,
    cleanup: async () => { await live.stop(); await relay.stop(); rmSync(root, { recursive: true, force: true }); } };
}

test("upstream custom messages preserve literal text, provenance, images, polls and best-effort controls", { timeout: 60000 }, async () => {
  const f = await fixture();
  try {
    f.text("$literal", "/native-command /skill:research /some-template"); await f.delivered("$literal"); await f.idle();
    assert.ok(!f.entries().some(entry => entry.customType === "probe.command"));
    assert.match(JSON.stringify(f.remote("$literal").content), /\/native-command/);
    assert.equal(f.remote("$literal").details.events[0].sender, USER);
    await f.relay.pump();
    assert.ok(!JSON.stringify([...f.http.sent.values()]).includes("/native-command"), "remote chat is not echoed");
    assert.ok(!JSON.stringify([...f.http.sent.values()]).includes("Private pre-enrollment fixture"));
    await f.live.send("prompt", { message: "local user text" }); await f.idle(); await f.relay.pump();
    assert.ok([...f.http.sent.values()].some(event => String(event.content.body).includes("Local Pi user")));
    f.text("$model", "!model bridge-probe/fake-text");
    await until(async () => { await f.relay.pump(); return (await f.state()).model?.id === "fake-text"; });
    f.text("$thinking", "!thinking high");
    await until(async () => { await f.relay.pump(); return (await f.state()).thinkingLevel === "high"; });
    f.text("$image-model", "!model bridge-probe/fake");
    await until(async () => { await f.relay.pump(); return (await f.state()).model?.id === "fake"; });
    for (const format of ["jpg", "png", "webp"]) {
      const bytes = readFileSync(resolve(`tests/fixtures/matrix-bridge/input.${format}`)); f.http.media = bytes;
      const id = `$image-${format}`;
      f.relay.store.intake(id, [{ id, room: ROOM, event: { event_id: id, type: "m.room.message", sender: USER, content: { msgtype: "m.image", body: "literal caption", filename: "photo", url: "mxc://example.test/image" } } }]);
      await f.delivered(id); await f.idle();
      const image = f.remote(id).content.find((part: any) => part.type === "image");
      assert.deepEqual(Buffer.from(image.data, "base64"), bytes);
    }
    f.text("$compact", "!compact retain the explicit task");
    await until(async () => { await f.relay.pump(); return [...f.http.sent.values()].some(event => String(event.content.body).includes("Native compaction completed")); });
    assert.ok(f.entries().some(entry => entry.type === "compaction"));
    f.text("$question", "ask choice"); await f.delivered("$question");
    await until(async () => { await f.relay.pump(); return [...f.http.sent.values()].some(event => event.type === POLL_START); }); await f.idle();
    const poll = [...f.http.sent.values()].find(event => event.type === POLL_START)!;
    f.text("$later", "conversation moved on"); await f.delivered("$later"); await f.idle();
    const vote = (id: string) => f.relay.store.intake(id, [{ id, room: ROOM, event: { event_id: id, type: POLL_RESPONSE, sender: USER, content: { "m.relates_to": { rel_type: "m.reference", event_id: poll.event_id }, [POLL_RESPONSE]: { answers: ["answer-1"] } } } }]);
    vote("$answer"); vote("$duplicate"); await f.delivered("$answer"); await f.idle(); await f.relay.pump();
    assert.match(JSON.stringify(f.remote("$answer").content), /Choose one/);
    assert.equal(f.remote("$duplicate"), undefined);
    f.text("$removed-control", "!start"); await f.relay.pump();
    assert.ok([...f.http.sent.values()].some(event => String(event.content.body).includes("Unknown native control")));
    assert.equal((await f.live.send("get_state")).success, true);
  } finally { await f.cleanup(); }
});

test("remote chat batches only at idle; local steering remains native; abort/disconnect never replay", { timeout: 40000 }, async () => {
  const f = await fixture();
  try {
    await f.live.send("prompt", { message: "hold for abort" }); await until(async () => (await f.state()).isStreaming);
    f.text("$one", "first queued instruction"); f.text("$two", "clarification"); await f.relay.pump();
    assert.equal((await f.state()).pendingMessageCount, 0, "remote messages never enter native queues");
    assert.equal(f.remote("$one"), undefined);
    // Archive is presentation only: it cannot revoke this waiting batch.
    const binding = f.relay.store.bindings()[0]!; f.relay.archive(binding.key, true, 0);
    await f.live.send("steer", { message: "local steering retained" });
    assert.equal((await f.state()).pendingMessageCount, 1);
    writeFileSync(join(f.root, "release-model"), "");
    await until(async () => !(await f.state()).isStreaming);
    await f.delivered("$one"); await f.idle();
    assert.equal(f.remote("$one").id, f.remote("$two").id);
    assert.deepEqual(f.remote("$one").details.events.map((event: any) => event.id), ["$one", "$two"]);
    assert.match(readFileSync(f.file, "utf8"), /local steering retained/);
    rmSync(join(f.root, "release-model"));
    await f.live.send("prompt", { message: "hold for abort" }); await until(async () => (await f.state()).isStreaming);
    f.text("$held", "must not replay"); await f.relay.pump();
    f.text("$abort", "!abort"); await f.relay.pump(); await f.idle(); await f.relay.pump();
    assert.equal(f.remote("$held"), undefined);
    assert.ok(f.relay.store.status(binding.key).interrupted >= 1);
    f.text("$fresh", "fresh after abort"); await f.delivered("$fresh"); await f.idle();
    await f.live.stop(); await until(async () => {
      const peer = await connect(f.socket, async () => ({}));
      try { return (await peer.request("list", {}) as any[])[0]?.runtime === "detached"; } finally { peer.close(); }
    });
    f.text("$offline", "offline instruction"); await f.relay.pump();
    assert.equal(f.relay.store.status(binding.key).queued, 0);
    assert.ok([...f.http.sent.values()].some(event => String(event.content.body).includes("Pi is offline")));
  } finally { await f.cleanup(); }
});

test("new empty sessions enroll only after upstream persistence; duplicate routing cannot displace the first adapter", { timeout: 30000 }, async () => {
  const f = await fixture(true);
  try {
    assert.equal(f.relay.store.bindings().length, 0); assert.equal(existsSync(f.file), false);
    await f.live.send("prompt", { message: "first local conversation" }); await f.idle();
    await until(() => f.relay.store.bindings().length === 1);
    const binding = f.relay.store.bindings()[0]!;
    const second = await connect(f.socket, async () => ({}));
    try { await assert.rejects(second.request("register", { protocol: 2, file: binding.file, nativeId: binding.nativeId, boundary: f.entries().find(entry => entry.customType === "matrix-bridge.boundary").id, title: "Duplicate", idle: true }), /already connected/); } finally { second.close(); }
    const old = await connect(f.socket, async () => ({}));
    try { await assert.rejects(old.request("register", {}), /upgrade required/); } finally { old.close(); }
    assert.equal((await f.live.send("new_session")).success, true);
    assert.equal(f.relay.store.bindings().length, 1);
    await f.live.send("prompt", { message: "new local conversation" }); await f.idle();
    await until(() => f.relay.store.bindings().length === 2);
    assert.notEqual(f.relay.store.bindings()[0]!.nativeId, f.relay.store.bindings()[1]!.nativeId);
  } finally { await f.cleanup(); }
});
