import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RelayRegistry } from "../config/agent/extensions/managed-sessions/relay/registry.js";
import { ConversationManifestStore } from "../config/agent/extensions/managed-sessions/relay/manifest-store.js";
import { RuntimeRepairOwner } from "../config/agent/extensions/managed-sessions/relay/runtime-repair.js";
import { observeRuntimeRepair } from "../config/agent/extensions/managed-sessions/relay/runtime-repair-evidence.js";
import { ConversationRepairOwner } from "../config/agent/extensions/managed-sessions/relay/conversation-repair.js";
import { HostAccountClient } from "../config/agent/extensions/managed-sessions/relay/host-account-client.js";
import { ManagedHostMutationOwner } from "../config/agent/extensions/managed-sessions/relay/host-mutation-owner.js";
import { HostApprovalStore } from "../config/agent/extensions/managed-sessions/relay/host-approval-store.js";
import { prepareHostApproval, parseHostApprovalRecord, type ModelHostRequest } from "../config/agent/extensions/managed-sessions/relay/host-approval-record.js";
import { hostApprovalQuestion } from "../config/agent/extensions/managed-sessions/relay/host-approval-prompts.js";
import { managedHostAction } from "../config/agent/extensions/managed-sessions/host-tool.js";
import { roomHostCommand } from "../config/agent/extensions/managed-sessions/host-command.js";
import { parseHostCliArgs } from "../config/agent/extensions/managed-sessions/relay/host-cli-args.js";
import { HostAccountOwner } from "../config/agent/extensions/managed-sessions/relay/host-account-owner.js";
import { RelayEventProjector } from "../config/agent/extensions/managed-sessions/relay/event-projector.js";
import { ProjectionResumptionOwner } from "../config/agent/extensions/managed-sessions/relay/projection-resumption.js";
import type { ManagedMatrixClient } from "../config/agent/extensions/managed-sessions/relay/matrix-client.js";
import { AccountStore, accountHosts, ACCOUNT_REQUEST_EVENT } from "../config/agent/extensions/bridge-chat/account-store.js";
import { AccountWorker, type AccountMatrixPort } from "../config/agent/extensions/bridge-chat/account-worker.js";
import { accountRoomProofs, type EnsureRoom } from "../config/agent/extensions/bridge-chat/account-proof.js";
import { MANAGED_PROVENANCE_EVENT } from "../config/agent/extensions/managed-sessions/managed-provenance.js";
import { deriveConversationId, deriveDeliveryId, deriveTranscriptEntryId, type ConversationManifest } from "../config/agent/extensions/managed-sessions/contracts.js";
import { hostActionPolicy, type AccountAction, type AccountAck } from "../config/agent/extensions/managed-sessions/live-workspace-contracts.js";
const operator = "@owner:test", bot = "@host:test", hostSpaceId = "!host:test";
const hosts = accountHosts([{ hostId: "host", botUserId: bot, deviceId: "HOST" }]);
const operation = (n = "a") => `operation_${n.repeat(32)}`;
const delay = () => new Promise<void>(resolve => setTimeout(resolve, 20));

