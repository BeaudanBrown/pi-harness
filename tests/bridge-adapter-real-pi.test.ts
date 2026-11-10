import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { appendFileSync, chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { BridgeStore } from "../config/agent/extensions/matrix-bridge/store.js";
import { BridgeRelay } from "../config/agent/extensions/matrix-bridge/relay.js";
import { BridgeMatrix } from "../config/agent/extensions/matrix-bridge/matrix.js";
import { MatrixHttp } from "../config/agent/extensions/matrix-shared/http.js";
import { InteractionHttp, ROOM, USER, textEvent } from "./fixtures/matrix-bridge/interaction-http.js";
import { POLL_START, POLL_RESPONSE } from "../config/agent/extensions/matrix-bridge/interaction.js";
import { connect, object, Peer, remoteText } from "../config/agent/extensions/matrix-bridge/wire.js";
import { imageInfo } from "../config/agent/extensions/matrix-bridge/media.js";
import { localTasks } from "../config/agent/extensions/matrix-bridge/local-process.js";

async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  const end = Date.now() + 8000;
  while (!await check()) { if (Date.now() > end) throw Error("Native bridge test condition timed out"); await new Promise(resolve => setTimeout(resolve, 20)); }
}
function piProcess(root: string, file: string, extension: string, extra: string[] = [], directories: { cwd?: string; home?: string; log?: string } = {}) {
  const executable = process.env.PI_BRIDGE_TEST_PI;
  assert.ok(executable, "the actual packaged Pi is required; no skipped runtime evidence");
  const home = directories.home ?? join(root, "home"), log = directories.log ?? root; mkdirSync(home, { recursive: true }); mkdirSync(log, { recursive: true });
  const child = spawn(executable, ["--mode", "rpc", "--session", file, "--no-extensions", "--no-skills", "--no-context-files", "--no-builtin-tools", "--extension", extension,
    "--extension", resolve("tests/fixtures/matrix-bridge/native-probe.mjs"), "--provider", "bridge-probe", "--model", "fake", ...extra], {
    cwd: directories.cwd ?? root, env: { HOME: home, PATH: process.env.PATH, TERM: "xterm-256color", PI_CODING_AGENT_DIR: join(home, ".pi"), PI_SESSION_LOCK_DIRECTORY: join(root, "locks"), BRIDGE_PROBE_PERSISTENCE_LOG: join(log, "persistence.jsonl"), BRIDGE_PROBE_MODEL_LOG: join(log, "modelcalls.jsonl") },
  });
  const pending = new Map<string, { resolve: (event: Record<string, unknown>) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  let buffer = "", stderr = "", next = 0;
  const ui: Record<string, unknown>[] = [], queues: Record<string, unknown>[] = [];
  child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-8000); });
  child.stdout.on("data", chunk => {
    buffer += String(chunk);
    for (;;) {
      const end = buffer.indexOf("\n"); if (end < 0) return;
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      let event: Record<string, unknown>; try { event = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      if (event.type === "extension_ui_request" && event.method === "confirm") ui.push(event);
      if (event.type === "queue_update") queues.push(event);
      if (event.type === "response") { const item = pending.get(String(event.id)); if (item) { clearTimeout(item.timer); pending.delete(String(event.id)); item.resolve(event); } }
    }
  });
  const failPending = (error: Error) => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); } pending.clear(); };
  child.once("exit", () => failPending(Error(`Native Pi exited: ${stderr}`)));
  child.once("error", failPending);
  // Idle RPC shutdown may close stdin before the exit event is observed. The
  // next checkpoint rejects normally; an unhandled EPIPE is not test evidence.
  child.stdin.on("error", failPending);
  const send = (type: string, extra: Record<string, unknown> = {}) => new Promise<Record<string, unknown>>((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) { reject(Error(`Native Pi already exited: ${stderr}`)); return; }
    const id = String(++next), timer = setTimeout(() => { pending.delete(id); reject(Error(`Native Pi RPC timed out: ${stderr}`)); }, 10000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ id, type, ...extra }) + "\n", error => { if (error) failPending(error); });
  });
  return { child, send, ui, queues, confirm: (id: unknown, confirmed: boolean) => child.stdin.write(JSON.stringify({ type: "extension_ui_response", id, confirmed }) + "\n"), stop: async () => { if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; } } };
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
    accept("$busy-model", "!model bridge-probe/fake-text"); await relay.pump(); await relay.pump();
    assert.equal(((await live.send("get_state")).data as { model: { id: string } }).model.id, "fake");
    assert.ok(published.some(content => String(content.body).includes("while Pi is busy")));
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

