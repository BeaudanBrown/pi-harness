import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { requestSelfBind, BoundAdapterClient } from "../config/agent/extensions/managed-sessions/adapter/client.js";
import { MANAGED_SESSION_STATE_VERSION, deriveConversationId, deriveTranscriptEntryId } from "../config/agent/extensions/managed-sessions/contracts.js";
import { startManagedSessionRelay } from "../config/agent/extensions/managed-sessions/relay/main.js";
import type { SessionBinding } from "../config/agent/extensions/managed-sessions/adapter/state.js";

const nonce = "abcdefghijklmnopqrstuvwxyzABCDEF";

test("production relay self-binds, attaches, reports status, and deletes only bridge state", { timeout: 10_000 }, async (t) => {
	const peerUidHelper = process.env.PI_MANAGED_SESSIONS_TEST_PEER_UID_HELPER;
	const relayLockHelper = process.env.PI_MANAGED_SESSIONS_TEST_RELAY_LOCK_HELPER;
	if (!peerUidHelper || !relayLockHelper) return t.skip("packaged relay security helpers are unavailable");
	const root = await mkdtemp(join(tmpdir(), "pi-relay-adapter-"));
	const hostId = `host-${randomUUID()}`;
	const creationKey = "manual-production-bind";
	const conversationId = deriveConversationId(hostId, creationKey);
	const sessionId = "session-production-bind";
	const boundaryEntryId = deriveTranscriptEntryId(sessionId, "boundary");
	const originalFetch = globalThis.fetch;
	const requests: Array<{ path: string; authorization: string | null }> = [];
	let failLeave = false;
	globalThis.fetch = async (input, init) => {
		const url = new URL(String(input));
		requests.push({ path: url.pathname, authorization: new Headers(init?.headers).get("authorization") });
		if (url.pathname.endsWith("/whoami")) return Response.json({ user_id: "@bot:example.com" });
		if (url.pathname.endsWith("/createRoom")) return Response.json({ room_id: "!production:example.com" });
		if (url.pathname.endsWith("/leave") && failLeave) return new Response("temporary", { status: 503 });
		return Response.json({});
	};
	let running: Awaited<ReturnType<typeof startManagedSessionRelay>> | undefined;
	t.after(async () => {
		globalThis.fetch = originalFetch;
		await running?.stop();
		await rm(root, { recursive: true, force: true });
	});
	running = await startManagedSessionRelay({
		PI_MANAGED_SESSIONS_RUNTIME_DIR: join(root, "runtime"),
		PI_MANAGED_SESSIONS_MANIFEST_DIR: join(root, "manifests"),
		PI_MANAGED_SESSIONS_HOST_ID: hostId,
		PI_MANAGED_SESSIONS_RESTART_GRACE_MS: "5000",
		PI_MANAGED_SESSIONS_PEER_UID_HELPER: peerUidHelper,
		PI_MANAGED_SESSIONS_RELAY_LOCK_HELPER: relayLockHelper,
		PI_MATRIX_HOMESERVER: "https://matrix.example.com",
		PI_MATRIX_ACCESS_TOKEN: "test-token-never-in-ipc",
		PI_MATRIX_BOT_USER_ID: "@bot:example.com",
		PI_MATRIX_OPERATOR_USER_ID: "@operator:example.com",
	});
	assert.equal(await requestSelfBind({
		socketPath: running.server.socketPath,
		role: "ordinary_adapter",
		creationKey,
		concept: "production work",
		sessionId,
		attachmentNonce: nonce,
		bindingBoundaryEntryId: boundaryEntryId,
		placement: { rootKey: "projects", workspace: "work", relativeCwd: "" },
	}), conversationId);
	const binding: SessionBinding = {
		version: MANAGED_SESSION_STATE_VERSION,
		conversationId,
		concept: "production work",
		sessionId,
		bindingBoundaryEntryId: boundaryEntryId,
		role: "ordinary_adapter",
	};
	const client = new BoundAdapterClient({
		socketPath: running.server.socketPath,
		role: "ordinary_adapter",
		attachmentNonce: nonce,
		binding,
		onEnvelope: () => undefined,
	});
	await client.connect();
	assert.equal((await client.selfStatus()).payload.conversationState, "active");
	failLeave = true;
	await assert.rejects(() => client.selfDelete(), /Relay operation failed/);
	assert.equal(running.registry.snapshot().conversations.length, 1, "failed Matrix leave must restore relay persistence and attachment");
	failLeave = false;
	await new Promise((resolve) => setTimeout(resolve, 25));
	const retryClient = new BoundAdapterClient({
		socketPath: running.server.socketPath, role: "ordinary_adapter", attachmentNonce: nonce, binding, onEnvelope: () => undefined,
	});
	await retryClient.connect();
	assert.equal((await retryClient.selfDelete()).payload.status, "ok");
	await retryClient.close("bridge_delete");
	assert.deepEqual(running.registry.snapshot().conversations, []);
	assert.deepEqual(requests.map((request) => request.path), [
		"/_matrix/client/v3/account/whoami",
		"/_matrix/client/v3/createRoom",
		"/_matrix/client/v3/rooms/!production%3Aexample.com/leave",
		"/_matrix/client/v3/rooms/!production%3Aexample.com/leave",
	]);
	assert.ok(requests.every((request) => request.authorization === "Bearer test-token-never-in-ipc"));
});
