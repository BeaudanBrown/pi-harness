import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MANAGED_SESSION_PROTOCOL_VERSION, deriveConversationId, deriveGenerationId, deriveTranscriptEntryId, parseManagedSessionEnvelope,
	parsePersistenceBundle, type HostRuntimeState, type PendingLocalConversation } from "../config/agent/extensions/managed-sessions/contracts.js";
import { deriveCheckoutId } from "../config/agent/extensions/managed-sessions/managed-provenance.js";
import { migrateV1Bundle } from "../config/agent/extensions/managed-sessions/v2-contracts.js";
import { ConversationManifestStore } from "../config/agent/extensions/managed-sessions/relay/manifest-store.js";
import { RelayRegistry } from "../config/agent/extensions/managed-sessions/relay/registry.js";

const hostId = "local-host"; const nonce = "n".repeat(32);
function local(creationKey = "one", ownerHostId = hostId): PendingLocalConversation {
	const conversationId = deriveConversationId(ownerHostId, creationKey); const sessionId = `session-${creationKey}`;
	const generationId = deriveGenerationId(conversationId, 1); const boundary = deriveTranscriptEntryId(sessionId, "boundary");
	const createdAt = "2026-10-01T00:00:00.000Z"; const projectKey = `project_${"1".repeat(32)}`;
	return { version: 1, kind: "project", conversationId, ownerHostId, creationKey, concept: "same label", piSessionId: sessionId,
		placement: { rootKey: "projects", workspace: "project", relativeCwd: "" }, projectKey, projectDisplayName: "Project", checkoutDisplayName: "main",
		checkoutId: deriveCheckoutId(ownerHostId, projectKey, "/work/project"), bindingBoundaryEntryId: boundary, createdAt, activeGenerationId: generationId,
		generations: [{ generationId, ordinal: 1, piSessionId: sessionId, bindingBoundaryEntryId: boundary, createdAt }] };
}
function attach(value: PendingLocalConversation, options: { nonce?: string; legacy?: boolean; role?: string } = {}) {
	return parseManagedSessionEnvelope({ protocolVersion: MANAGED_SESSION_PROTOCOL_VERSION, role: options.role ?? "ordinary_adapter", type: "attachment.attach",
		messageId: "attach-local", conversationId: value.conversationId, payload: { sessionId: value.piSessionId, bindingBoundaryEntryId: value.bindingBoundaryEntryId,
			attachmentNonce: options.nonce ?? nonce, ...(!options.legacy ? { requestedCapabilities: ["local-enrollment-v1"] } : {}) } });
}
async function fixture(t: { after: (callback: () => Promise<void>) => void }) {
	const root = await mkdtemp(join(tmpdir(), "local-enrollment-")); t.after(() => rm(root, { recursive: true, force: true }));
	const store = new ConversationManifestStore(join(root, "manifests")); const registry = new RelayRegistry(hostId, root, store); await registry.load();
	const value = local(); await registry.registerLocalConversation(value, nonce, join(root, "source.jsonl"));
	const binding = { roomId: "!conversation:example.com", projectSpace: "!project:example.com", checkoutSpace: "!checkout:example.com", checkoutId: value.checkoutId };
	return { root, store, registry, value, binding };
}

test("local enrollment is durable and attachable without any Matrix identity", async (t) => {
	const { root, store, registry, value } = await fixture(t);
	assert.equal(registry.manifestByConversationId(value.conversationId), undefined);
	assert.deepEqual(await store.list(), []); assert.deepEqual(registry.managedRoomIds(), []);
	assert.deepEqual(registry.localConversations(), [value]); assert.equal(Object.hasOwn(registry.localConversations()[0]!, "roomId"), false);
	await assert.rejects(() => registry.attach(attach(value, { legacy: true }), "legacy"), { code: "matrix_unavailable" });
	await assert.rejects(() => registry.attach(attach(value, { nonce: "x".repeat(32) }), "wrong"), { code: "invalid_nonce" });
	await assert.rejects(() => registry.attach(attach(value, { role: "coordinator_adapter" }), "role"), { code: "permission_denied" });
	await registry.attach(attach(value), "source"); assert.equal(registry.conversationState(value.conversationId), "active");
	const restarted = new RelayRegistry(hostId, root, store); await restarted.load(); restarted.beginRestartReconciliation();
	await restarted.attach(attach(value), "reconnected"); assert.equal(restarted.conversationState(value.conversationId), "active");
	assert.deepEqual(await store.list(), []);
	const migrated = migrateV1Bundle([], restarted.snapshot());
	assert.deepEqual(migrated.runtime.localConversations, [value]); assert.equal(migrated.runtime.conversations[0]?.activeGenerationId, value.activeGenerationId);
});

