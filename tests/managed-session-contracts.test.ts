import assert from "node:assert/strict";
import test from "node:test";
import {
	MANAGED_SESSION_PROTOCOL_VERSION,
	MANAGED_SESSION_STATE_VERSION,
	MAX_NDJSON_FRAME_BYTES,
	ManagedSessionContractError,
	deriveChunkId,
	deriveConversationId,
	deriveDeliveryId,
	deriveMatrixTransactionId,
	deriveTranscriptEntryId,
	encodeNdjsonEnvelope,
	parseConversationManifest,
	parseHostRuntimeState,
	parseManagedSessionEnvelope,
	parseNdjsonEnvelope,
	parsePersistenceBundle,
} from "../config/agent/extensions/managed-sessions/contracts.js";

const hostId = "grill";
const conversationId = deriveConversationId(hostId, "coordinator");
const entryId = deriveTranscriptEntryId("pi-session-1", "entry-1");
const deliveryId = deriveDeliveryId(conversationId, "$matrix-event");

function attachEnvelope() {
	return {
		protocolVersion: MANAGED_SESSION_PROTOCOL_VERSION,
		messageId: "message-1",
		conversationId,
		role: "ordinary_adapter",
		type: "attachment.attach",
		payload: {
			sessionId: "pi-session-1",
			attachmentNonce: "abcdefghijklmnopqrstuvwxyzABCDEF",
			bindingBoundaryEntryId: entryId,
		},
	};
}

function manifest(overrides: Record<string, unknown> = {}) {
	return {
		schemaVersion: MANAGED_SESSION_STATE_VERSION,
		kind: "project",
		conversationId,
		ownerHostId: hostId,
		creationKey: "coordinator",
		concept: "contracts",
		piSessionId: "pi-session-1",
		roomId: "!room:example.com",
		placement: { rootKey: "projects", workspace: "pi-harness", relativeCwd: "packages/relay" },
		bindingBoundaryEntryId: entryId,
		createdAt: "2026-08-31T10:00:00.000Z",
		...overrides,
	};
}

function runtime(overrides: Record<string, unknown> = {}) {
	return {
		schemaVersion: MANAGED_SESSION_STATE_VERSION,
		hostId,
		conversations: [
			{
				conversationId,
				state: "dormant",
				attachment: null,
				matrixCursor: { status: "bootstrap" },
				pendingInputs: [],
				projection: [],
				managedWindow: null,
				...overrides,
			},
		],
	};
}

test("protocol envelopes round trip through strict bounded NDJSON", () => {
	const envelope = attachEnvelope();
	const frame = encodeNdjsonEnvelope(envelope);
	assert.deepEqual(parseNdjsonEnvelope(frame), envelope);
	assert.deepEqual(parseNdjsonEnvelope(new TextEncoder().encode(frame)), envelope);
});

test("protocol rejects unknown fields, malformed framing, invalid UTF-8, and oversized frames", () => {
	assert.throws(() => parseManagedSessionEnvelope({ ...attachEnvelope(), surprise: true }), ManagedSessionContractError);
	assert.throws(() => parseNdjsonEnvelope(JSON.stringify(attachEnvelope())), /LF-terminated/);
	assert.throws(() => parseNdjsonEnvelope(`${JSON.stringify(attachEnvelope())}\n{}\n`), /exactly one/);
	assert.throws(() => parseNdjsonEnvelope(new Uint8Array([0xff, 0x0a])), /valid UTF-8/);
	assert.throws(
		() => parseNdjsonEnvelope(`${" ".repeat(MAX_NDJSON_FRAME_BYTES)}\n`),
		/exceeds/,
	);
	const bomPrefixedOversizedFrame = new Uint8Array(MAX_NDJSON_FRAME_BYTES + 1);
	bomPrefixedOversizedFrame.set([0xef, 0xbb, 0xbf]);
	bomPrefixedOversizedFrame.fill(0x20, 3, -1);
	bomPrefixedOversizedFrame[bomPrefixedOversizedFrame.length - 1] = 0x0a;
	assert.throws(() => parseNdjsonEnvelope(bomPrefixedOversizedFrame), /exceeds/);
});

