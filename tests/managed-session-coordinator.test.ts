import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	MANAGED_SESSION_PROTOCOL_VERSION,
	MANAGED_SESSION_STATE_VERSION,
	deriveConversationId,
	type ConversationManifest,
} from "../config/agent/extensions/managed-sessions/contracts.js";
import { bootstrapCoordinator } from "../config/agent/extensions/managed-sessions/relay/coordinator-bootstrap.js";
import { launchCoordinator } from "../config/agent/extensions/managed-sessions/relay/coordinator-launcher.js";
import { CoordinatorRouter } from "../config/agent/extensions/managed-sessions/relay/coordinator-router.js";
import { ConversationManifestStore } from "../config/agent/extensions/managed-sessions/relay/manifest-store.js";
import { ManagedMatrixClient } from "../config/agent/extensions/managed-sessions/relay/matrix-client.js";
import { RelayRegistry } from "../config/agent/extensions/managed-sessions/relay/registry.js";
import { startManagedSessionRelay } from "../config/agent/extensions/managed-sessions/relay/main.js";
import type { ManagedSessionIpcServer } from "../config/agent/extensions/managed-sessions/relay/ipc-server.js";

const hostId = "coordinator-host";
const matrixConfig = {
	homeserver: "https://matrix.example.com", accessToken: "secret", botUserId: "@bot:example.com", operatorUserId: "@operator:example.com",
};

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "pi-coordinator-"));
	const workspaceDirectory = join(root, "workspace");
	const sessionFile = join(root, "sessions", "coordinator.jsonl");
	const store = new ConversationManifestStore(join(root, "manifests"));
	const registry = new RelayRegistry(hostId, join(root, "runtime"), store);
	await registry.load();
	return { root, workspaceDirectory, sessionFile, store, registry };
}

function matrixFetch(sessionFile: string, state: { rooms: string[]; createCalls: number; inaccessibleRoom?: string }): typeof fetch {
	return async (input) => {
		const url = new URL(String(input));
		if (url.pathname.endsWith("/createRoom")) {
			assert.ok((await readFile(sessionFile, "utf8")).startsWith('{"type":"session"'), "Pi session must exist before Matrix binding");
			state.createCalls += 1;
			const roomId = state.rooms.shift();
			if (!roomId) throw new Error("unexpected room creation");
			return Response.json({ room_id: roomId });
		}
		if (url.pathname.includes("/state/m.room.create/")) {
			if (state.inaccessibleRoom && url.pathname.includes(encodeURIComponent(state.inaccessibleRoom))) return new Response("forbidden", { status: 403 });
			return Response.json({ creator: matrixConfig.botUserId });
		}
		return Response.json({});
	};
}

