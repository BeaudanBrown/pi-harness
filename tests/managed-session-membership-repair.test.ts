import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostAccountClient } from "../config/agent/extensions/managed-sessions/relay/host-account-client.js";
import { MembershipRepairOwner } from "../config/agent/extensions/managed-sessions/relay/membership-repair.js";
import { HostAccountOwner } from "../config/agent/extensions/managed-sessions/relay/host-account-owner.js";
import { deriveConversationId } from "../config/agent/extensions/managed-sessions/contracts.js";
import type { RelayRegistry } from "../config/agent/extensions/managed-sessions/relay/registry.js";
import type { ManagedMatrixClient } from "../config/agent/extensions/managed-sessions/relay/matrix-client.js";
import type { AccountAction, AccountAck } from "../config/agent/extensions/managed-sessions/live-workspace-contracts.js";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
 const dir = await mkdtemp(join(tmpdir(), "membership-repair-")); t.after(() => rm(dir, { recursive: true, force: true }));
 let now = 100_000; const sent: AccountAction[] = []; const transport = { sendAccountRequest: async (_u: string, _d: string, _tx: string, action: AccountAction) => { sent.push(action); } };
 let client = new HostAccountClient(dir, "host", "@owner:test", "OWNER", transport, () => now); await client.load();
 const identity = { conversationId: `conv_${"a".repeat(32)}`, roomId: "!room:test", hostSpaceId: "!host:test", operatorUserId: "@owner:test", botUserId: "@bot:test", sourceDigest: "a".repeat(64) };
 let member = { eventId: "$left", sender: "@owner:test", membership: "leave" }; let terminal = false, invites = 0, lose = false;
 const owner = () => new MembershipRepairOwner({ client, now: () => now, identity: async () => { if (terminal) throw Error("terminal"); return { ...identity }; },
  member: async () => ({ ...member }), invite: async () => { invites++; if (lose) throw Error("lost response"); member = { eventId: "$invite", sender: identity.botUserId, membership: "invite" }; } });
 const acknowledge = async (a: AccountAction, extra: Partial<AccountAck> = {}) => client.ingest({ to_device: { events: [{ type: "lol.bepis.pi.account.ack.v1", sender: "@owner:test", content: {
  version: a.version, hostId: a.hostId, requestId: a.requestId, payloadDigest: a.payloadDigest, status: "complete", revision: 1, ...extra } }] } });
 const supported = async (retired = false) => {
  await assert.rejects(owner().snapshot(identity.conversationId), /unconfirmed/); await client.flush(new AbortController().signal);
  await acknowledge(sent.at(-1)!, { membershipRepair: { capability: "original-room-repair-v1", retired } });
 };
 return { identity, owner, supported, acknowledge, get client() { return client; }, get invites() { return invites; }, setMember: (v: typeof member) => { member = v; },
  retire: () => { terminal = true; }, lose: () => { lose = true; }, advance: () => { now += 400_000; },
  restart: async () => { await client.close(); client = new HostAccountClient(dir, "host", "@owner:test", "OWNER", transport, () => now); await client.load(); } };
}
for (const scenario of ["missing", "unsupported", "unverified", "stale", "terminal_stale", "ready"] as const)
 test(`repair inspection distinguishes ${scenario} evidence without effects`, async t => {
  const f = await fixture(t);
  const request = await f.client.request({ operation: "room.membership.inspect", roomId: f.identity.roomId, conversationId: f.identity.conversationId, membershipEventId: "$left" });
  if (scenario !== "missing") await f.acknowledge(request, {
   ...(scenario === "unverified" ? { status: "pending" as const, code: "unverified" as const } : {}),
   ...(scenario !== "unsupported" ? { membershipRepair: { capability: "original-room-repair-v1" as const, retired: scenario === "terminal_stale" } } : {}) });
  if (scenario === "stale" || scenario === "terminal_stale") f.advance();
  const messages = { missing: /awaiting an inspection response/, unsupported: /lacks the required repair capability/, unverified: /supports original-room repair.*authority is unverified/, stale: /evidence is stale/, terminal_stale: /terminal on NAS/ };
  if (scenario === "ready") await assert.doesNotReject(f.owner().snapshot(f.identity.conversationId));
  else await assert.rejects(f.owner().snapshot(f.identity.conversationId), messages[scenario]);
  assert.equal(f.invites, 0); await f.client.close();
 });
