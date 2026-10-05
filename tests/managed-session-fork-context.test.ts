import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { forkContextEntry, forkContextId, forkContextText, parseForkContext, verifyForkContextEntry, FORK_CONTEXT_TYPE } from "../config/agent/extensions/managed-sessions/fork-context.js";

import { durableProjectSession } from "../config/agent/extensions/managed-sessions/relay/host-lifecycle.js";

const context = { version: 1 as const, sourceConversationId: `conv_${"a".repeat(32)}`, sourceGenerationId: `generation_${"b".repeat(32)}`,
	baseCommit: "c".repeat(40), summary: "Goal: implement the parser.\nCompleted: grammar review.\nNext: add fixtures." };
const timestamp = "2026-10-05T00:00:00.000Z";

test("fork context is explicit, bounded and cannot import execution state", () => {
	assert.deepEqual(parseForkContext(context), context);
	assert.notEqual(parseForkContext(context), context, "return a detached value");
	for (const value of [null, { ...context, binding: {} }, { ...context, approvals: [] }, { ...context, summary: " " },
		{ ...context, summary: "x".repeat(4097) }, { ...context, summary: "界".repeat(3000) }, { ...context, summary: "hidden\u0000text" },
		{ ...context, baseCommit: "main" }, { ...context, sourceGenerationId: "latest" },
		...["\u0085", "\u202e", "\u2066", "\u200f", "\r", "\ud800"].map(control => ({ ...context, summary: `unsafe${control}summary` }))]) assert.throws(() => parseForkContext(value), /Invalid fork context/);
	assert.equal(parseForkContext({ ...context, summary: "界".repeat(2000) }).summary.length, 2000);
});

test("fork context content and seed identity are frozen without normalizing away differences", () => {
	const reordered = { summary: context.summary, baseCommit: context.baseCommit, sourceGenerationId: context.sourceGenerationId, sourceConversationId: context.sourceConversationId, version: 1 as const };
	assert.equal(forkContextId(context), "fork_context_d78f2e7fbbe8ebf4ff58f00bbac14f04", "length-framed live-v1 identity vector");
	assert.equal(forkContextId(context), forkContextId(reordered));
	for (const change of [{ summary: `${context.summary}\n` }, { baseCommit: "d".repeat(40) }, { sourceGenerationId: `generation_${"e".repeat(32)}` }, { sourceConversationId: `conv_${"f".repeat(32)}` }]) {
		assert.notEqual(forkContextId(context), forkContextId({ ...context, ...change }));
	}
	const entry = forkContextEntry(context, "fresh-boundary", timestamp);
	assert.equal(entry.content, forkContextText(context)); assert.equal(entry.display, true);
	verifyForkContextEntry(JSON.parse(JSON.stringify(entry)), context, "fresh-boundary");
	assert.throws(() => verifyForkContextEntry({ ...entry, id: `fork_context_${"a".repeat(64)}` }, context, "fresh-boundary"), /conflicts/, "unreleased legacy seeds require explicit recovery, never automatic rewriting");
	for (const change of [{ content: "replacement" }, { display: false }, { parentId: "old-binding" }, { details: {} }, { extra: true }]) {
		assert.throws(() => verifyForkContextEntry({ ...entry, ...change }, context, "fresh-boundary"), /conflicts/);
	}
	assert.throws(() => forkContextEntry(context, "../file", timestamp), /boundary/);
	assert.throws(() => forkContextEntry(context, "fresh-boundary", "yesterday"), /boundary/);
});

