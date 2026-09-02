import assert from "node:assert/strict";
import test from "node:test";
import {
	ManagedMatrixClient,
	ManagedMatrixError,
	managedMatrixConfigFromEnvironment,
} from "../config/agent/extensions/managed-sessions/relay/matrix-client.js";
import { redactManagedValue } from "../config/agent/extensions/managed-sessions/relay/redaction.js";

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
		if (url.pathname.includes("/state/m.room.member/")) return Response.json({ membership: "join" });
		if (url.pathname.includes("/send/")) return Response.json({ event_id: "$sent" });
		return Response.json({});
	};
	const client = new ManagedMatrixClient(config, fetchMock);
	assert.equal(await client.whoami(), config.botUserId);
	assert.equal((await client.sync("cursor-1")).nextBatch, "cursor-2");
	assert.equal(await client.createPrivateRoom("pi · work"), "!room:example.com");
	await client.setRoomName("!room:example.com", "work");
	assert.equal(await client.memberJoined("!room:example.com", config.operatorUserId), true);
	assert.equal(await client.sendText("!room:example.com", "pi_txn", "hello"), "$sent");
	await client.leaveRoom("!room:example.com");
	assert.deepEqual(calls.map((call) => [call.init?.method, call.url.pathname]), [
		["GET", "/_matrix/client/v3/account/whoami"],
		["GET", "/_matrix/client/v3/sync"],
		["POST", "/_matrix/client/v3/createRoom"],
		["PUT", "/_matrix/client/v3/rooms/!room%3Aexample.com/state/m.room.name/"],
		["GET", "/_matrix/client/v3/rooms/!room%3Aexample.com/state/m.room.member/%40operator%3Aexample.com"],
		["PUT", "/_matrix/client/v3/rooms/!room%3Aexample.com/send/m.room.message/pi_txn"],
		["POST", "/_matrix/client/v3/rooms/!room%3Aexample.com/leave"],
	]);
	assert.ok(calls.every((call) => new Headers(call.init?.headers).get("authorization") === `Bearer ${token}`));
	assert.ok(!JSON.stringify(client).includes(token));
	await assert.rejects(() => client.sendText("!unmanaged:example.com", "pi_other", "no"), /not owned/);
});