const op = `operation_${"a".repeat(32)}`;
for (const kind of ["project", "coordinator"] as const) test(`production ${kind} adapter binds original provenance and rechecks terminal authority after I/O`, async t => {
 const f = await fixture(t); const coordinatorId = deriveConversationId("host", "coordinator");
 const manifest = { kind, conversationId: kind === "coordinator" ? coordinatorId : f.identity.conversationId, roomId: f.identity.roomId, creationKey: "original", projectKey: `project_${"a".repeat(32)}` };
 let terminal = false, duringProof = false, proofs = 0;
 const registry = { hostId: "host", retirement: () => terminal ? {} : undefined, archiveRecord: () => undefined,
  manifestByConversationId: (id: string) => id === manifest.conversationId ? { ...manifest, hostSpace: "!host:test" } : id === coordinatorId ? { hostSpace: "!host:test" } : undefined } as unknown as RelayRegistry;
 const matrix = { operatorUserId: "@owner:test", botUserId: "@bot:test", assertManagedProvenance: async (room: string, proof: { kind: string }) => {
  proofs++; assert.equal(room, manifest.roomId); assert.equal(proof.kind, kind === "project" ? "conversation" : "coordinator"); if (duringProof) terminal = true;
 }, operatorMembershipEvent: async () => ({ eventId: "$left", sender: "@owner:test", membership: "leave" }) } as unknown as ManagedMatrixClient;
 const account = new HostAccountOwner(f.client, registry, matrix);
 await f.client.request({ operation: "room.ensure", kind: kind === "project" ? "conversation" : "coordinator", roomId: manifest.roomId, conversationId: manifest.conversationId,
  creationKey: manifest.creationKey, hostSpaceId: "!host:test", notificationSetup: "preserve", ...(kind === "project" ? { project: { projectKey: manifest.projectKey, spaceId: "!project:test" }, checkout: { checkoutId: `checkout_${"b".repeat(32)}`, spaceId: "!checkout:test" } } : {}) });
 await assert.rejects(account.freezeRoomMembership(manifest.conversationId), /unconfirmed/);
 const inspect = await f.client.request({ operation: "room.membership.inspect", roomId: manifest.roomId, conversationId: manifest.conversationId, membershipEventId: "$left" });
 await f.acknowledge(inspect, { membershipRepair: { capability: "original-room-repair-v1", retired: false } });
 assert.equal((await account.freezeRoomMembership(manifest.conversationId)).identity.roomId, manifest.roomId);
 duringProof = true; await assert.rejects(account.freezeRoomMembership(manifest.conversationId), /terminal/);
 const before = proofs; await assert.rejects(account.freezeRoomMembership(manifest.conversationId), /terminal/); assert.equal(proofs, before);
});
test("missing NAS support and terminal NAS flags cause zero invitation effects", async t => {
 const f = await fixture(t); await f.supported(true);
 await assert.rejects(f.owner().snapshot(f.identity.conversationId), /not restorable/); assert.equal(f.invites, 0);
});
test("durable NAS admission precedes invitation; accepted invite and join reconcile the same operation", async t => {
 const f = await fixture(t); await f.supported(); const plan = JSON.parse(JSON.stringify(await f.owner().snapshot(f.identity.conversationId)));
 assert.equal((await f.owner().reconcile(plan, op, 300_000)).setupState, "pending"); assert.equal(f.invites, 0);
 const request = f.client.membershipRequest(op)!; await f.acknowledge(request, { status: "pending", code: "admitted" });
 await f.restart(); await f.owner().reconcile(plan, op, 300_000); assert.equal(f.invites, 1);
 await f.owner().reconcile(plan, op, 300_000); assert.equal(f.invites, 1);
 f.setMember({ eventId: "$joined", sender: "@owner:test", membership: "join" });
 await f.acknowledge(request, { status: "pending", code: "join_observed", revision: 2 });
 assert.equal((await f.owner().reconcile(plan, op, 300_000)).setupState, "pending");
 await f.acknowledge(request, { revision: 3 });
 const inspect = await f.client.request({ operation: "room.membership.inspect", roomId: f.identity.roomId, conversationId: f.identity.conversationId, membershipEventId: "$joined" });
 await f.acknowledge(inspect, { membershipRepair: { capability: "original-room-repair-v1", retired: false } });
 assert.equal((await f.owner().reconcile(plan, op, 300_000)).setupState, "ready");
 f.retire(); await assert.rejects(f.owner().reconcile(plan, op, 300_000), /terminal/);
});
test("uncertain invite, new departure, operation mutation and expiry never blindly replay", async t => {
 const f = await fixture(t); await f.supported(); const plan = await f.owner().snapshot(f.identity.conversationId);
 await f.owner().reconcile(plan, op, 300_000); await f.acknowledge(f.client.membershipRequest(op)!, { status: "pending", code: "admitted" });
 f.lose(); await assert.rejects(f.owner().reconcile(plan, op, 300_000), /lost/); await f.restart();
 await assert.rejects(f.owner().reconcile(plan, op, 300_000), /uncertain/); assert.equal(f.invites, 1);
 await assert.rejects(f.owner().reconcile(plan, op, 300_001), /scope changed/);
 f.setMember({ eventId: "$new-left", sender: "@owner:test", membership: "leave" }); await assert.rejects(f.owner().reconcile(plan, op, 300_000), /evidence changed/);
 f.setMember(plan.member); f.advance(); await assert.rejects(f.owner().reconcile(plan, op, 300_000), /expired/);
});
test("departure protection is exact and terminal cancellation is durable", async t => {
 const f = await fixture(t); await f.supported(); const plan = await f.owner().snapshot(f.identity.conversationId);
 await f.owner().reconcile(plan, op, 300_000);
 assert.equal(f.client.protectsDeparture(f.identity.conversationId, "$left"), false);
 await f.acknowledge(f.client.membershipRequest(op)!, { status: "pending", code: "admitted" });
 assert.equal(f.client.protectsDeparture(f.identity.conversationId, "$left"), true);
 assert.equal(f.client.protectsDeparture(f.identity.conversationId, "$later"), false);
 assert.equal(f.client.protectsDeparture(f.identity.conversationId, undefined), false);
 await f.client.cancelRetired(id => id === f.identity.conversationId); await f.restart();
 assert.equal(f.client.protectsDeparture(f.identity.conversationId, "$left"), false);
});