test("coordinator bootstrap persists Pi first, creates its private Space/room, and self-heals only the room", async () => {
	const value = await fixture();
	const state = { rooms: ["!space:example.com", "!coordinator:example.com"], createCalls: 0, inaccessibleRoom: undefined as string | undefined };
	const matrix = new ManagedMatrixClient(matrixConfig, matrixFetch(value.sessionFile, state));
	const first = await bootstrapCoordinator(hostId, {
		workspaceDirectory: value.workspaceDirectory, sessionFile: value.sessionFile, concept: "host coordinator",
	}, value.registry, matrix);
	assert.equal(first.manifest.kind, "coordinator");
	assert.equal(first.manifest.hostSpace, "!space:example.com");
	assert.equal(state.createCalls, 2);
	assert.equal((await stat(value.sessionFile)).mode & 0o777, 0o600);
	assert.match(await readFile(join(value.workspaceDirectory, "AGENTS.md"), "utf8"), /neutral workspace/);
	const originalSession = await readFile(value.sessionFile, "utf8");

	await chmod(value.sessionFile, 0o644);
	const restarted = new RelayRegistry(hostId, join(value.root, "runtime"), value.store);
	await restarted.load();
	const same = await bootstrapCoordinator(hostId, {
		workspaceDirectory: value.workspaceDirectory, sessionFile: value.sessionFile, concept: "host coordinator",
	}, restarted, matrix);
	assert.equal(same.manifest.roomId, first.manifest.roomId);
	assert.equal((await stat(value.sessionFile)).mode & 0o777, 0o600, "existing coordinator session permissions are repaired");
	assert.equal(state.createCalls, 2, "accessible coordinator room is reused");

	state.inaccessibleRoom = first.manifest.roomId;
	state.rooms.push("!replacement:example.com");
	const healed = await bootstrapCoordinator(hostId, {
		workspaceDirectory: value.workspaceDirectory, sessionFile: value.sessionFile, concept: "host coordinator",
	}, restarted, matrix);
	assert.equal(healed.manifest.roomId, "!replacement:example.com");
	assert.equal(healed.manifest.piSessionId, first.manifest.piSessionId);
	assert.equal(healed.manifest.hostSpace, first.manifest.hostSpace);
	assert.equal(await readFile(value.sessionFile, "utf8"), originalSession);
	await assert.rejects(() => bootstrapCoordinator(hostId, {
		workspaceDirectory: value.workspaceDirectory, sessionFile: value.sessionFile, concept: "renamed coordinator",
	}, restarted, matrix), /coordinator.*identity|Existing coordinator/);

	const unsafe = await fixture();
	const target = join(unsafe.root, "target.jsonl");
	await writeFile(target, originalSession, { mode: 0o600 });
	await mkdir(join(unsafe.root, "sessions"), { recursive: true });
	await symlink(target, unsafe.sessionFile);
	await assert.rejects(() => bootstrapCoordinator(hostId, {
		workspaceDirectory: unsafe.workspaceDirectory, sessionFile: unsafe.sessionFile, concept: "host coordinator",
	}, unsafe.registry, new ManagedMatrixClient(matrixConfig, matrixFetch(unsafe.sessionFile, { rooms: [], createCalls: 0 }))), /non-symlink/);

	const foreign = await fixture();
	await mkdir(join(foreign.root, "sessions"), { recursive: true });
	await writeFile(foreign.sessionFile, originalSession.replace('"creationKey":"coordinator"', '"creationKey":"project"'), { mode: 0o600 });
	await assert.rejects(() => bootstrapCoordinator(hostId, {
		workspaceDirectory: foreign.workspaceDirectory, sessionFile: foreign.sessionFile, concept: "host coordinator",
	}, foreign.registry, new ManagedMatrixClient(matrixConfig, matrixFetch(foreign.sessionFile, { rooms: [], createCalls: 0 }))), /bootstrap identity/);
});

