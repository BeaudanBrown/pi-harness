import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AccountStore, ACCOUNT_REQUEST_EVENT } from "../config/agent/extensions/bridge-chat/account-store.js";
import { AccountWorker, type AccountMatrixPort } from "../config/agent/extensions/bridge-chat/account-worker.js";
import { accountActionIdentity, parseAccountAction, type AccountAction } from "../config/agent/extensions/managed-sessions/live-workspace-contracts.js";
import { MatrixError } from "../config/agent/extensions/matrix-shared/http.js";
const owner = "@owner:test", bot = "@host:test", hosts = [{ hostId: "host", botUserId: bot, deviceId: "HOST" }];
const signal = () => new AbortController().signal;
const signed = (body: Record<string, unknown>) => parseAccountAction({ ...body, ...accountActionIdentity(body) });
function ensure(n: number): AccountAction {
 return signed({ version: "1.0.0", hostId: "host", operation: "room.ensure", roomId: `!room${n}:test`, kind: "coordinator", creationKey: `room${n}`, hostSpaceId: "!host:test", conversationId: `conv_${n.toString(16).padStart(32, "0")}`, notificationSetup: "preserve" });
}
const frame = (a: AccountAction) => ({ type: ACCOUNT_REQUEST_EVENT, sender: bot, content: a });
function inspect(n: number): AccountAction {
 const a = ensure(n); if (a.operation !== "room.ensure") throw Error("fixture");
 return signed({ version: a.version, hostId: a.hostId, operation: "room.membership.inspect", roomId: a.roomId, conversationId: a.conversationId, membershipEventId: "$joined" });
}
async function fixture(t: { after(fn: () => Promise<void>): void }) {
 const root = await mkdtemp(join(tmpdir(), "nas-schedule-")), file = join(root, "account.sqlite"); let now = 100_000;
 let store = new AccountStore(file, owner, () => now); const stop = new AbortController(); let task: Promise<void> | undefined;
 const sent: Array<{ txn: string; payload: unknown }> = [];
 const port: AccountMatrixPort = { joined: async () => true, state: async () => { throw Error("unverified"); },
  join: async () => assert.fail("no join authority"), leave: async () => assert.fail("no leave authority"), forget: async () => assert.fail("no forget authority"), cleanupEligible: async () => false,
  toDevice: async (_type, _recipient, _device, txn, payload) => { sent.push({ txn, payload }); } };
 const rules = { read: async () => undefined, put: async () => assert.fail("no rule authority") };
 let worker = new AccountWorker(store, hosts, owner, port, rules, () => now); worker.ingest({});
 t.after(async () => { stop.abort(); await task; store.close(); await rm(root, { recursive: true, force: true }); });
 return { get store() { return store; }, get worker() { return worker; }, port, sent, stop, advance: (ms: number) => { now += ms; },
  ingest: (...actions: AccountAction[]) => worker.ingest({ to_device: { events: actions.map(frame) } }),
  run: () => task = worker.run(stop.signal),
  restart: () => { store.close(); store = new AccountStore(file, owner, () => now); worker = new AccountWorker(store, hosts, owner, port, rules, () => now); worker.ingest({}); } };
}

