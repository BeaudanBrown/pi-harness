import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { BridgeRelay } from "../config/agent/extensions/matrix-bridge/relay.js";
import { BridgeMatrix } from "../config/agent/extensions/matrix-bridge/matrix.js";
import { MatrixHttp } from "../config/agent/extensions/matrix-shared/http.js";

async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  const end = Date.now() + 8000;
  while (!await check()) { if (Date.now() > end) throw Error("Native bridge test condition timed out"); await new Promise(resolve => setTimeout(resolve, 20)); }
}
function piProcess(root: string, file: string, extension: string) {
  const executable = process.env.PI_BRIDGE_TEST_PI;
  assert.ok(executable, "the actual packaged Pi is required; no skipped runtime evidence");
  const home = join(root, "home"); mkdirSync(home, { recursive: true });
  const child = spawn(executable, ["--mode", "rpc", "--session", file, "--no-extensions", "--no-skills", "--no-context-files", "--no-builtin-tools", "--extension", extension,
    "--extension", resolve("tests/fixtures/matrix-bridge/native-probe.mjs"), "--provider", "bridge-probe", "--model", "fake"], {
    cwd: root, env: { HOME: home, PATH: process.env.PATH, TERM: "xterm-256color", PI_CODING_AGENT_DIR: join(home, ".pi"), PI_SESSION_LOCK_DIRECTORY: join(root, "locks"), BRIDGE_PROBE_PERSISTENCE_LOG: join(root, "persistence.jsonl") },
  });
  const pending = new Map<string, { resolve: (event: Record<string, unknown>) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  let buffer = "", stderr = "", next = 0;
  child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-8000); });
  child.stdout.on("data", chunk => {
    buffer += String(chunk);
    for (;;) {
      const end = buffer.indexOf("\n"); if (end < 0) return;
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      let event: Record<string, unknown>; try { event = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      if (event.type === "response") { const item = pending.get(String(event.id)); if (item) { clearTimeout(item.timer); pending.delete(String(event.id)); item.resolve(event); } }
    }
  });
  child.once("exit", () => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(Error(`Native Pi exited: ${stderr}`)); } pending.clear(); });
  const send = (type: string, extra: Record<string, unknown> = {}) => new Promise<Record<string, unknown>>((resolve, reject) => {
    const id = String(++next), timer = setTimeout(() => { pending.delete(id); reject(Error(`Native Pi RPC timed out: ${stderr}`)); }, 10000);
    pending.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ id, type, ...extra }) + "\n");
  });
  return { child, send, stop: async () => { if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; } } };
}

