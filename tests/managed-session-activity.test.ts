import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MANAGED_SESSION_PROTOCOL_VERSION, deriveConversationId, type ManagedSessionEnvelope } from "../config/agent/extensions/managed-sessions/contracts.js";
import { deriveActivityId, deriveGenerationId } from "../config/agent/extensions/managed-sessions/v2-contracts.js";
import { ActivityProjector } from "../config/agent/extensions/managed-sessions/relay/activity-projector.js";
import { ManagedMatrixClient } from "../config/agent/extensions/managed-sessions/relay/matrix-client.js";
import type { RelayRegistry } from "../config/agent/extensions/managed-sessions/relay/registry.js";

const conversationId = deriveConversationId("host", "activity");
const roomId = "!activity:example.com";
const activityId = deriveActivityId(deriveGenerationId(conversationId, 1), "user-entry");
const envelope = (type: string, payload: Record<string, unknown>): ManagedSessionEnvelope => ({
	protocolVersion: MANAGED_SESSION_PROTOCOL_VERSION, messageId: `${type}-${String(payload.revision)}`, conversationId,
	role: "ordinary_adapter", type, payload,
});

test("typing serializes a delayed stop before a newer start without blocking work or other rooms", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "managed-typing-race-")); t.after(() => rm(root, { recursive: true, force: true }));
	let releaseStop!: () => void; let stopped!: () => void;
	const stopStarted = new Promise<void>((resolve) => { stopped = resolve; });
	const stopGate = new Promise<void>((resolve) => { releaseStop = resolve; });
	let remoteTyping = false; const otherRoom = "!other:example.com"; let otherTyping = false;
	const matrix = new ManagedMatrixClient({ homeserver: "https://matrix.example.com", accessToken: "token", botUserId: "@bot:example.com", operatorUserId: "@operator:example.com" },
		async (input, init) => {
			const value = Boolean(JSON.parse(String(init?.body)).typing);
			if (decodeURIComponent(String(input)).includes(otherRoom)) otherTyping = value;
			else { if (!value) { stopped(); await stopGate; } remoteTyping = value; }
			return Response.json({});
		}, [roomId, otherRoom]);
	const registry = { manifestByConversationId: (id: string) => ({ roomId: id === conversationId ? roomId : otherRoom }) } as unknown as RelayRegistry;
	const projector = new ActivityProjector(root, registry, matrix); t.after(() => projector.close());
	await projector.beginOperationFeedback(conversationId, "old");
	await projector.endOperationFeedback(conversationId, "old"); await stopStarted;
	await projector.beginOperationFeedback(conversationId, "new");
	await projector.beginOperationFeedback("other", "independent");
	assert.equal(otherTyping, true);
	releaseStop(); await new Promise((resolve) => setImmediate(resolve));
	assert.equal(remoteTyping, true, "old stop must finish before sending the newest typing intent");
});

test("interrupted cards return a typed continuation signal without rewriting final history", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "managed-typing-continuation-")); t.after(() => rm(root, { recursive: true, force: true }));
	let typing = false;
	const matrix = new ManagedMatrixClient({ homeserver: "https://matrix.example.com", accessToken: "token", botUserId: "@bot:example.com", operatorUserId: "@operator:example.com" },
		async (input, init) => { if (String(input).includes("/typing/")) typing = Boolean(JSON.parse(String(init?.body)).typing); return Response.json({ event_id: "$card" }); }, [roomId]);
	const registry = { manifestByConversationId: () => ({ roomId }) } as unknown as RelayRegistry;
	const projector = new ActivityProjector(root, registry, matrix); t.after(() => projector.close());
	await projector.project(envelope("activity.update", { activityId, revision: 0, state: "tool", tools: [{ name: "read", state: "running", count: 1 }] }));
	await projector.interrupt(conversationId);
	const interrupted = JSON.parse(await readFile(join(root, "activities.json"), "utf8")).activities[0];
	await projector.attachmentConnected(conversationId);
	await assert.rejects(() => projector.project(envelope("activity.update", { activityId, revision: 1, state: "busy" })), { code: "activity_interrupted" });
	const nextId = deriveActivityId(deriveGenerationId(conversationId, 1), `continuation:${activityId}`);
	await projector.project(envelope("activity.update", { activityId: nextId, revision: 0, state: "busy" }));
	assert.equal(typing, true);
	assert.deepEqual(JSON.parse(await readFile(join(root, "activities.json"), "utf8")).activities[0], interrupted);
	await projector.project(envelope("activity.finalize", { activityId: nextId, revision: 1, outcome: "completed" }));
	assert.equal(typing, false);
});

