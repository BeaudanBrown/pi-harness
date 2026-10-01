import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RelayRegistry } from "../config/agent/extensions/managed-sessions/relay/registry.js";
import { ConversationManifestStore } from "../config/agent/extensions/managed-sessions/relay/manifest-store.js";
import { AtomicJsonFile } from "../config/agent/extensions/managed-sessions/relay/atomic-json.js";
import { deriveConversationId, deriveGenerationId, deriveTranscriptEntryId, type ConversationManifest, type ManagedSessionEnvelope } from "../config/agent/extensions/managed-sessions/contracts.js";
import type { RetirementTarget } from "../config/agent/extensions/managed-sessions/relay/retirement-store.js";

const nonce = "abcdefghijklmnopqrstuvwxyzABCDEF";
function manifest(key: string): ConversationManifest {
	return { schemaVersion: "1.0.0", ownerHostId: "host", kind: key === "coordinator" ? "coordinator" : "project", conversationId: deriveConversationId("host", key), creationKey: key,
		concept: key, piSessionId: `session-${key}`, roomId: `!${key}:example.com`, placement: { rootKey: "projects", workspace: key, relativeCwd: "" },
		bindingBoundaryEntryId: deriveTranscriptEntryId(`session-${key}`, "boundary"), createdAt: "2026-10-01T00:00:00.000Z" };
}
async function fixture(t: { after(fn: () => Promise<void>): void }) {
	const root = await mkdtemp(join(tmpdir(), "retired-registry-")); t.after(() => rm(root, { recursive: true, force: true }));
	const manifests = new ConversationManifestStore(join(root, "manifests")); const first = manifest("first"); const other = manifest("other");
	await manifests.write(first); await manifests.write(other); const runtime = join(root, "runtime");
	const registry = new RelayRegistry("host", runtime, manifests); await registry.load(); await registry.setAttachmentNonce(first.conversationId, nonce);
	const packet: ManagedSessionEnvelope = { protocolVersion: "1.0.0", role: "ordinary_adapter", type: "attachment.attach", messageId: "attach", conversationId: first.conversationId,
		payload: { sessionId: first.piSessionId, attachmentNonce: nonce, bindingBoundaryEntryId: first.bindingBoundaryEntryId } };
	const attachment = await registry.attach(packet, "socket");
	const targets: RetirementTarget[] = [{ kind: "stop", generationId: deriveGenerationId(first.conversationId, 1), attachmentId: attachment.attachmentId },
		{ kind: "operator_leave_forget", roomId: first.roomId }, { kind: "bot_leave", roomId: first.roomId }];
	return { root, runtime, manifests, first, other, registry, targets, packet, attachment };
}

test("retirement removes ordinary discovery and rejects stale nonce, attachment, creation and restore paths", async (t) => {
	const f = await fixture(t); const before = f.registry.snapshot();
	await writeFile(join(f.root, "transcript.jsonl"), "preserve transcript\n");
	const retired = await f.registry.retireConversation(f.first.conversationId, f.targets);
	assert.equal(retired.cleanup?.length, 3); assert.equal(f.registry.registeredConversation(f.first.conversationId), undefined);
	assert.deepEqual(f.registry.conversationMetadata().map((item) => item.conversationId), [f.other.conversationId]);
	assert.equal(f.registry.pendingRetirements().length, 1);
	await assert.rejects(f.registry.setAttachmentNonce(f.first.conversationId, nonce)); await assert.rejects(f.registry.attach(f.packet, "stale-socket"));
	assert.throws(() => f.registry.assertAuthorized({ ...f.packet, type: "self.status", payload: {} }, "socket", f.attachment));
	await assert.rejects(f.registry.createProjectConversation(f.first, nonce), /retired/);
	await assert.rejects(f.registry.restoreDeletedConversation({ manifest: f.first, runtime: before.conversations.find((item) => item.conversationId === f.first.conversationId)! }), /retired/);
	assert.equal(await readFile(join(f.root, "transcript.jsonl"), "utf8"), "preserve transcript\n");
	// Simulate restoration of an old runtime file while permanent tombstones survive.
	await writeFile(join(f.runtime, "registry.json"), JSON.stringify(before));
	const replacement = new RelayRegistry("host", f.runtime, f.manifests); await replacement.load();
	assert.equal(replacement.manifestByConversationId(f.first.conversationId), undefined); assert.equal(replacement.listConversations().length, 1);
	assert.throws(() => replacement.manifestByCreationKey(f.first.creationKey), /retired/);
	assert.equal(replacement.pendingRetirements()[0].retirementId, retired.retirementId);
});

test("runtime write failure after terminal commit cannot roll back retirement in memory or after restart", async (t) => {
	const f = await fixture(t); const write = AtomicJsonFile.prototype.write;
	AtomicJsonFile.prototype.write = async function (value: unknown) {
		if (this.path === join(f.runtime, "registry.json")) throw Error("Injected runtime failure after tombstone");
		return write.call(this, value);
	};
	try { await assert.rejects(f.registry.retireConversation(f.first.conversationId, f.targets), /Injected runtime/); }
	finally { AtomicJsonFile.prototype.write = write; }
	assert.equal(f.registry.registeredConversation(f.first.conversationId), undefined); assert.equal(f.registry.retirement(f.first.conversationId)?.cleanup?.length, 3);
	const replacement = new RelayRegistry("host", f.runtime, f.manifests); await replacement.load();
	assert.equal(replacement.listConversations().length, 1); await assert.rejects(replacement.createProjectConversation(f.first, nonce), /retired/);
});

test("wrong stop generation, missing account obligation or foreign room cannot establish retirement", async (t) => {
	const f = await fixture(t);
	for (const targets of [f.targets.slice(0, 1), f.targets.map((target) => target.kind === "stop" ? { ...target, generationId: deriveGenerationId(f.first.conversationId, 2) } : target),
		f.targets.map((target) => target.kind === "bot_leave" ? { ...target, roomId: "!foreign:example.com" } : target)]) {
		await assert.rejects(f.registry.retireConversation(f.first.conversationId, targets));
		assert.equal(f.registry.retirement(f.first.conversationId), undefined); assert.ok(f.registry.registeredConversation(f.first.conversationId));
	}
});
