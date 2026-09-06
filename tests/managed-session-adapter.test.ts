import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	MANAGED_SESSION_PROTOCOL_VERSION,
	MANAGED_SESSION_STATE_VERSION,
	deriveConversationId,
	deriveDeliveryId,
	deriveTranscriptEntryId,
	encodeNdjsonEnvelope,
	parseNdjsonEnvelope,
	type ManagedSessionEnvelope,
} from "../config/agent/extensions/managed-sessions/contracts.js";
import { BoundAdapterClient, CoordinatorAdapterClient, ManagedAdapterError, requestSelfBind } from "../config/agent/extensions/managed-sessions/adapter/client.js";
import { createManagedSessionAdapterExtension } from "../config/agent/extensions/managed-sessions/adapter/extension.js";
import {
	BINDING_BOUNDARY_ENTRY_TYPE,
	CHECKPOINT_ENTRY_TYPE,
	BINDING_ENTRY_TYPE,
	DELIVERY_ENTRY_TYPE,
	PROJECTION_DIAGNOSTIC_ENTRY_TYPE,
	PROJECTION_ENTRY_TYPE,
	UNBOUND_ENTRY_TYPE,
	eligibleTranscriptEntries,
	aloopPrivateAssistantEntryKeys,
	findDeliveredUserEntry,
	hasBackfillDiagnostic,
	hasProjectionCapacityDiagnostic,
	planTranscriptBackfill,
	restoreBindingAttempt,
	restoreDeliveries,
	restoreProjections,
	restoreSessionBinding,
	transcriptOfferWithinFrame,
	type SessionBinding,
} from "../config/agent/extensions/managed-sessions/adapter/state.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	ALOOP_LIFECYCLE_ENTRY_TYPE,
	ALOOP_LIFECYCLE_PROJECTION_ENTRY_TYPE,
	createAloopLifecycleEvent,
	delegateManagedAloopCheckpoint,
	publishAloopLifecycleEvent,
	registerManagedAloopAbortDelegate,
} from "../config/agent/extensions/managed-sessions/aloop-lifecycle.js";

const conversationId = deriveConversationId("host", "work");
const sessionId = "session-work";
const boundaryEntryId = deriveTranscriptEntryId(sessionId, "boundary");
const nonce = "abcdefghijklmnopqrstuvwxyzABCDEF";
const binding: SessionBinding = {
	version: MANAGED_SESSION_STATE_VERSION,
	conversationId,
	concept: "work",
	sessionId,
	bindingBoundaryEntryId: boundaryEntryId,
	role: "ordinary_adapter",
};

function custom(id: string, customType: string, data: unknown) {
	return { type: "custom", id, parentId: null, timestamp: "2026-08-31T00:00:00.000Z", customType, data };
}

class FakeRelay {
	readonly frames: ManagedSessionEnvelope[] = [];
	readonly sockets = new Set<Socket>();
	readonly root: string;
	readonly socketPath: string;
	private server?: Server;
	private counter = 0;

	private constructor(root: string, private readonly lifecycleDelayMs = 0, private readonly attachmentDelayMs = 0,
		private readonly transcriptDelayMs = 0, private readonly selfStatusDelayMs = 0) {
		this.root = root;
		this.socketPath = join(root, "relay.sock");
	}

	static async start(lifecycleDelayMs = 0, attachmentDelayMs = 0, transcriptDelayMs = 0, selfStatusDelayMs = 0): Promise<FakeRelay> {
		const relay = new FakeRelay(await mkdtemp(join(tmpdir(), "pi-adapter-relay-")), lifecycleDelayMs, attachmentDelayMs, transcriptDelayMs, selfStatusDelayMs);
		relay.server = createServer((socket) => relay.accept(socket));
		await new Promise<void>((resolve, reject) => {
			relay.server!.once("error", reject);
			relay.server!.listen(relay.socketPath, resolve);
		});
		return relay;
	}

	async close(): Promise<void> {
		for (const socket of this.sockets) socket.destroy();
		if (this.server) await new Promise<void>((resolve) => this.server!.close(() => resolve()));
		await rm(this.root, { recursive: true, force: true });
	}

	disconnect(): void {
		for (const socket of this.sockets) socket.destroy();
	}

	send(envelope: ManagedSessionEnvelope): void {
		const socket = [...this.sockets].at(-1);
		if (!socket) throw new Error("No adapter socket");
		socket.write(encodeNdjsonEnvelope(envelope));
	}

	private accept(socket: Socket): void {
		this.sockets.add(socket);
		let buffer = Buffer.alloc(0);
		socket.on("close", () => this.sockets.delete(socket));
		socket.on("data", (chunk) => {
			buffer = Buffer.concat([buffer, chunk]);
			while (buffer.includes(0x0a)) {
				const newline = buffer.indexOf(0x0a);
				const envelope = parseNdjsonEnvelope(buffer.subarray(0, newline + 1));
				buffer = buffer.subarray(newline + 1);
				this.frames.push(envelope);
				this.respond(socket, envelope);
			}
		});
	}

	private respond(socket: Socket, envelope: ManagedSessionEnvelope): void {
		this.counter += 1;
		const base = {
			protocolVersion: MANAGED_SESSION_PROTOCOL_VERSION,
			messageId: `relay-${this.counter}`,
			conversationId: envelope.conversationId ?? conversationId,
			role: "relay" as const,
			inReplyTo: envelope.messageId,
		};
		if (envelope.type === "self.bind") {
			socket.write(encodeNdjsonEnvelope({ ...base, type: "self.result", payload: { operation: "self.bind", status: "ok", boundConversationId: conversationId } }));
		} else if (envelope.type === "attachment.attach") {
			setTimeout(() => {
				if (!socket.destroyed) socket.write(encodeNdjsonEnvelope({ ...base, type: "attachment.accepted", payload: { attachmentId: "attachment-1", state: "active" } }));
			}, this.attachmentDelayMs);
		} else if (envelope.type === "input.acknowledge") {
			socket.write(encodeNdjsonEnvelope({ ...base, type: "input.result", payload: { deliveryId: envelope.payload.deliveryId, status: envelope.payload.status } }));
		} else if (envelope.type === "media.reject") {
			socket.write(encodeNdjsonEnvelope({ ...base, type: "media.result", payload: { deliveryId: envelope.payload.deliveryId, blobId: envelope.payload.blobId, status: "rejected" } }));
		} else if (envelope.type === "control.result") {
			socket.write(encodeNdjsonEnvelope({ ...base, type: "self.result", payload: { operation: "control.result", status: "ok" } }));
		} else if (envelope.type === "activity.update" || envelope.type === "activity.finalize") {
			socket.write(encodeNdjsonEnvelope({ ...base, type: "activity.acknowledge", payload: { activityId: envelope.payload.activityId, revision: envelope.payload.revision, status: envelope.type === "activity.finalize" ? "finalized" : "updated" } }));
		} else if (envelope.type === "checkpoint.offer") {
			socket.write(encodeNdjsonEnvelope({ ...base, type: "checkpoint.acknowledge", payload: { checkpointId: envelope.payload.checkpointId, status: "projected" } }));
		} else if (envelope.type === "aloop.notice") {
			socket.write(encodeNdjsonEnvelope({ ...base, type: "aloop.acknowledge", payload: { lifecycleId: envelope.payload.lifecycleId, status: "projected" } }));
		} else if (envelope.type === "transcript.offer") {
			setTimeout(() => {
				if (!socket.destroyed) socket.write(encodeNdjsonEnvelope({ ...base, type: "transcript.acknowledge", payload: { entryId: envelope.payload.entryId, status: "projected" } }));
			}, this.transcriptDelayMs);
		} else if (envelope.type === "self.status") {
			if (this.selfStatusDelayMs >= 0) setTimeout(() => {
				if (!socket.destroyed) socket.write(encodeNdjsonEnvelope({ ...base, type: "self.result", payload: { operation: "self.status", status: "ok", conversationState: "active" } }));
			}, this.selfStatusDelayMs);
		} else if (envelope.type === "self.delete") {
			socket.write(encodeNdjsonEnvelope({ ...base, type: "self.result", payload: { operation: "self.delete", status: "ok" } }));
		} else if (envelope.type === "lifecycle.request") {
			setTimeout(() => socket.write(encodeNdjsonEnvelope({ ...base, type: "lifecycle.result", payload: {
				operation: "workspace.list", workspaces: [{ rootKey: "projects", workspace: "pi-harness" }],
			} })), this.lifecycleDelayMs);
		}
	}
}

