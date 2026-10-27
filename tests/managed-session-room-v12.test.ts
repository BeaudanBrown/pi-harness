import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Check } from "typebox/value";
import { verifyManagedHierarchy, type EnsureRoom } from "../config/agent/extensions/bridge-chat/account-proof.js";
import { MatrixRoomIdSchema, isMatrixRoomId } from "../config/agent/extensions/matrix-shared/room-id.js";
import { RetirementEffectSchema } from "../config/agent/extensions/managed-sessions/relay/retirement-store.js";
import { deriveConversationId } from "../config/agent/extensions/managed-sessions/contracts.js";
import { AccountActionSchema } from "../config/agent/extensions/managed-sessions/live-workspace-contracts.js";
import { parseManagedProvenance, managedRoomAlias } from "../config/agent/extensions/managed-sessions/managed-provenance.js";
import { ManagedMatrixClient } from "../config/agent/extensions/managed-sessions/relay/matrix-client.js";
import { provisionCoordinatorRooms } from "../config/agent/extensions/managed-sessions/relay/coordinator-provisioning.js";

const host = "isolated-smoke", bot = "@bot:example.com", hostRoom = `!${"A".repeat(43)}`, coordinatorRoom = `!${"B".repeat(42)}A`;
const hostProof = { version: 1 as const, hostId: host, kind: "host_space" as const, creationKey: "host" };
const proof = (parentRoomId: string) => ({ version: 1, hostId: host, kind: "coordinator", creationKey: "coordinator", conversationId: deriveConversationId(host, "coordinator"), parentRoomId });

test("legacy and hash-only v12 IDs cross provenance and account contracts without accepting malformed IDs", () => {
 for (const room of ["!legacy:example.com", "!legacy:example.com:8448", hostRoom, "!EK6Ue_DMIiYwKq-msIkzQnfllEja1nPVTrMPXT9jioo"]) {
  assert.equal(isMatrixRoomId(room), true); assert.equal(Check(MatrixRoomIdSchema, room), true);
  assert.doesNotThrow(() => parseManagedProvenance(proof(room)));
  assert.equal(Check(AccountActionSchema, { version: "1.0.0", requestId: `account_${"a".repeat(32)}`, hostId: host, payloadDigest: "a".repeat(64), operation: "room.retire", roomId: room, conversationId: deriveConversationId(host, "project"), retirementId: `retirement_${"a".repeat(32)}` }), true);
 }
 for (const room of ["!", "!short", `!${"A".repeat(42)}`, `!${"A".repeat(44)}`, `!${"A".repeat(42)}=`, hostRoom + "\n", "!bad\u0000:example.com", "!bad space:example.com", "!:example.com", "!local:", `!${"a".repeat(200)}:${"b".repeat(200)}`]) assert.throws(() => parseManagedProvenance(proof(room)), /Invalid managed room provenance/, room);
});

function fixture(options: { sender?: string; additionalCreators?: string[]; roomVersion?: string; encrypted?: boolean; numericPower?: number } = {}) {
 let creates = 1;
 const rooms = new Map<string, any>([[hostRoom, { creation_content: { type: "m.space", "m.federate": false }, initial_state: [{ type: "lol.bepis.pi.managed.v1", state_key: "", content: hostProof }] }]]);
 const aliases = new Map([[managedRoomAlias(hostProof), hostRoom]]);
 const links: any[] = [];
 const client = new ManagedMatrixClient({ homeserver: "https://matrix.example.com", botUserId: bot, operatorUserId: "@owner:example.com", accessToken: "test-only" }, async (input, init) => {
  const path = new URL(String(input)).pathname;
  if (path.includes("/directory/room/")) {
   const alias = decodeURIComponent(path.split("/directory/room/")[1]!).slice(1).split(":")[0]!;
   return aliases.has(alias) ? Response.json({ room_id: aliases.get(alias) }) : Response.json({ errcode: "M_NOT_FOUND" }, { status: 404 });
  }
  if (path.endsWith("/createRoom")) {
   const body = JSON.parse(String(init?.body));
   if (aliases.has(body.room_alias_name)) return Response.json({ errcode: "M_ROOM_IN_USE" }, { status: 400 });
   assert.equal(++creates, 2, "must not create a replacement host Space");
   rooms.set(coordinatorRoom, body); aliases.set(body.room_alias_name, coordinatorRoom); return Response.json({ room_id: coordinatorRoom });
  }
  const match = path.match(/\/rooms\/([^/]+)\/state(?:\/(.*))?$/); assert.ok(match);
  const room = decodeURIComponent(match[1]!); const body = rooms.get(room); assert.ok(body);
  const create = { ...body.creation_content, room_version: options.roomVersion ?? "12", ...(options.additionalCreators ? { additional_creators: options.additionalCreators } : {}) };
  if (match[2] === "m.room.create/") return Response.json(create);
  if (match[2] === "m.room.power_levels/") return Response.json({ users: options.numericPower === undefined ? {} : { [bot]: options.numericPower } });
  if (match[2]?.startsWith("m.room.member/")) return Response.json({ membership: "join" });
  if (match[2]?.startsWith("m.space.child/") && init?.method === "PUT") { links.push({ parent: room, child: decodeURIComponent(match[2].slice("m.space.child/".length)), content: JSON.parse(String(init.body)) }); return Response.json({}); }
  assert.equal(match[2], undefined);
  return Response.json([
   { type: "m.room.create", state_key: "", sender: options.sender ?? bot, content: create },
   { type: "m.room.join_rules", state_key: "", sender: bot, content: { join_rule: "invite" } },
   ...body.initial_state.map((event: any) => ({ ...event, sender: bot })),
   ...(options.encrypted ? [{ type: "m.room.encryption", state_key: "", sender: bot, content: {} }] : []),
  ]);
 }, [], { maxAttempts: 1 });
 return { client, links, creates: () => creates };
}

