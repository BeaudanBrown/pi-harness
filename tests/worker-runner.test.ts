import assert from "node:assert/strict";
import test from "node:test";
import {
	DEFAULT_WORKER_MODEL,
	isWorkerMode,
	LUNA_WORKER_MODEL,
	parseWorkerModelRef,
	workerModelCandidates,
	workerModelForMode,
} from "../config/agent/extensions/worker-runner/core.js";

test("worker modes target Spark by default and Luna explicitly", () => {
	assert.equal(workerModelForMode("spark"), "openai-codex/gpt-5.3-codex-spark");
	assert.equal(workerModelForMode("luna"), "openai-codex/gpt-5.6-luna");
	assert.equal(DEFAULT_WORKER_MODEL, "openai-codex/gpt-5.3-codex-spark");
	assert.equal(LUNA_WORKER_MODEL, "openai-codex/gpt-5.6-luna");
	assert.equal(isWorkerMode("spark"), true);
	assert.equal(isWorkerMode("luna"), true);
	assert.equal(isWorkerMode("other"), false);
});

test("Spark preserves the parent-model fallback but Luna never silently falls back", () => {
	assert.deepEqual(workerModelCandidates({ mode: "spark", parentModel: "openai-codex/gpt-5.5" }), [
		DEFAULT_WORKER_MODEL,
		"openai-codex/gpt-5.5",
	]);
	assert.deepEqual(workerModelCandidates({ mode: "luna", parentModel: "openai-codex/gpt-5.3-codex-spark" }), [LUNA_WORKER_MODEL]);
});

test("the explicit environment override has priority", () => {
	assert.deepEqual(
		workerModelCandidates({
			mode: "luna",
			environmentOverride: " litellm/sub-gpt-5.5 ",
			parentModel: "openai-codex/gpt-5.5",
		}),
		["litellm/sub-gpt-5.5"],
	);
});

test("worker model references require provider-qualified model IDs", () => {
	assert.deepEqual(parseWorkerModelRef(LUNA_WORKER_MODEL), { provider: "openai-codex", id: "gpt-5.6-luna" });
	assert.equal(parseWorkerModelRef("gpt-5.6-luna"), undefined);
	assert.equal(parseWorkerModelRef("openai-codex/"), undefined);
});
