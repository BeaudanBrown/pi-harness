import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
	MANAGED_SESSION_PROTOCOL_VERSION, MANAGED_SESSION_STATE_VERSION, deriveConversationId, deriveDeliveryId, deriveTranscriptEntryId,
	encodeNdjsonEnvelope, parseNdjsonEnvelope, type ConversationManifest, type ManagedSessionEnvelope,
} from "../config/agent/extensions/managed-sessions/contracts.js";
import { renderRemoteCheckpoint } from "../config/agent/extensions/managed-sessions/checkpoint.js";
import { RelayEventProjector } from "../config/agent/extensions/managed-sessions/relay/event-projector.js";
import { CoordinatorRouter, authorizedRoomEvents, operatorTextEvents, parseTypedRemoteControl } from "../config/agent/extensions/managed-sessions/relay/coordinator-router.js";
import { ManagedSessionIpcServer } from "../config/agent/extensions/managed-sessions/relay/ipc-server.js";
import { ConversationManifestStore } from "../config/agent/extensions/managed-sessions/relay/manifest-store.js";
import { ManagedMatrixClient } from "../config/agent/extensions/managed-sessions/relay/matrix-client.js";
import { RelayRegistry } from "../config/agent/extensions/managed-sessions/relay/registry.js";

const config = { homeserver: "https://matrix.example.com", accessToken: "secret", botUserId: "@bot:example.com", operatorUserId: "@operator:example.com" };

async function fixture(establishCursor = true) {
	const root = await mkdtemp(join(tmpdir(), "managed-controls-"));
	const registry = new RelayRegistry("controls-host", join(root, "runtime"), new ConversationManifestStore(join(root, "manifests")));
	await registry.load();
	const conversationId = deriveConversationId("controls-host", "coordinator");
	const manifest: ConversationManifest = { schemaVersion: MANAGED_SESSION_STATE_VERSION, kind: "coordinator", conversationId,
		ownerHostId: "controls-host", creationKey: "coordinator", concept: "controls", piSessionId: "session-controls",
		roomId: "!room:example.com", bindingBoundaryEntryId: `entry_${"1".repeat(32)}`, createdAt: new Date().toISOString() };
	await registry.createCoordinatorConversation(manifest);
	if (establishCursor) await registry.setMatrixCursor(conversationId, "controls-fixture-cursor");
	await registry.setAttachmentNonce(conversationId, "abcdefghijklmnopqrstuvwxyzABCDEF");
	return { root, registry, manifest };
}

function sync(events: unknown[]) { return { next_batch: "next", rooms: { join: { "!room:example.com": { timeline: { events } } } } }; }
function event(id: string, body: string, relation?: unknown) { return { event_id: id, origin_server_ts: Date.now(), sender: config.operatorUserId, type: "m.room.message",
	content: { msgtype: "m.text", body, ...(relation === undefined ? {} : { "m.relates_to": relation }) } }; }

async function attach(server: ManagedSessionIpcServer, manifest: ConversationManifest): Promise<Socket> {
	const socket = connect(server.socketPath);
	await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
	socket.write(encodeNdjsonEnvelope({ protocolVersion: MANAGED_SESSION_PROTOCOL_VERSION, messageId: "attach-controls",
		conversationId: manifest.conversationId, role: "coordinator_adapter", type: "attachment.attach", payload: {
			sessionId: manifest.piSessionId, attachmentNonce: "abcdefghijklmnopqrstuvwxyzABCDEF", bindingBoundaryEntryId: manifest.bindingBoundaryEntryId,
		} }));
	await readMany(socket, 1);
	return socket;
}

async function readMany(socket: Socket, count: number): Promise<ManagedSessionEnvelope[]> {
	return new Promise((resolve, reject) => {
		let buffer = Buffer.alloc(0); const result: ManagedSessionEnvelope[] = [];
		const timer = setTimeout(() => reject(new Error(`timed out after ${result.length} envelopes`)), 3_000);
		socket.on("data", function onData(chunk) {
			buffer = Buffer.concat([buffer, chunk]);
			while (buffer.includes(0x0a)) { const newline = buffer.indexOf(0x0a); result.push(parseNdjsonEnvelope(buffer.subarray(0, newline + 1))); buffer = buffer.subarray(newline + 1); }
			if (result.length >= count) { clearTimeout(timer); socket.off("data", onData); resolve(result); }
		});
		socket.once("error", reject);
	});
}

