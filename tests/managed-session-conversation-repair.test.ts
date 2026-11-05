import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { freezeJsonChunks } from "../config/agent/extensions/managed-sessions/relay/host-preview-store.js";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RelayRegistry } from "../config/agent/extensions/managed-sessions/relay/registry.js";
import { ConversationManifestStore } from "../config/agent/extensions/managed-sessions/relay/manifest-store.js";
import { RuntimeRepairOwner } from "../config/agent/extensions/managed-sessions/relay/runtime-repair.js";
import { observeRuntimeRepair } from "../config/agent/extensions/managed-sessions/relay/runtime-repair-evidence.js";
import { ConversationRepairOwner } from "../config/agent/extensions/managed-sessions/relay/conversation-repair.js";
import type { MembershipRepairPlan } from "../config/agent/extensions/managed-sessions/relay/membership-repair.js";
import { AtomicJsonFile } from "../config/agent/extensions/managed-sessions/relay/atomic-json.js";
import { ManagedHostMutationOwner } from "../config/agent/extensions/managed-sessions/relay/host-mutation-owner.js";
import { RelayEventProjector } from "../config/agent/extensions/managed-sessions/relay/event-projector.js";
import { ProjectionResumptionOwner } from "../config/agent/extensions/managed-sessions/relay/projection-resumption.js";
import { CoordinatorRouter } from "../config/agent/extensions/managed-sessions/relay/coordinator-router.js";
import type { ManagedSessionIpcServer } from "../config/agent/extensions/managed-sessions/relay/ipc-server.js";
import type { ManagedMatrixClient } from "../config/agent/extensions/managed-sessions/relay/matrix-client.js";
import { parseHostAction } from "../config/agent/extensions/managed-sessions/live-workspace-contracts.js";
import { deriveConversationId, deriveDeliveryId, deriveTranscriptEntryId, parseHostRuntimeState, type ConversationManifest, type ManagedSessionEnvelope } from "../config/agent/extensions/managed-sessions/contracts.js";
import { deriveControlId } from "../config/agent/extensions/managed-sessions/v2-contracts.js";
const op = (letter = "a") => `operation_${letter.repeat(32)}`;
async function fixture(t: { after(fn: () => Promise<void>): void }, kind: "project" | "coordinator" = "project", legacy = true) {
 const root = await mkdtemp(join(tmpdir(), "conversation-repair-")); t.after(() => rm(root, { recursive: true, force: true }));
 const manifests = new ConversationManifestStore(join(root, "manifests")); const id = deriveConversationId("host", kind);
 const manifest: ConversationManifest = { schemaVersion: "1.0.0", ownerHostId: "host", kind, conversationId: id, creationKey: kind,
  concept: kind, piSessionId: "saved", roomId: "!original:example.com", bindingBoundaryEntryId: deriveTranscriptEntryId("saved", "boundary"),
  createdAt: "2026-10-01T00:00:00.000Z", ...(kind === "project" ? { placement: { rootKey: "projects", workspace: "example", relativeCwd: "" }, projectKey: `project_${"a".repeat(32)}`, projectDisplayName: "example", checkoutDisplayName: "example" } : {}) };
 await manifests.write(manifest); const file = join(root, "session.jsonl");
 await writeFile(file, [{ type: "session", id: "saved", cwd: root }, { type: "custom", customType: "managed-session.binding-boundary", id: "boundary",
  data: { version: "1.0.0", creationKey: kind, concept: kind, sessionId: "saved" } }, { type: "message", content: "PRIVATE HISTORY" }].map(x => JSON.stringify(x)).join("\n") + "\n");
 const runtimeFile = join(root, "runtime"); const registry = new RelayRegistry("host", runtimeFile, manifests); await registry.load();
 if (legacy) await registry.setManagedWindow(id, { sessionName: "default", windowId: "@1", paneId: "%1" });
 let unreadableProcesses: string[] = [];
 const accountPlan: MembershipRepairPlan = { identity: { conversationId: id, roomId: manifest.roomId, hostSpaceId: "!host:example.com", operatorUserId: "@operator:example.com", botUserId: "@bot:example.com", sourceDigest: "a".repeat(64) },
  member: { eventId: "$joined", sender: "@operator:example.com", membership: "join" } };
 let calls = 0; let restore: () => Promise<"ready" | "pending"> = async () => "ready"; let inspectError = "";
 const account = { freezeRoomMembership: async () => { if (inspectError) throw Error(inspectError); return structuredClone(accountPlan); },
  restoreRoomMembership: async () => { calls++; return { conversationId: id, setupState: await restore() }; } };
 const makeOwner = (r = registry) => new ConversationRepairOwner({ registry: r, account, runtime: new RuntimeRepairOwner({ registry: r,
  observe: target => observeRuntimeRepair({ manifest, target, file, cwd: root, windows: { check: async () => "gone" },
   observe: async () => ({ conflicts: false, bootId: "12345678-1234-1234-1234-123456789abc", unreadableProcesses }) }) }) });
 const owner = makeOwner(); t.after(() => owner.close());
 const input = (event = "$old") => ({ deliveryId: deriveDeliveryId(id, event), matrixEventId: event, kind: "prompt", body: `PRIVATE ${event}`, status: "accepted" as const });
 const attach = async () => { await registry.setAttachmentNonce(id, "n".repeat(64)); await registry.attach({ protocolVersion: "1.0.0", messageId: "attach", conversationId: id,
  role: kind === "coordinator" ? "coordinator_adapter" : "ordinary_adapter", type: "attachment.attach", payload: { sessionId: "saved", attachmentNonce: "n".repeat(64), bindingBoundaryEntryId: manifest.bindingBoundaryEntryId } }, "connection"); };
 return { root, file, registry, runtimeFile, manifests, manifest, id, owner, makeOwner, input, attach, accountPlan, calls: () => calls,
  setRestore: (value: typeof restore) => { restore = value; }, setInspectError: (value: string) => { inspectError = value; }, setUnreadable: (value: string[]) => { unreadableProcesses = value; } };
}
async function finish(f: Awaited<ReturnType<typeof fixture>>, operationId = op()) {
 const plan = await f.owner.preview(f.id); assert.deepEqual(plan.blockers, []);
 await f.owner.apply(plan, operationId, { operatorClosed: true }); await f.owner.drain();
 assert.equal(f.registry.conversationRepairReceipt(f.id)?.phase, "complete");
}

