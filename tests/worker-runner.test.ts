import assert from "node:assert/strict";
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

test("worker model references require provider-qualified model IDs", () => {
	assert.deepEqual(parseWorkerModelRef(LUNA_WORKER_MODEL), { provider: "openai-codex", id: "gpt-5.6-luna" });
	assert.equal(parseWorkerModelRef("gpt-5.6-luna"), undefined);
	assert.equal(parseWorkerModelRef("openai-codex/"), undefined);
});
