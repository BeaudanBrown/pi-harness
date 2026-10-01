import assert from "node:assert/strict";
import test from "node:test";
import { ConversationIdSchema, WorkspaceIdentitySchema } from "../config/agent/extensions/managed-sessions/contracts.js";
import * as identities from "../config/agent/extensions/managed-sessions/identity-contracts.js";
import { parseHostRunWitness, type HostRunWitness } from "../config/agent/extensions/managed-sessions/host-run-contracts.js";
import { hostActionPolicy } from "../config/agent/extensions/managed-sessions/live-workspace-contracts.js";
import { resolveHostRunActor, type AcceptedHostInputOrigin } from "../config/agent/extensions/managed-sessions/relay/host-run-origin.js";

const conversationId = `conv_${"a".repeat(32)}`; const generationId = `generation_${"a".repeat(32)}`;
const deliveryId = `delivery_${"a".repeat(32)}`; const secondDelivery = `delivery_${"b".repeat(32)}`;
const witness: HostRunWitness = { generationId, runId: "run-1", phase: "active", sources: [{ kind: "local" }], toolCallIds: ["tool-1"] };
const base = { conversationId, generationId, runId: "run-1", toolCallId: "tool-1", requestId: "request-1", roomId: "!room:example.com" };
const origin: AcceptedHostInputOrigin = { deliveryId, roomId: base.roomId, eventId: "$input", senderUserId: "@participant:example.com", status: "persisted" };

function resolve(observation: unknown = witness, input: AcceptedHostInputOrigin | undefined = origin) {
	return resolveHostRunActor({ ...base, witness: observation, acceptedInput: () => input });
}

test("shared identity leaves preserve old contract exports without host/adapter import cycles", () => {
	assert.equal(ConversationIdSchema, identities.ConversationIdSchema);
	assert.equal(WorkspaceIdentitySchema, identities.WorkspaceIdentitySchema);
});

test("fresh local and Matrix witnesses select presentation but never confer human authority", () => {
	const local = resolve(); assert.equal(local.presentation, "local_dialog"); assert.equal(local.kind, "model");
	const matrix = resolve({ ...witness, sources: [{ kind: "matrix", deliveryId }] });
	assert.equal(matrix.presentation, "matrix_poll"); assert.ok(matrix.presentation === "matrix_poll");
	assert.deepEqual(matrix.origin, { roomId: origin.roomId, eventId: origin.eventId, senderUserId: origin.senderUserId });
	for (const actor of [local, matrix]) assert.equal(hostActionPolicy({ operation: "conversation.stop", conversationId }, actor, `conv_${"b".repeat(32)}`), "approval");
	const parsed = parseHostRunWitness(witness); parsed.toolCallIds.length = 0; assert.equal(witness.toolCallIds.length, 1);
});

test("mixed Matrix participants remain model proposals; local/Matrix mixtures and absent origins fail closed", () => {
	const actor = resolveHostRunActor({ ...base, witness: { ...witness, sources: [{ kind: "matrix", deliveryId }, { kind: "matrix", deliveryId: secondDelivery }] },
		acceptedInput: (id) => id === deliveryId ? origin : { ...origin, deliveryId: secondDelivery, eventId: "$later", senderUserId: "@operator:example.com" } });
	assert.ok(actor.presentation === "matrix_poll"); assert.equal(actor.origin.senderUserId, "@participant:example.com");
	assert.equal(hostActionPolicy({ operation: "conversation.stop", conversationId }, actor, `conv_${"b".repeat(32)}`), "approval");
	for (const sources of [[], [{ kind: "local" }, { kind: "matrix", deliveryId }]]) assert.throws(() => resolve({ ...witness, sources }), { code: "forbidden" });
});

test("stale generation/run/tool and ended runs cannot request or revive approval", () => {
	for (const changed of [
		{ ...witness, generationId: `generation_${"b".repeat(32)}` }, { ...witness, runId: "other-run" },
		{ ...witness, toolCallIds: [] }, { ...witness, phase: "ended", toolCallIds: [] },
	]) assert.throws(() => resolve(changed), { code: "cancelled" });
});

test("witnesses cannot supply sender/room fields or invent an accepted delivery", () => {
	const matrix = { ...witness, sources: [{ kind: "matrix", deliveryId }] };
	for (const input of [undefined, { ...origin, roomId: "!unrelated:example.com" }, { ...origin, senderUserId: undefined },
		{ ...origin, status: "completed" as const }, { ...origin, deliveryId: secondDelivery }])
		assert.throws(() => resolveHostRunActor({ ...base, witness: matrix, acceptedInput: () => input }), { code: "forbidden" });
	for (const changed of [
		{ ...matrix, senderUserId: "@operator:example.com" }, { ...matrix, sources: [{ kind: "matrix", deliveryId, roomId: base.roomId }] },
		{ ...witness, phase: "ended" }, { ...witness, toolCallIds: ["tool-1", "tool-1"] },
	]) assert.throws(() => resolve(changed), { code: "forbidden" });
});
