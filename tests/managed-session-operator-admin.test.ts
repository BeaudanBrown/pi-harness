import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ManagedMatrixClient } from "../config/agent/extensions/managed-sessions/relay/matrix-client.js";
import { planOperatorAdmin, OperatorAdminMigration } from "../config/agent/extensions/managed-sessions/relay/operator-admin.js";
import { ManagedHostMutationOwner } from "../config/agent/extensions/managed-sessions/relay/host-mutation-owner.js";
import { prepareHostApproval, type ModelHostRequest } from "../config/agent/extensions/managed-sessions/relay/host-approval-record.js";
import { hostApprovalQuestion } from "../config/agent/extensions/managed-sessions/relay/host-approval-prompts.js";
import type { HostLifecycle } from "../config/agent/extensions/managed-sessions/relay/host-lifecycle.js";
import type { ConversationRetirement } from "../config/agent/extensions/managed-sessions/relay/conversation-retirement.js";
import type { ManagedSessionIpcServer } from "../config/agent/extensions/managed-sessions/relay/ipc-server.js";
import type { RelayRegistry } from "../config/agent/extensions/managed-sessions/relay/registry.js";

const bot = "@bot:example.com", operator = "@operator:example.com", guest = "@guest:example.com";
const room = "!room:example.com";
const base = { roomId: room, space: false, botUserId: bot, operatorUserId: operator, creation: { creator: bot, room_version: "10" } };
const powers = { users: { [bot]: 100, [guest]: 0 }, users_default: 0, state_default: 50, events: { "m.room.power_levels": 100 }, notifications: { room: 50 }, extension: { keep: "unchanged" } };

test("admin planning changes only the exact operator and preserves all unrelated state", () => {
	const before = structuredClone(powers); const plan = planOperatorAdmin({ ...base, powers });
	assert.equal(plan.change, true); assert.deepEqual(plan.proposed, { ...before, users: { ...before.users, [operator]: 100 } });
	assert.deepEqual(powers, before);
	for (const value of [100, 150]) {
		const elevated = { ...powers, users: { ...powers.users, [operator]: value } };
		const same = planOperatorAdmin({ ...base, powers: elevated }); assert.equal(same.change, false); assert.deepEqual(same.proposed, elevated);
	}
});

test("v12 keeps creators out of the users map and never grants creator status", () => {
	const plan = planOperatorAdmin({ ...base, creation: { room_version: "12" }, powers: { ...powers, users: { [guest]: 0 } } });
	assert.deepEqual(plan.proposed.users, { [guest]: 0, [operator]: 100 });
	const creator = planOperatorAdmin({ ...base, creation: { room_version: "12", additional_creators: [operator] }, powers: { users: {} } });
	assert.equal(creator.change, false); assert.deepEqual(creator.proposed.users, {});
	assert.throws(() => planOperatorAdmin({ ...base, creation: { room_version: "12" }, powers }), /creators must not appear/);
});

test("unsupported, malformed, peer-admin and insufficient bot authority fail closed", () => {
	for (const invalid of [null, { users: [] }, { events: [] }, { ...powers, users_default: "0" }, { ...powers, kick: 101 },
		{ ...powers, users: { [bot]: 50 } }, { ...powers, users: { [bot]: 100, [guest]: 100 } }])
		assert.throws(() => planOperatorAdmin({ ...base, powers: invalid }));
	assert.throws(() => planOperatorAdmin({ ...base, creation: { room_version: "13" }, powers }));
});

