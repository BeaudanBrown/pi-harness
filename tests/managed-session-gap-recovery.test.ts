import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MANAGED_SESSION_PROTOCOL_VERSION, MANAGED_SESSION_STATE_VERSION, deriveConversationId, type ConversationManifest, type ManagedSessionEnvelope } from "../config/agent/extensions/managed-sessions/contracts.js";
import { ManagedMatrixClient } from "../config/agent/extensions/managed-sessions/relay/matrix-client.js";
import { CoordinatorRouter } from "../config/agent/extensions/managed-sessions/relay/coordinator-router.js";
import { RelayRegistry } from "../config/agent/extensions/managed-sessions/relay/registry.js";
import { ConversationManifestStore } from "../config/agent/extensions/managed-sessions/relay/manifest-store.js";
import type { ManagedSessionIpcServer } from "../config/agent/extensions/managed-sessions/relay/ipc-server.js";

const config = { homeserver: "https://matrix.example.com", accessToken: "synthetic-secret", botUserId: "@bot:example.com", operatorUserId: "@operator:example.com" };
const room = "!room:example.com";
const event = (id: string) => ({ event_id: id, room_id: room, origin_server_ts: Date.now(), sender: config.operatorUserId,
	type: "m.room.message", content: { msgtype: "m.text", body: id } });
const response = (events = [event("$tail")]) => ({ rooms: { join: { [room]: { timeline: { limited: true, prev_batch: "tail-start", events } } } } });

test("limited sync recovers the fixed interval in forward order, retaining the original response", async () => {
	const requests: URL[] = [];
	const matrix = new ManagedMatrixClient(config, async (input) => {
		const url = new URL(String(input)); requests.push(url);
		assert.equal(url.pathname, `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/messages`);
		assert.equal(url.searchParams.get("dir"), "f"); assert.equal(url.searchParams.get("limit"), "100");
		assert.equal(url.searchParams.get("to"), "new-sync");
		return Response.json({ start: url.searchParams.get("from"), ...(url.searchParams.get("from") === "old-sync" ? { chunk: [event("$first")], end: "page-2" }
			: { chunk: [event("$tail")], end: "new-sync" }) });
	}, [room]);
	const original = response();
	const recovered = await matrix.recoverSyncTimelines(original, "old-sync", "new-sync", [room]) as ReturnType<typeof response>;
	assert.deepEqual(recovered.rooms.join[room].timeline.events.map((item) => item.event_id), ["$first", "$tail"]);
	assert.equal(recovered.rooms.join[room].timeline.limited, false);
	assert.equal(original.rooms.join[room].timeline.limited, true);
	assert.equal(requests.length, 2);
});

test("ordinary complete sync does not request history", async () => {
	const matrix = new ManagedMatrixClient(config, async () => { throw new Error("unexpected request"); }, [room]);
	const sync = response(); sync.rooms.join[room].timeline.limited = false;
	assert.deepEqual(await matrix.recoverSyncTimelines(sync, "old", "new", [room]), sync);
});

for (const fault of ["malformed", "foreign", "duplicate", "stalled", "cycle", "missing-tail", "missing-end", "wrong-start", "event-bound", "page-bound", "byte-bound", "forbidden"] as const) {
	test(`gap recovery rejects ${fault} without returning a partial interval`, async () => {
		let page = 0;
		const matrix = new ManagedMatrixClient(config, async (input) => {
			page += 1;
			const start = new URL(String(input)).searchParams.get("from");
			const json = (value: Record<string, unknown>) => Response.json({ start, end: "new", ...value });
			if (fault === "forbidden") return new Response("private response body", { status: 403 });
			if (fault === "malformed") return json({ chunk: null });
			if (fault === "foreign") return json({ chunk: [{ ...event("$tail"), room_id: "!foreign:example.com" }] });
			if (fault === "duplicate") return json({ chunk: [event("$tail"), event("$tail")] });
			if (fault === "stalled") return json({ chunk: [], end: "old" });
			if (fault === "cycle") return json({ chunk: [], end: page === 1 ? "p2" : "old" });
			if (fault === "missing-tail") return json({ chunk: [event("$first")] });
			if (fault === "missing-end") return json({ chunk: [event("$tail")], end: undefined });
			if (fault === "wrong-start") return json({ start: "wrong", chunk: [event("$tail")] });
			if (fault === "byte-bound") return json({ chunk: [{ ...event(`$${page}`), content: { body: "x".repeat(2_200_000) } }], end: `p${page}` });
			return json({ chunk: fault === "event-bound" ? Array.from({ length: 100 }, (_, i) => event(`$${page}-${i}`)) : [], end: `p${page}` });
		}, [room], { maxAttempts: 1 });
		await assert.rejects(() => matrix.recoverSyncTimelines(response(), "old", "new", [room]), (error: Error) => {
			assert.doesNotMatch(error.message, /private response body|synthetic-secret/); return true;
		});
		assert.ok(page <= 10);
	});
}

