import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostAccountClient, type AccountActionBody } from "../config/agent/extensions/managed-sessions/relay/host-account-client.js";
import { AccountStore, ACCOUNT_REQUEST_EVENT } from "../config/agent/extensions/bridge-chat/account-store.js";
import { AccountWorker, type AccountMatrixPort } from "../config/agent/extensions/bridge-chat/account-worker.js";
import { accountRoomProofs, AccountProofError, type EnsureRoom } from "../config/agent/extensions/bridge-chat/account-proof.js";
import type { AccountAction, AccountAck } from "../config/agent/extensions/managed-sessions/live-workspace-contracts.js";
import { MANAGED_PROVENANCE_EVENT } from "../config/agent/extensions/managed-sessions/managed-provenance.js";
const owner = "@owner:test", bot = "@host:test", hosts = [{ hostId: "host", botUserId: bot, deviceId: "HOST" }];
const signal = () => new AbortController().signal;
const stable = (prefix: string, n: number) => `${prefix}_${n.toString(16).padStart(32, "0")}`;
type Event = { type: string; state_key: string; sender: string; content: Record<string, unknown>; event_id?: string };
type Transmission = { txn: string; ack: AccountAck };
async function fixture(t: { after(fn: () => Promise<void>): void }) {
 const root = await mkdtemp(join(tmpdir(), "account-delivery-acceptance-")); let now = 1_000_000;
 const unavailable = new Set<string>(), retired = new Set<string>(), joined = new Set<string>(), snapshots = new Map<string, Event[]>();
 const hostSends: Array<{ txn: string; action: AccountAction }> = [], nasSends: Transmission[] = [], held: Transmission[] = [], effects: string[] = [];
 let hold = false, loseAck = false, loseHost = false;
 let store = new AccountStore(join(root, "nas.sqlite"), owner, () => now), worker: AccountWorker;
 const transport = { sendAccountRequest: async (_user: string, _device: string, txn: string, action: AccountAction) => {
  hostSends.push({ txn, action }); worker.ingest({ to_device: { events: [{ type: ACCOUNT_REQUEST_EVENT, sender: bot, content: action }] } });
  if (loseHost) { loseHost = false; throw Error("injected host response loss"); }
 } };
 let client = new HostAccountClient(join(root, "host"), "host", owner, "NAS", transport, () => now); await client.load(); client.bindMembershipAuthority(id => !retired.has(id));
 const deliver = (value: Transmission) => client.ingest({ to_device: { events: [{ type: "lol.bepis.pi.account.ack.v1", sender: owner, content: value.ack }] } });
 const port: AccountMatrixPort = {
  joined: async room => joined.has(room),
  state: async room => { if (unavailable.has(room) || !snapshots.has(room)) throw new AccountProofError("unverified");
   return [...snapshots.get(room)!, { type: "m.room.member", state_key: owner, sender: owner, event_id: "$joined", content: { membership: "join" } }]; },
  join: async room => { effects.push(`join:${room}`); joined.add(room); }, leave: async room => { effects.push(`leave:${room}`); joined.delete(room); },
  forget: async room => { effects.push(`forget:${room}`); }, cleanupEligible: async () => true,
  toDevice: async (_type, recipient, device, txn, value) => {
   assert.equal(recipient, bot); assert.equal(device, "HOST"); const frame = { txn, ack: structuredClone(value) as AccountAck }; nasSends.push(frame);
   if (hold) held.push(frame); else await deliver(frame);
   if (loseAck) { loseAck = false; throw Error("injected NAS response loss"); }
  },
 };
 const rules = { read: async () => undefined, put: async () => assert.fail("preserved policy must not be changed") };
 worker = new AccountWorker(store, hosts, owner, port, rules, () => now); worker.ingest({});
 t.after(async () => { await client.close(); store.close(); await rm(root, { recursive: true, force: true }); });
 const ensure = async (n: number, unknown = false, project = false) => {
  const a = await client.request({ operation: "room.ensure", kind: project ? "conversation" : "coordinator", roomId: `!room${n}:test`, hostSpaceId: "!host:test", conversationId: stable("conv", n), creationKey: `room${n}`, notificationSetup: "preserve",
   ...(project ? { project: { projectKey: stable("project", 1), spaceId: "!project:test" }, checkout: { checkoutId: stable("checkout", 1), spaceId: "!checkout:test" } } : {}) }) as EnsureRoom;
  const chain = accountRoomProofs(a);
  for (const [i, p] of chain.entries()) {
   if (!snapshots.has(p.roomId)) snapshots.set(p.roomId, [
    { type: "m.room.create", state_key: "", sender: bot, content: { "m.federate": false, ...(p.expected.kind.endsWith("_space") ? { type: "m.space" } : {}) } },
    { type: "m.room.join_rules", state_key: "", sender: bot, content: { join_rule: "invite" } },
    { type: MANAGED_PROVENANCE_EVENT, state_key: "", sender: bot, content: { creationKey: "ancestor", ...p.expected } },
   ]);
   const child = chain[i + 1]; if (child && !snapshots.get(p.roomId)!.some(e => e.type === "m.space.child" && e.state_key === child.roomId)) snapshots.get(p.roomId)!.push({ type: "m.space.child", state_key: child.roomId, sender: bot, content: { via: ["test"] } });
   joined.add(p.roomId);
  }
  if (unknown) unavailable.add(a.roomId); return a;
 };
 const turn = async () => {
  try { await client.flush(signal()); } catch (error) { assert.match(String(error), /injected host response loss/); }
  await worker.step(signal());
  try { await worker.flush(signal()); } catch (error) { assert.match(String(error), /injected NAS response loss/); }
 };
 const warm = async (n: number) => { for (let i = 1; i <= n; i++) { const a = await ensure(i); await turn(); assert.equal(client.ack(a.requestId)?.status, "complete"); } };
 const inspect = (n: number, room = 1) => client.request({ operation: "room.membership.inspect", roomId: `!room${room}:test`, conversationId: stable("conv", room), membershipEventId: `$observation${n}` });
 const backlog = async () => {
  for (let i = 100; i < 103; i++) await ensure(i, true);
  const cleanup: AccountAction[] = [];
  for (let i = 200; i < 212; i++) { const a = await ensure(i, true, true); retired.add(a.conversationId!);
   cleanup.push(await client.request({ operation: "room.retire", roomId: a.roomId, conversationId: a.conversationId!, retirementId: stable("retirement", i) })); }
  return cleanup;
 };
 const restore = (expiresAt: number): AccountActionBody => ({ operation: "room.membership.restore", roomId: "!room1:test", conversationId: stable("conv", 1), hostSpaceId: "!host:test", operationId: stable("operation", 1), sourceDigest: "a".repeat(64), expiresAt, membership: "join", membershipEventId: "$joined" });
 return { get client() { return client; }, get store() { return store; }, get now() { return now; }, turn, warm, ensure, inspect, backlog, restore, hostSends, nasSends, held, effects, deliver,
  advance: (ms: number) => { now += ms; }, hold: (v: boolean) => { hold = v; }, loseAck: () => { loseAck = true; }, loseHost: () => { loseHost = true; },
  reveal: (room: string) => unavailable.delete(room),
  restart: async () => { await client.close(); store.close(); store = new AccountStore(join(root, "nas.sqlite"), owner, () => now);
   client = new HostAccountClient(join(root, "host"), "host", owner, "NAS", transport, () => now); await client.load(); client.bindMembershipAuthority(id => !retired.has(id));
   worker = new AccountWorker(store, hosts, owner, port, rules, () => now); worker.ingest({}); },
 };
}

