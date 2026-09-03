import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
	MANAGED_SESSION_PROTOCOL_VERSION, MANAGED_SESSION_STATE_VERSION, deriveCheckpointPollAnswerId, deriveCheckpointPollIntentHash, deriveChunkId, deriveConversationId, deriveDeliveryId, deriveMatrixTransactionId, deriveTranscriptEntryId,
	encodeNdjsonEnvelope, parseNdjsonEnvelope, type ConversationManifest, type ManagedSessionEnvelope,
} from "../config/agent/extensions/managed-sessions/contracts.js";
import { renderRemoteCheckpoint, renderRemoteCheckpointPollQuestion } from "../config/agent/extensions/managed-sessions/checkpoint.js";
import { RelayEventProjector } from "../config/agent/extensions/managed-sessions/relay/event-projector.js";
import { CoordinatorRouter, authorizedRoomEvents, operatorTextEvents, parseTypedRemoteControl } from "../config/agent/extensions/managed-sessions/relay/coordinator-router.js";
import { ManagedSessionIpcServer } from "../config/agent/extensions/managed-sessions/relay/ipc-server.js";
import { ConversationManifestStore } from "../config/agent/extensions/managed-sessions/relay/manifest-store.js";
import { ManagedMatrixClient } from "../config/agent/extensions/managed-sessions/relay/matrix-client.js";
import { CheckpointPollPublisher } from "../config/agent/extensions/managed-sessions/relay/checkpoint-poll-publisher.js";
import { ControlPollPublisher } from "../config/agent/extensions/managed-sessions/relay/control-poll-publisher.js";
import { RelayRegistry } from "../config/agent/extensions/managed-sessions/relay/registry.js";
import { deriveControlId } from "../config/agent/extensions/managed-sessions/v2-contracts.js";

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

test("confirmed generation control gates queued text before old-adapter attachment replay", async (t) => {
	const { root, registry, manifest } = await fixture();
	const control = { controlId: deriveControlId(manifest.conversationId, "$new-confirm"), matrixEventId: "$new-confirm", name: "new" as const, argument: "--confirm" };
	await registry.recordPendingControl(manifest.conversationId, control);
	await registry.recordAcceptedInput(manifest.conversationId, { deliveryId: deriveDeliveryId(manifest.conversationId, "$after-new"), matrixEventId: "$after-new",
		kind: "prompt", body: "must be first in the fresh generation", status: "accepted" });
	const server = new ManagedSessionIpcServer(registry, { runtimeDirectory: join(root, "ipc-generation-gate") });
	await server.start(); t.after(() => server.close());
	const socket = await attach(server, manifest); t.after(() => socket.destroy());
	const router = new CoordinatorRouter(manifest, registry, new ManagedMatrixClient(config, async () => Response.json({ event_id: "$ok" }), [manifest.roomId]), server, async () => undefined);
	const first = readMany(socket, 1); await router.attachmentReady(manifest.conversationId);
	assert.equal((await first)[0]?.payload.controlId, control.controlId);
	let unexpected = false; const observe = () => { unexpected = true; }; socket.once("data", observe);
	await new Promise((resolve) => setTimeout(resolve, 50)); socket.off("data", observe);
	assert.equal(unexpected, false, "queued text is withheld until the fresh generation activates");
});

