import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import registerPatchRuntime from "../config/agent/extensions/aloop-patch-runtime/index.js";
import registerWorkerRuntime from "../config/agent/extensions/aloop-worker-runtime/index.js";
import { collectSessionUsage } from "../config/agent/extensions/agent-profiles/usage.js";

function toolsFrom(register: (pi: any) => void): Map<string, any> {
	const tools = new Map<string, any>();
	register({ registerTool(tool: any) { tools.set(tool.name, tool); } });
	return tools;
}

async function withEnvironment(values: Record<string, string>, action: () => Promise<void>): Promise<void> {
	const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
	Object.assign(process.env, values);
	try { await action(); } finally {
		for (const [key, value] of previous) value === undefined ? delete process.env[key] : process.env[key] = value;
	}
}

test("implementation runtime exposes immutable context, advisory feedback, and terminating submission", async () => {
	const directory = await mkdtemp(path.join(tmpdir(), "aloop-runtime-"));
	try {
		const contextPath = path.join(directory, "context.json");
		const submissionPath = path.join(directory, "submission.json");
		await writeFile(contextPath, JSON.stringify({ selectedIssue: { number: 72 }, issueBaseCommit: "abc" }));
		await withEnvironment({
			PI_ALOOP_ISSUE_CONTEXT_PATH: contextPath,
			PI_ALOOP_SUBMISSION_PATH: submissionPath,
			PI_ALOOP_ATTEMPT_DIRECTORY: directory,
			PI_ALOOP_WORKER_FEEDBACK_COMMAND: JSON.stringify({ argv: ["sh", "-c", "printf focused-feedback"], timeoutMs: 5_000 }),
		}, async () => {
			const tools = toolsFrom(registerWorkerRuntime);
			assert.deepEqual([...tools.keys()].sort(), ["aloop_issue_context", "aloop_submit_result", "aloop_worker_feedback"]);
			const context = await tools.get("aloop_issue_context").execute("id", {});
			assert.match(context.content[0].text, /"number": 72/);
			const feedback = await tools.get("aloop_worker_feedback").execute("id", {}, undefined);
			assert.match(feedback.content[0].text, /passed|focused-feedback/);
			const submitted = await tools.get("aloop_submit_result").execute("id", {
				status: "decision-required", summary: "Need a product decision.", verification: [], acceptanceCriteria: [],
				discoveredWork: [], nextAction: "Ask the operator.",
			});
			assert.equal(submitted.terminate, true);
			assert.equal(JSON.parse(await readFile(submissionPath, "utf8")).status, "decision-required");
		});
	} finally { await rm(directory, { recursive: true, force: true }); }
});

test("nested model usage normalizes into supervisor accounting records", () => {
	assert.deepEqual(collectSessionUsage([{ role: "assistant", provider: "p", model: "m", usage: { input: 10, output: 4, cacheRead: 2, cost: { total: 0.5 } } }], "review:spec"), [{
		source: "review:spec", provider: "p", model: "m", inputTokens: 10, outputTokens: 4, cacheReadTokens: 2, cacheWriteTokens: 0, cost: 0.5,
	}]);
});

test("patch runtime persists a terminating structured result", async () => {
	const directory = await mkdtemp(path.join(tmpdir(), "aloop-patch-runtime-"));
	try {
		const submissionPath = path.join(directory, "submission.json");
		await withEnvironment({ PI_ALOOP_SUBMISSION_PATH: submissionPath }, async () => {
			const tool = toolsFrom(registerPatchRuntime).get("aloop_submit_patch_result");
			const result = await tool.execute("id", { status: "patched", summary: "Fixed.", verification: ["focused pass"], nextAction: "Review." });
			assert.equal(result.terminate, true);
			assert.equal(JSON.parse(await readFile(submissionPath, "utf8")).status, "patched");
		});
	} finally { await rm(directory, { recursive: true, force: true }); }
});
