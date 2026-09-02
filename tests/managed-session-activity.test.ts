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
	const fetcher = async (input: string | URL | Request) => new Response(JSON.stringify(String(input).includes("/send/") ? { event_id: "$stable" } : {}), { status: 200 });
	const matrix = new ManagedMatrixClient({ homeserver: "https://matrix.example.com", accessToken: "token", botUserId: "@bot:example.com", operatorUserId: "@operator:example.com" }, fetcher as typeof fetch, [roomId]);
	const registry = { manifestByConversationId: () => ({ conversationId, roomId }) } as unknown as RelayRegistry;
	const first = new ActivityProjector(root, registry, matrix); await first.load(); await first.project(envelope("activity.update", { activityId, revision: 0, state: "busy" })); await first.close();
	const recovered = new ActivityProjector(root, registry, matrix); await recovered.load(); await recovered.interrupt(conversationId); await recovered.close();
	const durable = JSON.parse(await readFile(join(root, "activities.json"), "utf8"));
	assert.equal(durable.activities[0].finalized, true); assert.equal(durable.activities[0].payload.outcome, "interrupted");
	await rm(root, { recursive: true, force: true });
});