test("unrecoverable gaps block dispatch; interrupted dispatch resumes with stable input identities", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "managed-gap-router-")); t.after(() => rm(root, { recursive: true, force: true }));
	const host = "gap-host"; const store = new ConversationManifestStore(join(root, "manifests"));
	const registry = new RelayRegistry(host, join(root, "state"), store); await registry.load();
	const manifest: ConversationManifest = { schemaVersion: MANAGED_SESSION_STATE_VERSION, conversationId: deriveConversationId(host, "coordinator"),
		kind: "coordinator", creationKey: "coordinator", ownerHostId: host, concept: "gap test", piSessionId: "gap-session", roomId: room,
		bindingBoundaryEntryId: `entry_${"1".repeat(32)}`, createdAt: new Date().toISOString() };
	await registry.createCoordinatorConversation(manifest); await registry.setMatrixCursor(manifest.conversationId, "old-sync");
	const nonce = "abcdefghijklmnopqrstuvwxyzABCDEF";
	const attach = async (registry: RelayRegistry) => {
		await registry.setAttachmentNonce(manifest.conversationId, nonce);
		await registry.attach({ protocolVersion: MANAGED_SESSION_PROTOCOL_VERSION, messageId: "attach", conversationId: manifest.conversationId,
			role: "coordinator_adapter", type: "attachment.attach", payload: { sessionId: manifest.piSessionId, attachmentNonce: nonce,
				bindingBoundaryEntryId: manifest.bindingBoundaryEntryId } }, "connection");
	};
	await attach(registry);
	let failHistory: "http" | "missing-end" | false = "http"; let interruptDispatch = false; let reachedBoundary = false; let diagnosed = false;
	const accepted: string[] = [];
	const matrix = new ManagedMatrixClient(config, async (input, init) => {
		const url = new URL(String(input));
		if (url.pathname.endsWith("/joined_members")) return Response.json({ joined: { [config.operatorUserId]: {} } });
		if (url.pathname.endsWith("/messages")) {
			if (failHistory === "http") return new Response("forbidden", { status: 403 });
			if (failHistory === "missing-end") return Response.json({ start: url.searchParams.get("from"), chunk: [event("$tail")] });
			return Response.json({ start: url.searchParams.get("from"), chunk: [event("$first"), event("$tail")], end: "new-sync" });
		}
		if (url.searchParams.get("since") === "new-sync") {
			reachedBoundary = true;
			await new Promise<void>((resolve) => init?.signal?.addEventListener("abort", () => resolve(), { once: true }));
			throw Object.assign(new Error("cancelled"), { name: "AbortError" });
		}
		assert.equal(url.searchParams.get("since"), "old-sync");
		return Response.json({ ...response(), next_batch: "new-sync" });
	}, [room], { maxAttempts: 1 });
	const server = { sendToConversation: (envelope: ManagedSessionEnvelope) => {
		if (interruptDispatch && envelope.payload.body === "$tail") throw new Error("synthetic interruption after durable acceptance");
		accepted.push(String(envelope.payload.body)); return true;
	} } as unknown as ManagedSessionIpcServer;
	const run = async (registry: RelayRegistry) => {
		diagnosed = false;
		const router = new CoordinatorRouter(manifest, registry, matrix, server, async () => undefined, async () => undefined,
			async () => undefined, () => { diagnosed = true; });
		router.start();
		try { for (let i = 0; i < 100 && !diagnosed && !reachedBoundary; i += 1) await new Promise((resolve) => setTimeout(resolve, 10)); }
		finally { await router.stop(); }
	};
	await run(registry);
	assert.equal(diagnosed, true); assert.deepEqual(accepted, []);
	assert.deepEqual(registry.snapshot().conversations[0]?.matrixCursor, { status: "established", since: "old-sync" });
	failHistory = "missing-end";
	await run(registry);
	assert.equal(diagnosed, true); assert.deepEqual(accepted, [], "a visible sync tail without a terminal boundary must not skip intervening history");
	assert.deepEqual(registry.snapshot().conversations[0]?.matrixCursor, { status: "established", since: "old-sync" });
	failHistory = false; interruptDispatch = true;
	await run(registry);
	assert.equal(diagnosed, true);
	assert.deepEqual(registry.pendingInputs(manifest.conversationId).map((item) => item.matrixEventId), ["$first", "$tail"]);
	assert.deepEqual(registry.snapshot().conversations[0]?.matrixCursor, { status: "established", since: "old-sync" });
	// The real adapter's delivery identity dedup handles replayed envelopes; the
	// durable registry must not create a second accepted turn on cursor replay.
	const restarted = new RelayRegistry(host, join(root, "state"), store); await restarted.load();
	restarted.beginRestartReconciliation(); await attach(restarted); await restarted.finishRestartReconciliation();
	interruptDispatch = false;
	await run(restarted);
	assert.equal(diagnosed, false); assert.equal(reachedBoundary, true);
	assert.deepEqual(restarted.pendingInputs(manifest.conversationId).map((item) => item.matrixEventId), ["$first", "$tail"]);
	assert.deepEqual(restarted.snapshot().conversations[0]?.matrixCursor, { status: "established", since: "new-sync" });
});
