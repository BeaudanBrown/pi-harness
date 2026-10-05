import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
	MANAGED_SESSION_PROTOCOL_VERSION,
	MANAGED_SESSION_STATE_VERSION,
	MAX_NDJSON_FRAME_BYTES,
	deriveConversationId,
	deriveTranscriptEntryId,
	encodeNdjsonEnvelope,
	parseNdjsonEnvelope,
	type ConversationManifest,
	type ManagedSessionEnvelope,
} from "../config/agent/extensions/managed-sessions/contracts.js";
import { ManagedSessionIpcServer, type EnvelopeHandler, type PeerUidResolver, type AttachmentDisconnectHandler } from "../config/agent/extensions/managed-sessions/relay/ipc-server.js";
import { ConversationManifestStore } from "../config/agent/extensions/managed-sessions/relay/manifest-store.js";
import { peerUidFromHelper } from "../config/agent/extensions/managed-sessions/relay/peer-uid.js";
import { RelayRegistry, RelayRegistryError } from "../config/agent/extensions/managed-sessions/relay/registry.js";
import { hostRelayLockPath, HostRelayLock } from "../config/agent/extensions/managed-sessions/relay/relay-lock.js";
import { BoundAdapterClient } from "../config/agent/extensions/managed-sessions/adapter/client.js";
import { ConversationTitles } from "../config/agent/extensions/managed-sessions/relay/conversation-titles.js";
import { deriveGenerationId } from "../config/agent/extensions/managed-sessions/v2-contracts.js";

const hostId = "ipc-host";
const nonce = "abcdefghijklmnopqrstuvwxyzABCDEF";

function manifest(key: string): ConversationManifest {
	const sessionId = `session-${key}`;
	return {
		schemaVersion: MANAGED_SESSION_STATE_VERSION,
		kind: "project",
		conversationId: deriveConversationId(hostId, key),
		ownerHostId: hostId,
		creationKey: key,
		concept: key,
		piSessionId: sessionId,
		roomId: `!${key}:example.com`,
		placement: { rootKey: "projects", workspace: key, relativeCwd: "" },
		bindingBoundaryEntryId: deriveTranscriptEntryId(sessionId, "boundary"),
		createdAt: "2026-08-31T00:00:00.000Z",
	};
}

function attach(value: ConversationManifest, messageId: string): ManagedSessionEnvelope {
	return {
		protocolVersion: MANAGED_SESSION_PROTOCOL_VERSION,
		messageId,
		conversationId: value.conversationId,
		role: "ordinary_adapter",
		type: "attachment.attach",
		payload: { sessionId: value.piSessionId, attachmentNonce: nonce, bindingBoundaryEntryId: value.bindingBoundaryEntryId },
	};
}

function openSocket(path: string): Promise<Socket> {
	return new Promise((resolve, reject) => {
		const socket = connect(path, () => resolve(socket));
		socket.once("error", reject);
	});
}

function readEnvelope(socket: Socket): Promise<ManagedSessionEnvelope> {
	return new Promise((resolve, reject) => {
		let buffer = Buffer.alloc(0);
		const onData = (chunk: Buffer) => {
			buffer = Buffer.concat([buffer, chunk]);
			const newline = buffer.indexOf(0x0a);
			if (newline === -1) return;
			cleanup();
			try { resolve(parseNdjsonEnvelope(buffer.subarray(0, newline + 1))); } catch (error) { reject(error); }
		};
		const onClose = () => { cleanup(); reject(new Error("socket closed before a relay response")); };
		const cleanup = () => { socket.off("data", onData); socket.off("close", onClose); };
		socket.on("data", onData);
		socket.on("close", onClose);
	});
}