test("control poll intent recovers an accepted PUT and a vote arriving before event-ID persistence", async () => {
	const { root, registry, manifest } = await fixture();
	const source = { controlId: deriveControlId(manifest.conversationId, "$uncertain-model"), matrixEventId: "$uncertain-model", name: "model" as const };
	await registry.recordPendingControl(manifest.conversationId, source);
	const transactionId = deriveMatrixTransactionId(manifest.conversationId, source.controlId, 0);
	const putPaths: string[] = [];
	const matrix = new ManagedMatrixClient(config, async (input, init) => {
		const url = String(input); const method = init?.method ?? "GET";
		if (method === "PUT" && url.includes("/m.poll.start/")) { putPaths.push(new URL(url).pathname); return Response.json({ event_id: "$accepted-poll" }); }
		if (method === "GET" && url.includes("/event/")) return Response.json({ sender: config.botUserId, type: "m.poll.start", content: {
			"m.poll": { kind: "m.disclosed", max_selections: 1, question: { "m.text": [{ body: "Choose" }] },
				answers: [{ "m.id": "pi-control-0", "m.text": [{ body: "!model scoped/model" }] }] },
		} });
		throw new Error(`unexpected Matrix request ${method} ${url}`);
	}, [manifest.roomId]);
	const crashing = new ControlPollPublisher(registry, matrix, () => { throw new Error("injected crash after Matrix acceptance"); });
	await assert.rejects(crashing.publish({ conversationId: manifest.conversationId, roomId: manifest.roomId, sourceControl: source,
		scope: "model", prompt: "Choose", options: [{ answerId: "pi-control-0", command: "!model scoped/model" }] }), /injected crash/);
	const uncertain = registry.snapshot().conversations[0];
	assert.equal(uncertain?.activeControlPoll, null);
	assert.equal(uncertain?.publishingControlPoll?.transactionId, transactionId, "complete bounded intent is durable before PUT");

	// The homeserver can expose this vote in the next sync while the relay still lacks the poll event ID.
	const vote = { event_id: "$window-vote", origin_server_ts: Date.now(), sender: config.operatorUserId, type: "m.poll.response",
		content: { "m.selections": ["pi-control-0"], "m.relates_to": { rel_type: "m.reference", event_id: "$accepted-poll" } } };
	const restarted = new RelayRegistry("controls-host", join(root, "runtime"), new ConversationManifestStore(join(root, "manifests")));
	await restarted.load();
	await new ControlPollPublisher(restarted, matrix).reconcile();
	assert.equal(putPaths.length, 2);
	assert.equal(putPaths[0], putPaths[1], "reconciliation retries the identical idempotent Matrix transaction path");
	assert.equal(putPaths[1]?.endsWith(`/${transactionId}`), true);
	assert.equal(restarted.snapshot().conversations[0]?.publishingControlPoll, null);
	assert.equal(restarted.activeControlPollOption(manifest.conversationId, "$accepted-poll", "pi-control-0"), "!model scoped/model");
	const [authorized] = authorizedRoomEvents(sync([vote]), manifest.roomId, config.operatorUserId, true, Date.now());
	assert.equal(authorized?.kind, "poll_response");
	const selected = await matrix.controlPollAnswer(manifest.roomId, "$accepted-poll", "pi-control-0");
	const response = { controlId: deriveControlId(manifest.conversationId, "$window-vote"), matrixEventId: "$window-vote",
		name: "model" as const, argument: "scoped/model" };
	assert.equal(await restarted.acceptActiveControlPollResponse(manifest.conversationId, "$accepted-poll", "pi-control-0", selected!, response), true,
		"the vote arriving in the crash window is accepted after intent reconciliation");
	assert.deepEqual(restarted.pendingControls(manifest.conversationId), [response]);
});

