import assert from "node:assert/strict";
import test from "node:test";
import { ManagedMatrixClient } from "../config/agent/extensions/managed-sessions/relay/matrix-client.js";
import { MANAGED_PROVENANCE_EVENT, type ManagedProvenance } from "../config/agent/extensions/managed-sessions/managed-provenance.js";

const config = { homeserver: "https://matrix.example.com", accessToken: "token", botUserId: "@bot:example.com", operatorUserId: "@operator:example.com" };
const proof: ManagedProvenance = { version: 1, hostId: "host", kind: "project_space", projectKey: `project_${"a".repeat(32)}`, creationKey: `project_${"a".repeat(32)}`, parentRoomId: "!host:example.com" };
function fixture(version: string, options: { existing?: boolean; capabilities?: unknown; loseReply?: boolean; proof?: ManagedProvenance } = {}) {
	const room = version === "12" ? `!${"a".repeat(42)}A` : "!space:example.com";
	let exists = options.existing ?? false, lose = options.loseReply ?? false;
	let powers: any = { users: version === "12" ? {} : { [config.botUserId]: 100 } };
	const creation = { room_version: version, type: "m.space", "m.federate": false, ...(Number(version) <= 10 ? { creator: config.botUserId } : {}) };
	const event = { type: "m.room.create", state_key: "", sender: config.botUserId, event_id: `$${room.slice(1)}`, room_id: room, content: creation };
	const calls: Array<{ method: string; path: string; body?: any }> = [];
	const client = new ManagedMatrixClient(config, async (url, init) => {
		const path = decodeURIComponent(new URL(String(url)).pathname), method = init?.method ?? "GET";
		const body = init?.body ? JSON.parse(String(init.body)) : undefined; calls.push({ method, path, body });
		if (path.endsWith("/capabilities")) return Response.json(options.capabilities ?? { capabilities: { "m.room_versions": { default: version, available: { [version]: "stable" } } } });
		if (path.includes("/directory/room/")) return exists ? Response.json({ room_id: room }) : new Response("missing", { status: 404 });
		if (path.endsWith("/createRoom")) { exists = true; powers = body.power_level_content_override; if (lose) { lose = false; throw Error("lost response"); } return Response.json({ room_id: room }); }
		if (path.endsWith("/state/m.room.create/")) return Response.json(creation);
		if (path.endsWith("/state/m.room.power_levels/")) return Response.json(powers);
		if (path.includes("/state/m.room.member/")) return Response.json({ membership: path.endsWith(config.operatorUserId) ? "invite" : "join" });
		if (path.includes("/event/")) return Response.json(event);
		if (path.endsWith("/state")) return Response.json([event,
			{ type: "m.room.join_rules", state_key: "", content: { join_rule: "invite" } },
			{ type: MANAGED_PROVENANCE_EVENT, state_key: "", sender: config.botUserId, content: options.proof ?? proof }]);
		throw Error(`Unexpected ${method} ${path}`);
	}, [], { maxAttempts: 1 });
	return { client, calls, room, revoke: () => { delete powers.users[config.operatorUserId]; } };
}
for (const version of ["10", "11", "12"]) test(`migration Space atomically pins v${version} and grants only operator admin`, async () => {
	const f = fixture(version);
	assert.equal(await f.client.ensureManagedRoom("Project", proof, undefined, true), f.room);
	await f.client.assertOperatorSpaceAdmin(f.room);
	const body = f.calls.find(call => call.path.endsWith("/createRoom"))!.body;
	assert.equal(body.room_version, version); assert.equal(body.preset, "private_chat");
	assert.deepEqual(body.power_level_content_override.users, { ...(version === "12" ? {} : { [config.botUserId]: 100 }), [config.operatorUserId]: 100 });
	assert.deepEqual(body.invite, [config.operatorUserId]);
	assert.ok(!f.calls.some(call => call.method === "PUT"), "never rewrites existing power state");
	f.revoke(); await assert.rejects(f.client.assertOperatorSpaceAdmin(f.room), /separately approved admin migration/);
});
test("existing alias without admin is not promoted and uncertain creation does not duplicate", async () => {
	const existing = fixture("12", { existing: true });
	await existing.client.ensureManagedRoom("Project", proof, undefined, true);
	await assert.rejects(existing.client.assertOperatorSpaceAdmin(existing.room), /separately approved/);
	assert.ok(existing.calls.every(call => call.method === "GET"));
	const uncertain = fixture("12", { loseReply: true });
	await uncertain.client.ensureManagedRoom("Project", proof, undefined, true);
	await uncertain.client.assertOperatorSpaceAdmin(uncertain.room);
	assert.equal(await uncertain.client.recoverManagedAlias(proof), uncertain.room);
	assert.equal(uncertain.calls.filter(call => call.path.endsWith("/createRoom")).length, 1);
});
for (const kind of ["archive_root_space", "archive_project_space", "archive_worktree_space"] as const) test(`${kind} uses pinned v12 admin policy without rewriting power state`, async () => {
	const archived: ManagedProvenance = { version: 1, hostId: "host", kind, creationKey: "archive-space", parentRoomId: "!parent:example.com",
		...(kind !== "archive_root_space" ? { projectKey: `project_${"a".repeat(32)}` } : {}), ...(kind === "archive_worktree_space" ? { checkoutId: `checkout_${"b".repeat(32)}` } : {}) } as ManagedProvenance;
	const f = fixture("12", { proof: archived, loseReply: true });
	await f.client.ensureManagedRoom("Archive", archived, undefined, true); await f.client.assertOperatorSpaceAdmin(f.room);
	assert.equal(await f.client.recoverManagedAlias(archived), f.room);
	const creates = f.calls.filter(call => call.path.endsWith("/createRoom")); assert.equal(creates.length, 1);
	assert.equal(creates[0]!.body.room_version, "12"); assert.deepEqual(creates[0]!.body.power_level_content_override.users, { [config.operatorUserId]: 100 });
	assert.equal(creates[0]!.body.creation_content.type, "m.space"); assert.ok(!f.calls.some(call => call.method === "PUT"));
});
test("archive link snapshots require a successful bounded unambiguous state read", async () => {
	const roomId = "!space:example.com", child = "!child:example.com";
	let status = 200; let state: unknown = [];
	const client = new ManagedMatrixClient(config, async () => Response.json(state, { status }), [roomId], { maxAttempts: 1 });
	assert.equal(await client.spaceChildContent(roomId, child), null);
	const event = { type: "m.space.child", state_key: child, content: { via: ["example.com"], order: "operator-order" } }; state = [event];
	assert.deepEqual(await client.spaceChildContent(roomId, child), event.content);
	for (const malformed of [[event, event], [null], [{ ...event, content: { huge: "x".repeat(16385) } }]]) {
		state = malformed; await assert.rejects(client.spaceChildContent(roomId, child));
	}
	status = 404; state = {}; await assert.rejects(client.spaceChildContent(roomId, child), "HTTP failure must never be interpreted as an absent child");
});
test("unsupported capabilities fail before create", async () => {
	for (const capabilities of [{}, { capabilities: { "m.room_versions": { default: "13", available: { "13": "stable" } } } }]) {
		const f = fixture("12", { capabilities });
		await assert.rejects(f.client.ensureManagedRoom("Project", proof, undefined, true), /No supported stable room version/);
		assert.ok(!f.calls.some(call => call.method !== "GET"));
	}
});