test("delayed account acknowledgement after thirty polls completes within original approval expiry", async t => {
 const f = await fixture(t, "project", false);
 await f.registry.recordAcceptedInput(f.id, f.input());
 t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
 let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
 f.setRestore(async () => { entered(); return f.calls() > 35 ? "ready" : "pending"; });
 const plan = await f.owner.preview(f.id);
 await f.owner.apply(plan, op(), {}); await started;
 for (let i = 0; i < 36; i++) {
  await new Promise<void>(resolve => setImmediate(resolve)); t.mock.timers.tick(1000);
 }
 await f.owner.drain();
 assert.equal(f.registry.conversationRepairReceipt(f.id)?.phase, "complete");
 assert.equal(f.registry.conversationRepairReceipt(f.id)?.expiresAt, plan.expiresAt);
 assert.deepEqual(f.registry.dispatchableInputs(f.id), []);
 assert.equal(f.registry.pendingInputs(f.id)[0].status, "accepted");
});

for (const reply of ["pending", "ready"] as const) test(`original expiry fences a delayed ${reply} account reply`, async t => {
 const f = await fixture(t, "project", false);
 await f.registry.recordAcceptedInput(f.id, f.input());
 t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
 let entered!: () => void, release!: () => void;
 const started = new Promise<void>(resolve => { entered = resolve; });
 const gate = new Promise<void>(resolve => { release = resolve; });
 f.setRestore(async () => { entered(); await gate; return reply; });
 const plan = await f.owner.preview(f.id);
 await f.owner.apply(plan, op(), {}); await started;
 t.mock.timers.tick(300_000); release();
 await new Promise<void>(resolve => setImmediate(resolve)); t.mock.timers.tick(1000);
 await f.owner.drain();
 assert.equal(f.calls(), 1);
 assert.equal(f.owner.isRunning(op()), false);
 assert.equal(f.registry.conversationRepairReceipt(f.id)?.phase, "account_pending");
 assert.equal(f.registry.conversationRepairReceipt(f.id)?.expiresAt, plan.expiresAt);
 assert.deepEqual(f.registry.dispatchableInputs(f.id), []);
});
test("pending reply just before expiry sleeps only until the original deadline", async t => {
 const f = await fixture(t, "project", false);
 t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
 let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
 f.setRestore(async () => { t.mock.timers.tick(299_950); entered(); return "pending"; });
 await f.owner.apply(await f.owner.preview(f.id), op(), {}); await started;
 await new Promise<void>(resolve => setImmediate(resolve));
 t.mock.timers.tick(49); await new Promise<void>(resolve => setImmediate(resolve));
 assert.equal(f.owner.isRunning(op()), true);
 t.mock.timers.tick(1); await new Promise<void>(resolve => setImmediate(resolve));
 assert.equal(f.owner.isRunning(op()), false); assert.equal(f.calls(), 1);
 assert.equal(f.registry.conversationRepairReceipt(f.id)?.phase, "account_pending");
});

