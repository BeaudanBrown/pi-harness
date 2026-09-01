import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
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
import { ManagedSessionIpcServer, type EnvelopeHandler, type PeerUidResolver } from "../config/agent/extensions/managed-sessions/relay/ipc-server.js";
import { ConversationManifestStore } from "../config/agent/extensions/managed-sessions/relay/manifest-store.js";
import { peerUidFromHelper } from "../config/agent/extensions/managed-sessions/relay/peer-uid.js";
import { RelayRegistry, RelayRegistryError } from "../config/agent/extensions/managed-sessions/relay/registry.js";
import { hostRelayLockPath, HostRelayLock } from "../config/agent/extensions/managed-sessions/relay/relay-lock.js";

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

function waitForClose(socket: Socket): Promise<void> {
	return new Promise((resolve) => socket.once("close", () => resolve()));
}

async function setup(peerUidOverride?: PeerUidResolver, onEnvelope?: EnvelopeHandler): Promise<{ root: string; server: ManagedSessionIpcServer; values: ConversationManifest[] }> {
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
		onEnvelope,
	});
	await server.start();
	return { root, server, values };
}

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