test("title metadata requires negotiated capability and uses the live attached conversation over real IPC", async t => {
	let owner!: ConversationTitles; let accepted = 0;
	const f = await setup(undefined, async (envelope, attachment) => {
		accepted++; const source = f.registry.registeredConversation(attachment.conversationId)!;
		const title = envelope.type === "title.read" ? await owner.read(source.conversationId) : await owner.observe(source.conversationId, source.piSessionId,
			envelope.payload.sequence as number, envelope.payload.title as string, () => f.server.attachment(source.conversationId)?.attachmentId === attachment.attachmentId);
		return { protocolVersion: MANAGED_SESSION_PROTOCOL_VERSION, role: "relay", messageId: "title-response", conversationId: source.conversationId, inReplyTo: envelope.messageId, type: "self.result",
			payload: { operation: envelope.type, ...title, ...(envelope.type === "title.observe" ? { sequence: envelope.payload.sequence } : {}) } };
	});
	owner = new ConversationTitles({ root: join(f.root, "titles"), hostId, botUserId: "@bot:example.com", registry: f.registry, runtime: () => new Map(),
		readName: async () => { throw Error("No Matrix traffic expected"); }, writeName: async () => { throw Error("No Matrix traffic expected"); }, changed: () => undefined });
	t.after(async () => { await owner.close(); await f.server.close(); await rm(f.root, { recursive: true, force: true }); });
	const legacy = await openSocket(f.server.socketPath); t.after(() => legacy.destroy());
	let reply = readEnvelope(legacy); legacy.write(encodeNdjsonEnvelope(attach(f.values[0]!, "legacy"))); await reply;
	reply = readEnvelope(legacy); legacy.write(encodeNdjsonEnvelope({ protocolVersion: "1.0.0", role: "ordinary_adapter", messageId: "legacy-title", conversationId: f.values[0]!.conversationId, type: "title.observe", payload: { sequence: 1, title: "unnegotiated" } }));
	assert.equal((await reply).payload.code, "permission_denied"); assert.equal(accepted, 0);
	const value = f.values[1]!; const client = new BoundAdapterClient({ socketPath: f.server.socketPath, role: "ordinary_adapter", attachmentNonce: nonce, requestedCapabilities: ["title-v1"], onEnvelope: async () => undefined,
		binding: { version: MANAGED_SESSION_STATE_VERSION, role: "ordinary_adapter", conversationId: value.conversationId, concept: value.concept, sessionId: value.piSessionId, bindingBoundaryEntryId: value.bindingBoundaryEntryId } });
	t.after(() => client.close()); await client.connect(); assert.ok(client.supports("title-v1"));
	assert.equal((await client.title()).title, value.concept);
	assert.equal((await client.title(1, "Current title")).title, "Current title");
	assert.equal(f.registry.registeredConversation(value.conversationId)?.title, "Current title");
	assert.equal(f.registry.registeredConversation(f.values[0]!.conversationId)?.title, undefined);
});

test("exact attachment shutdown survives registry retirement but rejects changed attachment/generation", async (t) => {
	let disconnects = 0; const f = await setup(undefined, undefined, false, () => { disconnects++; });
	t.after(async () => { await f.server.close(); await rm(f.root, { recursive: true, force: true }); });
	const value = f.values[0]!; const socket = await openSocket(f.server.socketPath); t.after(() => socket.destroy());
	const attached = readEnvelope(socket); socket.write(encodeNdjsonEnvelope(attach(value, "exact-attach"))); await attached;
	const target = f.server.attachment(value.conversationId)!; assert.ok(target);
	await f.registry.retireConversation(value.conversationId, [
		{ kind: "stop", generationId: deriveGenerationId(value.conversationId, target.generation), attachmentId: target.attachmentId },
		{ kind: "operator_leave_forget", roomId: value.roomId, userId: "@operator:example.com" },
		{ kind: "bot_leave", roomId: value.roomId, userId: "@bot:example.com" },
	]);
	const stop: ManagedSessionEnvelope = { protocolVersion: MANAGED_SESSION_PROTOCOL_VERSION, messageId: "retired-stop", conversationId: value.conversationId,
		role: "relay", type: "termination.request", payload: { reason: "stop" } };
	assert.equal(f.server.sendToAttachment({ ...target, attachmentId: "replacement" }, stop), false);
	assert.equal(f.server.sendToAttachment({ ...target, generation: target.generation + 1 }, stop), false);
	const delivered = readEnvelope(socket); assert.equal(f.server.sendToAttachment(target, stop), true); assert.equal((await delivered).type, "termination.request");
	await f.server.close(); assert.equal(disconnects, 1); assert.equal(f.server.attachment(value.conversationId), undefined);
	assert.equal(f.server.sendToAttachment(target, stop), false);
});

function waitForClose(socket: Socket): Promise<void> {
	return new Promise((resolve) => socket.once("close", () => resolve()));
}