test("loaded durable host/NAS exchange bounds foreground turns and preserves maintenance/cleanup service", async t => {
 const f = await fixture(t); await f.warm(50); f.advance(76_000); const cleanup = await f.backlog(), start = f.hostSends.length;
 const target = await f.inspect(1); let turns = 0;
 while (!f.client.ack(target.requestId) && turns < 20) { await f.turn(); turns++; }
 assert.equal(f.client.ack(target.requestId)?.status, "complete"); assert.ok(turns <= 20);
 const expiresAt = f.now + 300_000, restore = await f.client.request(f.restore(expiresAt));
 let traffic = 1000;
 for (let i = 0; i < 100 && f.client.ack(restore.requestId)?.code !== "admitted"; i++) { await f.inspect(traffic++); await f.turn(); }
 assert.equal(f.client.ack(restore.requestId)?.code, "admitted");
 await f.client.request({ operation: "room.membership.authorize", roomId: restore.roomId, conversationId: stable("conv", 1), restoreRequestId: restore.requestId, membership: "join", membershipEventId: "$joined" });
 for (let i = 0; i < 100 && f.client.ack(restore.requestId)?.status !== "complete"; i++) { await f.inspect(traffic++); await f.turn(); }
 assert.equal(f.client.ack(restore.requestId)?.status, "complete"); assert.equal((f.store.get(restore.requestId)!.action as Extract<AccountAction, { operation: "room.membership.restore" }>).expiresAt, expiresAt);
 for (const a of cleanup) f.reveal(a.roomId); f.advance(300_001);
 for (let i = 0; i < 300 && !cleanup.every(a => f.client.ack(a.requestId)?.status === "complete"); i++) { f.advance(1000); await f.inspect(traffic++); await f.turn(); }
 assert.ok(cleanup.every(a => f.client.ack(a.requestId)?.status === "complete"), `continuous foreground must not starve cleanup: ${JSON.stringify(cleanup.map(a => ({ host: f.client.ack(a.requestId)?.status, nas: f.store.get(a.requestId)?.ack?.status, code: f.store.get(a.requestId)?.ack?.code })))}`);
 assert.ok(f.hostSends.slice(start).some(r => r.action.operation === "room.ensure" && r.action.kind === "coordinator"), "completed maintenance gets service");
 assert.equal(f.effects.filter(e => e.startsWith("forget:")).length, 12); assert.equal(f.effects.filter(e => e.startsWith("join:")).length, 0);
 for (const a of cleanup) assert.equal(f.store.room(a.roomId)?.retired, true);
});

