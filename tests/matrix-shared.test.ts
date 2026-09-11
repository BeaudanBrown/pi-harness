import test from "node:test";
import assert from "node:assert/strict";
import { MatrixHttp, MatrixError, MAX_MATRIX_RESPONSE_BYTES } from "../config/agent/extensions/matrix-shared/http.js";
import { OwnerMatrix } from "../config/agent/extensions/bridge-chat/transport.js";
import { ManagedMatrixClient } from "../config/agent/extensions/managed-sessions/relay/matrix-client.js";
const config = { homeserver: "https://matrix.example.com", accessToken: "fixture-token", botUserId: "@bot:example.com", operatorUserId: "@owner:example.com" };

test("shared JSON transport keeps credentials in headers, rejects redirects and foreign paths", async () => {
	let calls = 0;
	const http = new MatrixHttp(config, async (url, init) => {
		calls++; assert.equal(String(url), config.homeserver + "/_matrix/client/v3/account/whoami");
		assert.equal(init?.redirect, "error"); assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer fixture-token");
		return new Response('{"user_id":"@owner:example.com"}');
	});
	await http.request("GET", "/_matrix/client/v3/account/whoami");
	for (const uri of ["//other/_matrix/x", "https://other/_matrix/x", "/other"]) await assert.rejects(http.request("GET", uri));
	assert.equal(calls, 1);
	for (const origin of ["http://a", "https://user@a", "https://a/path", "https://a/?secret=x"]) assert.throws(() => new MatrixHttp({ ...config, homeserver: origin }));
});
test("streaming byte bound applies before buffering unbounded JSON", async () => {
	let cancelled = false;
	const http = new MatrixHttp(config, async () => new Response(new ReadableStream({
		pull(controller) { controller.enqueue(new Uint8Array(MAX_MATRIX_RESPONSE_BYTES + 1)); },
		cancel() { cancelled = true; },
	})), { maxAttempts: 1 });
	await assert.rejects(http.request("GET", "/_matrix/x"), /size limit/); assert.equal(cancelled, true);
});
test("managed retries stay enabled; chat deliberately never retries uncertain PUT", async () => {
	let managedCalls = 0, chatCalls = 0;
	const managed = new ManagedMatrixClient(config, async () => {
		managedCalls++; return managedCalls === 1 ? new Response('{}', { status: 503 }) : new Response('{"user_id":"@bot:example.com"}');
	}, [], { sleep: async () => {} });
	assert.equal(await managed.whoami(), config.botUserId); assert.equal(managedCalls, 2);
	const chat = new OwnerMatrix(config, async (_url, init) => {
		chatCalls++; assert.deepEqual(JSON.parse(String(init?.body)), { msgtype: "m.text", body: "Pi: answer", "m.mentions": {} });
		return new Response('{"error":"private sentinel"}', { status: 503 });
	});
	await assert.rejects(chat.send("!room:example.com", "pi-txn", "answer"), e => e instanceof MatrixError && !e.message.includes("sentinel"));
	assert.equal(chatCalls, 1);
});
test("shared sync mechanics preserve separate account filters and cursors", async () => {
	const observed: URL[] = [];
	const fetcher: typeof fetch = async url => { observed.push(new URL(String(url))); return new Response('{"next_batch":"new"}'); };
	const managed = new ManagedMatrixClient(config, fetcher);
	const chat = new OwnerMatrix({ ...config, accessToken: "other-token" }, fetcher);
	await managed.sync("managed-cursor"); await chat.sync("chat-cursor", [config.operatorUserId], 0);
	assert.equal(observed[0].searchParams.get("since"), "managed-cursor"); assert.equal(observed[0].searchParams.get("filter"), null);
	assert.equal(observed[1].searchParams.get("since"), "chat-cursor");
	assert.deepEqual(JSON.parse(observed[1].searchParams.get("filter")!).room.timeline.senders, [config.operatorUserId]);
});