test("NAS prioritizes a fresh inspection over fifty due ordinary effects", async t => {
 const f = await fixture(t); f.ingest(...Array.from({ length: 50 }, (_, i) => ensure(i + 1)), inspect(99));
 assert.equal(f.store.nextRequest(hosts)?.action.operation, "room.membership.inspect");
});
test("NAS oldest due work and reserved lanes survive continuous interactive arrivals", async t => {
 const f = await fixture(t), ordinary = ensure(1), maintenance = ensure(2); f.ingest(ordinary, maintenance);
 f.store.acknowledge(maintenance.requestId, hosts[0], "pending", "unverified");
 const seen: string[] = [];
 for (let i = 0; i < 15; i++) { f.ingest(inspect(i + 100)); seen.push(f.store.nextRequest(hosts)!.action.requestId); }
 assert.ok(seen.includes(ordinary.requestId)); assert.ok(seen.includes(maintenance.requestId));
});
test("NAS duplicate pending work cannot erase exponential retry across reload or clock rollback", async t => {
 const f = await fixture(t), a = ensure(1); f.ingest(a); assert.equal(await f.worker.step(signal()), true);
 f.ingest(a); f.restart(); assert.equal(await f.worker.step(signal()), false);
 f.advance(-1000); assert.equal(await f.worker.step(signal()), false); f.advance(31_000); assert.equal(await f.worker.step(signal()), true);
 f.advance(30_000); assert.equal(await f.worker.step(signal()), false); f.advance(30_000); assert.equal(await f.worker.step(signal()), true);
 assert.equal(f.store.get(a.requestId)?.ack?.status, "pending");
});
test("NAS uncertain ack keeps exact bytes and txn, while another recipient can progress", async t => {
 const f = await fixture(t), a = ensure(1), b = signed({ ...ensure(2), hostId: "other" });
 const otherHost = { hostId: "other", botUserId: "@other:test", deviceId: "OTHER" }, configured = [...hosts, otherHost];
 f.ingest(a); f.store.ingest([{ ...frame(b), sender: otherHost.botUserId }], configured);
 f.store.acknowledge(a.requestId, hosts[0], "pending"); const first = f.store.transmission(hosts)!;
 f.restart(); assert.equal(f.store.transmission(hosts), undefined);
 f.store.acknowledge(b.requestId, otherHost, "complete"); const other = f.store.transmission(configured)!; assert.equal(other.requestId, b.requestId); f.store.transmitted(other);
 f.advance(30_000); assert.deepEqual(f.store.transmission(hosts), first);
});
for (const backlog of [1, 12]) test(`NAS ack-first pump reserves effect service with ${backlog} pending acknowledgements`, async t => {
 const f = await fixture(t), acks = Array.from({ length: backlog }, (_, i) => ensure(i + 1)); f.ingest(...acks, ensure(backlog + 1));
 for (const a of acks) f.store.acknowledge(a.requestId, hosts[0], "complete");
 let entered!: () => void; const entering = new Promise<void>(resolve => { entered = resolve; });
 f.port.joined = async (_room, abort) => { assert.equal(f.sent.length, Math.min(8, backlog)); entered(); await new Promise<void>(resolve => abort.addEventListener("abort", () => resolve(), { once: true })); return true; };
 const task = f.run(); await entering; f.stop.abort(); await task;
});
test("NAS durable intake wakes an idle pump without ticking its safety timer", async t => {
 const f = await fixture(t); t.mock.timers.enable({ apis: ["setTimeout"] });
 let delivered!: () => void; const delivery = new Promise<void>(resolve => { delivered = resolve; });
 f.port.toDevice = async () => { delivered(); }; const task = f.run();
 const a = inspect(1); f.ingest(a);
 // The effect produces a durable ack, then the bounded batch yields once.
 await new Promise<void>(resolve => setImmediate(resolve)); t.mock.timers.tick(25);
 await delivery; f.stop.abort(); await task;
});
test("NAS rate-limit cooldown survives restart and gates fresh work and acknowledgements", async t => {
 const f = await fixture(t), a = ensure(1); f.ingest(a); f.store.acknowledge(a.requestId, hosts[0], "complete");
 f.port.toDevice = async () => { throw new MatrixError("http", "limited", 429, true, 90_000); };
 await assert.rejects(f.worker.flush(signal())); f.restart(); f.ingest(inspect(2));
 assert.equal(f.store.nextRequest(hosts), undefined); assert.equal(f.store.transmission(hosts), undefined);
 f.advance(89_999); assert.equal(f.store.nextRequest(hosts), undefined);
 f.advance(1); assert.ok(f.store.nextRequest(hosts)); assert.ok(f.store.transmission(hosts));
});
test("NAS identical pending inspection requests do not reset retry timing", async t => {
 const f = await fixture(t), a = inspect(1); f.ingest(a); await f.worker.step(signal());
 for (let i = 0; i < 10; i++) { f.ingest(a); assert.equal(await f.worker.step(signal()), false); }
 f.advance(30_000); assert.equal(await f.worker.step(signal()), true);
});
test("NAS changed join evidence wakes pending work once without granting authority", async t => {
 const f = await fixture(t), a = ensure(1); f.ingest(a); await f.worker.step(signal()); assert.equal(await f.worker.step(signal()), false);
 const batch = { rooms: { join: { [a.roomId]: { timeline: { events: [{ type: "m.room.member", state_key: owner, sender: owner, event_id: "$observed", content: { membership: "join" } }] } } } } };
 f.worker.ingest(batch); assert.equal(await f.worker.step(signal()), true); assert.equal(f.store.room(a.roomId)?.verified, false);
 f.worker.ingest(batch); assert.equal(await f.worker.step(signal()), false); f.restart(); f.worker.ingest(batch); assert.equal(await f.worker.step(signal()), false);
});
for (const committed of [false, true]) test(`NAS selection write failure (${committed ? "after" : "before"} commit) starts no HTTP effect`, async t => {
 const f = await fixture(t), a = ensure(1); f.ingest(a); let effects = 0;
 f.port.joined = async () => { effects++; return true; };
 const original = DatabaseSync.prototype.exec, prepare = DatabaseSync.prototype.prepare; let selected = false;
 t.mock.method(DatabaseSync.prototype, "prepare", function(this: DatabaseSync, sql: string) {
  if (sql.startsWith("UPDATE account_requests SET attempt=")) selected = true;
  return prepare.call(this, sql);
 });
 t.mock.method(DatabaseSync.prototype, "exec", function(this: DatabaseSync, sql: string) {
  if (selected && sql === "COMMIT") { if (committed) original.call(this, sql); throw Error("uncertain selection write"); }
  return original.call(this, sql);
 });
 await assert.rejects(f.worker.step(signal())); assert.equal(effects, 0);
 t.mock.restoreAll(); f.restart(); assert.equal(await f.worker.step(signal()), !committed);
 assert.equal(effects, committed ? 0 : 1);
});
test("NAS failed intake rolls back schedule wakes and suspends delivery until healthy sync", async t => {
 const f = await fixture(t), a = ensure(1), b = ensure(2); f.ingest(a, b); await f.worker.step(signal()); await f.worker.step(signal());
 assert.throws(() => f.worker.ingest({ rooms: { join: { [a.roomId]: { timeline: { events: [{ type: "m.room.member", state_key: owner, sender: owner, event_id: "$new", content: { membership: "join" } }] } }, [b.roomId]: { timeline: { events: Array(4097).fill({}) } } } } }));
 assert.equal(await f.worker.step(signal()), false); f.worker.ingest({}); assert.equal(await f.worker.step(signal()), false);
 f.advance(30_000); assert.equal(await f.worker.step(signal()), true);
});

test("NAS legacy scheduling schema migrates with existing request authority intact", async t => {
 const root = await mkdtemp(join(tmpdir(), "nas-legacy-")); t.after(() => rm(root, { recursive: true, force: true })); const file = join(root, "account.sqlite"), a = ensure(1);
 const old = new DatabaseSync(file); old.exec("CREATE TABLE account_requests(id TEXT PRIMARY KEY,sender TEXT NOT NULL,payload TEXT NOT NULL); CREATE TABLE account_outbox(id TEXT PRIMARY KEY,recipient TEXT NOT NULL,device TEXT NOT NULL,txn TEXT NOT NULL,payload TEXT NOT NULL)");
 old.prepare("INSERT INTO account_requests VALUES (?,?,?)").run(a.requestId, bot, JSON.stringify(a)); old.close();
 const store = new AccountStore(file, owner, () => 100_000); try { assert.deepEqual(store.nextRequest(hosts)?.action, a); assert.equal(store.nextRequest(hosts), undefined); } finally { store.close(); }
});
