import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile, chmod, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RelayRegistry } from "../config/agent/extensions/managed-sessions/relay/registry.js";
import { prepareRelayStateDirectory } from "../config/agent/extensions/managed-sessions/relay/state-directory.js";
import { ArchiveStore } from "../config/agent/extensions/managed-sessions/relay/archive-store.js";
import { ConversationManifestStore } from "../config/agent/extensions/managed-sessions/relay/manifest-store.js";
import { AtomicJsonFile } from "../config/agent/extensions/managed-sessions/relay/atomic-json.js";
import { deriveCheckpointPollAnswerId, deriveCheckpointPollIntentHash, deriveChunkId, deriveMatrixTransactionId, parseHostRuntimeState, deriveConversationId, deriveDeliveryId, deriveTranscriptEntryId, type ConversationManifest, type ManagedSessionEnvelope } from "../config/agent/extensions/managed-sessions/contracts.js";

const nonce = "abcdefghijklmnopqrstuvwxyzABCDEF";
async function fixture(t: { after(fn: () => Promise<void>): void }) {
	const root = await mkdtemp(join(tmpdir(), "archive-registry-")); t.after(() => rm(root, { recursive: true, force: true }));
	const manifests = new ConversationManifestStore(join(root, "manifests"));
	const make = (key: string): ConversationManifest => ({ schemaVersion: "1.0.0", ownerHostId: "host", kind: "project",
		conversationId: deriveConversationId("host", key), creationKey: key, concept: key, piSessionId: `session-${key}`, roomId: `!${key}:example.com`,
		placement: { rootKey: "projects", workspace: "deleted-worktree", relativeCwd: "" }, projectKey: `project_${"c".repeat(32)}`,
		projectDisplayName: "historical-project", checkoutDisplayName: "deleted-worktree",
		bindingBoundaryEntryId: deriveTranscriptEntryId(`session-${key}`, "boundary"), createdAt: "2026-10-01T00:00:00.000Z" });
	const first = make("first"), sibling = make("sibling"); await manifests.write(first); await manifests.write(sibling);
	const runtime = join(root, "runtime"); const registry = new RelayRegistry("host", runtime, manifests); await registry.load();
	await registry.setAttachmentNonce(first.conversationId, nonce);
	const packet: ManagedSessionEnvelope = { protocolVersion: "1.0.0", role: "ordinary_adapter", type: "attachment.attach", messageId: "attach", conversationId: first.conversationId,
		payload: { sessionId: first.piSessionId, attachmentNonce: nonce, bindingBoundaryEntryId: first.bindingBoundaryEntryId } };
	return { root, manifests, first, sibling, runtime, registry, packet };
}

test("archive fence preserves room/history and sibling but disables attachment, discovery, wake and input across restart", async t => {
	const f = await fixture(t); const id = f.first.conversationId; const before = f.registry.snapshot();
	const savedManifest = await f.manifests.list(); await writeFile(join(f.root, "history.jsonl"), "retained history\n");
	const candidate = f.registry.archiveCandidate(id); assert.deepEqual(candidate.blockers, []);
	const archived = await f.registry.admitArchive(candidate.source);
	assert.equal(archived.phase, "archiving"); assert.equal(archived.source.roomId, f.first.roomId);
	assert.deepEqual(await f.registry.admitArchive(candidate.source), archived, "exact retry retains original admission");
	assert.equal(f.registry.retirement(id), undefined, "archive is not leave/forget retirement");
	for (const registry of [f.registry, await (async () => {
		// Old registry backups must not override independent archive authority.
		await writeFile(join(f.runtime, "registry.json"), JSON.stringify(before));
		const replacement = new RelayRegistry("host", f.runtime, f.manifests); await replacement.load(); return replacement;
	})()]) {
		assert.equal(registry.manifestByConversationId(id), undefined); assert.equal(registry.registeredConversation(id), undefined);
		assert.deepEqual(registry.listConversations().map(c => c.conversationId), [f.sibling.conversationId]);
		assert.deepEqual(registry.listManifests().map(c => c.conversationId), [f.sibling.conversationId]);
		assert.deepEqual(registry.conversationMetadata().map(c => c.conversationId), [f.sibling.conversationId]);
		assert.deepEqual(registry.runtimeObservationSources().map(c => c.conversationId), [f.sibling.conversationId]);
		assert.deepEqual(registry.titleInventory().map(c => c.conversationId), [f.sibling.conversationId]);
		assert.throws(() => registry.manifestByCreationKey(f.first.creationKey), /archived/);
		await assert.rejects(registry.attach(f.packet, "stale"), /archived/);
		await assert.rejects(registry.setAttachmentNonce(id, nonce), /archived/);
		await assert.rejects(registry.beginLaunch(id), /archived/);
		await assert.rejects(registry.createProjectConversation(f.first, nonce), /archived/);
		await assert.rejects(registry.recordAcceptedInput(id, { deliveryId: deriveDeliveryId(id, "$late"), matrixEventId: "$late", kind: "prompt", body: "must not dispatch", status: "accepted" }), /archived/);
		assert.equal(registry.archiveRecords().length, 1);
	}
	assert.deepEqual(await f.manifests.list(), savedManifest); assert.equal(await readFile(join(f.root, "history.jsonl"), "utf8"), "retained history\n");
	const persisted = JSON.parse(await readFile(join(f.runtime, "registry.json"), "utf8"));
	assert.equal(persisted.conversations.find((c: { conversationId: string }) => c.conversationId === id).archiveId, archived.archiveId);
});