test("reconnect cancels an expired interruption still queued behind projection", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "managed-typing-queued-interrupt-"));
	let unblock!: () => void; let blocked!: () => void;
	const started = new Promise<void>((resolve) => { blocked = resolve; });
	const gate = new Promise<void>((resolve) => { unblock = resolve; });
	const otherRoom = "!other:example.com";
	const matrix = new ManagedMatrixClient({ homeserver: "https://matrix.example.com", accessToken: "token", botUserId: "@bot:example.com", operatorUserId: "@operator:example.com" },
		async (input) => { if (decodeURIComponent(String(input)).includes(otherRoom) && String(input).includes("/send/")) { blocked(); await gate; } return Response.json({ event_id: "$card" }); }, [roomId, otherRoom]);
	const registry = { manifestByConversationId: (id: string) => ({ roomId: id === conversationId ? roomId : otherRoom }) } as unknown as RelayRegistry;
	const projector = new ActivityProjector(root, registry, matrix, { interruptionGraceMs: 5 });
	t.after(async () => { unblock(); await projector.close(); await rm(root, { recursive: true, force: true }); });
	await projector.project(envelope("activity.update", { activityId, revision: 0, state: "busy" }));
	const slow = projector.project({ ...envelope("activity.update", { activityId, revision: 0, state: "busy" }), conversationId: "other" });
	await started; projector.attachmentDisconnected(conversationId);
	await new Promise((resolve) => setTimeout(resolve, 20));
	await projector.attachmentConnected(conversationId); unblock(); await slow;
	await projector.project(envelope("activity.update", { activityId, revision: 1, state: "busy" }));
	assert.equal(projector.hasUnfinalized(conversationId), true);
});

test("typing requests have deadlines, coalesce refreshes, and abort on close without late sends", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "managed-typing-deadline-")); t.after(() => rm(root, { recursive: true, force: true }));
	let calls = 0; let aborted = 0; let active = 0; let maxActive = 0;
	const matrix = new ManagedMatrixClient({ homeserver: "https://matrix.example.com", accessToken: "token", botUserId: "@bot:example.com", operatorUserId: "@operator:example.com" },
		async (_input, init) => {
			calls++; active++; maxActive = Math.max(maxActive, active);
			await new Promise<void>((_resolve, reject) => init!.signal!.addEventListener("abort", () => { aborted++; active--; reject(new Error("aborted")); }, { once: true }));
			return Response.json({});
		}, [roomId]);
	const registry = { manifestByConversationId: () => ({ roomId }) } as unknown as RelayRegistry;
	const projector = new ActivityProjector(root, registry, matrix, { typingRequestMs: 30, typingRefreshMs: 5 }); t.after(() => projector.close());
	await projector.beginOperationFeedback(conversationId, "one");
	for (let i = 0; i < 20; i++) await projector.beginOperationFeedback(conversationId, String(i));
	assert.equal(calls, 1, "pending feedback coalesces rather than launching concurrent requests");
	for (let i = 0; i < 100 && calls < 2; i++) await new Promise((resolve) => setTimeout(resolve, 5));
	assert.ok(aborted >= 1, "request deadline releases the single-flight sender"); assert.ok(calls >= 2);
	await projector.close(); const closedCalls = calls;
	await new Promise((resolve) => setTimeout(resolve, 40));
	assert.equal(calls, closedCalls); assert.equal(active, 0); assert.equal(maxActive, 1);
});

test("activity projector edits one stable card, balances the final snapshot, and preserves final history", async () => {
	const root = await mkdtemp(join(tmpdir(), "managed-activity-"));
	const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
	let events = 0;
	const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(String(input)); const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
		requests.push({ path: url.pathname, body });
		return new Response(JSON.stringify(url.pathname.includes("/send/") ? { event_id: `$event-${events++}` } : {}), { status: 200 });
	};
	const matrix = new ManagedMatrixClient({ homeserver: "https://matrix.example.com", accessToken: "secret-token", botUserId: "@bot:example.com", operatorUserId: "@operator:example.com" }, fetcher as typeof fetch, [roomId]);
	const registry = { manifestByConversationId: (id: string) => id === conversationId ? { conversationId, roomId } : undefined } as unknown as RelayRegistry;
	const projector = new ActivityProjector(root, registry, matrix); await projector.load();
	await projector.project(envelope("activity.update", { activityId, revision: 0, state: "busy" }));
	assert.equal(projector.hasUnfinalized(conversationId), true);
	await projector.project(envelope("activity.update", { activityId, revision: 1, state: "tool", tools: [{ name: "read", state: "running", count: 2 }] }));
	const final = { activityId, revision: 2, outcome: "completed", durationMs: 1200, model: "provider/model", thinking: "low", generation: 1,
		context: { usedTokens: 60, remainingTokens: 40, limitTokens: 100, deltaTokens: 10 }, run: { inputTokens: 20, outputTokens: 5, modelTurns: 2 },
		tools: { total: 2, errors: 0, counts: [{ name: "read", count: 2 }] }, compactions: 1 };
	await projector.project(envelope("activity.finalize", final));
	assert.equal(projector.hasUnfinalized(conversationId), false);
	assert.equal(requests.filter((request) => request.path.includes("/send/m.room.message/")).length, 3);
	assert.equal(requests.filter((request) => (request.body["m.relates_to"] as { rel_type?: string } | undefined)?.rel_type === "m.replace").length, 2);
	const finalRequest = [...requests].reverse().find((request) => request.path.includes("/send/m.room.message/"));
	const finalBody = String((finalRequest?.body["m.new_content"] as { body?: string }).body);
	assert.match(finalBody, /Context: 60\/100 used · 40 remaining · Δ \+10/);
	assert.match(finalBody, /Tools: 2 total · 0 errors · read 2/);
	assert.doesNotMatch(JSON.stringify(requests), /secret-token|arguments|command|output/);
	await assert.rejects(() => projector.project(envelope("activity.update", { activityId, revision: 3, state: "busy" })), /immutable/);
	const durable = JSON.parse(await readFile(join(root, "activities.json"), "utf8"));
	assert.equal(durable.activities[0].finalized, true); assert.equal(durable.activities[0].revision, 2);
	await projector.close(); await rm(root, { recursive: true, force: true });
});