test("loaded restart keeps parked obligations and avoids an immediate retry storm", async t => {
 const f = await fixture(t); await f.warm(50); const cleanup = await f.backlog();
 for (let i = 0; i < 150; i++) {
  await f.turn();
  if (f.client.diagnostics().classes.every(r => r.due === 0) && f.store.diagnostics(hosts, "idle").classes.every(r => r.due === 0)) break;
 }
 for (const a of cleanup) { assert.equal(f.client.ack(a.requestId)?.code, "unverified"); assert.equal(f.store.room(a.roomId)?.retired, true); }
 for (let i = 100; i < 103; i++) { const a = await f.ensure(i); assert.equal(f.client.ack(a.requestId)?.code, "unverified"); }
 const before = [f.hostSends.length, f.nasSends.length]; await f.restart();
 for (let i = 0; i < 10; i++) await f.turn(); f.advance(29_999); await f.turn();
 assert.deepEqual([f.hostSends.length, f.nasSends.length], before);
 assert.equal(cleanup.length, 12); assert.equal(f.effects.length, 0);
});

test("lost NAS ack plus host redelivery and both-store restart retains the exact uncertain transaction", async t => {
 const f = await fixture(t); await f.warm(1); const a = await f.inspect(1); f.hold(true); f.loseAck(); await f.turn();
 const first = f.nasSends.find(v => v.ack.requestId === a.requestId)!; assert.ok(first); assert.equal(f.client.ack(a.requestId), undefined);
 await f.restart(); const before = f.nasSends.length; await f.turn(); assert.equal(f.nasSends.length, before, "restart must not reset retry hints");
 f.advance(30_000); await f.turn(); const retry = f.nasSends.filter(v => v.ack.requestId === a.requestId)[1];
 assert.deepEqual(retry, first, "host redelivery must not replace an uncertain NAS outbox transmission");
 await f.deliver(retry); assert.equal(f.client.ack(a.requestId)?.status, "complete");
 f.hold(false); f.advance(120_001); await f.inspect(1); await f.turn();
 assert.ok(f.client.ack(a.requestId)!.revision > first.ack.revision, "fresh inspection still recomputes after uncertain transmission is drained");
});

test("host uncertain send reuses its transaction after both stores reload", async t => {
 const f = await fixture(t); const a = await f.ensure(1); f.loseHost(); await f.turn();
 assert.equal(f.client.ack(a.requestId)?.status, "complete"); const first = f.hostSends[0];
 await f.restart(); await f.turn(); assert.equal(f.hostSends.length, 1);
 f.advance(76_000); await f.turn(); assert.equal(f.hostSends[1].txn, first.txn); assert.deepEqual(f.hostSends[1].action, first.action);
});

test("delayed older NAS progress cannot regress newer verification at the host", async t => {
 const f = await fixture(t); await f.ensure(100, true); await f.turn(); const a = await f.inspect(1, 100); f.hold(true);
 for (let i = 0; i < 10 && !f.held.some(v => v.ack.requestId === a.requestId); i++) await f.turn();
 const old = f.held.find(v => v.ack.requestId === a.requestId)!; assert.equal(old.ack.status, "pending");
 f.reveal("!room100:test"); f.advance(300_001);
 for (let i = 0; i < 20 && !f.held.some(v => v.ack.requestId === a.requestId && v.ack.status === "complete"); i++) await f.turn();
 const latest = f.held.find(v => v.ack.requestId === a.requestId && v.ack.status === "complete")!; assert.ok(latest); assert.ok(latest.ack.revision > old.ack.revision);
 await f.deliver(latest); await f.deliver(old); assert.deepEqual(f.client.ack(a.requestId), latest.ack);
});

test("loaded membership approval expiry survives restart and late authorization without extension", async t => {
 const f = await fixture(t); await f.warm(50); await f.backlog(); const expiresAt = f.now + 1000, r = await f.client.request(f.restore(expiresAt));
 for (let i = 0; i < 40 && f.client.ack(r.requestId)?.code !== "admitted"; i++) await f.turn();
 assert.equal(f.client.ack(r.requestId)?.code, "admitted");
 await f.restart(); f.advance(1001);
 const a = await f.client.request({ operation: "room.membership.authorize", roomId: r.roomId, conversationId: stable("conv", 1), restoreRequestId: r.requestId, membership: "join", membershipEventId: "$joined" });
 for (let i = 0; i < 30; i++) { await f.inspect(2000 + i); await f.turn(); }
 assert.equal(f.hostSends.some(v => v.action.requestId === a.requestId), false); assert.notEqual(f.client.ack(r.requestId)?.status, "complete");
 assert.equal((f.store.get(r.requestId)!.action as Extract<AccountAction, { operation: "room.membership.restore" }>).expiresAt, expiresAt);
 assert.equal(f.effects.filter(e => e.startsWith("join:")).length, 0);
});