test("real Pi retains question polls, native preferences/compaction, original images and native expansion", { timeout: 60000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-native-rich-")), socket = join(root, "bridge.sock"), file = join(root, "native.jsonl"), extension = join(root, "bridge.ts");
  const config = { hostId: "host", stateDirectory: join(root, "state"), socket, roots: [root] }, http = new InteractionHttp();
  writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: "rich", cwd: root, timestamp: new Date().toISOString() }) + "\n");
  writeFileSync(extension, `import {installAdapter} from ${JSON.stringify(resolve("config/agent/extensions/matrix-bridge/adapter.ts"))}; export default pi => { installAdapter(pi,{config:${JSON.stringify({ socket, roots: [root] })},interactive:()=>true}); pi.registerCommand("native-command",{handler:async args=>pi.appendEntry("probe.command",{args})}); pi.registerCommand("probe-tree",{handler:async(args,ctx)=>{await ctx.navigateTree(args,{summarize:false}); pi.appendEntry("probe.tree",{target:args});}});
    pi.registerCommand("probe-model-guard",{handler:async(_,ctx)=>{let valid=true,blocked=false;const pending=pi.setModel(ctx.modelRegistry.getAvailable().find(m=>m.id==="fake"),{preflight:()=>valid});valid=false;try{await pending;}catch{blocked=true;}pi.appendEntry("probe.model-guard",{blocked});}});
    let compactValid=true;
    pi.on("session_before_compact",e=>{if(e.customInstructions!=="scope-race")return;compactValid=false;pi.appendEntry("probe.compact-hook",{called:true});return {compaction:{summary:"SHOULD_NOT_PERSIST",firstKeptEntryId:e.preparation.firstKeptEntryId,tokensBefore:e.preparation.tokensBefore}};});
    pi.registerCommand("probe-compact-guard",{handler:async(_,ctx)=>ctx.compact({customInstructions:"scope-race",preflight:()=>compactValid,onComplete:()=>pi.appendEntry("probe.compact-guard",{blocked:false}),onError:()=>pi.appendEntry("probe.compact-guard",{blocked:true})})}); };`);
  const template = join(root, "probe-template.md"), skill = join(root, "skill", "SKILL.md"); mkdirSync(join(root, "skill"));
  writeFileSync(template, "---\ndescription: fixture template\n---\nTEMPLATE_EXPANDED $1\n");
  writeFileSync(skill, "---\nname: bridge-probe\ndescription: fixture skill\n---\nSKILL_EXPANDED\n");
  mkdirSync(join(root, "home", ".pi"), { recursive: true });
  writeFileSync(join(root, "home", ".pi", "settings.json"), JSON.stringify({ compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 128 } }));
  const relay = new BridgeRelay(config, http.matrix, async () => { throw Error("must not replace live native Pi"); });
  await relay.start(false); relay.store.intake("live", []);
  const live = piProcess(root, file, extension, ["--prompt-template", template, "--skill", skill]);
  type Entry = { id: string; type: string; customType?: string; data?: Record<string, unknown>; message?: { role: string; content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; metadata?: Record<string, string> } };
  const entries = (): Entry[] => readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line) as Entry);
  const users = () => entries().filter(entry => entry.message?.role === "user");
  const state = async () => (await live.send("get_state")).data as { isStreaming: boolean; model?: { id: string }; thinkingLevel?: string };
  let cursor = 0;
  const input = (event: Record<string, unknown>) => relay.store.intake(`rich-${++cursor}`, [{ id: String(event.event_id), room: ROOM, event }]);
  const text = async (id: string, body: string) => { input(textEvent(id, body)); await relay.pump(); };
  const user = (id: string) => users().find(entry => entry.message?.metadata?.["pi.bridge.event"] === id);
  const idle = async () => until(async () => !(await state()).isStreaming);
  try {
    assert.equal((await live.send("get_state")).success, true); await until(() => relay.store.bindings().length === 1);
    const binding = relay.store.bindings()[0]!; relay.store.setRoom(binding.key, ROOM);
    await text("$command", "/native-command original-args"); await until(() => entries().some(entry => entry.customType === "probe.command"));
    assert.equal(entries().find(entry => entry.customType === "probe.command")!.data!.args, "original-args"); assert.equal(users().length, 0);
    await text("$template", "/probe-template raw"); await until(() => Boolean(user("$template"))); await idle();
    assert.ok(user("$template")!.message!.content[0]!.text!.includes("TEMPLATE_EXPANDED raw"));
    await text("$skill", "/skill:bridge-probe argument"); await until(() => Boolean(user("$skill"))); await idle();
    assert.ok(user("$skill")!.message!.content[0]!.text!.includes("SKILL_EXPANDED"));
    assert.ok(user("$skill")!.message!.content[0]!.text!.includes("argument"));
    await text("$models", "!model");
    await until(async () => { await relay.pump(); return [...http.sent.values()].some(event => event.type === POLL_START); });
    const menu = [...http.sent.values()].find(event => event.type === POLL_START)!;
    input({ event_id: "$model-vote", type: POLL_RESPONSE, sender: USER, content: { "m.relates_to": { rel_type: "m.reference", event_id: menu.event_id }, [POLL_RESPONSE]: { answers: ["answer-1"] } } });
    await relay.pump(); await until(async () => (await state()).model?.id === "fake-text");
    http.media = readFileSync(resolve("tests/fixtures/matrix-bridge/input.png"));
    input({ event_id: "$unsupported-model", type: "m.room.message", sender: USER, content: { msgtype: "m.image", body: "keep this caption", filename: "photo", url: "mxc://example.test/image" } });
    await relay.pump(); assert.equal(users().length, 2); assert.equal((await state()).model?.id, "fake-text");
    assert.ok([...http.sent.values()].some(event => String(event.content.body).includes("does not support images")));
    await text("$thinking", "!thinking high"); await until(async () => (await state()).thinkingLevel === "high");
    await text("$compact", "!compact keep the explicit task");
    await until(() => entries().some(entry => entry.customType === "matrix-bridge.control" && entry.data?.input === "$compact" && /compaction (completed|failed)/.test(String((entry.data.result as { message?: string })?.message))));
    assert.ok(entries().some(entry => entry.customType === "matrix-bridge.control" && entry.data?.input === "$compact" && String((entry.data.result as { message?: string })?.message).includes("compaction completed")), "actual native compaction must complete, not merely acknowledge the request");
    assert.ok(entries().some(entry => entry.type === "compaction"));
    assert.equal((await live.send("prompt", { message: "/probe-model-guard" })).success, true);
    assert.equal(entries().find(entry => entry.customType === "probe.model-guard")?.data?.blocked, true, "scope must be rechecked after native authentication, not just after applying the model");
    assert.equal((await state()).model?.id, "fake-text");
    await text("$after-compact", "next native turn"); await until(() => Boolean(user("$after-compact"))); await idle();
    assert.equal((await live.send("prompt", { message: "/probe-compact-guard" })).success, true);
    await until(() => entries().some(entry => entry.customType === "probe.compact-guard"));
    assert.equal(entries().find(entry => entry.customType === "probe.compact-guard")!.data!.blocked, true);
    assert.ok(entries().some(entry => entry.customType === "probe.compact-hook")); assert.ok(!readFileSync(file, "utf8").includes("SHOULD_NOT_PERSIST"));
    await text("$image-model", "!model bridge-probe/fake"); await until(async () => (await state()).model?.id === "fake");
    for (const format of ["jpg", "png", "webp"]) {
      const bytes = readFileSync(resolve(`tests/fixtures/matrix-bridge/input.${format}`)); http.media = bytes;
      const id = `$image-${format}`, caption = format === "png" ? "/native-command MUST_STAY_CAPTION" : format === "webp" ? "caption without filename" : "photo";
      input({ event_id: id, type: "m.room.message", sender: USER, content: { msgtype: "m.image", body: caption, ...(format === "webp" ? {} : { filename: "photo" }), url: "mxc://other.example/image" } });
      await relay.pump(); await until(() => Boolean(user(id))); await idle();
      const image = user(id)!.message!.content.find(part => part.type === "image")!;
      assert.deepEqual(Buffer.from(image.data!, "base64"), bytes);
      assert.ok(user(id)!.message!.content[0]!.text!.includes(format === "png" ? "MUST_STAY_CAPTION" : format === "webp" ? "caption without filename" : "Please analyze the attached image."));
    }
    assert.equal(entries().filter(entry => entry.customType === "probe.command").length, 1, "image captions are literal, not extension commands");
    await text("$question", "ask choice");
    await until(() => entries().some(entry => entry.customType === "matrix-bridge.question")); await idle();
    await relay.pump(); const question = [...http.sent.values()].filter(event => event.type === POLL_START).at(-1)!;
    input(question); const before = users().length;
    input({ event_id: "$answer", type: POLL_RESPONSE, sender: USER, content: { "m.relates_to": { rel_type: "m.reference", event_id: question.event_id }, [POLL_RESPONSE]: { answers: ["answer-0"] } } });
    input(textEvent("$losing-fallback", "Second")); await relay.pump(); await until(() => Boolean(user("$answer"))); await idle();
    await relay.pump(); assert.equal(users().length, before + 1); assert.equal(user("$losing-fallback"), undefined);
    assert.ok(entries().some(entry => entry.customType === "matrix-bridge.answer"));
    await text("$question-before-tree", "ask choice");
    await until(() => entries().filter(entry => entry.customType === "matrix-bridge.question").length === 2); await idle(); await relay.pump();
    const obsolete = [...http.sent.values()].filter(event => event.type === POLL_START).at(-1)!, beforeTreeVote = users().length;
    const navigation = await live.send("prompt", { message: `/probe-tree ${user("$template")!.id}` }); assert.equal(navigation.success, true);
    await until(() => entries().some(entry => entry.customType === "probe.tree"));
    input({ event_id: "$obsolete-branch", type: POLL_RESPONSE, sender: USER, content: { "m.relates_to": { rel_type: "m.reference", event_id: obsolete.event_id }, [POLL_RESPONSE]: { answers: ["answer-0"] } } });
    await relay.pump(); assert.equal(users().length, beforeTreeVote); assert.equal(user("$obsolete-branch"), undefined);
    assert.ok([...http.sent.values()].some(event => String(event.content.body).includes("obsolete")));
    assert.ok(!JSON.stringify([...http.sent.values()]).includes(root), "native expansion paths must not be echoed to Matrix");
    assert.ok(!JSON.stringify([...http.sent.values()]).includes("daemon-only-token"));
  } finally { await live.stop(); await relay.stop(); rmSync(root, { recursive: true, force: true }); }
});