test("coordinator launcher receives only fixed host configuration and records exact default window IDs", async () => {
	const value = await fixture();
	const conversationId = deriveConversationId(hostId, "coordinator");
	const manifest: ConversationManifest = {
		schemaVersion: MANAGED_SESSION_STATE_VERSION, kind: "coordinator", conversationId, ownerHostId: hostId,
		creationKey: "coordinator", concept: "host coordinator", piSessionId: "session-coordinator", roomId: "!coordinator:example.com",
		bindingBoundaryEntryId: "entry_00000000000000000000000000000000", createdAt: "2026-08-31T00:00:00.000Z",
		selectedModel: "local-llm/coordinator",
	};
	await value.registry.createCoordinatorConversation(manifest);
	await assert.rejects(() => value.registry.deleteConversation(conversationId), /cannot be deleted/);
	const launcher = join(value.root, "launcher");
	await writeFile(launcher, `#!${process.env.PI_TEST_SHELL ?? "/bin/sh"}\nset -eu\ncase "$2" in\nwindow-inspect) cat >/dev/null; printf '{"conversationId":"${conversationId}","exists":false}\\n';;\ncoordinator-ensure) grep -F '"conversationId":"${conversationId}"' >/dev/null; test -n "$PI_MANAGED_SESSION_ATTACHMENT_NONCE"; test -z "\${PI_MATRIX_ACCESS_TOKEN-}"; test "$PI_MANAGED_SESSION_MODEL" = local-llm/coordinator; printf '{"conversationId":"${conversationId}","sessionName":"default","windowId":"@7","paneId":"%%8","role":"coordinator"}\\n';;\n*) exit 2;;\nesac\n`);
	await chmod(launcher, 0o700);
	await launchCoordinator({
		launcher, manifest, sessionFile: value.sessionFile, workspaceDirectory: value.workspaceDirectory,
		socketPath: join(value.root, "relay.sock"), registry: value.registry,
		environment: { PATH: process.env.PATH, PI_MATRIX_ACCESS_TOKEN: "must-not-leak" },
	});
	const runtime = value.registry.snapshot().conversations[0]!;
	assert.deepEqual(runtime.managedWindow, { sessionName: "default", windowId: "@7", paneId: "%8" });
	assert.match(runtime.attachmentNonceHash ?? "", /^[a-f0-9]{64}$/);
	const firstNonceHash = runtime.attachmentNonceHash;
	await writeFile(launcher, `#!${process.env.PI_TEST_SHELL ?? "/bin/sh"}\ncat >/dev/null\nprintf '{"conversationId":"${conversationId}","exists":true,"sessionName":"default","windowId":"@7","paneId":"%%8"}\\n'\n`);
	await chmod(launcher, 0o700);
	await launchCoordinator({
		launcher, manifest, sessionFile: value.sessionFile, workspaceDirectory: value.workspaceDirectory,
		socketPath: join(value.root, "relay.sock"), registry: value.registry, environment: { PATH: process.env.PATH },
	});
	assert.equal(value.registry.snapshot().conversations[0]!.attachmentNonceHash, firstNonceHash,
		"reusing the same process preserves the nonce it can authenticate with");
	await writeFile(launcher, `#!${process.env.PI_TEST_SHELL ?? "/bin/sh"}\ncase "$2" in\nwindow-inspect) cat >/dev/null; printf '{"conversationId":"${conversationId}","exists":false}\\n';;\ncoordinator-ensure) cat >/dev/null; printf '{"conversationId":"conv_ffffffffffffffffffffffffffffffff","sessionName":"default","windowId":"@9","paneId":"%%9","role":"ordinary"}\\n';;\nesac\n`);
	await chmod(launcher, 0o700);
	await assert.rejects(() => launchCoordinator({
		launcher, manifest, sessionFile: value.sessionFile, workspaceDirectory: value.workspaceDirectory,
		socketPath: join(value.root, "relay.sock"), registry: value.registry, environment: { PATH: process.env.PATH },
	}), /invalid managed window/);
});