test("active control polls survive publication restart and atomically queue one response before dispatch", async () => {
	const { root, registry, manifest } = await fixture();
	const source = { controlId: deriveControlId(manifest.conversationId, "$model-request"), matrixEventId: "$model-request",
		name: "model" as const };
	await registry.recordPendingControl(manifest.conversationId, source);
	await registry.registerActiveControlPoll(manifest.conversationId, { pollEventId: "$published-poll", sourceControlId: source.controlId,
		scope: "model", options: [
			{ answerId: "pi-control-0", command: "!model scoped/one" },
			{ answerId: "pi-control-1", command: "!model scoped/two" },
		] });
	await registry.acknowledgeControlResult(manifest.conversationId, source.controlId);

	const restarted = new RelayRegistry("controls-host", join(root, "runtime"), new ConversationManifestStore(join(root, "manifests")));
	await restarted.load();
	assert.equal(restarted.activeControlPollOption(manifest.conversationId, "$published-poll", "pi-control-1"), "!model scoped/two");
	assert.equal(restarted.activeControlPollOption(manifest.conversationId, "$published-poll", "not-offered"), undefined);
	const response = { controlId: deriveControlId(manifest.conversationId, "$vote"), matrixEventId: "$vote",
		name: "model" as const, argument: "scoped/two" };
	assert.equal(await restarted.acceptActiveControlPollResponse(manifest.conversationId, "$published-poll", "pi-control-1", "!model scoped/two", response), true);

	const crashedBeforeDispatch = new RelayRegistry("controls-host", join(root, "runtime"), new ConversationManifestStore(join(root, "manifests")));
	await crashedBeforeDispatch.load();
	assert.equal(crashedBeforeDispatch.snapshot().conversations[0]?.activeControlPoll, null, "poll retirement is durable before socket dispatch");
	assert.deepEqual(crashedBeforeDispatch.pendingControls(manifest.conversationId), [response], "accepted response is atomically durable for restart replay");
	assert.equal(await crashedBeforeDispatch.acceptActiveControlPollResponse(manifest.conversationId, "$published-poll", "pi-control-1", "!model scoped/two", response), false,
		"replayed response cannot dispatch twice");
});

test("delayed, superseded, and mismatched control poll responses fail closed without retiring the active poll", async () => {
	const { registry, manifest } = await fixture();
	const firstId = deriveControlId(manifest.conversationId, "$first-source");
	const secondId = deriveControlId(manifest.conversationId, "$second-source");
	await registry.recordPendingControl(manifest.conversationId, { controlId: firstId, matrixEventId: "$first-source", name: "model" });
	await registry.registerActiveControlPoll(manifest.conversationId, { pollEventId: "$old-poll", sourceControlId: firstId,
		scope: "model", options: [{ answerId: "pi-control-0", command: "!model scoped/old" }] });
	await registry.acknowledgeControlResult(manifest.conversationId, firstId);
	await registry.recordPendingControl(manifest.conversationId, { controlId: secondId, matrixEventId: "$second-source", name: "model" });
	await registry.registerActiveControlPoll(manifest.conversationId, { pollEventId: "$new-poll", sourceControlId: secondId,
		scope: "model", options: [{ answerId: "pi-control-0", command: "!model scoped/new" }] });
	const delayed = { controlId: deriveControlId(manifest.conversationId, "$delayed"), matrixEventId: "$delayed", name: "model" as const, argument: "scoped/old" };
	assert.equal(await registry.acceptActiveControlPollResponse(manifest.conversationId, "$old-poll", "pi-control-0", "!model scoped/old", delayed), false);
	assert.equal(await registry.acceptActiveControlPollResponse(manifest.conversationId, "$new-poll", "wrong-answer", "!model scoped/new", delayed), false);
	assert.equal(registry.activeControlPollOption(manifest.conversationId, "$new-poll", "pi-control-0"), "!model scoped/new",
		"stale and malformed responses do not close the current poll");

	const textual = { controlId: deriveControlId(manifest.conversationId, "$text-selection"), matrixEventId: "$text-selection",
		name: "model" as const, argument: "scoped/exact" };
	await registry.recordPendingControl(manifest.conversationId, textual);
	assert.equal(registry.snapshot().conversations[0]?.activeControlPoll, null, "exact textual selection closes the same control scope");
	assert.equal(await registry.acceptActiveControlPollResponse(manifest.conversationId, "$new-poll", "pi-control-0", "!model scoped/new", delayed), false);
});

