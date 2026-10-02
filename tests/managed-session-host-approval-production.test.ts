import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { BoundAdapterClient } from "../config/agent/extensions/managed-sessions/adapter/client.js";
import { NativeHostRun } from "../config/agent/extensions/managed-sessions/adapter/host-run.js";
import { deriveConversationId, deriveTranscriptEntryId, type ConversationManifest } from "../config/agent/extensions/managed-sessions/contracts.js";
import { deriveGenerationId } from "../config/agent/extensions/managed-sessions/v2-contracts.js";
import { ConversationManifestStore } from "../config/agent/extensions/managed-sessions/relay/manifest-store.js";
import { startManagedSessionRelay } from "../config/agent/extensions/managed-sessions/relay/main.js";
import { provisioningFixture } from "./fixtures/managed-matrix-provisioning.js";

test("production relay requires fresh native consent before committing self-retirement", { timeout: 15000 }, async (t) => {
	const peer = process.env.PI_MANAGED_SESSIONS_TEST_PEER_UID_HELPER;
	const lock = process.env.PI_MANAGED_SESSIONS_TEST_RELAY_LOCK_HELPER;
	if (!peer || !lock) return t.skip("packaged relay security helpers are unavailable");
	const root = await mkdtemp(join(tmpdir(), "approval-production-")); const hostId = `approval-${randomUUID()}`;
	const conversationId = deriveConversationId(hostId, "project"); const sessionId = randomUUID();
	const boundary = deriveTranscriptEntryId(sessionId, "boundary"); const nonce = "a".repeat(32);
	const manifest: ConversationManifest = { schemaVersion: "1.0.0", kind: "project", conversationId, ownerHostId: hostId,
		creationKey: "project", concept: "Approval target", piSessionId: sessionId, roomId: "!target:example.com",
		placement: { rootKey: "projects", workspace: "project", relativeCwd: "" }, bindingBoundaryEntryId: boundary, createdAt: new Date().toISOString() };
	await new ConversationManifestStore(join(root, "manifests")).write(manifest);
	const originalFetch = globalThis.fetch;
	const provision = provisioningFixture("@bot:example.com", { rooms: ["!host:example.com", "!coordinator:example.com"], createCalls: 0 });
	globalThis.fetch = async (input, init) => {
		const url = new URL(String(input));
		if (url.pathname.endsWith("/whoami")) return Response.json({ user_id: "@bot:example.com" });
		if (url.pathname.endsWith("/sync")) {
			if (!init?.signal?.aborted) await new Promise<void>((done) => init?.signal?.addEventListener("abort", () => done(), { once: true }));
			throw Object.assign(Error("aborted"), { name: "AbortError" });
		}
		if (url.pathname.includes("/send/")) return Response.json({ event_id: "$sent" });
		return await provision(input, init) ?? Response.json({});
	};
	let running: Awaited<ReturnType<typeof startManagedSessionRelay>> | undefined;
	let client: BoundAdapterClient | undefined; let native: NativeHostRun | undefined;
	t.after(async () => { native?.reset(); await client?.close(); await running?.stop(); globalThis.fetch = originalFetch; await rm(root, { recursive: true, force: true }); });
	running = await startManagedSessionRelay({
		PI_MANAGED_SESSIONS_RUNTIME_DIR: join(root, "runtime"), PI_MANAGED_SESSIONS_STATE_DIR: join(root, "state"),
		PI_MANAGED_SESSIONS_MANIFEST_DIR: join(root, "manifests"), PI_MANAGED_SESSIONS_HOST_ID: hostId,
		PI_MANAGED_SESSIONS_RESTART_GRACE_MS: "5000", PI_MANAGED_SESSIONS_PEER_UID_HELPER: peer, PI_MANAGED_SESSIONS_RELAY_LOCK_HELPER: lock,
		PI_MANAGED_HOST_ACTION_POLICY: resolve("config/agent/managed-host-policy.json"),
		PI_MANAGED_COORDINATOR_WORKSPACE_DIR: join(root, "coordinator"), PI_MANAGED_COORDINATOR_SESSION_FILE: join(root, "sessions", "coordinator.jsonl"),
		PI_MANAGED_COORDINATOR_LAUNCHER: "/not-invoked", PI_MATRIX_HOMESERVER: "https://matrix.example.com",
		PI_MATRIX_ACCESS_TOKEN: "fixture-token", PI_MATRIX_BOT_USER_ID: "@bot:example.com", PI_MATRIX_OPERATOR_USER_ID: "@operator:example.com",
	});
	await running.registry.setAttachmentNonce(conversationId, nonce);
	let decision!: (choice: boolean) => void; let prompts = 0;
	native = new NativeHostRun({ client: () => client, sources: () => [{ kind: "local" }], confirm: async (_question, signal) => {
		prompts++; return new Promise<boolean>((done) => { decision = done; signal.addEventListener("abort", () => done(false), { once: true }); });
	} });
	client = new BoundAdapterClient({ socketPath: running.server.socketPath, role: "ordinary_adapter", attachmentNonce: nonce,
		binding: { version: "1.0.0", conversationId, sessionId, concept: manifest.concept, bindingBoundaryEntryId: boundary, role: "ordinary_adapter" },
		requestedCapabilities: ["approval-v1"], onEnvelope: async (envelope) => { await native!.receive(envelope); } });
	await client.connect(); assert.equal(client.supports("approval-v1"), true);
	native.begin(deriveGenerationId(conversationId, 1)); native.userMessage(); native.toolStart("delete");
	const request = (requestId: string) => client!.requestHostAction({ ...native!.identity("delete")!, requestId,
		action: { operation: "conversation.delete", conversationId, confirmed: true } });
	const waitPrompt = async (count: number) => { for (let i = 0; i < 200 && prompts < count; i++) await new Promise((done) => setTimeout(done, 5)); assert.equal(prompts, count); };
	const denied = request("deny"); await waitPrompt(1); assert.equal(running.registry.retirement(conversationId), undefined); decision(false);
	const no = await denied; assert.equal(no.ok, false); if (!no.ok) assert.equal(no.error.code, "denied");
	assert.ok(running.registry.manifestByConversationId(conversationId));
	native.toolEnd("delete"); native.toolStart("delete");
	const approved = request("approve"); await waitPrompt(2); assert.equal(running.registry.retirement(conversationId), undefined); decision(true);
	const yes = await approved; assert.equal(yes.ok, true);
	assert.ok(running.registry.retirement(conversationId)); assert.equal(running.registry.manifestByConversationId(conversationId), undefined);
});
