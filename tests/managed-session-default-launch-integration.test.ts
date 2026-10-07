import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import test, { type TestContext } from "node:test";
import { deriveConversationId, deriveGenerationId } from "../config/agent/extensions/managed-sessions/contracts.js";
import { parseHostRequest, savedSessionKey } from "../config/agent/extensions/managed-sessions/live-workspace-contracts.js";

async function fixture(t: TestContext) {
	const pi = process.env.PI_MANAGED_ADAPTER_TEST_PI;
	if (!pi) { t.skip("packaged SDK unavailable"); return; }
	const root = await mkdtemp(join(tmpdir(), "pi-launch-ui-")); t.after(() => rm(root, { recursive: true, force: true }));
	const cwd = join(root, "project"), runtime = join(root, "runtime"), owned = join(root, "owned"), agent = join(root, "agent");
	await Promise.all([mkdir(cwd), mkdir(runtime), mkdir(agent)]);
	await mkdir(join(runtime, "pi-managed-sessions"), { mode: 0o700 });
	const fzf = join(root, "fzf");
	await writeFile(fzf, `#!${process.execPath}\nif(process.env.TEST_CANCEL)process.exit(130);const rows=require('fs').readFileSync(0,'utf8').split('\\0');process.stdout.write(rows[0]+'\\0');\n`, { mode: 0o700 });
	const native = join(root, "native"), launcher = join(root, "launcher"), capture = join(root, "native.json"), log = join(root, "launcher.log");
	await writeFile(native, `#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(capture)},JSON.stringify({argv:process.argv.slice(2),cwd:process.cwd(),local:process.env.PI_HARNESS_LOCAL_ONLY}));\n`, { mode: 0o700 });
	await writeFile(launcher, `#!${process.execPath}\nconst fs=require('fs');const op=process.argv[3];const req=JSON.parse(fs.readFileSync(0,'utf8'));fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({op,req})+'\\n');let result;
if(op==='workspace-identify-auto')result={eligible:process.env.TEST_ELIGIBLE!=='0',reason:'outside-configured-checkouts',cwd:req.cwd,placement:{rootKey:'projects',workspace:'project',relativeCwd:''}};
else if(op==='ui-capabilities')result={version:1,clientCapture:true,exactFocus:true,exactAttach:true};
else if(op==='client-capture')result={clientName:'client-123',clientPid:'123'};
else if(op==='window-focus-exact')result={focused:true};
else if(op==='window-attach-exact')process.exit(0);
else throw Error(op);console.log(JSON.stringify(result));\n`, { mode: 0o700 });
	const requests: Array<Record<string, unknown>> = [], summaries = new Map<string, Record<string, unknown>>(), retired = new Set<string>();
	const server = createServer(socket => {
		let text = "";
		socket.on("data", chunk => {
			text += chunk;
			if (!text.endsWith("\n")) return;
			void (async () => {
				const request = parseHostRequest(JSON.parse(text)); const action = request.action; requests.push(action);
				let data: unknown;
				const error = (code: string) => socket.end(JSON.stringify({ version: "1.0.0", requestId: request.actor.requestId, ok: false, error: { code, message: code, retryable: false } }) + "\n");
				if (action.operation === "host.status") data = { hostId: "host", relayState: "disconnected", accountState: "unavailable", capabilities: ["saved-session-open-v1", "window-first-open-v1", "saved-session-import-v1"] };
				else if (action.operation === "conversation.list") data = { items: [...summaries.values()], nextCursor: null };
				else if (action.operation === "conversation.create") {
					const id = deriveConversationId("host", action.creationKey);
					const attempt = JSON.parse(await readFile(join(owned, ".launch-attempts", `${id}.json`), "utf8"));
					assert.equal(attempt.phase, "ready"); assert.deepEqual(attempt.action, action);
					summaries.set(id, { ...summary(id), ...(action.expectedSessionKey ? { sessionKey: action.expectedSessionKey } : {}) }); data = { conversationId: id, launchId: `launch_${"a".repeat(32)}`, setupState: "pending" };
				} else if (action.operation === "conversation.status") {
					if (retired.has(action.conversationId)) { error("retired"); return; }
					data = summaries.get(action.conversationId); if (!data) { error("not_found"); return; }
				} else if (action.operation === "conversation.open") {
					assert.ok(summaries.has(action.conversationId)); data = { conversationId: action.conversationId, launchId: `launch_${"a".repeat(32)}`, launchState: "window_created", window: { conversationId: action.conversationId, sessionName: "project", windowId: "@1", paneId: "%1" } };
				} else throw new Error(action.operation);
				socket.end(JSON.stringify({ version: "1.0.0", requestId: request.actor.requestId, ok: true, data }) + "\n");
			})().catch(error => { socket.destroy(); t.diagnostic(String(error)); });
		});
	});
	const socket = join(runtime, "pi-managed-sessions/control.sock");
	await new Promise<void>(done => server.listen(socket, done)); await chmod(socket, 0o600);
	t.after(() => new Promise<void>(done => server.close(() => done())));
	function summary(id: string, sessionId?: string) {
		return { conversationId: id, kind: "project", reconciliationRequired: true, title: "Saved", runtimeState: "running", launchState: "attached", setupState: "pending", activeGenerationId: deriveGenerationId(id, 1), capabilities: ["saved-session-open-v1"], ...(sessionId ? { sessionKey: savedSessionKey("host", sessionId) } : {}) };
	}
	async function run(argv: string[] = [], extra: Record<string, string> = {}, keys?: string) {
		const sdkRoot = join(dirname(dirname(pi!)), "lib/node_modules/@earendil-works/pi-coding-agent");
		const env = { PATH: process.env.PATH!, HOME: root, TERM: "xterm-256color", XDG_RUNTIME_DIR: runtime,
			PI_CODING_AGENT_DIR: agent, NODE_PATH: join(sdkRoot, "node_modules"), PI_HARNESS_NATIVE_SDK: join(sdkRoot, "dist/index.js"),
			PI_HARNESS_RESUME_FZF: fzf, PI_HARNESS_NATIVE_PI: native, PI_HARNESS_MANAGED_LAUNCHER: launcher, PI_HARNESS_MANAGED_HOST_ID: "host", PI_MANAGED_PROJECT_SESSION_DIR: owned, ...extra };
		const child = spawn(process.env.PI_TEST_PYTHON ?? "python3", [resolve("tests/fixtures/managed-launch-pty.py")], { stdio: ["pipe", "pipe", "pipe"] });
		let output = "", errors = ""; child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { errors += chunk; });
		child.stdin.end(JSON.stringify({ cwd, env, ...(keys ? { keys, sendWhen: "Resume>" } : {}), argv: [process.execPath, resolve("config/agent/extensions/managed-sessions/launch/main.mjs"), ...argv] }));
		await new Promise<void>((done, reject) => { child.on("error", reject); child.on("exit", code => code === 0 ? done() : reject(new Error(errors))); });
		return JSON.parse(output) as { code: number; output: string };
	}
	async function history(managed = false) {
		const creationKey = "saved", id = deriveConversationId("host", creationKey), sessionId = "native-saved";
		const path = managed ? join(owned, id, "session.jsonl") : join(root, "saved.jsonl"); await mkdir(dirname(path), { recursive: true });
		const entries = [{ type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd },
			...(managed ? [{ type: "custom", id: "boundary", parentId: null, customType: "managed-session.binding-boundary", data: { version: "1.0.0", sessionId, creationKey, concept: "Saved" } }] : [])];
		await writeFile(path, entries.map(entry => JSON.stringify(entry)).join("\n") + "\n", { mode: 0o600 });
		return { path, id, sessionId, bytes: await readFile(path, "utf8") };
	}
	return { root, cwd, owned, run, requests, summaries, retired, history, summary, capture, log, server };
}