test("typed control parsing is strict, bounded, and isolates malformed commands from prompts", () => {
	assert.deepEqual(parseTypedRemoteControl(" !model scoped/model "), { name: "model", argument: "scoped/model" });
	assert.deepEqual(parseTypedRemoteControl("!compact focus on API state"), { name: "compact", argument: "focus on API state" });
	assert.deepEqual(parseTypedRemoteControl("!unknown secret prompt"), { name: "help" });
	assert.deepEqual(parseTypedRemoteControl("!status extra"), { name: "help" });
	assert.deepEqual(parseTypedRemoteControl("!new"), { name: "new" });
	assert.deepEqual(parseTypedRemoteControl("!new --confirm"), { name: "new", argument: "--confirm" });
	assert.deepEqual(parseTypedRemoteControl("!new yes"), { name: "help" });
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

test("checkpoint poll question and fallback enforce the single-event byte bound", () => {
	assert.throws(() => renderRemoteCheckpointPollQuestion({ kind: "question", decision: "😀".repeat(600), context: "😀".repeat(600),
		options: Array.from({ length: 8 }, () => "😀".repeat(150)) }), /single Matrix event limit/);
	assert.match(renderRemoteCheckpointPollQuestion({ kind: "question", decision: "Choose", options: ["One", "Two"] }), /reply with text/);
});

test("checkpoint option polls persist opaque mappings and recover the same accepted Matrix transaction", async () => {
	const { root, registry, manifest } = await fixture();
	const deliveryId = deriveDeliveryId(manifest.conversationId, "$poll-origin");
	const entryId = deriveTranscriptEntryId(manifest.piSessionId, "checkpoint:checkpoint-poll-recovery");
	const transactionId = deriveMatrixTransactionId(manifest.conversationId, entryId, 0);
	await registry.recordAcceptedInput(manifest.conversationId, { deliveryId, matrixEventId: "$poll-origin", kind: "prompt", body: "choose", status: "accepted" });
	await registry.acknowledgeInput(manifest.conversationId, deliveryId, "persisted", deriveTranscriptEntryId(manifest.piSessionId, "poll-origin-user"));
	const intentBase = { checkpointId: "checkpoint-poll-recovery", originDeliveryId: deliveryId, entryId, transactionId,
		question: "Choose one, or reply with text.", options: ["First exact option", "Second exact option"].map((text, index) => ({
			answerId: deriveCheckpointPollAnswerId("checkpoint-poll-recovery", index), text,
		})) };
	const intent = { ...intentBase, intentHash: deriveCheckpointPollIntentHash(intentBase) };
	await registry.beginProjection(manifest.conversationId, { entryId, kind: "checkpoint", status: "projecting", contentHash: intent.intentHash, originDeliveryId: deliveryId,
		chunks: [{ chunkId: deriveChunkId(entryId, 0), transactionId, status: "pending" }] });
	const transactions: string[] = [];
	const matrix = new ManagedMatrixClient(config, async (input) => {
		const path = new URL(String(input)).pathname;
		if (path.includes("/m.poll.start/")) { transactions.push(path.split("/").at(-1)!); return Response.json({ event_id: "$checkpoint-poll" }); }
		throw new Error(`unexpected request ${path}`);
	}, [manifest.roomId]);
	const crashing = new CheckpointPollPublisher(registry, matrix, () => { throw new Error("crash after poll acceptance"); });
	await assert.rejects(crashing.publish(manifest.conversationId, manifest.roomId, intent), /crash after poll acceptance/);
	assert.deepEqual(registry.snapshot().conversations[0]?.publishingCheckpointPoll, intent);
	const restarted = new RelayRegistry("controls-host", join(root, "runtime"), new ConversationManifestStore(join(root, "manifests")));
	await restarted.load();
	await new CheckpointPollPublisher(restarted, matrix).reconcile();
	assert.deepEqual(transactions, [transactionId, transactionId]);
	assert.equal(restarted.snapshot().conversations[0]?.publishingCheckpointPoll, null);
	assert.equal(restarted.snapshot().conversations[0]?.activeCheckpointPoll?.pollEventId, "$checkpoint-poll");
	assert.notEqual(intent.options[0]?.answerId, intent.options[0]?.text, "persisted answer IDs are opaque");
	const answer = { deliveryId: deriveDeliveryId(manifest.conversationId, "$recovery-text"), matrixEventId: "$recovery-text", kind: "prompt", body: "Other", status: "accepted" };
	const closing = await restarted.acceptActiveCheckpointText(manifest.conversationId, answer);
	assert.ok(closing);
	const closeTransactions: string[] = []; let failClose = true;
	const closingMatrix = new ManagedMatrixClient(config, async (input) => {
		const path = new URL(String(input)).pathname; closeTransactions.push(path.split("/").at(-1)!);
		if (failClose) { failClose = false; throw new Error("close outage"); }
		return Response.json({ event_id: "$closed" });
	}, [manifest.roomId], { maxAttempts: 1 });
	await assert.rejects(new CheckpointPollPublisher(restarted, closingMatrix).close(manifest.conversationId, manifest.roomId, closing!), /failed/);
	const closureRestart = new RelayRegistry("controls-host", join(root, "runtime"), new ConversationManifestStore(join(root, "manifests")));
	await closureRestart.load();
	assert.equal(closureRestart.closingCheckpointPolls().length, 1, "accepted answer retains a durable poll closure during outage");
	await new CheckpointPollPublisher(closureRestart, closingMatrix).reconcile();
	assert.deepEqual(closeTransactions, [closing!.closureTransactionId, closing!.closureTransactionId]);
	assert.equal(closureRestart.closingCheckpointPolls().length, 0);
});

test("text waits behind an unresolved checkpoint poll publication without advancing the cursor", async () => {
	const { registry, manifest } = await fixture();
	const originId = deriveDeliveryId(manifest.conversationId, "$publishing-origin");
	const entryId = deriveTranscriptEntryId(manifest.piSessionId, "checkpoint:publishing-race");
	const transactionId = deriveMatrixTransactionId(manifest.conversationId, entryId, 0);
	await registry.recordAcceptedInput(manifest.conversationId, { deliveryId: originId, matrixEventId: "$publishing-origin", kind: "prompt", body: "choose", status: "accepted" });
	await registry.acknowledgeInput(manifest.conversationId, originId, "persisted", deriveTranscriptEntryId(manifest.piSessionId, "publishing-origin-user"));
	const intentBase = { checkpointId: "publishing-race", originDeliveryId: originId, entryId, transactionId,
		question: "Choose", options: [{ answerId: deriveCheckpointPollAnswerId("publishing-race", 0), text: "One" }] };
	const intent = { ...intentBase, intentHash: deriveCheckpointPollIntentHash(intentBase) };
	await registry.beginProjection(manifest.conversationId, { entryId, kind: "checkpoint", status: "projecting", contentHash: intent.intentHash, originDeliveryId: originId,
		chunks: [{ chunkId: deriveChunkId(entryId, 0), transactionId, status: "pending" }] });
	await registry.beginCheckpointPollPublication(manifest.conversationId, intent);
	let diagnostics = 0; let syncCalls = 0;
	const matrix = new ManagedMatrixClient(config, async (input, init) => {
		const path = new URL(String(input)).pathname;
		if (path.includes("/state/m.room.member/")) return Response.json({ membership: "join" });
		if (path.endsWith("/sync")) { syncCalls += 1; if (syncCalls === 1) return Response.json(sync([event("$publication-window-text", "Fallback answer")]));
			return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("cancelled"), { name: "AbortError" })), { once: true })); }
		return Response.json({ event_id: "$ok" });
	}, [manifest.roomId]);
	const router = new CoordinatorRouter(manifest, registry, matrix, { sendToConversation: () => false } as unknown as ManagedSessionIpcServer,
		async () => undefined, undefined, undefined, () => { diagnostics += 1; });
	router.start();
	for (let attempt = 0; attempt < 100 && diagnostics === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
	await router.stop();
	assert.equal(diagnostics > 0, true);
	assert.deepEqual(registry.snapshot().conversations[0]?.matrixCursor, { status: "established", since: "controls-fixture-cursor" });
	assert.equal(registry.pendingInputs(manifest.conversationId).some((input) => input.matrixEventId === "$publication-window-text"), false);
	assert.equal(registry.hasPublishingCheckpointPoll(manifest.conversationId), true);
});

