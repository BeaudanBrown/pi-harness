import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { HostDispatcher } from "../config/agent/extensions/managed-sessions/relay/host-dispatcher.js";
import { HostPolicy } from "../config/agent/extensions/managed-sessions/relay/host-policy.js";
import type { HostActor, HostResponse } from "../config/agent/extensions/managed-sessions/live-workspace-contracts.js";

const id = (prefix: string, letter = "a") => `${prefix}_${letter.repeat(32)}`;
const protectedConversationId = id("conv", "b");
const human = (requestId = "request-1"): HostActor => ({ kind: "human_local", requestId });
const model: HostActor = { kind: "model", requestId: "model-1", conversationId: id("conv"), generationId: id("generation"), runId: "run-1", toolCallId: "tool-1", presentation: "local_dialog" };
const status = { hostId: "host", relayState: "ready", capabilities: ["host-control-v1"], accountState: "unavailable" };
const request = (action: unknown = { operation: "host.status" }, actor = human()) => ({ version: "1.0.0", action, actor });
function code(response: HostResponse): string { if (response.ok) assert.fail("Expected failure"); return response.error.code; }
function harness(options: { now?: () => number; requestCapacity?: number; data?: unknown; load?: () => Promise<unknown> } = {}) {
	let reads = 0;
	const dispatcher = new HostDispatcher({ hostId: "host", protectedConversationId,
		policy: new HostPolicy(JSON.parse(readFileSync("config/agent/managed-host-policy.json", "utf8"))),
		read: async () => { reads++; return options.load ? options.load() : options.data ?? status; }, ...options });
	return { dispatcher, reads: () => reads };
}

test("dispatcher validates both boundaries and requires authenticated frontend identity", async () => {
	const { dispatcher, reads } = harness();
	assert.equal((await dispatcher.dispatch(request(), human())).ok, true);
	assert.equal(code(await dispatcher.dispatch({ ...request(), version: "2.0.0" }, human())), "upgrade_required");
	assert.equal(code(await dispatcher.dispatch(request({ operation: "host.status", argv: [] }), human())), "invalid_request");
	assert.equal(code(await dispatcher.dispatch(request({ operation: "arbitrary" }), human())), "invalid_request");
	assert.equal(code(await dispatcher.dispatch(request(), model)), "forbidden");
	assert.equal(code(await dispatcher.dispatch(request(undefined, model), human())), "forbidden");
	assert.equal(reads(), 1);
	const broken = harness({ data: { ...status, nonce: "private-secret" } });
	const result = await broken.dispatcher.dispatch(request(), human());
	assert.equal(code(result), "failed"); assert.ok(!JSON.stringify(result).includes("private-secret"));
});

test("model mutations, protected coordinator actions and staged human mutations never reach legacy execution", async () => {
	const { dispatcher, reads } = harness();
	assert.equal(code(await dispatcher.dispatch(request({ operation: "conversation.stop", conversationId: id("conv") }, model), model)), "approval_required");
	assert.equal(code(await dispatcher.dispatch(request({ operation: "conversation.stop", conversationId: id("conv") }), human())), "upgrade_required");
	const actor = human("coordinator-stop");
	assert.equal(code(await dispatcher.dispatch(request({ operation: "conversation.stop", conversationId: protectedConversationId }, actor), actor)), "forbidden");
	const readActor = { ...model, requestId: "model-read" };
	assert.equal((await dispatcher.dispatch(request(undefined, readActor), readActor)).ok, true);
	assert.equal(reads(), 1);
});