test("unknown and forward protocol versions fail closed", () => {
	assert.throws(
		() => parseManagedSessionEnvelope({ ...attachEnvelope(), protocolVersion: "2.0.0" }),
		(error: unknown) => error instanceof ManagedSessionContractError && error.code === "unsupported_version",
	);
	assert.throws(() => parseManagedSessionEnvelope({ ...attachEnvelope(), protocolVersion: undefined }), /unsupported|protocolVersion/);
});

test("role and operation combinations enforce capabilities", () => {
	const selfBind = {
		protocolVersion: MANAGED_SESSION_PROTOCOL_VERSION,
		messageId: "bind-1",
		role: "ordinary_adapter",
		type: "self.bind",
		payload: {
			creationKey: "manual-bind-1", concept: "work", sessionId: "pi-session-1",
			attachmentNonce: "abcdefghijklmnopqrstuvwxyzABCDEF", bindingBoundaryEntryId: entryId,
			placement: { rootKey: "projects", workspace: "pi-harness", relativeCwd: "" },
		},
	};
	assert.equal(parseManagedSessionEnvelope(selfBind).conversationId, undefined);
	assert.throws(() => parseManagedSessionEnvelope({
		...selfBind,
		payload: { ...selfBind.payload, placement: { ...selfBind.payload.placement, relativeCwd: "../escape" } },
	}), /unsafe path/);

	const lifecycle = {
		protocolVersion: MANAGED_SESSION_PROTOCOL_VERSION,
		messageId: "lifecycle-1",
		conversationId,
		role: "coordinator_adapter",
		type: "lifecycle.request",
		payload: { request: { operation: "workspace.list" } },
	};
	assert.equal(parseManagedSessionEnvelope(lifecycle).type, "lifecycle.request");
	assert.throws(
		() => parseManagedSessionEnvelope({ ...lifecycle, role: "ordinary_adapter" }),
		/managed-session envelope/,
	);
	assert.throws(
		() => parseManagedSessionEnvelope({
			protocolVersion: MANAGED_SESSION_PROTOCOL_VERSION,
			messageId: "coordinator-self-status",
			conversationId,
			role: "coordinator_adapter",
			type: "self.status",
			payload: {},
		}),
		/managed-session envelope/,
	);
	assert.throws(
		() => parseManagedSessionEnvelope({
			...lifecycle,
			payload: { request: { operation: "conversation.start", creationKey: "new", concept: "work", placement: { rootKey: "projects", workspace: "repo", relativeCwd: "../escape" }, objective: "hidden task" } },
		}),
		/managed-session envelope|unsafe path/,
	);
	assert.throws(
		() => parseManagedSessionEnvelope({
			...lifecycle,
			payload: { request: { operation: "conversation.delete", targetConversationId: conversationId, confirmed: false } },
		}),
	);
	const listResult = {
		protocolVersion: MANAGED_SESSION_PROTOCOL_VERSION,
		messageId: "list-result-1",
		conversationId,
		role: "relay",
		type: "lifecycle.result",
		inReplyTo: "lifecycle-1",
		payload: { operation: "workspace.list", workspaces: [{ rootKey: "projects", workspace: "pi-harness" }] },
	};
	assert.equal(parseManagedSessionEnvelope(listResult).type, "lifecycle.result");
	assert.throws(() => parseManagedSessionEnvelope({ ...listResult, payload: { ...listResult.payload, paths: ["/tmp"] } }));
});

test("checkpoint schemas preserve the explicit requested-code boundary", () => {
	const checkpoint = {
		protocolVersion: MANAGED_SESSION_PROTOCOL_VERSION,
		messageId: "checkpoint-1",
		conversationId,
		role: "ordinary_adapter",
		type: "checkpoint.offer",
		payload: {
			checkpointId: "checkpoint-1",
			originDeliveryId: deliveryId,
			checkpoint: { kind: "question", decision: "Approve?", requestedCodeOrDiff: "diff" },
		},
	};
	assert.throws(() => parseManagedSessionEnvelope(checkpoint), /must appear together/);
	assert.equal(parseManagedSessionEnvelope({
		...checkpoint,
		payload: { ...checkpoint.payload, checkpoint: { ...checkpoint.payload.checkpoint, codeOrDiffRequested: true } },
	}).type, "checkpoint.offer");
});

