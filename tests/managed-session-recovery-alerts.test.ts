import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RecoveryAlerts, type RecoveryAlert } from "../config/agent/extensions/managed-sessions/relay/recovery-alerts.js";
import { RecoveryMonitor } from "../config/agent/extensions/managed-sessions/relay/recovery-monitor.js";
import { deriveTranscriptEntryId, MANAGED_SESSION_STATE_VERSION } from "../config/agent/extensions/managed-sessions/contracts.js";
import { CHECKPOINT_ENTRY_TYPE, unansweredCheckpoint, type SessionBinding } from "../config/agent/extensions/managed-sessions/adapter/state.js";

const target = { conversationId: `conv_${"a".repeat(32)}`, piSessionId: "session", roomId: "!room:test" };
const checkpointId = `checkpoint-${"b".repeat(32)}`;

test("recovery selection survives lost acknowledgement, later epochs, and obsolete liveness", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "managed-recovery-")); t.after(() => rm(root, { recursive: true, force: true }));
	const path = join(root, "alerts.json"); const sent: RecoveryAlert[] = [];
	const first = new RecoveryAlerts(path, async (alert) => { sent.push(alert); throw Error("accepted then lost acknowledgement"); });
	await first.load(); await first.outage([target]); await first.outage([target]);
	assert.deepEqual(first.pending(), [], "no checks during outage");
	await first.healthy(); const ticket = first.pending()[0]!;
	assert.equal(ticket.epoch, 1, "repeated failures share epoch");
	await first.confirm(ticket, checkpointId, () => false); assert.equal(first.pending().length, 1, "expired or obsolete evidence cannot select an alert");
	await Promise.all([first.confirm(ticket, checkpointId, () => true), first.confirm(ticket, "other-checkpoint", () => true)]);
	await assert.rejects(() => first.drain(), /retained/); await first.close();
	const saved = JSON.parse(await readFile(path, "utf8")); assert.equal(saved.alerts.length, 1);
	const second = new RecoveryAlerts(path, async (alert) => { sent.push(alert); }); await second.load();
	await second.outage([target]); await second.healthy();
	await second.confirm(second.pending()[0]!, checkpointId, () => true);
	await second.drain(); await second.drain(); await second.close();
	assert.equal(sent.length, 2); assert.deepEqual(sent[0], sent[1], "uncertain accepted payload is never reclassified or duplicated in the next epoch");
});

test("fresh original checkpoint coalesces recovery and one failed room does not block another", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "managed-recovery-rooms-")); t.after(() => rm(root, { recursive: true, force: true }));
	const sent: string[] = [];
	const alerts = new RecoveryAlerts(join(root, "alerts.json"), async (alert) => {
		if (alert.ticket.target.conversationId === "blocked") throw Error("429");
		sent.push(alert.ticket.target.conversationId);
	});
	await alerts.load(); await alerts.outage([target, { ...target, conversationId: "blocked" }, { ...target, conversationId: "healthy" }]);
	await alerts.originalAccepted(target.conversationId, target.piSessionId); await alerts.healthy();
	assert.equal(alerts.pending().length, 2);
	for (const ticket of alerts.pending()) await alerts.confirm(ticket, checkpointId, () => true);
	await assert.rejects(() => alerts.drain(), /retained/); assert.deepEqual(sent, ["healthy"]); await alerts.close();
});

test("only original checkpoint position on the current branch proves an unanswered boundary", () => {
	const binding: SessionBinding = { version: MANAGED_SESSION_STATE_VERSION, conversationId: target.conversationId,
		sessionId: target.piSessionId, concept: "test", role: "ordinary_adapter", bindingBoundaryEntryId: deriveTranscriptEntryId("session", "boundary") };
	const offered = { type: "custom", id: "offer", customType: CHECKPOINT_ENTRY_TYPE,
		data: { version: MANAGED_SESSION_STATE_VERSION, checkpointId, originDeliveryId: `delivery_${"c".repeat(32)}`, checkpoint: { kind: "question", decision: "Continue?" }, status: "offered" } };
	const projected = { ...offered, id: "ack", data: { ...offered.data, status: "projected" } };
	const user = { type: "message", id: "reply", message: { role: "user", content: "Continue" } };
	assert.equal(unansweredCheckpoint([{ id: "boundary" }, offered, projected], binding), checkpointId);
	assert.equal(unansweredCheckpoint([{ id: "boundary" }, offered, user, projected], binding), null, "late ack does not reopen a locally answered question");
	assert.equal(unansweredCheckpoint([offered, projected, { id: "boundary" }], binding), null, "history before binding is excluded");
	assert.equal(unansweredCheckpoint([{ id: "boundary" }, offered], binding), null, "unpublished checkpoint is not a recovery alert");
	assert.equal(unansweredCheckpoint([{ id: "boundary" }, offered, { ...projected, data: { ...projected.data, status: "abandoned" } }], binding), null);
});