test("native abort withdraws in-flight images and asynchronous controls before late completion", { timeout: 15000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-native-transfer-")), file = join(root, "native.jsonl"), socket = join(root, "bridge.sock"), extension = join(root, "bridge.ts");
  writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: "transfer", cwd: root, timestamp: new Date().toISOString() }) + "\n");
  const modelWaiting = join(root, "model-waiting"), modelRelease = join(root, "model-release");
  writeFileSync(extension, `import {existsSync,writeFileSync} from "node:fs"; import {installAdapter} from ${JSON.stringify(resolve("config/agent/extensions/matrix-bridge/adapter.ts"))}; export default pi => installAdapter({...pi,setModel:async(model,options)=>{writeFileSync(${JSON.stringify(modelWaiting)},"");while(!existsSync(${JSON.stringify(modelRelease)}))await new Promise(resolve=>setTimeout(resolve,10));return pi.setModel(model,options);}},{config:${JSON.stringify({ socket, roots: [root] })},interactive:()=>true});`);
  const bytes = readFileSync(resolve("tests/fixtures/matrix-bridge/input.png")), info = imageInfo(bytes);
  const dispatchLedger = join(root, "ledger/bridge.sqlite"), ledger = new BridgeStore(dispatchLedger, "host");
  const binding = ledger.register({ file, nativeId: "transfer", cwd: root, title: "Transfer", boundary: null });
  let peer: Peer | undefined, release!: () => void, observed!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), reading = new Promise<void>(resolve => { observed = resolve; });
  const server = createServer(connection => {
    peer = new Peer(connection, async (method, params) => {
      if (method === "input.read") return { text: JSON.stringify(params.id === "$image" ? { text: "caption", sender: USER, image: info } : ["$model", "$fresh-model"].includes(String(params.id)) ? { text: "!model bridge-probe/fake-text", sender: USER, control: "model", argument: "bridge-probe/fake-text" } : { text: "!abort", sender: USER, control: "abort" }), done: true };
      if (method === "image.read") { observed(); await gate; return { data: bytes.toString("base64"), sha256: info.sha256, offset: 0, done: true }; }
      return { room: ROOM, intakeReady: true, key: binding.key, dispatchLedger };
    });
  });
  await new Promise<void>(resolve => server.listen(socket, () => { chmodSync(socket, 0o600); resolve(); }));
  const live = piProcess(root, file, extension);
  try {
    assert.equal((await live.send("get_state")).success, true); await until(() => Boolean(peer));
    const image = peer!.request("input", { id: "$image" });
    const rejected = assert.rejects(image, /changed|withdrawn|integrity/);
    await reading; assert.equal((await peer!.request("input", { id: "$abort" }) as { accepted: boolean }).accepted, true);
    release(); await rejected;
    assert.ok(!readFileSync(file, "utf8").includes('"role":"user"'), "late image data must not start a model turn after abort");
    assert.equal(((await live.send("get_state")).data as { isStreaming: boolean }).isStreaming, false);
    const control = peer!.request("input", { id: "$model" }), withdrawn = assert.rejects(control, /withdrawn|changed/);
    await until(() => { try { readFileSync(modelWaiting); return true; } catch { return false; } });
    assert.equal((await peer!.request("input", { id: "$abort-model" }) as { accepted: boolean }).accepted, true);
    writeFileSync(modelRelease, ""); await withdrawn;
    assert.equal(((await live.send("get_state")).data as { model: { id: string } }).model.id, "fake");
    assert.ok(!readFileSync(file, "utf8").includes('"input":"$model"'), "an aborted control must not publish late success");
    assert.equal((await peer!.request("input", { id: "$fresh-model" }) as { accepted: boolean }).accepted, true);
    assert.equal(((await live.send("get_state")).data as { model: { id: string } }).model.id, "fake-text", "fresh controls must not remain locked behind a withdrawn callback");
  } finally { writeFileSync(modelRelease, ""); release(); peer?.close(); await live.stop(); await new Promise<void>(resolve => server.close(() => resolve())); ledger.close(); rmSync(root, { recursive: true, force: true }); }
});

