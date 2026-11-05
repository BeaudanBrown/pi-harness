import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HostAccountClient, type AccountActionBody } from "../config/agent/extensions/managed-sessions/relay/host-account-client.js";
import { MatrixError } from "../config/agent/extensions/matrix-shared/http.js";
import { AtomicJsonFile } from "../config/agent/extensions/managed-sessions/relay/atomic-json.js";
import { AccountDeliverySchedule, accountDeliveryClass, type SchedulableAccountRecord, DeliveryWake } from "../config/agent/extensions/managed-sessions/relay/account-delivery-schedule.js";
import { accountActionIdentity, parseAccountAction, type AccountAction, type AccountAck } from "../config/agent/extensions/managed-sessions/live-workspace-contracts.js";
const owner = "@owner:test", signal = () => new AbortController().signal;
function ensure(n: number): AccountActionBody { return { operation: "room.ensure", kind: "coordinator", roomId: `!room${n}:test`, hostSpaceId: "!host:test", creationKey: `room${n}`, conversationId: `conv_${n.toString(16).padStart(32, "0")}`, notificationSetup: "preserve" }; }
function inspect(n: number): AccountActionBody { return { operation: "room.membership.inspect", roomId: `!room${n}:test`, conversationId: `conv_${n.toString(16).padStart(32, "0")}`, membershipEventId: `$member${n}` }; }
async function fixture(t: { after(fn: () => Promise<void>): void }) {
 const directory = await mkdtemp(join(tmpdir(), "account-scheduling-")); let now = 1000; let fail: boolean | Error = false; let live = true;
 const sent: Array<{ action: AccountAction; txn: string }> = [];
 let onSend = () => {};
 const port = { sendAccountRequest: async (_u: string, _d: string, txn: string, action: AccountAction) => { sent.push({ action, txn }); onSend(); if (fail) throw fail instanceof Error ? fail : Error("lost reply"); } };
 let client = new HostAccountClient(directory, "host", owner, "NAS", port, () => now); await client.load(); client.bindMembershipAuthority(() => live);
 t.after(async () => { await client.close(); await rm(directory, { recursive: true, force: true }); });
 const ack = async (a: AccountAction, status: AccountAck["status"] = "complete", code?: AccountAck["code"], revision = 1) => {
  await client.ingest({ to_device: { events: [{ type: "lol.bepis.pi.account.ack.v1", sender: owner, content: { version: a.version, hostId: a.hostId, requestId: a.requestId, payloadDigest: a.payloadDigest, revision, status, ...(code ? { code } : {}) } }] } });
 };
 return { directory, sent, ack, retire: () => { live = false; }, get client() { return client; }, advance: (ms: number) => { now += ms; }, fail: (value: boolean | Error) => { fail = value; }, onSend: (fn: () => void) => { onSend = fn; },
  restart: async () => { await client.close(); client = new HostAccountClient(directory, "host", owner, "NAS", port, () => now); await client.load(); client.bindMembershipAuthority(() => live); },
  saved: async () => JSON.parse(await readFile(join(directory, "account.json"), "utf8")) };
}
test("negative retries retain the control lane even with unverified progress", async t => {
 const f = await fixture(t);
 const bodies: AccountActionBody[] = [
  { operation: "room.retire", roomId: "!retired:test", conversationId: `conv_${"a".repeat(32)}`, retirementId: `retirement_${"a".repeat(32)}` },
  { operation: "space.retire", roomId: "!space:test", hostSpaceId: "!host:test", cleanupId: `cleanup_${"a".repeat(32)}` },
  { operation: "room.membership.cancel", roomId: "!room:test", conversationId: `conv_${"a".repeat(32)}`, operationId: `operation_${"a".repeat(32)}` },
 ];
 for (const body of bodies) { const action = await f.client.request(body); await f.ack(action, "pending", "unverified");
  assert.equal(accountDeliveryClass({ action, ack: f.client.ack(action.requestId) }), "control"); }
 assert.equal(f.client.diagnostics().classes.find(r => r.kind === "control")!.parked, 3);
 assert.equal(await f.client.flush(signal()), false, "priority does not bypass retry timing");
});
test("host same-lane service follows oldest due rather than oldest last-send", async t => {
 const f = await fixture(t), a = await f.client.request(ensure(1)), b = await f.client.request(ensure(2));
 await f.ack(a, "pending"); await f.ack(b, "pending");
 const late = { action: a, ack: f.client.ack(a.requestId), sentAt: 100, delivery: { attempts: 2, nextAt: 2000 } };
 const early = { action: b, ack: f.client.ack(b.requestId), sentAt: 200, delivery: { attempts: 1, nextAt: 1000 } };
 assert.equal(new AccountDeliverySchedule().select([late, early], 3000), early);
});
test("host children inherit earliest original expiry for equal-due selection", () => {
 const action = (body: AccountActionBody) => { const full = { ...body, version: "1.0.0", hostId: "host" }; return parseAccountAction({ ...full, ...accountActionIdentity(full) }); };
 const parent = (expiry: number, digit: string) => action({ operation: "room.membership.restore", roomId: "!room:test", conversationId: `conv_${"a".repeat(32)}`, hostSpaceId: "!host:test", operationId: `operation_${digit.repeat(32)}`, sourceDigest: "a".repeat(64), expiresAt: expiry, membership: "join", membershipEventId: "$joined" });
 const soon = parent(5000, "a"), later = parent(9000, "b");
 const child = (p: AccountAction, suffix: number) => action({ operation: "room.membership.authorize", roomId: p.roomId, conversationId: `conv_${"a".repeat(32)}`, restoreRequestId: p.requestId, membership: "join", membershipEventId: `$joined${suffix}` });
 const urgent = child(soon, 0); let delayed = child(later, 0);
 for (let i = 1; delayed.requestId > urgent.requestId && i < 100; i++) delayed = child(later, i);
 assert.ok(delayed.requestId < urgent.requestId, "fixture distinguishes expiry from request-ID ordering");
 const records: SchedulableAccountRecord[] = [delayed, urgent].map(a => ({ action: a, delivery: { attempts: 0, nextAt: 1000 } }));
 assert.equal(new AccountDeliverySchedule().select(records, 1000, [{ action: soon }, { action: later }])?.action.requestId, urgent.requestId);
});
test("new arrivals persist enqueue due time and cannot perpetually jump overdue same-lane work", async t => {
 const f = await fixture(t), old = await f.client.request(inspect(1)); await f.ack(old, "pending"); f.advance(35_000);
 const fresh = await f.client.request(inspect(2));
 assert.equal((await f.saved()).records.find((r: { action: AccountAction }) => r.action.requestId === fresh.requestId).delivery.nextAt, 36_000);
 await f.client.flush(signal()); assert.equal(f.sent[0].action.requestId, old.requestId);
});

