import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { writeAttemptIdentity } from "../config/agent/extensions/github-issues/aloop-artifacts.js";
import { registerAloopExtension } from "../config/agent/extensions/aloop/index.js";

test("dirty startup reports interrupted evidence without activating or spawning", async (t) => {
	const cwd = await mkdtemp(join(tmpdir(), "aloop-dirty-recovery-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	const artifactDirectory = ".pi/tmp/aloop/issue-2-100-abcdef";
	await mkdir(join(cwd, artifactDirectory), { recursive: true });
	await writeAttemptIdentity(join(cwd, artifactDirectory), { version: 1, issue: 2, epic: 1, artifactDirectory, beforeHead: "a".repeat(40), issueBaseCommit: "a".repeat(40), workerKind: "implementation" });
	const commands = new Map<string, any>();
	const lifecycle: any[] = [];
	const pi = {
		registerTool: () => undefined, registerCommand: (name: string, command: any) => commands.set(name, command), on: () => undefined,
		getActiveTools: () => [], setActiveTools: () => assert.fail("must not activate"),
		appendEntry: (_type: string, event: unknown) => lifecycle.push(event),
		exec: async () => ({ code: 0, stdout: "?? partial.txt", stderr: "" }),
	} as unknown as ExtensionAPI;
	registerAloopExtension(pi, { retrieveEpicContext: async () => { assert.fail("must not consult GitHub"); }, runWorker: async () => { assert.fail("must not spawn"); } });
	const ctx = { cwd, hasUI: false, isIdle: () => true, sessionManager: { getSessionId: () => "dirty-recovery" }, ui: { notify: () => undefined } } as unknown as ExtensionContext;
	await commands.get("aloop").handler("#1", ctx);
	assert.match(lifecycle.at(-1)?.body, /1 interrupted attempt.*retained recovery evidence/);
});

test("supervisor blocks acceptance on incomplete capture and publishes preservation facts on rejection", async (t) => {
	const cwd = await mkdtemp(join(tmpdir(), "aloop-evidence-supervisor-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	const tools = new Map<string, any>(), commands = new Map<string, any>();
	const head = "a".repeat(40);
	const leaf = { number: 2, title: "Leaf", body: "Fix", state: "open" as const, labels: [], assignee: null, parent: null, container: { number: 1, title: "Epic", state: "open" as const }, children: [], blockers: [], recentHandoffs: [] };
	const graph = { epic: { number: 1, title: "Epic", state: "open" as const }, issues: [{ ...leaf, number: 1, children: [2] }, leaf], executableLeaves: [2] };
	const published: string[] = [];
	const pi = {
		registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand: (name: string, command: any) => commands.set(name, command),
		on: () => undefined, getActiveTools: () => [], setActiveTools: () => undefined, setSessionName: () => undefined, sendUserMessage: () => undefined, appendEntry: () => undefined,
		exec: async (command: string, args: string[]) => ({ code: 0, stderr: "", stdout: command === "gh" ? "supervisor" : args[0] === "show" ? JSON.stringify({ canonicalCommand: { argv: [process.execPath, "-e", "process.exit(0)"] } }) : args[0] === "status" ? "" : head }),
	} as unknown as ExtensionAPI;
	registerAloopExtension(pi, {
		retrieveEpicContext: async () => graph,
		runWorker: async () => ({ status: "timeout", summary: "partial", commit: null, workerResult: null, contract: { valid: false, commit: null, violations: [] }, process: { exitCode: null, signal: null, timedOut: true, cancelled: false, durationMs: 1 }, preservation: { version: 1, head, commits: 0, staged: null, unstaged: null, untracked: null, capture: "incomplete", failures: ["worktree inspection"] }, artifacts: { directory: ".pi/tmp/aloop/issue-2-1-abcdef", prompt: "p", stdout: "o", stderr: "e", result: "r" } }),
		publishComment: async (_cwd, _issue, body, apply) => { if (apply) published.push(body); return {}; },
		closeIssue: async () => { assert.fail("must not close"); },
	});
	const ctx = { cwd, hasUI: false, isIdle: () => true, signal: new AbortController().signal, abort: () => undefined, sessionManager: { getSessionId: () => "preservation-test" }, model: { provider: "p", id: "m" }, modelRegistry: { find: () => undefined, hasConfiguredAuth: () => false } } as unknown as ExtensionContext;
	await commands.get("aloop").handler("#1", ctx);
	await tools.get("aloop_launch_worker").execute("launch", { issue: 2 }, ctx.signal, undefined, ctx);
	const params = { issue: 2, outcome: "accepted", summary: "No changes", outstanding_findings: [], decisions: [], verification: [], next_action: "Inspect" };
	await assert.rejects(tools.get("aloop_finish_attempt").execute("finish", params, ctx.signal, undefined, ctx), /complete preservation evidence/);
	assert.equal(published.length, 0);
	await tools.get("aloop_finish_attempt").execute("reject", { ...params, outcome: "rejected" }, ctx.signal, undefined, ctx);
	assert.match(published[0]!, /unknown untracked paths/);
	assert.match(published[0]!, /Preservation: incomplete/);
	assert.doesNotMatch(published[0]!, /No changes/);
});
