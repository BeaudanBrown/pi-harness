import assert from "node:assert/strict";
import test from "node:test";
import { retryMatrixStartup } from "../config/agent/extensions/managed-sessions/relay/startup-retry.js";
import { ManagedMatrixError } from "../config/agent/extensions/managed-sessions/relay/matrix-client.js";

test("startup retries transient Matrix failure in place with bounded backoff", async () => {
	let calls = 0, blocked = 0;
	const delays: number[] = [];
	const result = await retryMatrixStartup(async () => {
		if (++calls < 9) throw new ManagedMatrixError("http", "unavailable", 503, true);
		return "ready";
	}, async () => { blocked++; }, undefined, async (ms) => { delays.push(ms); });
	assert.equal(result, "ready"); assert.equal(blocked, 8);
	assert.ok(delays.every(ms => ms >= 1000 && ms < 30_500));
});

test("startup does not retry invalid credentials or malformed state", async () => {
	for (const error of [new ManagedMatrixError("http", "unauthorized", 401, false), new Error("invalid state")]) {
		await assert.rejects(retryMatrixStartup(async () => { throw error; }, async () => { assert.fail("not transient"); }), error);
	}
});

test("startup retry is cancellable without waiting for the next network attempt", async () => {
	const controller = new AbortController();
	await assert.rejects(retryMatrixStartup(async () => { throw new ManagedMatrixError("http", "unavailable", 502, true); },
		async () => { controller.abort(); }, controller.signal), { name: "AbortError" });
});