test("every uncaused membership transition invalidates consent before join authorization", async t => {
 for (const membership of ["leave", "invite", "join"] as const) {
  const f = await fixture(t); const member = { eventId: "$frozen", membership, sender: membership === "invite" ? "@bot:test" : "@owner:test" }; f.setMember(member);
  await f.supported(); const plan = await f.owner().snapshot(f.identity.conversationId);
  await f.owner().reconcile(plan, op, 300_000); const request = f.client.membershipRequest(op)!;
  await f.acknowledge(request, { status: "pending", code: "admitted" });
  for (const changed of ["leave", "invite", "join"] as const) {
   f.setMember({ eventId: "$changed", membership: changed, sender: changed === "invite" ? "@bot:test" : "@owner:test" });
   await assert.rejects(f.owner().reconcile(plan, op, 300_000), /evidence changed/);
   assert.equal(f.client.membershipAuthorization(request.requestId), undefined);
  }
 }
});

test("ban, unknown membership and foreign invitations remain external obligations", async t => {
 const f = await fixture(t);
 for (const membership of ["ban", "unknown", "invite"]) {
  f.setMember({ eventId: "$foreign", sender: "@foreign:test", membership });
  await assert.rejects(f.owner().snapshot(f.identity.conversationId), /external action/);
 }
 assert.equal(f.invites, 0);
});
