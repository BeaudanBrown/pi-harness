import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
	DEFAULT_WORKER_MODEL,
	isWorkerMode,
	LUNA_WORKER_MODEL,
	nextWorkerPresetSelection,
	parseWorkerModelCommand,
	parseWorkerModelRef,
	workerModelCandidates,
	workerModelForMode,
	workerModelSearchText,
	workerSelectionFromSettings,
	workerSelectionToSettings,
} from "../config/agent/extensions/worker-runner/core.js";
import { balancedLogExcerpt, deterministicCommandSummary, runDurableCommand } from "../config/agent/extensions/worker-runner/command-execution.js";

test("worker presets target Spark by default and Luna explicitly", () => {
	assert.equal(workerModelForMode("spark"), "openai-codex/gpt-5.3-codex-spark");
	assert.equal(workerModelForMode("luna"), "openai-codex/gpt-5.6-luna");
	assert.equal(DEFAULT_WORKER_MODEL, "openai-codex/gpt-5.3-codex-spark");
	assert.equal(LUNA_WORKER_MODEL, "openai-codex/gpt-5.6-luna");
	assert.equal(isWorkerMode("spark"), true);
	assert.equal(isWorkerMode("luna"), true);
	assert.equal(isWorkerMode("other"), false);
});

test("Spark preserves the parent-model fallback but Luna never silently falls back", () => {
	assert.deepEqual(
		workerModelCandidates({ selection: { kind: "preset", preset: "spark" }, parentModel: "openai-codex/gpt-5.5" }),
		[DEFAULT_WORKER_MODEL, "openai-codex/gpt-5.5"],
	);
	assert.deepEqual(
		workerModelCandidates({
			selection: { kind: "preset", preset: "luna" },
			parentModel: "openai-codex/gpt-5.3-codex-spark",
		}),
		[LUNA_WORKER_MODEL],
	);
});

test("an explicitly selected model never silently falls back", () => {
	assert.deepEqual(
		workerModelCandidates({
			selection: { kind: "model", modelRef: "anthropic/claude-sonnet-4-6" },
			parentModel: DEFAULT_WORKER_MODEL,
		}),
		["anthropic/claude-sonnet-4-6"],
	);
});

test("the explicit environment override has priority", () => {
	assert.deepEqual(
		workerModelCandidates({
			selection: { kind: "model", modelRef: "anthropic/claude-sonnet-4-6" },
			environmentOverride: " litellm/sub-gpt-5.5 ",
			parentModel: "openai-codex/gpt-5.5",
		}),
		["litellm/sub-gpt-5.5"],
	);
});

test("legacy mode settings migrate to preset selections", () => {
	assert.deepEqual(workerSelectionFromSettings({ mode: "luna" }), { kind: "preset", preset: "luna" });
	assert.deepEqual(workerSelectionFromSettings({ mode: "unknown" }), { kind: "preset", preset: "spark" });
});

test("custom selections round trip through persisted settings", () => {
	const selection = { kind: "model" as const, modelRef: "anthropic/claude-sonnet-4-6" };
	assert.deepEqual(workerSelectionFromSettings(workerSelectionToSettings(selection)), selection);
	assert.deepEqual(workerSelectionToSettings(selection), { selection });
});

test("the quick toggle remains Spark and Luna focused", () => {
	assert.deepEqual(nextWorkerPresetSelection({ kind: "preset", preset: "spark" }), { kind: "preset", preset: "luna" });
	assert.deepEqual(nextWorkerPresetSelection({ kind: "preset", preset: "luna" }), { kind: "preset", preset: "spark" });
	assert.deepEqual(nextWorkerPresetSelection({ kind: "model", modelRef: "anthropic/claude-sonnet-4-6" }), {
		kind: "preset",
		preset: "spark",
	});
});

test("worker-model commands preserve the toggle and accept selector and direct references", () => {
	assert.deepEqual(parseWorkerModelCommand(""), { type: "toggle" });
	assert.deepEqual(parseWorkerModelCommand("status"), { type: "status" });
	assert.deepEqual(parseWorkerModelCommand("select"), { type: "select" });
	assert.deepEqual(parseWorkerModelCommand("LUNA"), { type: "preset", preset: "luna" });
	assert.deepEqual(parseWorkerModelCommand(" anthropic/claude-sonnet-4-6 "), {
		type: "model",
		modelRef: "anthropic/claude-sonnet-4-6",
	});
	assert.deepEqual(parseWorkerModelCommand("not-a-model"), { type: "invalid", input: "not-a-model" });
});