test("monitor requires a fresh exact-attachment reply after backlog; never wakes a dormant adapter", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "managed-recovery-probes-")); t.after(() => rm(root, { recursive: true, force: true }));
	const sent: RecoveryAlert[] = []; let attached = false; let backlog = false; let attachmentId = "first"; let ready = true; let reported: string | null = checkpointId; let probes = 0; let replaceAttachment = false;
	const alerts = new RecoveryAlerts(join(root, "alerts.json"), async (alert) => { sent.push(alert); }); await alerts.load();
	const registry = {
		listManifests: () => [target], manifestByConversationId: () => target,
		snapshot: () => ({ conversations: [{ conversationId: target.conversationId, attachment: attached ? { attachmentId } : null,
			projection: [{ entryId: deriveTranscriptEntryId(target.piSessionId, `checkpoint:${checkpointId}`), kind: "checkpoint", status: "projected", originDeliveryId: "origin" }] }] }),
		pendingInputs: () => [{ deliveryId: "origin", status: "completed" }],
	};
	const server = {
		supports: () => attached,
		sendToConversation: (envelope: { payload: { requestId?: unknown } }) => {
			probes++;
			const replyingAttachment = attachmentId;
			queueMicrotask(() => {
				if (replaceAttachment) attachmentId = "replacement";
				monitor.confirm({ payload: { requestId: envelope.payload.requestId, ready, checkpointId: reported } } as any,
					{ conversationId: target.conversationId, attachmentId: replyingAttachment, role: "ordinary_adapter", state: "active", generation: 1 });
			});
			return true;
		},
	};
	let approvalLive = false; let revokeApproval = false; let approvalChecks = 0;
	const monitor = new RecoveryMonitor(alerts, registry as any, server as any, () => backlog, () => {}, 20, async () => {
		approvalChecks++; if (!approvalLive) return undefined;
		if (revokeApproval) approvalLive = false;
		return { id: `approval_${"b".repeat(32)}`, stillCurrent: () => approvalLive };
	});
	await monitor.health(false); await monitor.health(true); await monitor.tick();
	assert.equal(probes, 0); assert.equal(approvalChecks, 0); assert.equal(alerts.pending().length, 1, "dormant check waits without a wake");
	attached = true; backlog = true; await monitor.tick(); assert.equal(probes, 0);
	backlog = false; ready = false; await monitor.tick(); assert.equal(sent.length, 0); assert.equal(alerts.pending().length, 1);
	ready = true; replaceAttachment = true; await monitor.tick(); assert.equal(sent.length, 0, "a disconnected attachment cannot attest for its replacement");
	replaceAttachment = false; await monitor.tick(); await monitor.tick(); assert.equal(sent.length, 1);
	await monitor.health(false); await monitor.health(true); reported = null; await monitor.tick();
	assert.equal(sent.length, 1, "resolved checkpoint does not notify on later outage");
	await monitor.health(false); await monitor.health(true); approvalLive = true; revokeApproval = true;
	await monitor.tick(); assert.equal(sent.length, 1, "expired or cancelled approval cannot admit a recovery alert");
	assert.equal(alerts.pending().length, 1);
	approvalLive = true; revokeApproval = false; await monitor.tick(); await monitor.tick();
	assert.equal(sent.length, 2); assert.equal(sent[1].attentionId, `approval_${"b".repeat(32)}`);
	await monitor.health(false); await monitor.health(true); await alerts.originalAccepted(target.conversationId, target.piSessionId);
	await monitor.tick(); assert.equal(sent.length, 2, "new notifying poll already occupies the recovery slot");
	await monitor.close();
});