test("interactive bare launch creates once and targets the requesting client while Matrix is unavailable", async t => {
	const f = await fixture(t); if (!f) return;
	for (const extra of [{}, { TMUX: "/unused,123,0", TMUX_PANE: "%8" }] as Array<Record<string, string>>) {
		const result = await f.run([], extra); assert.equal(result.code, 0, result.output);
	}
	assert.equal(f.requests.filter(action => action.operation === "conversation.create").length, 2);
	assert.equal(f.requests.filter(action => action.operation === "conversation.open").length, 2);
	const rows = (await readFile(f.log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
	assert.ok(rows.some(row => row.op === "window-attach-exact")); assert.ok(rows.some(row => row.op === "window-focus-exact" && row.req.clientPid === "123"));
});

test("explicit resume reuses an owned generation, imports ordinary and retired snapshots, and preserves sources", async t => {
	const f = await fixture(t); if (!f) return;
	const bound = await f.history(true); f.summaries.set(bound.id, f.summary(bound.id, bound.sessionId));
	let result = await f.run(["--session", bound.path]); assert.equal(result.code, 0, result.output);
	assert.equal(f.requests.filter(action => action.operation === "conversation.create").length, 0);
	assert.equal(f.requests.find(action => action.operation === "conversation.open")?.expectedGenerationId, deriveGenerationId(bound.id, 1));
	f.retired.add(bound.id); f.summaries.delete(bound.id);
	result = await f.run(["--session", bound.path]); assert.equal(result.code, 0, result.output);
	const ordinary = await f.history(false);
	result = await f.run(["--session", ordinary.path]); assert.equal(result.code, 0, result.output);
	assert.equal(f.requests.filter(action => action.operation === "conversation.create").length, 2);
	assert.equal(await readFile(bound.path, "utf8"), bound.bytes); assert.equal(await readFile(ordinary.path, "utf8"), ordinary.bytes);
	assert.equal((await readdir(f.owned)).filter(name => name.startsWith("conv_")).length, 3);
	assert.deepEqual(await readdir(join(f.owned, ".launch-attempts")), []);
});

test("local-only refuses bound history without host contact and preserves ordinary startup overrides", async t => {
	const f = await fixture(t); if (!f) return;
	const bound = await f.history(true), ordinary = await f.history(false);
	let result = await f.run(["--session", bound.path], { PI_HARNESS_LOCAL_ONLY: "1" }); assert.notEqual(result.code, 0);
	result = await f.run(["--session", ordinary.path, "--model", "test/model", "--", "literal prompt"], { PI_HARNESS_LOCAL_ONLY: "1" }); assert.equal(result.code, 0, result.output);
	const native = JSON.parse(await readFile(f.capture, "utf8")); assert.equal(native.local, "1"); assert.ok(native.argv.includes("literal prompt")); assert.ok(native.argv.includes("test/model"));
	assert.equal(f.requests.length, 0);
});

test("unsupported eligible startup overrides refuse before mutation; ineligible launch stays native", async t => {
	const f = await fixture(t); if (!f) return;
	let result = await f.run(["--model", "test/model"]); assert.notEqual(result.code, 0); assert.match(result.output, /pi-local-only/); assert.equal(f.requests.length, 0);
	result = await f.run(["--model", "test/model"], { TEST_ELIGIBLE: "0" }); assert.equal(result.code, 0, result.output);
	assert.deepEqual(JSON.parse(await readFile(f.capture, "utf8")).argv, ["--model", "test/model"]); assert.equal(f.requests.length, 0);
});

test("relay outage refuses eligible creation but does not block explicit local-only work", async t => {
	const f = await fixture(t); if (!f) return;
	await new Promise<void>(done => f.server.close(() => done()));
	let result = await f.run(); assert.notEqual(result.code, 0); assert.match(result.output, /pi-local-only/);
	await assert.rejects(readFile(f.capture), { code: "ENOENT" });
	await assert.rejects(readdir(f.owned), { code: "ENOENT" });
	result = await f.run([], { PI_HARNESS_LOCAL_ONLY: "1" }); assert.equal(result.code, 0, result.output);
	assert.equal(f.requests.length, 0);
});

test("local-only storage aliases cannot bypass owned-directory guards", async t => {
	const f = await fixture(t); if (!f) return;
	await mkdir(f.owned); const alias = join(f.root, "alias"); await symlink(f.owned, alias);
	const result = await f.run(["--session-dir", join(alias, "new")], { PI_HARNESS_LOCAL_ONLY: "1" });
	assert.notEqual(result.code, 0); assert.match(result.output, /host-owned storage/);
	assert.deepEqual(await readdir(f.owned), []); assert.equal(f.requests.length, 0);
	const dangling = join(f.root, "dangling.jsonl"); await symlink(join(f.owned, "not-created.jsonl"), dangling);
	const missing = await f.run(["--session", dangling], { PI_HARNESS_LOCAL_ONLY: "1" });
	assert.notEqual(missing.code, 0); assert.match(missing.output, /Dangling storage aliases/);
});

test("read-only native selection supports picker, continue and ID prefixes without a second admission", async t => {
	const f = await fixture(t); if (!f) return;
	const bound = await f.history(true); f.summaries.set(bound.id, f.summary(bound.id, bound.sessionId));
	let result = await f.run(["--resume"], { TEST_CANCEL: "1" }); assert.equal(result.code, 0, result.output); assert.equal(f.requests.length, 0);
	for (const argv of [["--resume"], ["--continue"], ["--session", "native-sa"], ["--session-id", bound.sessionId]]) {
		result = await f.run(argv); assert.equal(result.code, 0, result.output);
	}
	assert.equal(f.requests.filter(action => action.operation === "conversation.create").length, 0);
	assert.equal(f.requests.filter(action => action.operation === "conversation.open").length, 4);
});

test("excluded persistent native modes keep ordinary arguments and never bypass bound-writer safety", async t => {
	const f = await fixture(t); if (!f) return;
	const ordinary = await f.history(false), bound = await f.history(true);
	for (const extra of [{ PI_HARNESS_AGENT_PROFILE: "review-worker" }, { PI_ALOOP_INVOCATION_ID: "internal" }, { PI_EVAL_ATTESTATION_PATH: "/fixture" }, { PI_EXPERIMENTAL: "1" }] as Array<Record<string, string>>) {
		const argv = ["--session", ordinary.path, "--model", "test/model"];
		let result = await f.run(argv, extra); assert.equal(result.code, 0, result.output);
		assert.deepEqual(JSON.parse(await readFile(f.capture, "utf8")).argv, argv);
		result = await f.run(["--session", bound.path], extra); assert.notEqual(result.code, 0);
	}
	const result = await f.run(["--mode", "rpc", "--session", ordinary.path]); assert.equal(result.code, 0, result.output);
	assert.equal(f.requests.length, 0);
});

test("actual fzf displays on the requesting PTY and Enter opens the selected owned session", async t => {
	const f = await fixture(t); if (!f) return;
	if (!process.env.PI_TEST_FZF) return t.skip("packaged fzf unavailable");
	const bound = await f.history(true); f.summaries.set(bound.id, f.summary(bound.id, bound.sessionId));
	const result = await f.run(["--resume"], { PI_HARNESS_RESUME_FZF: process.env.PI_TEST_FZF }, "\r");
	assert.equal(result.code, 0, result.output); assert.match(result.output, /Resume>/);
	assert.equal(f.requests.filter(action => action.operation === "conversation.open").length, 1);
	assert.equal(f.requests.filter(action => action.operation === "conversation.create").length, 0);
});

test("native-only new IDs and new file targets remain native, never an implicit managed creation", async t => {
	const f = await fixture(t); if (!f) return;
	for (const argv of [["--session-id", "brand-new"], ["--session", join(f.root, "brand-new.jsonl")]]) {
		let result = await f.run(argv); assert.notEqual(result.code, 0, result.output); assert.equal(f.requests.length, 0);
		result = await f.run(argv, { PI_HARNESS_LOCAL_ONLY: "1" }); assert.equal(result.code, 0, result.output);
		result = await f.run(argv, { TEST_ELIGIBLE: "0" }); assert.equal(result.code, 0, result.output);
	}
	assert.equal(f.requests.length, 0);
});