test("v12 recovers the original attempted host Space, persists hash IDs, links via joined bot server and replays no create", async t => {
 const root = await mkdtemp(join(tmpdir(), "room-v12-")); t.after(() => rm(root, { recursive: true, force: true }));
 const file = join(root, "intent.json");
 await writeFile(file, JSON.stringify({ version: 1, hostId: host, conversationId: deriveConversationId(host, "coordinator"), hostAttempted: true, roomAttempted: false, linked: false }), { mode: 0o600 });
 const f = fixture();
 assert.deepEqual(await provisionCoordinatorRooms(file, host, "smoke", f.client), { hostSpace: hostRoom, roomId: coordinatorRoom });
 assert.equal(f.creates(), 2);
 assert.deepEqual(f.links, [{ parent: hostRoom, child: coordinatorRoom, content: { via: ["example.com"], suggested: true } }]);
 assert.equal(JSON.parse(await readFile(file, "utf8")).linked, true);
 assert.deepEqual(await provisionCoordinatorRooms(file, host, "smoke", f.client), { hostSpace: hostRoom, roomId: coordinatorRoom });
 assert.equal(f.creates(), 2); assert.equal(f.links.length, 1);
});

test("v12 creator power never adopts foreign creators, co-creators, encrypted rooms or unknown versions", async () => {
 for (const options of [{ sender: "@foreign:example.com", additionalCreators: [bot] }, { additionalCreators: ["@foreign:example.com"] }, { encrypted: true }, { roomVersion: "999", numericPower: 100 }, { sender: "@foreign:example.com", numericPower: 100 }]) {
  const f = fixture(options);
  await assert.rejects(f.client.recoverManagedAlias(hostProof));
  assert.equal(f.creates(), 1); assert.equal(f.links.length, 0);
 }
});

test("idempotent v11/v12 alias collisions require the original sole creator before returning a room", async () => {
 for (const roomVersion of ["11", "12"]) {
  const f = fixture({ roomVersion, numericPower: 100 });
  assert.equal(await f.client.createPrivateSpaceIdempotent("host", managedRoomAlias(hostProof)), hostRoom);
  assert.equal(f.creates(), 1);
 }
 for (const options of [{ roomVersion: "11", sender: "@foreign:example.com", numericPower: 100 }, { sender: "@foreign:example.com", numericPower: 100 }, { additionalCreators: ["@foreign:example.com"] }, { sender: "@foreign:example.com", additionalCreators: [bot] }]) {
  const foreign = fixture(options);
  await assert.rejects(foreign.client.createPrivateSpaceIdempotent("host", managedRoomAlias(hostProof)), /foreign or ambiguous/);
  assert.equal(foreign.creates(), 1); assert.equal(foreign.links.length, 0);
 }
});

test("self membership and retirement cleanup accept v12 but reject arbitrary or control-containing room IDs", async () => {
 let rooms: unknown[] = [hostRoom]; let requests = 0;
 const client = new ManagedMatrixClient({ homeserver: "https://matrix.example.com", botUserId: bot, operatorUserId: "@owner:example.com", accessToken: "test-only" }, async () => { requests++; return Response.json({ joined_rooms: rooms }); });
 assert.equal(await client.accountJoined(hostRoom), true);
 const effect = (roomId: string) => ({ effectId: `cleanup_${"a".repeat(32)}`, phase: "pending", kind: "bot_leave", roomId, userId: bot });
 for (const room of [hostRoom, "!legacy:example.com"]) assert.equal(Check(RetirementEffectSchema, effect(room)), true);
 for (const room of ["!arbitrary", "!bad\u0000:example.com", hostRoom + "\n", `!${"A".repeat(44)}`]) {
  assert.equal(Check(RetirementEffectSchema, effect(room)), false);
  const before = requests; await assert.rejects(client.accountJoined(room), /membership target/); assert.equal(requests, before);
  rooms = [room]; await assert.rejects(client.accountJoined(hostRoom), /self membership/);
 }
});

test("account worker independently verifies v12 original creator and rejects additional or unknown authority", () => {
 const action: EnsureRoom = { version: "1.0.0", requestId: `account_${"a".repeat(32)}`, payloadDigest: "a".repeat(64), hostId: host,
  operation: "room.ensure", kind: "host_space", creationKey: "host", roomId: hostRoom, hostSpaceId: hostRoom, notificationSetup: "preserve" };
 const snapshot = (content: Record<string, unknown>, sender = bot) => new Map([[hostRoom, [
  { type: "m.room.create", state_key: "", sender, content: { room_version: "12", "m.federate": false, type: "m.space", ...content } },
  { type: "m.room.join_rules", state_key: "", sender: bot, content: { join_rule: "invite" } },
  { type: "lol.bepis.pi.managed.v1", state_key: "", sender: bot, content: hostProof },
 ]]]);
 assert.doesNotThrow(() => verifyManagedHierarchy(action, bot, snapshot({})));
 assert.doesNotThrow(() => verifyManagedHierarchy(action, bot, snapshot({ additional_creators: [] })));
 for (const content of [{ additional_creators: ["@other:example.com"] }, { additional_creators: null }, { room_version: "999" }, { creator: "@foreign:example.com" }]) assert.throws(() => verifyManagedHierarchy(action, bot, snapshot(content)));
 assert.throws(() => verifyManagedHierarchy(action, bot, snapshot({ additional_creators: [bot] }, "@foreign:example.com")));
});