test("host diagnostics are read-only aggregates with accurate retry age and in-flight state", async t => {
 const f = await fixture(t), a = await f.client.request(inspect(1));
 const before = await readFile(join(f.directory, "account.json"), "utf8");
 assert.equal(f.client.diagnostics().classes.find(r => r.kind === "interactive")!.due, 1);
 assert.equal(await readFile(join(f.directory, "account.json"), "utf8"), before);
 f.onSend(() => assert.equal(f.client.diagnostics().classes.reduce((n, r) => n + r.inFlight, 0), 1));
 await f.client.flush(signal()); await f.ack(a, "pending", "unverified");
 const parked = f.client.diagnostics().classes.find(r => r.kind === "maintenance")!;
 assert.equal(parked.parked, 1); assert.equal(parked.nextRetryInMs, 30_000); assert.equal(parked.progress.unverified, 1);
 f.advance(35_000); const due = f.client.diagnostics(); assert.equal(due.classes.find(r => r.kind === "maintenance")!.oldestDueAgeMs, 5000);
 for (const secret of [f.directory, owner, a.requestId, a.roomId, "membershipEventId", "transactionId"]) assert.equal(JSON.stringify(due).includes(secret), false);
 await f.ack(a, "rejected", "unsupported_encryption", 2);
 assert.equal(f.client.diagnostics().classes.reduce((n, r) => n + r.progress.unsupportedEncryption, 0), 1);
 await f.client.close(); assert.equal(f.client.diagnostics().state, "unavailable");
});
test("host diagnostics report cooldown without bypassing it or claiming fresh authority", async t => {
 const f = await fixture(t); await f.client.request(inspect(1)); f.fail(new MatrixError("http", "PRIVATE failure", 429, true, 90_000));
 await assert.rejects(f.client.flush(signal())); const before = await f.saved();
 const d = f.client.diagnostics(); assert.equal(d.cooldownMs, 90_000); assert.equal(d.classes.find(r => r.kind === "maintenance")!.nextRetryInMs, 90_000);
 assert.deepEqual(await f.saved(), before); assert.equal(JSON.stringify(d).includes("PRIVATE"), false);
});