async function setup(peerUidOverride?: PeerUidResolver, onEnvelope?: EnvelopeHandler, hostApprovalsEnabled = false, onAttachmentDisconnect?: AttachmentDisconnectHandler): Promise<{ root: string; server: ManagedSessionIpcServer; values: ConversationManifest[]; registry: RelayRegistry }> {
	const root = await mkdtemp(join(tmpdir(), "pi-managed-ipc-"));
	const values = [manifest("one"), manifest("two")];
	const store = new ConversationManifestStore(join(root, "manifests"));
	for (const value of values) await store.write(value);
	const registry = new RelayRegistry(hostId, join(root, "runtime"), store);
	await registry.load();
	for (const value of values) await registry.setAttachmentNonce(value.conversationId, nonce);
	const peerUidHelper = process.env.PI_MANAGED_SESSIONS_TEST_PEER_UID_HELPER;
	const server = new ManagedSessionIpcServer(registry, {
		runtimeDirectory: join(root, "run"),
		expectedUid: process.getuid?.(),
		peerUid: peerUidOverride ?? (peerUidHelper ? (socket) => peerUidFromHelper(peerUidHelper, socket) : () => process.getuid?.()),
		onEnvelope, hostApprovalsEnabled, onAttachmentDisconnect,
	});
	await server.start();
	return { root, server, values, registry };
}

test("host approval wait permits fresh proofs on the same socket and a disconnected client never replays the mutation", { timeout: 10_000 }, async (t) => {
	let proof!: () => void; const proofArrived = new Promise<void>((resolve) => { proof = resolve; });
	let release!: () => void; const effect = new Promise<void>((resolve) => { release = resolve; }); let attempts = 0;
	const running = await setup(undefined, async (envelope, attachment) => {
		const response = { protocolVersion: MANAGED_SESSION_PROTOCOL_VERSION, role: "relay" as const, messageId: `reply-${envelope.messageId}`, conversationId: attachment.conversationId, inReplyTo: envelope.messageId };
		if (envelope.type === "host.run.confirm") { assert.equal(envelope.payload.checkId, "fresh-check"); proof(); return { ...response, type: "host.acknowledge", payload: {} }; }
		assert.equal(envelope.type, "host.request"); attempts++;
		running.server.sendToConversation({ protocolVersion: MANAGED_SESSION_PROTOCOL_VERSION, role: "relay", messageId: "fresh-proof", conversationId: attachment.conversationId, type: "host.run.check", payload: { checkId: "fresh-check" } });
		await proofArrived; await effect;
		return { ...response, type: "host.result", payload: { operation: "conversation.stop", response: { version: "1.0.0", requestId: "request-1", ok: true, data: { conversationId: attachment.conversationId, runtimeState: "stopped" } } } };
	}, true);
	const value = running.values[0];
	const binding = { version: MANAGED_SESSION_STATE_VERSION, role: "ordinary_adapter" as const, conversationId: value.conversationId, concept: value.concept, sessionId: value.piSessionId, bindingBoundaryEntryId: value.bindingBoundaryEntryId };
	let client: BoundAdapterClient;
	const makeClient = () => new BoundAdapterClient({ socketPath: running.server.socketPath, binding, role: "ordinary_adapter", attachmentNonce: nonce, requestedCapabilities: ["approval-v1"],
		onEnvelope: async (envelope) => { await client.confirmHostRun(String(envelope.payload.checkId), { generationId: deriveGenerationId(value.conversationId, 1), runId: "run-1", phase: "active", sources: [{ kind: "local" }], toolCallIds: ["tool-1"] }); } });
	client = makeClient(); t.after(async () => { release(); await client.close(); await running.server.close(); await rm(running.root, { recursive: true, force: true }); });
	await client.connect(); assert.equal(client.supports("approval-v1"), true);
	const result = client.requestHostAction({ requestId: "request-1", generationId: deriveGenerationId(value.conversationId, 1), runId: "run-1", toolCallId: "tool-1", action: { operation: "conversation.stop", conversationId: value.conversationId } });
	await proofArrived; await client.close(); const unknown = await result;
	assert.ok(!unknown.ok); assert.match(unknown.error.message, /outcome is unknown/); assert.equal(unknown.error.retryable, false);
	release(); client = makeClient(); await client.connect(); assert.equal(attempts, 1);
});

test("approval capability is absent until explicitly enabled and unknown peer UID fails closed", async (t) => {
	const running = await setup(); t.after(async () => { await running.server.close(); await rm(running.root, { recursive: true, force: true }); });
	const socket = await openSocket(running.server.socketPath); const reply = readEnvelope(socket); const hello = attach(running.values[0], "capability-staged");
	hello.payload.requestedCapabilities = ["approval-v1"]; socket.write(encodeNdjsonEnvelope(hello));
	assert.deepEqual((await reply).payload.capabilities, []); socket.destroy();
	const unknown = await setup(() => undefined); t.after(async () => { await unknown.server.close(); await rm(unknown.root, { recursive: true, force: true }); });
	const rejected = await openSocket(unknown.server.socketPath); await waitForClose(rejected);
});

