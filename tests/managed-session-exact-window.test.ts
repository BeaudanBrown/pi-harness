import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExactWindowClient } from "../config/agent/extensions/managed-sessions/relay/exact-window-client.js";
import { parseExactWindowProof, type ExactWindowProof } from "../config/agent/extensions/managed-sessions/exact-window-contracts.js";
import { deriveConversationId, deriveTranscriptEntryId, type ConversationManifest } from "../config/agent/extensions/managed-sessions/contracts.js";
import { ConversationManifestStore } from "../config/agent/extensions/managed-sessions/relay/manifest-store.js";
import { RelayRegistry } from "../config/agent/extensions/managed-sessions/relay/registry.js";

const hostId = "host"; const conversationId = deriveConversationId(hostId, "window");
const proof: ExactWindowProof = { conversationId, serverId: `123:456:${"a".repeat(32)}`, launchId: `launch_${"b".repeat(32)}`,
	sessionName: "workspace", windowId: "@1", paneId: "%2", panePid: "789" };

test("exact window client preserves frozen identity and never falls back to legacy termination", async () => {
	const calls: string[] = []; let accepted = false;
	const client = new ExactWindowClient(async (operation, request) => {
		calls.push(operation);
		if (operation === "window-inspect-exact") return { conversationId, exists: true, ownership: proof };
		assert.deepEqual(request, proof); return { terminated: accepted };
	});
	const observed = await client.inspect(conversationId); assert.deepEqual(observed, proof);
	assert.equal(await client.terminate(proof), false); accepted = true; assert.equal(await client.terminate(proof), true);
	assert.deepEqual(calls, ["window-inspect-exact", "window-terminate-exact", "window-terminate-exact"]);
	const unavailable = new ExactWindowClient(async () => { throw Error("unsupported launcher"); });
	await assert.rejects(unavailable.terminate(proof), /unsupported/);
});

test("exact observation distinguishes disappearance from changed ownership without mutating", async () => {
	for (const state of ["match", "gone", "changed"] as const) {
		const client = new ExactWindowClient(async (operation, request) => { assert.equal(operation, "window-check-exact"); assert.deepEqual(request, proof); return { state }; });
		assert.equal(await client.check(proof), state);
	}
	await assert.rejects(new ExactWindowClient(async () => ({ state: ["gone"] })).check(proof), /unknown/);
	await assert.rejects(new ExactWindowClient(async () => ({ state: "gone", extra: true })).check(proof), /unknown/);
	assert.throws(() => parseExactWindowProof({ ...proof, panePid: "2147483648" }));
	assert.throws(() => parseExactWindowProof({ ...proof, serverId: `2147483648:456:${"a".repeat(32)}` }));
});

test("exact creation binds the reserved launch and workspace to the returned ownership", async () => {
	const placement = { rootKey: "projects", workspace: "workspace", relativeCwd: "" };
	const reply = { ...placement, conversationId, sessionName: proof.sessionName, windowId: proof.windowId, paneId: proof.paneId, role: "conversation", ownership: proof };
	const client = new ExactWindowClient(async (operation, request) => {
		assert.equal(operation, "window-create-exact"); assert.deepEqual(request, { conversationId, launchId: proof.launchId, placement }); return reply;
	});
	assert.deepEqual(await client.create(conversationId, proof.launchId, placement), proof);
	for (const changed of [{ ...reply, workspace: "foreign" }, { ...reply, windowId: "@99" }, { ...reply, ownership: { ...proof, launchId: `launch_${"c".repeat(32)}` } }]) {
		await assert.rejects(new ExactWindowClient(async () => changed).create(conversationId, proof.launchId, placement), /reserved identity/);
	}
});

test("missing, foreign and malformed ownership cannot authorize exact stop", async () => {
	for (const field of Object.keys(proof)) { const missing = { ...proof } as Record<string, unknown>; delete missing[field]; assert.throws(() => parseExactWindowProof(missing)); }
	for (const value of [{ ...proof, windowId: "@1; kill-server" }, { ...proof, sessionName: "#{pid}" }, { ...proof, launchId: "legacy" }, { ...proof, extra: true }]) assert.throws(() => parseExactWindowProof(value));
	const legacy = new ExactWindowClient(async () => ({ conversationId, exists: true, windowId: "@1", paneId: "%2" }));
	await assert.rejects(legacy.inspect(conversationId), /invalid/);
	const foreign = new ExactWindowClient(async () => ({ conversationId, exists: true, ownership: { ...proof, conversationId: deriveConversationId(hostId, "other") } }));
	await assert.rejects(foreign.inspect(conversationId), /changed conversation/);
});

test("private runtime ownership survives reload and rejects a mismatched binding", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "exact-window-")); t.after(() => rm(root, { recursive: true, force: true }));
	const manifests = new ConversationManifestStore(join(root, "manifests"));
	const manifest: ConversationManifest = { schemaVersion: "1.0.0", kind: "project", ownerHostId: hostId, conversationId,
		creationKey: "window", concept: "Window", placement: { rootKey: "projects", workspace: "window", relativeCwd: "" }, roomId: "!room:example.com", piSessionId: "session",
		bindingBoundaryEntryId: deriveTranscriptEntryId("session", "boundary"), createdAt: "2026-10-01T00:00:00.000Z" };
	await manifests.write(manifest); const registry = new RelayRegistry(hostId, root, manifests); await registry.load();
	const window = { sessionName: proof.sessionName, windowId: proof.windowId, paneId: proof.paneId, ownership: proof };
	await registry.setManagedWindow(conversationId, window);
	await assert.rejects(registry.setManagedWindow(conversationId, { ...window, paneId: "%99" }), /ownership conflicts/);
	const recovered = new RelayRegistry(hostId, root, manifests); await recovered.load(); assert.deepEqual(recovered.managedWindow(conversationId), window);
	const accountTargets = [{ kind: "operator_leave_forget" as const, roomId: manifest.roomId, userId: "@operator:example.com" },
		{ kind: "bot_leave" as const, roomId: manifest.roomId, userId: "@bot:example.com" }];
	const stop = { kind: "stop" as const, generationId: recovered.activeGeneration(manifest).generationId, window };
	await assert.rejects(recovered.retireConversation(conversationId, [{ ...stop, window: { ...window, ownership: undefined } }, ...accountTargets]), /stop target changed/);
	const retired = await recovered.retireConversation(conversationId, [stop, ...accountTargets]);
	assert.deepEqual(retired.cleanup?.find((effect) => effect.kind === "stop")?.window?.ownership, proof);
});
