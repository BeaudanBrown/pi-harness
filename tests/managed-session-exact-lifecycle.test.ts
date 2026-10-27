import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test, { type TestContext } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { HostControlServer } from "../config/agent/extensions/managed-sessions/relay/host-control-server.js";
import { HostDispatcher } from "../config/agent/extensions/managed-sessions/relay/host-dispatcher.js";
import { ManagedHostMutationOwner } from "../config/agent/extensions/managed-sessions/relay/host-mutation-owner.js";
import { prepareHostApproval, type ModelHostRequest } from "../config/agent/extensions/managed-sessions/relay/host-approval-record.js";
import { HostPolicy } from "../config/agent/extensions/managed-sessions/relay/host-policy.js";
import { savedSessionKey } from "../config/agent/extensions/managed-sessions/live-workspace-contracts.js";
import { requestHostControl } from "../config/agent/extensions/managed-sessions/relay/host-control-client.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveConversationId, deriveGenerationId, deriveTranscriptEntryId, type ConversationManifest } from "../config/agent/extensions/managed-sessions/contracts.js";
import type { ExactWindowProof } from "../config/agent/extensions/managed-sessions/exact-window-contracts.js";
import { ConversationRetirement } from "../config/agent/extensions/managed-sessions/relay/conversation-retirement.js";
import { LiveHierarchy } from "../config/agent/extensions/managed-sessions/relay/live-hierarchy.js";
import { HostLifecycle, durableProjectSession } from "../config/agent/extensions/managed-sessions/relay/host-lifecycle.js";
import { ConversationManifestStore } from "../config/agent/extensions/managed-sessions/relay/manifest-store.js";
import { RelayRegistry } from "../config/agent/extensions/managed-sessions/relay/registry.js";
import type { ManagedSessionIpcServer } from "../config/agent/extensions/managed-sessions/relay/ipc-server.js";
import type { ManagedMatrixClient } from "../config/agent/extensions/managed-sessions/relay/matrix-client.js";