test("command feedback leases keep typing active across compaction and concurrent model activity", async () => {
	const root = await mkdtemp(join(tmpdir(), "managed-operation-feedback-")); const typing: boolean[] = [];
	const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
		const path = String(input); if (path.includes("/typing/")) typing.push(Boolean(JSON.parse(String(init?.body)).typing));
		return new Response(JSON.stringify(path.includes("/send/") ? { event_id: "$activity" } : {}), { status: 200 });
	};
	const matrix = new ManagedMatrixClient({ homeserver: "https://matrix.example.com", accessToken: "token", botUserId: "@bot:example.com", operatorUserId: "@operator:example.com" }, fetcher as typeof fetch, [roomId]);
	const registry = { manifestByConversationId: () => ({ conversationId, roomId }) } as unknown as RelayRegistry;
	const projector = new ActivityProjector(root, registry, matrix); await projector.load();
	await projector.beginOperationFeedback(conversationId, `control_${"a".repeat(32)}`);
	assert.equal(typing.at(-1), true, "remote compaction/control feedback starts typing without a model span");
	await projector.project(envelope("activity.update", { activityId, revision: 0, state: "busy" }));
	await projector.endOperationFeedback(conversationId, `control_${"a".repeat(32)}`);
	assert.equal(typing.at(-1), true, "one operation completing cannot cancel concurrent model activity");
	await projector.beginOperationFeedback(conversationId, `delivery_${"b".repeat(32)}`);
	await projector.project(envelope("activity.finalize", { activityId, revision: 1, outcome: "completed" }));
	assert.equal(typing.at(-1), true, "a model span completing cannot cancel concurrent slash-command feedback");
	await projector.endOperationFeedback(conversationId, `delivery_${"b".repeat(32)}`);
	assert.equal(typing.at(-1), false);
	await projector.close(); await rm(root, { recursive: true, force: true });
});

test("typing endpoint failures never gate durable operation feedback", async () => {
	const root = await mkdtemp(join(tmpdir(), "managed-feedback-outage-")); let calls = 0;
	const matrix = new ManagedMatrixClient({ homeserver: "https://matrix.example.com", accessToken: "token", botUserId: "@bot:example.com", operatorUserId: "@operator:example.com" },
		async () => { calls += 1; return new Response("outage", { status: 503 }); }, [roomId], { maxAttempts: 1 });
	const registry = { manifestByConversationId: () => ({ conversationId, roomId }) } as unknown as RelayRegistry;
	const projector = new ActivityProjector(root, registry, matrix); await projector.load();
	await projector.beginOperationFeedback(conversationId, `control_${"c".repeat(32)}`);
	await projector.endOperationFeedback(conversationId, `control_${"c".repeat(32)}`);
	assert.equal(calls, 2, "best-effort typing attempts do not reject durable control delivery or completion");
	await projector.close(); await rm(root, { recursive: true, force: true });
});

