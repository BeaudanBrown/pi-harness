import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
	MANAGED_SESSION_PROTOCOL_VERSION, MANAGED_SESSION_STATE_VERSION, deriveConversationId, deriveDeliveryId, type ConversationManifest, type ManagedSessionEnvelope,
	encodeNdjsonEnvelope, parseNdjsonEnvelope,
} from "../config/agent/extensions/managed-sessions/contracts.js";
import { HostLifecycle } from "../config/agent/extensions/managed-sessions/relay/host-lifecycle.js";
import { CoordinatorRouter } from "../config/agent/extensions/managed-sessions/relay/coordinator-router.js";
import { ManagedSessionIpcServer } from "../config/agent/extensions/managed-sessions/relay/ipc-server.js";
import { ConversationManifestStore } from "../config/agent/extensions/managed-sessions/relay/manifest-store.js";
import { ManagedMatrixClient } from "../config/agent/extensions/managed-sessions/relay/matrix-client.js";
import { RelayRegistry } from "../config/agent/extensions/managed-sessions/relay/registry.js";
import { TranscriptProjector } from "../config/agent/extensions/managed-sessions/relay/transcript-projector.js";

const hostId = "lifecycle-host";
const matrixConfig = { homeserver: "https://matrix.example.com", accessToken: "relay-secret", botUserId: "@bot:example.com", operatorUserId: "@operator:example.com" };

async function readEnvelope(socket: Socket): Promise<ManagedSessionEnvelope> {
	return new Promise((resolve, reject) => {
		let buffer = Buffer.alloc(0);
		socket.on("data", (chunk) => {
			buffer = Buffer.concat([buffer, chunk]);
			const newline = buffer.indexOf(0x0a);
			if (newline >= 0) { try { resolve(parseNdjsonEnvelope(buffer.subarray(0, newline + 1))); } catch (error) { reject(error); } }
		});
		socket.once("error", reject);
	});
}

async function attachFromRecord(record: string, server: ManagedSessionIpcServer, registry: RelayRegistry): Promise<Socket> {
	for (let attempt = 0; attempt < 200; attempt += 1) {
		try {
			const launch = JSON.parse(await readFile(record, "utf8")) as { conversationId: string; nonce: string };
			const manifest = registry.manifestByConversationId(launch.conversationId)!;
			const socket = connect(server.socketPath);
			await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
			socket.write(encodeNdjsonEnvelope({
				protocolVersion: MANAGED_SESSION_PROTOCOL_VERSION, messageId: `attach-${attempt}`, conversationId: manifest.conversationId,
				role: "ordinary_adapter", type: "attachment.attach", payload: {
					sessionId: manifest.piSessionId, attachmentNonce: launch.nonce, bindingBoundaryEntryId: manifest.bindingBoundaryEntryId,
				},
			}));
			assert.equal((await readEnvelope(socket)).type, "attachment.accepted");
			return socket;
		} catch { await new Promise((resolve) => setTimeout(resolve, 25)); }
	}
	throw new Error("project attachment record timed out");
}

function lifecycleEnvelope(coordinatorId: string, request: Record<string, unknown>): ManagedSessionEnvelope {
	return { protocolVersion: MANAGED_SESSION_PROTOCOL_VERSION, messageId: `request-${Math.random()}`, conversationId: coordinatorId,
		role: "coordinator_adapter", type: "lifecycle.request", payload: { request } } as ManagedSessionEnvelope;
}

