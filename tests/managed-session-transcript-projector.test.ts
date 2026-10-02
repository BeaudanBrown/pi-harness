import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	MANAGED_SESSION_PROTOCOL_VERSION,
	MANAGED_SESSION_STATE_VERSION,
	deriveConversationId,
	deriveDeliveryId,
	deriveChunkId,
	deriveMatrixTransactionId,
	parseHostRuntimeState,
	deriveTranscriptEntryId,
	type ConversationManifest,
	type ManagedSessionEnvelope,
} from "../config/agent/extensions/managed-sessions/contracts.js";
import { ConversationManifestStore } from "../config/agent/extensions/managed-sessions/relay/manifest-store.js";
import { ManagedMatrixClient } from "../config/agent/extensions/managed-sessions/relay/matrix-client.js";
import { RelayRegistry } from "../config/agent/extensions/managed-sessions/relay/registry.js";
import { TranscriptProjector } from "../config/agent/extensions/managed-sessions/relay/transcript-projector.js";
import { renderTranscript as renderLegacy } from "../config/agent/extensions/managed-sessions/relay/legacy-transcript-renderer.js";
import { transcriptContentHash } from "../config/agent/extensions/managed-sessions/relay/transcript-renderer.js";
import { RelayEventProjector } from "../config/agent/extensions/managed-sessions/relay/event-projector.js";
import { renderRemoteCheckpoint } from "../config/agent/extensions/managed-sessions/checkpoint.js";
import { createHash } from "node:crypto";

const hostId = "projection-host";
const sessionId = "projection-session";
const conversationId = deriveConversationId(hostId, "projection-work");
const roomId = "!projection:example.com";
const manifest: ConversationManifest = {
	schemaVersion: MANAGED_SESSION_STATE_VERSION,
	kind: "project",
	conversationId,
	ownerHostId: hostId,
	creationKey: "projection-work",
	concept: "projection work",
	piSessionId: sessionId,
	roomId,
	placement: { rootKey: "projects", workspace: "projection-work", relativeCwd: "" },
	bindingBoundaryEntryId: deriveTranscriptEntryId(sessionId, "boundary"),
	createdAt: "2026-08-31T00:00:00.000Z",
};

async function registryFixture(): Promise<{ root: string; store: ConversationManifestStore; registry: RelayRegistry }> {
	const root = await mkdtemp(join(tmpdir(), "pi-transcript-projector-"));
	const store = new ConversationManifestStore(join(root, "manifests"));
	await store.write(manifest);
	const registry = new RelayRegistry(hostId, join(root, "runtime"), store);
	await registry.load();
	return { root, store, registry };
}

function offer(piEntryKey: string, body: string, kind: "local_user" | "assistant_final" = "assistant_final"): ManagedSessionEnvelope {
	return {
		protocolVersion: MANAGED_SESSION_PROTOCOL_VERSION,
		messageId: `offer-${piEntryKey}`,
		conversationId,
		role: "ordinary_adapter",
		type: "transcript.offer",
		payload: { entryId: deriveTranscriptEntryId(sessionId, piEntryKey), piSessionId: sessionId, piEntryKey, kind, body },
	};
}

const matrixConfig = {
	homeserver: "https://matrix.example.com",
	accessToken: "secret",
	botUserId: "@bot:example.com",
	operatorUserId: "@operator:example.com",
};