test("activity creation retries the same stable Matrix transaction after an uncertain send", async () => {
	const root = await mkdtemp(join(tmpdir(), "managed-activity-uncertain-"));
	const sendPaths: string[] = []; let fail = true;
	const fetcher = async (input: string | URL | Request) => {
		const path = new URL(String(input)).pathname;
		if (path.includes("/send/")) { sendPaths.push(path); if (fail) { fail = false; return new Response("{}", { status: 500 }); } return new Response(JSON.stringify({ event_id: "$stable" }), { status: 200 }); }
		return new Response("{}", { status: 200 });
	};
	const matrix = new ManagedMatrixClient({ homeserver: "https://matrix.example.com", accessToken: "token", botUserId: "@bot:example.com", operatorUserId: "@operator:example.com" }, fetcher as typeof fetch, [roomId], { maxAttempts: 1 });
	const registry = { manifestByConversationId: () => ({ conversationId, roomId }) } as unknown as RelayRegistry;
	const projector = new ActivityProjector(root, registry, matrix); await projector.load();
	const update = envelope("activity.update", { activityId, revision: 0, state: "busy" });
	await assert.rejects(() => projector.project(update)); await projector.project(update);
	assert.equal(sendPaths.length, 2); assert.equal(sendPaths[0], sendPaths[1]);
	await projector.close(); await rm(root, { recursive: true, force: true });
});

test("unfinished durable activity is finalized as interrupted after attachment loss", async () => {
	const root = await mkdtemp(join(tmpdir(), "managed-activity-recovery-"));
	const typing: boolean[] = [];
	const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
		const path = String(input);
		if (path.includes("/typing/")) typing.push(Boolean(JSON.parse(String(init?.body)).typing));
		return new Response(JSON.stringify(path.includes("/send/") ? { event_id: "$stable" } : {}), { status: 200 });
	};
	const matrix = new ManagedMatrixClient({ homeserver: "https://matrix.example.com", accessToken: "token", botUserId: "@bot:example.com", operatorUserId: "@operator:example.com" }, fetcher as typeof fetch, [roomId]);
	const registry = { manifestByConversationId: () => ({ conversationId, roomId }) } as unknown as RelayRegistry;
	const first = new ActivityProjector(root, registry, matrix); await first.load(); await first.project(envelope("activity.update", { activityId, revision: 0, state: "busy" })); await first.close();
	const recovered = new ActivityProjector(root, registry, matrix, { interruptionGraceMs: 10, typingRefreshMs: 5 });
	await recovered.load();
	await recovered.attachmentConnected(conversationId);
	await new Promise((resolve) => setTimeout(resolve, 25));
	let durable = JSON.parse(await readFile(join(root, "activities.json"), "utf8"));
	assert.equal(durable.activities[0].finalized, false, "an adapter reconnect cancels restart interruption");
	assert.ok(typing.includes(true), "typing resumes with the surviving busy span");
	recovered.attachmentDisconnected(conversationId);
	await new Promise((resolve) => setTimeout(resolve, 30));
	durable = JSON.parse(await readFile(join(root, "activities.json"), "utf8"));
	assert.equal(durable.activities[0].finalized, true); assert.equal(durable.activities[0].payload.outcome, "interrupted");
	assert.equal(typing.at(-1), false);
	await recovered.close(); await rm(root, { recursive: true, force: true });
});

test("all terminal outcomes render as distinct immutable unpinned snapshots", async () => {
	const root = await mkdtemp(join(tmpdir(), "managed-activity-outcomes-"));
	const bodies: Array<Record<string, unknown>> = [];
	const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
		const path = String(input); const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
		if (path.includes("/send/")) bodies.push(body);
		return new Response(JSON.stringify(path.includes("/send/") ? { event_id: `$${bodies.length}` } : {}), { status: 200 });
	};
	const matrix = new ManagedMatrixClient({ homeserver: "https://matrix.example.com", accessToken: "token", botUserId: "@bot:example.com", operatorUserId: "@operator:example.com" }, fetcher as typeof fetch, [roomId]);
	const registry = { manifestByConversationId: () => ({ conversationId, roomId }) } as unknown as RelayRegistry;
	const projector = new ActivityProjector(root, registry, matrix); await projector.load();
	const expected = { completed: "Completed", checkpoint: "Waiting at checkpoint", cancelled: "Cancelled", interrupted: "Interrupted", failed: "Failed" } as const;
	for (const [index, outcome] of Object.keys(expected).entries()) {
		const id = deriveActivityId(deriveGenerationId(conversationId, 1), `outcome-${outcome}`);
		await projector.project(envelope("activity.update", { activityId: id, revision: 0, state: "busy" }));
		await projector.project(envelope("activity.finalize", { activityId: id, revision: 1, outcome }));
		const final = String((bodies.at(-1)?.["m.new_content"] as { body?: string })?.body);
		assert.match(final, new RegExp(expected[outcome as keyof typeof expected]));
		assert.equal("m.relates_to" in (bodies.at(-1) ?? {}), true);
		assert.equal(Object.keys(bodies.at(-1) ?? {}).some((key) => /pin/i.test(key)), false);
		assert.equal(index + 1, bodies.filter((body) => (body["m.relates_to"] as { rel_type?: string } | undefined)?.rel_type === "m.replace").length);
	}
	await projector.close(); await rm(root, { recursive: true, force: true });
});
