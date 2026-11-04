import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RelayRegistry } from "../config/agent/extensions/managed-sessions/relay/registry.js";
import { ConversationManifestStore } from "../config/agent/extensions/managed-sessions/relay/manifest-store.js";
import { RuntimeRepairOwner, runtimeRepairDigest } from "../config/agent/extensions/managed-sessions/relay/runtime-repair.js";
import { observeRuntimeRepair } from "../config/agent/extensions/managed-sessions/relay/runtime-repair-evidence.js";
import { AtomicJsonFile } from "../config/agent/extensions/managed-sessions/relay/atomic-json.js";
import { deriveConversationId, deriveDeliveryId, deriveTranscriptEntryId, parseHostRuntimeState, type ConversationManifest } from "../config/agent/extensions/managed-sessions/contracts.js";
const op = (n = "a") => `operation_${n.repeat(32)}`;
const bootId = "12345678-1234-1234-1234-123456789abc";
async function fixture(t: { after(fn: () => Promise<void>): void }, kind: "project" | "coordinator" = "project") {
	const root = await mkdtemp(join(tmpdir(), "runtime-repair-")); t.after(() => rm(root, { recursive: true, force: true }));
	const manifests = new ConversationManifestStore(join(root, "manifests"));
	const id = deriveConversationId("host", kind); const file = join(root, "session.jsonl");
	const manifest: ConversationManifest = { schemaVersion: "1.0.0", ownerHostId: "host", kind, conversationId: id, creationKey: kind,
		concept: kind, piSessionId: "saved", roomId: "!original:example.com", bindingBoundaryEntryId: deriveTranscriptEntryId("saved", "boundary"),
		createdAt: "2026-10-01T00:00:00.000Z", ...(kind === "project" ? { placement: { rootKey: "projects", workspace: "example", relativeCwd: "" }, projectKey: `project_${"a".repeat(32)}`, projectDisplayName: "example", checkoutDisplayName: "example" } : {}) };
	await manifests.write(manifest);
	await writeFile(file, [{ type: "session", id: "saved", cwd: root }, { type: "custom", customType: "managed-session.binding-boundary", id: "boundary",
		data: { version: "1.0.0", creationKey: kind, concept: kind, sessionId: "saved" } }, { type: "message", content: "PRIVATE HISTORY" }].map(x => JSON.stringify(x)).join("\n") + "\n");
	const runtime = join(root, "runtime"); const registry = new RelayRegistry("host", runtime, manifests); await registry.load();
	let observation = { conflicts: false, bootId, unreadableProcesses: [] as string[] };
	let check: "gone" | "match" | "changed" = "gone";
	const observe = (target: ReturnType<RelayRegistry["runtimeRepairTarget"]>) => observeRuntimeRepair({ manifest, target, file, cwd: root,
		windows: { check: async () => check }, observe: async request => { assert.equal((request as { sessionFile: string }).sessionFile, file); return observation; } });
	const owner = new RuntimeRepairOwner({ registry, observe });
	return { root, file, id, manifest, manifests, registry, runtime, owner, observe,
		setObservation: (value: typeof observation) => { observation = value; }, setCheck: (value: typeof check) => { check = value; } };
}