test("fresh inspection skips fifty due completed ensures instead of waiting 150 seconds", async t => {
 const f = await fixture(t);
 for (let i = 0; i < 50; i++) await f.ack(await f.client.request(ensure(i)));
 f.advance(76_000); const target = await f.client.request(inspect(100));
 await f.client.flush(signal());
 assert.equal(f.sent[0].action.requestId, target.requestId);
 assert.equal((await f.saved()).records.length, 51, "maintenance audit is retained");
});
test("continuous new interactive work cannot starve due maintenance", async t => {
 const f = await fixture(t);
 for (let i = 0; i < 20; i++) await f.ack(await f.client.request(ensure(i)));
 f.advance(76_000);
 for (let i = 100; i < 120; i++) { await f.client.request(inspect(i)); await f.client.flush(signal()); }
 const maintenance = f.sent.filter(s => s.action.operation === "room.ensure");
 assert.ok(maintenance.length >= 6, `maintenance received ${maintenance.length} of 20 turns`);
 assert.ok(f.sent.filter(s => s.action.operation === "room.membership.inspect").length >= 12);
});
test("ordinary setup and negative controls receive reserved service amid interactive work", async t => {
 const f = await fixture(t);
 for (let i = 1; i <= 8; i++) {
  await f.client.request(ensure(i)); await f.client.request(inspect(100 + i));
  await f.client.request({ operation: "room.retire", conversationId: `conv_${(200 + i).toString(16).padStart(32, "0")}`, roomId: `!retired${i}:test`, retirementId: `retirement_${i.toString(16).padStart(32, "0")}` });
 }
 for (let i = 0; i < 16; i++) await f.client.flush(signal());
 for (const op of ["room.ensure", "room.retire", "room.membership.inspect"]) assert.ok(f.sent.filter(s => s.action.operation === op).length >= 4);
});
for (const timing of ["before_selection", "during_selection"] as const) test(`terminal authority fences an ordinary ensure ${timing}`, async t => {
 const f = await fixture(t);
 const a = await f.client.request({ ...ensure(1), kind: "conversation", project: { projectKey: `project_${"a".repeat(32)}`, spaceId: "!project:test" }, checkout: { checkoutId: `checkout_${"b".repeat(32)}`, spaceId: "!checkout:test" } } as AccountActionBody);
 if (timing === "before_selection") f.retire();
 else {
  const original = AtomicJsonFile.prototype.write;
  t.mock.method(AtomicJsonFile.prototype, "write", async function(this: AtomicJsonFile<unknown>, value: unknown) {
   await original.call(this, value);
   const rows = (value as { records?: Array<{ action: AccountAction; transactionId?: string }> }).records;
   if (rows?.some(r => r.action.requestId === a.requestId && r.transactionId)) f.retire();
  });
 }
 assert.equal(await f.client.flush(signal()), false);
 assert.equal(f.sent.length, 0); assert.equal((await f.saved()).records[0].cancelled, true);
});
for (const operation of ["room.membership.authorize", "room.membership.confirm"] as const)
 for (const timing of ["before_selection", "during_selection"] as const) test(`${operation} inherits original expiry ${timing}`, async t => {
  const f = await fixture(t), conversationId = `conv_${"a".repeat(32)}`;
  const parent = await f.client.request({ operation: "room.membership.restore", conversationId, roomId: "!room:test", hostSpaceId: "!host:test", operationId: `operation_${"a".repeat(32)}`, sourceDigest: "a".repeat(64), expiresAt: 2000, membership: "join", membershipEventId: "$joined" });
  await f.ack(parent, "pending", "admitted");
  const child = await f.client.request({ conversationId, roomId: "!room:test", restoreRequestId: parent.requestId, membershipEventId: "$joined", ...(operation === "room.membership.authorize" ? { operation, membership: "join" as const } : { operation }) });
  if (timing === "before_selection") f.advance(1000);
  else {
   const original = AtomicJsonFile.prototype.write;
   t.mock.method(AtomicJsonFile.prototype, "write", async function(this: AtomicJsonFile<unknown>, value: unknown) {
    await original.call(this, value);
    const rows = (value as { records?: Array<{ action: AccountAction; transactionId?: string }> }).records;
    if (rows?.some(r => r.action.requestId === child.requestId && r.transactionId)) f.advance(1000);
   });
  }
  assert.equal(await f.client.flush(signal()), false); assert.equal(f.sent.length, 0);
  assert.equal((await f.saved()).records[0].cancelled, undefined, "expiry must not cancel unrelated conversation authority");
 });

