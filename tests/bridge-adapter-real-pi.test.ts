import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { appendFileSync, chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { BridgeRelay } from "../config/agent/extensions/matrix-bridge/relay.js";
import { BridgeMatrix } from "../config/agent/extensions/matrix-bridge/matrix.js";
import { MatrixHttp } from "../config/agent/extensions/matrix-shared/http.js";
import { InteractionHttp, ROOM, USER, textEvent } from "./fixtures/matrix-bridge/interaction-http.js";
import { POLL_START, POLL_RESPONSE } from "../config/agent/extensions/matrix-bridge/interaction.js";
import { Peer } from "../config/agent/extensions/matrix-bridge/wire.js";
import { imageInfo } from "../config/agent/extensions/matrix-bridge/media.js";

async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  const end = Date.now() + 8000;
  while (!await check()) { if (Date.now() > end) throw Error("Native bridge test condition timed out"); await new Promise(resolve => setTimeout(resolve, 20)); }
}
function piProcess(root: string, file: string, extension: string, extra: string[] = []) {
  const executable = process.env.PI_BRIDGE_TEST_PI;
  assert.ok(executable, "the actual packaged Pi is required; no skipped runtime evidence");
  const home = join(root, "home"); mkdirSync(home, { recursive: true });
  const child = spawn(executable, ["--mode", "rpc", "--session", file, "--no-extensions", "--no-skills", "--no-context-files", "--no-builtin-tools", "--extension", extension,
    "--extension", resolve("tests/fixtures/matrix-bridge/native-probe.mjs"), "--provider", "bridge-probe", "--model", "fake", ...extra], {
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
  let peer: Peer | undefined, release!: () => void, observed!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), reading = new Promise<void>(resolve => { observed = resolve; });
  const server = createServer(connection => {
    peer = new Peer(connection, async (method, params) => {
      if (method === "input.read") return { text: JSON.stringify(params.id === "$image" ? { text: "caption", sender: USER, image: info } : ["$model", "$fresh-model"].includes(String(params.id)) ? { text: "!model bridge-probe/fake-text", sender: USER, control: "model", argument: "bridge-probe/fake-text" } : { text: "!abort", sender: USER, control: "abort" }), done: true };
      if (method === "image.read") { observed(); await gate; return { data: bytes.toString("base64"), sha256: info.sha256, offset: 0, done: true }; }
      return { room: ROOM, intakeReady: true };
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
  } finally { writeFileSync(modelRelease, ""); release(); peer?.close(); await live.stop(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }); }
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
