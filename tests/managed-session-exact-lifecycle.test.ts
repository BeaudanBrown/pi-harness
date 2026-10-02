import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveConversationId, deriveTranscriptEntryId, type ConversationManifest } from "../config/agent/extensions/managed-sessions/contracts.js";
import type { ExactWindowProof } from "../config/agent/extensions/managed-sessions/exact-window-contracts.js";
import { ConversationRetirement } from "../config/agent/extensions/managed-sessions/relay/conversation-retirement.js";
import { HostLifecycle } from "../config/agent/extensions/managed-sessions/relay/host-lifecycle.js";
import { ConversationManifestStore } from "../config/agent/extensions/managed-sessions/relay/manifest-store.js";
import { RelayRegistry } from "../config/agent/extensions/managed-sessions/relay/registry.js";
import type { ManagedSessionIpcServer } from "../config/agent/extensions/managed-sessions/relay/ipc-server.js";
import type { ManagedMatrixClient } from "../config/agent/extensions/managed-sessions/relay/matrix-client.js";

async function fixture(t: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "exact-lifecycle-")); t.after(() => rm(root, { recursive: true, force: true }));
	const hostId = "host"; const conversationId = deriveConversationId(hostId, "project");
	const sessionId = `managed-${conversationId.slice(5)}`;
	const manifest: ConversationManifest = { schemaVersion: "1.0.0", kind: "project", ownerHostId: hostId, conversationId,
		creationKey: "project", concept: "Project", placement: { rootKey: "projects", workspace: "project", relativeCwd: "" },
		roomId: "!room:example.com", piSessionId: sessionId, createdAt: "2026-10-01T00:00:00.000Z",
		bindingBoundaryEntryId: deriveTranscriptEntryId(sessionId, `managed-boundary-${conversationId.slice(5)}`) };
	const manifests = new ConversationManifestStore(join(root, "manifests")); await manifests.write(manifest);
	let registry = new RelayRegistry(hostId, root, manifests); await registry.load();
	let proof: ExactWindowProof | undefined; let state: "match" | "gone" | "changed" = "gone";
	let attach = true; let unknownCreate = false; let invalidProof = false; let exits = true; let creates = 0;
	let beforeCreate: (() => Promise<void>) | undefined;
	const calls: string[] = [];
	const server = { attachment: () => undefined, sendToAttachment: () => true } as unknown as ManagedSessionIpcServer;
	const matrix = { operatorUserId: "@operator:example.com", botUserId: "@bot:example.com" } as ManagedMatrixClient;
	function owner() {
		const lifecycle = new HostLifecycle({ hostId, launcher: "/fixture", projectSessionDirectory: join(root, "sessions"), socketPath: join(root, "socket"),
			registry, server, matrix, attachmentTimeoutMs: 100 });
		(lifecycle as unknown as { invoke: (op: string, request: Record<string, unknown>, env?: NodeJS.ProcessEnv) => Promise<Record<string, unknown>> }).invoke = async (op, request, env = {}) => {
			calls.push(op);
			switch (op) {
				case "workspace-resolve": return { ...manifest.placement, cwd: root, workspacePath: root };
				case "root-ensure": return { sessionName: "project" };
				case "window-inspect-exact":
					if (state === "changed") throw Error("retained dead pane: close it manually");
					return { conversationId, exists: state === "match", ...(state === "match" ? { ownership: proof } : {}) };
				case "window-create-exact": {
					creates++;
					assert.equal(registry.launchIdentity(conversationId)?.launchId, request.launchId, "launch admission is durable before invocation");
					assert.equal(registry.launchIdentity(conversationId)?.observed, false);
					await beforeCreate?.();
					if (unknownCreate) throw Error("lost create response");
					proof = { conversationId, launchId: String(request.launchId), serverId: `123:456:${"a".repeat(32)}`, sessionName: "project",
						windowId: `@${creates}`, paneId: `%${creates}`, panePid: "789", processBootId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", processStartTicks: "123" };
					state = attach ? "match" : "changed";
					if (attach) await registry.attach({ protocolVersion: "1.0.0", messageId: "attach", conversationId, role: "ordinary_adapter", type: "attachment.attach",
						payload: { sessionId, attachmentNonce: env.PI_MANAGED_SESSION_ATTACHMENT_NONCE!, bindingBoundaryEntryId: manifest.bindingBoundaryEntryId } }, `connection-${creates}`);
					return { ...manifest.placement, conversationId, role: "conversation", sessionName: proof.sessionName, windowId: proof.windowId, paneId: proof.paneId, ownership: invalidProof ? { ...proof, processBootId: undefined } : proof };
				}
				case "window-check-exact": assert.deepEqual(request, proof); return { state };
				case "window-terminate-exact":
					assert.deepEqual(request, proof);
					if (exits) { state = "gone"; await registry.markDormant(conversationId); }
					return { terminated: true };
				default: throw Error(`Unexpected/legacy operation: ${op}`);
			}
		};
		return lifecycle;
	}
	return { manifest, owner, calls, server, matrix, get registry() { return registry; }, get creates() { return creates; },
		set attach(value: boolean) { attach = value; }, set unknownCreate(value: boolean) { unknownCreate = value; },
		set beforeCreate(value: () => Promise<void>) { beforeCreate = value; },
		set invalidProof(value: boolean) { invalidProof = value; },
		set exits(value: boolean) { exits = value; }, set state(value: typeof state) { state = value; },
		async reload() { registry = new RelayRegistry(hostId, root, manifests); await registry.load(); } };
}