test("projection retries the same Matrix transaction after acceptance-before-ack crash", async () => {
	const { root, store, registry } = await registryFixture();
	const transactions: string[] = [];
	const matrix = new ManagedMatrixClient(matrixConfig, async (input) => {
		transactions.push(new URL(String(input)).pathname.split("/").at(-1)!);
		return Response.json({ event_id: `$event-${transactions.length}` });
	}, [roomId]);
	const projector = new TranscriptProjector(registry, matrix);
	const originalMark = registry.markProjectionChunkSent.bind(registry);
	let failAfterMatrixAcceptance = true;
	registry.markProjectionChunkSent = async (...args) => {
		if (failAfterMatrixAcceptance) { failAfterMatrixAcceptance = false; throw new Error("simulated registry crash"); }
		return originalMark(...args);
	};
	await assert.rejects(() => projector.project(offer("answer", "final **answer**")), /simulated registry crash/);
	assert.equal(registry.snapshot().conversations[0]?.projection[0]?.chunks[0]?.status, "pending");
	assert.equal(registry.snapshot().conversations[0]?.projection[0]?.renderingVersion, 2);
	assert.match(registry.snapshot().conversations[0]?.projection[0]?.chunks[0]?.formattedBody ?? "", /<strong>answer<\/strong>/);

	const restarted = new RelayRegistry(hostId, join(root, "runtime"), store);
	await restarted.load();
	await new TranscriptProjector(restarted, matrix).project(offer("answer", "final **answer**"));
	assert.equal(transactions.length, 2);
	assert.equal(transactions[0], transactions[1], "Matrix retry must reuse the stable transaction ID");
	assert.equal(restarted.snapshot().conversations[0]?.projection[0]?.status, "projected");
	await new TranscriptProjector(restarted, matrix).project(offer("answer", "final **answer**"));
	assert.equal(transactions.length, 2, "projected retries must not send another Matrix event");
	await assert.rejects(() => new TranscriptProjector(restarted, matrix).project(offer("answer", "changed body")), /Conflicting transcript projection content/);
});

test("Matrix-origin persisted users map to their operator event without a bot projection", async () => {
	const { registry } = await registryFixture();
	const deliveryId = deriveDeliveryId(conversationId, "$operator-event");
	await registry.recordAcceptedInput(conversationId, {
		deliveryId, matrixEventId: "$operator-event", kind: "prompt", body: "operator text", status: "accepted",
	});
	const entryId = deriveTranscriptEntryId(sessionId, "matrix-user");
	await registry.acknowledgeInput(conversationId, deliveryId, "persisted", entryId);
	await registry.acknowledgeInput(conversationId, deliveryId, "completed", entryId);
	const runtime = registry.snapshot().conversations[0]!;
	assert.equal(runtime.pendingInputs[0]?.piEntryId, entryId);
	assert.deepEqual(runtime.projection, [{ entryId, kind: "matrix_user", status: "projected", chunks: [] }]);
	await assert.rejects(() => registry.acknowledgeInput(conversationId, deliveryId, "completed", deriveTranscriptEntryId(sessionId, "other")), /changed its persisted Pi entry identity/);
});

for (const kind of ["assistant_final", "local_user"] as const) {
	test(`partially delivered legacy ${kind} retains exact legacy boundaries after upgrade`, async () => {
		const { root, store, registry } = await registryFixture();
		const source = "```\n" + "<&> old code\n".repeat(1_500) + "```";
		const rendered = renderLegacy(kind, source);
		assert.ok(rendered.length > 1);
		const entryId = deriveTranscriptEntryId(sessionId, "legacy");
		await registry.beginProjection(conversationId, { entryId, kind, status: "projecting", contentHash: transcriptContentHash(kind, source),
			chunks: rendered.map((_c, index) => ({ chunkId: deriveChunkId(entryId, index), transactionId: deriveMatrixTransactionId(conversationId, entryId, index), status: index === 0 ? "sent" : "pending" })) });
		const sent: Array<{ body: string; formatted_body: string }> = [];
		const matrix = new ManagedMatrixClient(matrixConfig, async (_input, init) => {
			sent.push(JSON.parse(String(init?.body))); return Response.json({ event_id: "$legacy" });
		}, [roomId]);
		const restarted = new RelayRegistry(hostId, join(root, "runtime"), store); await restarted.load();
		await new TranscriptProjector(restarted, matrix).project(offer("legacy", source, kind));
		assert.deepEqual(sent.map(c => ({ body: c.body, formattedBody: c.formatted_body })), rendered.slice(1));
		await new TranscriptProjector(restarted, matrix).project(offer("legacy", source, kind));
		assert.equal(sent.length, rendered.length - 1);
	});
}

