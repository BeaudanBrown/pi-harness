import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RelayRegistry } from "../config/agent/extensions/managed-sessions/relay/registry.js";
import { ConversationManifestStore } from "../config/agent/extensions/managed-sessions/relay/manifest-store.js";
import { AtomicJsonFile } from "../config/agent/extensions/managed-sessions/relay/atomic-json.js";
import { QueueActivityGate, queueCancellationSnapshot, QUEUE_CANCELLATION_WARNING } from "../config/agent/extensions/managed-sessions/relay/queue-cancellation.js";
import { TranscriptProjector } from "../config/agent/extensions/managed-sessions/relay/transcript-projector.js";
import { RelayEventProjector } from "../config/agent/extensions/managed-sessions/relay/event-projector.js";
import type { ManagedMatrixClient } from "../config/agent/extensions/managed-sessions/relay/matrix-client.js";
import { ManagedHostMutationOwner } from "../config/agent/extensions/managed-sessions/relay/host-mutation-owner.js";
import { parseHostAction } from "../config/agent/extensions/managed-sessions/live-workspace-contracts.js";
import { deriveConversationId, deriveDeliveryId, deriveTranscriptEntryId, deriveChunkId, deriveMatrixTransactionId, type ConversationManifest } from "../config/agent/extensions/managed-sessions/contracts.js";

import { deriveControlId } from "../config/agent/extensions/managed-sessions/v2-contracts.js";

const operationId = `operation_${"a".repeat(32)}`;
async function fixture(t: { after(fn: () => Promise<void>): void }) {
	const root = await mkdtemp(join(tmpdir(), "queue-cancel-")); t.after(() => rm(root, { recursive: true, force: true }));
	const manifests = new ConversationManifestStore(join(root, "manifests"));
	const id = deriveConversationId("host", "project");
	const manifest: ConversationManifest = { schemaVersion: "1.0.0", ownerHostId: "host", kind: "project", conversationId: id,
		creationKey: "project", concept: "project", piSessionId: "saved-session", roomId: "!room:example.com",
		placement: { rootKey: "projects", workspace: "example", relativeCwd: "" },
		bindingBoundaryEntryId: deriveTranscriptEntryId("saved-session", "boundary"), createdAt: "2026-10-01T00:00:00.000Z" };
	await manifests.write(manifest);
	const runtime = join(root, "runtime"); const registry = new RelayRegistry("host", runtime, manifests); await registry.load();
	const input = { deliveryId: deriveDeliveryId(id, "$input"), matrixEventId: "$input", kind: "prompt", body: "PRIVATE ORIGINAL INPUT", status: "accepted" };
	await registry.recordAcceptedInput(id, input);
	const control = { controlId: deriveControlId(id, "$control"), matrixEventId: "$control", name: "new" as const, argument: "--confirm" };
	await registry.recordPendingControl(id, control);
	const entryId = deriveTranscriptEntryId(manifest.piSessionId, "notice:old");
	await registry.recordProjection(id, { entryId, kind: "notice", status: "projecting", chunks: [0, 1].map(index => ({
		chunkId: deriveChunkId(entryId, index), transactionId: deriveMatrixTransactionId(id, entryId, index), status: index ? "pending" : "sent",
	})) });
	await writeFile(join(root, "saved-session.jsonl"), "saved Pi history\n");
	return { root, runtime, manifests, manifest, registry, id, input, control, entryId };
}

test("abandonment is atomic, audited, preserves prior effects/history and remains terminal after reload", async t => {
	const f = await fixture(t); const before = f.registry.conversationSnapshot(f.id)!;
	const snapshot = f.registry.queueCancellationSnapshot(f.id);
	assert.deepEqual(snapshot.blockers, []); assert.equal(snapshot.items.length, 3);
	assert.ok(!JSON.stringify(snapshot).includes("PRIVATE ORIGINAL INPUT"));
	await f.registry.cancelQueuedWork(snapshot, operationId);
	const replacement = new RelayRegistry("host", f.runtime, f.manifests); await replacement.load();
	for (const registry of [f.registry, replacement]) {
		const after = registry.conversationSnapshot(f.id)!;
		assert.equal(after.pendingInputs[0]!.status, "cancelled"); assert.equal(after.pendingInputs[0]!.body, f.input.body);
		assert.equal(after.projection[0]!.status, "cancelled"); assert.deepEqual(after.projection[0]!.chunks, before.projection[0]!.chunks);
		assert.equal(registry.controlResultState(f.id, f.control.controlId), "cancelled"); assert.deepEqual(registry.pendingControls(f.id), []);
		assert.deepEqual(after.abandonedControls, before.pendingControls); assert.deepEqual(after.completedControlIds, []);
		assert.equal(after.queueCancellations![0]!.operationId, operationId);
		assert.equal(after.queueCancellations![0]!.semantics, "abandon_future_attempts_prior_effects_uncertain");
		await registry.recordAcceptedInput(f.id, f.input); await registry.recordPendingControl(f.id, f.control);
		await registry.acknowledgeControlResult(f.id, f.control.controlId);
		assert.equal(registry.controlResultState(f.id, f.control.controlId), "cancelled");
		await assert.rejects(registry.acknowledgeInput(f.id, f.input.deliveryId, "completed", "entry-original"), /regressed/);
		assert.equal(registry.queueCancellationSnapshot(f.id).items.length, 0);
	}
	assert.equal(await readFile(join(f.root, "saved-session.jsonl"), "utf8"), "saved Pi history\n");
	assert.deepEqual(await f.manifests.list(), [f.manifest]);
});