test("shutdown aborts delayed account polling without releasing preserved work", async t => {
 const f = await fixture(t, "project", false);
 await f.registry.recordAcceptedInput(f.id, f.input());
 t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
 let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
 f.setRestore(async () => { entered(); return "pending"; });
 await f.owner.apply(await f.owner.preview(f.id), op(), {}); await started;
 await new Promise<void>(resolve => setImmediate(resolve));
 await f.owner.close(); t.mock.timers.tick(60_000);
 assert.equal(f.calls(), 1); assert.equal(f.owner.isRunning(op()), false);
 assert.equal(f.registry.conversationRepairReceipt(f.id)?.phase, "account_pending");
 assert.deepEqual(f.registry.dispatchableInputs(f.id), []);
});

test("repair has no queue choices, preserves work/history and leaves project and coordinator dormant", async t => {
 for (const kind of ["project", "coordinator"] as const) {
  const f = await fixture(t, kind); const original = await readFile(f.file); await f.registry.recordAcceptedInput(f.id, f.input());
  await finish(f);
  assert.equal(f.registry.pendingInputs(f.id)[0].status, "accepted"); assert.deepEqual(f.registry.dispatchableInputs(f.id), []);
  assert.equal(f.registry.runtimeRepairReceipt(f.id, op())?.phase, "released"); assert.equal(f.registry.conversationState(f.id), "dormant");
  assert.equal(f.registry.managedWindow(f.id), null); assert.equal(f.registry.conversationSnapshot(f.id)!.queueCancellations, undefined);
  assert.deepEqual(await readFile(f.file), original); assert.deepEqual(await f.manifests.list(), [f.manifest]);
  const reload = new RelayRegistry("host", f.runtimeFile, f.manifests); await reload.load(); assert.deepEqual(reload.dispatchableInputs(f.id), []);
  assert.equal(reload.queueItemHeld(f.id, "input", f.input().deliveryId), true);
 }
});
test("closure and unreadable-process consent remain explicit without queue-policy fields", async t => {
 const f = await fixture(t); f.setUnreadable(["101"]); const plan = await f.owner.preview(f.id);
 await assert.rejects(f.owner.apply(plan, op(), {}), /Explicit process/);
 await assert.rejects(f.owner.apply(plan, op(), { operatorClosed: true }), /Explicit process/);
 assert.equal(f.registry.conversationRepairReceipt(f.id), undefined); assert.equal(f.calls(), 0);
 await f.owner.apply(plan, op(), { operatorClosed: true, acceptIncompleteInspection: true }); await f.owner.drain();
 assert.equal(f.registry.conversationRepairReceipt(f.id)?.phase, "complete");
 const action = { operation: "conversation.repair.apply", previewId: `preview_${"a".repeat(32)}`, confirmed: true };
 assert.doesNotThrow(() => parseHostAction(action));
 for (const queue of ["hold", "resume", "abandon"]) assert.throws(() => parseHostAction({ ...action, queue }));
});
test("arrivals during repair remain preserved; later fresh intent is dispatchable without a queue choice", async t => {
 const f = await fixture(t); let enter!: () => void, release!: () => void;
 const entered = new Promise<void>(r => { enter = r; }), gate = new Promise<void>(r => { release = r; });
 f.setRestore(async () => { enter(); await gate; return "ready"; });
 await f.owner.apply(await f.owner.preview(f.id), op(), { operatorClosed: true }); await entered;
 await f.registry.recordAcceptedInput(f.id, f.input("$during")); assert.deepEqual(f.registry.dispatchableInputs(f.id), []);
 release(); await f.owner.drain(); await f.registry.recordAcceptedInput(f.id, f.input("$after"));
 assert.deepEqual(f.registry.dispatchableInputs(f.id).map(i => i.deliveryId), [f.input("$after").deliveryId]);
 assert.equal(f.registry.queueItemHeld(f.id, "input", f.input("$during").deliveryId), true);
});
test("restart never replays an approval; a fresh repair supersedes an interrupted receipt and retains holds", async t => {
 const f = await fixture(t); await f.registry.recordAcceptedInput(f.id, f.input()); f.setRestore(async () => { throw Error("uncertain transport"); });
 await f.owner.apply(await f.owner.preview(f.id), op(), { operatorClosed: true }); await f.owner.drain();
 assert.equal(f.registry.conversationRepairReceipt(f.id)?.phase, "account_pending");
 const reload = new RelayRegistry("host", f.runtimeFile, f.manifests); await reload.load(); const replacement = f.makeOwner(reload); t.after(() => replacement.close());
 const before = f.calls(); await new Promise(r => setImmediate(r)); assert.equal(f.calls(), before);
 assert.deepEqual(reload.dispatchableInputs(f.id), []); await assert.rejects(reload.beginLaunch(f.id), /holds/);
 f.setRestore(async () => "ready"); await replacement.apply(await replacement.preview(f.id), op("b"), { operatorClosed: true }); await replacement.drain();
 assert.deepEqual(reload.conversationSnapshot(f.id)!.conversationRepairs!.map(r => r.phase), ["superseded", "complete"]);
 assert.deepEqual(reload.dispatchableInputs(f.id), []); assert.equal(reload.pendingInputs(f.id)[0].body, f.input().body);
});
test("queue resumption is separate exact-scope authority, audited and stale on new arrivals", async t => {
 const f = await fixture(t); await f.registry.recordAcceptedInput(f.id, f.input()); await finish(f);
 const stale = f.registry.queueResumptionSnapshot(f.id); await f.registry.recordAcceptedInput(f.id, f.input("$new"));
 await assert.rejects(f.registry.resumeQueuedWork(stale, op("b")), /changed/);
 const selected = f.registry.queueResumptionSnapshot(f.id); assert.equal(selected.items.length, 1);
 await f.registry.resumeQueuedWork(selected, op("b")); assert.equal(f.registry.dispatchableInputs(f.id).length, 2);
 const row = f.registry.conversationSnapshot(f.id)!; assert.deepEqual(row.queueResumptions![0].items, selected.items);
 assert.equal(row.pendingInputs[0].status, "accepted"); assert.equal(row.queueCancellations, undefined);
});
test("fresh stop and reset do not implicitly abandon preserved input", async t => {
 const f = await fixture(t); await f.registry.recordAcceptedInput(f.id, f.input()); await finish(f);
 await f.registry.recordPendingControl(f.id, { controlId: deriveControlId(f.id, "$stop"), matrixEventId: "$stop", name: "stop" });
 await f.registry.cancelPendingInputs(f.id); await f.registry.cancelPendingInputsExcept(f.id, "another");
 const reset = deriveControlId(f.id, "$new"); await f.registry.recordPendingControl(f.id, { controlId: reset, matrixEventId: "$new", name: "new", argument: "--confirm" });
 await f.registry.beginGenerationTransition(f.id, reset, {});
 assert.equal(f.registry.pendingInputs(f.id)[0].status, "accepted");
});
test("held old reset/stop controls do not prevent an attached repaired coordinator accepting fresh input", async t => {
 const f = await fixture(t, "coordinator");
 await f.registry.recordPendingControl(f.id, { controlId: deriveControlId(f.id, "$stop"), matrixEventId: "$stop", name: "stop" });
 await f.registry.recordAcceptedInput(f.id, f.input()); await finish(f); await f.attach();
 await f.registry.recordAcceptedInput(f.id, f.input("$fresh")); const sent: ManagedSessionEnvelope[] = [];
 const server = { sendToConversation: (e: ManagedSessionEnvelope) => { sent.push(e); return true; } } as unknown as ManagedSessionIpcServer;
 const router = new CoordinatorRouter(f.manifest, f.registry, {} as ManagedMatrixClient, server, async () => assert.fail("no launch"));
 await router.attachmentReady(f.id);
 assert.equal(sent.length, 1); assert.equal((sent[0].payload as { deliveryId: string }).deliveryId, f.input("$fresh").deliveryId);
 assert.equal(f.registry.pendingInputs(f.id)[0].status, "accepted");
});
test("account-only repair preserves an existing attachment and requires no closure assertion", async t => {
 const f = await fixture(t, "project", false); await f.attach(); const before = f.registry.conversationSnapshot(f.id)!.attachment;
 const plan = await f.owner.preview(f.id); assert.equal(plan.runtime, undefined);
 await f.owner.apply(plan, op(), {}); await f.owner.drain();
 assert.equal(f.registry.conversationRepairReceipt(f.id)?.phase, "complete"); assert.deepEqual(f.registry.conversationSnapshot(f.id)!.attachment, before);
 assert.equal(f.registry.runtimeRepairReceipt(f.id, op()), undefined);
});
test("existing pending output is held while fresh control-plane output can be published", async t => {
 const f = await fixture(t, "project", false); let fail = true; let sends = 0;
 const matrix = { sendText: async () => { sends++; if (fail) throw Error("offline"); } } as unknown as ManagedMatrixClient;
 const projector = new RelayEventProjector(f.registry, matrix);
 await assert.rejects(projector.projectNotice(f.id, "old", "PRIVATE OLD OUTPUT"), /offline/);
 await finish(f); fail = false; const count = sends;
 await assert.rejects(projector.projectNotice(f.id, "old", "PRIVATE OLD OUTPUT"), /preserved/); assert.equal(sends, count);
 await projector.projectNotice(f.id, "fresh", "repair status"); assert.equal(sends, count + 1);
 const selected = f.registry.queueResumptionSnapshot(f.id); await f.registry.resumeQueuedWork(selected, op("b"));
 await projector.projectNotice(f.id, "old", "PRIVATE OLD OUTPUT"); assert.equal(sends, count + 2);
});
test("unsupported, terminal and unverified account evidence block before runtime/queue mutation", async t => {
 for (const error of ["Original room is terminal on NAS and is not restorable", "NAS support is unconfirmed", "secret error PRIVATE /tmp/private token=credential"]) {
  const f = await fixture(t); f.setInspectError(error); const before = f.registry.snapshot(); const plan = await f.owner.preview(f.id);
  assert.ok(plan.blockers.length); assert.ok(!JSON.stringify(plan.blockers).includes("PRIVATE"));
  await assert.rejects(f.owner.apply(plan, op(), { operatorClosed: true }), /changed/);
  assert.deepEqual(f.registry.snapshot(), before); assert.equal(f.calls(), 0);
 }
});
test("active producers and lifecycle transitions block before admission", async t => {
 const f = await fixture(t);
 await f.registry.withQueueEffect(f.id, async () => { const plan = await f.owner.preview(f.id); assert.ok(plan.blockers.length); });
 await f.registry.setManagedWindow(f.id, null);
 await f.registry.beginGenerationTransition(f.id, deriveControlId(f.id, "$new"), {});
 const plan = await f.owner.preview(f.id); assert.ok(plan.blockers.some(b => /transition/.test(b)));
});
test("changed history makes repair consent stale", async t => {
 const f = await fixture(t); const plan = await f.owner.preview(f.id); await writeFile(f.file, (await readFile(f.file, "utf8")) + "\n");
 await assert.rejects(f.owner.apply(plan, op(), { operatorClosed: true }), /changed/); assert.equal(f.registry.conversationRepairReceipt(f.id), undefined);
});
test("uncertain registry admission poisons the writer and reload retains a non-replayed hold", async t => {
 const f = await fixture(t); const plan = await f.owner.preview(f.id); const original = AtomicJsonFile.prototype.write; let injected = false;
 AtomicJsonFile.prototype.write = async function(value) { await original.call(this, value); if (this.path === join(f.runtimeFile, "registry.json") && !injected) { injected = true; throw Error("uncertain write"); } };
 try { await assert.rejects(f.owner.apply(plan, op(), { operatorClosed: true }), /uncertain write/); } finally { AtomicJsonFile.prototype.write = original; }
 assert.throws(() => f.registry.conversationRepairReceipt(f.id), /uncertain/); assert.equal(f.calls(), 0);
 const reload = new RelayRegistry("host", f.runtimeFile, f.manifests); await reload.load(); assert.equal(reload.conversationRepairReceipt(f.id)?.phase, "held");
 await assert.rejects(reload.beginLaunch(f.id), /holds/);
});
test("strict receipts reject altered scope, duplicate holds and incomplete phase cutover", async t => {
 const f = await fixture(t); f.setRestore(async () => { throw Error("stop"); });
 await f.owner.apply(await f.owner.preview(f.id), op(), { operatorClosed: true }); await f.owner.drain();
 await assert.rejects(f.registry.advanceConversationRepair(f.id, op(), "complete"), /changed/);
 const changed = f.registry.snapshot(); changed.conversations[0].conversationRepairs![0].generationId = `generation_${"b".repeat(32)}`;
 assert.throws(() => parseHostRuntimeState(changed), /frozen repair plan/);
});
test("typed mutation owner uses preview-bound repair and rejects model human-execution bypass", async t => {
 const f = await fixture(t);
 const owner = new ManagedHostMutationOwner({ registry: f.registry, repairs: f.owner,
  lifecycle: {} as ConstructorParameters<typeof ManagedHostMutationOwner>[0]["lifecycle"], retirement: {} as ConstructorParameters<typeof ManagedHostMutationOwner>[0]["retirement"], server: { attachment: () => undefined } });
 const preview = await owner.preview({ operation: "conversation.repair.preview", conversationId: f.id }); assert.deepEqual(preview.blockers, []);
 const action = { operation: "conversation.repair.apply" as const, previewId: preview.previewId, confirmed: true as const, operatorClosed: true as const };
 const result = await owner.executeHuman({ version: "1.0.0", actor: { kind: "human_local", requestId: "repair" }, action }) as { cleanupState: string };
 assert.equal(result.cleanupState, "pending"); await f.owner.drain(); assert.equal(f.registry.conversationRepairReceipt(f.id)?.phase, "complete");
 await assert.rejects(owner.executeHuman({ version: "1.0.0", actor: { kind: "model", requestId: "bypass", conversationId: f.id, generationId: f.registry.activeGeneration(f.manifest).generationId, runId: "run", toolCallId: "call", presentation: "local_dialog" }, action }), /independent consent/);
});