test("binding and delivery history restore fail closed without fork inheritance", () => {
	const entries = [custom("a", BINDING_ENTRY_TYPE, binding)];
	assert.deepEqual(restoreSessionBinding(entries, sessionId, "ordinary_adapter"), binding);
	assert.equal(restoreSessionBinding(entries, "fork-session", "ordinary_adapter"), undefined);
	assert.throws(() => restoreSessionBinding(entries, sessionId, "coordinator_adapter"), /role mismatch/);
	assert.throws(() => restoreSessionBinding([...entries, custom("conflict", BINDING_ENTRY_TYPE, {
		...binding, conversationId: deriveConversationId("host", "other"),
	})], sessionId, "ordinary_adapter"), /Conflicting/);
	assert.equal(restoreSessionBinding([...entries, custom("b", UNBOUND_ENTRY_TYPE, { version: MANAGED_SESSION_STATE_VERSION, sessionId })], sessionId, "ordinary_adapter"), undefined);
	const attemptEntry = custom("boundary-key", BINDING_BOUNDARY_ENTRY_TYPE, {
		version: MANAGED_SESSION_STATE_VERSION, creationKey: "manual-stable", concept: "work", sessionId,
	});
	assert.deepEqual(restoreBindingAttempt([attemptEntry], sessionId, "work"),
		{ version: MANAGED_SESSION_STATE_VERSION, creationKey: "manual-stable", concept: "work", sessionId, entryKey: "boundary-key" });
	assert.equal(restoreBindingAttempt([
		attemptEntry,
		custom("unbound", UNBOUND_ENTRY_TYPE, { version: MANAGED_SESSION_STATE_VERSION, sessionId }),
	], sessionId, "work"), undefined);

	const deliveryId = deriveDeliveryId(conversationId, "$event");
	const accepted = { version: MANAGED_SESSION_STATE_VERSION, deliveryId, matrixEventId: "$event", kind: "prompt", status: "accepted" } as const;
	const persisted = { ...accepted, status: "persisted" as const, expandedText: "hello", piEntryId: deriveTranscriptEntryId(sessionId, "entry") };
	assert.equal(restoreDeliveries([custom("c", DELIVERY_ENTRY_TYPE, accepted), custom("d", DELIVERY_ENTRY_TYPE, persisted)]).get(deliveryId)?.status, "persisted");
	assert.equal(findDeliveredUserEntry([
		custom("expanded-parent", DELIVERY_ENTRY_TYPE, { ...accepted, status: "expanded", expandedText: "same text" }),
		{ type: "message", id: "unrelated", parentId: "elsewhere", message: { role: "user", content: "same text" } },
		{ type: "message", id: "delivered", parentId: "expanded-parent", message: { role: "user", content: "same text" } },
	], deliveryId), "delivered");
	assert.throws(() => restoreDeliveries([custom("c", DELIVERY_ENTRY_TYPE, persisted), custom("d", DELIVERY_ENTRY_TYPE, accepted)]), /Conflicting/);
	assert.equal(restoreDeliveries([
		custom("c", DELIVERY_ENTRY_TYPE, persisted),
		custom("deleted", UNBOUND_ENTRY_TYPE, { version: MANAGED_SESSION_STATE_VERSION, sessionId }),
		custom("rebound", BINDING_ENTRY_TYPE, { ...binding, conversationId: deriveConversationId("host", "rebound") }),
	]).size, 0);
});

test("transcript classification is boundary-ordered, provenance-aware, and final-only", () => {
	const matrixDeliveryId = deriveDeliveryId(conversationId, "$matrix");
	const matrixUserKey = "matrix-user";
	const matrixEntryId = deriveTranscriptEntryId(sessionId, matrixUserKey);
	const delivery = {
		version: MANAGED_SESSION_STATE_VERSION, deliveryId: matrixDeliveryId, matrixEventId: "$matrix", kind: "prompt" as const,
		status: "persisted" as const, expandedText: "from matrix", piEntryId: matrixEntryId,
	};
	const expandedDelivery = { ...delivery, status: "expanded" as const, piEntryId: undefined };
	const preAcknowledgementBranch = [
		custom("boundary", BINDING_BOUNDARY_ENTRY_TYPE, { version: MANAGED_SESSION_STATE_VERSION }),
		custom("expanded", DELIVERY_ENTRY_TYPE, expandedDelivery),
		{ type: "message", id: matrixUserKey, parentId: "expanded", message: { role: "user", content: [{ type: "text", text: "from matrix" }] } },
	];
	const boundaryBinding = { ...binding, bindingBoundaryEntryId: deriveTranscriptEntryId(sessionId, "boundary") };
	assert.deepEqual(eligibleTranscriptEntries(preAcknowledgementBranch, boundaryBinding,
		new Map([[matrixDeliveryId, expandedDelivery]])), []);
	const branch = [
		{ type: "message", id: "before", message: { role: "assistant", content: [{ type: "text", text: "secret" }], stopReason: "stop" } },
		custom("boundary", BINDING_BOUNDARY_ENTRY_TYPE, { version: MANAGED_SESSION_STATE_VERSION }),
		{ type: "message", id: matrixUserKey, message: { role: "user", content: [{ type: "text", text: "from matrix" }] } },
		{ type: "message", id: "local-user", message: { role: "user", content: "terminal **input**" } },
		{ type: "message", id: "tool-step", message: { role: "assistant", content: [{ type: "toolCall", name: "read" }], stopReason: "toolUse" } },
		{ type: "message", id: "truncated", message: { role: "assistant", content: [{ type: "text", text: "partial limit output" }], stopReason: "length" } },
		{ type: "message", id: "final", message: { role: "assistant", content: [{ type: "thinking", thinking: "private" }, { type: "text", text: "final answer" }], stopReason: "stop" } },
		{ type: "compaction", id: "compact", summary: "private summary" },
	];
	assert.deepEqual(eligibleTranscriptEntries(branch, boundaryBinding, new Map([[matrixDeliveryId, delivery]])), [
		{ entryId: deriveTranscriptEntryId(sessionId, "local-user"), piEntryKey: "local-user", kind: "local_user", body: "terminal **input**" },
		{ entryId: deriveTranscriptEntryId(sessionId, "final"), piEntryKey: "final", kind: "assistant_final", body: "final answer" },
	]);
	const checkpointBranch = [...branch.slice(0, 7), custom("checkpoint", CHECKPOINT_ENTRY_TYPE, {
		version: MANAGED_SESSION_STATE_VERSION, checkpointId: `checkpoint-${"a".repeat(32)}`, originDeliveryId: matrixDeliveryId,
		checkpoint: { kind: "question", decision: "Approve?" }, status: "offered",
	}), { type: "message", id: "duplicate-final", message: { role: "assistant", content: "must not duplicate checkpoint", stopReason: "stop" } },
	{ type: "message", id: "reply", message: { role: "user", content: "new reply" } },
	{ type: "message", id: "reply-final", message: { role: "assistant", content: "resumed answer", stopReason: "stop" } }];
	assert.equal(eligibleTranscriptEntries(checkpointBranch, boundaryBinding, new Map([[matrixDeliveryId, delivery]])).some((entry) => entry.body.includes("duplicate checkpoint")), false);
	assert.equal(eligibleTranscriptEntries(checkpointBranch, boundaryBinding, new Map([[matrixDeliveryId, delivery]])).some((entry) => entry.body === "resumed answer"), true);
	const offered = { version: MANAGED_SESSION_STATE_VERSION, entryId: deriveTranscriptEntryId(sessionId, "final"), piEntryKey: "final", kind: "assistant_final" as const, status: "offered" as const };
	assert.equal(restoreProjections([custom("binding", BINDING_ENTRY_TYPE, binding), custom("offer", PROJECTION_ENTRY_TYPE, offered)]).get(offered.entryId)?.status, "offered");
	assert.equal(restoreProjections([custom("offer", PROJECTION_ENTRY_TYPE, offered), custom("unbound", UNBOUND_ENTRY_TYPE, { version: MANAGED_SESSION_STATE_VERSION })]).size, 0);
	const escapedOffer = { entryId: deriveTranscriptEntryId(sessionId, "escaped"), piEntryKey: "escaped", kind: "local_user" as const, body: "\n\"".repeat(20_000) };
	assert.equal(transcriptOfferWithinFrame(escapedOffer, binding), false, "the complete JSON-escaped NDJSON frame bounds offers");
	assert.equal(transcriptOfferWithinFrame({ ...escapedOffer, body: "short" }, binding), true);
	const excessive = [custom("boundary", BINDING_BOUNDARY_ENTRY_TYPE, {}), ...Array.from({ length: 4_097 }, (_, index) => ({
		type: "message", id: `entry-${index}`, message: { role: "user", content: `local ${index}` },
	}))];
	assert.equal(planTranscriptBackfill(excessive, boundaryBinding, new Map(), new Map()).excessiveCount, 4_097);
	assert.deepEqual(planTranscriptBackfill(excessive, boundaryBinding, new Map(), new Map()).entries, []);
	const diagnostic = custom("diagnostic", PROJECTION_DIAGNOSTIC_ENTRY_TYPE, {
		version: MANAGED_SESSION_STATE_VERSION, bindingBoundaryEntryId: boundaryBinding.bindingBoundaryEntryId,
		pendingCount: 4_097, limit: 4_096, reason: "backfill_limit",
	});
	assert.equal(hasBackfillDiagnostic([...excessive, diagnostic], boundaryBinding, 4_097), true);
	const capacityDiagnostic = custom("capacity", PROJECTION_DIAGNOSTIC_ENTRY_TYPE, {
		version: MANAGED_SESSION_STATE_VERSION, bindingBoundaryEntryId: boundaryBinding.bindingBoundaryEntryId,
		entryId: matrixEntryId, limit: 4_096, reason: "capacity_reached",
	});
	assert.equal(hasProjectionCapacityDiagnostic([...excessive, capacityDiagnostic], boundaryBinding, matrixEntryId), true);
});