test("human opens revalidate through the launch owner while model opens still require approval", async () => {
	let launches = 0; let available = true;
	const dispatcher = new HostDispatcher({ hostId: "host", protectedConversationId,
		policy: new HostPolicy(JSON.parse(readFileSync("config/agent/managed-host-policy.json", "utf8"))), read: async () => status,
		launch: async (action) => {
			launches++; if (!available) throw Error("target disappeared");
			return { conversationId: action.conversationId, launchId: id("launch"), launchState: "window_created",
				window: { conversationId: action.conversationId, sessionName: "default", windowId: "@1", paneId: "%1" } };
		} });
	const action = { operation: "conversation.open", conversationId: protectedConversationId };
	assert.equal((await dispatcher.dispatch(request(action), human())).ok, true);
	available = false;
	assert.equal(code(await dispatcher.dispatch(request(action), human())), "failed", "same request ID cannot replay a stale target");
	assert.equal(code(await dispatcher.dispatch(request(action, model), model)), "approval_required");
	assert.equal(launches, 2);
});

test("retained identity rejects changed arguments and requester context without depending on property order", async () => {
	const { dispatcher, reads } = harness();
	const original = request();
	assert.equal((await dispatcher.dispatch(original, human())).ok, true);
	assert.equal((await dispatcher.dispatch({ actor: { requestId: "request-1", kind: "human_local" }, action: original.action, version: original.version }, human())).ok, true);
	assert.equal(code(await dispatcher.dispatch(request({ operation: "workspace.list" }), human())), "conflict");
	const actor = { ...model, requestId: "request-1" };
	assert.equal(code(await dispatcher.dispatch(request(undefined, actor), actor)), "conflict");
	assert.equal(reads(), 1, "retained exact retries replay the validated read result");
});

test("read retries join in-flight work and replay detached results for 60 seconds after completion", async () => {
	let now = 0; let release!: (data: unknown) => void;
	const gate = new Promise<unknown>((resolve) => { release = resolve; });
	const { dispatcher, reads } = harness({ now: () => now, requestCapacity: 1, load: () => gate });
	const first = dispatcher.dispatch(request(), human()); const second = dispatcher.dispatch(request(), human());
	await Promise.resolve(); assert.equal(reads(), 1);
	now = 120_000; const third = dispatcher.dispatch(request(), human());
	const other = human("other"); assert.equal(code(await dispatcher.dispatch(request(undefined, other), other)), "unavailable");
	const backend = structuredClone(status); release(backend);
	const results = await Promise.all([first, second, third]); assert.deepEqual(results[0], results[1]); assert.deepEqual(results[0], results[2]);
	const expected = structuredClone(results[0]); backend.hostId = "backend-changed";
	assert.ok(results[0].ok); (results[0].data as typeof status).hostId = "caller-changed";
	now = 179_999; assert.deepEqual(await dispatcher.dispatch(request(), human()), expected); assert.equal(reads(), 1);
	now = 180_000; assert.notDeepEqual(await dispatcher.dispatch(request(), human()), expected); assert.equal(reads(), 2);
});

test("retained sanitized errors are frozen too; a new request ID can observe recovery", async () => {
	let fail = true;
	const { dispatcher, reads } = harness({ load: async () => { if (fail) throw Error("private backend details"); return status; } });
	const failed = await dispatcher.dispatch(request(), human()); assert.equal(code(failed), "failed");
	fail = false; assert.deepEqual(await dispatcher.dispatch(request(), human()), failed); assert.equal(reads(), 1);
	assert.ok(!JSON.stringify(failed).includes("private backend"));
	const next = human("recovered"); assert.equal((await dispatcher.dispatch(request(undefined, next), next)).ok, true); assert.equal(reads(), 2);
});

test("collision guard fails closed at capacity rather than forgetting retained identities", async () => {
	let now = 0; const { dispatcher, reads } = harness({ now: () => now, requestCapacity: 1 });
	assert.equal((await dispatcher.dispatch(request(), human())).ok, true);
	const second = human("second");
	assert.equal(code(await dispatcher.dispatch(request(undefined, second), second)), "unavailable");
	assert.equal(code(await dispatcher.dispatch(request({ operation: "workspace.list" }), human())), "conflict");
	now = 60_000;
	assert.equal((await dispatcher.dispatch(request(undefined, second), second)).ok, true);
	assert.equal(reads(), 2);
});