test("frozen v2 payloads survive renderer changes, and sent payload bytes are released", async () => {
	const { root, store, registry } = await registryFixture();
	const source = "# Heading";
	const entryId = deriveTranscriptEntryId(sessionId, "frozen");
	const frozen = { body: "Previously rendered heading", formattedBody: "<p>Previously rendered heading</p>" };
	await registry.beginProjection(conversationId, { entryId, kind: "assistant_final", status: "projecting", renderingVersion: 2,
		contentHash: transcriptContentHash("assistant_final", source), chunks: [{ chunkId: deriveChunkId(entryId, 0),
			transactionId: deriveMatrixTransactionId(conversationId, entryId, 0), status: "pending", ...frozen }] });
	const requests: unknown[] = [];
	const matrix = new ManagedMatrixClient(matrixConfig, async (_input, init) => { requests.push(JSON.parse(String(init?.body))); return Response.json({ event_id: "$frozen" }); }, [roomId]);
	const restarted = new RelayRegistry(hostId, join(root, "runtime"), store); await restarted.load();
	await new TranscriptProjector(restarted, matrix).project(offer("frozen", source));
	assert.equal((requests[0] as { body: string }).body, frozen.body);
	assert.equal((requests[0] as { formatted_body: string }).formatted_body, frozen.formattedBody);
	assert.equal(restarted.snapshot().conversations[0]?.projection[0]?.chunks[0]?.body, undefined);
	await new TranscriptProjector(restarted, matrix).project(offer("frozen", source));
	assert.equal(requests.length, 1);
});

test("frozen text notice retries use the exact transaction body", async () => {
	const { root, store, registry } = await registryFixture();
	const requests: string[] = [];
	const matrix = new ManagedMatrixClient(matrixConfig, async (_input, init) => { requests.push(String(init?.body)); return Response.json({ event_id: "$notice" }); }, [roomId]);
	registry.markProjectionChunkSent = async () => { throw new Error("crash after send"); };
	await assert.rejects(() => new RelayEventProjector(registry, matrix).projectNotice(conversationId, "source", "# Notice\n\n- item"), /crash after send/);
	const restarted = new RelayRegistry(hostId, join(root, "runtime"), store); await restarted.load();
	await new RelayEventProjector(restarted, matrix).projectNotice(conversationId, "source", "# Notice\n\n- item");
	assert.deepEqual(requests, [requests[0], requests[0]]);
});

test("frozen projection schema rejects missing, unknown, mixed and oversized payloads", async () => {
	const { registry } = await registryFixture();
	const entryId = deriveTranscriptEntryId(sessionId, "validate");
	await registry.beginProjection(conversationId, { entryId, kind: "assistant_final", status: "projecting", renderingVersion: 2,
		contentHash: transcriptContentHash("assistant_final", "source"), chunks: [{ chunkId: deriveChunkId(entryId, 0),
			transactionId: deriveMatrixTransactionId(conversationId, entryId, 0), status: "pending", body: "text", formattedBody: "<p>text</p>" }] });
	const state = registry.snapshot();
	assert.doesNotThrow(() => parseHostRuntimeState(state));
	const missing = structuredClone(state); delete missing.conversations[0]!.projection[0]!.chunks[0]!.body;
	assert.throws(() => parseHostRuntimeState(missing), /frozen projection/);
	const mixed = structuredClone(state); delete mixed.conversations[0]!.projection[0]!.renderingVersion;
	assert.throws(() => parseHostRuntimeState(mixed), /frozen projection/);
	const unsupported = structuredClone(state) as unknown as { conversations: Array<{ projection: Array<{ renderingVersion: number }> }> };
	unsupported.conversations[0]!.projection[0]!.renderingVersion = 3;
	assert.throws(() => parseHostRuntimeState(unsupported), /renderingVersion/);
	const oversized = structuredClone(state); oversized.conversations[0]!.projection[0]!.chunks[0]!.body = "🙂".repeat(2_001);
	assert.throws(() => parseHostRuntimeState(oversized), /byte budget/);
	await assert.rejects(() => registry.beginProjection(conversationId, { ...state.conversations[0]!.projection[0]!, chunks: [{ ...state.conversations[0]!.projection[0]!.chunks[0]!, body: "replacement" }] }), /Conflicting transcript/);
	const inconsistent = structuredClone(state); inconsistent.conversations[0]!.projection[0]!.status = "projected";
	assert.throws(() => parseHostRuntimeState(inconsistent), /versioned text projection/);
	const offered = structuredClone(state); offered.conversations[0]!.projection[0]!.status = "offered";
	assert.throws(() => parseHostRuntimeState(offered), /versioned text projection/);
	const full = structuredClone(state);
	full.conversations[0]!.projection = Array.from({ length: 17 }, (_v, entry) => {
		const id = deriveTranscriptEntryId(sessionId, `budget-${entry}`);
		return { ...state.conversations[0]!.projection[0]!, entryId: id, chunks: Array.from({ length: 64 }, (_x, index) => ({
			chunkId: deriveChunkId(id, index), transactionId: deriveMatrixTransactionId(conversationId, id, index), status: "pending",
			body: "x".repeat(8_000), formattedBody: "x".repeat(8_000),
		})) };
	});
	assert.throws(() => parseHostRuntimeState(full), /Frozen projection capacity/);
});