test("real Pi task tool requires a fresh native UI or operator poll and opens its child idle until new human input", { timeout: 60000 }, async () => {
  for (const name of ["PI_TASK_TEST_HELPER", "PI_TASK_TEST_GIT", "PI_TEST_TMUX"]) assert.ok(process.env[name], `${name} is mandatory native task evidence`);
  const root = mkdtempSync(join(tmpdir(), "bridge-native-task-")), cwd = join(root, "project"), file = join(root, "source.jsonl"), socket = join(root, "bridge.sock"), history = join(root, "task-history");
  const helperHome = join(root, "helper-home"), parentLog = join(root, "parent-log"), childLog = join(root, "child-log"); mkdirSync(cwd); mkdirSync(helperHome);
  const git = (args: string[]) => execFileSync(process.env.PI_TASK_TEST_GIT!, ["-C", cwd, ...args], { encoding: "utf8", env: { ...process.env, HOME: helperHome, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }, stdio: ["ignore", "pipe", "pipe"] }).trim();
  git(["init", "-q"]); git(["config", "user.name", "Native fixture"]); git(["config", "user.email", "native@example.invalid"]); git(["config", "commit.gpgsign", "false"]);
  writeFileSync(join(cwd, "tracked"), "committed\n"); git(["add", "tracked"]); git(["commit", "-qm", "base"]);
  writeFileSync(file, [ { type: "session", version: 3, id: "task-source", cwd, timestamp: new Date().toISOString() }, { type: "custom", id: "private", parentId: null, customType: "private", data: "SOURCE_SECRET_AND_PENDING_APPROVAL" } ].map(value => JSON.stringify(value) + "\n").join(""));
  const extension = join(root, "bridge.ts"), wrapper = join(root, "task-wrapper.mjs");
  writeFileSync(extension, `import {installAdapter} from ${JSON.stringify(resolve("config/agent/extensions/matrix-bridge/adapter.ts"))}; export default pi => installAdapter(pi,{config:${JSON.stringify({ socket, roots: [root] })},interactive:()=>true});`);
  writeFileSync(wrapper, `#!${process.execPath}\nimport {spawn} from 'node:child_process'; const child=spawn(${JSON.stringify(process.env.PI_TASK_TEST_HELPER)},process.argv.slice(2),{stdio:'inherit',env:{...process.env,HOME:${JSON.stringify(helperHome)},XDG_CONFIG_HOME:${JSON.stringify(join(root, "helper-config"))},XDG_CACHE_HOME:${JSON.stringify(join(root, "helper-cache"))},PI_TASK_SESSION_DIRECTORY:${JSON.stringify(history)},GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'}});child.on('error',()=>process.exit(1));child.on('close',code=>process.exit(code??1));\n`, { mode: 0o700 });
  const http = new InteractionHttp(); let opens = 0;
  const relay = new BridgeRelay({ hostId: "host", stateDirectory: join(root, "state"), socket, roots: [root], operatorUserId: USER }, http.matrix, async () => { opens++; throw Error("creation must not launch Pi"); }, localTasks(wrapper));
  await relay.start(false); relay.store.intake("ready", []);
  const live = piProcess(root, file, extension, [], { cwd, home: join(root, "parent-home"), log: parentLog }); let child: ReturnType<typeof piProcess> | undefined;
  const idle = async (process = live) => until(async () => !((await process.send("get_state")).data as { isStreaming: boolean }).isStreaming);
  try {
    assert.equal((await live.send("get_state")).success, true); await until(() => relay.store.bindings().length === 1);
    const source = relay.store.bindings()[0]!; relay.store.setRoom(source.key, ROOM); const originalStatus = git(["status", "--porcelain"]);
    const prompt = live.send("prompt", { message: "create task fixture" });
    await until(() => live.ui.length === 1); assert.match(String(live.ui[0]!.message), /Base: HEAD/);
    const draft = relay.store.tasks(["approval"])[0]!; assert.equal(existsSync(draft.plan.container), false); assert.equal(relay.store.bindings().length, 1);
    await live.send("abort"); live.confirm(live.ui[0]!.id, true); await prompt; await idle();
    assert.equal(relay.store.task(draft.plan.key)!.approval, undefined); assert.equal(existsSync(draft.plan.container), false);
    const again = live.send("prompt", { message: "create task fixture" }); await until(() => live.ui.length === 2);
    const fresh = relay.store.task(draft.plan.key)!; assert.notEqual(fresh.request.id, draft.request.id, "reused model tool-call IDs must not reuse a cancelled native UI request");
    live.confirm(live.ui[0]!.id, true); assert.equal(existsSync(fresh.plan.container), false);
    live.confirm(live.ui[1]!.id, true); await again;
    await until(() => relay.store.task(draft.plan.key)?.phase === "ready"); await idle();
    const ready = relay.tasks!.status(relay.store.binding(source.key)!, draft.plan.key); assert.equal(ready.localReady, true); assert.equal(ready.remotePending, true); assert.equal(opens, 0);
    assert.equal(git(["status", "--porcelain"]), originalStatus); assert.equal(((await live.send("get_state")).data as { sessionId: string }).sessionId, "task-source");
    assert.doesNotMatch(readFileSync(ready.file!, "utf8"), /SOURCE_SECRET_AND_PENDING_APPROVAL/);
    const rows = JSON.parse(execFileSync(join(dirname(process.env.PI_TASK_TEST_HELPER!), "pi-session"), ["list"], { encoding: "utf8", env: { HOME: helperHome, PATH: process.env.PATH, PI_BRIDGE_SESSION_ROOTS: JSON.stringify([history]), PI_BRIDGE_STATE_DIRECTORY: join(root, "absent-ledger"), PI_BRIDGE_TMUX: process.env.PI_TEST_TMUX!, PI_BRIDGE_TMUX_SOCKET: join(root, "disposable-tmux.sock"), PI_SESSION_LOCK_DIRECTORY: join(root, "locks") } })) as Array<{ file: string; id: string }>;
    assert.ok(rows.some(row => row.file === ready.file && row.id === draft.plan.nativeId), "offline native picker discovery needs neither the bridge database nor a running child");
    child = piProcess(root, ready.file!, extension, [], { cwd: ready.cwd!, home: join(root, "child-home"), log: childLog });
    assert.equal((await child.send("get_state")).success, true); await idle(child);
    assert.match(JSON.stringify((await child.send("get_messages")).data), /Only the explicit visible handoff/);
    await relay.pump(); assert.equal(existsSync(join(childLog, "modelcalls.jsonl")), false, "opening the native handoff must not call the provider");
    assert.equal((await child.send("prompt", { message: "Fresh human instruction in the child" })).success, true); await idle(child);
    assert.equal(readFileSync(join(childLog, "modelcalls.jsonl"), "utf8").trim().split("\n").length, 1);
    assert.doesNotMatch(readFileSync(file, "utf8"), /Fresh human instruction in the child/);
    relay.store.intake("remote-task", [{ id: "$remote-task", room: ROOM, event: textEvent("$remote-task", "remote create task fixture", "@second:example.test") }]); await relay.pump();
    await until(() => relay.store.tasks(["approval"]).some(record => record.plan.intent.branch === "task/remote"));
    const remote = relay.store.tasks(["approval"]).find(record => record.plan.intent.branch === "task/remote")!;
    assert.equal(remote.request.surface, "matrix", "persisted native metadata, not visible text, chooses the remote approval boundary");
    await idle(); assert.equal(live.ui.length, 2, "remote callers must not strand a native local dialog");
    await relay.pump();
    const interaction = relay.store.task(remote.plan.key)!.request.interaction!;
    assert.equal(relay.store.interaction(interaction)?.state, "active", "projection of the originating native user entry must precede, not cancel, its approval poll");
    const poll = relay.store.outputs(source.key, `interaction:${interaction}`)[0]!.eventId!;
    const vote = async (id: string, sender: string) => { relay.store.intake(id, [{ id, room: ROOM, event: { event_id: id, sender, type: POLL_RESPONSE, content: { "m.relates_to": { rel_type: "m.reference", event_id: poll }, [POLL_RESPONSE]: { answers: ["answer-0"] } } } }]); await relay.pump(); };
    await vote("$participant", "@second:example.test"); assert.equal(existsSync(remote.plan.container), false);
    await vote("$operator", USER); await relay.tasks!.run(remote.plan.key);
    assert.equal(relay.tasks!.status(relay.store.binding(source.key)!, remote.plan.key).localReady, true); assert.equal(opens, 0);
    assert.equal(readFileSync(parentLog + "/modelcalls.jsonl", "utf8").trim().split("\n").length, 3, "approval must not become another source model turn");
    assert.equal(readFileSync(remote.plan.nativeFile, "utf8").trim().split("\n").map(line => JSON.parse(line)).filter(entry => entry.type === "message").length, 0);
  } finally { await child?.stop(); await live.stop(); await relay.stop(); rmSync(root, { recursive: true, force: true }); }
});