test("both projects and coordinator reconcile legacy state behind a durable hold without launching or changing history", async t => {
	for (const kind of ["project", "coordinator"] as const) {
		const f = await fixture(t, kind); const original = await readFile(f.file);
		await f.registry.setManagedWindow(f.id, { sessionName: kind === "project" ? "project" : "default", windowId: "@1", paneId: "%1" });
		await f.registry.setAttachmentNonce(f.id, "n".repeat(64));
		const snapshot = JSON.parse(JSON.stringify(await f.owner.snapshot(f.id)));
		await assert.rejects(f.owner.reconcile(snapshot, op(), {}), { code: "forbidden" });
		assert.equal(await f.owner.reconcile(snapshot, op(), { operatorClosed: true }), "reconciled");
		assert.equal(f.registry.runtimeRepairHeld(f.id), true); assert.equal(f.registry.managedWindow(f.id), null);
		assert.equal(f.registry.conversationSnapshot(f.id)!.attachmentNonceHash, undefined);
		await assert.rejects(f.registry.beginLaunch(f.id), /holds/);
		await assert.rejects(f.registry.prepareProjectLaunch(f.id, "new".repeat(22)), /holds/);
		assert.throws(() => f.registry.beginRefresh(f.id), /holds/);
		assert.throws(() => f.registry.withQueueEffect(f.id, async () => assert.fail()), /holds/);
		await assert.rejects(f.registry.attach({ protocolVersion: "1.0.0", messageId: "old", conversationId: f.id,
			role: kind === "coordinator" ? "coordinator_adapter" : "ordinary_adapter", type: "attachment.attach", payload: {
				sessionId: "saved", attachmentNonce: "n".repeat(64), bindingBoundaryEntryId: f.manifest.bindingBoundaryEntryId } }, "old-connection"), /holds/);
		const reloaded = new RelayRegistry("host", f.runtime, f.manifests); await reloaded.load();
		assert.equal(reloaded.runtimeRepairHeld(f.id), true);
		const resumed = new RuntimeRepairOwner({ registry: reloaded, observe: async () => assert.fail("completed receipt must not replay inspection/effects") });
		assert.equal(await resumed.reconcile(snapshot, op(), { operatorClosed: true }), "reconciled");
		assert.deepEqual(await readFile(f.file), original); assert.deepEqual(await f.manifests.list(), [f.manifest]);
	}
});

test("uncertain launch reservation reconciliation retains monotonic ordinal across release and reload", async t => {
	const f = await fixture(t); const first = await f.registry.prepareProjectLaunch(f.id, "n".repeat(64)); await f.registry.failLaunch(f.id);
	const snapshot = await f.owner.snapshot(f.id); await f.owner.reconcile(snapshot, op(), { operatorClosed: true });
	assert.equal(f.registry.launchIdentity(f.id), undefined);
	await f.registry.releaseEmptyRuntimeRepair(f.id, op());
	const reloaded = new RelayRegistry("host", f.runtime, f.manifests); await reloaded.load();
	const second = await reloaded.prepareProjectLaunch(f.id, "x".repeat(64));
	assert.equal(second.ordinal, first.ordinal + 1); assert.notEqual(second.launchId, first.launchId);
	await assert.rejects(reloaded.prepareProjectLaunch(f.id, "y".repeat(64)), /Previous launch/);
});

test("new inputs remain durable behind the repair hold; release never implicitly resumes them", async t => {
	const f = await fixture(t); const snapshot = await f.owner.snapshot(f.id);
	await f.owner.reconcile(snapshot, op(), { operatorClosed: true });
	await f.registry.recordAcceptedInput(f.id, { deliveryId: deriveDeliveryId(f.id, "$later"), matrixEventId: "$later", kind: "prompt", body: "later work", status: "accepted" });
	await assert.rejects(f.registry.releaseEmptyRuntimeRepair(f.id, op()), /still holds work/);
	assert.equal(f.registry.pendingInputs(f.id)[0].status, "accepted");
});

test("in-flight producer/launcher admission blocks repair; fresh identity and evidence are rechecked", async t => {
	const f = await fixture(t); const snapshot = await f.owner.snapshot(f.id);
	await f.registry.withQueueEffect(f.id, async () => { await assert.rejects(f.owner.snapshot(f.id), /quiescent/); });
	await f.registry.setAttachmentNonce(f.id, "changed".repeat(9));
	await assert.rejects(f.owner.reconcile(snapshot, op(), { operatorClosed: true }), /changed/);
	assert.equal(f.registry.runtimeRepairHeld(f.id), false);
});