test("completion retains the active local attachment and nonce, and freezes exact verified bindings", async (t) => {
	const { registry, value, binding, store } = await fixture(t);
	await registry.attach(attach(value), "source"); const before = registry.snapshot().conversations;
	const bound = await registry.completeLocalBinding(value.conversationId, binding);
	assert.equal(bound.roomId, binding.roomId); assert.deepEqual(registry.localConversations(), []);
	assert.deepEqual(registry.snapshot().conversations, before); assert.equal(registry.isActiveGenerationAttached(value.conversationId), true);
	assert.deepEqual(await store.list(), [bound]);
	await assert.rejects(() => registry.completeLocalBinding(value.conversationId, { ...binding, roomId: "!other:example.com" }), /identity changed/);
	assert.deepEqual(await store.list(), [bound]);
});

test("local enrollment retries do not create another identity or rotate an active nonce", async (t) => {
	const { root, registry, value } = await fixture(t);
	await registry.registerLocalConversation(value, nonce, join(root, "source.jsonl"));
	await registry.registerLocalConversation(local("two"), nonce, join(root, "other.jsonl"));
	assert.equal(registry.localConversations().length, 2, "duplicate labels do not merge conversations");
	await registry.attach(attach(value), "source");
	await assert.rejects(() => registry.registerLocalConversation(value, "x".repeat(32), join(root, "source.jsonl")), { code: "invalid_nonce" });
	await assert.rejects(() => registry.registerLocalConversation(value, nonce, join(root, "different.jsonl")), /source Pi session/);
	await assert.rejects(() => registry.registerLocalConversation(local("coordinator"), nonce, join(root, "source.jsonl")), /protected/);
	await assert.rejects(() => registry.registerLocalConversation(local("foreign", "another-host"), nonce, join(root, "source.jsonl")), { code: "permission_denied" });
});

test("publication interruptions recover from the private verified receipt without replacing room IDs", async (t) => {
	for (const timing of ["before", "after"] as const) {
		const { root, registry, value, binding, store } = await fixture(t);
		const write = store.write.bind(store); let injected = false;
		store.write = async (manifest) => {
			if (!injected && timing === "before") { injected = true; throw Error("publication interrupted"); }
			await write(manifest);
			if (!injected) { injected = true; throw Error("publication interrupted"); }
		};
		await assert.rejects(() => registry.completeLocalBinding(value.conversationId, binding), /publication interrupted/);
		assert.equal(injected, true); assert.ok(registry.localConversations()[0]?.verifiedBinding);
		store.write = write;
		const restarted = new RelayRegistry(hostId, root, store); await restarted.load();
		const bound = await restarted.completeLocalBinding(value.conversationId, binding);
		assert.equal(bound.roomId, binding.roomId); assert.equal((await store.list()).length, 1); assert.deepEqual(restarted.localConversations(), []);
	}
});

test("private receipt and completion-cleanup interruptions are recoverable at both sides of each write", async (t) => {
	for (const phase of ["receipt", "cleanup"] as const) for (const timing of ["before", "after"] as const) {
		const { root, registry, value, binding, store } = await fixture(t);
		const file = (registry as unknown as { runtimeFile: { write: (state: HostRuntimeState) => Promise<void> } }).runtimeFile;
		const write = file.write.bind(file); let injected = false;
		file.write = async (state) => {
			const match = !injected && (phase === "receipt" ? Boolean(state.localConversations?.[0]?.verifiedBinding) : !state.localConversations);
			if (match && timing === "before") { injected = true; throw Error("private state interrupted"); }
			await write(state);
			if (match) { injected = true; throw Error("private state interrupted"); }
		};
		await assert.rejects(() => registry.completeLocalBinding(value.conversationId, binding), /private state interrupted/); assert.equal(injected, true);
		const restarted = new RelayRegistry(hostId, root, store); await restarted.load();
		await restarted.completeLocalBinding(value.conversationId, binding);
		assert.deepEqual(restarted.localConversations(), []); assert.equal((await store.list())[0]?.roomId, binding.roomId);
	}
});

test("a coincident public file cannot claim completion without the matching private receipt", async (t) => {
	const { registry, value, binding } = await fixture(t);
	const { version: _version, ...identity } = value;
	const unverified = { ...identity, schemaVersion: "1.0.0", ...binding };
	assert.throws(() => parsePersistenceBundle([unverified], registry.snapshot()), /verified Matrix binding identities differ/);
	await registry.completeLocalBinding(value.conversationId, binding);
	const pending = { ...value, verifiedBinding: { roomId: "!wrong:example.com", projectSpace: binding.projectSpace, checkoutSpace: binding.checkoutSpace } };
	assert.throws(() => parsePersistenceBundle([unverified], { ...registry.snapshot(), localConversations: [pending] }), /verified Matrix binding identities differ/);
});