test("a reconciled runtime awaiting account confirmation does not require repeated closure assertion", async t => {
 const f = await fixture(t);
 f.setRestore(async () => { f.setInspectError("unconfirmed"); return "ready"; });
 await f.owner.apply(await f.owner.preview(f.id), op(), { operatorClosed: true }); await f.owner.drain();
 assert.equal(f.registry.runtimeRepairReceipt(f.id, op())?.phase, "reconciled");
 assert.equal(f.registry.conversationRepairReceipt(f.id)?.phase, "runtime_pending");
 f.setInspectError(""); f.setRestore(async () => "ready");
 const fresh = await f.owner.preview(f.id); assert.equal(fresh.runtime, undefined);
 await f.owner.apply(fresh, op("b"), {}); await f.owner.drain();
 assert.equal(f.registry.runtimeRepairReceipt(f.id, op())?.phase, "released");
 assert.equal(f.registry.conversationRepairReceipt(f.id)?.phase, "complete");
});
test("unobserved reservations reconcile without resetting launch high-water", async t => {
 const f = await fixture(t, "project", false);
 const launch = await f.registry.prepareProjectLaunch(f.id, "n".repeat(64)); await f.registry.failLaunch(f.id);
 await finish(f); const next = await f.registry.prepareProjectLaunch(f.id, "x".repeat(64));
 assert.equal(next.ordinal, launch.ordinal + 1); assert.notEqual(next.launchId, launch.launchId);
});
for (const terminal of ["retired", "archived"] as const) test(`${terminal} authority defeats interrupted orchestration and older runtime snapshots`, async t => {
 const f = await fixture(t, "project", false); f.setRestore(async () => { throw Error("uncertain"); });
 await f.owner.apply(await f.owner.preview(f.id), op(), { operatorClosed: true }); await f.owner.drain();
 const old = await readFile(join(f.runtimeFile, "registry.json"));
 if (terminal === "retired") await f.registry.retireConversation(f.id, [
  { kind: "stop", generationId: f.registry.activeGeneration(f.manifest).generationId },
  { kind: "operator_leave_forget", roomId: f.manifest.roomId, userId: "@operator:example.com" },
  { kind: "bot_leave", roomId: f.manifest.roomId, userId: "@bot:example.com" },
 ]);
 else await f.registry.admitArchive(f.registry.archiveCandidate(f.id).source);
 await assert.rejects(f.owner.preview(f.id), /retired|archived/);
 await writeFile(join(f.runtimeFile, "registry.json"), old);
 const reload = new RelayRegistry("host", f.runtimeFile, f.manifests); await reload.load();
 await assert.rejects(f.makeOwner(reload).preview(f.id), /retired|archived/);
});

