import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { TrustedInvitations, trustedBridgeBots } from "../config/agent/extensions/bridge-chat/trusted-invites.js";
import { assistantPolicyFingerprint, validateConfig } from "../config/agent/extensions/bridge-chat/transport.js";
import { BridgeOrganization } from "../config/agent/extensions/matrix-bridge/organization.js";
import { BridgeStore } from "../config/agent/extensions/matrix-bridge/store.js";
import { BRIDGE_ROOM_STAMP } from "../config/agent/extensions/matrix-shared/bridge-room.js";
import { BOT, OWNER, SetupHttp } from "./fixtures/matrix-bridge/setup-http.js";

async function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "bridge-invites-")), http = new SetupHttp(), path = join(root, "invitations.sqlite");
  const store = new BridgeStore(join(root, "bridge.sqlite"), "host");
  const binding = store.register({ file: join(root, "native.jsonl"), cwd: root, nativeId: "native", title: "Room", boundary: null });
  const organizer = new BridgeOrganization(store, http.bot, { hostId: "host", botUserId: BOT, operatorUserId: OWNER }, async () => { throw Error("Grouping offline"); });
  await organizer.pump(); await organizer.stop(); const room = store.binding(binding.key)!.room!; store.close();
  let helper = new TrustedInvitations(path, http.owner, OWNER, { host: BOT }), open = true;
  const close = () => { if (open) { helper.close(); open = false; } };
  t.after(() => { close(); rmSync(root, { recursive: true, force: true }); });
  return { root, path, http, room, close, get helper() { return helper; }, restart: (hosts: Record<string, string> = { host: BOT }) => { close(); helper = new TrustedInvitations(path, http.owner, OWNER, hosts); open = true; } };
}

test("native invitation acceptance is exact-host, once-only, independently cursor-backed and notification-neutral", async t => {
  const f = await fixture(t); await f.helper.syncOnce(); const cursor = f.helper.cursor();
  assert.equal(f.helper.status().offered, 1); assert.ok(cursor);
  await Promise.all([f.helper.pump(), f.helper.pump()]);
  assert.equal(f.http.count("/join"), 1); assert.equal(f.helper.status().joined, 1);
  assert.equal(f.helper.cursor(), cursor, "scoped recheck does not advance global invitation intake");
  f.restart(); await f.helper.syncOnce(); await f.helper.pump(); assert.equal(f.http.count("/join"), 1);
  assert.ok(f.http.calls.filter(call => call.actor === OWNER).every(call => call.method === "GET" && call.path.endsWith("/sync") || call.method === "POST" && call.path.endsWith("/join")));
});

test("native invitation policy is separate from assistant policy and incompatible with the old account consumer", () => {
  const config = { homeserver: "https://example.test", ownerUserId: OWNER, remoteOwnerUserIds: [], roomIds: ["!test:example.test"], allJoinedRooms: false, modelSocket: "/fixture.sock" };
  assert.deepEqual(trustedBridgeBots({ host: BOT }), { host: BOT });
  for (const value of [[], null, { bad: "someone" }, { "invalid host": BOT }, { a: BOT, b: BOT }]) assert.throws(() => trustedBridgeBots(value));
  assert.equal(assistantPolicyFingerprint(config, "token"), assistantPolicyFingerprint({ ...config, trustedBridgeBots: { host: BOT } }, "token"));
  assert.throws(() => validateConfig({ ...config, trustedBridgeBots: { host: OWNER } }));
  assert.throws(() => validateConfig({ ...config, trustedBridgeBots: { host: BOT }, managedAccountHosts: [{ hostId: "host", botUserId: BOT, deviceId: "legacy" }] }));
});

test("an uncertain join never replays after restart, including a departure hidden by a later invitation", async t => {
  const f = await fixture(t); await f.helper.syncOnce(); f.http.joinFailure = true; await f.helper.pump();
  assert.equal(f.helper.status().attempted, 1); assert.equal(f.http.count("/join"), 1);
  f.http.member(f.room, "leave"); f.http.member(f.room, "invite", BOT);
  f.restart(); await f.helper.syncOnce(); await f.helper.pump();
  assert.equal(f.http.count("/join"), 1); assert.equal(f.helper.status().attempted, 1);
});

test("a lost join acknowledgement may be observed as joined without replay", async t => {
  const f = await fixture(t); await f.helper.syncOnce(); f.http.joinFailure = true; await f.helper.pump();
  f.restart(); f.http.nextSync = { next_batch: "joined", rooms: { join: { [f.room]: {} } } };
  await f.helper.syncOnce(); await f.helper.pump();
  assert.equal(f.helper.status().joined, 1); assert.equal(f.http.count("/join"), 1);
});