/** Real host/NAS journals and production owners; only Matrix/process observation ports are fake. */
async function fixture(t: { after(fn: () => Promise<void>): void }, name: string, coordinator = false) {
 const root = await mkdtemp(join(tmpdir(), "repair-acceptance-"));
 const creationKey = coordinator ? "coordinator" : name, id = deriveConversationId("host", creationKey);
 const manifest: ConversationManifest = { schemaVersion: "1.0.0", ownerHostId: "host", kind: coordinator ? "coordinator" : "project", conversationId: id,
  creationKey, concept: name, piSessionId: "original-session", roomId: `!${name}:test`, ...(coordinator ? { hostSpace: hostSpaceId } : {}),
  bindingBoundaryEntryId: deriveTranscriptEntryId("original-session", "boundary"), createdAt: "2026-10-01T00:00:00.000Z",
  ...(!coordinator ? { projectKey: `project_${"a".repeat(32)}`, projectDisplayName: "project", checkoutDisplayName: name,
   placement: { rootKey: "projects", workspace: name, relativeCwd: "" } } : {}) };
 const manifests = new ConversationManifestStore(join(root, "manifests")); await manifests.write(manifest);
 if (!coordinator) await manifests.write({ schemaVersion: "1.0.0", ownerHostId: "host", kind: "coordinator", conversationId: deriveConversationId("host", "coordinator"),
  creationKey: "coordinator", concept: "coordinator", piSessionId: "coordinator-session", roomId: "!coordinator:test", hostSpace: hostSpaceId,
  bindingBoundaryEntryId: deriveTranscriptEntryId("coordinator-session", "boundary"), createdAt: manifest.createdAt });
 const file = join(root, "session.jsonl"); await writeFile(file, [
  { type: "session", id: manifest.piSessionId, cwd: root },
  { type: "custom", customType: "managed-session.binding-boundary", id: "boundary", data: { version: "1.0.0", creationKey, concept: name, sessionId: manifest.piSessionId } },
  { type: "message", content: "PRIVATE ORIGINAL HISTORY" },
 ].map(x => JSON.stringify(x)).join("\n") + "\n");
 const registry = new RelayRegistry("host", join(root, "runtime"), manifests); await registry.load();
 const database = join(root, "account.sqlite"); let store = new AccountStore(database, operator), worker: AccountWorker;
 let supported = true, loseInvite = false, loseJoin = false;
 const effects: string[] = []; let member = { eventId: "$original-join", sender: operator, membership: "join" };
 const transport = { sendAccountRequest: async (_u: string, _d: string, _tx: string, action: AccountAction) => {
  if (!supported && action.operation === "room.membership.inspect") return;
  worker.ingest({ to_device: { events: [{ type: ACCOUNT_REQUEST_EVENT, sender: bot, content: action }] } });
 } };
 const client = new HostAccountClient(join(root, "host-account"), "host", operator, "OWNER", transport); await client.load();
 const ensure = await client.request({ operation: "room.ensure", kind: coordinator ? "coordinator" : "conversation", roomId: manifest.roomId, hostSpaceId,
  conversationId: id, creationKey, notificationSetup: "preserve", ...(!coordinator ? { project: { projectKey: manifest.projectKey!, spaceId: "!project:test" },
   checkout: { checkoutId: `checkout_${"b".repeat(32)}`, spaceId: "!checkout:test" } } : {}) }) as EnsureRoom;
 const chain = accountRoomProofs(ensure);
 const snapshots = new Map(chain.map((room, index) => [room.roomId, [
  { type: "m.room.create", state_key: "", sender: bot, content: { "m.federate": false, ...(room.expected.kind.endsWith("_space") ? { type: "m.space" } : {}) } },
  { type: "m.room.join_rules", state_key: "", sender: bot, content: { join_rule: "invite" } },
  { type: MANAGED_PROVENANCE_EVENT, state_key: "", sender: bot, content: { creationKey: "ancestor", ...room.expected } },
  ...(chain[index + 1] ? [{ type: "m.space.child", state_key: chain[index + 1].roomId, sender: bot, content: { via: ["test"] } }] : []),
 ]]));
 const memberEvent = () => ({ type: "m.room.member", state_key: operator, event_id: member.eventId, sender: member.sender, content: { membership: member.membership } });
 const port: AccountMatrixPort = {
  joined: async room => room !== manifest.roomId || member.membership === "join",
  state: async room => { assert.ok(snapshots.has(room)); return [...snapshots.get(room)!, ...(room === manifest.roomId ? [memberEvent()] : [])]; },
  join: async room => { assert.equal(room, manifest.roomId); effects.push(`join:${room}`); member = { eventId: "$repaired-join", sender: operator, membership: "join" }; if (loseJoin) throw Error("lost join response"); },
  leave: async () => assert.fail("repair must not leave"), forget: async () => assert.fail("repair must not forget"), cleanupEligible: async () => false,
  toDevice: async (_type, recipient, device, _tx, content) => { assert.equal(recipient, bot); assert.equal(device, "HOST");
   await client.ingest({ to_device: { events: [{ type: "lol.bepis.pi.account.ack.v1", sender: operator, content }] } }); },
 };
 const rules = { read: async () => undefined, put: async () => assert.fail("repair must preserve notification settings") };
 const restartNas = () => { store.close(); store = new AccountStore(database, operator); worker = new AccountWorker(store, hosts, operator, port, rules); worker.ingest({}); };
 worker = new AccountWorker(store, hosts, operator, port, rules); worker.ingest({});
 const signal = new AbortController().signal;
 const pump = async () => {
  await client.flush(signal);
  worker.ingest(member.membership === "invite" ? { rooms: { invite: { [manifest.roomId]: { invite_state: { events: [...snapshots.get(manifest.roomId)!, memberEvent()] } } } } } : {});
  await worker.step(signal); await worker.flush(signal);
 };
 const matrix = { operatorUserId: operator, botUserId: bot,
  assertManagedProvenance: async (room: string, expected: unknown) => { assert.equal(room, manifest.roomId); assert.deepEqual(snapshots.get(room)!.find(e => e.type === MANAGED_PROVENANCE_EVENT)!.content, expected); },
  operatorMembershipEvent: async (room: string) => { assert.equal(room, manifest.roomId); return { ...member }; },
  inviteOperator: async (room: string) => { assert.equal(room, manifest.roomId); effects.push(`invite:${room}`); member = { eventId: "$repair-invite", sender: bot, membership: "invite" }; if (loseInvite) throw Error("lost invitation response"); },
 } as unknown as ManagedMatrixClient;
 const account = new HostAccountOwner(client, registry, matrix);
 await pump(); assert.equal(store.room(manifest.roomId)?.verified, true);
 const runtime = new RuntimeRepairOwner({ registry, observe: target => observeRuntimeRepair({ manifest, target, file, cwd: root,
  windows: { check: async () => "gone" }, observe: async () => ({ conflicts: false, bootId: "12345678-1234-1234-1234-123456789abc", unreadableProcesses: [] }) }) });
 const repair = new ConversationRepairOwner({ registry, runtime, account });
 t.after(async () => { await repair.close(); await account.close(); store.close(); await rm(root, { recursive: true, force: true }); });
 const preview = async () => {
  for (let i = 0; i < 4; i++) { const result = await repair.preview(id); if (!result.blockers.length) return result; await pump(); }
  return repair.preview(id);
 };
 const settle = async (op: string, afterPump?: () => void) => {
  const deadline = Date.now() + 15_000;
  while (repair.isRunning(op) && Date.now() < deadline) { await pump(); afterPump?.(); await delay(); }
  assert.equal(repair.isRunning(op), false, "bounded original invocation must settle"); await repair.drain();
 };
 return { root, registry, manifest, manifests, file, id, repair, client, effects, preview, settle, pump, restartNas, get store() { return store; },
  leave: () => { member = { eventId: "$original-left", sender: operator, membership: "leave" }; },
  retireNas: () => { store.retire(manifest.roomId); }, unsupported: () => { supported = false; },
  loseInvitation: () => { loseInvite = true; }, loseJoining: () => { loseJoin = true; },
  restoreAck: (op: string): AccountAck | undefined => { const request = client.membershipRequest(op); return request ? client.ack(request.requestId) : undefined; } };
}