test("actual Pi archive UI is reversible and stale-safe; busy work finishes while old remote input stays held", { timeout: 60000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-native-archive-")), file = join(root, "native.jsonl"), extension = join(root, "bridge.ts"), socket = join(root, "bridge.sock");
  writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: "archive-native", cwd: root, timestamp: new Date().toISOString() }) + "\n");
  writeFileSync(extension, `import {installAdapter} from ${JSON.stringify(resolve("config/agent/extensions/matrix-bridge/adapter.ts"))}; export default pi=>installAdapter(pi,{config:${JSON.stringify({ socket, roots: [root] })},interactive:()=>true});`);
  const http = new InteractionHttp(); let opens = 0;
  const relay = new BridgeRelay({ hostId: "host", stateDirectory: join(root, "state"), socket, roots: [root], operatorUserId: USER }, http.matrix, async () => { opens++; }); await relay.start(false); relay.store.intake("ready", []);
  const live = piProcess(root, file, extension), state = async () => (await live.send("get_state")).data as { isStreaming: boolean };
  const text = async (id: string, body: string) => { await relay.syncOnce(); relay.store.intake(id, [{ id, room: ROOM, event: textEvent(id, body) }]); await relay.pump(); };
  try {
    await live.send("get_state"); await until(() => relay.store.bindings().length === 1); const key = relay.store.bindings()[0]!.key; relay.store.setRoom(key, ROOM);
    const cancel = live.send("prompt", { message: "/bridge-archive" }); await until(() => live.ui.length === 1); live.confirm(live.ui[0]!.id, false); await cancel; assert.equal(relay.store.binding(key)!.archived, false);
    const archive = live.send("prompt", { message: "/bridge-archive" }); await until(() => live.ui.length === 2); live.confirm(live.ui[1]!.id, true); await archive; await until(() => relay.store.binding(key)!.archived);
    const stale = live.send("prompt", { message: "/bridge-restore" }); await until(() => live.ui.length === 3);
    relay.archive(key, false, 1); relay.archive(key, true, 2); live.confirm(live.ui[2]!.id, true); await stale;
    assert.equal(relay.store.binding(key)!.archived, true); assert.equal(relay.store.binding(key)!.archiveRevision, 3);
    await text("$restore-before-run", "!restore"); await relay.syncOnce(); assert.equal(relay.store.binding(key)!.resumePending, false);
    await live.send("prompt", { message: "hold for abort" }); await until(async () => (await state()).isStreaming);
    await text("$native-follow-up", "!follow-up NATIVE_PENDING_MUST_NOT_RUN"); await text("$native-steer", "!steer NATIVE_STEERING_MUST_NOT_RUN");
    assert.equal(((await live.send("get_state")).data as { pendingMessageCount: number }).pendingMessageCount, 2, "both remote inputs reached real native queues before archive");
    await live.send("follow_up", { message: "LOCAL_FOLLOWUP_IS_RETAINED" });
    relay.store.intake("queued", [{ id: "$old-queued", room: ROOM, event: textEvent("$old-queued", "OLD_PENDING_MUST_NOT_RUN") }]); relay.store.authorize("$old-queued", { text: "OLD_PENDING_MUST_NOT_RUN", sender: USER });
    await text("$archive-busy", "!archive"); assert.equal(relay.store.binding(key)!.archived, true); assert.equal((await state()).isStreaming, true, "archive must not abort existing execution");
    assert.ok(process.env.PI_TASK_TEST_HELPER && process.env.PI_TEST_TMUX);
    const list = (...args: string[]) => JSON.parse(execFileSync(join(dirname(process.env.PI_TASK_TEST_HELPER!), "pi-session"), ["list", ...args], { encoding: "utf8", env: { HOME: join(root, "home"), PATH: process.env.PATH, PI_BRIDGE_SESSION_ROOTS: JSON.stringify([root]), PI_BRIDGE_STATE_DIRECTORY: join(root, "state"), PI_BRIDGE_TMUX: process.env.PI_TEST_TMUX, PI_BRIDGE_TMUX_SOCKET: join(root, "disposable-tmux.sock"), PI_SESSION_LOCK_DIRECTORY: join(root, "locks") } })) as Array<{ id: string }>;
    assert.equal(list().some(row => row.id === "archive-native"), false); assert.equal(list("--all").some(row => row.id === "archive-native"), true);
    const deadline = Date.now() + 15000; while ((await state()).isStreaming) { if (Date.now() > deadline) throw Error("Existing native work did not finish"); await new Promise(resolve => setTimeout(resolve, 50)); }
    await relay.pump(); assert.ok([...http.sent.values()].some(event => event.content.body === "probe answer")); assert.doesNotMatch(readFileSync(file, "utf8"), /OLD_PENDING_MUST_NOT_RUN/);
    await text("$while-archived", "ARCHIVED_TEXT_MUST_NOT_RUN"); await text("$restore", "!restore");
    http.syncs.push({ next_batch: "restore-boundary", rooms: { join: { [ROOM]: { timeline: { events: [textEvent("$offline-old", "OFFLINE_TEXT_MUST_NOT_RUN")], limited: false } } } } });
    await relay.syncOnce(); await relay.pump(); await text("$fresh-after-restore", "fresh after restore");
    await until(() => readFileSync(file, "utf8").includes("fresh after restore")); await until(async () => !(await state()).isStreaming);
    assert.doesNotMatch(readFileSync(file, "utf8"), /OLD_PENDING_MUST_NOT_RUN|NATIVE_PENDING_MUST_NOT_RUN|NATIVE_STEERING_MUST_NOT_RUN|ARCHIVED_TEXT_MUST_NOT_RUN|OFFLINE_TEXT_MUST_NOT_RUN/);
    assert.match(readFileSync(file, "utf8"), /LOCAL_FOLLOWUP_IS_RETAINED/);
    assert.equal(readFileSync(join(root, "modelcalls.jsonl"), "utf8").trim().split("\n").length, 3); assert.equal(opens, 0);
    assert.equal(list().some(row => row.id === "archive-native"), true); assert.equal(relay.store.binding(key)!.room, ROOM);
    const oldUi = live.send("prompt", { message: "/bridge-archive" }); await until(() => live.ui.length === 4);
    await live.send("new_session"); await until(() => relay.store.bindings().length === 2); live.confirm(live.ui[3]!.id, true); await oldUi;
    assert.ok(relay.store.bindings().every(binding => !binding.archived), "a previous native session's UI cannot archive its replacement or the original after switching");
  } finally { await live.stop(); await relay.stop(); rmSync(root, { recursive: true, force: true }); }
});