test("frozen digests cover item identities, status, payload, sent chunks and source binding", async t => {
	const f = await fixture(t); const before = f.registry.queueCancellationSnapshot(f.id);
	for (const change of [
		(row: ReturnType<RelayRegistry["conversationSnapshot"]>) => { row!.pendingInputs[0]!.body = "changed"; },
		(row: ReturnType<RelayRegistry["conversationSnapshot"]>) => { row!.pendingInputs[0]!.status = "delivered"; },
		(row: ReturnType<RelayRegistry["conversationSnapshot"]>) => { row!.pendingControls[0]!.argument = "other"; },
		(row: ReturnType<RelayRegistry["conversationSnapshot"]>) => { row!.projection[0]!.chunks[1]!.status = "sent"; },
		(row: ReturnType<RelayRegistry["conversationSnapshot"]>) => { row!.pendingInputs.pop(); },
	]) {
		const row = f.registry.conversationSnapshot(f.id)!; change(row);
		assert.notEqual(queueCancellationSnapshot(f.manifest, row, false).sourceDigest, before.sourceDigest);
	}
	assert.notEqual(queueCancellationSnapshot({ ...f.manifest, piSessionId: "other-session" }, f.registry.conversationSnapshot(f.id)!, false).sourceDigest, before.sourceDigest);
	const active = f.registry.conversationSnapshot(f.id)!; active.state = "active";
	assert.match(queueCancellationSnapshot(f.manifest, active, false).blockers.join(), /Attached/);
});

test("queued source changes reject the whole operation inside the serialized writer", async t => {
	const f = await fixture(t); const snapshot = f.registry.queueCancellationSnapshot(f.id);
	const next = f.registry.recordAcceptedInput(f.id, { ...f.input, deliveryId: deriveDeliveryId(f.id, "$next"), matrixEventId: "$next" });
	const cancellation = f.registry.cancelQueuedWork(snapshot, operationId);
	await next; await assert.rejects(cancellation, /changed or expired/);
	assert.equal(f.registry.conversationSnapshot(f.id)!.queueCancellations, undefined);
	assert.equal(f.registry.pendingInputs(f.id)[0]!.status, "accepted");
});

test("in-flight producers block; held cancellation prevents new producers and releases on failure", async t => {
	const f = await fixture(t); let release!: () => void;
	const work = f.registry.withQueueEffect(f.id, () => new Promise<void>(resolve => { release = resolve; }));
	assert.match(f.registry.queueCancellationSnapshot(f.id).blockers.join(), /in-flight/);
	await assert.rejects(f.registry.cancelQueuedWork(f.registry.queueCancellationSnapshot(f.id), operationId), /in flight/);
	release(); await work;
	const gate = new QueueActivityGate(); const held = gate.exclusive(f.id, () => new Promise<void>(resolve => { release = resolve; }));
	await assert.rejects(gate.effect(f.id, async () => assert.fail("must not send")), /in progress/);
	release(); await held; await gate.effect(f.id, async () => undefined);
});

test("producer retries and late sent receipts cannot turn abandonment into projected success", async t => {
	const f = await fixture(t); await f.registry.cancelQueuedWork(f.registry.queueCancellationSnapshot(f.id), operationId);
	const matrix = { sendNotice: async () => assert.fail("must not retry Matrix"), sendText: async () => assert.fail("must not retry Matrix") } as unknown as ManagedMatrixClient;
	await new RelayEventProjector(f.registry, matrix).projectNotice(f.id, "old", "old notice");
	await new TranscriptProjector(f.registry, matrix).project({ protocolVersion: "1.0.0", messageId: "retry", role: "ordinary_adapter", conversationId: f.id,
		type: "transcript.offer", payload: { entryId: f.entryId, piSessionId: f.manifest.piSessionId, piEntryKey: "notice:old", kind: "assistant_final", body: "old" } });
	await f.registry.markProjectionChunkSent(f.id, f.entryId, deriveChunkId(f.entryId, 1));
	assert.equal(f.registry.projectionByEntryId(f.id, f.entryId)!.status, "cancelled");
});