test("archive admission rechecks queued work and exact frozen metadata under the serialized writer", async t => {
	const f = await fixture(t); const id = f.first.conversationId; const source = f.registry.archiveCandidate(id).source;
	await assert.rejects(f.registry.admitArchive({ ...source, roomId: "!other:example.com" }), /changed/);
	const input = { deliveryId: deriveDeliveryId(id, "$queued"), matrixEventId: "$queued", kind: "prompt", body: "preserve", status: "accepted" };
	const incoming = f.registry.recordAcceptedInput(id, input); const admission = f.registry.admitArchive(source);
	await incoming; await assert.rejects(admission, /pending work changed/);
	assert.equal(f.registry.archiveRecord(id), undefined); assert.equal(f.registry.conversationSnapshot(id)?.pendingInputs[0]?.body, "preserve");
});

test("input arriving behind archive admission cannot reopen the conversation", async t => {
	const f = await fixture(t); const id = f.first.conversationId;
	const admitted = f.registry.admitArchive(f.registry.archiveCandidate(id).source);
	const input = f.registry.recordAcceptedInput(id, { deliveryId: deriveDeliveryId(id, "$racing"), matrixEventId: "$racing", kind: "prompt", body: "must not dispatch", status: "accepted" });
	await admitted; await assert.rejects(input, /archived/);
	assert.equal(f.registry.snapshot().conversations.find(c => c.conversationId === id)?.pendingInputs.length, 0);
});

test("live attachments and uncertain legacy windows cannot be archived", async t => {
	const f = await fixture(t); const id = f.first.conversationId; const attachment = await f.registry.attach(f.packet, "live");
	assert.match(f.registry.archiveCandidate(id).blockers.join(), /Runtime closure/);
	await assert.rejects(f.registry.admitArchive(f.registry.archiveCandidate(id).source), /pending work changed/);
	await f.registry.detach("live", attachment);
	await f.registry.setManagedWindow(id, { sessionName: "old", windowId: "@1", paneId: "%1" });
	assert.match(f.registry.archiveCandidate(id).blockers.join(), /Runtime closure/);
});

test("archive authority commit survives runtime-write rollback", async t => {
	const f = await fixture(t); const id = f.first.conversationId; const source = f.registry.archiveCandidate(id).source;
	const original = AtomicJsonFile.prototype.write;
	AtomicJsonFile.prototype.write = async function (value: unknown) { if (this.path === join(f.runtime, "registry.json")) throw Error("Injected runtime write failure"); return original.call(this, value); };
	try { await assert.rejects(f.registry.admitArchive(source), /Injected/); } finally { AtomicJsonFile.prototype.write = original; }
	assert.ok(f.registry.archiveRecord(id)); await assert.rejects(f.registry.attach(f.packet, "late"), /archived/);
	const restart = new RelayRegistry("host", f.runtime, f.manifests); await restart.load(); assert.ok(restart.archiveRecord(id));
	assert.equal(restart.manifestByConversationId(id), undefined);
});

test("uncertain archive writes poison authority rather than allowing runtime rollback to reopen dispatch", async t => {
	const f = await fixture(t); const source = f.registry.archiveCandidate(f.first.conversationId).source; const original = AtomicJsonFile.prototype.write;
	AtomicJsonFile.prototype.write = async function (value: unknown) {
		await original.call(this, value); if (this.path === join(f.runtime, "archives.json")) throw Error("Injected post-rename failure");
	};
	try { await assert.rejects(f.registry.admitArchive(source)); } finally { AtomicJsonFile.prototype.write = original; }
	assert.throws(() => f.registry.listConversations(), /Archive authority is unavailable/);
	await assert.rejects(f.registry.attach(f.packet, "late"), /Archive authority is unavailable/);
	const restart = new RelayRegistry("host", f.runtime, f.manifests); await restart.load(); assert.ok(restart.archiveRecord(f.first.conversationId));
});

for (const fault of ["missing", "missing-with-old-runtime", "corrupt", "foreign-host", "permissions", "symlink", "changed-source"] as const) test(`archive authority fails closed for ${fault}`, async t => {
	const f = await fixture(t); const before = f.registry.snapshot(); await f.registry.admitArchive(f.registry.archiveCandidate(f.first.conversationId).source);
	const file = join(f.runtime, "archives.json"); const bytes = await readFile(file, "utf8");
	if (fault === "missing" || fault === "missing-with-old-runtime") await rm(file);
	if (fault === "missing-with-old-runtime") await writeFile(join(f.runtime, "registry.json"), JSON.stringify(before));
	if (fault === "corrupt") await writeFile(file, "{");
	if (fault === "foreign-host") { const data = JSON.parse(bytes); data.hostId = "foreign"; await writeFile(file, JSON.stringify(data)); }
	if (fault === "permissions") await chmod(file, 0o644);
	if (fault === "symlink") { await rm(file); await writeFile(join(f.root, "copy.json"), bytes, { mode: 0o600 }); await symlink(join(f.root, "copy.json"), file); }
	if (fault === "changed-source") { const data = JSON.parse(bytes); data.records[0].source.roomId = "!different:example.com"; await writeFile(file, JSON.stringify(data)); }
	await assert.rejects(new RelayRegistry("host", f.runtime, f.manifests).load());
});

