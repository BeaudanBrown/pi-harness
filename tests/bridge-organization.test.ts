import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { BridgeOrganization, workspaceGrouping, type Grouping } from "../config/agent/extensions/matrix-bridge/organization.js";
import { BridgeStore } from "../config/agent/extensions/matrix-bridge/store.js";
import { ownedBridgeRoom } from "../config/agent/extensions/matrix-shared/bridge-room.js";
import { BOT, OWNER, SetupHttp } from "./fixtures/matrix-bridge/setup-http.js";

function fixture(t: TestContext, group?: (cwd: string) => Promise<Grouping>) {
  const root = mkdtempSync(join(tmpdir(), "bridge-setup-")), database = join(root, "bridge.sqlite"), http = new SetupHttp();
  let now = Date.now(); t.mock.method(Date, "now", () => now);
  let store = new BridgeStore(database, "host");
  const grouping = group ?? (async (cwd: string) => ({ project: root, checkout: cwd, projectName: "Project", checkoutName: "Checkout" }));
  const make = () => new BridgeOrganization(store, http.bot, { hostId: "host", botUserId: BOT, operatorUserId: OWNER }, grouping);
  let organization = make();
  t.after(async () => { await organization.stop(); store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, http, get store() { return store; }, get organization() { return organization; }, advance: () => { now += 6000; },
    register: (id = "native") => store.register({ file: join(root, id + ".jsonl"), cwd: root, nativeId: id, boundary: null, title: id }),
    restart: async () => { await organization.stop(); store.close(); store = new BridgeStore(database, "host"); organization = make(); now += 6000; } };
}

test("native setup shares hierarchy nodes, links both ways, and never derives identity from names", async t => {
  const f = fixture(t), a = f.register("a"), b = f.register("b");
  await Promise.all([f.organization.pump(), f.organization.pump()]);
  assert.equal(f.http.count("/createRoom"), 5, "two conversations share host/project/checkout");
  assert.notEqual(f.store.binding(a.key)!.room, f.store.binding(b.key)!.room);
  assert.equal(f.http.calls.filter(call => call.method === "PUT").length, 8);
  assert.equal(f.organization.status(a.key).stage, "invitation");
  assert.equal(f.http.count("/invite"), 5);
  for (const room of f.http.rooms.keys()) f.http.member(room, "join");
  f.advance(); await f.organization.pump(); assert.equal(f.organization.status(a.key).stage, "ready");
  f.http.aliases.clear(); f.store.register({ ...a, title: "Changed display title" });
  const calls = f.http.calls.length; await f.organization.pump();
  assert.equal(f.http.calls.length, calls, "settled setup is not a continuous state-write loop");
  assert.equal(f.http.count("/createRoom"), 5);
});

test("lost create acknowledgement recovers the exact owned room after a real ledger restart", async t => {
  const f = fixture(t, async () => { throw Error("Git unavailable"); }), binding = f.register();
  f.http.createFailure = "after";
  await f.organization.pump(); assert.equal(f.http.rooms.size, 1); assert.equal(f.store.binding(binding.key)!.room, undefined);
  await f.restart(); await f.organization.pump();
  assert.equal(f.http.count("/createRoom"), 1);
  assert.equal(f.store.binding(binding.key)!.room, [...f.http.rooms.keys()][0]);
  assert.equal(f.organization.status(binding.key).stage, "grouping");
  assert.equal(f.http.count("/invite"), 1, "Git failure cannot suppress the conversation invitation");
});

test("explicitly rejected creation and invitation can retry without treating them as accepted effects", async t => {
  const f = fixture(t, async () => { throw Error("Grouping offline"); }), binding = f.register();
  f.http.rejectOnce = { suffix: "/createRoom", status: 403 };
  await f.organization.pump(); assert.equal(f.http.rooms.size, 0); assert.equal(f.http.count("/createRoom"), 1);
  f.advance(); f.http.rejectOnce = { suffix: "/invite", status: 403 }; await f.organization.pump();
  assert.ok(f.store.binding(binding.key)!.room); assert.equal(f.http.count("/createRoom"), 2); assert.equal(f.http.count("/invite"), 1);
  f.advance(); await f.organization.pump();
  assert.equal(f.http.count("/createRoom"), 2); assert.equal(f.http.count("/invite"), 2); assert.equal(f.http.rooms.size, 1);
});

test("uncertain creation without an alias never permits a second POST", async t => {
  for (const mode of ["before", "after"] as const) {
    const f = fixture(t), binding = f.register(mode); f.http.createFailure = mode;
    await f.organization.pump(); f.http.aliases.clear();
    await f.restart(); await f.organization.pump(); f.advance(); await f.organization.pump();
    assert.equal(f.http.count("/createRoom"), 1);
    assert.match(f.organization.status(binding.key).error!, /uncertain.*no duplicate/);
  }
});

test("foreign alias conflicts stay scoped and cannot pin or adopt a foreign room", async t => {
  const f = fixture(t, async () => { throw Error("Grouping offline"); }), binding = f.register();
  const room = "!foreign:example.test";
  f.http.rooms.set(room, [f.http.event("m.room.create", "", "@other:example.test", { room_version: "12" })]); f.http.aliasCollision = room;
  await f.organization.pump(); assert.equal(f.store.binding(binding.key)!.room, undefined);
  assert.match(f.organization.status(binding.key).error!, /foreign/); assert.equal(f.http.count("/createRoom"), 0);
  f.http.aliasCollision = undefined; f.advance(); await f.organization.pump();
  assert.ok(f.store.binding(binding.key)!.room); assert.notEqual(f.store.binding(binding.key)!.room, room);
  assert.equal(f.http.count("/createRoom"), 1);
});

test("lost link acknowledgement is observed without repeating the accepted state write", async t => {
  const f = fixture(t), binding = f.register(); f.http.linkFailure = true;
  await f.organization.pump(); assert.equal(f.organization.status(binding.key).stage, "grouping");
  const first = f.http.calls.find(call => call.method === "PUT")!;
  await f.restart(); await f.organization.pump();
  assert.equal(f.http.count("/createRoom"), 4);
  assert.equal(f.http.calls.filter(call => call.method === "PUT" && call.path === first.path).length, 1);
  assert.equal(f.organization.status(binding.key).stage, "invitation");
});

test("unknown invitation outcome and deliberate departure never cause reinvitation", async t => {
  const f = fixture(t, async () => { throw Error("Grouping offline"); }), binding = f.register(); f.http.inviteFailure = true;
  await f.organization.pump(); const room = f.store.binding(binding.key)!.room!;
  assert.equal(f.http.count("/invite"), 1); f.http.member(room, "leave");
  await f.restart(); await f.organization.pump(); assert.equal(f.http.count("/invite"), 1);
  // Even if membership cannot be observed later, unknown prior sends stay fenced.
  f.http.rooms.set(room, f.http.rooms.get(room)!.filter(event => event.state_key !== OWNER));
  f.advance(); await f.organization.pump(); assert.equal(f.http.count("/invite"), 1);
  assert.ok(!f.http.calls.some(call => /pushrules|unban|forget|\/leave$/.test(call.path)));
});

test("immutable ownership rejects extra creators, unsupported versions, encryption and forged names", async t => {
  const f = fixture(t, async () => { throw Error("Grouping offline"); }), binding = f.register(); await f.organization.pump();
  const events = f.http.rooms.get(f.store.binding(binding.key)!.room!)!;
  assert.equal(ownedBridgeRoom(events, BOT).kind, "conversation");
  for (const change of [{ additional_creators: [OWNER] }, { room_version: "13" }, { creator: OWNER }]) {
    const altered = structuredClone(events); Object.assign(altered.find(event => event.type === "m.room.create")!.content, change);
    assert.throws(() => ownedBridgeRoom(altered, BOT), /creator/);
  }
  assert.throws(() => ownedBridgeRoom([...events, f.http.event("m.room.encryption", "", BOT, { algorithm: "m.megolm.v1.aes-sha2" })], BOT), /policy/);
});

test("real Git grouping shares a project across linked worktrees and plain workspaces need no Git", async t => {
  const root = mkdtempSync(join(tmpdir(), "bridge-groups-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const plain = join(root, "plain"), main = join(root, "main"), linked = join(root, "linked"); mkdirSync(plain); mkdirSync(main);
  const env = { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.test", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.test" };
  const git = (...args: string[]) => execFileSync("git", ["-C", main, ...args], { env, stdio: "pipe" });
  git("init", "-b", "main"); git("commit", "--allow-empty", "-m", "fixture"); git("worktree", "add", "--detach", linked, "HEAD");
  const a = await workspaceGrouping(main), b = await workspaceGrouping(linked);
  assert.equal(a.project, b.project); assert.notEqual(a.checkout, b.checkout);
  t.mock.method(process, "cwd", () => plain);
  const previous = process.env.PATH; process.env.PATH = plain;
  try { assert.equal((await workspaceGrouping(plain)).project, plain); }
  finally { if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous; }
  writeFileSync(join(plain, ".git"), "gitdir: /nonexistent-fixture-git\n");
  await assert.rejects(workspaceGrouping(plain), /grouping lookup failed/);
});