test("coordinator lifecycle persists project Pi first, starts/resumes/stops, and bridge-deletes without project loss", { timeout: 30_000 }, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-lifecycle-"));
	const runtime = join(root, "runtime"); const manifests = join(root, "manifests"); const sessions = join(root, "sessions");
	const workspaceRoot = join(root, "workspaces"); const workspace = join(workspaceRoot, "alpha"); const record = join(root, "launch.json");
	await mkdir(workspace, { recursive: true });
	const registry = new RelayRegistry(hostId, runtime, new ConversationManifestStore(manifests));
	await registry.load();
	const coordinatorId = deriveConversationId(hostId, "coordinator");
	const coordinator: ConversationManifest = { schemaVersion: MANAGED_SESSION_STATE_VERSION, kind: "coordinator", conversationId: coordinatorId,
		ownerHostId: hostId, creationKey: "coordinator", concept: "host coordinator", piSessionId: "coordinator-session",
		roomId: "!coordinator:example.com", hostSpace: "!host:example.com", bindingBoundaryEntryId: `entry_${"1".repeat(32)}`, createdAt: new Date().toISOString() };
	await registry.createCoordinatorConversation(coordinator);
	const matrixCalls: string[] = [];
	let roomIndex = 0; let syncIndex = 0;
	const matrix = new ManagedMatrixClient(matrixConfig, async (input, init) => {
		const path = new URL(String(input)).pathname; matrixCalls.push(`${init?.method ?? "GET"} ${path}`);
		if (path.endsWith("/sync")) {
			syncIndex += 1;
			return Response.json({ next_batch: `cursor-${syncIndex}`, rooms: { join: syncIndex === 1 ? {
				"!room2:example.com": { timeline: { events: [{ event_id: "$first-task", sender: matrixConfig.operatorUserId,
					type: "m.room.message", content: { msgtype: "m.text", body: "first real task" } }] } },
			} : {} } });
		}
		if (path.endsWith("/createRoom")) {
			assert.ok((await stat(sessions)).isDirectory(), "project Pi session directory exists before Matrix binding");
			roomIndex += 1; return Response.json({ room_id: roomIndex === 1 ? "!project:example.com" : `!room${roomIndex}:example.com` });
		}
		return Response.json({ event_id: "$ok" });
	}, [coordinator.roomId, coordinator.hostSpace!]);
	const launcher = join(root, "tmux_project");
	await writeFile(launcher, `#!/bin/sh\nset -eu\nop="$2"\ncase "$op" in\nworkspace-list) printf '{"workspaces":[{"rootKey":"projects","workspace":"alpha"}]}\\n';;\nworkspace-resolve) cat >/dev/null; printf '{"rootKey":"projects","workspace":"alpha","relativeCwd":"","workspacePath":"${workspace}","cwd":"${workspace}"}\\n';;\nroot-ensure) cat >/dev/null; printf '{"sessionName":"alpha","workspacePath":"${workspace}"}\\n';;\nwindow-create) test "$PI_MANAGED_SESSION_LAUNCH_ROLE" = project; test -z "\${PI_MATRIX_ACCESS_TOKEN-}"; test -f "$PI_MANAGED_PROJECT_SESSION_FILE"; body=$(cat); conversation=$(printf '%s' "$body" | ${process.execPath} -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>process.stdout.write(JSON.parse(s).conversationId))'); printf '{"conversationId":"%s","nonce":"%s"}\\n' "$conversation" "$PI_MANAGED_SESSION_ATTACHMENT_NONCE" > "$TEST_LAUNCH_RECORD"; printf '{"conversationId":"%s","sessionName":"alpha","windowId":"@7","paneId":"%%8","rootKey":"projects","workspace":"alpha","relativeCwd":"","role":"conversation"}\\n' "$conversation";;\nwindow-terminate) cat >/dev/null; printf '{"terminated":true}\\n';;\nbridge-clear) cat >/dev/null; printf '{"cleared":true}\\n';;\n*) exit 2;;\nesac\n`);
	await chmod(launcher, 0o700);
	const server = new ManagedSessionIpcServer(registry, { runtimeDirectory: join(root, "ipc") });
	await server.start(); t.after(async () => server.close());
	const lifecycle = new HostLifecycle({ hostId, launcher, projectSessionDirectory: sessions, socketPath: server.socketPath,
		registry, matrix, server, environment: { ...process.env, TEST_LAUNCH_RECORD: record, PI_MATRIX_ACCESS_TOKEN: "must-not-leak" } });
	assert.deepEqual(await lifecycle.request(lifecycleEnvelope(coordinatorId, { operation: "workspace.list" })), {
		operation: "workspace.list", workspaces: [{ rootKey: "projects", workspace: "alpha" }],
	});
	const creationKey = "coordinator-project-one";
	const conversationId = deriveConversationId(hostId, creationKey);
	const attaching = attachFromRecord(record, server, registry);
	const started = await lifecycle.request(lifecycleEnvelope(coordinatorId, { operation: "conversation.start", creationKey,
		concept: "alpha work", placement: { rootKey: "projects", workspace: "alpha", relativeCwd: "" } }));
	const firstSocket = await attaching;
	assert.equal(started.conversationState, "active");
	const manifest = registry.manifestByConversationId(conversationId)!;
	const sessionFile = join(sessions, conversationId, "session.jsonl");
	const sessionText = await readFile(sessionFile, "utf8");
	assert.equal(sessionText.trim().split("\n").length, 2, "no objective or orientation is injected before the first Matrix task");
	assert.equal(manifest.projectSpace, "!project:example.com");
	assert.ok(matrixCalls.some((call) => call.includes("m.space.child")));
	assert.equal(registry.listConversations().filter((item) => item.conversationId === conversationId).length, 1);
	await writeFile(record, "", "utf8");
	const secondConversationId = deriveConversationId(hostId, "coordinator-project-two");
	const attachingSecond = attachFromRecord(record, server, registry);
	await lifecycle.request(lifecycleEnvelope(coordinatorId, { operation: "conversation.start", creationKey: "coordinator-project-two",
		concept: "alpha review", placement: { rootKey: "projects", workspace: "alpha", relativeCwd: "" } }));
	const independentSocket = await attachingSecond;
	assert.equal(registry.listConversations().filter((item) => item.kind === "project" && item.state === "active").length, 2,
		"multiple independent conversations may remain active in one workspace");
	assert.notEqual(registry.manifestByConversationId(secondConversationId)?.piSessionId, manifest.piSessionId);

	setTimeout(() => firstSocket.destroy(), 25);
	await lifecycle.request(lifecycleEnvelope(coordinatorId, { operation: "conversation.stop", targetConversationId: conversationId }));
	assert.equal(registry.conversationState(conversationId), "dormant");
	firstSocket.destroy();
	await writeFile(record, "", "utf8");
	const reattaching = attachFromRecord(record, server, registry);
	const resumed = await lifecycle.request(lifecycleEnvelope(coordinatorId, { operation: "conversation.resume", targetConversationId: conversationId }));
	const secondSocket = await reattaching;
	assert.equal(resumed.conversationState, "active");
	assert.equal(registry.manifestByConversationId(conversationId)?.piSessionId, manifest.piSessionId, "resume preserves exact Pi session identity");
	const router = new CoordinatorRouter(coordinator, registry, matrix, server, async () => undefined);
	router.start();
	const delivered = await Promise.race([readEnvelope(secondSocket), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("project room input timed out")), 5_000))]);
	assert.equal(delivered.type, "input.deliver");
	assert.equal(delivered.conversationId, conversationId);
	assert.equal(delivered.payload.body, "first real task", "authorized text routes directly without @host addressing");
	await router.stop();

	const beforeDelete = await readFile(sessionFile, "utf8");
	await lifecycle.request(lifecycleEnvelope(coordinatorId, { operation: "conversation.delete", targetConversationId: conversationId, confirmed: true }));
	assert.equal(registry.manifestByConversationId(conversationId), undefined);
	assert.equal(await readFile(sessionFile, "utf8"), beforeDelete, "bridge deletion preserves Pi history");
	assert.ok(await stat(workspace));
	const pendingId = deriveDeliveryId(secondConversationId, "$cancel-on-stop");
	await registry.recordAcceptedInput(secondConversationId, { deliveryId: pendingId, matrixEventId: "$cancel-on-stop", kind: "prompt", body: "do not recover", status: "accepted" });
	setTimeout(() => independentSocket.destroy(), 25);
	await lifecycle.request(lifecycleEnvelope(coordinatorId, { operation: "conversation.stop", targetConversationId: secondConversationId }));
	assert.equal(registry.pendingInputs(secondConversationId).find((item) => item.deliveryId === pendingId)?.status, "cancelled",
		"remote stop durably cancels unfinished input before a later resume can recover it");
	await assert.rejects(() => lifecycle.request(lifecycleEnvelope(coordinatorId, {
		operation: "conversation.delete", targetConversationId: secondConversationId, confirmed: false,
	})), /explicit confirmation/);
	await lifecycle.request(lifecycleEnvelope(coordinatorId, { operation: "conversation.delete", targetConversationId: secondConversationId, confirmed: true }));
	assert.equal(registry.manifestByConversationId(secondConversationId), undefined, "stopped conversations remain bridge-deletable without a window");
	secondSocket.destroy(); independentSocket.destroy();
});