test("protected coordinator resumption does not inherit cancellation's project-only blocker", async t => {
 const f = await fixture(t, "coordinator"); await f.registry.recordAcceptedInput(f.id, f.input()); await finish(f);
 assert.ok(f.registry.queueCancellationSnapshot(f.id).blockers.some(b => /protected coordinator/.test(b)));
 assert.deepEqual(f.registry.queueResumptionSnapshot(f.id).blockers, []);
 let dispatches = 0;
 const owner = new ManagedHostMutationOwner({ registry: f.registry, repairs: f.owner, queueReady: () => true, resumeQueues: async id => { assert.equal(id, f.id); dispatches++; },
  lifecycle: {} as ConstructorParameters<typeof ManagedHostMutationOwner>[0]["lifecycle"], retirement: {} as ConstructorParameters<typeof ManagedHostMutationOwner>[0]["retirement"], server: { attachment: () => undefined } });
 const preview = await owner.preview({ operation: "conversation.queue.resume.preview", conversationId: f.id }); assert.deepEqual(preview.blockers, []);
 await owner.executeHuman({ version: "1.0.0", actor: { kind: "human_local", requestId: "resume" }, action: { operation: "conversation.queue.resume.apply", previewId: preview.previewId, confirmed: true } });
 assert.equal(dispatches, 1); assert.equal(f.registry.dispatchableInputs(f.id).length, 1);
});
test("only separately resumed durable output retries after a crash before delivery", async t => {
 const f = await fixture(t, "project", false); let offline = true; const sent: unknown[][] = [];
 const matrix = { sendText: async (...args: unknown[]) => { sent.push(args.slice(0, 4)); if (offline) throw Error("offline"); } } as unknown as ManagedMatrixClient;
 const projector = new RelayEventProjector(f.registry, matrix);
 await assert.rejects(projector.projectNotice(f.id, "old", "PRIVATE ORIGINAL OUTPUT"), /offline/);
 await finish(f); offline = false;
 const before = new ProjectionResumptionOwner(f.registry, matrix); await before.kick(); await before.close(); assert.equal(sent.length, 1);
 await f.registry.resumeQueuedWork(f.registry.queueResumptionSnapshot(f.id), op("b"));
 // Crash after permission/audit commit, before any retry callback.
 const reload = new RelayRegistry("host", f.runtimeFile, f.manifests); await reload.load();
 const retry = new ProjectionResumptionOwner(reload, matrix); t.after(() => retry.close());
 await retry.kick(); assert.equal(sent.length, 2); assert.deepEqual(sent[1], sent[0]);
 assert.equal(reload.conversationSnapshot(f.id)!.projection[0].status, "projected");
 await retry.kick(); assert.equal(sent.length, 2);
});
test("serialized admission rejects expired consent without writing holds", async t => {
 const f = await fixture(t); const plan = await f.owner.preview(f.id); const before = f.registry.snapshot();
 plan.expiresAt = Date.now() - 1; const at = new Date(plan.expiresAt - 1000).toISOString(); const planJson = freezeJsonChunks(plan);
 await assert.rejects(f.registry.admitConversationRepair(plan.source, { operationId: op(), generationId: plan.source.generationId,
  runtimeRepair: plan.source.runtimeRepair, expiresAt: plan.expiresAt, phase: "held", admittedAt: at, updatedAt: at, planJson,
  planDigest: createHash("sha256").update(planJson.join("")).digest("hex") }), /changed/);
 assert.deepEqual(f.registry.snapshot(), before);
});
test("startup attachment fallback uses dispatch eligibility for interrupted account-only repair", async t => {
 const f = await fixture(t, "project", false); await f.attach();
 await f.registry.recordPendingControl(f.id, { controlId: deriveControlId(f.id, "$stop"), matrixEventId: "$stop", name: "stop" });
 f.setRestore(async () => { throw Error("interrupted account step"); });
 await f.owner.apply(await f.owner.preview(f.id), op(), {}); await f.owner.drain();
 const reload = new RelayRegistry("host", f.runtimeFile, f.manifests); await reload.load(); reload.beginRestartReconciliation();
 await reload.attach({ protocolVersion: "1.0.0", messageId: "reattach", conversationId: f.id, role: "ordinary_adapter", type: "attachment.attach",
  payload: { sessionId: "saved", attachmentNonce: "n".repeat(64), bindingBoundaryEntryId: f.manifest.bindingBoundaryEntryId } }, "reconnected");
 assert.equal(reload.pendingControls(f.id).length, 1); assert.deepEqual(reload.dispatchableControls(f.id), []);
 // Startup composition must not bypass this tested registry gate before the router exists.
 const main = await readFile("config/agent/extensions/managed-sessions/relay/main.ts", "utf8");
 assert.ok(main.includes("else for (const control of registry.dispatchableControls(attachment.conversationId).filter"));
});
test("resumed partial output skips sent chunks whose bytes were already released", async t => {
 const f = await fixture(t, "project", false); let offline = true; const transactions: string[] = [];
 const matrix = { sendText: async (_room: string, transactionId: string) => { transactions.push(transactionId); if (offline && transactions.length > 1) throw Error("offline"); } } as unknown as ManagedMatrixClient;
 await assert.rejects(new RelayEventProjector(f.registry, matrix).projectNotice(f.id, "partial", "x".repeat(18000)), /offline/);
 const before = f.registry.conversationSnapshot(f.id)!.projection[0];
 assert.equal(before.chunks[0].status, "sent"); assert.equal(before.chunks[0].body, undefined);
 await finish(f); await f.registry.resumeQueuedWork(f.registry.queueResumptionSnapshot(f.id), op("b")); offline = false;
 const retry = new ProjectionResumptionOwner(f.registry, matrix); t.after(() => retry.close()); await retry.kick();
 assert.equal(transactions.filter(tx => tx === before.chunks[0].transactionId).length, 1);
 assert.equal(f.registry.conversationSnapshot(f.id)!.projection[0].status, "projected");
});
