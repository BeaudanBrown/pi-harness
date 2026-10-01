import assert from "node:assert/strict";
import test from "node:test";
import { parseManagedSessionEnvelope } from "../config/agent/extensions/managed-sessions/contracts.js";

const conversationId = `conv_${"a".repeat(32)}`; const generationId = `generation_${"a".repeat(32)}`;
const envelope = { protocolVersion: "1.0.0", messageId: "request-1", conversationId, role: "ordinary_adapter" };
const witness = { generationId, runId: "run-1", phase: "active", sources: [{ kind: "local" }], toolCallIds: ["tool-1"] };
const payload = { requestId: "request-1", generationId, runId: "run-1", toolCallId: "tool-1", action: { operation: "conversation.stop", conversationId } };

test("approval wire carries strict actions and run references, never model-supplied sender or route authority", () => {
	for (const value of [
		{ ...envelope, type: "host.request", payload },
		{ ...envelope, type: "host.run.observe", payload: { witness } },
		{ ...envelope, type: "host.run.confirm", payload: { checkId: "fresh", witness: null } },
		{ ...envelope, type: "host.approval.answer", payload: { approvalId: `approval_${"a".repeat(32)}`, generationId, runId: "run-1", toolCallId: "tool-1", choice: "deny" } },
	]) assert.doesNotThrow(() => parseManagedSessionEnvelope(value));
	for (const changed of [
		{ ...payload, actor: { kind: "human_local" } }, { ...payload, senderUserId: "@operator:example.com" },
		{ ...payload, roomId: "!elsewhere:example.com" }, { ...payload, action: { operation: "worktree.create", creationKey: "key", rootKey: "root", workspace: "../escape", baseRef: "main", branch: "topic" } },
	]) assert.throws(() => parseManagedSessionEnvelope({ ...envelope, type: "host.request", payload: changed }));
	assert.throws(() => parseManagedSessionEnvelope({ ...envelope, type: "host.run.observe", payload: { witness: { ...witness, phase: "ended" } } }));
});

test("nested host results are operation-validated and relay proof/dialog requests cannot be forged as adapter messages", () => {
	const response = { version: "1.0.0", requestId: "request-1", ok: true, data: { conversationId, runtimeState: "stopped" } };
	assert.doesNotThrow(() => parseManagedSessionEnvelope({ ...envelope, role: "relay", type: "host.result", payload: { operation: "conversation.stop", response } }));
	assert.throws(() => parseManagedSessionEnvelope({ ...envelope, role: "relay", type: "host.result", payload: { operation: "host.status", response } }));
	assert.throws(() => parseManagedSessionEnvelope({ ...envelope, role: "relay", type: "host.result", payload: { operation: "invented", response } }));
	assert.throws(() => parseManagedSessionEnvelope({ ...envelope, type: "host.run.check", payload: { checkId: "fresh" } }));
	assert.throws(() => parseManagedSessionEnvelope({ ...envelope, type: "host.approval.show", payload: { approvalId: `approval_${"a".repeat(32)}`, generationId, runId: "run-1", toolCallId: "tool-1", question: "Approve?", expiresAt: 1000 } }));
});
