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
	deriveTranscriptEntryId,
	type ConversationManifest,
	type ManagedSessionEnvelope,
} from "../config/agent/extensions/managed-sessions/contracts.js";
import { ConversationManifestStore } from "../config/agent/extensions/managed-sessions/relay/manifest-store.js";
import { ManagedMatrixClient } from "../config/agent/extensions/managed-sessions/relay/matrix-client.js";
import { RelayRegistry } from "../config/agent/extensions/managed-sessions/relay/registry.js";
import { TranscriptProjector } from "../config/agent/extensions/managed-sessions/relay/transcript-projector.js";

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