for (const name of ["sandbox", "epic644", "coordinator", "pi-harness-backlog", "timeline", "ihp-update"] as const)
 test(`six-incident acceptance: ${name} composes durable host and NAS owners`, async t => {
  const f = await fixture(t, name, name === "coordinator"), original = await readFile(f.file), manifests = await f.manifests.list();
  let ordinal: number | undefined;
  if (name === "sandbox" || name === "epic644") { ordinal = (await f.registry.prepareProjectLaunch(f.id, "n".repeat(64))).ordinal; await f.registry.failLaunch(f.id); }
  if (name === "coordinator") await f.registry.setManagedWindow(f.id, { sessionName: "default", windowId: "@1", paneId: "%1" });
  if (name === "timeline" || name === "ihp-update") f.leave();
  let sends = 0;
  const outputMatrix = { sendText: async () => { sends++; throw Error("offline"); } } as unknown as ManagedMatrixClient;
  if (name === "pi-harness-backlog") await assert.rejects(new RelayEventProjector(f.registry, outputMatrix).projectNotice(f.id, "old", "PRIVATE OLD OUTPUT"), /offline/);
  const input = { deliveryId: deriveDeliveryId(f.id, "$queued"), matrixEventId: "$queued", kind: "prompt", body: "PRIVATE QUEUED WORK", status: "accepted" as const };
  await f.registry.recordAcceptedInput(f.id, input);
  const plan = await f.preview(); assert.deepEqual(plan.blockers, []);
  await f.repair.apply(plan, operation(), { operatorClosed: true }); await f.settle(operation());
  assert.equal(f.registry.conversationRepairReceipt(f.id)?.phase, "complete"); assert.equal(f.restoreAck(operation())?.status, "complete");
  assert.equal(f.registry.conversationState(f.id), "dormant"); assert.deepEqual(f.registry.dispatchableInputs(f.id), []);
  assert.deepEqual(await readFile(f.file), original); assert.deepEqual(await f.manifests.list(), manifests);
  assert.equal(f.store.room(f.manifest.roomId)?.retired, false);
  assert.deepEqual(f.effects, name === "timeline" || name === "ihp-update" ? [`invite:${f.manifest.roomId}`, `join:${f.manifest.roomId}`] : []);
  if (ordinal !== undefined) { assert.equal(f.registry.launchIdentity(f.id), undefined); assert.equal(f.registry.conversationSnapshot(f.id)!.launchHighWater, ordinal); }
  if (name === "coordinator") assert.equal(hostActionPolicy({ operation: "conversation.delete", conversationId: f.id, confirmed: true }, { kind: "human_local", requestId: "deny" }, f.id), "forbidden");
  if (name === "pi-harness-backlog") {
   assert.equal(sends, 1); const tx = f.registry.conversationSnapshot(f.id)!.projection[0].chunks[0].transactionId;
   await f.registry.resumeQueuedWork(f.registry.queueResumptionSnapshot(f.id), operation("b"));
   const output = new ProjectionResumptionOwner(f.registry, { sendText: async (_room: string, transactionId: string) => { assert.equal(transactionId, tx); sends++; } } as unknown as ManagedMatrixClient);
   await output.kick(); await output.close(); assert.equal(sends, 2);
  }
 });