test("changed uncertainty after admission leaves a hold that fresh consent can supersede without a gap", async t => {
	const f = await fixture(t); let calls = 0;
	const owner = new RuntimeRepairOwner({ registry: f.registry, observe: async target => {
		if (++calls === 3) f.setObservation({ conflicts: false, bootId, unreadableProcesses: ["101"] });
		return f.observe(target);
	} });
	const frozen = await owner.snapshot(f.id);
	await assert.rejects(owner.reconcile(frozen, op(), { operatorClosed: true }), /after admission/);
	assert.equal(f.registry.runtimeRepairHeld(f.id), true);
	const fresh = await owner.snapshot(f.id); assert.equal(fresh.heldOperationId, op());
	await assert.rejects(owner.reconcile(fresh, op("b"), { operatorClosed: true }), /uncertainty/);
	await owner.reconcile(fresh, op("b"), { operatorClosed: true, acceptIncompleteInspection: true });
	assert.equal(f.registry.runtimeRepairReceipt(f.id, op())!.phase, "superseded");
	assert.equal(f.registry.runtimeRepairReceipt(f.id, op("b"))!.phase, "reconciled");
	const malformed = f.registry.snapshot(); malformed.conversations[0].runtimeRepairs![0].releasedAt = new Date().toISOString();
	assert.throws(() => parseHostRuntimeState(malformed), /repair receipt/);
	await assert.rejects(owner.reconcile(frozen, op(), { operatorClosed: true }), /superseded/);
});

test("known process conflicts, changed/reused exact windows and incomplete exact evidence cannot be waived", async t => {
	const f = await fixture(t);
	f.setObservation({ conflicts: true, bootId, unreadableProcesses: [] }); await assert.rejects(f.owner.snapshot(f.id), /cannot verify/);
	f.setObservation({ conflicts: false, bootId, unreadableProcesses: [] });
	const launch = await f.registry.prepareProjectLaunch(f.id, "n".repeat(64));
	await f.registry.setManagedWindow(f.id, { sessionName: "project", windowId: "@1", paneId: "%1", ownership: {
		conversationId: f.id, launchId: launch.launchId, serverId: `1:1:${"a".repeat(32)}`, sessionName: "project", windowId: "@1", paneId: "%1",
		panePid: "123", processBootId: bootId, processStartTicks: "99" } });
	for (const check of ["match", "changed"] as const) { f.setCheck(check); await assert.rejects(f.owner.snapshot(f.id), /cannot verify/); }
	f.setCheck("gone"); f.setObservation({ conflicts: false, bootId, unreadableProcesses: ["123"] }); await assert.rejects(f.owner.snapshot(f.id), /cannot verify/);
	f.setObservation({ conflicts: false, bootId, unreadableProcesses: [] });
	const snapshot = await f.owner.snapshot(f.id); assert.equal(snapshot.evidence.closureBasis, "verified_exit");
	await f.owner.reconcile(snapshot, op(), {}); assert.equal(f.registry.runtimeRepairHeld(f.id), true);
});

test("saved session changes and symlinks fail without rewriting the file", async t => {
	const f = await fixture(t); const snapshot = await f.owner.snapshot(f.id);
	await writeFile(f.file, "changed history\n");
	await assert.rejects(f.owner.reconcile(snapshot, op(), { operatorClosed: true }));
	assert.equal(await readFile(f.file, "utf8"), "changed history\n");
	await rm(f.file); await symlink(join(f.root, "missing"), f.file);
	await assert.rejects(f.owner.snapshot(f.id)); assert.equal(f.registry.runtimeRepairHeld(f.id), false);
});