test("relay persists controls before delivery and replays stable identities after an attachment crash and restart", async (t) => {
	const { root, registry, manifest } = await fixture();
	const control = { controlId: `control_${"a".repeat(32)}`, matrixEventId: "$durable-control", name: "model" as const, argument: "scoped/model" };
	await registry.recordPendingControl(manifest.conversationId, control);
	await registry.recordPendingControl(manifest.conversationId, control);
	assert.equal(registry.pendingControls(manifest.conversationId).length, 1, "Matrix cursor replay is idempotent");

	const matrix = new ManagedMatrixClient(config, async () => Response.json({ event_id: "$ok" }), [manifest.roomId]);
	const server = new ManagedSessionIpcServer(registry, { runtimeDirectory: join(root, "ipc-first") });
	await server.start();
	const router = new CoordinatorRouter(manifest, registry, matrix, server, async () => undefined);
	const first = await attach(server, manifest);
	const firstReplay = readMany(first, 1);
	await router.attachmentReady(manifest.conversationId);
	const [firstDelivery] = await firstReplay;
	assert.deepEqual(firstDelivery.payload, { controlId: control.controlId, name: "model", argument: "scoped/model" });
	first.destroy();
	await server.close({ preserveAttachments: true });

	const restartedRegistry = new RelayRegistry("controls-host", join(root, "runtime"), new ConversationManifestStore(join(root, "manifests")));
	await restartedRegistry.load();
	restartedRegistry.beginRestartReconciliation();
	const restartedServer = new ManagedSessionIpcServer(restartedRegistry, { runtimeDirectory: join(root, "ipc-restarted") });
	await restartedServer.start(); t.after(() => restartedServer.close());
	const restartedRouter = new CoordinatorRouter(manifest, restartedRegistry, matrix, restartedServer, async () => undefined);
	const second = await attach(restartedServer, manifest); t.after(() => second.destroy());
	const restartReplay = readMany(second, 1);
	await restartedRouter.attachmentReady(manifest.conversationId);
	const [replayed] = await restartReplay;
	assert.equal(replayed.payload.controlId, control.controlId, "restart replay preserves the stable control identity");
	assert.equal(restartedRegistry.controlResultState(manifest.conversationId, control.controlId), "pending");
	await restartedRegistry.acknowledgeControlResult(manifest.conversationId, control.controlId);
	await restartedRegistry.acknowledgeControlResult(manifest.conversationId, control.controlId);
	assert.equal(restartedRegistry.pendingControls(manifest.conversationId).length, 0, "only explicit result acknowledgement clears the pending queue");
	assert.equal(restartedRegistry.controlResultState(manifest.conversationId, control.controlId), "completed", "lost acknowledgements remain idempotent");
});

test("typed control parsing is strict, bounded, and isolates malformed commands from prompts", () => {
	assert.deepEqual(parseTypedRemoteControl(" !model scoped/model "), { name: "model", argument: "scoped/model" });
	assert.deepEqual(parseTypedRemoteControl("!compact focus on API state"), { name: "compact", argument: "focus on API state" });
	assert.deepEqual(parseTypedRemoteControl("!unknown secret prompt"), { name: "help" });
	assert.deepEqual(parseTypedRemoteControl("!status extra"), { name: "help" });
	assert.deepEqual(parseTypedRemoteControl(`!model ${"x".repeat(4_097)}`), { name: "help" });
	assert.equal(parseTypedRemoteControl("ordinary task"), undefined);
	assert.equal(parseTypedRemoteControl("!abort"), undefined);
	assert.equal(parseTypedRemoteControl("!steer redirect"), undefined);
});

