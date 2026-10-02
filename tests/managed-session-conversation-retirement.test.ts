import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ConversationRetirement } from "../config/agent/extensions/managed-sessions/relay/conversation-retirement.js";
import { RelayRegistry } from "../config/agent/extensions/managed-sessions/relay/registry.js";
import { ConversationManifestStore } from "../config/agent/extensions/managed-sessions/relay/manifest-store.js";
import { AtomicJsonFile } from "../config/agent/extensions/managed-sessions/relay/atomic-json.js";
import type { ManagedMatrixClient } from "../config/agent/extensions/managed-sessions/relay/matrix-client.js";
import { deriveCheckoutId } from "../config/agent/extensions/managed-sessions/managed-provenance.js";
import { deriveConversationId, deriveGenerationId, deriveTranscriptEntryId, type ConversationManifest } from "../config/agent/extensions/managed-sessions/contracts.js";

async function fixture(t: { after(fn: () => Promise<void>): void }, owned = true, roomless = false) {
	const root = await mkdtemp(join(tmpdir(), "conversation-retirement-")); let owner: ConversationRetirement | undefined;
	t.after(async () => { await owner?.close(); await rm(root, { recursive: true, force: true }); });
	const manifests = new ConversationManifestStore(join(root, "manifests")); const runtime = join(root, "runtime");
	const first: ConversationManifest = { schemaVersion: "1.0.0", ownerHostId: "host", kind: "project", conversationId: deriveConversationId("host", "first"), creationKey: "first",
		concept: "First", piSessionId: "session-first", roomId: "!first:example.com", placement: { rootKey: "projects", workspace: "workspace", relativeCwd: "" },
		bindingBoundaryEntryId: deriveTranscriptEntryId("session-first", "boundary"), createdAt: "2026-10-01T00:00:00.000Z" };
	const other = { ...first, conversationId: deriveConversationId("host", "other"), creationKey: "other", piSessionId: "session-other", bindingBoundaryEntryId: deriveTranscriptEntryId("session-other", "boundary"), roomId: "!other:example.com" };
	if (!roomless) await manifests.write(first); await manifests.write(other);
	const registry = new RelayRegistry("host", runtime, manifests); await registry.load();
	const nonce = "abcdefghijklmnopqrstuvwxyzABCDEF";
	if (roomless) {
		const { schemaVersion: _schema, roomId: _room, hostSpace: _host, projectSpace: _project, checkoutSpace: _checkout, ...local } = first;
		const generationId = deriveGenerationId(first.conversationId, 1); const projectKey = `project_${"1".repeat(32)}`;
		await registry.registerLocalConversation({ ...local, version: 1, kind: "project", placement: first.placement!, projectKey, projectDisplayName: "Project", checkoutDisplayName: "main",
			checkoutId: deriveCheckoutId("host", projectKey, join(root, "workspace")), activeGenerationId: generationId,
			generations: [{ generationId, ordinal: 1, piSessionId: first.piSessionId, bindingBoundaryEntryId: first.bindingBoundaryEntryId, createdAt: first.createdAt }] }, nonce, join(root, "source.jsonl"));
	} else await registry.setAttachmentNonce(first.conversationId, nonce);
	let attachment = await registry.attach({ protocolVersion: "1.0.0", role: "ordinary_adapter", type: "attachment.attach", messageId: "attach", conversationId: first.conversationId,
		payload: { sessionId: first.piSessionId, attachmentNonce: nonce, bindingBoundaryEntryId: first.bindingBoundaryEntryId, requestedCapabilities: ["local-enrollment-v1"] } }, "socket") as ReturnType<import("../config/agent/extensions/managed-sessions/relay/ipc-server.js").ManagedSessionIpcServer["attachment"]>;
	const proof = { conversationId: first.conversationId, serverId: `123:456:${"a".repeat(32)}`, launchId: `launch_${"b".repeat(32)}`, sessionName: "workspace", windowId: "@1", paneId: "%1", panePid: "789" };
	await registry.setManagedWindow(first.conversationId, { sessionName: proof.sessionName, windowId: proof.windowId, paneId: proof.paneId, ...(owned ? { ownership: proof } : {}) });
	const events: string[] = []; const state = { authenticated: true, accountAvailable: true, window: "match" as "match" | "gone" | "changed" };
	const observe = (name: string) => { assert.ok(registry.retirement(first.conversationId)); assert.equal(registry.registeredConversation(first.conversationId), undefined); events.push(name); };
	const matrix = { operatorUserId: "@operator:example.com", botUserId: "@bot:example.com",
		accountJoined: async (room: string) => { assert.equal(room, first.roomId); observe("bot-observe"); return true; },
		assertRoomAuthority: async (room: string, space: boolean) => { assert.equal(room, first.roomId); assert.equal(space, false); observe("bot-authority"); },
		leaveRoom: async (room: string) => { assert.equal(room, first.roomId); observe("bot-leave"); } } as unknown as ManagedMatrixClient;
	owner = new ConversationRetirement({ registry, matrix, matrixAuthenticated: () => state.authenticated,
		server: { attachment: () => attachment, sendToAttachment: (target, frame) => { assert.deepEqual(target, attachment); assert.equal(frame.type, "termination.request"); assert.equal(frame.payload.reason, "stop"); observe("native-stop"); return true; } },
		windows: { check: async (value) => { assert.deepEqual(value, proof); observe("window-check"); return state.window; },
			terminate: async (value) => { assert.deepEqual(value, proof); observe("window-stop"); state.window = "gone"; attachment = undefined; return true; } },
		account: { completed: async () => state.accountAvailable, leaveAndForget: async (target) => { assert.equal(target.roomId, first.roomId); observe("operator-leave"); return state.accountAvailable; } },
		cancelApprovals: () => observe("cancel-approvals") });
	return { root, runtime, manifests, registry, first, other, owner, events, state, disconnect: () => { attachment = undefined; } };
}

