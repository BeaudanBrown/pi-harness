import assert from "node:assert/strict";
import { chmod, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import test from "node:test";
import {
	MANAGED_SESSION_PROTOCOL_VERSION,
	MANAGED_SESSION_STATE_VERSION,
	deriveChunkId,
	deriveConversationId,
	deriveDeliveryId,
	deriveMatrixTransactionId,
	deriveTranscriptEntryId,
	type ConversationManifest,
	type HostRuntimeState,
	type ManagedSessionEnvelope,
	parseHostRuntimeState,
} from "../config/agent/extensions/managed-sessions/contracts.js";
import { AtomicJsonFile, ensurePrivateDirectory } from "../config/agent/extensions/managed-sessions/relay/atomic-json.js";
import { ConversationManifestStore } from "../config/agent/extensions/managed-sessions/relay/manifest-store.js";
import { RelayRegistry, RelayRegistryError } from "../config/agent/extensions/managed-sessions/relay/registry.js";
import { ManagedMatrixClient } from "../config/agent/extensions/managed-sessions/relay/matrix-client.js";

const hostId = "test-host";
const nonce = "abcdefghijklmnopqrstuvwxyzABCDEF";

function manifest(creationKey = "work", kind: "project" | "coordinator" = "project"): ConversationManifest {
	const conversationId = deriveConversationId(hostId, creationKey);
	const base = {
		schemaVersion: MANAGED_SESSION_STATE_VERSION,
		kind,
		conversationId,
		ownerHostId: hostId,
		creationKey,
		concept: creationKey,
		piSessionId: `session-${creationKey}`,
		roomId: `!${creationKey}:example.com`,
		bindingBoundaryEntryId: deriveTranscriptEntryId(`session-${creationKey}`, "boundary"),
		createdAt: "2026-08-31T00:00:00.000Z",
	};
	return kind === "project" ? { ...base, kind, placement: { rootKey: "projects", workspace: creationKey, relativeCwd: "" } } : { ...base, kind };
}

function attach(value: ConversationManifest, role: "ordinary_adapter" | "coordinator_adapter", attachmentNonce = nonce): ManagedSessionEnvelope {
	return {
		protocolVersion: MANAGED_SESSION_PROTOCOL_VERSION,
		messageId: `attach-${value.creationKey}`,
		conversationId: value.conversationId,
		role,
		type: "attachment.attach",
		payload: {
			sessionId: value.piSessionId,
			attachmentNonce,
			bindingBoundaryEntryId: value.bindingBoundaryEntryId,
		},
	};
}

async function fixture(manifests = [manifest()]): Promise<{ root: string; store: ConversationManifestStore; registry: RelayRegistry }> {
	const root = await mkdtemp(join(tmpdir(), "pi-managed-registry-"));
	const store = new ConversationManifestStore(join(root, "manifests"));
	for (const value of manifests) await store.write(value);
	const registry = new RelayRegistry(hostId, join(root, "runtime"), store);
	await registry.load();
	return { root, store, registry };
}

test("atomic JSON keeps the last complete primary and rejects malformed primary state", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-managed-atomic-"));
	const directory = await ensurePrivateDirectory(join(root, "private"));
	assert.equal((await stat(directory)).mode & 0o777, 0o700);
	const path = join(directory, "state.json");
	const store = new AtomicJsonFile(path, parseHostRuntimeState);
	const valid: HostRuntimeState = { schemaVersion: MANAGED_SESSION_STATE_VERSION, hostId, conversations: [] };
	await store.write(valid);
	assert.equal((await stat(path)).mode & 0o777, 0o600);
	await writeFile(`${path}.interrupted.tmp`, "{", { mode: 0o600 });
	assert.deepEqual(await store.read(), valid);
	await writeFile(join(directory, "bad.json"), "{", { mode: 0o600 });
	const malformed = new AtomicJsonFile(join(directory, "bad.json"), parseHostRuntimeState);
	await assert.rejects(() => malformed.read(), /Malformed durable JSON/);
	await chmod(path, 0o644);
	await store.write(valid);
	assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test("registry enforces nonce, role, binding, and one live attachment per conversation", async () => {
	const value = manifest();
	const { registry } = await fixture([value]);
	await registry.setAttachmentNonce(value.conversationId, nonce);
	await assert.rejects(() => registry.attach(attach(value, "coordinator_adapter"), "wrong-role"), (error: unknown) => error instanceof RelayRegistryError && error.code === "permission_denied");
	await assert.rejects(() => registry.attach(attach(value, "ordinary_adapter", "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef"), "wrong-nonce"), (error: unknown) => error instanceof RelayRegistryError && error.code === "invalid_nonce");
	const accepted = await registry.attach(attach(value, "ordinary_adapter"), "connection-1");
	assert.equal(accepted.state, "active");
	await assert.rejects(() => registry.attach(attach(value, "ordinary_adapter"), "connection-2"), (error: unknown) => error instanceof RelayRegistryError && error.code === "attachment_conflict");
	await registry.detach("connection-1", accepted, accepted.attachmentId);
	assert.equal(registry.snapshot().conversations[0]?.state, "dormant");
});

test("token rotation changes only request authorization and preserves rooms, sessions, cursor, and projection state", async () => {
	const value = manifest(); const { root, store, registry } = await fixture([value]);
	await registry.setMatrixCursor(value.conversationId, "rotation-cursor");
	const entryId = deriveTranscriptEntryId(value.piSessionId, "rotation-final");
	await registry.recordProjection(value.conversationId, { entryId, kind: "assistant_final", status: "projected", chunks: [] });
	const authorizations: string[] = [];
	for (const accessToken of ["old-rotation-token", "new-rotation-token"]) {
		const client = new ManagedMatrixClient({ homeserver: "https://matrix.example.com", accessToken,
			botUserId: "@bot:example.com", operatorUserId: "@operator:example.com" }, async (_input, init) => {
			authorizations.push(new Headers(init?.headers).get("authorization") ?? ""); return Response.json({ user_id: "@bot:example.com" });
		}, [value.roomId]);
		assert.equal(await client.whoami(), "@bot:example.com");
		const restarted = new RelayRegistry(hostId, join(root, "runtime"), store); await restarted.load();
		assert.equal(restarted.manifestByConversationId(value.conversationId)?.roomId, value.roomId);
		assert.equal(restarted.manifestByConversationId(value.conversationId)?.piSessionId, value.piSessionId);
		assert.deepEqual(restarted.snapshot().conversations[0]?.matrixCursor, { status: "established", since: "rotation-cursor" });
		assert.equal(restarted.snapshot().conversations[0]?.projection[0]?.entryId, entryId);
	}
	assert.deepEqual(authorizations, ["Bearer old-rotation-token", "Bearer new-rotation-token"]);
});

test("restart preserves cursor, accepted input, projections, and permits nonce-authorized reattachment", async () => {
	const value = manifest();
	const { root, store, registry } = await fixture([value]);
	await registry.setAttachmentNonce(value.conversationId, nonce);
	const accepted = await registry.attach(attach(value, "ordinary_adapter"), "old-process");
	const deliveryId = deriveDeliveryId(value.conversationId, "$event");
	await registry.setMatrixCursor(value.conversationId, "cursor-1");
	await registry.recordAcceptedInput(value.conversationId, { deliveryId, matrixEventId: "$event", kind: "prompt", body: "hello", status: "accepted" });
	const entryId = deriveTranscriptEntryId(value.piSessionId, "answer");
	await registry.recordProjection(value.conversationId, {
		entryId,
		kind: "assistant_final",
		status: "projecting",
		chunks: [{ chunkId: deriveChunkId(entryId, 0), transactionId: deriveMatrixTransactionId(value.conversationId, entryId, 0), status: "pending" }],
	});
	assert.equal(accepted.state, "active");

	const restarted = new RelayRegistry(hostId, join(root, "runtime"), store);
	await restarted.load();
	restarted.beginRestartReconciliation();
	const before = restarted.snapshot().conversations[0]!;
	assert.deepEqual(before.matrixCursor, { status: "established", since: "cursor-1" });
	assert.equal(before.pendingInputs[0]?.body, "hello");
	assert.equal(before.projection[0]?.status, "projecting");
	const reattached = await restarted.attach(attach(value, "ordinary_adapter"), "new-process");
	assert.equal(reattached.state, "active");
	await restarted.finishRestartReconciliation();
	assert.equal(restarted.snapshot().conversations[0]?.state, "active");

	const unmatched = new RelayRegistry(hostId, join(root, "runtime"), store);
	await unmatched.load();
	unmatched.beginRestartReconciliation();
	await unmatched.finishRestartReconciliation();
	assert.equal(unmatched.snapshot().conversations[0]?.state, "dormant");
	assert.equal(unmatched.snapshot().conversations[0]?.attachment, null);
});