for (const poll of ["control", "checkpoint", "closing"] as const) test(`restored active runtime cannot dispatch archived ${poll} publication`, async t => {
	const f = await fixture(t); const id = f.first.conversationId;
	const attachment = await f.registry.attach(f.packet, "live"); const old = f.registry.snapshot();
	await f.registry.detach("live", attachment); await f.registry.admitArchive(f.registry.archiveCandidate(id).source);
	const row = old.conversations.find(c => c.conversationId === id)!;
	if (poll === "control") {
		const sourceControl = { controlId: `control_${"b".repeat(32)}`, matrixEventId: "$control", name: "thinking" as const };
		row.pendingControls = [sourceControl]; row.publishingControlPoll = { sourceControl, scope: "thinking", transactionId: deriveMatrixTransactionId(id, sourceControl.controlId, 0),
			prompt: "Choose", options: [{ answerId: "pi-control-0", command: "!thinking high" }] };
	} else {
		const deliveryId = deriveDeliveryId(id, "$origin"); const entryId = deriveTranscriptEntryId(f.first.piSessionId, "checkpoint:test");
		const transactionId = deriveMatrixTransactionId(id, entryId, 0);
		const base = { checkpointId: "checkpoint-test", originDeliveryId: deliveryId, entryId, transactionId,
			question: "Choose", options: [{ answerId: deriveCheckpointPollAnswerId("checkpoint-test", 0), text: "Exact option" }] };
		const intent = { ...base, intentHash: deriveCheckpointPollIntentHash(base) };
		row.pendingInputs = [{ deliveryId, matrixEventId: "$origin", kind: "prompt", body: "Choose", status: "completed" }];
		row.projection = [{ entryId, kind: "checkpoint", status: "projecting", contentHash: intent.intentHash, originDeliveryId: deliveryId,
			chunks: [{ chunkId: deriveChunkId(entryId, 0), transactionId, status: "pending" }] }];
		if (poll === "checkpoint") row.publishingCheckpointPoll = intent;
		else {
			row.pendingInputs.push({ deliveryId: deriveDeliveryId(id, "$answer"), matrixEventId: "$answer", kind: "prompt", body: "Exact option", status: "accepted" });
			row.closingCheckpointPolls = [{ ...intent, pollEventId: "$poll", resolutionEventId: "$answer", selectedAnswerId: intent.options[0]!.answerId,
				closureTransactionId: deriveMatrixTransactionId(id, "$poll", 0), fallback: "Selection accepted" }];
		}
	}
	parseHostRuntimeState(old); await writeFile(join(f.runtime, "registry.json"), JSON.stringify(old));
	const restart = new RelayRegistry("host", f.runtime, f.manifests); await restart.load();
	assert.deepEqual(restart.publishingControlPolls(), []); assert.deepEqual(restart.publishingCheckpointPolls(), []); assert.deepEqual(restart.closingCheckpointPolls(), []);
	const projected = restart.snapshot().conversations.find(c => c.conversationId === id)!;
	assert.equal(projected.state, "dormant"); assert.equal(projected.attachment, null);
	assert.ok(projected.projection.length || projected.publishingControlPoll, "historical work is retained, not cancelled or erased");
});

test("persistent-state relocation retains archive authority and presence marker", async t => {
	const f = await fixture(t); const source = f.registry.archiveCandidate(f.first.conversationId).source;
	const record = await f.registry.admitArchive(source); const target = join(f.root, "persistent", "relay");
	await prepareRelayStateDirectory("host", target, f.runtime, f.manifests);
	const moved = new RelayRegistry("host", target, f.manifests); await moved.load();
	assert.deepEqual(moved.archiveRecord(f.first.conversationId), record);
	assert.equal(moved.manifestByConversationId(f.first.conversationId), undefined);
	assert.equal(await readFile(join(target, "archives.json.initialized"), "utf8"), await readFile(join(f.runtime, "archives.json.initialized"), "utf8"));
});

test("archive store reads are detached and unavailable before load", async t => {
	const f = await fixture(t); const record = await f.registry.admitArchive(f.registry.archiveCandidate(f.first.conversationId).source);
	const store = new ArchiveStore(join(f.runtime, "archives.json"), "host"); assert.throws(() => store.list(), /unavailable/); await store.load();
	store.get(f.first.conversationId)!.source.title = "mutation"; assert.equal(store.get(f.first.conversationId)?.source.title, record.source.title);
	await assert.rejects(store.admit({ ...record, source: { ...record.source, creationKey: "other" } }), /identity changed/);
});
