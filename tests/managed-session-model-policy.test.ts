import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	MANAGED_LOCAL_MODEL_TOOLS_ENV,
	parseManagedLocalModelTools,
	registerManagedModelToolPolicy,
} from "../config/agent/extensions/managed-sessions/adapter/model-tool-policy.js";

const localTools = ["read", "bash", "edit", "write", "grep", "find", "ls"];
type Handler = (event: any, ctx: ExtensionContext) => any;

function modelContext(provider: string): ExtensionContext {
	return { model: { provider, id: "probe" } } as unknown as ExtensionContext;
}

function policyHarness(initialTools: string[]) {
	let active = [...initialTools];
	const handlers = new Map<string, Handler[]>();
	const pi = {
		getActiveTools: () => [...active],
		setActiveTools: (tools: string[]) => { active = [...tools]; },
		on: (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
	} as unknown as ExtensionAPI;
	registerManagedModelToolPolicy(pi, localTools);
	return {
		active: () => [...active],
		setActive: (tools: string[]) => { active = [...tools]; },
		emit: async (event: string, payload: any, provider: string) => {
			let result: unknown;
			for (const handler of handlers.get(event) ?? []) result = await handler(payload, modelContext(provider));
			return result;
		},
	};
}

test("managed local-model tool configuration is strict and bounded", () => {
	assert.deepEqual(parseManagedLocalModelTools(JSON.stringify(localTools)), localTools);
	for (const value of [undefined, "", "{}", "[]", '["read","read"]', '["Read"]', "not-json"]) {
		assert.throws(() => parseManagedLocalModelTools(value), new RegExp(MANAGED_LOCAL_MODEL_TOOLS_ENV));
	}
	assert.throws(() => parseManagedLocalModelTools(JSON.stringify(Array.from({ length: 65 }, (_, index) => `tool_${index}`))), /1-64/);
});

test("cloud startup is unchanged and local startup intersects the active tool set", async () => {
	const cloud = policyHarness(["read", "web_search", "remote_checkpoint"]);
	await cloud.emit("session_start", {}, "openai");
	assert.deepEqual(cloud.active(), ["read", "web_search", "remote_checkpoint"]);

	const local = policyHarness(["read", "web_search", "edit", "remote_checkpoint", "remote_artifact_export"]);
	await local.emit("session_start", {}, "local-llm");
	assert.deepEqual(local.active(), ["read", "edit", "remote_checkpoint", "remote_artifact_export"]);
});

test("model transitions preserve one normal snapshot and current transport state", async () => {
	const harness = policyHarness(["read", "edit", "web_search", "github_issue_mutate", "remote_checkpoint", "remote_artifact_export"]);
	await harness.emit("model_select", { model: { provider: "local-llm" } }, "local-llm");
	assert.deepEqual(harness.active(), ["read", "edit", "remote_checkpoint", "remote_artifact_export"]);

	// A second local selection reapplies policy without replacing the original snapshot.
	harness.setActive(["read", "web_search", "remote_checkpoint", "remote_artifact_export"]);
	await harness.emit("model_select", { model: { provider: "local-llm" } }, "local-llm");
	assert.deepEqual(harness.active(), ["read", "remote_checkpoint", "remote_artifact_export"]);

	// A relay disconnect while restricted must not restore stale transport tools.
	harness.setActive(["read"]);
	await harness.emit("model_select", { model: { provider: "openai" } }, "openai");
	assert.deepEqual(harness.active(), ["read", "edit", "web_search", "github_issue_mutate"]);
});

test("relay transport enabled during local mode remains enabled after restoration", async () => {
	const harness = policyHarness(["read", "web_search"]);
	await harness.emit("model_select", { model: { provider: "local-llm" } }, "local-llm");
	harness.setActive(["read", "remote_checkpoint", "remote_artifact_export"]);
	await harness.emit("model_select", { model: { provider: "anthropic" } }, "anthropic");
	assert.deepEqual(harness.active(), ["read", "web_search", "remote_checkpoint", "remote_artifact_export"]);
});

test("session changes restore process-global tools before applying the new model policy", async () => {
	const harness = policyHarness(["read", "web_search", "remote_checkpoint"]);
	await harness.emit("session_start", {}, "local-llm");
	assert.deepEqual(harness.active(), ["read", "remote_checkpoint"]);
	await harness.emit("session_start", {}, "openai");
	assert.deepEqual(harness.active(), ["read", "web_search", "remote_checkpoint"]);
});

test("tool-call enforcement uses the current model and blocks every model-delegation capability", async () => {
	const delegated = ["run_worker", "review_agents", "aloop_launch_worker", "aloop_apply_patch"];
	const harness = policyHarness(["read", "web_search", ...delegated, "remote_checkpoint"]);
	await harness.emit("session_start", {}, "local-llm");
	assert.deepEqual(harness.active(), ["read", "remote_checkpoint"], "delegation tools are absent from the local-model tool surface");
	assert.equal(await harness.emit("tool_call", { toolName: "read" }, "local-llm"), undefined);
	assert.equal(await harness.emit("tool_call", { toolName: "remote_checkpoint" }, "local-llm"), undefined);
	for (const toolName of ["web_search", ...delegated]) {
		assert.deepEqual(await harness.emit("tool_call", { toolName }, "local-llm"), {
			block: true,
			terminate: true,
			reason: `Tool ${toolName} is unavailable while using local-llm.`,
		});
	}
	harness.setActive(["read"]);
	assert.deepEqual(await harness.emit("tool_call", { toolName: "remote_checkpoint" }, "local-llm"), {
		block: true,
		terminate: true,
		reason: "Tool remote_checkpoint is unavailable while using local-llm.",
	});
	assert.equal(await harness.emit("tool_call", { toolName: "web_search" }, "openai"), undefined);
});