test("coordinator lifecycle requests allow the bounded launcher duration", async (t) => {
	const relay = await FakeRelay.start(5_100);
	t.after(() => relay.close());
	const coordinatorBinding = { ...binding, role: "coordinator_adapter" as const };
	const client = new CoordinatorAdapterClient({
		socketPath: relay.socketPath, role: "coordinator_adapter", attachmentNonce: nonce,
		binding: coordinatorBinding, onEnvelope: () => undefined,
	});
	t.after(() => client.close());
	await client.connect();
	const result = await client.lifecycleRequest({ operation: "workspace.list" });
	assert.equal(result.type, "lifecycle.result");
});

test("transcript projection tolerates relay Matrix work beyond the short IPC request timeout", async (t) => {
	const relay = await FakeRelay.start(0, 0, 5_100);
	t.after(() => relay.close());
	const client = new BoundAdapterClient({ socketPath: relay.socketPath, role: "ordinary_adapter", attachmentNonce: nonce, binding,
		onEnvelope: () => undefined });
	t.after(() => client.close());
	await client.connect();
	const entryId = deriveTranscriptEntryId(sessionId, "slow-final");
	const result = await client.offerTranscript({ entryId, piSessionId: sessionId, piEntryKey: "slow-final",
		kind: "assistant_final", body: "A final response delayed by bounded Matrix retry work." });
	assert.equal(result.type, "transcript.acknowledge");
	assert.equal(client.connected, true);
});

test("a valid response arriving just after an IPC timeout does not disconnect the adapter", async (t) => {
	const relay = await FakeRelay.start(0, 0, 0, 5_100);
	t.after(() => relay.close());
	const client = new BoundAdapterClient({ socketPath: relay.socketPath, role: "ordinary_adapter", attachmentNonce: nonce, binding,
		onEnvelope: () => undefined });
	t.after(() => client.close());
	await client.connect();
	await assert.rejects(client.selfStatus(), (error: unknown) => error instanceof ManagedAdapterError && error.code === "timeout");
	await new Promise((resolve) => setTimeout(resolve, 200));
	assert.equal(client.connected, true, "a recognized late correlation is ignored without forcing recovery and transcript backlog");
});

test("a mismatched late correlation fails closed", async (t) => {
	const relay = await FakeRelay.start(0, 0, 0, 6_000);
	t.after(() => relay.close());
	const client = new BoundAdapterClient({ socketPath: relay.socketPath, role: "ordinary_adapter", attachmentNonce: nonce, binding,
		onEnvelope: () => undefined });
	t.after(() => client.close());
	await client.connect();
	await assert.rejects(client.selfStatus(), (error: unknown) => error instanceof ManagedAdapterError && error.code === "timeout");
	const requestId = relay.frames.at(-1)!.messageId;
	relay.send({ protocolVersion: MANAGED_SESSION_PROTOCOL_VERSION, messageId: "mismatched-late-response", conversationId, role: "relay",
		inReplyTo: requestId, type: "input.result", payload: { deliveryId: deriveDeliveryId(conversationId, "$unrelated"), status: "accepted" } });
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(client.connected, false);
});

test("adapter request concurrency is bounded", async (t) => {
	const relay = await FakeRelay.start(0, 0, 0, -1);
	t.after(() => relay.close());
	const client = new BoundAdapterClient({ socketPath: relay.socketPath, role: "ordinary_adapter", attachmentNonce: nonce, binding,
		onEnvelope: () => undefined });
	await client.connect();
	const pending = Array.from({ length: 256 }, () => client.selfStatus());
	await assert.rejects(client.selfStatus(), (error: unknown) => error instanceof ManagedAdapterError && error.code === "capacity_reached");
	await client.close();
	assert.equal((await Promise.allSettled(pending)).every((result) => result.status === "rejected"), true);
});

test("ordinary adapter speaks only fixed role-bound operations and deduplicates request correlation", async (t) => {
	const relay = await FakeRelay.start();
	t.after(() => relay.close());
	const received: ManagedSessionEnvelope[] = [];
	const client = new BoundAdapterClient({ socketPath: relay.socketPath, role: "ordinary_adapter", attachmentNonce: nonce, binding, onEnvelope: (envelope) => { received.push(envelope); } });
	t.after(() => client.close());
	await client.connect();
	assert.equal(client.connected, true);
	assert.equal(relay.frames[0]?.role, "ordinary_adapter");
	assert.equal(relay.frames[0]?.type, "attachment.attach");
	assert.equal("lifecycleRequest" in client, false);
	const deliveryId = deriveDeliveryId(conversationId, "$event");
	relay.send({
		protocolVersion: MANAGED_SESSION_PROTOCOL_VERSION,
		messageId: "delivery-1", conversationId, role: "relay", type: "input.deliver",
		payload: { deliveryId, matrixEventId: "$event", kind: "prompt", body: "hello" },
	});
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(received[0]?.type, "input.deliver");
	await client.acknowledgeInput(deliveryId, "accepted");
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(relay.frames.at(-1)?.type, "input.acknowledge");
	assert.equal(relay.frames.at(-1)?.role, "ordinary_adapter");
	assert.equal((await client.selfDelete()).payload.status, "ok");
	assert.equal(relay.frames.at(-1)?.payload.confirmed, true);
});

test("manual self binding is a strict one-shot relay operation", async (t) => {
	const relay = await FakeRelay.start();
	t.after(() => relay.close());
	assert.equal(await requestSelfBind({
		socketPath: relay.socketPath,
		role: "ordinary_adapter",
		creationKey: "manual-retry-key",
		concept: "work",
		sessionId,
		attachmentNonce: nonce,
		bindingBoundaryEntryId: boundaryEntryId,
		placement: { rootKey: "projects", workspace: "work", relativeCwd: "" },
	}), conversationId);
	assert.equal(relay.frames[0]?.type, "self.bind");
	assert.equal(relay.frames[0]?.conversationId, undefined);
	assert.equal(relay.frames[0]?.payload.attachmentNonce, nonce);
});

test("only the coordinator profile exposes the bounded managed lifecycle tools", () => {
	for (const role of ["ordinary_adapter", "coordinator_adapter"] as const) {
		const commands = new Map<string, unknown>();
		const tools: string[] = [];
		const handlers: string[] = [];
		const api = {
			registerCommand: (name: string, options: unknown) => commands.set(name, options),
			registerTool: (tool: { name: string }) => tools.push(tool.name),
			on: (event: string) => handlers.push(event),
		} as unknown as ExtensionAPI;
		createManagedSessionAdapterExtension(role, { PI_MANAGED_SESSIONS_SOCKET: "/tmp/relay.sock" })(api);
		assert.deepEqual([...commands.keys()], ["remote"]);
		assert.equal(commands.has("remote-off"), false);
		assert.deepEqual(tools, role === "ordinary_adapter" ? ["remote_artifact_export", "remote_checkpoint"] : [
			"remote_workspace_list", "remote_session_list", "remote_session_status", "remote_project_reconcile_preview", "remote_project_reconcile_apply",
			"remote_project_space_cleanup", "remote_project_create", "remote_worktree_list", "remote_worktree_create", "remote_worktree_conversation_create",
			"remote_worktree_remove_preview", "remote_worktree_remove_apply", "remote_worktree_cleanup_preview", "remote_worktree_cleanup_apply",
			"remote_worktree_branch_delete", "remote_session_start", "remote_session_resume", "remote_session_stop", "remote_session_delete",
		]);
		assert.ok(handlers.includes("session_start") && handlers.includes("session_shutdown"));
	}
});