function matrixFixture(version = "10") {
	const roomId = version === "12" ? `!${"a".repeat(42)}A` : room;
	let state: Record<string, unknown> = structuredClone(version === "12" ? { ...powers, users: { [guest]: 0 } } : powers);
	let membership = "join", sender = bot, failPut = false, corruptReadback = false;
	const writes: unknown[] = [];
	const creation = version === "12" ? { room_version: version } : { room_version: version, creator: bot };
	const client = new ManagedMatrixClient({ homeserver: "https://matrix.example.com", accessToken: "fixture", botUserId: bot, operatorUserId: operator }, async (url, init) => {
		const path = decodeURIComponent(new URL(String(url)).pathname);
		if (init?.method === "PUT") {
			writes.push(JSON.parse(String(init.body))); state = JSON.parse(String(init.body));
			if (failPut) throw Error("uncertain network response");
			if (corruptReadback) state = { ...state, invite: 1 };
			return Response.json({ event_id: "$updated" });
		}
		if (path.endsWith("/state/m.room.create/")) return Response.json(creation);
		if (path.includes("/event/")) return Response.json({ event_id: `$${roomId.slice(1)}`, room_id: roomId, sender, type: "m.room.create", state_key: "", content: creation });
		if (path.endsWith("/state/m.room.power_levels/")) return Response.json(state);
		if (path.includes("/state/m.room.member/")) return Response.json({ membership: path.endsWith(operator) ? membership : "join" });
		throw Error("Unexpected fixture request");
	}, [roomId], { maxAttempts: 1 });
	return { client, roomId, writes, set state(value: Record<string, unknown>) { state = value; }, set membership(value: string) { membership = value; },
		set sender(value: string) { sender = value; }, set failPut(value: boolean) { failPut = value; }, set corruptReadback(value: boolean) { corruptReadback = value; } };
}

for (const version of ["10", "12"]) test(`Matrix admin apply verifies ownership, exact state and readback for v${version}`, async () => {
	const f = matrixFixture(version); const snapshot = await f.client.operatorAdminSnapshot({ roomId: f.roomId, space: false });
	await f.client.applyOperatorAdmin(snapshot); assert.equal(f.writes.length, 1);
	const after = await f.client.operatorAdminSnapshot(snapshot); assert.equal(after.change, false);
	await f.client.applyOperatorAdmin(after); assert.equal(f.writes.length, 1);
});

test("changed powers, operator departure, foreign creators and changed scope prevent PUT", async () => {
	const f = matrixFixture(); const snapshot = await f.client.operatorAdminSnapshot({ roomId: f.roomId, space: false });
	f.state = { ...powers, invite: 1 }; await assert.rejects(f.client.applyOperatorAdmin(snapshot), /changed/);
	f.state = powers; f.membership = "leave"; await assert.rejects(f.client.applyOperatorAdmin(snapshot), /neither joined nor invited/);
	f.membership = "join"; await assert.rejects(f.client.applyOperatorAdmin(snapshot, () => { throw Error("scope changed"); }), /scope changed/);
	assert.equal(f.writes.length, 0);
	const foreign = matrixFixture("12"); foreign.sender = guest;
	await assert.rejects(foreign.client.operatorAdminSnapshot({ roomId: foreign.roomId, space: false }), /foreign|ambiguous/);
	assert.equal(foreign.writes.length, 0);
});

test("lost PUT response is not retried; fresh preview recognizes applied state", async () => {
	const f = matrixFixture(); const snapshot = await f.client.operatorAdminSnapshot({ roomId: f.roomId, space: false });
	f.failPut = true; await assert.rejects(f.client.applyOperatorAdmin(snapshot)); assert.equal(f.writes.length, 1);
	assert.equal((await f.client.operatorAdminSnapshot(snapshot)).change, false);
	const conflicting = matrixFixture(); conflicting.corruptReadback = true;
	await assert.rejects(conflicting.client.applyOperatorAdmin(await conflicting.client.operatorAdminSnapshot({ roomId: conflicting.roomId, space: false })), /readback/);
	assert.equal(conflicting.writes.length, 1);
});

