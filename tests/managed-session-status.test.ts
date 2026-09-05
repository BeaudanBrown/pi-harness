import assert from "node:assert/strict";
import test from "node:test";
import type { ConversationManifest, HostRuntimeState } from "../config/agent/extensions/managed-sessions/contracts.js";
import { renderManagedConversationStatus } from "../config/agent/extensions/managed-sessions/relay/status.js";

const manifest = {
	kind: "project", concept: "Tara tools", projectDisplayName: "tara-tools", checkoutDisplayName: "tara-tools",
	selectedModel: "local-llm/qwen", selectedThinking: "high", activeGenerationId: "generation_active",
	generations: [{ generationId: "generation_old", ordinal: 1 }, { generationId: "generation_active", ordinal: 2, model: "local-llm/qwen", thinking: "high" }],
} as unknown as ConversationManifest;

function runtime(overrides: Partial<HostRuntimeState["conversations"][number]> = {}): HostRuntimeState["conversations"][number] {
	return {
		state: "active", attachment: { attachmentId: "a", sessionId: "s", connectedAt: "now" }, pendingInputs: [], pendingControls: [],
		activeCheckpointPoll: null, publishingCheckpointPoll: null, ...overrides,
	} as unknown as HostRuntimeState["conversations"][number];
}

test("managed status combines relay authority with live adapter state", () => {
	const result = renderManagedConversationStatus(manifest, runtime({ pendingInputs: [
		{ deliveryId: "one", matrixEventId: "$one", kind: "prompt", status: "accepted" },
		{ deliveryId: "two", matrixEventId: "$two", kind: "prompt", status: "completed" },
	], pendingControls: [{ controlId: "current", matrixEventId: "$status", name: "status" }] }),
	{ state: "idle", model: "local-llm/qwen", thinking: "high", context: { usedTokens: 1200, limitTokens: 32768 } }, 3, "current");
	assert.match(result, /Conversation: Tara tools \(project\)/);
	assert.match(result, /Generation: 2\/2/);
	assert.match(result, /Model match: yes/);
	assert.match(result, /Queues: 1 input; 0 control/);
	assert.match(result, /Project reconciliation pending: 3/);
	assert.doesNotMatch(result, /roomId|workspacePath|matrixEventId/);
});

test("managed status makes requested/runtime model disagreement visible", () => {
	const result = renderManagedConversationStatus(manifest, runtime(), { state: "idle", model: "openai/default", thinking: "medium" }, 0);
	assert.match(result, /Model match: NO — runtime differs from requested model/);
});