test("uncertain admission write poisons the owner; reload retains the committed hold", async t => {
	const f = await fixture(t); const snapshot = await f.owner.snapshot(f.id);
	const write = AtomicJsonFile.prototype.write;
	AtomicJsonFile.prototype.write = async function(value) { await write.call(this, value); if (this.path === join(f.runtime, "registry.json")) throw Error("uncertain commit"); };
	try { await assert.rejects(f.owner.reconcile(snapshot, op(), { operatorClosed: true }), /uncertain/); }
	finally { AtomicJsonFile.prototype.write = write; }
	assert.throws(() => f.registry.snapshot(), /uncertain/);
	const reloaded = new RelayRegistry("host", f.runtime, f.manifests); await reloaded.load();
	assert.equal(reloaded.runtimeRepairHeld(f.id), true);
	const owner = new RuntimeRepairOwner({ registry: reloaded, observe: f.observe });
	await owner.reconcile(snapshot, op(), { operatorClosed: true }); assert.equal(reloaded.runtimeRepairReceipt(f.id, op())!.phase, "reconciled");
});

test("repair receipts reject phase skips, duplicate operations and backward launch counters", async t => {
	const f = await fixture(t); const snapshot = await f.owner.snapshot(f.id);
	await f.owner.reconcile(snapshot, op(), { operatorClosed: true });
	for (const change of [
		(row: ReturnType<RelayRegistry["snapshot"]>["conversations"][number]) => { delete row.runtimeRepairs![0].reconciledAt; },
		(row: ReturnType<RelayRegistry["snapshot"]>["conversations"][number]) => { row.runtimeRepairs!.push(row.runtimeRepairs![0]); },
	]) { const state = f.registry.snapshot(); change(state.conversations[0]); assert.throws(() => parseHostRuntimeState(state)); }
	await f.registry.releaseEmptyRuntimeRepair(f.id, op());
	await f.registry.prepareProjectLaunch(f.id, "x".repeat(64));
	const state = f.registry.snapshot(); state.conversations[0].launchHighWater = 1; state.conversations[0].launch!.ordinal = 2;
	assert.throws(() => parseHostRuntimeState(state));
	assert.equal(runtimeRepairDigest({ a: 1 }).length, 64);
});

test("a reconciled but still held plan can be superseded without discarding its reconciliation receipt", async t => {
 const f = await fixture(t); await f.owner.reconcile(await f.owner.snapshot(f.id), op(), { operatorClosed: true });
 const first = f.registry.runtimeRepairReceipt(f.id, op())!;
 await f.owner.reconcile(await f.owner.snapshot(f.id), op("b"), { operatorClosed: true });
 const superseded = f.registry.runtimeRepairReceipt(f.id, op())!;
 assert.equal(superseded.phase, "superseded"); assert.equal(superseded.reconciledAt, first.reconciledAt);
 assert.ok(superseded.supersededAt); assert.equal(superseded.releasedAt, undefined);
 assert.equal(f.registry.heldRuntimeRepairOperation(f.id), op("b"));
 assert.doesNotThrow(() => parseHostRuntimeState(f.registry.snapshot()));
});

for (const terminal of ["retired", "archived"] as const) test(`${terminal} authority defeats held repair and restoration of an older runtime snapshot`, async t => {
 const f = await fixture(t); const snapshot = await f.owner.snapshot(f.id);
 await f.owner.reconcile(snapshot, op(), { operatorClosed: true });
 const old = await readFile(join(f.runtime, "registry.json"));
 if (terminal === "retired") await f.registry.retireConversation(f.id, [
  { kind: "stop", generationId: snapshot.target.generationId },
  { kind: "operator_leave_forget", roomId: f.manifest.roomId, userId: "@operator:example.com" },
  { kind: "bot_leave", roomId: f.manifest.roomId, userId: "@bot:example.com" },
 ]);
 else await f.registry.admitArchive(f.registry.archiveCandidate(f.id).source);
 await assert.rejects(f.owner.reconcile(snapshot, op(), { operatorClosed: true }), /retired|archived/);
 await writeFile(join(f.runtime, "registry.json"), old);
 const reloaded = new RelayRegistry("host", f.runtime, f.manifests); await reloaded.load();
 await assert.rejects(new RuntimeRepairOwner({ registry: reloaded, observe: f.observe }).snapshot(f.id), /retired|archived/);
});
