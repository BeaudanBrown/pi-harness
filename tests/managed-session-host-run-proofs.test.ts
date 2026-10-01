import assert from "node:assert/strict";
import test from "node:test";
import { HostRunProofs } from "../config/agent/extensions/managed-sessions/relay/host-run-proofs.js";
import type { AcceptedAttachment } from "../config/agent/extensions/managed-sessions/relay/registry.js";
import type { ManagedSessionEnvelope } from "../config/agent/extensions/managed-sessions/contracts.js";
import { deriveGenerationId } from "../config/agent/extensions/managed-sessions/v2-contracts.js";

const attachment: AcceptedAttachment = { attachmentId: "attachment-1", conversationId: `conv_${"a".repeat(32)}`, role: "ordinary_adapter", state: "active", generation: 1 };
function reply(message: ManagedSessionEnvelope): ManagedSessionEnvelope {
	return { ...message, role: "ordinary_adapter", type: "host.run.confirm", payload: { checkId: message.payload.checkId,
		witness: { generationId: deriveGenerationId(attachment.conversationId, 1), runId: "run-1", phase: "active", sources: [{ kind: "local" }], toolCallIds: ["tool-1"] } } };
}

test("each run proof requires a fresh challenge on the same still-current attachment", async () => {
	const sent: ManagedSessionEnvelope[] = []; let current = attachment;
	const proofs = new HostRunProofs({ attachment: () => current, capable: () => true, send: (message) => { sent.push(message); return true; } });
	try {
		const first = proofs.request(attachment.conversationId); const answer = reply(sent[0]);
		assert.equal(proofs.confirm({ ...answer, payload: { ...answer.payload, checkId: "unsolicited" } }, attachment), false);
		assert.equal(proofs.confirm(answer, { ...attachment, attachmentId: "foreign" }), false);
		assert.equal(proofs.confirm(answer, attachment), true); assert.equal((await first)?.runId, "run-1");
		const second = proofs.request(attachment.conversationId); assert.notEqual(sent[0].payload.checkId, sent[1].payload.checkId);
		assert.equal(proofs.confirm(answer, attachment), false);
		current = { ...attachment, attachmentId: "replacement" };
		assert.equal(proofs.confirm(reply(sent[1]), attachment), false);
		proofs.disconnected(attachment); assert.equal(await second, null);
	} finally { proofs.close(); }
});

test("absent, legacy, timed-out and shutdown requesters supply no proof, and wrong generation cannot confirm", async () => {
	const sent: ManagedSessionEnvelope[] = []; let capable = false;
	const proofs = new HostRunProofs({ attachment: () => attachment, capable: () => capable, send: (message) => { sent.push(message); return true; }, timeoutMs: 10 });
	assert.equal(await proofs.request(attachment.conversationId), null); assert.equal(sent.length, 0); capable = true;
	const pending = proofs.request(attachment.conversationId); const answer = reply(sent[0]);
	(answer.payload.witness as Record<string, unknown>).generationId = deriveGenerationId(attachment.conversationId, 2);
	assert.equal(proofs.confirm(answer, attachment), false); assert.equal(await pending, null);
	const closing = proofs.request(attachment.conversationId); proofs.close(); assert.equal(await closing, null);
	assert.equal(await proofs.request(attachment.conversationId), null); assert.equal(proofs.confirm(reply(sent[1]), attachment), false);
});