test("Space inclusion is explicit, shared targets deduplicate, and missing/retired identities block", async () => {
	const id = `conv_${"a".repeat(32)}`, other = `conv_${"b".repeat(32)}`; let retired = false, missing = false;
	const registry = { retirement: () => retired ? {} : undefined,
		registeredConversation: (key: string) => missing ? undefined : ({ roomId: key === id ? room : "!other:example.com", projectSpace: "!space:example.com", checkoutSpace: "!space:example.com" }) } as unknown as RelayRegistry;
	const migration = new OperatorAdminMigration({ registry, directory: "/unused", matrix: {
		operatorAdminSnapshot: async target => planOperatorAdmin({ ...base, ...target, powers }), applyOperatorAdmin: async () => { throw Error("Preview must not mutate"); },
	} });
	assert.equal((await migration.preview({ conversationIds: [id, other] })).rooms.length, 2);
	const shared = await migration.preview({ conversationIds: [id, other], includeSpaces: true });
	assert.equal(shared.rooms.length, 3); assert.equal(shared.rooms.filter(value => value.space).length, 1);
	retired = true; await assert.rejects(migration.preview({ conversationIds: [id] }), /Retired/);
	retired = false; missing = true; await assert.rejects(migration.preview({ conversationIds: [id] }), /no longer exists/);
});

test("admin model approval freezes powers and discloses nontransactional writes without interrupting active work", async () => {
	const id = `conv_${"a".repeat(32)}`; const selection = { conversationIds: [id] };
	let current = { selection, rooms: [planOperatorAdmin({ ...base, powers })] }; let applied = 0;
	const lifecycle = { adminApprovalPreview: async () => structuredClone(current), executeAdminApproval: async () => { applied++; } } as unknown as HostLifecycle;
	const owner = new ManagedHostMutationOwner({ registry: { hostId: "host" } as RelayRegistry, lifecycle,
		retirement: {} as ConversationRetirement, server: { attachment: () => ({ attachmentId: "live" }) } as unknown as Pick<ManagedSessionIpcServer, "attachment">,
		activeRun: async () => { throw Error("Admin must not touch active runs"); } });
	const preview = await owner.preview({ operation: "conversation.admin.preview", ...selection });
	const request: ModelHostRequest = { version: "1.0.0", actor: { kind: "model", requestId: "admin", conversationId: id,
		generationId: `generation_${"b".repeat(32)}`, runId: "run", toolCallId: "tool", presentation: "local_dialog" },
		action: { operation: "conversation.admin.apply", previewId: preview.previewId, confirmed: true } };
	const approval = prepareHostApproval("host", request, await owner.freeze(request), Date.now());
	assert.match(hostApprovalQuestion(approval), /no conditional power-state writes/);
	assert.match(hostApprovalQuestion(approval), /@operator:example.com/);
	await assert.rejects(owner.executeHuman(request), /independent consent/);
	assert.equal(await owner.revalidate(approval), true);
	current = { selection, rooms: [planOperatorAdmin({ ...base, powers: { ...powers, invite: 1 } })] };
	assert.equal(await owner.revalidate(approval), false);
	await assert.rejects(owner.execute(approval), /Frozen targets changed/); assert.equal(applied, 0);
});

test("migration writes durable attempt before PUT; interruption requires fresh consent, not receipt replay", async t => {
	const directory = await mkdtemp(join(tmpdir(), "operator-admin-")); t.after(() => rm(directory, { recursive: true, force: true }));
	const f = matrixFixture(); const id = `conv_${"a".repeat(32)}`;
	const registry = { retirement: () => undefined, registeredConversation: () => ({ roomId: room }) } as unknown as RelayRegistry;
	const migration = new OperatorAdminMigration({ registry, matrix: f.client, directory });
	const snapshot = await migration.preview({ conversationIds: [id] }); f.failPut = true;
	await assert.rejects(migration.apply(snapshot, `operation_${"a".repeat(32)}`));
	const receipt = JSON.parse(await readFile(join(directory, (await readdir(directory))[0]!), "utf8"));
	assert.equal(receipt.phase, "attempted"); assert.deepEqual(receipt.completed, []); assert.equal(receipt.attemptedRoom, room);
	const restarted = new OperatorAdminMigration({ registry, matrix: f.client, directory });
	assert.equal((await restarted.preview({ conversationIds: [id] })).rooms[0]!.change, false);
	await assert.rejects(restarted.apply(snapshot, `operation_${"b".repeat(32)}`), /changed/); assert.equal(f.writes.length, 1);
});
