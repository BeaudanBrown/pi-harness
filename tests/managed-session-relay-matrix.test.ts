import assert from "node:assert/strict";
import test from "node:test";
import {
	ManagedMatrixClient,
	ManagedMatrixError,
	managedMatrixConfigFromEnvironment,
} from "../config/agent/extensions/managed-sessions/relay/matrix-client.js";

const token = "super-secret-matrix-token";
const config = {
	homeserver: "https://matrix.example.com",
	accessToken: token,
	botUserId: "@bot:example.com",
	operatorUserId: "@operator:example.com",
};

test("Matrix client exposes only fixed whoami, sync, room, state, send, and leave routes", async () => {
	const calls: Array<{ url: URL; init?: RequestInit }> = [];
	const fetchMock: typeof fetch = async (input, init) => {
		const url = new URL(String(input));
		calls.push({ url, init });
		if (url.pathname.endsWith("/whoami")) return Response.json({ user_id: config.botUserId });
		if (url.pathname.endsWith("/sync")) return Response.json({ next_batch: "cursor-2", rooms: {} });
		if (url.pathname.endsWith("/createRoom")) return Response.json({ room_id: "!room:example.com" });
		if (url.pathname.includes("/send/")) return Response.json({ event_id: "$sent" });
		return Response.json({});
	};
	const client = new ManagedMatrixClient(config, fetchMock);
	assert.equal(await client.whoami(), config.botUserId);
	assert.equal((await client.sync("cursor-1")).nextBatch, "cursor-2");
	assert.equal(await client.createPrivateRoom("pi · work"), "!room:example.com");
	await client.setRoomName("!room:example.com", "work");
	assert.equal(await client.sendText("!room:example.com", "pi_txn", "hello"), "$sent");
	await client.leaveRoom("!room:example.com");
	assert.deepEqual(calls.map((call) => [call.init?.method, call.url.pathname]), [
		["GET", "/_matrix/client/v3/account/whoami"],
		["GET", "/_matrix/client/v3/sync"],
		["POST", "/_matrix/client/v3/createRoom"],
		["PUT", "/_matrix/client/v3/rooms/!room%3Aexample.com/state/m.room.name/"],
		["PUT", "/_matrix/client/v3/rooms/!room%3Aexample.com/send/m.room.message/pi_txn"],
		["POST", "/_matrix/client/v3/rooms/!room%3Aexample.com/leave"],
	]);
	assert.ok(calls.every((call) => new Headers(call.init?.headers).get("authorization") === `Bearer ${token}`));
	assert.ok(!JSON.stringify(client).includes(token));
	await assert.rejects(() => client.sendText("!unmanaged:example.com", "pi_other", "no"), /not owned/);
});

test("Matrix host Space operations are fixed, managed-room scoped, and accessibility checked", async () => {
	const calls: Array<{ method?: string; path: string; body?: string }> = [];
	let creates = 0;
	const client = new ManagedMatrixClient(config, async (input, init) => {
		const path = new URL(String(input)).pathname;
		calls.push({ method: init?.method, path, ...(typeof init?.body === "string" ? { body: init.body } : {}) });
		if (path.endsWith("/createRoom")) return Response.json({ room_id: ++creates === 1 ? "!space:example.com" : "!child:example.com" });
		return Response.json({});
	});
	const space = await client.createPrivateSpace("pi · host");
	const room = await client.createPrivateRoom("pi · coordinator");
	await client.addSpaceChild(space, room);
	assert.equal(await client.roomAccessible(room), true);
	assert.match(calls[0]?.body ?? "", /"type":"m.space"/);
	assert.match(calls[2]?.body ?? "", /"via":\["example.com"\]/);
	assert.deepEqual(calls.map((call) => [call.method, call.path]), [
		["POST", "/_matrix/client/v3/createRoom"],
		["POST", "/_matrix/client/v3/createRoom"],
		["PUT", "/_matrix/client/v3/rooms/!space%3Aexample.com/state/m.space.child/!child%3Aexample.com"],
		["GET", "/_matrix/client/v3/rooms/!child%3Aexample.com/state/m.room.create/"],
	]);
});

test("Matrix errors are typed, cancellable, bounded, and credential-redacted", async () => {
	const httpClient = new ManagedMatrixClient(config, async () => new Response(token, { status: 503 }));
	await assert.rejects(() => httpClient.whoami(), (error: unknown) => {
		assert.ok(error instanceof ManagedMatrixError);
		assert.equal(error.code, "http");
		assert.equal(error.retryable, true);
		assert.ok(!String(error).includes(token));
		return true;
	});
	const controller = new AbortController();
	controller.abort();
	const cancelledClient = new ManagedMatrixClient(config, async () => { throw new Error(token); });
	await assert.rejects(() => cancelledClient.sync(undefined, controller.signal), (error: unknown) => error instanceof ManagedMatrixError && error.code === "cancelled" && !String(error).includes(token));
	const oversized = new ManagedMatrixClient(config, async () => new Response("{}", { headers: { "content-length": String(4 * 1024 * 1024 + 1) } }));
	await assert.rejects(() => oversized.whoami(), /size limit/);
});

test("Matrix environment validation rejects non-HTTPS and credential-bearing homeservers", () => {
	const environment = {
		PI_MATRIX_HOMESERVER: "http://matrix.example.com",
		PI_MATRIX_ACCESS_TOKEN: token,
		PI_MATRIX_BOT_USER_ID: config.botUserId,
		PI_MATRIX_OPERATOR_USER_ID: config.operatorUserId,
	};
	assert.throws(() => managedMatrixConfigFromEnvironment(environment), /credential-free HTTPS/);
	assert.throws(() => managedMatrixConfigFromEnvironment({ ...environment, PI_MATRIX_HOMESERVER: "https://user:password@matrix.example.com" }), /credential-free HTTPS/);
});