test("input and acknowledgement semantic constraints fail closed", () => {
	const delivery = {
		protocolVersion: MANAGED_SESSION_PROTOCOL_VERSION,
		messageId: "delivery-1",
		conversationId,
		role: "relay",
		type: "input.deliver",
		payload: { deliveryId, matrixEventId: "$matrix-event", kind: "abort", body: "must not exist" },
	};
	assert.throws(() => parseManagedSessionEnvelope(delivery), /abort input/);
	assert.equal(parseManagedSessionEnvelope({ ...delivery, payload: { ...delivery.payload, body: undefined } }).type, "input.deliver");

	const acknowledgement = {
		protocolVersion: MANAGED_SESSION_PROTOCOL_VERSION,
		messageId: "ack-1",
		conversationId,
		role: "ordinary_adapter",
		type: "input.acknowledge",
		payload: { deliveryId, status: "persisted" },
	};
	assert.throws(() => parseManagedSessionEnvelope(acknowledgement), /requires piEntryId/);
});

test("portable manifests reject unknown versions, fields, and unsafe workspace identities", () => {
	assert.equal(parseConversationManifest(manifest()).conversationId, conversationId);
	assert.throws(() => parseConversationManifest(manifest({ schemaVersion: "2.0.0" })), /unsupported/);
	assert.throws(() => parseConversationManifest(manifest({ token: "secret" })), /conversation manifest/);
	assert.throws(
		() => parseConversationManifest(manifest({ placement: { rootKey: "projects", workspace: "pi-harness", relativeCwd: "/tmp" } })),
		/portable relative path/,
	);
	assert.throws(
		() => parseConversationManifest(manifest({ placement: { rootKey: "projects", workspace: "nested/repo", relativeCwd: "" } })),
		/immediate child/,
	);
});

test("legacy optional matrixSince runtime is migrated to explicit safe cursor state", () => {
	const established = runtime() as { conversations: Array<Record<string, unknown>> };
	delete established.conversations[0]!.matrixCursor; established.conversations[0]!.matrixSince = "legacy-cursor";
	assert.deepEqual(parseHostRuntimeState(established).conversations[0]?.matrixCursor, { status: "established", since: "legacy-cursor" });
	const fresh = runtime() as { conversations: Array<Record<string, unknown>> }; delete fresh.conversations[0]!.matrixCursor;
	assert.deepEqual(parseHostRuntimeState(fresh).conversations[0]?.matrixCursor, { status: "bootstrap" });
});

test("runtime parser strictly bounds active control poll authorization state", () => {
	const source = { controlId: `control_${"a".repeat(32)}`, matrixEventId: "$source", name: "model" };
	const poll = { pollEventId: "$poll", sourceControlId: source.controlId, scope: "model",
		options: [{ answerId: "pi-control-0", command: "!model scoped/model" }] };
	const state = (activeControlPoll: unknown) => runtime({ pendingControls: [source], activeControlPoll });
	assert.deepEqual(parseHostRuntimeState(state(poll)).conversations[0]?.activeControlPoll, poll);
	assert.throws(() => parseHostRuntimeState(state({ ...poll, extra: true })), /activeControlPoll/);
	assert.throws(() => parseHostRuntimeState(state({ ...poll, options: Array.from({ length: 21 }, (_, index) =>
		({ answerId: `pi-control-${index}`, command: `!model scoped/model-${index}` })) })), /activeControlPoll/);
	assert.throws(() => parseHostRuntimeState(state({ ...poll, options: [
		{ answerId: "same", command: "!model scoped/one" }, { answerId: "same", command: "!model scoped/two" },
	] })), /invalid active control poll/);
	assert.throws(() => parseHostRuntimeState(state({ ...poll, options: [
		{ answerId: "pi-control-0", command: "!thinking high" },
	] })), /invalid active control poll/);
});