test("fresh relay bootstraps a cursor without replaying retained room commands", async () => {
	const { registry, manifest } = await fixture(false); let syncCount = 0; let launches = 0;
	const matrix = new ManagedMatrixClient(config, async (input, init) => {
		if (!new URL(String(input)).pathname.endsWith("/sync")) return Response.json({ event_id: "$ok" });
		syncCount += 1;
		if (syncCount === 1) return Response.json({ next_batch: "safe-start", rooms: { join: { [manifest.roomId]: { timeline: { events: [event("$retained", "must not replay")] } } } } });
		await new Promise<void>((resolve) => init?.signal?.addEventListener("abort", () => resolve(), { once: true }));
		throw Object.assign(new Error("cancelled"), { name: "AbortError" });
	}, [manifest.roomId]);
	const router = new CoordinatorRouter(manifest, registry, matrix, { sendToConversation: () => false } as unknown as ManagedSessionIpcServer, async () => { launches += 1; });
	router.start(); for (let attempt = 0; attempt < 100 && registry.snapshot().conversations[0]?.matrixCursor.status !== "established"; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
	await router.stop();
	assert.deepEqual(registry.snapshot().conversations[0]?.matrixCursor, { status: "established", since: "safe-start" });
	assert.equal(registry.pendingInputs(manifest.conversationId).length, 0); assert.equal(launches, 0);
});

test("limited offline timeline does not advance the durable cursor", async () => {
	const { registry, manifest } = await fixture(); let diagnosed = false;
	const matrix = new ManagedMatrixClient(config, async (input) => {
		if (!new URL(String(input)).pathname.endsWith("/sync")) return Response.json({ membership: "join" });
		return Response.json({ next_batch: "must-not-advance", rooms: { join: { [manifest.roomId]: { timeline: {
			limited: true, prev_batch: "gap", events: [event("$offline", "retained")],
		} } } } });
	}, [manifest.roomId], { maxAttempts: 1 });
	const router = new CoordinatorRouter(manifest, registry, matrix, { sendToConversation: () => false } as unknown as ManagedSessionIpcServer,
		async () => undefined, async () => undefined, async () => undefined, () => { diagnosed = true; });
	router.start(); for (let attempt = 0; attempt < 100 && !diagnosed; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
	await router.stop();
	assert.equal(diagnosed, true); assert.deepEqual(registry.snapshot().conversations[0]?.matrixCursor,
		{ status: "established", since: "controls-fixture-cursor" });
	assert.equal(registry.pendingInputs(manifest.conversationId).length, 0);
});

test("bootstrap limited timeline also does not establish a cursor", async () => {
	const { registry, manifest } = await fixture(false); let diagnosed = false;
	const matrix = new ManagedMatrixClient(config, async () => Response.json({ next_batch: "unsafe-bootstrap", rooms: { join: {
		[manifest.roomId]: { timeline: { limited: true, prev_batch: "gap", events: [event("$old", "do not run")] } },
	} } }), [manifest.roomId], { maxAttempts: 1 });
	const router = new CoordinatorRouter(manifest, registry, matrix, { sendToConversation: () => false } as unknown as ManagedSessionIpcServer,
		async () => undefined, async () => undefined, async () => undefined, () => { diagnosed = true; });
	router.start(); for (let attempt = 0; attempt < 100 && !diagnosed; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
	await router.stop(); assert.equal(diagnosed, true);
	assert.deepEqual(registry.snapshot().conversations[0]?.matrixCursor, { status: "bootstrap" });
});

test("room membership, event age, and payload shape fail closed before routing", () => {
	const now = Date.now(); const message = event("$member", "hello");
	const response = (membership: string) => ({ rooms: { join: { "!room:example.com": {
		state: { events: [{ type: "m.room.member", state_key: config.operatorUserId, content: { membership } }] }, timeline: { events: [message] },
	} } } });
	assert.equal(operatorTextEvents(response("leave"), "!room:example.com", config.operatorUserId, false, now).length, 0);
	assert.equal(operatorTextEvents(response("join"), "!room:example.com", config.operatorUserId, false, now).length, 1);
	const stale = response("join"); stale.rooms.join["!room:example.com"].timeline.events[0] = { ...message, origin_server_ts: now - 2 * 24 * 60 * 60 * 1_000 };
	assert.equal(operatorTextEvents(stale, "!room:example.com", config.operatorUserId, false, now).length, 0);
	assert.throws(() => operatorTextEvents({ rooms: { join: { "!room:example.com": { timeline: { events: Array(513).fill(message) } } } } },
		"!room:example.com", config.operatorUserId, false, now), /gap recovery/);
	assert.throws(() => operatorTextEvents({ rooms: { join: { "!room:example.com": { timeline: { limited: true, prev_batch: "gap", events: [message] } } } } },
		"!room:example.com", config.operatorUserId, true, now), /gap recovery/);
});

test("authorized poll responses accept exact stable and unstable forms and reject adversarial hybrids", () => {
	const now = Date.now();
	const relation = { rel_type: "m.reference", event_id: "$poll" };
	const poll = (id: string, type: "m.poll.response" | "org.matrix.msc3381.poll.response", content: Record<string, unknown>, sender = config.operatorUserId) => ({
		event_id: id, origin_server_ts: now, sender, type, content: { ...content, "m.relates_to": relation },
	});
	const stable = (id: string, selections: unknown = ["yes"], sender?: string) => poll(id, "m.poll.response", { "m.selections": selections }, sender);
	const unstable = (id: string, answers: unknown = ["yes"]) => poll(id, "org.matrix.msc3381.poll.response", { "org.matrix.msc3381.poll.response": { answers } });
	const response = { rooms: { join: { "!room:example.com": { timeline: { events: [
		stable("$stable"), unstable("$unstable"), stable("$stable"),
		stable("$foreign", ["yes"], "@other:example.com"),
		{ ...stable("$thread"), content: { "m.selections": ["yes"], "m.relates_to": { rel_type: "m.thread", event_id: "$poll" } } },
		{ ...stable("$relation-extra"), content: { "m.selections": ["yes"], "m.relates_to": { ...relation, extra: true } } },
		poll("$old-stable-shape", "m.poll.response", { "m.poll.response": { answers: ["yes"] } }),
		poll("$stable-hybrid", "m.poll.response", { "m.selections": ["yes"], "org.matrix.msc3381.poll.response": { answers: ["yes"] } }),
		poll("$unstable-hybrid", "org.matrix.msc3381.poll.response", { "org.matrix.msc3381.poll.response": { answers: ["yes"] }, "m.selections": ["yes"] }),
		unstable("$multiple", ["yes", "no"]), stable("$empty", []),
		{ ...unstable("$response-extra"), content: { "org.matrix.msc3381.poll.response": { answers: ["yes"], extra: true }, "m.relates_to": relation } },
		poll("$content-extra", "m.poll.response", { "m.selections": ["yes"], extra: true }),
		{ event_id: "$reaction", origin_server_ts: now, sender: config.operatorUserId, type: "m.reaction", content: { "m.relates_to": relation } },
	] } } } } };
	assert.deepEqual(authorizedRoomEvents(response, "!room:example.com", config.operatorUserId, true, now), [
		{ kind: "poll_response", eventId: "$stable", pollEventId: "$poll", answerId: "yes" },
		{ kind: "poll_response", eventId: "$unstable", pollEventId: "$poll", answerId: "yes" },
	]);
});

test("dormant and starting controls are deterministic and never launch an aborted wake", async (t) => {
	const { root, registry, manifest } = await fixture();
	let launchCount = 0; const sent: Array<{ transaction: string; body: string }> = [];
	const responses = [sync([event("$steer", "!steer change"), event("$abort", "!abort")]),
		sync([event("$prompt", "wake task"), event("$queued-abort", "!abort")])];
	const matrix = new ManagedMatrixClient(config, async (input, init) => {
		const path = new URL(String(input)).pathname;
		if (path.endsWith("/sync")) return Response.json(responses.shift() ?? sync([]));
		if (path.includes("/state/m.room.member/")) return Response.json({ membership: "join" });
		if (path.includes("/send/m.room.message/")) { sent.push({ transaction: path.split("/").at(-1)!, body: JSON.parse(String(init?.body)).body }); return Response.json({ event_id: "$notice" }); }
		return Response.json({ sender: config.botUserId });
	}, [manifest.roomId]);
	const server = new ManagedSessionIpcServer(registry, { runtimeDirectory: join(root, "ipc") });
	await server.start(); t.after(() => server.close());
	const projector = new RelayEventProjector(registry, matrix);
	const router = new CoordinatorRouter(manifest, registry, matrix, server, async () => { launchCount += 1; }, async () => undefined,
		(source, target, body) => projector.projectNotice(target.conversationId, source, body));
	router.start();
	for (let attempt = 0; attempt < 100 && sent.length < 3; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20));
	await router.stop();
	assert.equal(launchCount, 0);
	assert.equal(registry.conversationState(manifest.conversationId), "dormant");
	assert.equal(registry.pendingInputs(manifest.conversationId).every((input) => input.status === "cancelled"), true);
	assert.deepEqual(sent.map((item) => item.body), [
		"No active run to steer; managed conversation remains dormant.",
		"No active run to abort; managed conversation remains dormant.",
		"No active run to abort; managed conversation remains dormant.",
	]);
	assert.equal(new Set(sent.map((item) => item.transaction)).size, 3);
});

test("abort arriving during an in-progress wake cancels queued work and is never recovered", async (t) => {
	const { root, registry, manifest } = await fixture();
	let releaseLaunch!: () => void; const launchGate = new Promise<void>((resolve) => { releaseLaunch = resolve; });
	t.after(() => releaseLaunch());
	let launches = 0; const notices: string[] = []; const responses = [sync([event("$wake", "wake task")]), sync([event("$wake-abort", "!abort")])];
	const matrix = new ManagedMatrixClient(config, async (input, init) => {
		const path = new URL(String(input)).pathname;
		if (path.endsWith("/sync")) return Response.json(responses.shift() ?? sync([]));
		if (path.includes("/state/m.room.member/")) return Response.json({ membership: "join" });
		if (path.includes("/send/m.room.message/")) { notices.push(JSON.parse(String(init?.body)).body); return Response.json({ event_id: "$notice" }); }
		return Response.json({ event_id: "$ok" });
	}, [manifest.roomId]);
	const server = new ManagedSessionIpcServer(registry, { runtimeDirectory: join(root, "ipc") }); await server.start(); t.after(() => server.close());
	const projector = new RelayEventProjector(registry, matrix);
	const router = new CoordinatorRouter(manifest, registry, matrix, server, async () => { launches += 1; await launchGate; throw new Error("wake failed after abort"); },
		async () => undefined, (source, target, body) => projector.projectNotice(target.conversationId, source, body));
	router.start();
	for (let attempt = 0; attempt < 100 && registry.pendingInputs(manifest.conversationId)[0]?.status !== "cancelled"; attempt += 1) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.equal(launches, 1); assert.equal(registry.pendingInputs(manifest.conversationId)[0]?.status, "cancelled");
	releaseLaunch();
	for (let attempt = 0; attempt < 100 && notices.length === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
	await router.stop();
	assert.equal(registry.pendingInputs(manifest.conversationId).every((input) => input.status === "cancelled"), true);
	assert.deepEqual(notices, ["No active run to abort; managed conversation remains dormant."]);
	await projector.projectNotice(manifest.conversationId, "$wake-abort", "No active run to abort; managed conversation remains dormant.");
	assert.equal(notices.length, 1, "cursor replay reuses the same notice identity and content");
});

test("active prompt, steer, abort, valid reply fallback, and fail-closed relations retain exact kinds", async (t) => {
	const { registry, manifest } = await fixture();
	const server = new ManagedSessionIpcServer(registry, { runtimeDirectory: join((await mkdtemp(join(tmpdir(), "controls-ipc-"))), "ipc") });
	await server.start(); t.after(() => server.close());
	const socket = await attach(server, manifest); t.after(() => socket.destroy());
	const relation = { "m.in_reply_to": { event_id: "$bot-answer" } };
	const events = [event("$prompt", "plain"), event("$steer", "!steer redirect"), event("$reply", "> <@bot:example.com> answer\n\nreply body", relation),
		event("$bad-reply", "> malformed\n\nignored", relation), event("$edit", "ignored", { rel_type: "m.replace", event_id: "$old" }),
		{ event_id: "$missing-time", sender: config.operatorUserId, type: "m.room.message", content: { msgtype: "m.text", body: "ignored missing time" } },
		event("$abort", "!abort")];
	let synced = false;
	const matrix = new ManagedMatrixClient(config, async (input) => {
		const path = new URL(String(input)).pathname;
		if (path.endsWith("/sync")) { if (synced) return Response.json(sync([])); synced = true; return Response.json(sync(events)); }
		if (path.includes("/state/m.room.member/")) return Response.json({ membership: "join" });
		if (path.includes("/event/")) return Response.json({ sender: config.botUserId });
		return Response.json({ event_id: "$ok" });
	}, [manifest.roomId]);
	const router = new CoordinatorRouter(manifest, registry, matrix, server, async () => undefined);
	router.start(); const delivered = await readMany(socket, 4); await router.stop();
	assert.deepEqual(delivered.map((item) => [item.payload.kind, item.payload.body]), [
		["prompt", "plain"], ["steer", "redirect"], ["prompt", "reply body"], ["abort", undefined],
	]);
	assert.equal(registry.pendingInputs(manifest.conversationId).length, 4);
	assert.equal(registry.pendingInputs(manifest.conversationId).every((input) => input.status === "cancelled"), true);
});

test("persisted unfinished delivery wakes a crashed process but explicit cancellation never recovers", async () => {
	const { registry, manifest } = await fixture();
	const deliveryId = deriveDeliveryId(manifest.conversationId, "$persisted");
	await registry.recordAcceptedInput(manifest.conversationId, { deliveryId, matrixEventId: "$persisted", kind: "prompt", body: "continue", status: "accepted" });
	await registry.acknowledgeInput(manifest.conversationId, deliveryId, "persisted", deriveTranscriptEntryId(manifest.piSessionId, "persisted-user"));
	let launches = 0;
	const matrix = new ManagedMatrixClient(config, async () => Response.json({ event_id: "$ok" }), [manifest.roomId]);
	const server = { sendToConversation: () => false } as unknown as ManagedSessionIpcServer;
	const router = new CoordinatorRouter(manifest, registry, matrix, server, async () => { launches += 1; throw new Error("simulated crash restart launch"); });
	await router.reconcileWake();
	for (let attempt = 0; attempt < 50 && launches === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(launches, 1, "persisted unfinished input wakes the same session after an unexpected process loss");
	await registry.cancelPendingInputs(manifest.conversationId);
	await router.reconcileWake();
	assert.equal(launches, 1, "durably cancelled input is never recovered");
});

test("checkpoint and notice projection retry stable Matrix transactions without duplicates", async () => {
	assert.throws(() => renderRemoteCheckpoint({ kind: "question", decision: "😀".repeat(3_000) }), /single Matrix event limit/);
	assert.throws(() => renderRemoteCheckpoint({ kind: "question", decision: "'".repeat(1_200), context: "'".repeat(1_200) }), /single Matrix event limit/);
	const { registry, manifest } = await fixture();
	const deliveryId = deriveDeliveryId(manifest.conversationId, "$origin");
	await registry.recordAcceptedInput(manifest.conversationId, { deliveryId, matrixEventId: "$origin", kind: "prompt", body: "question", status: "accepted" });
	await registry.acknowledgeInput(manifest.conversationId, deliveryId, "persisted", deriveTranscriptEntryId(manifest.piSessionId, "origin-user"));
	const transactions: string[] = []; let failAfterAcceptance = true;
	const matrix = new ManagedMatrixClient(config, async (input) => {
		const path = new URL(String(input)).pathname; if (!path.includes("/send/m.room.message/")) return Response.json({ event_id: "$ok" });
		transactions.push(path.split("/").at(-1)!); if (failAfterAcceptance) { failAfterAcceptance = false; throw new Error("acceptance crash"); }
		return Response.json({ event_id: "$sent" });
	}, [manifest.roomId], { maxAttempts: 1 });
	const projector = new RelayEventProjector(registry, matrix);
	const offer = { protocolVersion: MANAGED_SESSION_PROTOCOL_VERSION, messageId: "checkpoint-offer", conversationId: manifest.conversationId,
		role: "coordinator_adapter", type: "checkpoint.offer", payload: { checkpointId: `checkpoint-${"a".repeat(32)}`, originDeliveryId: deliveryId,
			checkpoint: { kind: "question", decision: "Approve closure?" } } } as ManagedSessionEnvelope;
	await assert.rejects(() => projector.projectCheckpoint(offer), /Matrix PUT .* failed/);
	await projector.projectCheckpoint(offer);
	await projector.projectCheckpoint(offer);
	await assert.rejects(() => projector.projectCheckpoint({ ...offer, messageId: "checkpoint-conflict", payload: {
		...offer.payload, checkpointId: `checkpoint-${"b".repeat(32)}`,
	} } as ManagedSessionEnvelope), /different boundary|not available/);
	assert.equal(transactions.length, 2);
	assert.equal(transactions[0], transactions[1]);
	const entryId = deriveTranscriptEntryId(manifest.piSessionId, `checkpoint:checkpoint-${"a".repeat(32)}`);
	assert.equal(registry.snapshot().conversations[0]?.projection.find((item) => item.entryId === entryId)?.status, "projected");
	assert.equal(registry.pendingInputs(manifest.conversationId)[0]?.status, "completed", "checkpoint completion is durable before adapter acknowledgement");
});