function request(conversationId: string, operation: "conversation.stop" | "conversation.resume") {
	return { protocolVersion: "1.0.0" as const, messageId: "request", conversationId, role: "coordinator_adapter" as const, type: "lifecycle.request" as const,
		payload: { request: { operation, targetConversationId: conversationId } } };
}

test("normal launch persists exact ownership and stop verifies exit without legacy operations", async (t) => {
	const f = await fixture(t); const owner = f.owner();
	await Promise.all([owner.wake(f.manifest), owner.wake(f.manifest)]);
	assert.equal(f.creates, 1); assert.equal(f.registry.launchIdentity(f.manifest.conversationId)?.observed, true);
	assert.ok(f.registry.managedWindow(f.manifest.conversationId)?.ownership?.processBootId);
	await owner.request(request(f.manifest.conversationId, "conversation.stop"));
	assert.ok(f.registry.managedWindow(f.manifest.conversationId)?.ownership, "later retirement retains the exited process identity");
	assert.deepEqual(f.calls.slice(-3), ["window-check-exact", "window-terminate-exact", "window-check-exact"]);
	const retirement = new ConversationRetirement({ registry: f.registry, server: f.server, matrix: f.matrix, matrixAuthenticated: () => false, windows: owner.exactWindows });
	try {
		await retirement.retire(f.manifest.conversationId); await retirement.drain();
		assert.equal(f.registry.retirement(f.manifest.conversationId)?.cleanup?.find((effect) => effect.kind === "stop")?.phase, "done");
	} finally { await retirement.close(); }
});

test("a termination acknowledgement without exit retains the exact binding", async (t) => {
	const f = await fixture(t); const owner = f.owner(); await owner.wake(f.manifest); f.exits = false;
	const window = f.registry.managedWindow(f.manifest.conversationId);
	await assert.rejects(owner.request(request(f.manifest.conversationId, "conversation.stop")), /exit is unverified/);
	assert.deepEqual(f.registry.managedWindow(f.manifest.conversationId), window);
});

test("retained dead panes block retry until manual closure and verified original exit", async (t) => {
	const f = await fixture(t); const owner = f.owner(); f.attach = false;
	await assert.rejects(owner.wake(f.manifest), /dead pane/);
	const first = f.registry.managedWindow(f.manifest.conversationId);
	await assert.rejects(owner.wake(f.manifest), /dead pane/);
	assert.equal(f.creates, 1); assert.deepEqual(f.registry.managedWindow(f.manifest.conversationId), first);
	assert.ok(!f.calls.includes("window-terminate-exact"), "failed startup is not automatic cleanup consent");
	f.state = "gone"; f.attach = true;
	await owner.wake(f.manifest);
	assert.equal(f.creates, 2); assert.equal(f.registry.launchIdentity(f.manifest.conversationId)?.ordinal, 2);
	assert.notEqual(f.registry.managedWindow(f.manifest.conversationId)?.ownership?.launchId, first?.ownership?.launchId);
});

test("attachment cannot conceal a malformed creation proof", async (t) => {
	const f = await fixture(t); f.invalidProof = true;
	await assert.rejects(f.owner().wake(f.manifest), /identity|ownership|incomplete/);
	assert.equal(f.registry.managedWindow(f.manifest.conversationId), null);
	assert.equal(f.registry.launchIdentity(f.manifest.conversationId)?.observed, false);
});

test("a stop cannot join or overtake an admitted launch", async (t) => {
	const f = await fixture(t); const owner = f.owner();
	let entered!: () => void; const started = new Promise<void>((resolve) => { entered = resolve; });
	let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
	f.beforeCreate = async () => { entered(); await gate; };
	const waking = owner.wake(f.manifest);
	try { await started; await assert.rejects(owner.request(request(f.manifest.conversationId, "conversation.stop")), /Conflicting workspace operation/); }
	finally { release(); await waking; }
	assert.equal(f.creates, 1); assert.ok(!f.calls.includes("window-terminate-exact"));
});

test("lost creation response survives restart as a nonreplayed manual-inspection failure", async (t) => {
	const f = await fixture(t); f.unknownCreate = true;
	await assert.rejects(f.owner().wake(f.manifest), /lost create response/);
	const identity = f.registry.launchIdentity(f.manifest.conversationId);
	await f.reload(); f.unknownCreate = false;
	await assert.rejects(f.owner().wake(f.manifest), /inspection before retry/);
	assert.equal(f.creates, 1); assert.deepEqual(f.registry.launchIdentity(f.manifest.conversationId), identity);
	assert.equal(f.registry.retirementCandidate(f.manifest.conversationId).unresolvedLaunch, true);
});