test("a shutdown racing attachment startup cannot reactivate managed conversation tools", async (t) => {
	const relay = await FakeRelay.start(0, 100); t.after(() => relay.close());
	const handlers = new Map<string, (...args: any[]) => any>();
	let activeTools = ["read", "remote_checkpoint", "remote_artifact_export"];
	const api = {
		on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler),
		registerCommand: () => undefined, registerTool: () => undefined, getCommands: () => [], appendEntry: () => undefined,
		getActiveTools: () => activeTools, setActiveTools: (tools: string[]) => { activeTools = tools; },
	} as unknown as ExtensionAPI;
	createManagedSessionAdapterExtension("ordinary_adapter", { PI_MANAGED_SESSIONS_SOCKET: relay.socketPath, PI_MANAGED_SESSION_ATTACHMENT_NONCE: nonce })(api);
	const branch = [custom("binding", BINDING_ENTRY_TYPE, binding)];
	const ctx: any = { hasUI: false, sessionManager: { getSessionId: () => sessionId, getBranch: () => branch, getLeafId: () => "binding" } };
	const startup = handlers.get("session_start")!({ reason: "resume" }, ctx);
	await new Promise((resolve) => setTimeout(resolve, 20));
	await handlers.get("session_shutdown")!({ reason: "quit" }, ctx);
	await startup;
	assert.deepEqual(activeTools, ["read"]);
});

test("typed runtime controls reject busy mutation and use authenticated scoped native state without prompts", async (t) => {
	const relay = await FakeRelay.start(); t.after(() => relay.close());
	const branch: any[] = [custom("binding", BINDING_ENTRY_TYPE, binding)];
	const handlers = new Map<string, (...args: any[]) => any>();
	let idle = false; let setModelCalls = 0; let thinking = "medium"; let contextTokens = 90; let compactFocus: string | undefined; let promptCalls = 0;
	let activeTools = ["read", "remote_checkpoint", "remote_artifact_export"];
	const models = [
		...Array.from({ length: 25 }, (_, index) => ({ provider: "scoped", id: `model-${index}`, reasoning: false, contextWindow: 100, maxTokens: 10 })),
		...Array.from({ length: 5 }, (_, index) => ({ provider: "small", id: `choice-${index}`, reasoning: false, contextWindow: 100, maxTokens: 10 })),
	];
	const api = { on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler), registerCommand: () => undefined,
		registerTool: () => undefined, getCommands: () => [], appendEntry: () => undefined,
		sendUserMessage: () => { promptCalls += 1; }, sendMessage: () => { promptCalls += 1; },
		setModel: async () => { setModelCalls += 1; return true; }, setThinkingLevel: (level: string) => { thinking = level; }, getThinkingLevel: () => thinking,
		getActiveTools: () => activeTools, setActiveTools: (tools: string[]) => { activeTools = tools; },
	} as unknown as ExtensionAPI;
	createManagedSessionAdapterExtension("ordinary_adapter", { PI_MANAGED_SESSIONS_SOCKET: relay.socketPath, PI_MANAGED_SESSION_ATTACHMENT_NONCE: nonce })(api);
	const ctx: any = { hasUI: false, isIdle: () => idle, abort: () => undefined, shutdown: () => undefined,
		model: models[0], thinkingLevel: thinking, scopedModels: models.map((model) => ({ model })),
		modelRegistry: { getAvailable: () => [...models, { provider: "outside", id: "forbidden", reasoning: false }] },
		getContextUsage: () => ({ tokens: contextTokens }), compact: ({ customInstructions, onComplete }: any) => { compactFocus = customInstructions; contextTokens = 40; onComplete({ estimatedTokensAfter: 40 }); },
		sessionManager: { getSessionId: () => sessionId, getBranch: () => branch, getLeafId: () => "binding", getSessionFile: () => "/tmp/session.jsonl" } };
	await handlers.get("session_start")!({ reason: "resume" }, ctx);
	assert.deepEqual(activeTools, ["read", "remote_checkpoint", "remote_artifact_export"], "managed conversation tools activate only for the live binding");
	const send = async (id: number, name: string, argument?: string) => { relay.send({ protocolVersion: MANAGED_SESSION_PROTOCOL_VERSION,
		messageId: `control-${id}`, conversationId, role: "relay", type: "control.deliver", payload: { controlId: `control_${String(id).padStart(32, "a")}`, name, ...(argument ? { argument } : {}) } } as ManagedSessionEnvelope); await new Promise((resolve) => setTimeout(resolve, 30)); };
	await send(12, "status");
	assert.deepEqual(relay.frames.at(-1)?.payload.liveStatus, { state: "busy", model: "scoped/model-0", thinking: "medium", context: { usedTokens: 90, limitTokens: 100 } });
	await send(1, "model", "scoped/model-1");
	assert.equal(setModelCalls, 0); assert.match(String(relay.frames.at(-1)?.payload.message), /busy/);
	idle = true; await send(2, "model");
	assert.deepEqual(relay.frames.at(-1)?.payload.options, ["!model small"], "only providers whose full authenticated scoped catalogue is bounded are offered");
	await send(9, "model", "small");
	assert.equal((relay.frames.at(-1)?.payload.options as string[]).length, 5, "an offered provider uses exact-provider selection and always yields at most 20 models");
	await send(10, "model", "model-");
	assert.equal(relay.frames.at(-1)?.payload.options, undefined, "a textual subset cannot make an overfull provider eligible when exact selection would expand it");
	assert.match(String(relay.frames.at(-1)?.payload.message), /narrower textual filter/);
	await send(3, "model", "model-1");
	assert.equal((relay.frames.at(-1)?.payload.options as string[]).length, 11, "text filtering narrows the catalogue to a bounded selection follow-up");
	assert.ok((relay.frames.at(-1)?.payload.options as string[]).includes("!model scoped/model-1"));
	await send(8, "model", "outside/forbidden"); assert.equal(setModelCalls, 0);
	await send(4, "model", "scoped/model-1"); assert.equal(setModelCalls, 1);
	assert.deepEqual(relay.frames.at(-1)?.payload.selection, { model: "scoped/model-1" }, "the accepted exact model is returned for durable relay persistence");
	await send(4, "model", "scoped/model-1"); assert.equal(setModelCalls, 1, "replayed control IDs return the durable result without repeating mutation");
	assert.deepEqual(relay.frames.at(-1)?.payload.selection, { model: "scoped/model-1" }, "durable result replay preserves the exact selection");
	await send(5, "thinking", "off"); assert.equal(thinking, "off");
	assert.deepEqual(relay.frames.at(-1)?.payload.selection, { thinking: "off" }, "the accepted exact thinking level is returned for durable relay persistence");
	await send(6, "compact", "focus on controls"); assert.equal(compactFocus, "focus on controls");
	assert.match(String(relay.frames.at(-1)?.payload.message), /90 -> 40/);
	await send(7, "new"); assert.match(String(relay.frames.at(-1)?.payload.message), /!new --confirm/);
	await send(11, "new", "--confirm");
	assert.deepEqual(relay.frames.at(-1)?.payload.generation, { model: "scoped/model-1", thinking: "off" }, "confirmed reset carries only the selected model and thinking metadata");
	assert.equal(promptCalls, 0, "internal controls never enter model-visible message APIs");
	relay.disconnect();
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.deepEqual(activeTools, ["read"], "checkpoint deactivates immediately when the managed binding disconnects");
	await handlers.get("session_shutdown")!({ reason: "quit" }, ctx);
	assert.deepEqual(activeTools, ["read"], "checkpoint remains inactive when the managed binding shuts down");
});