test("unprefixed authorized coordinator text is durable before wake and delivered on attachment", async () => {
	const value = await fixture();
	const conversationId = deriveConversationId(hostId, "coordinator");
	const manifest: ConversationManifest = {
		schemaVersion: MANAGED_SESSION_STATE_VERSION, kind: "coordinator", conversationId, ownerHostId: hostId,
		creationKey: "coordinator", concept: "host coordinator", piSessionId: "session-coordinator", roomId: "!coordinator:example.com",
		bindingBoundaryEntryId: "entry_00000000000000000000000000000000", createdAt: "2026-08-31T00:00:00.000Z",
	};
	await value.registry.createCoordinatorConversation(manifest);
	await value.registry.setMatrixCursor(conversationId, "coordinator-test-cursor");
	let syncCount = 0;
	const matrix = {
		operatorUserId: matrixConfig.operatorUserId,
		memberJoined: async () => true,
		sync: async (_since?: string, signal?: AbortSignal) => {
			syncCount += 1;
			if (syncCount === 1) return { nextBatch: "cursor-1", response: { rooms: { join: { [manifest.roomId]: { timeline: { events: [
				{ event_id: "$operator", origin_server_ts: Date.now(), sender: matrixConfig.operatorUserId, type: "m.room.message", content: { msgtype: "m.text", body: "resume please" } },
				{ event_id: "$other", origin_server_ts: Date.now(), sender: "@other:example.com", type: "m.room.message", content: { msgtype: "m.text", body: "ignore" } },
			] } } } } } };
			await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
			throw new Error("cancelled");
		},
	} as unknown as ManagedMatrixClient;
	const delivered: unknown[] = [];
	let attached = false;
	const server = {
		sendToConversation: (envelope: unknown) => { if (!attached) return false; delivered.push(envelope); return true; },
	} as ManagedSessionIpcServer;
	let launches = 0;
	const router = new CoordinatorRouter(manifest, value.registry, matrix, server, async () => {
		launches += 1;
		assert.equal(value.registry.pendingInputs(conversationId)[0]?.status, "accepted", "input is durable before wake");
		const attachmentNonce = "abcdefghijklmnopqrstuvwxyzABCDEF";
		await value.registry.setAttachmentNonce(conversationId, attachmentNonce);
		await value.registry.attach({
			protocolVersion: MANAGED_SESSION_PROTOCOL_VERSION, messageId: "attach-router", conversationId,
			role: "coordinator_adapter", type: "attachment.attach",
			payload: { sessionId: manifest.piSessionId, attachmentNonce, bindingBoundaryEntryId: manifest.bindingBoundaryEntryId },
		}, "router-connection");
	});
	router.start();
	for (let index = 0; index < 50 && launches === 0; index += 1) await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(launches, 1);
	assert.equal(value.registry.pendingInputs(conversationId).length, 1, "unauthorized text is ignored");
	attached = true;
	await router.attachmentReady();
	assert.equal(delivered.length, 1);
	assert.equal(value.registry.pendingInputs(conversationId)[0]?.status, "delivered");
	const replayed = value.registry.pendingInputs(conversationId)[0]!;
	await value.registry.recordAcceptedInput(conversationId, { ...replayed, status: "accepted" });
	assert.equal(value.registry.pendingInputs(conversationId)[0]?.status, "delivered", "cursor replay preserves monotonic delivery status");
	await router.stop();
});

test("failed coordinator wake returns dormant, retains input, and emits one stable notice boundary", async () => {
	const value = await fixture();
	const conversationId = deriveConversationId(hostId, "coordinator");
	const manifest: ConversationManifest = {
		schemaVersion: MANAGED_SESSION_STATE_VERSION, kind: "coordinator", conversationId, ownerHostId: hostId,
		creationKey: "coordinator", concept: "host coordinator", piSessionId: "session-coordinator", roomId: "!coordinator:example.com",
		bindingBoundaryEntryId: "entry_00000000000000000000000000000000", createdAt: "2026-08-31T00:00:00.000Z",
	};
	await value.registry.createCoordinatorConversation(manifest);
	await value.registry.setMatrixCursor(conversationId, "coordinator-failure-cursor");
	let synced = false;
	const matrix = {
		operatorUserId: matrixConfig.operatorUserId,
		memberJoined: async () => true,
		sync: async (_since?: string, signal?: AbortSignal) => {
			if (!synced) {
				synced = true;
				return { nextBatch: "failure-cursor", response: { rooms: { join: { [manifest.roomId]: { timeline: { events: [
					{ event_id: "$wake-failure", origin_server_ts: Date.now(), sender: matrixConfig.operatorUserId, type: "m.room.message", content: { msgtype: "m.text", body: "wake" } },
				] } } } } } };
			}
			await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
			throw new Error("cancelled");
		},
	} as unknown as ManagedMatrixClient;
	let noticeSource: string | undefined;
	const router = new CoordinatorRouter(manifest, value.registry, matrix,
		{ sendToConversation: () => false } as unknown as ManagedSessionIpcServer,
		async () => { throw new Error("fixed launcher failed"); },
		async (sourceId) => { noticeSource = sourceId; });
	router.start();
	for (let index = 0; index < 100 && !noticeSource; index += 1) await new Promise((resolve) => setTimeout(resolve, 10));
	assert.match(noticeSource ?? "", /^delivery_/);
	assert.equal(value.registry.conversationState(conversationId), "dormant");
	assert.equal(value.registry.pendingInputs(conversationId)[0]?.status, "accepted");
	await router.stop();
});