test("uncertain commit poisons this owner; reload reads durable abandonment", async t => {
	const f = await fixture(t); const snapshot = f.registry.queueCancellationSnapshot(f.id);
	const write = AtomicJsonFile.prototype.write;
	t.mock.method(AtomicJsonFile.prototype, "write", async function(this: AtomicJsonFile<unknown>, value: unknown) {
		await write.call(this, value);
		if (this.path === join(f.runtime, "registry.json")) throw new Error("lost acknowledgement after durable write");
	});
	await assert.rejects(f.registry.cancelQueuedWork(snapshot, operationId), /lost acknowledgement/);
	assert.throws(() => f.registry.queueCancellationSnapshot(f.id), /uncertain/);
	t.mock.restoreAll();
	const replacement = new RelayRegistry("host", f.runtime, f.manifests); await replacement.load();
	assert.equal(replacement.pendingInputs(f.id)[0]!.status, "cancelled");
});

test("typed previews freeze exact metadata and expire; model execution is not a human shortcut", async t => {
	const f = await fixture(t); let now = Date.now();
	const owner = new ManagedHostMutationOwner({ registry: f.registry, lifecycle: {} as never, retirement: {} as never, server: { attachment: () => undefined }, now: () => now });
	const action = parseHostAction({ operation: "conversation.queue.cancel.preview", conversationId: f.id });
	assert.equal(action.operation, "conversation.queue.cancel.preview");
	const preview = await owner.preview(action as Extract<typeof action, { operation: "conversation.queue.cancel.preview" }>);
	assert.deepEqual(preview.blockers, []); assert.ok(preview.warnings!.includes(QUEUE_CANCELLATION_WARNING));
	assert.ok(preview.warnings!.join().includes(f.control.controlId)); assert.ok(!JSON.stringify(preview).includes(f.input.body));
	const apply = parseHostAction({ operation: "conversation.queue.cancel.apply", previewId: preview.previewId, confirmed: true });
	const frozen = await owner.freeze({ action: apply }); assert.ok(frozen.preconditions.preview);
	now += 60 * 60 * 1000; await assert.rejects(owner.freeze({ action: apply }), /expired/);
});

test("persisted input abandonment retains its saved-entry identity", async t => {
	const f = await fixture(t);
	await f.registry.acknowledgeInput(f.id, f.input.deliveryId, "persisted", deriveTranscriptEntryId(f.manifest.piSessionId, "persisted"));
	const before = f.registry.pendingInputs(f.id)[0]!;
	await f.registry.cancelQueuedWork(f.registry.queueCancellationSnapshot(f.id), operationId);
	assert.deepEqual(f.registry.pendingInputs(f.id)[0], { ...before, status: "cancelled" });
	assert.equal(f.registry.conversationSnapshot(f.id)!.queueCancellations![0]!.items.find(i => i.kind === "input")!.priorState, "persisted");
});

test("actual Matrix publication holds a producer lease through sent-receipt persistence", async t => {
	const f = await fixture(t); let release!: () => void; let started!: () => void;
	const begun = new Promise<void>(resolve => { started = resolve; });
	const matrix = { sendText: async () => { started(); await new Promise<void>(resolve => { release = resolve; }); } } as unknown as ManagedMatrixClient;
	const publication = new RelayEventProjector(f.registry, matrix).projectNotice(f.id, "working", "body");
	await begun;
	await assert.rejects(f.registry.cancelQueuedWork(f.registry.queueCancellationSnapshot(f.id), operationId), /in flight/);
	release(); await publication;
	assert.deepEqual(f.registry.queueCancellationSnapshot(f.id).blockers, []);
});

test("new items behind successful admission survive without expanding consent", async t => {
	const f = await fixture(t); const cancellation = f.registry.cancelQueuedWork(f.registry.queueCancellationSnapshot(f.id), operationId);
	const next = { ...f.input, deliveryId: deriveDeliveryId(f.id, "$new-after"), matrixEventId: "$new-after" };
	const incoming = f.registry.recordAcceptedInput(f.id, next);
	await cancellation; await incoming;
	assert.equal(f.registry.pendingInputs(f.id).find(i => i.deliveryId === next.deliveryId)!.status, "accepted");
	assert.equal(f.registry.conversationSnapshot(f.id)!.queueCancellations![0]!.items.some(i => i.id === next.deliveryId), false);
});

test("approval execution changes only frozen queues; model human-execution is rejected", async t => {
	const f = await fixture(t);
	const owner = new ManagedHostMutationOwner({ registry: f.registry, lifecycle: {} as never, retirement: {} as never, server: { attachment: () => undefined } });
	const preview = await owner.preview({ operation: "conversation.queue.cancel.preview", conversationId: f.id });
	const request = { version: "1.0.0" as const, requestId: "cancel", action: { operation: "conversation.queue.cancel.apply" as const, previewId: preview.previewId, confirmed: true as const }, actor: { kind: "model" as const, conversationId: f.id } };
	await assert.rejects(owner.executeHuman(request as never), /independent consent/);
	const frozen = await owner.freeze({ action: request.action });
	const result = await owner.execute({ request, frozen, approvalId: `approval_${"b".repeat(32)}` } as never);
	assert.deepEqual(result, { operationId: `operation_${"b".repeat(32)}`, cleanupState: "complete" });
	assert.equal(f.registry.pendingInputs(f.id)[0]!.status, "cancelled");
});