test("durable control marker restoration rejects extra, malformed, and unbounded data", async () => {
	const validId = `control_${"e".repeat(32)}`;
	const malformedMarkers = [
		["pi-managed-session-control-result", null],
		["pi-managed-session-control-result", { controlId: validId, status: "ok", message: "done", extra: true }],
		["pi-managed-session-control-result", { controlId: validId, status: "unknown", message: "done" }],
		["pi-managed-session-control-result", { controlId: validId, status: "ok", message: "" }],
		["pi-managed-session-control-result", { controlId: validId, status: "ok", message: "x".repeat(4_097) }],
		["pi-managed-session-control-result", { controlId: validId, status: "ok", message: "done", options: [] }],
		["pi-managed-session-control-result", { controlId: validId, status: "ok", message: "done", options: Array(21).fill("choice") }],
		["pi-managed-session-control-result", { controlId: validId, status: "ok", message: "done", options: ["x".repeat(256)] }],
		["pi-managed-session-control-result", { controlId: validId, status: "ok", message: "done", selection: {} }],
		["pi-managed-session-control-result", { controlId: validId, status: "ok", message: "done", selection: { model: "x".repeat(257) } }],
		["pi-managed-session-control-result", { controlId: validId, status: "ok", message: "done", selection: { thinking: "x".repeat(33) } }],
		["pi-managed-session-control-result", { controlId: validId, status: "ok", message: "done", selection: { model: "scoped/model", thinking: "high" } }],
		["pi-managed-session-control-result", { controlId: validId, status: "rejected", message: "done", liveStatus: { state: "idle", thinking: "off" } }],
		["pi-managed-session-control-result", { controlId: validId, status: "ok", message: "done", liveStatus: { state: "idle", thinking: "off", context: { usedTokens: 2, limitTokens: 1 } } }],
		["pi-managed-session-control-execution", { controlId: validId, name: "model", argument: "provider/model", state: "started", extra: true }],
		["pi-managed-session-control-execution", { controlId: validId, name: "thinking", argument: "x".repeat(4_097), state: "started" }],
		["pi-managed-session-control-execution", { controlId: validId, name: "model", argument: "", state: "started" }],
		["pi-managed-session-control-execution", [validId, "model", "started"]],
	] as const;
	for (const [index, [customType, data]] of malformedMarkers.entries()) {
		const handlers = new Map<string, (...args: any[]) => any>();
		const branch = [custom("binding", BINDING_ENTRY_TYPE, binding), custom(`bad-${index}`, customType, data)];
		const api = { on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler), registerCommand: () => undefined,
			registerTool: () => undefined, getCommands: () => [], appendEntry: () => undefined } as unknown as ExtensionAPI;
		createManagedSessionAdapterExtension("ordinary_adapter", { PI_MANAGED_SESSIONS_SOCKET: "/tmp/not-used" })(api);
		const ctx: any = { hasUI: false, sessionManager: { getSessionId: () => sessionId, getBranch: () => branch } };
		await assert.rejects(handlers.get("session_start")!({ reason: "resume" }, ctx), /Malformed durable control (result|execution) state/,
			`case ${index} must fail closed`);
	}
});

test("recovered exact model selection is reapplied idempotently while uncertain thinking remains conservative", async (t) => {
	const relay = await FakeRelay.start(); t.after(() => relay.close());
	const modelId = `control_${"f".repeat(32)}`;
	const thinkingId = `control_${"1".repeat(32)}`;
	const branch: any[] = [
		custom("binding", BINDING_ENTRY_TYPE, binding),
		custom("model-started", "pi-managed-session-control-execution", { controlId: modelId, name: "model", argument: "scoped/model", state: "started" }),
		custom("thinking-started", "pi-managed-session-control-execution", { controlId: thinkingId, name: "thinking", argument: "high", state: "started" }),
	];
	const handlers = new Map<string, (...args: any[]) => any>();
	let leaf = "thinking-started"; let setModelCalls = 0; let setThinkingCalls = 0;
	const model = { provider: "scoped", id: "model", reasoning: true, contextWindow: 100, maxTokens: 10 };
	const api = { on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler), registerCommand: () => undefined,
		registerTool: () => undefined, getCommands: () => [], appendEntry: (customType: string, data: unknown) => { leaf = `result-${branch.length}`; branch.push(custom(leaf, customType, data)); },
		setModel: async () => { setModelCalls += 1; return true; }, setThinkingLevel: () => { setThinkingCalls += 1; }, getThinkingLevel: () => "high",
		sendUserMessage: () => undefined, sendMessage: () => undefined } as unknown as ExtensionAPI;
	createManagedSessionAdapterExtension("ordinary_adapter", { PI_MANAGED_SESSIONS_SOCKET: relay.socketPath, PI_MANAGED_SESSION_ATTACHMENT_NONCE: nonce })(api);
	const ctx: any = { hasUI: false, isIdle: () => true, model, thinkingLevel: "high", scopedModels: [{ model }], modelRegistry: { getAvailable: () => [model] },
		getContextUsage: () => undefined, abort: () => undefined, shutdown: () => undefined,
		sessionManager: { getSessionId: () => sessionId, getBranch: () => branch, getLeafId: () => leaf, getSessionFile: () => "/tmp/session.jsonl" } };
	await handlers.get("session_start")!({ reason: "resume" }, ctx);
	relay.send({ protocolVersion: MANAGED_SESSION_PROTOCOL_VERSION, messageId: "model-replay", conversationId, role: "relay", type: "control.deliver",
		payload: { controlId: modelId, name: "model", argument: "scoped/model" } });
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.equal(setModelCalls, 1, "the exact authenticated model mutation is safe to reapply after interruption");
	assert.deepEqual(relay.frames.at(-1)?.payload.selection, { model: "scoped/model" });
	relay.send({ protocolVersion: MANAGED_SESSION_PROTOCOL_VERSION, messageId: "thinking-replay", conversationId, role: "relay", type: "control.deliver",
		payload: { controlId: thinkingId, name: "thinking", argument: "high" } });
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.match(String(relay.frames.at(-1)?.payload.message), /not repeated/i);
	assert.equal(setThinkingCalls, 0, "uncertain recovered thinking selection is not repeated");
	assert.equal(branch.filter((entry) => entry.customType === "pi-managed-session-control-result").length, 2, "recovered outcomes are durable");
	await handlers.get("session_shutdown")!({ reason: "quit" }, ctx);
});

test("durable control execution closes compaction and stop crash windows without repeating compaction", async (t) => {
	const relay = await FakeRelay.start(); t.after(() => relay.close());
	const branch: any[] = [custom("binding", BINDING_ENTRY_TYPE, binding)];
	let sequence = 0; let compactStarts = 0; let aborts = 0; let shutdowns = 0;
	const boot = async () => {
		const handlers = new Map<string, (...args: any[]) => any>();
		let leaf = branch.at(-1)?.id ?? "binding";
		const api = {
			on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler), registerCommand: () => undefined,
			registerTool: () => undefined, getCommands: () => [],
			appendEntry: (customType: string, data: unknown) => { leaf = `control-marker-${++sequence}`; branch.push(custom(leaf, customType, data)); },
			setModel: async () => true, setThinkingLevel: () => undefined, getThinkingLevel: () => "off", sendUserMessage: () => undefined, sendMessage: () => undefined,
		} as unknown as ExtensionAPI;
		createManagedSessionAdapterExtension("ordinary_adapter", { PI_MANAGED_SESSIONS_SOCKET: relay.socketPath, PI_MANAGED_SESSION_ATTACHMENT_NONCE: nonce })(api);
		const ctx: any = { hasUI: false, isIdle: () => true, abort: () => { aborts += 1; }, shutdown: () => { shutdowns += 1; },
			model: undefined, thinkingLevel: "off", scopedModels: [], modelRegistry: { getAvailable: () => [] }, getContextUsage: () => ({ tokens: 80 }),
			compact: () => { compactStarts += 1; /* injected crash/disconnect window: native callback never arrives */ },
			sessionManager: { getSessionId: () => sessionId, getBranch: () => branch, getLeafId: () => leaf, getSessionFile: () => "/tmp/session.jsonl" } };
		await handlers.get("session_start")!({ reason: "resume" }, ctx);
		return { handlers, ctx };
	};
	const compactId = `control_${"c".repeat(32)}`;
	const first = await boot();
	relay.send({ protocolVersion: MANAGED_SESSION_PROTOCOL_VERSION, messageId: "compact-crash", conversationId, role: "relay", type: "control.deliver",
		payload: { controlId: compactId, name: "compact", argument: "durable focus" } });
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.equal(compactStarts, 1);
	assert.ok(branch.some((entry) => entry.customType === "pi-managed-session-control-execution" && entry.data.controlId === compactId), "execution is durable before native compaction starts");
	await first.handlers.get("session_shutdown")!({ reason: "quit" }, first.ctx);

	const recovered = await boot();
	relay.send({ protocolVersion: MANAGED_SESSION_PROTOCOL_VERSION, messageId: "compact-replay", conversationId, role: "relay", type: "control.deliver",
		payload: { controlId: compactId, name: "compact", argument: "durable focus" } });
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.equal(compactStarts, 1, "uncertain compaction is never initiated twice after restart");
	assert.match(String(relay.frames.at(-1)?.payload.message), /interrupted.*not repeated/i);
	await recovered.handlers.get("session_shutdown")!({ reason: "quit" }, recovered.ctx);

	const stopId = `control_${"d".repeat(32)}`;
	branch.push(custom(`control-marker-${++sequence}`, "pi-managed-session-control-execution", { controlId: stopId, name: "stop", state: "started" }));
	branch.push(custom(`control-marker-${++sequence}`, "pi-managed-session-control-result", { controlId: stopId, status: "ok", message: "Managed process stopping; Matrix and Pi history are preserved." }));
	const stopRecovery = await boot();
	relay.send({ protocolVersion: MANAGED_SESSION_PROTOCOL_VERSION, messageId: "stop-replay", conversationId, role: "relay", type: "control.deliver",
		payload: { controlId: stopId, name: "stop" } });
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.equal(aborts, 1); assert.equal(shutdowns, 1, "a crash after the durable stop result resumes the committed stop effect");
	relay.send({ protocolVersion: MANAGED_SESSION_PROTOCOL_VERSION, messageId: "stop-duplicate", conversationId, role: "relay", type: "control.deliver",
		payload: { controlId: stopId, name: "stop" } });
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.equal(aborts, 1); assert.equal(shutdowns, 1, "same-process acknowledgement replay does not repeat the stop effect");
	await stopRecovery.handlers.get("session_shutdown")!({ reason: "quit" }, stopRecovery.ctx);
});