test("IPC shutdown drains disconnect writes before releasing ownership", async (t) => {
	const { root, server, values, registry } = await setup();
	let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
	let began!: () => void; const detaching = new Promise<void>((resolve) => { began = resolve; });
	t.after(async () => { release(); await server.close(); await rm(root, { recursive: true, force: true }); });
	const socket = await openSocket(server.socketPath); const accepted = readEnvelope(socket);
	socket.write(encodeNdjsonEnvelope(attach(values[0]!, "attach-drain"))); await accepted;
	const detach = registry.detach.bind(registry);
	registry.detach = async (...args) => { began(); await gate; await detach(...args); };
	socket.destroy(); await detaching;
	let closed = false; const closing = server.close().then(() => { closed = true; });
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(closed, false, "socket closure alone is not a durable ownership-release boundary");
	release(); await closing;
	assert.equal(registry.conversationState(values[0]!.conversationId), "dormant");
});

test("commentary is capability-gated and legacy attachment responses remain unchanged", async (t) => {
	let projected = 0;
	const { server, values } = await setup(undefined, async (envelope) => {
		projected += 1;
		return { protocolVersion: MANAGED_SESSION_PROTOCOL_VERSION, role: "relay", messageId: `reply-${envelope.messageId}`,
			conversationId: envelope.conversationId, type: "transcript.acknowledge", inReplyTo: envelope.messageId,
			payload: { entryId: envelope.payload.entryId, status: "projected" } };
	});
	t.after(() => server.close());
	for (const [index, enabled] of [false, true].entries()) {
		const socket = await openSocket(server.socketPath);
		t.after(() => socket.destroy());
		const value = values[index]!;
		const request = attach(value, `attach-${index}`);
		if (enabled) request.payload.requestedCapabilities = ["commentary-v1"];
		const attached = readEnvelope(socket);
		socket.write(encodeNdjsonEnvelope(request));
		assert.deepEqual((await attached).payload.capabilities, enabled ? ["commentary-v1"] : undefined);
		const result = readEnvelope(socket);
		socket.write(encodeNdjsonEnvelope({ protocolVersion: MANAGED_SESSION_PROTOCOL_VERSION, messageId: `comment-${index}`,
			conversationId: value.conversationId, role: "ordinary_adapter", type: "transcript.offer",
			payload: { entryId: deriveTranscriptEntryId(value.piSessionId, "message:text:0"), piSessionId: value.piSessionId,
				piEntryKey: "message:text:0", kind: "assistant_commentary", body: "Completed commentary" } }));
		const response = await result;
		assert.equal(response.type, enabled ? "transcript.acknowledge" : "error");
	}
	assert.equal(projected, 1);
});

test("host relay lock permits exactly one relay process per host independent of runtime path", async (t) => {
	const helper = process.env.PI_MANAGED_SESSIONS_TEST_RELAY_LOCK_HELPER;
	if (!helper) return t.skip("packaged relay lock helper is unavailable");
	const lockPath = await hostRelayLockPath(hostId, process.getuid?.());
	const first = new HostRelayLock(helper, lockPath);
	const second = new HostRelayLock(helper, lockPath);
	await first.acquire();
	await assert.rejects(() => second.acquire(), /already owns/);
	await first.release();
	await second.acquire();
	await second.release();
});

test("private IPC accepts many same-user adapters but one attachment per conversation", async (t) => {
	const { server, values } = await setup();
	t.after(() => server.close());
	assert.equal((await stat(dirname(server.socketPath))).mode & 0o777, 0o700);
	assert.equal((await stat(server.socketPath)).mode & 0o777, 0o600);

	const first = await openSocket(server.socketPath);
	const second = await openSocket(server.socketPath);
	t.after(() => { first.destroy(); second.destroy(); });
	const firstResponse = readEnvelope(first);
	first.write(encodeNdjsonEnvelope(attach(values[0]!, "attach-one")));
	assert.equal((await firstResponse).type, "attachment.accepted");
	const secondResponse = readEnvelope(second);
	second.write(encodeNdjsonEnvelope(attach(values[1]!, "attach-two")));
	assert.equal((await secondResponse).type, "attachment.accepted");

	const duplicate = await openSocket(server.socketPath);
	const duplicateResponse = readEnvelope(duplicate);
	duplicate.write(encodeNdjsonEnvelope(attach(values[0]!, "attach-duplicate")));
	const rejected = await duplicateResponse;
	assert.equal(rejected.type, "error");
	assert.equal(rejected.payload.code, "attachment_conflict");
});