test("first valid checkpoint vote resumes once with exact option text and retires late votes", async (t) => {
	const { root, registry, manifest } = await fixture();
	const deliveryId = deriveDeliveryId(manifest.conversationId, "$vote-origin");
	await registry.recordAcceptedInput(manifest.conversationId, { deliveryId, matrixEventId: "$vote-origin", kind: "prompt", body: "choose", status: "accepted" });
	await registry.acknowledgeInput(manifest.conversationId, deliveryId, "persisted", deriveTranscriptEntryId(manifest.piSessionId, "vote-origin-user"));
	let pollContent: Record<string, unknown> | undefined; let syncCount = 0; const pollEnds: string[] = [];
	const matrix = new ManagedMatrixClient(config, async (input, init) => {
		const path = new URL(String(input)).pathname; const method = init?.method ?? "GET";
		if (method === "PUT" && path.includes("/m.poll.start/")) { pollContent = JSON.parse(String(init?.body)); return Response.json({ event_id: "$vote-poll" }); }
		if (method === "GET" && path.endsWith("/event/%24vote-poll")) return Response.json({ sender: config.botUserId, type: "m.poll.start", content: pollContent });
		if (method === "PUT" && path.includes("/m.poll.end/")) { pollEnds.push(path); return Response.json({ event_id: "$poll-end" }); }
		if (path.includes("/state/m.room.member/")) return Response.json({ membership: "join" });
		if (path.endsWith("/sync")) {
			syncCount += 1;
			if (syncCount > 1) return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("cancelled"), { name: "AbortError" })), { once: true }));
			const firstAnswer = deriveCheckpointPollAnswerId("checkpoint-vote", 1);
			const changedAnswer = deriveCheckpointPollAnswerId("checkpoint-vote", 0);
			const vote = (id: string, answerId: string, sender = config.operatorUserId) => ({ event_id: id, origin_server_ts: Date.now(), sender, type: "m.poll.response",
				content: { "m.selections": [answerId], "m.relates_to": { rel_type: "m.reference", event_id: "$vote-poll" } } });
			const cleared = { ...vote("$cleared-vote", firstAnswer), content: { "m.selections": [], "m.relates_to": { rel_type: "m.reference", event_id: "$vote-poll" } } };
			return Response.json(sync([vote("$foreign-vote", firstAnswer, "@foreign:example.com"), cleared, vote("$malformed-vote", "unknown-answer"),
				vote("$first-vote", firstAnswer), vote("$changed-vote", changedAnswer), vote("$late-vote", firstAnswer)]));
		}
		throw new Error(`unexpected request ${method} ${path}`);
	}, [manifest.roomId]);
	const projector = new RelayEventProjector(registry, matrix);
	await projector.projectCheckpoint({ protocolVersion: MANAGED_SESSION_PROTOCOL_VERSION, messageId: "vote-offer", conversationId: manifest.conversationId,
		role: "coordinator_adapter", type: "checkpoint.offer", payload: { checkpointId: "checkpoint-vote", originDeliveryId: deliveryId,
			checkpoint: { kind: "question", decision: "Choose release mode", context: "Only one vote is accepted.", options: ["Hold", "Release exactly"] } } });
	const server = new ManagedSessionIpcServer(registry, { runtimeDirectory: join(root, "vote-ipc") }); await server.start(); t.after(() => server.close());
	const socket = await attach(server, manifest); t.after(() => socket.destroy());
	const router = new CoordinatorRouter(manifest, registry, matrix, server, async () => undefined, undefined, undefined, undefined, undefined,
		() => projector.checkpointPollPublisher.reconcile());
	const delivered = readMany(socket, 1); router.start();
	const [answer] = await delivered; await router.stop();
	assert.deepEqual([answer.payload.kind, answer.payload.body], ["prompt", "Release exactly"]);
	assert.equal(registry.snapshot().conversations[0]?.activeCheckpointPoll, null);
	assert.deepEqual(registry.pendingInputs(manifest.conversationId).filter((input) => input.matrixEventId.endsWith("-vote")).map((input) => input.matrixEventId), ["$first-vote"]);
	assert.equal(pollEnds.length, 1);
});