test("activity lifecycle is one redacted busy span across parallel tools, retries, compaction, and follow-ups", async (t) => {
	const relay = await FakeRelay.start(); t.after(() => relay.close());
	const branch: any[] = [
		custom("boundary", BINDING_BOUNDARY_ENTRY_TYPE, { version: MANAGED_SESSION_STATE_VERSION }),
		custom("binding", BINDING_ENTRY_TYPE, binding),
		{ type: "message", id: "terminal-user", parentId: "binding", message: { role: "user", content: "terminal task /private/path" } },
	];
	let leaf = "terminal-user"; let sequence = 0; let contextTokens: number | undefined;
	const handlers = new Map<string, (...args: any[]) => any>();
	const api = {
		on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler), registerCommand: () => undefined,
		registerTool: () => undefined, getCommands: () => [],
		appendEntry: (customType: string, data: unknown) => { const id = `activity-${++sequence}`; branch.push({ ...custom(id, customType, data), parentId: leaf }); leaf = id; },
		sendUserMessage: () => undefined, sendMessage: () => undefined,
	} as unknown as ExtensionAPI;
	createManagedSessionAdapterExtension("ordinary_adapter", { PI_MANAGED_SESSIONS_SOCKET: relay.socketPath, PI_MANAGED_SESSION_ATTACHMENT_NONCE: nonce })(api);
	const ctx: any = { hasUI: false, isIdle: () => true, abort: () => undefined, shutdown: () => undefined,
		model: { provider: "provider", id: "measured-model", contextWindow: 100 }, thinkingLevel: "low",
		getContextUsage: () => contextTokens === undefined ? undefined : { tokens: contextTokens },
		sessionManager: { getSessionId: () => sessionId, getBranch: () => branch, getLeafId: () => leaf,
			getSessionFile: () => "/tmp/session.jsonl", getSessionDir: () => "/tmp" } };
	await handlers.get("session_start")!({ reason: "resume" }, ctx);
	await handlers.get("agent_start")!({}, ctx);
	handlers.get("tool_execution_start")!({ toolCallId: "parallel-1", toolName: "read", args: { path: "/secret/one" } });
	handlers.get("tool_execution_start")!({ toolCallId: "parallel-2", toolName: "read", args: { path: "/secret/two" } });
	handlers.get("tool_execution_end")!({ toolCallId: "parallel-1", toolName: "read", isError: true, result: "private output" });
	handlers.get("tool_execution_end")!({ toolCallId: "parallel-2", toolName: "read", isError: false, result: "private output" });
	handlers.get("tool_execution_start")!({ toolCallId: "retry", toolName: "read", args: { path: "/secret/retry" } });
	handlers.get("tool_execution_end")!({ toolCallId: "retry", toolName: "read", isError: false });
	handlers.get("session_before_compact")!({}); handlers.get("session_compact")!({});
	handlers.get("turn_end")!({ message: { role: "assistant", usage: { input: 12, output: 3 }, stopReason: "toolUse" } });
	await handlers.get("agent_start")!({}, ctx); // A busy follow-up must not create another card.
	handlers.get("turn_end")!({ message: { role: "assistant", usage: { input: 7, output: 5 }, stopReason: "stop" } });
	branch.push({ type: "message", id: "final-answer", parentId: leaf, message: { role: "assistant", content: "persisted final", stopReason: "stop" } }); leaf = "final-answer";
	contextTokens = 40;
	await handlers.get("agent_settled")!({}, ctx);
	const activityFrames = relay.frames.filter((frame) => frame.type.startsWith("activity."));
	const finalFrame = activityFrames.find((frame) => frame.type === "activity.finalize")!;
	const transcriptFrames = relay.frames.filter((frame) => frame.type === "transcript.offer");
	assert.equal(new Set(activityFrames.map((frame) => frame.payload.activityId)).size, 1);
	assert.deepEqual(finalFrame.payload.run, { inputTokens: 19, outputTokens: 8, modelTurns: 2 });
	assert.deepEqual(finalFrame.payload.tools, { total: 3, errors: 1, counts: [{ name: "read", count: 3 }] });
	assert.equal(finalFrame.payload.compactions, 1);
	assert.equal(finalFrame.payload.context, undefined, "delta is omitted when starting context was unavailable");
	assert.equal(finalFrame.payload.generation, 1, "the current single-generation binding reports its deterministic ordinal");
	assert.ok(relay.frames.indexOf(finalFrame) < relay.frames.indexOf(transcriptFrames.find((frame) => frame.payload.kind === "assistant_final")!));
	assert.doesNotMatch(JSON.stringify(activityFrames), /secret|private|path|args|result/);

	branch.push({ type: "message", id: "follow-up-user", parentId: leaf, message: { role: "user", content: "follow up" } }); leaf = "follow-up-user";
	contextTokens = 40; await handlers.get("agent_start")!({}, ctx); contextTokens = 55;
	handlers.get("turn_end")!({ message: { role: "assistant", usage: { input: 2, output: 1 }, stopReason: "error" } });
	branch.push({ type: "message", id: "failed-final", parentId: leaf, message: { role: "assistant", content: "failed", stopReason: "error" } }); leaf = "failed-final";
	await handlers.get("agent_settled")!({}, ctx);
	const secondFinal = relay.frames.filter((frame) => frame.type === "activity.finalize").at(-1)!;
	assert.equal(secondFinal.payload.outcome, "failed");
	assert.deepEqual(secondFinal.payload.context, { usedTokens: 55, remainingTokens: 45, limitTokens: 100, deltaTokens: 15 });
	await handlers.get("session_shutdown")!({ reason: "quit" }, ctx);
});

test("durable aloop lifecycle scope protects persisted finals across restart", () => {
	const start = createAloopLifecycleEvent("startup", 53, "Aloop started for epic #53.", 66);
	const checkpoint = createAloopLifecycleEvent("checkpoint", 53, "Aloop needs a decision.", 66);
	const stop = createAloopLifecycleEvent("bounded-stop", 53, "Aloop settled.", 66);
	const decisionDelivery = { version: MANAGED_SESSION_STATE_VERSION, deliveryId: deriveDeliveryId(conversationId, "$decision"), matrixEventId: "$decision", kind: "prompt", status: "accepted" };
	const nextDelivery = { version: MANAGED_SESSION_STATE_VERSION, deliveryId: deriveDeliveryId(conversationId, "$next"), matrixEventId: "$next", kind: "prompt", status: "accepted" };
	const branch = [custom("start", ALOOP_LIFECYCLE_ENTRY_TYPE, start),
		{ type: "message", id: "private-before-crash", message: { role: "assistant", content: "secret", stopReason: "stop" } },
		custom("checkpoint", ALOOP_LIFECYCLE_ENTRY_TYPE, checkpoint), custom("decision-delivery", DELIVERY_ENTRY_TYPE, decisionDelivery),
		{ type: "message", id: "private-decision-continuation", message: { role: "assistant", content: "continue aloop", stopReason: "stop" } },
		custom("stop", ALOOP_LIFECYCLE_ENTRY_TYPE, stop), custom("next-delivery", DELIVERY_ENTRY_TYPE, nextDelivery),
		{ type: "message", id: "ordinary-after", message: { role: "assistant", content: "public", stopReason: "stop" } }];
	assert.deepEqual([...aloopPrivateAssistantEntryKeys(branch)], ["private-before-crash", "private-decision-continuation"]);
});