test("Matrix rich primitives emit exact MSC3381 wire dialects and bounded edit fallback", async () => {
	const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
	const client = new ManagedMatrixClient(config, async (input, init) => {
		calls.push({ path: new URL(String(input)).pathname, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
		return Response.json({ event_id: `$event-${calls.length}` });
	}, ["!rich:example.com"]);
	await client.setTyping("!rich:example.com", true, 5_000);
	await client.setTyping("!rich:example.com", false);
	await client.sendNotice("!rich:example.com", "pi_notice", "working");
	await client.replaceMessage("!rich:example.com", "pi_edit", "$event-3", "done");
	await client.startPoll("!rich:example.com", "pi_poll", "Continue?", [{ id: "yes", text: "Yes" }, { id: "no", text: "No" }]);
	await client.endPoll("!rich:example.com", "pi_poll_end", "$event-5");
	await client.startPoll("!rich:example.com", "pi_poll_stable", "Stable?", [{ id: "yes", text: "Yes" }], undefined, "stable");
	await client.endPoll("!rich:example.com", "pi_poll_end_stable", "$event-7", "Closed", undefined, "stable");
	await client.replaceMessage("!rich:example.com", "pi_edit_max", "$event-3", "x".repeat(32_768));

	assert.deepEqual(calls[0]?.body, { typing: true, timeout: 5_000 });
	assert.deepEqual(calls[1]?.body, { typing: false });
	assert.deepEqual(calls[3], {
		path: "/_matrix/client/v3/rooms/!rich%3Aexample.com/send/m.room.message/pi_edit",
		body: { msgtype: "m.notice", body: "* done", "m.new_content": { msgtype: "m.notice", body: "done" },
			"m.relates_to": { rel_type: "m.replace", event_id: "$event-3" } },
	});
	assert.deepEqual(calls[4], {
		path: "/_matrix/client/v3/rooms/!rich%3Aexample.com/send/org.matrix.msc3381.poll.start/pi_poll",
		body: {
			"org.matrix.msc1767.text": "Continue?\n1. Yes\n2. No",
			"org.matrix.msc3381.poll.start": {
				kind: "org.matrix.msc3381.poll.disclosed", max_selections: 1,
				question: { "org.matrix.msc1767.text": "Continue?" },
				answers: [{ id: "yes", "org.matrix.msc1767.text": "Yes" }, { id: "no", "org.matrix.msc1767.text": "No" }],
			},
		},
	});
	assert.deepEqual(calls[5], {
		path: "/_matrix/client/v3/rooms/!rich%3Aexample.com/send/org.matrix.msc3381.poll.end/pi_poll_end",
		body: { "m.relates_to": { rel_type: "m.reference", event_id: "$event-5" }, "org.matrix.msc1767.text": "Poll closed", "org.matrix.msc3381.poll.end": {} },
	});
	assert.deepEqual(calls[6], {
		path: "/_matrix/client/v3/rooms/!rich%3Aexample.com/send/m.poll.start/pi_poll_stable",
		body: {
			"m.text": [{ mimetype: "text/plain", body: "Stable?\n1. Yes" }],
			"m.poll": { kind: "m.disclosed", max_selections: 1, question: { "m.text": [{ body: "Stable?" }] },
				answers: [{ "m.id": "yes", "m.text": [{ body: "Yes" }] }] },
		},
	});
	assert.deepEqual(calls[7], {
		path: "/_matrix/client/v3/rooms/!rich%3Aexample.com/send/m.poll.end/pi_poll_end_stable",
		body: { "m.relates_to": { rel_type: "m.reference", event_id: "$event-7" }, "m.text": [{ mimetype: "text/plain", body: "Closed" }] },
	});
	assert.equal(String(calls[8]?.body.body).length, 32_768);
	assert.equal((calls[8]?.body["m.new_content"] as { body: string }).body.length, 32_768);
	await assert.rejects(() => client.startPoll("!rich:example.com", "pi_bad", "q", [], undefined), /out of bounds/);
});

test("control poll resolution revalidates durable bot-owned poll content after restart", async () => {
	let event: unknown = { sender: config.botUserId, type: "m.poll.start", content: { "m.poll": { kind: "m.disclosed", max_selections: 1,
		answers: [{ "m.id": "pi-control-0", "m.text": [{ body: "!model scoped/model" }] }] } } };
	const client = new ManagedMatrixClient(config, async () => Response.json(event), ["!control:example.com"]);
	assert.equal(await client.controlPollAnswer("!control:example.com", "$poll", "pi-control-0"), "!model scoped/model");
	event = { ...(event as object), sender: "@other:example.com" };
	assert.equal(await client.controlPollAnswer("!control:example.com", "$poll", "pi-control-0"), undefined);
	event = { sender: config.botUserId, type: "m.poll.start", content: { "m.poll": { kind: "m.disclosed", max_selections: 1,
		answers: [{ "m.id": "checkpoint-answer", "m.text": [{ body: "!model forbidden" }] }] } } };
	assert.equal(await client.controlPollAnswer("!control:example.com", "$poll", "checkpoint-answer"), undefined, "non-control polls cannot be reinterpreted as controls");
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
	const httpClient = new ManagedMatrixClient(config, async () => new Response(token, { status: 503 }), [], { maxAttempts: 1 });
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

test("Matrix retries rate limits and uncertain sends with bounded deterministic delay and one transaction", async () => {
	const delays: number[] = []; const calls: Array<{ path: string; body?: BodyInit | null }> = []; let attempt = 0;
	const client = new ManagedMatrixClient(config, async (input, init) => {
		calls.push({ path: new URL(String(input)).pathname, body: init?.body }); attempt += 1;
		if (attempt === 1) return Response.json({ errcode: "M_LIMIT_EXCEEDED", retry_after_ms: 1_234, secret: token }, { status: 429 });
		if (attempt === 2) throw new Error(token);
		return Response.json({ event_id: "$retry-sent" });
	}, ["!retry:example.com"], { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 2_000, random: () => 0,
		sleep: async (delay) => { delays.push(delay); } });
	assert.equal(await client.sendText("!retry:example.com", "pi_stable_retry", "retry"), "$retry-sent");
	assert.deepEqual(delays, [1_234, 100]);
	assert.equal(new Set(calls.map((call) => `${call.path}\0${String(call.body)}`)).size, 1);
	assert.ok(calls.every((call) => call.path.endsWith("/pi_stable_retry")));
	assert.ok(!JSON.stringify(delays).includes(token));
});

test("Matrix backoff cancellation stops retries without a busy loop", async () => {
	const controller = new AbortController(); let calls = 0;
	const client = new ManagedMatrixClient(config, async () => { calls += 1; return new Response("{}", { status: 503 }); }, [], {
		maxAttempts: 5, sleep: async (_delay, signal) => { controller.abort(); if (signal?.aborted) throw new ManagedMatrixError("cancelled", "Matrix request was cancelled"); },
	});
	await assert.rejects(() => client.whoami(controller.signal), (error: unknown) => error instanceof ManagedMatrixError && error.code === "cancelled");
	assert.equal(calls, 1);
});

test("fault diagnostics redact bearer and credential environment values", () => {
	const rendered = redactManagedValue(new Error(`Bearer ${token}\npassword=${token}`), { PI_MATRIX_ACCESS_TOKEN: token, OTHER: "visible" });
	assert.equal(rendered.includes(token), false);
	assert.equal(rendered.includes("[REDACTED]"), true);
	assert.equal(rendered.includes("\n"), false);
	assert.equal(redactManagedValue("token=x", { PI_MATRIX_ACCESS_TOKEN: "x" }).includes("x"), false);
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
	assert.equal(managedMatrixConfigFromEnvironment({ ...environment, PI_MATRIX_HOMESERVER: config.homeserver,
		PI_MATRIX_ACCESS_TOKEN: " =opaque-token= " }).accessToken, " =opaque-token= ");
});