test("unchanged unverified acks and provisioning do not reset persisted retry backoff", async t => {
 const f = await fixture(t), a = await f.client.request(ensure(1));
 await f.client.flush(signal()); await f.ack(a, "pending", "unverified");
 f.advance(30_000); await f.client.flush(signal());
 f.advance(30_000); await f.client.flush(signal());
 assert.equal(f.sent.length, 3);
 const before = (await f.saved()).records[0].delivery;
 await f.client.request(ensure(1)); await f.ack(a, "pending", "unverified", 2);
 assert.deepEqual((await f.saved()).records[0].delivery, before);
 await f.restart(); f.advance(30_000); assert.equal(await f.client.flush(signal()), false);
 f.advance(30_000); assert.equal(await f.client.flush(signal()), true);
 assert.equal((await f.saved()).records[0].delivery.attempts, 3);
});
test("uncertain send keeps transaction and retry due across restart and clock rollback", async t => {
 const f = await fixture(t); await f.client.request(ensure(1)); f.fail(true);
 await assert.rejects(f.client.flush(signal()), /lost reply/); const txn = f.sent[0].txn;
 await f.restart(); f.advance(-500); assert.equal(await f.client.flush(signal()), false);
 f.advance(30_500); f.fail(false); await f.client.flush(signal()); assert.equal(f.sent[1].txn, txn);
});
test("rate limits persist a transport-wide cooldown including fresh arrivals and restart", async t => {
 const f = await fixture(t); await f.client.request(ensure(1));
 f.fail(new MatrixError("http", "limited", 429, true, 120_000));
 await assert.rejects(f.client.flush(signal()), /limited/);
 await f.client.request(inspect(2)); assert.equal(await f.client.flush(signal()), false);
 await f.restart(); f.fail(false); f.advance(119_999);
 assert.equal(await f.client.flush(signal()), false); assert.equal(f.sent.length, 1);
 f.advance(1); assert.equal(await f.client.flush(signal()), true);
 assert.equal(f.sent[1].action.operation, "room.membership.inspect");
});

