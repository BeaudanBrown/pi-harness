import assert from "node:assert/strict";
import test from "node:test";
import { APPROVAL_LIFETIME_MS } from "../config/agent/extensions/managed-sessions/live-workspace-contracts.js";
import { hostApprovalId, parseHostApprovalRecord, prepareHostApproval, transitionHostApproval, type ModelHostRequest } from "../config/agent/extensions/managed-sessions/relay/host-approval-record.js";

const request: ModelHostRequest = { version: "1.0.0", actor: { kind: "model", requestId: "request-1", conversationId: `conv_${"a".repeat(32)}`,
	generationId: `generation_${"a".repeat(32)}`, runId: "run-1", toolCallId: "tool-1", presentation: "local_dialog" },
	action: { operation: "conversation.stop", conversationId: `conv_${"b".repeat(32)}` } };
const prepare = () => prepareHostApproval("host", request, { effects: [request.action], preconditions: { generationId: `generation_${"b".repeat(32)}`, instance: "frozen-instance" } }, 1000);

test("approval identity scopes independent calls while freezing request, effects, preconditions and original expiry", () => {
	const record = prepare(); assert.equal(record.phase, "prepared"); assert.equal(record.expiresAt, 1000 + APPROVAL_LIFETIME_MS);
	assert.equal(record.approvalId, "approval_06b4360054b9a83b0cd4d5fa14382c5a");
	assert.equal(hostApprovalId("host", { ...request.actor, requestId: "retry-correlation" }), record.approvalId);
	assert.notEqual(hostApprovalId("host", { ...request.actor, toolCallId: "tool-2" }), record.approvalId);
	assert.notEqual(hostApprovalId("other-host", request.actor), record.approvalId);
	assert.notEqual(hostApprovalId("host", { ...request.actor, runId: "run-2" }), record.approvalId);
	for (const changed of [
		{ ...record, expiresAt: record.expiresAt + 1 }, { ...record, hostId: "other-host" },
		{ ...record, frozen: { ...record.frozen, preconditions: { instance: "new-instance" } } },
		{ ...record, frozen: { ...record.frozen, effects: [] } },
		{ ...record, request: { ...record.request, action: { ...record.request.action, confirmed: true } } },
	]) assert.throws(() => parseHostApprovalRecord(changed));
	const parsed = parseHostApprovalRecord(record); parsed.frozen.preconditions.instance = "caller-change";
	assert.equal(record.frozen.preconditions.instance, "frozen-instance");
});

test("approval phase receipts cannot skip consent, extend lifetime or claim an unaccepted result", () => {
	const prepared = prepare(); const presented = { ...prepared, phase: "presented", presentation: { kind: "local_dialog", id: "dialog-1" } };
	assert.doesNotThrow(() => parseHostApprovalRecord(presented));
	const voter = { kind: "local" as const };
	const approved = { ...presented, phase: "approved", decision: { choice: "approve", at: 2000, voter } };
	const accepted = { ...approved, phase: "accepted", acceptedAt: 3000 };
	assert.doesNotThrow(() => parseHostApprovalRecord(accepted));
	for (const changed of [
		{ ...prepared, phase: "approved" }, { ...approved, decision: { choice: "deny", at: 2000, voter } },
		{ ...approved, decision: { choice: "approve", at: prepared.expiresAt, voter } },
		{ ...accepted, acceptedAt: 1999 }, { ...accepted, acceptedAt: prepared.expiresAt },
		{ ...accepted, phase: "cancelled" }, { ...accepted, phase: "completed" },
		{ ...presented, presentation: { kind: "matrix_poll", id: "$poll" } },
	]) assert.throws(() => parseHostApprovalRecord(changed));
	const failed = { ...accepted, phase: "failed", result: { version: "1.0.0", requestId: "request-1", ok: false,
		error: { code: "failed", message: "Operation failed", retryable: false } } };
	assert.throws(() => parseHostApprovalRecord(failed), "completed outcomes are not durable approval receipts");
	assert.throws(() => parseHostApprovalRecord({ ...failed, result: { ...failed.result, requestId: "other-request" } }));
	assert.doesNotThrow(() => parseHostApprovalRecord({ ...presented, phase: "denied", decision: { choice: "deny", at: 2000, voter } }));
	assert.doesNotThrow(() => parseHostApprovalRecord({ ...prepared, phase: "cancelled" }));
});

test("phase transitions never replace a frozen receipt, skip consent or revoke accepted work", () => {
	const prepared = prepare();
	const presented = transitionHostApproval(prepared, { phase: "presented", presentation: { kind: "local_dialog", id: "dialog-1" } });
	const approved = transitionHostApproval(presented, { phase: "approved", decision: { choice: "approve", at: 2000, voter: { kind: "local" } } });
	assert.throws(() => transitionHostApproval(prepared, { phase: "approved", presentation: presented.presentation, decision: approved.decision }), /phase transition/);
	assert.throws(() => transitionHostApproval(presented, { phase: "approved", presentation: { kind: "local_dialog", id: "other-dialog" }, decision: approved.decision }), /receipt cannot/);
	const accepted = transitionHostApproval(approved, { phase: "accepted", acceptedAt: 3000 });
	assert.deepEqual(transitionHostApproval(accepted, { phase: "accepted", acceptedAt: 3000 }), accepted);
	assert.throws(() => transitionHostApproval(accepted, { phase: "cancelled", acceptedAt: undefined }));
	const denied = transitionHostApproval(presented, { phase: "denied", decision: { choice: "deny", at: 2000, voter: { kind: "local" } } });
	assert.throws(() => transitionHostApproval(denied, { phase: "approved", decision: approved.decision }), /phase transition/);
});

test("Matrix receipt records bind presentation and voter provenance without themselves granting authority", () => {
	const matrixRequest: ModelHostRequest = { ...request, actor: { ...request.actor, presentation: "matrix_poll", origin: { roomId: "!room:example.com", eventId: "$input", senderUserId: "@participant:example.com" } } };
	const prepared = prepareHostApproval("host", matrixRequest, { effects: [request.action], preconditions: {} }, 1000);
	const presented = transitionHostApproval(prepared, { phase: "presented", presentation: { kind: "matrix_poll", id: "$poll" } });
	assert.doesNotThrow(() => transitionHostApproval(presented, { phase: "approved", decision: { choice: "approve", at: 2000,
		voter: { kind: "matrix", userId: "@operator:example.com", eventId: "$vote" } } }));
	assert.throws(() => transitionHostApproval(presented, { phase: "approved", decision: { choice: "approve", at: 2000, voter: { kind: "local" } } }), /voter changed/);
});

test("private owner preconditions remain bounded JSON; reads and forged record fields are rejected", () => {
	const record = prepare();
	for (const preconditions of [null, [], { bad: Infinity }, { bad: undefined }, { bad: new Date() }, { bad: "x".repeat(4097) }, { constructor: "bad" }])
		assert.throws(() => parseHostApprovalRecord({ ...record, frozen: { ...record.frozen, preconditions } }));
	assert.throws(() => prepareHostApproval("host", request, { effects: [request.action], preconditions: Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`field${i}`, "x".repeat(4096)])) }, 0), /frozen input exceeds bounds/);
	assert.throws(() => parseHostApprovalRecord({ ...record, operator: true }));
	assert.throws(() => parseHostApprovalRecord({ ...record, frozen: { ...record.frozen, effects: [{ operation: "host.status" }] } }));
	const cyclic: Record<string, never> = {}; Object.assign(cyclic, { cyclic });
	assert.throws(() => prepareHostApproval("host", request, { effects: [request.action], preconditions: cyclic }, 0), /structural bounds/);
});