test("new payloads are durable before the first send, and a failed prepare sends nothing", async () => {
	const { root, store, registry } = await registryFixture();
	const matrix = new ManagedMatrixClient(matrixConfig);
	let sends = 0;
	matrix.sendText = async (_room, _txn, body, html) => {
		sends += 1;
		const restarted = new RelayRegistry(hostId, join(root, "runtime"), store); await restarted.load();
		const pending = restarted.snapshot().conversations[0]?.projection[0]?.chunks[0];
		assert.equal(pending?.body, body); assert.equal(pending?.formattedBody, html);
		throw new Error("crash before send");
	};
	await assert.rejects(() => new TranscriptProjector(registry, matrix).project(offer("prepared", "# prepared")), /crash before send/);
	assert.equal(sends, 1);
	await assert.rejects(() => new TranscriptProjector(registry, matrix).project(offer("overflow", "> ".repeat(32) + "text")), /nesting exceeds/);
	assert.equal(sends, 1);
	assert.equal(registry.snapshot().conversations[0]?.projection.length, 1);
});

for (const legacy of [true, false]) {
	test(`${legacy ? "legacy" : "versioned"} text checkpoints recover accepted sends without changing transaction bodies`, async () => {
		const { root, store, registry } = await registryFixture();
		const deliveryId = deriveDeliveryId(conversationId, "$checkpoint-origin");
		await registry.recordAcceptedInput(conversationId, { deliveryId, matrixEventId: "$checkpoint-origin", kind: "prompt", body: "question", status: "accepted" });
		await registry.acknowledgeInput(conversationId, deliveryId, "persisted", deriveTranscriptEntryId(sessionId, "origin"));
		const checkpoint = { kind: "question" as const, decision: "Which option?" };
		const body = renderRemoteCheckpoint(checkpoint);
		const entryId = deriveTranscriptEntryId(sessionId, "checkpoint:boundary");
		const expected = legacy ? renderLegacy("assistant_final", body)[0]! : undefined;
		if (legacy) await registry.beginProjection(conversationId, { entryId, kind: "checkpoint", status: "projecting", originDeliveryId: deliveryId,
			contentHash: createHash("sha256").update("managed-checkpoint\0").update(body).digest("hex"), chunks: [{ chunkId: deriveChunkId(entryId, 0),
				transactionId: deriveMatrixTransactionId(conversationId, entryId, 0), status: "pending" }] });
		const requests: string[] = [];
		const matrix = new ManagedMatrixClient(matrixConfig, async (_input, init) => { requests.push(String(init?.body)); return Response.json({ event_id: "$checkpoint" }); }, [roomId]);
		registry.markProjectionChunkSent = async () => { throw new Error("checkpoint crash"); };
		const envelope: ManagedSessionEnvelope = { protocolVersion: MANAGED_SESSION_PROTOCOL_VERSION, messageId: "checkpoint-offer", conversationId,
			role: "ordinary_adapter", type: "checkpoint.offer", payload: { checkpointId: "boundary", originDeliveryId: deliveryId, checkpoint } };
		await assert.rejects(() => new RelayEventProjector(registry, matrix).projectCheckpoint(envelope), /checkpoint crash/);
		const restarted = new RelayRegistry(hostId, join(root, "runtime"), store); await restarted.load();
		await new RelayEventProjector(restarted, matrix).projectCheckpoint(envelope);
		assert.deepEqual(requests, [requests[0], requests[0]]);
		if (expected) { const sent = JSON.parse(requests[0]!); assert.equal(sent.body, expected.body); assert.equal(sent.formatted_body, expected.formattedBody); }
		await new RelayEventProjector(restarted, matrix).projectCheckpoint(envelope);
		assert.equal(requests.length, 2);
	});
}