test("explicit stale inspection demand wakes before maintenance without repeated retry acceleration", async t => {
 const f = await fixture(t), a = await f.client.request(inspect(1));
 await f.client.flush(signal()); await f.ack(a);
 f.advance(90_000); await f.client.request(inspect(1));
 assert.equal((await f.saved()).records[0].delivery.demand, true);
 await f.client.flush(signal()); const before = (await f.saved()).records[0].delivery;
 await f.client.request(inspect(1)); assert.deepEqual((await f.saved()).records[0].delivery, before);
});
test("old journals derive conservative timing and invalid scheduling hints fail closed", async t => {
 const f = await fixture(t); await f.client.request(ensure(1)); await f.client.flush(signal()); await f.client.close();
 const saved = await f.saved(); delete saved.records[0].delivery;
 await writeFile(join(f.directory, "account.json"), JSON.stringify(saved)); await f.restart();
 assert.equal(await f.client.flush(signal()), false);
 f.advance(30_000); assert.equal(await f.client.flush(signal()), true);
 await f.client.close(); saved.records[0].delivery = { nextAt: -1, attempts: 0 };
 await writeFile(join(f.directory, "account.json"), JSON.stringify(saved));
 await assert.rejects(f.restart(), /delivery timing/);
});
test("pump wakes on durable enqueue without advancing an idle timer and close interrupts sleep", async t => {
 const f = await fixture(t); t.mock.timers.enable({ apis: ["setTimeout"] });
 let resolve!: () => void; const sent = new Promise<void>(r => { resolve = r; }); f.onSend(resolve);
 f.client.start(); await new Promise<void>(r => setImmediate(r));
 await f.client.request(inspect(1)); await sent;
 assert.equal(f.sent.length, 1); await f.client.close();
 t.mock.timers.tick(300_000); assert.equal(f.sent.length, 1);
});
test("pump sends bounded batches then yields rather than delaying each individual request", async t => {
 const f = await fixture(t); await f.client.requestMany(Array.from({ length: 20 }, (_, i) => inspect(i)));
 t.mock.timers.enable({ apis: ["setTimeout"] });
 let onYield = () => {}; const first = new Promise<void>(resolve => { onYield = resolve; });
 const originalTimer = setTimeout;
 t.mock.method(globalThis, "setTimeout", (...args: Parameters<typeof setTimeout>) => {
  const timer = originalTimer(...args); if (args[1] === 25) onYield(); return timer;
 });
 f.client.start(); await first; assert.equal(f.sent.length, 8);
 const second = new Promise<void>(resolve => { onYield = resolve; });
 t.mock.timers.tick(25); await second; assert.equal(f.sent.length, 16);
 await f.client.close();
});
test("uncertain scheduling write poisons delivery and restart retains the frozen attempt", async t => {
 const f = await fixture(t); await f.client.request(ensure(1));
 const original = AtomicJsonFile.prototype.write;
 const mocked = t.mock.method(AtomicJsonFile.prototype, "write", async function(this: AtomicJsonFile<unknown>, value: unknown) {
  await original.call(this, value); throw Error("uncertain write");
 });
 await assert.rejects(f.client.flush(signal()), /uncertain write/);
 assert.equal(f.sent.length, 0); await assert.rejects(f.client.flush(signal()), /unavailable/);
 mocked.mock.restore(); const txn = (await f.saved()).records[0].transactionId;
 await f.restart(); assert.equal(await f.client.flush(signal()), false);
 f.advance(30_000); await f.client.flush(signal()); assert.equal(f.sent[0].txn, txn);
});

test("wake generation closes enqueue-before-sleep races and aborted waits leave no timer", async t => {
 t.mock.timers.enable({ apis: ["setTimeout"] });
 const wake = new DeliveryWake(), version = wake.version(); wake.notify();
 await wake.wait(version, 10000, signal());
 const stop = new AbortController(); const waiting = wake.wait(wake.version(), 10000, stop.signal);
 stop.abort(); await waiting; t.mock.timers.tick(10000);
});