test("canonical retirement commits before effects, stops exact ownership and preserves unrelated resources", async (t) => {
	const f = await fixture(t); const resources = ["pi-session.jsonl", "project-file", "git-history"];
	for (const file of resources) await writeFile(join(f.root, file), `preserve ${file}`);
	await f.owner.retire(f.first.conversationId); await f.owner.drain();
	assert.equal(f.events[0], "cancel-approvals"); assert.ok(f.events.includes("window-stop"));
	assert.ok(f.registry.retirement(f.first.conversationId)); assert.equal(f.registry.retirement(f.first.conversationId)?.cleanup, undefined);
	assert.deepEqual(f.registry.retirementRoomIds(), []); assert.ok(f.registry.registeredConversation(f.other.conversationId));
	for (const file of resources) assert.equal(await readFile(join(f.root, file), "utf8"), `preserve ${file}`);
	const replacement = new RelayRegistry("host", f.runtime, f.manifests); await replacement.load();
	assert.equal(replacement.registeredConversation(f.first.conversationId), undefined); assert.ok(replacement.registeredConversation(f.other.conversationId));
});

test("local retirement proceeds offline but account effects wait for authenticated bot identity", async (t) => {
	const f = await fixture(t); f.state.authenticated = false;
	await f.owner.retire(f.first.conversationId); await f.owner.drain();
	assert.ok(f.events.includes("window-stop")); assert.ok(!f.events.some((event) => event.startsWith("bot-") || event === "operator-leave"));
	assert.deepEqual(f.registry.retirementRoomIds(), [f.first.roomId]);
	f.state.authenticated = true; f.state.accountAvailable = false; f.owner.kick(); await f.owner.drain();
	assert.ok(f.events.includes("bot-leave")); const completedEffects = f.events.filter((event) => event === "window-stop" || event === "bot-leave");
	f.state.accountAvailable = true; f.owner.kick(); await f.owner.drain();
	assert.deepEqual(f.events.filter((event) => event === "window-stop" || event === "bot-leave"), completedEffects);
	assert.ok(f.registry.retirement(f.first.conversationId)); assert.equal(f.registry.retirement(f.first.conversationId)?.cleanup, undefined);
});

test("changed or legacy window ownership remains visibly blocked without forced termination", async (t) => {
	for (const owned of [true, false]) {
		const f = await fixture(t, owned); f.state.window = "changed";
		await f.owner.retire(f.first.conversationId); await f.owner.drain();
		assert.equal(f.registry.retirement(f.first.conversationId)?.cleanup?.find((effect) => effect.kind === "stop")?.phase, "blocked");
		assert.ok(!f.events.includes("window-stop")); assert.ok(f.registry.registeredConversation(f.other.conversationId));
	}
});

test("frozen retirement plans cannot expand to changed window ownership", async (t) => {
	const f = await fixture(t); const plan = f.owner.prepare(f.first.conversationId); const window = f.registry.managedWindow(f.first.conversationId)!;
	await f.registry.setManagedWindow(f.first.conversationId, { ...window, windowId: "@2", ownership: { ...window.ownership!, windowId: "@2" } });
	await assert.rejects(f.owner.retirePrepared(plan), /stop target changed/);
	assert.equal(f.registry.retirement(f.first.conversationId), undefined); assert.deepEqual(f.events, []);
});

test("unresolved launch or room binding cannot become falsely complete when the known window disappears", async (t) => {
	for (const roomless of [false, true]) {
		const f = await fixture(t, true, roomless);
		if (!roomless) { f.disconnect(); await f.registry.markDormant(f.first.conversationId); await f.registry.beginLaunch(f.first.conversationId); }
		await f.owner.retire(f.first.conversationId); await f.owner.drain();
		assert.ok(f.events.includes("window-stop"));
		const stop = f.registry.retirement(f.first.conversationId)?.cleanup?.find((effect) => effect.kind === "stop");
		assert.equal(stop?.phase, "blocked"); if (stop?.kind === "stop") assert.ok(roomless ? stop.unresolvedBinding : stop.unresolvedLaunch);
	}
});

test("cleanup and cancellation survive a runtime projection failure after terminal commit", async (t) => {
	const f = await fixture(t); const write = AtomicJsonFile.prototype.write;
	AtomicJsonFile.prototype.write = async function (value: unknown) { if (this.path === join(f.runtime, "registry.json")) throw Error("Injected runtime write failure"); return write.call(this, value); };
	try { await assert.rejects(f.owner.retire(f.first.conversationId), /Injected runtime/); }
	finally { AtomicJsonFile.prototype.write = write; }
	await f.owner.drain(); assert.ok(f.events.includes("cancel-approvals")); assert.ok(f.events.includes("window-stop"));
	assert.ok(f.registry.retirement(f.first.conversationId)); assert.equal(f.registry.retirement(f.first.conversationId)?.cleanup, undefined);
});