test("coordinator tracer routes one unprefixed Matrix turn through real Pi and projects the final", { timeout: 30_000 }, async (t) => {
	const packagedLauncher = process.env.PI_MANAGED_TEST_LAUNCHER;
	const coordinatorPi = process.env.PI_MANAGED_TEST_COORDINATOR_PI;
	const peerUidHelper = process.env.PI_MANAGED_SESSIONS_TEST_PEER_UID_HELPER;
	const relayLockHelper = process.env.PI_MANAGED_SESSIONS_TEST_RELAY_LOCK_HELPER;
	const tmux = process.env.PI_MANAGED_SESSIONS_TEST_TMUX;
	if (!packagedLauncher || !coordinatorPi || !peerUidHelper || !relayLockHelper || !tmux) return t.skip("packaged module coordinator/tmux relay probe paths are unavailable");
	const root = await mkdtemp(join(tmpdir(), "pi-coordinator-tracer-"));
	const provider = join(root, "provider.ts");
	await writeFile(provider, `
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
export default function (pi) {
  pi.registerProvider("coordinator-probe", {
    baseUrl: "https://probe.invalid", apiKey: "test", api: "coordinator-probe-api",
    models: [{ id: "fake", name: "Coordinator Probe", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 }],
    streamSimple(model) {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const message = { role: "assistant", content: [{ type: "text", text: "coordinator answer" }], api: model.api,
          provider: model.provider, model: model.id, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0,
          totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() };
        stream.push({ type: "start", partial: { ...message, content: [] } });
        stream.push({ type: "text_start", contentIndex: 0, partial: message });
        stream.push({ type: "text_delta", contentIndex: 0, delta: "coordinator answer", partial: message });
        stream.push({ type: "text_end", contentIndex: 0, content: "coordinator answer", partial: message });
        stream.push({ type: "done", reason: "stop", message }); stream.end();
      });
      return stream;
    },
  });
}
`);
	const launcher = packagedLauncher;
	const tmuxSocket = `pi43-${process.pid}-${Date.now()}`;
	let running: Awaited<ReturnType<typeof startManagedSessionRelay>> | undefined;
	const originalFetch = globalThis.fetch;
	let createCount = 0;
	let syncCount = 0;
	let resolveFinal!: () => void;
	const finalProjected = new Promise<void>((resolve) => { resolveFinal = resolve; });
	globalThis.fetch = async (input, init) => {
		const url = new URL(String(input));
		if (url.pathname.endsWith("/whoami")) return Response.json({ user_id: matrixConfig.botUserId });
		if (url.pathname.endsWith("/createRoom")) {
			createCount += 1;
			return Response.json({ room_id: createCount === 1 ? "!space:example.com" : "!coordinator:example.com" });
		}
		if (url.pathname.includes("/state/m.room.member/")) return Response.json({ membership: "join" });
		if (url.pathname.endsWith("/sync")) {
			syncCount += 1;
			if (syncCount === 1) return Response.json({ next_batch: "cursor-bootstrap", rooms: { join: {} } });
			if (syncCount === 2) return Response.json({ next_batch: "cursor-phone", rooms: { join: { "!coordinator:example.com": { timeline: { events: [
				{ event_id: "$phone", origin_server_ts: Date.now(), sender: matrixConfig.operatorUserId, type: "m.room.message", content: { msgtype: "m.text", body: "hello coordinator" } },
			] } } } } });
			await new Promise<void>((resolve) => init?.signal?.addEventListener("abort", () => resolve(), { once: true }));
			throw Object.assign(new Error("aborted"), { name: "AbortError" });
		}
		if (url.pathname.includes("/send/")) {
			const content = JSON.parse(String(init?.body)) as { body?: string };
			if (content.body === "coordinator answer") resolveFinal();
			return Response.json({ event_id: "$final" });
		}
		return Response.json({});
	};
	t.after(async () => {
		globalThis.fetch = originalFetch;
		await running?.stop().catch(() => undefined);
		try { execFileSync(tmux, ["-L", tmuxSocket, "kill-server"]); } catch {}
		await rm(root, { recursive: true, force: true });
	});
	running = await startManagedSessionRelay({
		...process.env,
		PI_MANAGED_SESSIONS_RUNTIME_DIR: join(root, "runtime"),
		PI_MANAGED_SESSIONS_SOCKET: join(root, "runtime", "relay.sock"),
		PI_MANAGED_SESSIONS_MANIFEST_DIR: join(root, "manifests"),
		PI_MANAGED_SESSIONS_HOST_ID: `tracer-${Date.now()}`,
		PI_MANAGED_SESSIONS_RESTART_GRACE_MS: "100",
		PI_MANAGED_SESSIONS_PEER_UID_HELPER: peerUidHelper,
		PI_MANAGED_SESSIONS_RELAY_LOCK_HELPER: relayLockHelper,
		PI_MANAGED_COORDINATOR_WORKSPACE_DIR: join(root, "workspace"),
		PI_MANAGED_COORDINATOR_SESSION_FILE: join(root, "sessions", "coordinator.jsonl"),
		PI_MANAGED_COORDINATOR_LAUNCHER: launcher,
		PI_MATRIX_HOMESERVER: matrixConfig.homeserver,
		PI_MATRIX_ACCESS_TOKEN: matrixConfig.accessToken,
		PI_MATRIX_BOT_USER_ID: matrixConfig.botUserId,
		PI_MATRIX_OPERATOR_USER_ID: matrixConfig.operatorUserId,
		PI_MANAGED_TEST_COORDINATOR_PI: coordinatorPi,
		PI_MANAGED_TEST_PROVIDER: provider,
		PI_MANAGED_TEST_TMUX_SOCKET: tmuxSocket,
	});
	let phoneTimer: NodeJS.Timeout | undefined;
	try {
		await Promise.race([finalProjected, new Promise((_, reject) => { phoneTimer = setTimeout(() => reject(new Error("coordinator phone round trip timed out")), 15_000); })]);
	} finally {
		if (phoneTimer) clearTimeout(phoneTimer);
	}
	for (let index = 0; index < 100; index += 1) {
		const current = running.registry.snapshot().conversations[0];
		if (current?.pendingInputs[0]?.status === "completed" && current.managedWindow !== null &&
			current.projection.some((entry) => entry.kind === "assistant_final" && entry.status === "projected")) break;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	const runtime = running.registry.snapshot().conversations[0]!;
	assert.equal(runtime.pendingInputs[0]?.status, "completed");
	assert.equal(runtime.projection.some((entry) => entry.kind === "assistant_final" && entry.status === "projected"), true);
	assert.equal(runtime.managedWindow?.sessionName, "default", JSON.stringify(runtime));
	assert.match(runtime.managedWindow?.windowId ?? "", /^@[0-9]+$/);
	assert.match(runtime.managedWindow?.paneId ?? "", /^%[0-9]+$/);
	assert.equal(execFileSync(tmux, ["-L", tmuxSocket, "list-windows", "-t", "=default", "-F", "#{window_name}"], { encoding: "utf8" }).trim(), "coordinator");
	const retriedWindow = JSON.parse(execFileSync(launcher, ["managed", "window-inspect"], {
		input: `${JSON.stringify({ conversationId: running.registry.manifestByCreationKey("coordinator")!.conversationId })}\n`,
		encoding: "utf8",
		env: { ...process.env, PI_MANAGED_TEST_TMUX_SOCKET: tmuxSocket },
	})) as { exists: boolean; windowId: string; paneId: string };
	assert.equal(retriedWindow.exists, true);
	assert.equal(retriedWindow.windowId, runtime.managedWindow!.windowId);
	assert.equal(retriedWindow.paneId, runtime.managedWindow!.paneId);
	assert.equal(execFileSync(tmux, ["-L", tmuxSocket, "list-windows", "-t", "=default", "-F", "#{window_name}"], { encoding: "utf8" }).trim().split("\n").length, 1);
});