test("model search covers provider, ID, qualified reference, and display name", () => {
	assert.equal(
		workerModelSearchText({ provider: "openai-codex", id: "gpt-5.6-luna", name: "GPT 5.6 Luna" }),
		"openai-codex openai-codex/gpt-5.6-luna openai-codex gpt-5.6-luna GPT 5.6 Luna",
	);
});

test("balanced diagnostic excerpts retain both beginning and end", () => {
	const excerpt = balancedLogExcerpt(`BEGIN-${"x".repeat(10_000)}-END`, 1_000);
	assert.match(excerpt, /^BEGIN-/);
	assert.match(excerpt, /middle bytes omitted/);
	assert.match(excerpt, /-END$/);
	assert.ok(Buffer.byteLength(excerpt) <= 1_100);
	assert.equal(
		deterministicCommandSummary("check", { code: 2, timedOut: false, cancelled: false, stdout: "start", stderr: "failure" }, 1_000),
		"check: failed with exit code 2.\n\nRelevant output:\nstart\nfailure",
	);
});

test("durable command timeout kills descendants and writes authoritative result first", async () => {
	const cwd = await mkdtemp(path.join(tmpdir(), "worker-command-timeout-"));
	try {
		const resultPath = path.join(cwd, "result.json");
		const childPath = path.join(cwd, "child.pid");
		const result = await runDurableCommand({
			cwd,
			command: ["bash", "-c", `sleep 30 & echo $! > ${JSON.stringify(childPath)}; wait`],
			logPath: path.join(cwd, "command.log"),
			resultPath,
			timeoutMs: 50,
			shutdownGraceMs: 100,
		});
		assert.equal(result.timedOut, true);
		const childPid = Number((await readFile(childPath, "utf8")).trim());
		assert.throws(() => process.kill(childPid, 0), /ESRCH/);
		const persisted = JSON.parse(await readFile(resultPath, "utf8"));
		assert.equal(persisted.timedOut, true);
		assert.deepEqual(persisted.command, result.command);
	} finally { await rm(cwd, { recursive: true, force: true }); }
});

test("successful commands cannot leave detached descendants running", async () => {
	const cwd = await mkdtemp(path.join(tmpdir(), "worker-command-success-child-"));
	try {
		const childPath = path.join(cwd, "child.pid");
		const result = await runDurableCommand({
			cwd,
			command: ["bash", "-c", `sleep 30 >/dev/null 2>&1 & echo $! > ${JSON.stringify(childPath)}; exit 0`],
			logPath: path.join(cwd, "command.log"),
			resultPath: path.join(cwd, "result.json"),
			timeoutMs: 30_000,
			shutdownGraceMs: 100,
		});
		assert.equal(result.code, 0);
		const childPid = Number((await readFile(childPath, "utf8")).trim());
		assert.throws(() => process.kill(childPid, 0), /ESRCH/);
	} finally { await rm(cwd, { recursive: true, force: true }); }
});

test("durable command cancellation kills descendants and persists cancellation", async () => {
	const cwd = await mkdtemp(path.join(tmpdir(), "worker-command-cancel-"));
	try {
		const controller = new AbortController();
		const resultPath = path.join(cwd, "result.json");
		const running = runDurableCommand({ cwd, command: ["bash", "-c", "sleep 30 & wait"], logPath: path.join(cwd, "command.log"), resultPath, timeoutMs: 30_000, shutdownGraceMs: 100, signal: controller.signal });
		setTimeout(() => controller.abort(), 50);
		const result = await running;
		assert.equal(result.cancelled, true);
		assert.equal(JSON.parse(await readFile(resultPath, "utf8")).cancelled, true);
	} finally { await rm(cwd, { recursive: true, force: true }); }
});

test("worker model references require provider-qualified model IDs", () => {
	assert.deepEqual(parseWorkerModelRef(LUNA_WORKER_MODEL), { provider: "openai-codex", id: "gpt-5.6-luna" });
	assert.equal(parseWorkerModelRef("gpt-5.6-luna"), undefined);
	assert.equal(parseWorkerModelRef("openai-codex/"), undefined);
});