test("IPC preserves immediately sent frames while asynchronous peer credentials are checked", async (t) => {
	const { server, values } = await setup(async () => {
		await new Promise((resolve) => setTimeout(resolve, 50));
		return process.getuid?.();
	});
	t.after(() => server.close());
	const socket = await openSocket(server.socketPath);
	t.after(() => socket.destroy());
	const response = readEnvelope(socket);
	socket.write(encodeNdjsonEnvelope(attach(values[0]!, "immediate-attach")));
	assert.equal((await response).type, "attachment.accepted");
});

test("IPC keeps authenticated attachments after recoverable operation errors", async (t) => {
	let attempts = 0;
	const { server, values } = await setup(undefined, async (envelope) => {
		attempts += 1;
		if (attempts === 1) throw new RelayRegistryError("capacity_reached", "temporary capacity boundary");
		return {
			protocolVersion: MANAGED_SESSION_PROTOCOL_VERSION,
			messageId: `response-${attempts}`,
			conversationId: envelope.conversationId!,
			role: "relay",
			type: "self.result",
			inReplyTo: envelope.messageId,
			payload: { operation: "self.status", status: "ok", conversationState: "active" },
		};
	});
	t.after(() => server.close());
	const socket = await openSocket(server.socketPath);
	t.after(() => socket.destroy());
	let response = readEnvelope(socket);
	socket.write(encodeNdjsonEnvelope(attach(values[0]!, "recoverable-attach")));
	assert.equal((await response).type, "attachment.accepted");
	const request = (messageId: string): ManagedSessionEnvelope => ({
		protocolVersion: MANAGED_SESSION_PROTOCOL_VERSION, messageId, conversationId: values[0]!.conversationId,
		role: "ordinary_adapter", type: "self.status", payload: {},
	});
	response = readEnvelope(socket);
	socket.write(encodeNdjsonEnvelope(request("recoverable-error")));
	assert.equal((await response).payload.code, "capacity_reached");
	response = readEnvelope(socket);
	socket.write(encodeNdjsonEnvelope(request("after-recoverable-error")));
	assert.equal((await response).type, "self.result");
});

test("IPC fails closed on malformed, oversized, duplicate-ID, and wrong-UID clients", async (t) => {
	const { root, server, values } = await setup();
	t.after(() => server.close());
	const credentialFrame = Buffer.from(`${JSON.stringify({
		...attach(values[0]!, "credential-attempt"),
		payload: { ...attach(values[0]!, "credential-attempt").payload, accessToken: "must-not-cross-ipc" },
	})}\n`);
	for (const frame of [Buffer.from("not-json\n"), credentialFrame, Buffer.alloc(MAX_NDJSON_FRAME_BYTES + 1, 0x20)]) {
		const socket = await openSocket(server.socketPath);
		const closed = waitForClose(socket);
		socket.write(frame);
		await closed;
	}
	const socket = await openSocket(server.socketPath);
	const accepted = readEnvelope(socket);
	const frame = encodeNdjsonEnvelope(attach(values[0]!, "same-id"));
	socket.write(frame);
	await accepted;
	const closed = waitForClose(socket);
	socket.write(frame);
	await closed;

	await server.close({ preserveAttachments: true });
	const store = new ConversationManifestStore(join(root, "manifests"));
	const registry = new RelayRegistry(hostId, join(root, "runtime"), store);
	await registry.load();
	const wrongUidServer = new ManagedSessionIpcServer(registry, {
		runtimeDirectory: join(root, "wrong-uid-run"), expectedUid: process.getuid?.(), peerUid: () => (process.getuid?.() ?? 0) + 1,
	});
	await wrongUidServer.start();
	t.after(() => wrongUidServer.close());
	const wrongUid = await openSocket(wrongUidServer.socketPath);
	const wrongUidClosed = waitForClose(wrongUid);
	wrongUid.write(encodeNdjsonEnvelope(attach(values[1]!, "wrong-uid")));
	await wrongUidClosed;
});
