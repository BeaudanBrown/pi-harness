import assert from "node:assert/strict";
import test from "node:test";
import { ManagedMatrixClient, ManagedMatrixError, describeMatrixFailure } from "../config/agent/extensions/managed-sessions/relay/matrix-client.js";
import { isMatrixRoomId } from "../config/agent/extensions/managed-sessions/room-identity.js";
import { parseManagedSessionEnvelope, MANAGED_SESSION_PROTOCOL_VERSION, deriveConversationId } from "../config/agent/extensions/managed-sessions/contracts.js";

const config = { homeserver: "https://matrix.example.com", accessToken: "private-token", botUserId: "@bot:example.com", operatorUserId: "@operator:example.com" };
const room = `!${"a".repeat(42)}A`;
const content = { room_version: "12", type: "m.space", "m.federate": false };
function fixture(options: { sender?: string; membership?: string; eventId?: string; eventContent?: unknown; roomVersion?: string; powers?: unknown } = {}) {
	const calls: Array<{ method: string; path: string; body?: any }> = [];
	const create = { ...content, room_version: options.roomVersion ?? "12" };
	const fetcher: typeof fetch = async (url, init) => {
		const path = decodeURIComponent(new URL(String(url)).pathname); const method = init?.method ?? "GET";
		calls.push({ method, path, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
		if (path.includes("/directory/room/")) return Response.json({ room_id: room, servers: ["example.com"] });
		if (path.endsWith("/createRoom")) return Response.json({ room_id: room });
		if (path.endsWith("/state/m.room.create/")) return Response.json(create);
		if (path.includes("/event/")) return Response.json({ type: "m.room.create", state_key: "", event_id: options.eventId ?? `$${room.slice(1)}`, room_id: room,
			sender: options.sender ?? config.botUserId, content: options.eventContent ?? create });
		if (path.endsWith("/state/m.room.power_levels/")) return Response.json(options.powers ?? { users_default: 0, state_default: 50, events: { "m.space.child": 100 } });
		if (path.includes("/state/m.room.member/")) return Response.json({ membership: options.membership ?? "join" });
		if (path.endsWith("/state")) return Response.json([{ type: "m.space.child", state_key: room, content: { via: ["example.com"] } }]);
		if (method === "PUT" && path.includes("/state/m.space.child/")) return Response.json({ event_id: "$linked" });
		throw Error(`Unexpected request: ${method} ${path}`);
	};
	return { calls, client: new ManagedMatrixClient(config, fetcher, [room, "!parent:example.com"], { maxAttempts: 1 }) };
}

test("room IDs accept strict v12 digests and legacy IDs but reject malformed/control-bearing input", () => {
	for (const id of [room, "!legacy:example.com", "!legacy:[::1]:8448", "!legacy:1.2.3.4", "!legacy:example.com.", "!legacy:xn--host-4za.example", "!😀:example.com"]) assert.equal(isMatrixRoomId(id), true, id);
	for (const id of ["!short", `!${"a".repeat(43)}`, `!${"a".repeat(42)}`, `!${"a".repeat(44)}`, `!${"a".repeat(42)}=`, "!x :example.com", "!x\u0000:example.com", `!${"a".repeat(250)}:example.com`, "!x:example.com:bad", "!x:foo..example", "!x:-example.com", "!x:example-.com", "!x:[not-an-ip]", "!x:[fe80::1%eth0]",  "!x:::1", "!x:example.com:123456", `!${"é".repeat(125)}:example.com`, "!x\u0085:example.com", "!\ud800:example.com", "#alias:example.com"]) assert.equal(isMatrixRoomId(id), false, id);
});

test("v12 alias, creator infinite authority, room creation and Space routing use verified identities", async () => {
	const { client, calls } = fixture();
	assert.equal(await client.resolvePrivateRoomAlias("project-space", true), room);
	await client.assertRoomAuthority(room, true, undefined, { spaceChild: true, kick: true });
	assert.equal(await client.createPrivateSpaceIdempotent("project", "project-space"), room);
	await client.addSpaceChild("!parent:example.com", room);
	assert.deepEqual(calls.find(call => call.method === "PUT")?.body, { via: ["example.com"], suggested: true });
	assert.deepEqual(await client.spaceChildren(room), [room]);
	assert.ok(calls.some(call => call.path.endsWith(`/event/$${room.slice(1)}`)));
});

for (const options of [
	{ sender: "@foreign:example.com" }, { membership: "leave" }, { eventId: "$wrong" },
	{ eventContent: { ...content, "m.federate": true } }, { roomVersion: "13" }, { powers: { state_default: "not-a-level" } },
]) test(`v12 ownership fails closed: ${JSON.stringify(options)}`, async () => {
	const { client, calls } = fixture(options);
	await assert.rejects(() => client.resolvePrivateRoomAlias("project-space", true), ManagedMatrixError);
	assert.equal(calls.some(call => call.method !== "GET"), false);
	await assert.rejects(() => client.addSpaceChild("!parent:example.com", room), /not owned/);
});

test("redacted provisioning diagnostics expose only whitelisted reasons and HTTP status", () => {
	assert.equal(describeMatrixFailure(new ManagedMatrixError("http", "private-token /private/path server body", 403)), "http (HTTP 403)");
	assert.match(describeMatrixFailure(new ManagedMatrixError("invalid_response", "Matrix v12 create event does not prove bot ownership")), /prove bot ownership/);
});

test("provisioning retry contracts require coordinator role, original identity and confirmation", () => {
	const base = { protocolVersion: MANAGED_SESSION_PROTOCOL_VERSION, messageId: "retry", conversationId: deriveConversationId("host", "coordinator"), role: "coordinator_adapter", type: "lifecycle.request" };
	const request = { operation: "conversation.provisioning.resume", creationKey: "retained-key", concept: "project", placement: { rootKey: "projects", workspace: "project", relativeCwd: "" }, confirmed: true };
	assert.ok(parseManagedSessionEnvelope({ ...base, payload: { request } }));
	for (const change of [{ confirmed: false }, { confirmed: undefined }, { path: "/arbitrary" }, { placement: { ...request.placement, relativeCwd: "../escape" } }]) {
		assert.throws(() => parseManagedSessionEnvelope({ ...base, payload: { request: { ...request, ...change } } }));
	}
	assert.throws(() => parseManagedSessionEnvelope({ ...base, role: "ordinary_adapter", payload: { request } }));
});

test("provisioning inspection contracts reject malformed persisted Matrix IDs", () => {
	const envelope = { protocolVersion: MANAGED_SESSION_PROTOCOL_VERSION, messageId: "inspect", conversationId: deriveConversationId("host", "coordinator"), role: "relay", type: "lifecycle.result" };
	const intent = { conversationId: deriveConversationId("host", "retained-key"), creationKey: "retained-key", concept: "project", createdAt: "2026-10-05T11:37:56.000Z", phase: "room", inProgress: false, retry: "manual" };
	for (const id of [room, "!legacy:example.com", "!malformed", "!x:[not-an-ip]", "!x:example.com:bad"]) {
		const payload = { operation: "conversation.provisioning.list", hostId: "host", intents: [{ ...intent, projectSpaceId: id }] };
		if (isMatrixRoomId(id)) assert.ok(parseManagedSessionEnvelope({ ...envelope, payload }));
		else assert.throws(() => parseManagedSessionEnvelope({ ...envelope, payload }), /malformed Matrix room ID/);
	}
});