async function fixture(t: TestContext, roomless: boolean | "fresh" = false, creationKeyForRoot: (root: string) => string = () => "project") {
	const root = await mkdtemp(join(tmpdir(), "exact-lifecycle-")); t.after(() => rm(root, { recursive: true, force: true }));
	const hostId = "host"; const creationKey = creationKeyForRoot(root); const conversationId = deriveConversationId(hostId, creationKey);
	const sessionId = `managed-${conversationId.slice(5)}`;
	const manifest: ConversationManifest = { schemaVersion: "1.0.0", kind: "project", ownerHostId: hostId, conversationId,
		creationKey, concept: "Project", placement: { rootKey: "projects", workspace: "project", relativeCwd: "" },
		roomId: "!room:example.com", piSessionId: sessionId, createdAt: "2026-10-01T00:00:00.000Z",
		bindingBoundaryEntryId: deriveTranscriptEntryId(sessionId, `managed-boundary-${conversationId.slice(5)}`) };
	const manifests = new ConversationManifestStore(join(root, "manifests"));
	if (!roomless) {
		await durableProjectSession(join(root, "sessions", conversationId, "session.jsonl"), root, conversationId, manifest.creationKey, manifest.concept);
		await manifests.write(manifest);
	}
	let registry = new RelayRegistry(hostId, root, manifests); await registry.load();
	if (roomless === true) {
		const session = await durableProjectSession(join(root, "sessions", conversationId, "session.jsonl"), root, conversationId, manifest.creationKey, manifest.concept);
		const { schemaVersion: _schema, roomId: _room, hostSpace: _hostSpace, projectSpace: _projectSpace, checkoutSpace: _checkoutSpace, ...identity } = manifest;
		const generationId = deriveGenerationId(conversationId, 1);
		await registry.registerOwnedLocalConversation({ ...identity, version: 1, kind: "project", placement: manifest.placement!,
			projectKey: `project_${"1".repeat(32)}`, projectDisplayName: "Project", checkoutDisplayName: "main", checkoutId: `checkout_${"2".repeat(32)}`,
			activeGenerationId: generationId, generations: [{ generationId, ordinal: 1, piSessionId: session.sessionId,
				bindingBoundaryEntryId: session.boundaryEntryId, createdAt: manifest.createdAt }] }, "n".repeat(32));
	}
	let proof: ExactWindowProof | undefined; let state: "match" | "gone" | "changed" = "gone";
	let inspectError = false;
	let attach = true; let retainedAlive = false; let unknownCreate = false; let invalidProof = false; let exits = true; let creates = 0;
	let beforeCreate: (() => Promise<void>) | undefined;
	let beforeCheck: (() => Promise<void>) | undefined;
	let launchNonce: string | undefined;
	const calls: string[] = [];
	const server = { attachment: () => undefined, sendToAttachment: () => true } as unknown as ManagedSessionIpcServer;
	const matrix = { operatorUserId: "@operator:example.com", botUserId: "@bot:example.com" } as ManagedMatrixClient;
	const hierarchy = roomless === "fresh" ? new LiveHierarchy(join(root, "hierarchy"), hostId, matrix, () => undefined) : undefined;
	if (hierarchy) { await hierarchy.load(); t.after(() => hierarchy.close()); }
	function owner() {
		const lifecycle = new HostLifecycle({ hostId, launcher: "/fixture", projectSessionDirectory: join(root, "sessions"), socketPath: join(root, "socket"),
			registry, server, matrix, hierarchy, attachmentTimeoutMs: 100 });
		(lifecycle as unknown as { invoke: (op: string, request: Record<string, unknown>, env?: NodeJS.ProcessEnv) => Promise<Record<string, unknown>> }).invoke = async (op, request, env = {}) => {
			calls.push(op);
			switch (op) {
				case "workspace-resolve": return { ...manifest.placement, cwd: root, workspacePath: root,
					projectKey: `project_${"1".repeat(32)}`, projectDisplayName: "Project", checkoutDisplayName: "main" };
				case "worktree-create-preview": return { rootKey: "projects", sourceWorkspace: "source", projectWorkspace: "source", targetWorkspace: "project",
					commonDir: join(root, ".git"), mainPath: root, targetPath: root, baseRef: "refs/heads/main", baseCommit: "a".repeat(40), branch: "topic" };
				case "worktree-create-apply": return { rootKey: "projects", workspace: "project", branch: "topic", baseCommit: "a".repeat(40) };
				case "root-resolve": return { sessionName: "project" };
				case "window-inspect-exact":
					if (inspectError) throw Error("tmux server cannot be contacted");
					if (state === "changed") throw Error("retained dead pane: close it manually");
					return { conversationId, exists: state === "match", ...(state === "match" ? { ownership: proof } : {}) };
				case "window-create-exact": {
					creates++; launchNonce = env.PI_MANAGED_SESSION_ATTACHMENT_NONCE;
					assert.equal(registry.launchIdentity(conversationId)?.launchId, request.launchId, "launch admission is durable before invocation");
					assert.equal(registry.launchIdentity(conversationId)?.observed, false);
					await beforeCreate?.();
					if (unknownCreate) throw Error("lost create response");
					proof = { conversationId, launchId: String(request.launchId), serverId: `123:456:${"a".repeat(32)}`, sessionName: "project",
						windowId: `@${creates}`, paneId: `%${creates}`, panePid: "789", processBootId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", processStartTicks: "123" };
					state = attach || retainedAlive ? "match" : "changed";
					if (attach) await registry.attach({ protocolVersion: "1.0.0", messageId: "attach", conversationId, role: "ordinary_adapter", type: "attachment.attach",
						payload: { sessionId, attachmentNonce: env.PI_MANAGED_SESSION_ATTACHMENT_NONCE!, bindingBoundaryEntryId: manifest.bindingBoundaryEntryId, ...(roomless ? { requestedCapabilities: ["local-enrollment-v1"] } : {}) } }, `connection-${creates}`);
					return { ...manifest.placement, conversationId, role: "conversation", sessionName: proof.sessionName, windowId: proof.windowId, paneId: proof.paneId, ownership: invalidProof ? { ...proof, processBootId: undefined } : proof };
				}
				case "window-check-exact": assert.deepEqual(request, proof); await beforeCheck?.(); return { state };
				case "window-terminate-exact":
					assert.deepEqual(request, proof);
					if (exits) { state = "gone"; await registry.markDormant(conversationId); }
					return { terminated: true };
				default: throw Error(`Unexpected/legacy operation: ${op}`);
			}
		};
		return lifecycle;
	}
	return { root, manifest, owner, calls, server, matrix, get registry() { return registry; }, get creates() { return creates; },
		set inspectError(value: boolean) { inspectError = value; },
		set attach(value: boolean) { attach = value; }, set retainedAlive(value: boolean) { retainedAlive = value; }, set unknownCreate(value: boolean) { unknownCreate = value; },
		set beforeCreate(value: () => Promise<void>) { beforeCreate = value; },
		set beforeCheck(value: () => Promise<void>) { beforeCheck = value; },
		set invalidProof(value: boolean) { invalidProof = value; },
		set exits(value: boolean) { exits = value; }, set state(value: typeof state) { state = value; },
		async attachNow() {
			await registry.attach({ protocolVersion: "1.0.0", messageId: "late-attach", conversationId, role: "ordinary_adapter", type: "attachment.attach",
				payload: { sessionId, attachmentNonce: launchNonce!, bindingBoundaryEntryId: manifest.bindingBoundaryEntryId, ...(roomless ? { requestedCapabilities: ["local-enrollment-v1"] } : {}) } }, `connection-${creates}`);
		},
		async reload() { registry = new RelayRegistry(hostId, root, manifests); await registry.load(); } };
}

function request(conversationId: string, operation: "conversation.stop" | "conversation.resume") {
	return { protocolVersion: "1.0.0" as const, messageId: "request", conversationId, role: "coordinator_adapter" as const, type: "lifecycle.request" as const,
		payload: { request: { operation, targetConversationId: conversationId } } };
}

test("registered conversations with missing history fail closed without recreating a session or window", async t => {
	const f = await fixture(t); const path = join(f.root, "sessions", f.manifest.conversationId, "session.jsonl");
	await rm(path);
	await assert.rejects(f.owner().openConversation(f.manifest.conversationId), /persisted Pi session file is unavailable/);
	assert.equal(f.creates, 0);
	await assert.rejects(readFile(path), { code: "ENOENT" });
});

test("saved-session open fences its generation before effects and after asynchronous observation", async t => {
	const f = await fixture(t); const owner = f.owner(); const id = f.manifest.conversationId;
	const generation = deriveGenerationId(id, 1);
	await assert.rejects(owner.openConversation(id, deriveGenerationId(id, 2)), /generation changed/);
	assert.deepEqual(f.calls, []); assert.equal(f.creates, 0);
	await owner.openConversation(id, generation);
	assert.equal(f.registry.conversationMetadata()[0].sessionId, f.manifest.piSessionId);
	f.beforeCheck = async () => {
		const transition = await f.registry.beginGenerationTransition(id, `control_${"3".repeat(32)}`, {});
		await f.registry.recordGenerationSession(id, transition.transitionId, { sessionId: "new-generation", boundaryEntryId: deriveTranscriptEntryId("new-generation", "boundary") });
		await f.registry.activateGeneration(id, transition.transitionId);
	};
	await assert.rejects(owner.openConversation(id, generation), /generation changed/);
	assert.equal(f.creates, 1);
});

test("fresh hierarchy-backed start persists and launches locally while Matrix bootstrap is unavailable", async t => {
	const f = await fixture(t, "fresh"); const owner = f.owner();
	const start = { ...request(f.manifest.conversationId, "conversation.resume"), payload: { request: {
		operation: "conversation.start" as const, creationKey: f.manifest.creationKey, concept: f.manifest.concept, placement: f.manifest.placement! } } };
	await Promise.all([owner.request(start), owner.request(start)]);
	assert.equal(f.creates, 1); assert.equal(f.registry.conversationState(f.manifest.conversationId), "active");
	assert.equal(f.registry.manifestByConversationId(f.manifest.conversationId), undefined);
	assert.equal(f.registry.hasOwnedLocalSeed(f.manifest.conversationId), true);
	assert.equal(f.registry.localConversations().length, 1);
	await assert.rejects(owner.completeLocalEnrollment(f.manifest.conversationId), /Host Space provisioning is pending/);
	assert.equal(f.registry.conversationState(f.manifest.conversationId), "active");
	const sessionFile = join(f.root, "sessions", f.manifest.conversationId, "session.jsonl");
	const history = await readFile(sessionFile, "utf8");
	await owner.request(start);
	assert.equal(f.creates, 1); assert.equal(await readFile(sessionFile, "utf8"), history);
});

test("import admission requires the selected durable native identity before registration or launch", async t => {
	const f = await fixture(t, "fresh"); const owner = f.owner(); const id = f.manifest.conversationId;
	const action = { operation: "conversation.create" as const, creationKey: f.manifest.creationKey, title: f.manifest.concept,
		placement: f.manifest.placement!, expectedSessionKey: savedSessionKey("host", f.manifest.piSessionId) };
	const sessionFile = join(f.root, "sessions", id, "session.jsonl");
	await assert.rejects(owner.executeCreation(action, await owner.freezeCreation(action)), /persisted Pi session file is unavailable/);
	await assert.rejects(readFile(sessionFile), { code: "ENOENT" }); assert.equal(f.creates, 0); assert.equal(f.registry.localConversations().length, 0);
	await durableProjectSession(sessionFile, f.root, id, action.creationKey, action.title);
	const bytes = await readFile(sessionFile, "utf8"), wrong = { ...action, expectedSessionKey: savedSessionKey("host", "other") };
	await assert.rejects(owner.executeCreation(wrong, await owner.freezeCreation(wrong)), /Imported session identity changed/);
	assert.equal(f.creates, 0); assert.equal(f.registry.localConversations().length, 0);
	const frozen = await owner.freezeCreation(action);
	await Promise.all([owner.executeCreation(action, frozen), owner.executeCreation(action, frozen)]);
	assert.equal(f.creates, 1); assert.equal(f.registry.hasOwnedLocalSeed(id), true); assert.equal(await readFile(sessionFile, "utf8"), bytes);
	await owner.executeCreation(action, await owner.freezeCreation(action)); assert.equal(f.creates, 1);
	await assert.rejects(owner.executeCreation(wrong, await owner.freezeCreation(wrong)), /Imported session identity changed/);
	await rm(sessionFile);
	await assert.rejects(owner.executeCreation(action, await owner.freezeCreation(action)), /persisted Pi session file is unavailable/);
	assert.equal(f.creates, 1);
});

test("owned roomless open and resume share one exact launch before independent Matrix binding", async t => {
	const f = await fixture(t, true); const owner = f.owner();
	const sessionFile = join(f.root, "sessions", f.manifest.conversationId, "session.jsonl");
	const history = await readFile(sessionFile, "utf8");
	const [first, second, ready] = await Promise.all([owner.openConversation(f.manifest.conversationId),
		owner.openConversation(f.manifest.conversationId), owner.resumeConversation(f.manifest.conversationId)]);
	assert.deepEqual(first, second); assert.equal(first.launchId, ready.launchId); assert.equal(f.creates, 1);
	assert.equal(f.registry.conversationState(f.manifest.conversationId), "active");
	assert.equal(f.registry.manifestByConversationId(f.manifest.conversationId), undefined);
	assert.equal(f.registry.localConversations().length, 1);
	const window = f.registry.managedWindow(f.manifest.conversationId);
	await f.registry.completeLocalBinding(f.manifest.conversationId, { roomId: "!later:example.com", projectSpace: "!project:example.com",
		checkoutSpace: "!checkout:example.com", checkoutId: `checkout_${"2".repeat(32)}` });
	assert.deepEqual(await owner.openConversation(f.manifest.conversationId), first);
	assert.deepEqual(f.registry.managedWindow(f.manifest.conversationId), window);
	assert.equal(f.creates, 1); assert.equal(await readFile(sessionFile, "utf8"), history);
});

test("roomless launch refuses missing durable seed instead of fabricating history", async t => {
	const f = await fixture(t, true);
	const sessionFile = join(f.root, "sessions", f.manifest.conversationId, "session.jsonl");
	await rm(sessionFile);
	await assert.rejects(f.owner().openConversation(f.manifest.conversationId));
	await assert.rejects(readFile(sessionFile), { code: "ENOENT" });
	assert.equal(f.creates, 0); assert.equal(f.registry.launchIdentity(f.manifest.conversationId), undefined);
});

test("roomless open requires origin proof before resolving or touching its session", async t => {
	const f = await fixture(t, true);
	const state = f.registry.snapshot(); delete state.conversations[0].ownedLocalLaunch;
	await writeFile(join(f.root, "registry.json"), JSON.stringify(state)); await f.reload();
	await assert.rejects(f.owner().openConversation(f.manifest.conversationId), /durable owned-seed authority/);
	assert.deepEqual(f.calls, []); assert.equal(f.creates, 0);
});

test("roomless launch uncertainty survives restart without a second create", async t => {
	const f = await fixture(t, true); f.unknownCreate = true;
	await assert.rejects(f.owner().openConversation(f.manifest.conversationId), /lost create response/);
	assert.equal(f.creates, 1);
	await f.reload(); f.unknownCreate = false;
	await assert.rejects(f.owner().openConversation(f.manifest.conversationId), /unobserved|unresolved|unknown|inspect/i);
	assert.equal(f.creates, 1);
});

test("private host controls create, open, stop, resume and retire owned roomless work without Matrix", async t => {
	const f = await fixture(t, "fresh"); const lifecycle = f.owner(); const id = f.manifest.conversationId;
	const historyPath = join(f.root, "sessions", id, "session.jsonl");
	const retirement = new ConversationRetirement({ registry: f.registry, server: f.server, matrix: f.matrix,
		matrixAuthenticated: () => false, windows: lifecycle.exactWindows });
	const mutations = new ManagedHostMutationOwner({ registry: f.registry, lifecycle, retirement, server: f.server });
	const dispatcher = new HostDispatcher({ hostId: "host", protectedConversationId: deriveConversationId("host", "coordinator"),
		policy: new HostPolicy(JSON.parse(await readFile("config/agent/managed-host-policy.json", "utf8"))),
		read: async () => { throw Error("not used"); }, humanMutation: input => mutations.executeHuman(input) });
	const server = new HostControlServer({ runtimeDirectory: join(f.root, "control"), expectedUid: process.getuid!(), peerUid: () => process.getuid!(), dispatcher });
	await server.start();
	try {
		const created = await requestHostControl({ socketPath: server.socketPath, requestId: "create", action: { operation: "conversation.create",
			creationKey: f.manifest.creationKey, title: f.manifest.concept, placement: f.manifest.placement! } });
		assert.equal(created.ok, true, JSON.stringify(created));
		if (created.ok) assert.equal(created.data.setupState, "pending");
		const history = await readFile(historyPath, "utf8");
		const opened = await requestHostControl({ socketPath: server.socketPath, requestId: "open", action: { operation: "conversation.open", conversationId: id } });
		assert.equal(opened.ok, true, JSON.stringify(opened));
		const stopped = await requestHostControl({ socketPath: server.socketPath, requestId: "stop", action: { operation: "conversation.stop", conversationId: id } });
		assert.equal(stopped.ok, true, JSON.stringify(stopped));
		assert.equal(f.registry.conversationState(id), "dormant"); assert.ok(f.registry.managedWindow(id)?.ownership);
		const resumed = await requestHostControl({ socketPath: server.socketPath, requestId: "resume", action: { operation: "conversation.resume", conversationId: id } });
		assert.equal(resumed.ok, true, JSON.stringify(resumed)); assert.equal(f.creates, 2);
		assert.equal(f.registry.manifestByConversationId(id), undefined);
		const deleted = await requestHostControl({ socketPath: server.socketPath, requestId: "retire", action: { operation: "conversation.delete", conversationId: id, confirmed: true } });
		assert.equal(deleted.ok, true, JSON.stringify(deleted)); await retirement.drain();
		assert.ok(f.registry.retirement(id));
		const stop = f.registry.retirement(id)?.cleanup?.find(effect => effect.kind === "stop");
		assert.equal(stop?.phase, "blocked", "unresolved provisioning is not falsely reported as completed cleanup");
		await assert.rejects(lifecycle.openConversation(id)); assert.equal(f.creates, 2);
		assert.equal(await readFile(historyPath, "utf8"), history);
	} finally { await server.close(); await retirement.close(); }
});

test("bundled worktree conversation creation returns local success without inventing a pending room link", async t => {
	const digest = (domain: string, ...parts: string[]) => {
		const hash = createHash("sha256").update(`pi-managed-sessions:${domain}:v1\0`);
		for (const part of parts) hash.update(`${Buffer.byteLength(part)}:`).update(part);
		return hash.digest("hex").slice(0, 32);
	};
	const f = await fixture(t, "fresh", root => `worktree-conversation-${digest("worktree-conversation",
		`worktree_${digest("worktree", "host", "projects", join(root, ".git"), "topic")}`, "Project")}`);
	const lifecycle = f.owner();
	const result = await lifecycle.request({ ...request(f.manifest.conversationId, "conversation.resume"), payload: { request: {
		operation: "worktree.conversation.create", creationKey: "new-worktree", rootKey: "projects", workspace: "source", baseRef: "main", branch: "topic", concept: "Project" } } });
	assert.equal(result.targetConversationId, f.manifest.conversationId);
	assert.equal(result.conversationState, "active"); assert.equal("roomLink" in result, false);
	assert.equal(f.registry.manifestByConversationId(f.manifest.conversationId), undefined);
	assert.equal(f.registry.hasOwnedLocalSeed(f.manifest.conversationId), true); assert.equal(f.creates, 1);
	await assert.rejects(lifecycle.completeLocalEnrollment(f.manifest.conversationId), /Host Space provisioning is pending/);
	assert.equal(f.registry.conversationState(f.manifest.conversationId), "active");
});

test("roomless binding completion invalidates frozen process-control consent", async t => {
	const f = await fixture(t, true); const lifecycle = f.owner(); const id = f.manifest.conversationId;
	await lifecycle.resumeConversation(id);
	const retirement = new ConversationRetirement({ registry: f.registry, server: f.server, matrix: f.matrix, matrixAuthenticated: () => false, windows: lifecycle.exactWindows });
	try {
		const mutations = new ManagedHostMutationOwner({ registry: f.registry, lifecycle, retirement, server: f.server });
		const input: ModelHostRequest = { version: "1.0.0", actor: { kind: "model", requestId: "stop", conversationId: id,
			generationId: deriveGenerationId(id, 1), runId: "run", toolCallId: "tool", presentation: "local_dialog" },
			action: { operation: "conversation.stop", conversationId: id } };
		const record = prepareHostApproval("host", input, await mutations.freeze(input), Date.now());
		assert.equal(await mutations.revalidate(record), true);
		await f.registry.completeLocalBinding(id, { roomId: "!later:example.com", projectSpace: "!project:example.com", checkoutSpace: "!checkout:example.com", checkoutId: `checkout_${"2".repeat(32)}` });
		assert.equal(await mutations.revalidate(record), false);
		await assert.rejects(mutations.execute(record), /Frozen targets/);
		assert.ok(!f.calls.includes("window-terminate-exact")); assert.equal(f.registry.conversationState(id), "active");
	} finally { await retirement.close(); }
});

test("roomless failed attachment can be explicitly stopped only after proven process exit", async t => {
	const f = await fixture(t, true); const lifecycle = f.owner(); const id = f.manifest.conversationId;
	f.attach = false; f.retainedAlive = true;
	await assert.rejects(lifecycle.resumeConversation(id), /timed out/);
	f.exits = false;
	await assert.rejects(lifecycle.stopConversation(id), /exit is unverified/);
	f.exits = true;
	await lifecycle.stopConversation(id);
	assert.equal(f.registry.conversationState(id), "dormant"); assert.ok(f.registry.managedWindow(id)?.ownership);
	assert.equal(f.creates, 1);
});

test("roomless controls do not reinterpret unproven registration as owned process authority", async t => {
	const f = await fixture(t, true); const id = f.manifest.conversationId;
	const state = f.registry.snapshot(); delete state.conversations[0].ownedLocalLaunch;
	await writeFile(join(f.root, "registry.json"), JSON.stringify(state)); await f.reload(); const lifecycle = f.owner();
	assert.throws(() => lifecycle.stopConversation(id), /durable owned-seed authority/);
	await assert.rejects(lifecycle.refreshApproved(id), /durable owned-seed authority/);
	assert.deepEqual(f.calls, []);
});

test("roomless dormant refresh preserves history and binding identity", async t => {
	const f = await fixture(t, true); const lifecycle = f.owner(); const id = f.manifest.conversationId;
	await lifecycle.resumeConversation(id); await lifecycle.stopConversation(id);
	const file = join(f.root, "sessions", id, "session.jsonl"); const history = await readFile(file, "utf8");
	const result = await lifecycle.refreshApproved(id);
	assert.equal(result.launchState, "attached"); assert.equal(f.creates, 2);
	assert.equal(f.registry.manifestByConversationId(id), undefined); assert.equal(f.registry.hasOwnedLocalSeed(id), true);
	assert.equal(await readFile(file, "utf8"), history);
});

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

test("open returns the window while concurrent resume keeps observing one launch", async (t) => {
	const f = await fixture(t); f.attach = false; f.retainedAlive = true; const owner = f.owner();
	const opening = owner.openConversation(f.manifest.conversationId);
	let settled = false;
	const resuming = owner.wake(f.manifest).finally(() => { settled = true; });
	const failed = assert.rejects(resuming, /timed out/);
	const [first, second] = await Promise.all([opening, owner.openConversation(f.manifest.conversationId)]);
	assert.deepEqual(first, second); assert.equal(first.launchState, "window_created");
	assert.equal(first.window.windowId, "@1"); assert.equal(f.creates, 1); assert.equal(settled, false);
	await assert.rejects(owner.request(request(f.manifest.conversationId, "conversation.stop")), /Conflicting workspace operation/);
	await failed;
	assert.match(f.registry.snapshot().conversations[0]!.lastLaunchError!.message, /timed out/);
	assert.ok(!f.calls.includes("window-terminate-exact"));
});

test("open and resume join a matching start but conflicting creation arguments do not", async (t) => {
	const f = await fixture(t); f.attach = false; f.retainedAlive = true; const owner = f.owner();
	const envelope = { ...request(f.manifest.conversationId, "conversation.resume"), payload: { request: {
		operation: "conversation.start", creationKey: f.manifest.creationKey, concept: f.manifest.concept, placement: f.manifest.placement! } } };
	const starting = owner.request(envelope);
	const failed = assert.rejects(starting, /timed out/);
	const target = await owner.openConversation(f.manifest.conversationId);
	assert.equal(target.launchState, "window_created");
	await assert.rejects(owner.request({ ...envelope, payload: { request: { ...envelope.payload.request, concept: "different" } } }), /Conflicting/);
	await failed; assert.equal(f.creates, 1);
});

test("resume succeeds only after the opened instance attaches", async (t) => {
	const f = await fixture(t); f.attach = false; f.retainedAlive = true; const owner = f.owner();
	const opening = owner.openConversation(f.manifest.conversationId);
	let ready = false; const resuming = owner.resumeConversation(f.manifest.conversationId).then((value) => { ready = true; return value; });
	const target = await opening; assert.equal(ready, false);
	await f.attachNow(); const resumed = await resuming;
	assert.equal(resumed.launchState, "attached"); assert.equal(resumed.launchId, target.launchId); assert.equal(f.creates, 1);
});

test("IPC open disconnect does not cancel readiness and a missing relay is typed unavailable", async (t) => {
	const f = await fixture(t); f.attach = false; f.retainedAlive = true; const owner = f.owner();
	const dispatcher = new HostDispatcher({ hostId: "host", protectedConversationId: deriveConversationId("host", "coordinator"),
		policy: new HostPolicy(JSON.parse(await readFile("config/agent/managed-host-policy.json", "utf8"))),
		read: async () => { throw Error("not used"); }, launch: (action) => action.operation === "conversation.open"
			? owner.openConversation(action.conversationId) : owner.resumeConversation(action.conversationId) });
	const server = new HostControlServer({ runtimeDirectory: join(f.root, "control"), expectedUid: process.getuid!(), peerUid: () => process.getuid!(), dispatcher });
	await server.start();
	try {
		const response = await requestHostControl({ socketPath: server.socketPath, requestId: "open", action: { operation: "conversation.open", conversationId: f.manifest.conversationId } });
		assert.equal(response.ok, true); if (response.ok) assert.equal(response.data.launchState, "window_created");
		await assert.rejects(owner.wake(f.manifest), /timed out/);
		assert.match(f.registry.snapshot().conversations[0]!.lastLaunchError!.message, /timed out/); assert.equal(f.creates, 1);
	} finally { await server.close(); }
	const offline = await requestHostControl({ socketPath: server.socketPath, requestId: "offline", action: { operation: "conversation.open", conversationId: f.manifest.conversationId } });
	assert.equal(offline.ok, false); if (!offline.ok) assert.equal(offline.error.code, "unavailable");
});

test("active open revalidates its exact target without restarting", async (t) => {
	const f = await fixture(t); const owner = f.owner(); await owner.wake(f.manifest);
	assert.equal((await owner.openConversation(f.manifest.conversationId)).launchState, "attached");
	assert.equal(f.creates, 1);
	f.state = "changed";
	await assert.rejects(owner.openConversation(f.manifest.conversationId), /disappeared or changed/);
	f.state = "gone";
	await assert.rejects(owner.openConversation(f.manifest.conversationId), /disappeared or changed/);
	assert.equal(f.creates, 1);
});

test("open cannot publish a launch that retirement overtook", async (t) => {
	const f = await fixture(t); const owner = f.owner();
	const retirement = new ConversationRetirement({ registry: f.registry, server: f.server, matrix: f.matrix, matrixAuthenticated: () => false, windows: owner.exactWindows });
	f.beforeCreate = async () => { await retirement.retire(f.manifest.conversationId); };
	try {
		await assert.rejects(owner.openConversation(f.manifest.conversationId), /retired/);
		assert.ok(f.registry.retirement(f.manifest.conversationId));
		assert.equal(f.registry.manifestByConversationId(f.manifest.conversationId), undefined);
	} finally { await retirement.close(); }
});

test("first-server creation needs no placeholder and later inspection failure requires proven exit", async (t) => {
	const f = await fixture(t); const owner = f.owner(); f.inspectError = true;
	await owner.wake(f.manifest); assert.equal(f.creates, 1);
	assert.ok(!f.calls.includes("window-inspect-exact")); assert.ok(!f.calls.includes("root-ensure"));
	await f.registry.markDormant(f.manifest.conversationId);
	await assert.rejects(owner.wake(f.manifest), /server cannot be contacted/); assert.equal(f.creates, 1);
	f.state = "gone"; await owner.wake(f.manifest); assert.equal(f.creates, 2);
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

test("direct resume persists attachment timeout without destroying its window or replaying creation", async (t) => {
	const f = await fixture(t); f.attach = false; f.retainedAlive = true;
	await assert.rejects(f.owner().request(request(f.manifest.conversationId, "conversation.resume")), /timed out/);
	const window = f.registry.managedWindow(f.manifest.conversationId); assert.ok(window?.ownership);
	await f.reload();
	assert.match(f.registry.snapshot().conversations.find((item) => item.conversationId === f.manifest.conversationId)!.lastLaunchError!.message, /timed out/);
	assert.deepEqual(f.registry.managedWindow(f.manifest.conversationId), window); assert.equal(f.creates, 1);
	assert.ok(!f.calls.includes("window-terminate-exact"));
	f.state = "gone"; f.attach = true; await f.owner().wake(f.manifest); assert.equal(f.creates, 2);
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