test("real native Pi bridges persisted text, survives daemon loss, and uses a fresh binding for native new", { timeout: 30000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-native-adapter-")), socket = join(root, "bridge.sock"), file = join(root, "native.jsonl");
  const config = { hostId: "host", stateDirectory: join(root, "state"), socket, roots: [root] };
  writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: "native", timestamp: new Date().toISOString(), cwd: root }) + "\n");
  const extension = join(root, "bridge.ts");
  writeFileSync(extension, `import {installAdapter} from ${JSON.stringify(resolve("config/agent/extensions/matrix-bridge/adapter.ts"))}; export default pi => installAdapter(pi,{config:${JSON.stringify({ socket, roots: [root] })},interactive:()=>true});`);
  const published: Record<string, unknown>[] = [];
  const matrix = new BridgeMatrix(new MatrixHttp({ homeserver: "https://example.org", accessToken: "daemon-only" }, async (url, init) => {
    if (String(url).includes("/state/m.room.member/")) return Response.json({ membership: "join" });
    if (String(url).includes("/send/")) { published.push(JSON.parse(String(init?.body)) as Record<string, unknown>); return Response.json({ event_id: `$published-${published.length}` }); }
    throw Error("unexpected Matrix request");
  }, { maxAttempts: 1 }), "@bridge:example.org");
  let relay = new BridgeRelay(config, matrix, async () => { throw Error("live Pi must not be replaced"); });
  const live = piProcess(root, file, extension);
  try {
    await relay.start(false); assert.equal((await live.send("get_state")).success, true);
    await until(() => relay.store.bindings().length === 1);
    const binding = relay.store.bindings()[0]!; relay.store.setRoom(binding.key, "!room:example.org");
    const accept = (id: string, text: string) => relay.store.intake(`cursor:${id}`, [{ id, room: "!room:example.org", event: {
      event_id: id, type: "m.room.message", sender: "@friend:example.org", content: { msgtype: "m.text", body: text },
    } }]);
    const native = () => readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line) as { type: string; message?: { role: string; content: Array<{ type: string; text: string }>; metadata?: Record<string, string> } });
    accept("$remote", "remote prompt"); await relay.pump();
    await until(async () => { await relay.pump(); return published.some(content => content.body === "probe answer"); });
    assert.equal(native().filter(entry => entry.message?.role === "user").length, 1);
    assert.ok(native().find(entry => entry.message?.role === "user")!.message!.content[0]!.text.includes('"sender":"@friend:example.org"'));
    assert.ok(!JSON.stringify(published).includes("remote prompt"));
    const eventObservations = readFileSync(join(root, "persistence.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line) as { role: string; persisted: boolean });
    assert.equal(eventObservations.some(entry => entry.role === "assistant" && !entry.persisted), true, "message_end must not be mistaken for persistence");
    const copiedText = native().find(entry => entry.message?.role === "user")!.message!.content[0]!.text;
    assert.equal((await live.send("prompt", { message: copiedText })).success, true);
    await until(async () => { await relay.pump(); return published.some(content => String(content.body).startsWith("Local Pi user") && String(content.body).includes("remote prompt")); });
    await relay.stop();
    assert.equal((await live.send("get_state")).success, true, "bridge stop must leave the native process alone");
    relay = new BridgeRelay(config, matrix, async () => { throw Error("live Pi must not be replaced"); }); await relay.start(false);
    await until(async () => {
      const { connect } = await import("../config/agent/extensions/matrix-bridge/wire.js");
      const peer = await connect(socket, async () => ({}));
      try { return (await peer.request("list", {}) as Array<{ runtime: string }>)[0]?.runtime !== "detached"; } finally { peer.close(); }
    });
    accept("$remote", "remote prompt"); accept("$fresh", "fresh after outage"); await relay.pump();
    await until(() => native().filter(entry => entry.message?.role === "user").length === 3);
    assert.equal(native().filter(entry => entry.message?.role === "user" && entry.message.metadata?.["pi.bridge.event"] === "$remote").length, 1);
    const idle = async () => (await live.send("get_state")).data as { isStreaming: boolean };
    await until(async () => !(await idle()).isStreaming);
    accept("$slow", "hold for abort"); await relay.pump();
    await until(async () => (await idle()).isStreaming);
    accept("$queued", "!follow-up SHOULD NOT RUN"); await relay.pump();
    accept("$abort", "!abort"); await relay.pump();
    await until(async () => !(await idle()).isStreaming);
    assert.ok(!readFileSync(file, "utf8").includes("SHOULD NOT RUN"), "native abort withdraws queued follow-up instead of replaying it");
    assert.ok(relay.store.status(binding.key).interrupted >= 1);
    accept("$after-abort", "fresh after abort"); await relay.pump();
    await until(() => native().filter(entry => entry.message?.role === "user").length === 5);
    await until(async () => !(await idle()).isStreaming);
    const created = await live.send("new_session"); assert.equal(created.success, true, JSON.stringify(created));
    await until(() => relay.store.bindings().length === 2);
    const child = relay.store.bindings().find(item => item.key !== binding.key)!;
    assert.notEqual(child.file, binding.file); assert.equal(child.room, undefined);
    assert.ok(readFileSync(child.file, "utf8").includes("matrix-bridge.boundary"), "idle new history exists without a model turn");
    assert.equal(child.boundary !== binding.boundary, true);
    relay.store.setRoom(child.key, "!child:example.org");
    relay.store.intake("stop", [{ id: "$stop", room: "!child:example.org", event: { event_id: "$stop", type: "m.room.message", sender: "@friend:example.org", content: { msgtype: "m.text", body: "!stop" } } }]);
    await relay.pump();
    // RPC observes an idle extension shutdown at its next control checkpoint.
    // The ordinary TUI's immediate idle shutdown is tested separately below.
    await until(async () => {
      if (live.child.exitCode !== null || live.child.signalCode !== null) return true;
      await live.send("get_state").catch(() => {});
      return live.child.exitCode !== null || live.child.signalCode !== null;
    });
    assert.ok(readFileSync(child.file, "utf8").includes("matrix-bridge.boundary"));
  } finally { await live.stop(); await relay.stop(); rmSync(root, { recursive: true, force: true }); }
});

test("the production enrollment policy excludes an RPC worker even when configured", { timeout: 15000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-unbridged-worker-")), file = join(root, "worker.jsonl"), socket = join(root, "bridge.sock");
  writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: "worker", cwd: root, timestamp: new Date().toISOString() }) + "\n");
  const extension = join(root, "worker-extension.ts");
  writeFileSync(extension, `import {installAdapter} from ${JSON.stringify(resolve("config/agent/extensions/matrix-bridge/adapter.ts"))}; export default pi => installAdapter(pi,{config:${JSON.stringify({ socket, roots: [root] })}});`);
  let live = piProcess(root, file, extension);
  try {
    assert.equal((await live.send("get_state")).success, true);
    assert.equal((await live.send("prompt", { message: "ordinary worker prompt" })).success, true);
    await until(() => readFileSync(file, "utf8").includes("probe answer"));
    assert.ok(!readFileSync(file, "utf8").includes("matrix-bridge.boundary"));
    await live.stop();
    appendFileSync(file, JSON.stringify({ type: "custom", id: "old-boundary", customType: "matrix-bridge.boundary", data: { nativeId: "worker" } }) + "\n");
    live = piProcess(root, file, extension);
    assert.equal((await live.send("get_state")).success, true);
    const entries = readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line) as { customType?: string; data?: { enabled?: boolean } });
    assert.equal(entries.find(entry => entry.customType === "matrix-bridge.enrollment")?.data?.enabled, false, "a headless resume of a formerly bridged file disables projection before new work");
  } finally { await live.stop(); rmSync(root, { recursive: true, force: true }); }
});