test("packaged lifecycle launches real Pi through direnv and projects its final answer", { timeout: 30_000 }, async (t) => {
	const launcher = process.env.PI_MANAGED_TEST_LAUNCHER;
	const managedPi = process.env.PI_MANAGED_TEST_MANAGED_PI;
	const direnv = process.env.PI_MANAGED_TEST_DIRENV;
	const tmux = process.env.PI_MANAGED_SESSIONS_TEST_TMUX;
	if (!launcher || !managedPi || !direnv || !tmux) return t.skip("packaged project lifecycle probe paths are unavailable");
	const root = await mkdtemp(join(tmpdir(), "pi-lifecycle-real-"));
	const workspaceRoot = join(root, "roots"); const workspace = join(workspaceRoot, "alpha");
	const direnvConfig = join(root, "direnv-config"); const home = join(root, "home"); const provider = join(root, "provider.ts");
	const tmuxSocket = `pi44-${process.pid}-${Date.now()}`; const projectLog = join(root, "project.log");
	await mkdir(workspace, { recursive: true }); await mkdir(home, { recursive: true });
	await writeFile(join(workspace, ".envrc"), "export PROJECT_PROBE=present\n");
	execFileSync(direnv, ["allow", workspace], { env: { ...process.env, HOME: home, DIRENV_CONFIG: direnvConfig } });
	await writeFile(provider, `
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AssistantMessageEventStream } from "@mariozechner/pi-ai";
export default function (pi: ExtensionAPI) {
  pi.registerProvider("coordinator-probe", {
    baseUrl: "https://probe.invalid", apiKey: "test", api: "coordinator-probe-api",
    models: [{ id: "fake", name: "fake", api: "coordinator-probe-api", provider: "coordinator-probe", baseUrl: "https://probe.invalid",
      reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 256 }],
    streamSimple: (_model: any, _context: any) => {
      const stream = new AssistantMessageEventStream();
      queueMicrotask(() => {
        const text = process.env.PROJECT_PROBE === "present" ? "direnv project answer" : "missing project environment";
        const message = { role: "assistant", content: [{ type: "text", text }], api: "coordinator-probe-api",
          provider: "coordinator-probe", model: "fake", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
          totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() };
        stream.push({ type: "start", partial: message }); stream.push({ type: "text_start", contentIndex: 0, partial: message });
        stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
        stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message }); stream.push({ type: "done", reason: "stop", message }); stream.end(message);
      }); return stream;
    },
  });
}
`);
	const registry = new RelayRegistry(hostId, join(root, "runtime"), new ConversationManifestStore(join(root, "manifests")));
	await registry.load();
	const coordinatorId = deriveConversationId(hostId, "coordinator-real");
	const coordinator: ConversationManifest = { schemaVersion: MANAGED_SESSION_STATE_VERSION, kind: "coordinator", conversationId: coordinatorId,
		ownerHostId: hostId, creationKey: "coordinator-real", concept: "host coordinator", piSessionId: "coordinator-real",
		roomId: "!coordinator:example.com", hostSpace: "!host:example.com", bindingBoundaryEntryId: `entry_${"2".repeat(32)}`, createdAt: new Date().toISOString() };
	await registry.createCoordinatorConversation(coordinator);
	let roomIndex = 0; let resolveFinal!: () => void;
	const finalProjected = new Promise<void>((resolve) => { resolveFinal = resolve; });
	const matrix = new ManagedMatrixClient(matrixConfig, async (input, init) => {
		const path = new URL(String(input)).pathname;
		if (path.endsWith("/createRoom")) { roomIndex += 1; return Response.json({ room_id: roomIndex === 1 ? "!project:example.com" : "!task:example.com" }); }
		if (path.includes("/send/m.room.message/")) {
			const body = JSON.parse(String(init?.body)) as { body: string };
			if (body.body === "direnv project answer") resolveFinal();
			return Response.json({ event_id: "$project-final" });
		}
		return Response.json({ event_id: "$ok" });
	}, [coordinator.roomId, coordinator.hostSpace!]);
	const projector = new TranscriptProjector(registry, matrix);
	let server!: ManagedSessionIpcServer;
	server = new ManagedSessionIpcServer(registry, {
		runtimeDirectory: join(root, "ipc"),
		onAttachment: async (attachment) => {
			if (attachment.role !== "ordinary_adapter") return;
			const matrixEventId = "$real-project-task"; const deliveryId = deriveDeliveryId(attachment.conversationId, matrixEventId);
			await registry.recordAcceptedInput(attachment.conversationId, { deliveryId, matrixEventId, kind: "prompt", body: "answer from project", status: "accepted" });
			server.sendToConversation({ protocolVersion: MANAGED_SESSION_PROTOCOL_VERSION, messageId: "relay-real-task", conversationId: attachment.conversationId,
				role: "relay", type: "input.deliver", payload: { deliveryId, matrixEventId, kind: "prompt", body: "answer from project" } });
		},
		onEnvelope: async (envelope, attachment) => {
			if (envelope.type === "input.acknowledge") {
				const payload = envelope.payload as { deliveryId: string; status: string; piEntryId?: string };
				await registry.acknowledgeInput(attachment.conversationId, payload.deliveryId, payload.status, payload.piEntryId);
				return { protocolVersion: MANAGED_SESSION_PROTOCOL_VERSION, messageId: `result-${Date.now()}`, conversationId: attachment.conversationId,
					role: "relay", type: "input.result", inReplyTo: envelope.messageId, payload: { deliveryId: payload.deliveryId, status: payload.status } };
			}
			if (envelope.type === "transcript.offer") {
				await projector.project(envelope);
				return { protocolVersion: MANAGED_SESSION_PROTOCOL_VERSION, messageId: `projection-${Date.now()}`, conversationId: attachment.conversationId,
					role: "relay", type: "transcript.acknowledge", inReplyTo: envelope.messageId, payload: { entryId: envelope.payload.entryId, status: "projected" } };
			}
			return undefined;
		},
	});
	await server.start();
	const cleanup = async () => { try { execFileSync(tmux, ["-L", tmuxSocket, "kill-server"]); } catch {} await server.close().catch(() => undefined); };
	t.after(cleanup);
	const launchEnvironment = { ...process.env };
	delete launchEnvironment.PI_CODING_AGENT;
	const lifecycle = new HostLifecycle({ hostId, launcher, projectSessionDirectory: join(root, "sessions"), socketPath: server.socketPath,
		registry, matrix, server, environment: { ...launchEnvironment, PATH: `${managedPi.slice(0, managedPi.lastIndexOf("/"))}:${process.env.PATH}`,
			HOME: home, PI_CODING_AGENT_DIR: join(root, "agent"),
			DIRENV_CONFIG: direnvConfig, PI_MANAGED_TEST_TMUX_SOCKET: tmuxSocket, PI_MANAGED_TEST_WORKSPACE_ROOT: workspaceRoot,
			PI_MANAGED_TEST_PROVIDER: provider, PI_MANAGED_TEST_PROJECT_LOG: projectLog } });
	let started: Record<string, unknown>;
	try {
		started = await lifecycle.request(lifecycleEnvelope(coordinatorId, { operation: "conversation.start", creationKey: "real-project",
			concept: "real project", placement: { rootKey: "projects", workspace: "alpha", relativeCwd: "" } }));
	} catch (error) {
		let pane = ""; let session = "";
		try { pane = await readFile(projectLog, "utf8"); } catch {}
		try { session = await readFile(join(root, "sessions", deriveConversationId(hostId, "real-project"), "session.jsonl"), "utf8"); } catch {}
		throw new Error(`${error instanceof Error ? error.message : "project launch failed"}; session=${session.trim()}; project-log=${pane.trim()}`);
	}
	assert.equal(started.conversationState, "active");
	await Promise.race([finalProjected, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("real project final projection timed out")), 15_000))]);
	const project = registry.manifestByCreationKey("real-project")!;
	assert.equal(registry.pendingInputs(project.conversationId)[0]?.status, "completed");
	assert.equal(execFileSync(tmux, ["-L", tmuxSocket, "list-windows", "-t", "=alpha", "-F", "#{window_name}"], { encoding: "utf8" }).trim().split("\n").filter((name) => name.startsWith("pi-")).length, 1);
});