test("explicit join rejection may retry after the server delay, unlike an unknown outcome", async t => {
  const f = await fixture(t); let now = Date.now(); t.mock.method(Date, "now", () => now);
  await f.helper.syncOnce(); f.http.rejectOnce = { suffix: "/join", status: 429, retryAfterMs: 12000 };
  await f.helper.pump(); assert.equal(f.helper.status().offered, 1); assert.equal(f.http.count("/join"), 1);
  now += 5001; await f.helper.pump(); assert.equal(f.http.count("/join"), 1);
  now += 7000; await f.helper.pump(); assert.equal(f.http.count("/join"), 2); assert.equal(f.helper.status().joined, 1);
});

test("invitation offers and cursor roll back together on malformed intake", async t => {
  const f = await fixture(t); await f.helper.syncOnce(); const cursor = f.helper.cursor();
  const invite = { invite_state: { events: f.http.rooms.get(f.room) } };
  assert.throws(() => f.helper.ingest({ next_batch: "failed", rooms: { invite: { "!second:example.test": invite }, join: { [f.room]: { timeline: { events: {} } } } } }), /Invalid invitation state/);
  f.restart(); assert.equal(f.helper.cursor(), cursor); assert.deepEqual(f.helper.status(), { offered: 1 });
  f.helper.ingest({ next_batch: "accepted", rooms: { invite: { "!second:example.test": invite } } });
  f.restart(); assert.equal(f.helper.cursor(), "accepted"); assert.deepEqual(f.helper.status(), { offered: 2 });
});

test("filtered account leave sections suppress joining without a member event", async t => {
  const f = await fixture(t); await f.helper.syncOnce();
  f.helper.ingest({ next_batch: "left", rooms: { leave: { [f.room]: {} } } });
  await f.helper.pump(); assert.equal(f.helper.status().departed, 1); assert.equal(f.http.count("/join"), 0);
});

test("observed departure survives later invitation, process restart and account policy changes", async t => {
  const f = await fixture(t); await f.helper.syncOnce(); f.http.member(f.room, "leave"); await f.helper.syncOnce();
  assert.equal(f.helper.status().departed, 1);
  f.http.member(f.room, "invite", BOT); f.restart({ host: BOT, other: "@other:example.test" });
  await f.helper.syncOnce(); await f.helper.pump();
  assert.equal(f.helper.status().departed, 1); assert.equal(f.http.count("/join"), 0);
});

test("a current membership recheck prevents accepting an invitation declined after intake", async t => {
  const f = await fixture(t); await f.helper.syncOnce();
  f.http.beforeSnapshot = () => f.http.member(f.room, "leave");
  await f.helper.pump(); assert.equal(f.http.count("/join"), 0); assert.equal(f.helper.status().departed, 1);
});

test("arbitrary invitations, forged host/creator, encryption and extra creators never reach join", async t => {
  for (const mutate of [
    (f: Awaited<ReturnType<typeof fixture>>) => f.http.member(f.room, "invite", "@unknown:example.test"),
    (f: Awaited<ReturnType<typeof fixture>>) => { const create = f.http.rooms.get(f.room)!.find(e => e.type === "m.room.create")!; (create.content[BRIDGE_ROOM_STAMP] as { host: string }).host = "foreign"; },
    (f: Awaited<ReturnType<typeof fixture>>) => { f.http.rooms.get(f.room)!.find(e => e.type === "m.room.create")!.content.additional_creators = [OWNER]; },
    (f: Awaited<ReturnType<typeof fixture>>) => f.http.set(f.room, "m.room.encryption", "", { algorithm: "m.megolm.v1.aes-sha2" }),
  ]) {
    const f = await fixture(t); mutate(f); await f.helper.syncOnce(); await f.helper.pump();
    assert.equal(f.http.count("/join"), 0); assert.deepEqual(f.helper.status(), {});
  }
});

test("trust revocation gates queued invitations and the journal cannot change operator", async t => {
  const f = await fixture(t); await f.helper.syncOnce(); f.restart({ host: "@different:example.test" });
  assert.equal(f.helper.cursor(), ""); await f.helper.syncOnce(); await f.helper.pump(); assert.equal(f.http.count("/join"), 0);
  assert.throws(() => new TrustedInvitations(f.path, f.http.owner, OWNER, { host: BOT }), /locked/);
  f.close();
  assert.throws(() => new TrustedInvitations(f.path, f.http.owner, "@another:example.test", { host: BOT }), /another operator/);
  f.restart(); assert.equal(f.helper.status().offered, 1);
});

test("independent invitation loop can stop without any account teardown operation", async t => {
  const f = await fixture(t), stop = new AbortController();
  await f.helper.run(stop.signal, () => stop.abort());
  assert.equal(f.http.count("/join"), 1);
  assert.ok(!f.http.calls.some(call => /pushrules|toDevice|\/leave$|forget|unban/.test(call.path)));
});
