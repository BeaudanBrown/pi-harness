import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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
import { RecoveryAlerts } from "../config/agent/extensions/managed-sessions/relay/recovery-alerts.js";
import { RelayEventProjector } from "../config/agent/extensions/managed-sessions/relay/event-projector.js";
import { renderTranscript as renderLegacy } from "../config/agent/extensions/managed-sessions/relay/legacy-transcript-renderer.js";
import { transcriptContentHash } from "../config/agent/extensions/managed-sessions/relay/transcript-renderer.js";
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

function offer(piEntryKey: string, body: string, kind: "local_user" | "assistant_final" | "assistant_commentary" | "branch_marker" = "assistant_final"): ManagedSessionEnvelope {
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

test("production c65509a projected renderingVersion records survive upgrade without state loss or resend", async () => {
	const { root, store, registry } = await registryFixture();
	const state = registry.snapshot();
	state.conversations[0]!.projection = Array.from({ length: 107 }, (_, index) => {
		const entryId = deriveTranscriptEntryId(sessionId, `production-${index}`);
		return { entryId, kind: "assistant_final", status: "projected", renderingVersion: 2 as const,
			contentHash: transcriptContentHash("assistant_final", `answer ${index}`),
			chunks: [{ chunkId: deriveChunkId(entryId, 0), transactionId: deriveMatrixTransactionId(conversationId, entryId, 0), status: "sent" }] };
	});
	const path = join(root, "runtime", "registry.json");
	await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
	const before = await readFile(path);
	const restarted = new RelayRegistry(hostId, join(root, "runtime"), store); await restarted.load();
	assert.deepEqual(restarted.snapshot().conversations[0]!.projection, state.conversations[0]!.projection);
	assert.deepEqual(await readFile(path), before, "loading must not strip production metadata");
	let sends = 0;
	const matrix = new ManagedMatrixClient(matrixConfig, async () => { sends++; throw Error("completed projection must not resend"); }, [roomId]);
	await new TranscriptProjector(restarted, matrix).project(offer("production-106", "answer 106"));
	assert.equal(sends, 0);
});

test("branch markers are silent notices and replay exact transaction bytes after a lost acknowledgement", async () => {
	const { root, store, registry } = await registryFixture(); const sends: Array<{ url: string; body: string }> = [];
	const matrix = new ManagedMatrixClient(matrixConfig, async (url, init) => { sends.push({ url: String(url), body: String(init?.body) }); return Response.json({ event_id: "$branch" }); }, [roomId]);
	const marker = offer("branch-boundary", "Pi switched branches in this session. Earlier Matrix history is unchanged.", "branch_marker"); marker.payload.disposition = "silent";
	registry.markProjectionChunkSent = async () => { throw Error("lost acknowledgement"); };
	await assert.rejects(new TranscriptProjector(registry, matrix).project(marker), /lost acknowledgement/);
	const restarted = new RelayRegistry(hostId, join(root, "runtime"), store); await restarted.load(); await new TranscriptProjector(restarted, matrix).project(marker);
	assert.equal(sends.length, 2); assert.deepEqual(sends[0], sends[1]); const content = JSON.parse(sends[0]!.body);
	assert.equal(content.msgtype, "m.notice"); assert.deepEqual(content["m.mentions"], {}); assert.equal(content["lol.bepis.pi.notification"].disposition, "silent");
	await assert.rejects(new TranscriptProjector(restarted, matrix).project({ ...marker, payload: { ...marker.payload, disposition: "notify" } }), /Only final transcript/);
});

test("accepted recovery alert retries exact Matrix bytes after relay restart without another liveness decision", async () => {
	const { root, store, registry } = await registryFixture();
	const sends: Array<{ url: string; body: string }> = [];
	const matrix = new ManagedMatrixClient(matrixConfig, async (url, init) => {
		sends.push({ url: String(url), body: String(init?.body) }); return Response.json({ event_id: "$recovery" });
	}, [roomId]);
	const projector = new RelayEventProjector(registry, matrix);
	const path = join(root, "recovery-alerts.json");
	const alerts = new RecoveryAlerts(path, (alert) => projector.projectRecoveryAlert(alert));
	await alerts.load(); await alerts.outage([{ conversationId, piSessionId: sessionId, roomId }]); await alerts.healthy();
	await alerts.confirm(alerts.pending()[0]!, "checkpoint-current", () => true);
	registry.markProjectionChunkSent = async () => { throw Error("crash after Matrix acceptance"); };
	await assert.rejects(() => alerts.drain(), /retained/); await alerts.close();
	const restarted = new RelayRegistry(hostId, join(root, "runtime"), store); await restarted.load();
	const recovered = new RecoveryAlerts(path, (alert) => new RelayEventProjector(restarted, matrix).projectRecoveryAlert(alert));
	await recovered.load(); await recovered.drain(); await recovered.drain(); await recovered.close();
	assert.equal(sends.length, 2); assert.deepEqual(sends[0], sends[1]);
	assert.deepEqual(JSON.parse(sends[0]!.body)["m.mentions"], { room: true });
});

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

test("commentary requests silence and retries identical chunk payloads after a lost ack", async () => {
	const { root, store, registry } = await registryFixture();
	const sends: Array<{ url: string; body: string }> = [];
	const matrix = new ManagedMatrixClient(matrixConfig, async (input, init) => {
		sends.push({ url: String(input), body: String(init?.body) });
		return Response.json({ event_id: `$commentary-${sends.length}` });
	}, [roomId]);
	registry.markProjectionChunkSent = async () => { throw new Error("lost ack"); };
	const entry = offer("comment:text:0", "Visible progress. ".repeat(700), "assistant_commentary");
	await assert.rejects(() => new TranscriptProjector(registry, matrix).project(entry), /lost ack/);
	const restarted = new RelayRegistry(hostId, join(root, "runtime"), store);
	await restarted.load();
	await new TranscriptProjector(restarted, matrix).project(entry);
	assert.deepEqual(sends[0], sends[1]);
	assert.ok(sends.length >= 3, "fixture must exercise deterministic chunking");
	for (const sent of sends) {
		const content = JSON.parse(sent.body);
		assert.deepEqual(content["lol.bepis.pi.notification"], { version: 1, disposition: "silent" });
		assert.deepEqual(content["m.mentions"], {});
	}
	const count = sends.length;
	await new TranscriptProjector(restarted, matrix).project(entry);
	assert.equal(sends.length, count);
});

test("final notification disposition is frozen before send and only its first chunk notifies", async () => {
	const { root, store, registry } = await registryFixture();
	const sends: Array<{ url: string; body: string }> = [];
	const matrix = new ManagedMatrixClient(matrixConfig, async (input, init) => {
		sends.push({ url: String(input), body: String(init?.body) });
		return Response.json({ event_id: `$final-${sends.length}` });
	}, [roomId]);
	registry.markProjectionChunkSent = async () => { throw new Error("lost final ack"); };
	const entry = offer("final-notification", "Final answer. ".repeat(900));
	entry.payload.disposition = "notify";
	await assert.rejects(() => new TranscriptProjector(registry, matrix).project(entry), /lost final ack/);
	const restarted = new RelayRegistry(hostId, join(root, "runtime"), store);
	await restarted.load();
	await new TranscriptProjector(restarted, matrix).project(entry);
	assert.deepEqual(sends[0], sends[1], "accepted send is not silenced on retry");
	assert.deepEqual(JSON.parse(sends[0]!.body)["m.mentions"], { room: true });
	assert.ok(sends.slice(2).every((item) => JSON.parse(item.body)["lol.bepis.pi.notification"].disposition === "silent"));
	assert.equal(restarted.snapshot().conversations[0]!.projection[0]!.disposition, "notify");
	await assert.rejects(() => new TranscriptProjector(restarted, matrix).project({ ...entry, payload: { ...entry.payload, disposition: "silent" } }), /Conflicting transcript projection/);
	const local = offer("local-notification", "local text", "local_user"); local.payload.disposition = "notify";
	await assert.rejects(() => new TranscriptProjector(restarted, matrix).project(local), /Only final/);
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