test("router starts ephemeral feedback for adapter controls and slash commands", async (t) => {
	const { root, registry, manifest } = await fixture(); let syncCount = 0; const feedback: string[] = []; const ended: string[] = [];
	const matrix = new ManagedMatrixClient(config, async (input, init) => {
		const path = new URL(String(input)).pathname;
		if (path.includes("/state/m.room.member/")) return Response.json({ membership: "join" });
		if (path.endsWith("/sync")) { syncCount += 1; if (syncCount === 1) return Response.json(sync([event("$compact-feedback", "!compact focus"), event("$command-feedback", "/name grouped"), event("$abort-feedback", "!abort")]));
			return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("cancelled"), { name: "AbortError" })), { once: true })); }
		return Response.json({ event_id: "$ok" });
	}, [manifest.roomId]);
	const server = new ManagedSessionIpcServer(registry, { runtimeDirectory: join(root, "feedback-ipc") }); await server.start(); t.after(() => server.close());
	const socket = await attach(server, manifest); t.after(() => socket.destroy());
	const router = new CoordinatorRouter(manifest, registry, matrix, server, async () => undefined, undefined, undefined, undefined, undefined, undefined, undefined,
		async (_conversationId, operationId) => { feedback.push(operationId); }, async (_conversationId, operationId) => { ended.push(operationId); });
	const delivered = readMany(socket, 2); router.start(); await delivered; await new Promise((resolve) => setTimeout(resolve, 20)); await router.stop();
	const commandId = deriveDeliveryId(manifest.conversationId, "$command-feedback");
	assert.deepEqual(feedback.sort(), [deriveControlId(manifest.conversationId, "$compact-feedback"), commandId].sort());
	assert.deepEqual(ended, [commandId], "durable abort cancellation releases slash-command typing feedback");
});

