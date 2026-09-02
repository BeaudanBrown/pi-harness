import assert from "node:assert/strict";
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
import { BoundAdapterClient, CoordinatorAdapterClient, requestSelfBind } from "../config/agent/extensions/managed-sessions/adapter/client.js";
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

	private constructor(root: string, private readonly lifecycleDelayMs = 0) {
		this.root = root;
		this.socketPath = join(root, "relay.sock");
	}

	static async start(lifecycleDelayMs = 0): Promise<FakeRelay> {
		const relay = new FakeRelay(await mkdtemp(join(tmpdir(), "pi-adapter-relay-")), lifecycleDelayMs);
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
			socket.write(encodeNdjsonEnvelope({ ...base, type: "attachment.accepted", payload: { attachmentId: "attachment-1", state: "active" } }));
		} else if (envelope.type === "input.acknowledge") {
			socket.write(encodeNdjsonEnvelope({ ...base, type: "input.result", payload: { deliveryId: envelope.payload.deliveryId, status: envelope.payload.status } }));
		} else if (envelope.type === "activity.update" || envelope.type === "activity.finalize") {
			socket.write(encodeNdjsonEnvelope({ ...base, type: "activity.acknowledge", payload: { activityId: envelope.payload.activityId, revision: envelope.payload.revision, status: envelope.type === "activity.finalize" ? "finalized" : "updated" } }));
		} else if (envelope.type === "checkpoint.offer") {
			socket.write(encodeNdjsonEnvelope({ ...base, type: "checkpoint.acknowledge", payload: { checkpointId: envelope.payload.checkpointId, status: "projected" } }));
		} else if (envelope.type === "transcript.offer") {
			socket.write(encodeNdjsonEnvelope({ ...base, type: "transcript.acknowledge", payload: { entryId: envelope.payload.entryId, status: "projected" } }));
		} else if (envelope.type === "self.status") {
			socket.write(encodeNdjsonEnvelope({ ...base, type: "self.result", payload: { operation: "self.status", status: "ok", conversationState: "active" } }));
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
		assert.deepEqual(tools, role === "ordinary_adapter" ? ["remote_checkpoint"] : [
			"remote_workspace_list", "remote_session_list", "remote_session_status", "remote_session_start",
			"remote_session_resume", "remote_session_stop", "remote_session_delete", "remote_checkpoint",
		]);
		assert.ok(handlers.includes("session_start") && handlers.includes("session_shutdown"));
	}
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
	const ctx: any = { hasUI: false, isIdle: () => idle, abort: () => { aborts += 1; }, shutdown: () => undefined,
		sessionManager: { getSessionId: () => sessionId, getBranch: () => branch, getLeafId: () => leaf,
			getSessionFile: () => "/tmp/session.jsonl", getSessionDir: () => "/tmp" } };
	await handlers.get("session_start")!({ reason: "resume" }, ctx);
	const send = async (eventId: string, kind: "prompt" | "steer", body: string) => {
		relay.send({ protocolVersion: MANAGED_SESSION_PROTOCOL_VERSION, messageId: `relay-${eventId.replace(/[^A-Za-z0-9]/g, "")}`, conversationId, role: "relay", type: "input.deliver",
			payload: { deliveryId: deriveDeliveryId(conversationId, eventId), matrixEventId: eventId, kind, body } });
		await new Promise((resolve) => setTimeout(resolve, 30));
	};
	await send("$idle", "prompt", "idle task");
	const checkpoint = tools.get("remote_checkpoint");
	const checkpointResult = await checkpoint.execute("tool-call-stable", { kind: "question", decision: "Approve?" }, undefined, undefined, ctx);
	assert.equal(checkpointResult.details.waiting, true); assert.equal(aborts, 1);
	assert.equal(relay.frames.filter((frame) => frame.type === "checkpoint.offer").length, 1);
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.ok(relay.frames.some((frame) => frame.type === "input.acknowledge" && frame.payload.status === "completed"));
	idle = false; await send("$follow", "prompt", "busy follow-up"); await send("$steer", "steer", "redirect");
	assert.deepEqual(deliveriesSeen, [{ text: "idle task" }, { text: "busy follow-up", deliverAs: "followUp" }, { text: "redirect", deliverAs: "steer" }]);
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