test("NAS restart after positive admission preserves protection and joins the original room once", async t => {
 const f = await fixture(t, "nas-restart"); f.leave(); const plan = await f.preview(); assert.deepEqual(plan.blockers, []);
 await f.repair.apply(plan, operation(), {}); let restarted = false;
 await f.settle(operation(), () => { if (!restarted && f.restoreAck(operation())?.code === "admitted") { restarted = true; f.restartNas(); } });
 assert.equal(restarted, true); assert.equal(f.registry.conversationRepairReceipt(f.id)?.phase, "complete");
 assert.equal(f.effects.filter(e => e.startsWith("invite:")).length, 1); assert.equal(f.effects.filter(e => e.startsWith("join:")).length, 1);
});
test("a lost invite response requires fresh consent and never repeats the original invitation", async t => {
 const f = await fixture(t, "lost-invite"); f.leave(); f.loseInvitation();
 await f.repair.apply(await f.preview(), operation(), {}); await f.settle(operation());
 assert.equal(f.registry.conversationRepairReceipt(f.id)?.phase, "account_pending"); assert.equal(f.effects.length, 1);
 const fresh = await f.preview(); assert.deepEqual(fresh.blockers, []);
 await f.repair.apply(fresh, operation("b"), {}); await f.settle(operation("b"));
 assert.equal(f.registry.conversationRepairReceipt(f.id)?.phase, "complete");
 assert.deepEqual(f.effects, [`invite:${f.manifest.roomId}`, `join:${f.manifest.roomId}`]);
});
test("lost NAS join response reconciles observed join without another HTTP join", async t => {
 const f = await fixture(t, "lost-join"); f.leave(); f.loseJoining();
 await f.repair.apply(await f.preview(), operation(), {}); await f.settle(operation());
 assert.equal(f.registry.conversationRepairReceipt(f.id)?.phase, "complete");
 assert.deepEqual(f.effects, [`invite:${f.manifest.roomId}`, `join:${f.manifest.roomId}`]);
});
test("terminal NAS originals and older unsupported NAS leave host state untouched", async t => {
 for (const kind of ["terminal", "unsupported"] as const) {
  const f = await fixture(t, kind); f.leave(); if (kind === "terminal") f.retireNas(); else f.unsupported();
  const before = f.registry.snapshot(); const plan = await f.preview(); assert.ok(plan.blockers.length);
  await assert.rejects(f.repair.apply(plan, operation(), {}), /changed/);
  assert.deepEqual(f.registry.snapshot(), before); assert.deepEqual(f.effects, []);
 }
});
test("repair consent round-trips the shared durable approval store and all frontend grammars", async t => {
 const f = await fixture(t, "approval"); assert.deepEqual((await f.preview()).blockers, []);
 const owner = new ManagedHostMutationOwner({ registry: f.registry, repairs: f.repair, lifecycle: {} as never, retirement: {} as never, server: { attachment: () => undefined } });
 const preview = await owner.preview({ operation: "conversation.repair.preview", conversationId: f.id }); assert.deepEqual(preview.blockers, []);
 const action = { operation: "conversation.repair.apply" as const, previewId: preview.previewId, confirmed: true as const };
 assert.deepEqual(managedHostAction(action), action);
 assert.deepEqual(roomHostCommand(`!host conversation repair apply --preview-id ${preview.previewId} --confirmed`, f.id), action);
 const cli = parseHostCliArgs(["conversation", "repair", "apply", "--preview-id", preview.previewId, "--confirmed"]);
 assert.ok("request" in cli); assert.deepEqual(cli.request.action, action);
 const request: ModelHostRequest = { version: "1.0.0", action, actor: { kind: "model", requestId: "repair", conversationId: f.id,
  generationId: f.registry.activeGeneration(f.manifest).generationId, runId: "run", toolCallId: "call", presentation: "local_dialog" } };
 await assert.rejects(owner.executeHuman(request), /independent consent/);
 const frozen = await owner.freeze(request); const record = prepareHostApproval("host", request, frozen, Date.now());
 const question = hostApprovalQuestion(record); assert.ok(question.length <= 4096); assert.ok(!question.includes("PRIVATE"));
 assert.match(question, /No queue-management choice is required/);
 assert.throws(() => parseHostApprovalRecord({ ...record, frozen: { ...record.frozen, effects: [{ operation: "conversation.open", conversationId: f.id }] } }), /changed/);
 const directory = join(f.root, "approvals"); const store = new HostApprovalStore(directory, "host"); await store.load(); await store.prepare(record); await store.close();
 const reopened = new HostApprovalStore(directory, "host"); await reopened.load(); t.after(() => reopened.close());
 assert.deepEqual(reopened.get(record.approvalId), record);
 await reopened.transition(record.approvalId, { phase: "presented", presentation: { kind: "local_dialog", id: "dialog" } });
 await reopened.transition(record.approvalId, { phase: "approved", decision: { choice: "approve", at: Date.now(), voter: { kind: "local" } } });
 const accepted = await reopened.transition(record.approvalId, { phase: "accepted", acceptedAt: Date.now() });
 assert.equal(await owner.revalidate(accepted), true); await owner.execute(accepted);
 await f.settle(accepted.approvalId.replace("approval_", "operation_"));
 assert.equal(f.registry.conversationRepairReceipt(f.id)?.phase, "complete");
});