test("control-poll selections acquire the same adapter-operation typing feedback", async (t) => {
	const { root, registry, manifest } = await fixture(); const source = { controlId: deriveControlId(manifest.conversationId, "$model-source"), matrixEventId: "$model-source", name: "model" as const };
	await registry.recordPendingControl(manifest.conversationId, source);
	await registry.registerActiveControlPoll(manifest.conversationId, { pollEventId: "$model-poll", sourceControlId: source.controlId, scope: "model",
		options: [{ answerId: "pi-control-0", command: "!model scoped/model" }] });
	await registry.acknowledgeControlResult(manifest.conversationId, source.controlId);
	let syncCount = 0; const feedback: string[] = [];
	const matrix = new ManagedMatrixClient(config, async (input, init) => {
		const path = new URL(String(input)).pathname;
		if (path.includes("/state/m.room.member/")) return Response.json({ membership: "join" });
		if (path.includes("/event/")) return Response.json({ sender: config.botUserId, type: "m.poll.start", content: { "m.poll": {
			kind: "m.disclosed", max_selections: 1, answers: [{ "m.id": "pi-control-0", "m.text": [{ body: "!model scoped/model" }] }] } } });
		if (path.includes("/m.poll.end/")) return Response.json({ event_id: "$closed" });
		if (path.endsWith("/sync")) { syncCount += 1; if (syncCount === 1) return Response.json(sync([{ event_id: "$model-vote", origin_server_ts: Date.now(), sender: config.operatorUserId,
			type: "m.poll.response", content: { "m.selections": ["pi-control-0"], "m.relates_to": { rel_type: "m.reference", event_id: "$model-poll" } } }]));
			return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("cancelled"), { name: "AbortError" })), { once: true })); }
		return Response.json({ event_id: "$ok" });
	}, [manifest.roomId]);
	const server = new ManagedSessionIpcServer(registry, { runtimeDirectory: join(root, "poll-feedback-ipc") }); await server.start(); t.after(() => server.close());
	const socket = await attach(server, manifest); t.after(() => socket.destroy());
	const router = new CoordinatorRouter(manifest, registry, matrix, server, async () => undefined, undefined, undefined, undefined, undefined, undefined, undefined,
		async (_conversationId, operationId) => { feedback.push(operationId); });
	const delivered = readMany(socket, 1); router.start(); const [control] = await delivered; await router.stop();
	assert.equal(control.payload.name, "model"); assert.deepEqual(feedback, [deriveControlId(manifest.conversationId, "$model-vote")]);
});