test("runtime parser strictly bounds complete control poll publication intents", () => {
	const sourceControl = { controlId: `control_${"b".repeat(32)}`, matrixEventId: "$publishing-source", name: "thinking" };
	const intent = { sourceControl, scope: "thinking", transactionId: deriveMatrixTransactionId(conversationId, sourceControl.controlId, 0),
		prompt: "Choose thinking", options: [{ answerId: "pi-control-0", command: "!thinking high" }] };
	const state = (publishingControlPoll: unknown) => runtime({ pendingControls: [sourceControl], publishingControlPoll });
	assert.deepEqual(parseHostRuntimeState(state(intent)).conversations[0]?.publishingControlPoll, intent);
	assert.throws(() => parseHostRuntimeState(state({ ...intent, extra: true })), /publishingControlPoll/);
	assert.throws(() => parseHostRuntimeState(state({ ...intent, prompt: "x".repeat(4_097) })), /publishingControlPoll/);
	assert.throws(() => parseHostRuntimeState(state({ ...intent, transactionId: deriveMatrixTransactionId(conversationId, sourceControl.controlId, 1) })), /invalid publishing/);
	assert.throws(() => parseHostRuntimeState(state({ ...intent, sourceControl: { ...sourceControl, matrixEventId: "$other" } })), /invalid publishing/);
	assert.throws(() => parseHostRuntimeState(state({ ...intent, options: [{ answerId: "pi-control-0", command: "!model scoped/model" }] })), /invalid publishing/);
});

test("runtime parser rejects malformed lifecycle state and duplicate durable identities", () => {
	assert.equal(parseHostRuntimeState(runtime()).conversations[0]?.state, "dormant");
	assert.throws(() => parseHostRuntimeState(runtime({ state: "active" })), /has no attachment/);
	assert.throws(
		() => parseHostRuntimeState(runtime({ attachment: { attachmentId: "attachment-1", sessionId: "pi-session-1", connectedAt: "2026-08-31T10:00:00Z" } })),
		/has an attachment/,
	);
	assert.throws(
		() => parseHostRuntimeState({ ...runtime(), conversations: [...runtime().conversations, ...runtime().conversations] }),
		/duplicate runtime conversation/,
	);
	assert.throws(
		() => parseHostRuntimeState(runtime({
			pendingInputs: [
				{ deliveryId, matrixEventId: "$same", kind: "prompt", body: "one", status: "accepted" },
				{ deliveryId, matrixEventId: "$other", kind: "prompt", body: "two", status: "accepted" },
			],
		})),
		/conflicting pending input/,
	);
	const chunkId = deriveChunkId(entryId, 0);
	const transactionId = deriveMatrixTransactionId(conversationId, entryId, 0);
	assert.throws(
		() => parseHostRuntimeState(runtime({
			projection: [
				{ entryId, kind: "assistant_final", status: "projecting", chunks: [{ chunkId, transactionId, status: "pending" }] },
				{ entryId: deriveTranscriptEntryId("pi-session-1", "entry-2"), kind: "local_user", status: "projecting", chunks: [{ chunkId, transactionId, status: "pending" }] },
			],
		})),
		/duplicate projection chunk/,
	);
});

test("persistence bundle rejects host and identity conflicts instead of reconciling implicitly", () => {
	assert.equal(parsePersistenceBundle([manifest()], runtime()).manifests.length, 1);
	assert.throws(() => parsePersistenceBundle([manifest({ ownerHostId: "t480" })], runtime()), /another host/);
	assert.throws(() => parsePersistenceBundle([], runtime()), /do not match exactly/);
	assert.throws(
		() => parsePersistenceBundle([manifest(), manifest({ conversationId: deriveConversationId(hostId, "second") })], {
			...runtime(),
			conversations: [
				...runtime().conversations,
				{ ...runtime().conversations[0], conversationId: deriveConversationId(hostId, "second") },
			],
		}),
		/duplicate room identity/,
	);
});

test("stable identifiers and Matrix transactions are deterministic and domain separated", () => {
	assert.equal(deriveConversationId(hostId, "coordinator"), conversationId);
	assert.equal(deriveDeliveryId(conversationId, "$matrix-event"), deliveryId);
	assert.equal(deriveTranscriptEntryId("pi-session-1", "entry-1"), entryId);
	assert.notEqual(deriveTranscriptEntryId("pi-session-1", "entry-1"), deriveTranscriptEntryId("pi-session-1-entry", "1"));
	assert.notEqual(deriveChunkId(entryId, 0), deriveChunkId(entryId, 1));
	assert.match(deriveMatrixTransactionId(conversationId, entryId, 0), /^pi_[a-f0-9]{48}$/);
	assert.throws(() => deriveChunkId(entryId, -1), /non-negative/);
});
