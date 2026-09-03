import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
	DEFAULT_ALOOP_COMMAND_TIMEOUT_MS,
	parseAloopVerificationPolicy,
	snapshotAloopPolicy,
} from "../config/agent/extensions/aloop/policy.js";

const canonicalOnly = JSON.stringify({ canonicalCommand: { argv: ["nix", "run", ".#verify"] } });

test("aloop policy requires only canonical argv and applies the command timeout default", () => {
	const policy = parseAloopVerificationPolicy(canonicalOnly);
	assert.deepEqual(policy.canonicalCommand, { argv: ["nix", "run", ".#verify"], timeoutMs: DEFAULT_ALOOP_COMMAND_TIMEOUT_MS });
	assert.equal(policy.workerFeedbackCommand, undefined);
	assert.equal(policy.productionIntegration, undefined);
	assert.deepEqual(policy.workerResources, { extensions: [], tools: [] });
});

test("aloop policy models advisory feedback and phase-aware production integration", () => {
	const policy = parseAloopVerificationPolicy(JSON.stringify({
		canonicalCommand: { argv: ["make", "verify"], timeoutMs: 1234 },
		workerFeedbackCommand: { argv: ["make", "test-fast"] },
		productionIntegration: { frequency: "epic", command: { argv: ["make", "production"], timeoutMs: 5678 } },
		workerResources: { extensions: [".pi/worker.ts"], tools: ["project_lookup"] },
		patchWorkerModel: "openai-codex/gpt-5.6-terra",
	}));
	assert.equal(policy.canonicalCommand.timeoutMs, 1234);
	assert.deepEqual(policy.workerFeedbackCommand?.argv, ["make", "test-fast"]);
	assert.equal(policy.productionIntegration?.frequency, "epic");
	assert.equal(policy.productionIntegration?.command.timeoutMs, 5678);
	assert.deepEqual(policy.workerResources.tools, ["project_lookup"]);
	assert.equal(policy.patchWorkerModel, "openai-codex/gpt-5.6-terra");
});

test("this repository's legacy policy is migrated to the argv schema", () => {
	const policy = parseAloopVerificationPolicy(readFileSync(".aloop.json", "utf8"));
	assert.deepEqual(policy.canonicalCommand.argv, ["nix", "run", ".#verify"]);
	assert.equal(policy.productionIntegration?.frequency, "issue");
});

test("legacy shell strings and malformed command definitions fail closed", () => {
	assert.throws(() => parseAloopVerificationPolicy(JSON.stringify({ canonicalCommand: "nix run .#verify" })), /legacy shell-string schema/);
	assert.throws(() => parseAloopVerificationPolicy("{}"), /must declare canonicalCommand/);
	assert.throws(() => parseAloopVerificationPolicy(JSON.stringify({ canonicalCommand: { argv: [] } })), /non-empty string array/);
	assert.throws(() => parseAloopVerificationPolicy(JSON.stringify({ canonicalCommand: { argv: ["true"] }, productionIntegration: { frequency: "sometimes", command: { argv: ["true"] } } })), /frequency/);
	assert.throws(() => parseAloopVerificationPolicy(JSON.stringify({ canonicalCommand: { argv: ["true"], timeoutMs: 0 } })), /timeoutMs/);
	assert.throws(() => parseAloopVerificationPolicy(JSON.stringify({ canonicalCommand: { argv: ["true"] }, patchWorkerModel: " " })), /patchWorkerModel/);
});

test("policy snapshots bind exact committed bytes and startup commit", () => {
	const first = snapshotAloopPolicy(canonicalOnly, "a".repeat(40));
	const repeated = snapshotAloopPolicy(canonicalOnly, "a".repeat(40));
	assert.equal(first.sha256, repeated.sha256);
	assert.equal(first.startCommit, "a".repeat(40));
	assert.notEqual(snapshotAloopPolicy(`${canonicalOnly}\n`, "a".repeat(40)).sha256, first.sha256);
});