test("ordinary checkpoint text closes the poll and bypasses configured options exactly once", async (t) => {
	const { root, registry, manifest } = await fixture();
	const originId = deriveDeliveryId(manifest.conversationId, "$text-origin");
	await registry.recordAcceptedInput(manifest.conversationId, { deliveryId: originId, matrixEventId: "$text-origin", kind: "prompt", body: "choose", status: "accepted" });
	await registry.acknowledgeInput(manifest.conversationId, originId, "persisted", deriveTranscriptEntryId(manifest.piSessionId, "text-origin-user"));
	let syncCount = 0; let pollEnds = 0;
	const matrix = new ManagedMatrixClient(config, async (input, init) => {
		const path = new URL(String(input)).pathname;
		if (path.includes("/m.poll.start/")) return Response.json({ event_id: "$text-poll" });
		if (path.includes("/m.poll.end/")) { pollEnds += 1; return Response.json({ event_id: "$text-poll-end" }); }
		if (path.includes("/state/m.room.member/")) return Response.json({ membership: "join" });
		if (path.endsWith("/sync")) {
			syncCount += 1;
			if (syncCount === 1) return Response.json(sync([event("$text-answer", "Use a custom safe answer"), event("$later-text", "must not replace") ]));
			return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("cancelled"), { name: "AbortError" })), { once: true }));
		}
		return Response.json({ event_id: "$ok" });
	}, [manifest.roomId]);
	const projector = new RelayEventProjector(registry, matrix);
	await projector.projectCheckpoint({ protocolVersion: MANAGED_SESSION_PROTOCOL_VERSION, messageId: "text-offer", conversationId: manifest.conversationId,
		role: "coordinator_adapter", type: "checkpoint.offer", payload: { checkpointId: "checkpoint-text", originDeliveryId: originId,
			checkpoint: { kind: "question", decision: "Choose", options: ["One", "Two"] } } });
	const server = new ManagedSessionIpcServer(registry, { runtimeDirectory: join(root, "text-ipc") }); await server.start(); t.after(() => server.close());
	const socket = await attach(server, manifest); t.after(() => socket.destroy());
	const router = new CoordinatorRouter(manifest, registry, matrix, server, async () => undefined);
	const delivered = readMany(socket, 2); router.start(); const answers = await delivered; await router.stop();
	assert.deepEqual(answers.map((answer) => answer.payload.body), ["Use a custom safe answer", "must not replace"]);
	assert.equal(registry.snapshot().conversations[0]?.activeCheckpointPoll, null);
	assert.equal(pollEnds, 1);
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