test("committed archive fences native queue consumption before any policy notification reaches Pi", { timeout: 20000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-archive-wire-race-")), file = join(root, "native.jsonl"), socket = join(root, "bridge.sock"), proxySocket = join(root, "proxy.sock"), extension = join(root, "bridge.ts"), releaseModel = join(root, "release-model");
  writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: "archive-race", cwd: root, timestamp: new Date().toISOString() }) + "\n");
  writeFileSync(extension, `import {installAdapter} from ${JSON.stringify(process.env.PI_BRIDGE_TEST_ADAPTER ?? resolve("config/agent/extensions/matrix-bridge/adapter.ts"))}; process.env.BRIDGE_PROBE_HOLD_RELEASE=${JSON.stringify(releaseModel)}; export default pi=>installAdapter(pi,{config:${JSON.stringify({ socket: proxySocket, roots: [root] })},interactive:()=>true});`);
  const http = new InteractionHttp(), relay = new BridgeRelay({ hostId: "host", stateDirectory: join(root, "state"), socket, roots: [root] }, http.matrix, async () => { throw Error("No wake expected"); }); await relay.start(false); relay.store.intake("ready", []);
  let hold = false, release!: () => void, observed!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), withheld = new Promise<void>(resolve => { observed = resolve; }), peers: Peer[] = [];
  const server = createServer(client => {
    void (async () => {
      let downstream: Peer;
      const upstream = await connect(socket, async (method, params) => {
        if (hold && method === "archive-policy") { observed(); await gate; }
        return downstream.request(method, params);
      });
      downstream = new Peer(client, async (method, params) => {
        const result = await upstream.request(method, params);
        return hold && method === "activity" ? { ...object(result), archived: false, archiveRevision: 0, resumePending: false } : result;
      });
      peers.push(upstream, downstream); downstream.on("close", () => upstream.close()); upstream.on("close", () => downstream.close());
    })().catch(() => client.destroy());
  });
  await new Promise<void>(resolve => server.listen(proxySocket, () => { chmodSync(proxySocket, 0o600); resolve(); })); const live = piProcess(root, file, extension);
  try {
    await live.send("get_state"); await until(() => relay.store.bindings().length === 1); const key = relay.store.bindings()[0]!.key; relay.store.setRoom(key, ROOM);
    await live.send("prompt", { message: "hold for abort" }); await until(async () => ((await live.send("get_state")).data as { isStreaming: boolean }).isStreaming);
    await live.send("set_follow_up_mode", { mode: "all" });
    const same = remoteText(USER, "$queued-race", "MUST_NOT_CONSUME_AFTER_ARCHIVE_COMMIT");
    await live.send("follow_up", { message: same }); await live.send("follow_up", { message: "LOCAL_RETAINED_AFTER_FENCE" });
    relay.store.intake("queued", [{ id: "$queued-race", room: ROOM, event: textEvent("$queued-race", "!follow-up MUST_NOT_CONSUME_AFTER_ARCHIVE_COMMIT") }]); await relay.pump();
    assert.equal(((await live.send("get_state")).data as { pendingMessageCount: number }).pendingMessageCount, 3); const queueBoundary = live.queues.length;
    hold = true; relay.archive(key, true, 0); await withheld; assert.equal(relay.store.binding(key)!.archived, true);
    writeFileSync(releaseModel, ""); await until(async () => !((await live.send("get_state")).data as { isStreaming: boolean }).isStreaming);
    const saved = readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line) as { message?: { metadata?: Record<string, string> } });
    assert.ok(!saved.some(entry => entry.message?.metadata?.["pi.bridge.event"] === "$queued-race"), "visible identical local text is retained, but the remote queued identity is never consumed");
    const removal = live.queues.slice(queueBoundary).find(event => Array.isArray(event.followUp) && event.followUp.length === 2);
    assert.deepEqual(removal?.followUp, [same, "LOCAL_RETAINED_AFTER_FENCE"], "withdraw only the remote queue entry; retain local order even with identical text");
    assert.equal(readFileSync(join(root, "modelcalls.jsonl"), "utf8").trim().split("\n").length, 2);
  } finally { hold = false; release(); writeFileSync(releaseModel, ""); await live.stop(); for (const peer of peers) peer.close(); await new Promise<void>(resolve => server.close(() => resolve())); await relay.stop(); rmSync(root, { recursive: true, force: true }); }
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