test("managed aloop projects only durable lifecycle summaries and hides routine internals", async (t) => {
	const relay = await FakeRelay.start(); t.after(() => relay.close());
	const branch: any[] = [custom("boundary", BINDING_BOUNDARY_ENTRY_TYPE, { version: MANAGED_SESSION_STATE_VERSION }), custom("binding", BINDING_ENTRY_TYPE, binding)];
	let leaf = "binding"; let sequence = 0;
	const handlers = new Map<string, (...args: any[]) => any>();
	const api = {
		on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler), registerCommand: () => undefined,
		registerTool: () => undefined, getCommands: () => [],
		appendEntry: (customType: string, data: unknown) => { const id = `aloop-${++sequence}`; branch.push({ ...custom(id, customType, data), parentId: leaf }); leaf = id; },
		sendUserMessage: () => undefined, sendMessage: () => undefined,
	} as unknown as ExtensionAPI;
	createManagedSessionAdapterExtension("ordinary_adapter", { PI_MANAGED_SESSIONS_SOCKET: relay.socketPath, PI_MANAGED_SESSION_ATTACHMENT_NONCE: nonce })(api);
	const ctx: any = { hasUI: false, isIdle: () => true, abort: () => undefined, shutdown: () => undefined,
		model: { provider: "provider", id: "supervisor", contextWindow: 100 }, getContextUsage: () => ({ tokens: 10 }),
		sessionManager: { getSessionId: () => sessionId, getBranch: () => branch, getLeafId: () => leaf,
			getSessionFile: () => "/tmp/session.jsonl", getSessionDir: () => "/tmp" } };
	await handlers.get("session_start")!({ reason: "resume" }, ctx);
	await handlers.get("agent_start")!({}, ctx);
	const lifecycle = createAloopLifecycleEvent("startup", 53, "Aloop started for #53. Selected child: #66. Shared budget: 60 minutes and 20 launches.", 66, sessionId);
	api.appendEntry(ALOOP_LIFECYCLE_ENTRY_TYPE, lifecycle);
	publishAloopLifecycleEvent(lifecycle);
	publishAloopLifecycleEvent(createAloopLifecycleEvent("startup", 99, "Foreign aloop.", 100, "foreign-session"));
	publishAloopLifecycleEvent(createAloopLifecycleEvent("recovery", 53, "Undurable event must not project.", 66, sessionId));
	handlers.get("tool_execution_start")!({ toolCallId: "worker", toolName: "aloop_launch_worker" });
	handlers.get("tool_execution_end")!({ toolCallId: "worker", toolName: "aloop_launch_worker", isError: false });
	handlers.get("tool_execution_start")!({ toolCallId: "review", toolName: "review_agents" });
	handlers.get("tool_execution_end")!({ toolCallId: "review", toolName: "review_agents", isError: false });
	branch.push({ type: "message", id: "private-final", parentId: leaf, message: { role: "assistant", content: "Worker log /tmp/private and receipt verify-secret", stopReason: "stop" } }); leaf = "private-final";
	await handlers.get("agent_settled")!({}, ctx);
	const notices = relay.frames.filter((frame) => frame.type === "aloop.notice");
	assert.equal(notices.length, 1); assert.equal(notices[0]?.payload.body, lifecycle.body);
	assert.equal(relay.frames.filter((frame) => frame.type === "transcript.offer" && frame.payload.kind === "assistant_final").length, 0);
	const finalActivity = relay.frames.filter((frame) => frame.type === "activity.finalize").at(-1)!;
	assert.deepEqual((finalActivity.payload.tools as any).counts, [{ name: "aloop", count: 2 }]);
	assert.doesNotMatch(JSON.stringify(relay.frames), /private-final|\/tmp\/private|verify-secret|review_agents|aloop_launch_worker/);
	assert.ok(branch.some((entry) => entry.customType === ALOOP_LIFECYCLE_PROJECTION_ENTRY_TYPE && entry.data.lifecycleId === lifecycle.lifecycleId));
	assert.ok(branch.some((entry) => entry.customType === PROJECTION_ENTRY_TYPE && entry.data.reason === "aloop_private"));
	const abortOrder: string[] = [];
	ctx.abort = () => abortOrder.push("signal-abort");
	const unregisterAbort = registerManagedAloopAbortDelegate(sessionId, () => abortOrder.push("aloop-deactivate"));
	relay.send({ protocolVersion: MANAGED_SESSION_PROTOCOL_VERSION, messageId: "managed-abort", conversationId, role: "relay", type: "input.deliver",
		payload: { deliveryId: deriveDeliveryId(conversationId, "$managed-abort"), matrixEventId: "$managed-abort", kind: "abort" } });
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.deepEqual(abortOrder, ["signal-abort", "aloop-deactivate"]);
	unregisterAbort();
	await handlers.get("session_shutdown")!({ reason: "quit" }, ctx);
});

test("managed adapter preserves idle/follow-up/steer expansion and hard checkpoint boundaries", async (t) => {
	const relay = await FakeRelay.start(); t.after(() => relay.close());
	const branch: any[] = [custom("boundary", BINDING_BOUNDARY_ENTRY_TYPE, { version: MANAGED_SESSION_STATE_VERSION }), custom("binding", BINDING_ENTRY_TYPE, binding)];
	let leaf = "binding"; let sequence = 0; let idle = true; let aborts = 0;
	const handlers = new Map<string, (...args: any[]) => any>(); const tools = new Map<string, any>();
	const deliveriesSeen: Array<{ text: string; deliverAs?: string }> = [];
	const api = {
		on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler),
		registerCommand: () => undefined,
		registerTool: (tool: any) => tools.set(tool.name, tool),
		getCommands: () => [],
		appendEntry: (customType: string, data: unknown) => { const id = `custom-${++sequence}`; branch.push({ ...custom(id, customType, data), parentId: leaf }); leaf = id; },
		sendUserMessage: (text: string, options: any) => { deliveriesSeen.push({ text, ...(options.deliverAs ? { deliverAs: options.deliverAs } : {}) }); options.onPromptExpanded(text);
			const id = `user-${++sequence}`; branch.push({ type: "message", id, parentId: leaf, message: { role: "user", content: text } }); leaf = id; },
		sendMessage: () => undefined,
	} as unknown as ExtensionAPI;
	createManagedSessionAdapterExtension("ordinary_adapter", { PI_MANAGED_SESSIONS_SOCKET: relay.socketPath,
		PI_MANAGED_SESSION_ATTACHMENT_NONCE: nonce })(api);
	const ctx: any = { hasUI: false, isIdle: () => idle, abort: () => { aborts += 1; }, shutdown: () => undefined, getContextUsage: () => undefined,
		sessionManager: { getSessionId: () => sessionId, getBranch: () => branch, getLeafId: () => leaf,
			getSessionFile: () => "/tmp/session.jsonl", getSessionDir: () => "/tmp" } };
	await handlers.get("session_start")!({ reason: "resume" }, ctx);
	const send = async (eventId: string, kind: "prompt" | "steer", body: string, senderUserId?: string) => {
		relay.send({ protocolVersion: MANAGED_SESSION_PROTOCOL_VERSION, messageId: `relay-${eventId.replace(/[^A-Za-z0-9]/g, "")}`, conversationId, role: "relay", type: "input.deliver",
			payload: { deliveryId: deriveDeliveryId(conversationId, eventId), matrixEventId: eventId, ...(senderUserId ? { senderUserId } : {}), kind, body } });
		await new Promise((resolve) => setTimeout(resolve, 30));
	};
	await send("$idle", "prompt", "idle task", "@alice:example.com");
	await handlers.get("agent_start")!({}, ctx);
	assert.ok(tools.has("remote_checkpoint"));
	await assert.rejects(() => tools.get("remote_checkpoint").execute("malformed-checkpoint", {}, undefined, undefined, ctx), /kind must be/);
	assert.equal(relay.frames.filter((frame) => frame.type === "checkpoint.offer").length, 0,
		"malformed local-model arguments fail before durable relay or Matrix side effects");
	const delegated = await delegateManagedAloopCheckpoint(sessionId, "tool-call-stable", { kind: "question", decision: "Approve?" });
	assert.equal(delegated, true); assert.equal(aborts, 1);
	assert.equal(relay.frames.filter((frame) => frame.type === "checkpoint.offer").length, 1);
	handlers.get("turn_end")!({ message: { role: "assistant", usage: { input: 1, output: 1 }, stopReason: "error" } });
	await handlers.get("agent_settled")!({}, ctx);
	assert.equal(relay.frames.filter((frame) => frame.type === "activity.finalize").at(-1)?.payload.outcome, "checkpoint",
		"the intentional hard stop cannot overwrite a projected checkpoint with a generic model error");
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.ok(relay.frames.some((frame) => frame.type === "input.acknowledge" && frame.payload.status === "completed"));
	idle = false; await send("$follow", "prompt", "busy follow-up"); await send("$steer", "steer", "redirect");
	assert.deepEqual(deliveriesSeen, [{ text: "Matrix participant @alice:example.com:\n\nidle task" },
		{ text: "busy follow-up", deliverAs: "followUp" }, { text: "redirect", deliverAs: "steer" }]);
	assert.equal(restoreDeliveries(branch).get(deriveDeliveryId(conversationId, "$idle"))?.senderUserId, "@alice:example.com");
	await handlers.get("session_shutdown")!({ reason: "quit" }, ctx);

	const recoveryId = deriveDeliveryId(conversationId, "$persisted-crash");
	const expandedCrashId = deriveDeliveryId(conversationId, "$expanded-crash");
	const recoveryBranch: any[] = [custom("boundary", BINDING_BOUNDARY_ENTRY_TYPE, { version: MANAGED_SESSION_STATE_VERSION }),
		custom("binding", BINDING_ENTRY_TYPE, binding), custom("persisted", DELIVERY_ENTRY_TYPE, {
			version: MANAGED_SESSION_STATE_VERSION, deliveryId: recoveryId, matrixEventId: "$persisted-crash", kind: "prompt", status: "persisted",
			expandedText: "unfinished", piEntryId: deriveTranscriptEntryId(sessionId, "unfinished-user"),
		}), custom("expanded-crash", DELIVERY_ENTRY_TYPE, { version: MANAGED_SESSION_STATE_VERSION, deliveryId: expandedCrashId,
			matrixEventId: "$expanded-crash", kind: "prompt", status: "expanded", expandedText: "expanded but not persisted" })];
	let resumeTriggers = 0; let reinjectedExpanded = 0; let recoveryLeaf = "expanded-crash";
	const recoveryHandlers = new Map<string, (...args: any[]) => any>();
	const recoveryApi = { on: (name: string, handler: (...args: any[]) => any) => recoveryHandlers.set(name, handler), registerCommand: () => undefined,
		registerTool: () => undefined, getCommands: () => [], appendEntry: (customType: string, data: unknown) => { const id = `recovery-${++sequence}`;
			recoveryBranch.push({ ...custom(id, customType, data), parentId: recoveryLeaf }); recoveryLeaf = id; },
		sendMessage: (_message: unknown, options: { triggerTurn?: boolean }) => { if (options.triggerTurn) resumeTriggers += 1; },
		sendUserMessage: (text: string, options: { onPromptExpanded?: (text: string) => void }) => { reinjectedExpanded += 1; options.onPromptExpanded?.(text);
			const id = `recovery-user-${++sequence}`; recoveryBranch.push({ type: "message", id, parentId: recoveryLeaf, message: { role: "user", content: text } }); recoveryLeaf = id; } } as unknown as ExtensionAPI;
	createManagedSessionAdapterExtension("ordinary_adapter", { PI_MANAGED_SESSIONS_SOCKET: relay.socketPath, PI_MANAGED_SESSION_ATTACHMENT_NONCE: nonce })(recoveryApi);
	const recoveryCtx: any = { ...ctx, sessionManager: { ...ctx.sessionManager, getBranch: () => recoveryBranch, getLeafId: () => recoveryLeaf } };
	await recoveryHandlers.get("session_start")!({ reason: "resume" }, recoveryCtx);
	assert.equal(resumeTriggers, 1, "persisted unfinished delivery resumes without reinjecting its Pi user entry");
	assert.equal(reinjectedExpanded, 1, "expanded-before-persistence crash is reinjected exactly once from its durable expansion");
	await recoveryHandlers.get("session_shutdown")!({ reason: "quit" }, recoveryCtx);
});