test("fresh session publication includes exactly one immutable seed, never retrofits existing history", async t => {
	const root = await mkdtemp(join(tmpdir(), "fork-session-")); t.after(() => rm(root, { recursive: true, force: true }));
	const path = join(root, "target.jsonl"), target = `conv_${"d".repeat(32)}`;
	const create = (seed = context) => durableProjectSession(path, root, target, "fork", "New conversation", 1, false, seed);
	const first = await create(); const bytes = await readFile(path, "utf8");
	assert.deepEqual(await create(), first); assert.equal(await readFile(path, "utf8"), bytes);
	await assert.rejects(create({ ...context, summary: "changed" }), /conflicts/); assert.equal(await readFile(path, "utf8"), bytes);
	const ordinary = join(root, "ordinary.jsonl"); await durableProjectSession(ordinary, root, target, "ordinary", "Existing");
	const before = await readFile(ordinary, "utf8");
	await assert.rejects(durableProjectSession(ordinary, root, target, "ordinary", "Existing", 1, false, context), /unique fork context/);
	assert.equal(await readFile(ordinary, "utf8"), before);
	await assert.rejects(durableProjectSession(path, root, context.sourceConversationId, "fork", "New", 1, false, context), /independent initial generation/);
	await assert.rejects(durableProjectSession(path, root, target, "fork", "New", 2, false, context), /independent initial generation/);
});

test("real Pi loads visible inherited context and remains idle until an explicit next prompt", { timeout: 15000 }, async t => {
	const piPath = process.env.PI_MANAGED_ADAPTER_TEST_PI; if (!piPath) return t.skip("packaged Pi SDK unavailable");
	const sdkRoot = join(dirname(dirname(piPath)), "lib/node_modules/@earendil-works/pi-coding-agent");
	const sdk = await import(pathToFileURL(join(sdkRoot, "dist/index.js")).href);
	const ai = await import(pathToFileURL(join(sdkRoot, "node_modules/@earendil-works/pi-ai/dist/index.js")).href);
	const root = await mkdtemp(join(tmpdir(), "fork-context-")); t.after(() => rm(root, { recursive: true, force: true }));
	const path = join(root, "target.jsonl");
	await durableProjectSession(path, root, `conv_${"d".repeat(32)}`, "fork", "New conversation", 1, false, context);
	const initial = (await readFile(path, "utf8")).trim().split("\n").map(line => JSON.parse(line));
	const seed = initial.find(entry => entry.customType === FORK_CONTEXT_TYPE);
	const boundary = initial.find(entry => entry.customType === "managed-session.binding-boundary");
	const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
	const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: join(root, "models.json"), modelsStorePath: join(root, "store.json") });
	await modelRuntime.setRuntimeApiKey("anthropic", "fixture-key");
	let calls = 0;
	for (let attempt = 0; attempt < 2; attempt++) {
		const sm = sdk.SessionManager.open(path);
		assert.equal(sm.getEntries().filter((entry: any) => entry.customType === FORK_CONTEXT_TYPE).length, 1);
		const messages = sm.buildSessionContext().messages;
		assert.equal(messages[0].role, "custom"); assert.equal(messages[0].content, seed.content); assert.equal(messages[0].display, true);
		const loader = new sdk.DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true });
		await loader.reload();
		const { session } = await sdk.createAgentSession({ cwd: root, agentDir: root, resourceLoader: loader, settingsManager, sessionManager: sm,
			modelRuntime, model: modelRuntime.getModel("anthropic", "claude-sonnet-4-5"), tools: [] });
		try {
			session.agent.streamFunction = (model: any) => {
				calls++; const stream = ai.createAssistantMessageEventStream();
				queueMicrotask(() => { const message = { role: "assistant", content: [{ type: "text", text: "Now responding to the new message." }],
					api: model.api, provider: model.provider, model: model.id, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() };
					stream.push({ type: "done", reason: "stop", message }); stream.end(); }); return stream;
			};
			await session.bindExtensions({}); await new Promise(resolve => setImmediate(resolve));
			assert.equal(calls, 0, "loading or reopening context must not trigger a model call");
			assert.equal(session.agent.state.messages[0].content, seed.content);
			if (attempt === 1) { await session.prompt("Now add the fixtures."); assert.equal(calls, 1); }
		} finally { await session.abort(); await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); }
	}
	const saved = (await readFile(path, "utf8")).trim().split("\n").map(line => JSON.parse(line));
	assert.equal(saved.filter(entry => entry.customType === FORK_CONTEXT_TYPE).length, 1);
	verifyForkContextEntry(saved.find(entry => entry.customType === FORK_CONTEXT_TYPE), context, boundary.id);
	assert.equal(saved[0].parentSession, undefined, "no source-file history relationship is imported");
});