test("managed images become one ordered text-plus-image turn and unsupported models reject without fallback", async (t) => {
	const relay = await FakeRelay.start(); t.after(() => relay.close());
	const makeAdapter = async (imageCapable: boolean, adapterRole: "ordinary_adapter" | "coordinator_adapter" = "ordinary_adapter") => {
		const adapterBinding = { ...binding, role: adapterRole };
		const branch: any[] = [custom("boundary", BINDING_BOUNDARY_ENTRY_TYPE, { version: MANAGED_SESSION_STATE_VERSION }), custom("binding", BINDING_ENTRY_TYPE, adapterBinding)];
		let leaf = "binding"; let sequence = 0; const handlers = new Map<string, (...args: any[]) => any>(); const sent: unknown[] = [];
		const api = { on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler), registerCommand: () => undefined,
			registerTool: () => undefined, getCommands: () => [], getActiveTools: () => [], setActiveTools: () => undefined,
			appendEntry: (customType: string, data: unknown) => { const id = `media-${++sequence}`; branch.push({ ...custom(id, customType, data), parentId: leaf }); leaf = id; },
			sendMessage: () => undefined,
			sendUserMessage: (content: unknown, options: { onPromptExpanded?: (text: string) => void }) => { sent.push(content);
				options.onPromptExpanded?.(String((content as Array<{ type: string; text?: string }>)[0]?.text));
				const id = `media-user-${++sequence}`; branch.push({ type: "message", id, parentId: leaf, message: { role: "user", content } }); leaf = id; },
		} as unknown as ExtensionAPI;
		createManagedSessionAdapterExtension(adapterRole, { PI_MANAGED_SESSIONS_SOCKET: relay.socketPath, PI_MANAGED_SESSION_ATTACHMENT_NONCE: nonce })(api);
		const ctx: any = { hasUI: false, isIdle: () => true, abort: () => undefined, shutdown: () => undefined,
			model: { provider: "test", id: "model", input: imageCapable ? ["text", "image"] : ["text"], contextWindow: 10_000 },
			getContextUsage: () => ({ tokens: 1 }), sessionManager: { getSessionId: () => sessionId, getBranch: () => branch,
				getLeafId: () => leaf, getSessionFile: () => "/tmp/session.jsonl", getSessionDir: () => "/tmp" } };
		await handlers.get("session_start")!({ reason: "resume" }, ctx);
		return { branch, handlers, ctx, sent };
	};
	const bytes = Buffer.from("normalized-image"); const sha256 = createHash("sha256").update(bytes).digest("hex");
	const deliveryId = deriveDeliveryId(conversationId, "$image"); const blobId = `blob_${"a".repeat(32)}`;
	const begin = () => ({ protocolVersion: MANAGED_SESSION_PROTOCOL_VERSION, messageId: `begin-${Date.now()}`, conversationId, role: "relay" as const, type: "media.begin",
		payload: { deliveryId, matrixEventId: "$image", senderUserId: "@signal_123:example.com", blobId, sha256, mimeType: "image/png", byteLength: bytes.length, width: 1, height: 1, chunkCount: 1, caption: "caption" } });
	const push = async () => {
		relay.send(begin());
		relay.send({ protocolVersion: MANAGED_SESSION_PROTOCOL_VERSION, messageId: `chunk-${Date.now()}`, conversationId, role: "relay", type: "media.chunk",
			payload: { deliveryId, blobId, index: 0, sha256, data: bytes.toString("base64") } });
		await new Promise((resolve) => setTimeout(resolve, 30));
	};
	const capable = await makeAdapter(true);
	relay.send(begin()); relay.disconnect();
	await new Promise((resolve) => setTimeout(resolve, 400));
	await push();
	assert.equal(capable.sent.length, 1);
	assert.deepEqual(capable.sent[0], [{ type: "text", text: "Matrix participant @signal_123:example.com:\n\ncaption" },
		{ type: "image", data: bytes.toString("base64"), mimeType: "image/png" }]);
	await capable.handlers.get("agent_settled")!({}, capable.ctx);
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.ok(relay.frames.some((frame) => frame.type === "input.acknowledge" && frame.payload.deliveryId === deliveryId && frame.payload.status === "completed"));
	await push();
	assert.equal(capable.sent.length, 1, "replayed media after durable completion does not inject a duplicate Pi turn");
	await capable.handlers.get("session_shutdown")!({ reason: "quit" }, capable.ctx);

	const coordinator = await makeAdapter(true, "coordinator_adapter"); await push();
	assert.equal(coordinator.sent.length, 1, "authorized coordinator-room images use the same ordered Pi image path");
	await coordinator.handlers.get("session_shutdown")!({ reason: "quit" }, coordinator.ctx);

	const unsupported = await makeAdapter(false); await push();
	assert.equal(unsupported.sent.length, 0);
	assert.ok(relay.frames.some((frame) => frame.type === "media.reject" && frame.payload.reason === "unsupported_model"));
	await unsupported.handlers.get("session_shutdown")!({ reason: "quit" }, unsupported.ctx);
});
