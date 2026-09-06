import assert from "node:assert/strict";
import test from "node:test";
import {
	MANAGED_SESSION_PROTOCOL_VERSION,
	MANAGED_SESSION_STATE_VERSION,
	MAX_NDJSON_FRAME_BYTES,
	ManagedSessionContractError,
	deriveCheckpointPollAnswerId,
	deriveCheckpointPollIntentHash,
	deriveChunkId,
	deriveConversationId,
	deriveDeliveryId,
	deriveMatrixTransactionId,
	deriveProjectCreationKey,
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

test("accepted exact model and thinking control results carry only one durable selection", () => {
	const value = {
		protocolVersion: MANAGED_SESSION_PROTOCOL_VERSION,
		messageId: "model-selection",
		conversationId,
		role: "ordinary_adapter",
		type: "control.result",
		payload: { controlId: `control_${"a".repeat(32)}`, status: "ok", message: "selected", selection: { model: "local-llm/qwen" } },
	};
	assert.deepEqual(parseManagedSessionEnvelope(value), value);
	const thinking = { ...value, payload: { ...value.payload, selection: { thinking: "high" } } };
	assert.deepEqual(parseManagedSessionEnvelope(thinking), thinking);
	assert.deepEqual(parseManagedSessionEnvelope({ ...value, role: "coordinator_adapter" }), { ...value, role: "coordinator_adapter" });
	assert.throws(() => parseManagedSessionEnvelope({ ...value, payload: { ...value.payload, selection: { model: "local-llm/qwen", thinking: "high" } } }), /managed-session envelope/);
	assert.throws(() => parseManagedSessionEnvelope({ ...value, role: "relay" }), /managed-session envelope/);
	assert.throws(() => parseManagedSessionEnvelope({ ...value, payload: { ...value.payload, status: "rejected" } }), /selection metadata/);
	assert.throws(() => parseManagedSessionEnvelope({ ...value, payload: { ...value.payload, options: ["one"] } }), /selection metadata/);
	assert.throws(() => parseManagedSessionEnvelope({ ...value, payload: { ...value.payload, generation: { model: "other/model" } } }), /selection metadata/);
});

test("status control results carry one bounded typed live snapshot", () => {
	const value = {
		protocolVersion: MANAGED_SESSION_PROTOCOL_VERSION, messageId: "status-result", conversationId,
		role: "ordinary_adapter", type: "control.result",
		payload: { controlId: `control_${"b".repeat(32)}`, status: "ok", message: "status", liveStatus: {
			state: "idle", model: "local-llm/qwen", thinking: "high", context: { usedTokens: 100, limitTokens: 1000 },
		} },
	};
	assert.deepEqual(parseManagedSessionEnvelope(value), value);
	assert.throws(() => parseManagedSessionEnvelope({ ...value, payload: { ...value.payload, options: ["one"] } }), /live status metadata/);
	assert.throws(() => parseManagedSessionEnvelope({ ...value, payload: { ...value.payload, liveStatus: { ...value.payload.liveStatus, secret: "no" } } }), /managed-session envelope/);
	assert.throws(() => parseManagedSessionEnvelope({ ...value, payload: { ...value.payload, liveStatus: {
		...value.payload.liveStatus, context: { usedTokens: 1001, limitTokens: 1000 },
	} } }), /cannot exceed/);
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

test("project creation keys use stable length-framed workspace identity", () => {
	assert.equal(deriveProjectCreationKey("projects", "new-project"), "coordinator_e7f203823119c23de6a9b349601d4ae8");
	assert.notEqual(deriveProjectCreationKey("project", "snew-project"), deriveProjectCreationKey("projects", "new-project"));
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
	const projectCreate = { ...lifecycle, payload: { request: { operation: "project.create", creationKey: "create-1", rootKey: "projects", workspace: "new-project", concept: "new project" } } };
	assert.equal(parseManagedSessionEnvelope(projectCreate).type, "lifecycle.request");
	const reconciliationKey = `reconcile_${"a".repeat(32)}`;
	for (const request of [{ operation: "project.reconcile.preview" }, { operation: "project.reconcile.apply", reconciliationKey, confirmed: true },
		{ operation: "project.space.cleanup", reconciliationKey, confirmed: true }]) {
		assert.equal(parseManagedSessionEnvelope({ ...lifecycle, payload: { request } }).type, "lifecycle.request");
		assert.throws(() => parseManagedSessionEnvelope({ ...lifecycle, role: "ordinary_adapter", payload: { request } }));
	}
	assert.throws(() => parseManagedSessionEnvelope({ ...lifecycle, payload: { request: { operation: "project.reconcile.apply", reconciliationKey, confirmed: false } } }));
	const removalKey = `worktree_remove_${"b".repeat(32)}`;
	for (const request of [
		{ operation: "worktree.list", rootKey: "projects", workspace: "pi-harness" },
		{ operation: "worktree.create", creationKey: "worktree-create", rootKey: "projects", workspace: "pi-harness", baseRef: "main", branch: "feature/example" },
		{ operation: "worktree.conversation.create", creationKey: "worktree-bundle", rootKey: "projects", workspace: "pi-harness", baseRef: "refs/heads/main", branch: "feature/bundle", concept: "bundle work" },
		{ operation: "worktree.remove.preview", rootKey: "projects", workspace: "pi-harness-feature", mergeTarget: "main" },
		{ operation: "worktree.remove.apply", removalKey, confirmed: true },
		{ operation: "worktree.conversation.cleanup.preview", targetConversationId: conversationId, mergeTarget: "main" },
		{ operation: "worktree.conversation.cleanup.apply", removalKey, confirmed: true },
		{ operation: "worktree.branch.delete", removalKey, confirmed: true },
	]) {
		assert.equal(parseManagedSessionEnvelope({ ...lifecycle, payload: { request } }).type, "lifecycle.request");
		assert.throws(() => parseManagedSessionEnvelope({ ...lifecycle, role: "ordinary_adapter", payload: { request } }));
	}
	for (const operation of ["worktree.remove.apply", "worktree.conversation.cleanup.apply", "worktree.branch.delete"]) {
		assert.throws(() => parseManagedSessionEnvelope({ ...lifecycle, payload: { request: { operation, removalKey, confirmed: false } } }));
	}
	assert.throws(() => parseManagedSessionEnvelope({ ...lifecycle, payload: { request: { operation: "worktree.create", creationKey: "bad", rootKey: "projects", workspace: "pi-harness", baseRef: "HEAD~1", branch: "feature/bad" } } }));
	assert.equal(parseManagedSessionEnvelope({ protocolVersion: MANAGED_SESSION_PROTOCOL_VERSION, messageId: "worktree-result", conversationId, role: "relay", type: "lifecycle.result",
		inReplyTo: "lifecycle-1", payload: { operation: "worktree.list", rootKey: "projects", workspace: "pi-harness", worktrees: [
			{ workspace: "pi-harness-topic", branch: "topic@2026", head: "a".repeat(40), isMain: false, locked: false, clean: true, conversations: [] },
		], intents: [] } }).type, "lifecycle.result", "safe existing Git branch names remain representable in inventory responses");
	assert.throws(() => parseManagedSessionEnvelope({ ...projectCreate, payload: { request: { ...projectCreate.payload.request, projectSpace: "caller-selected" } } }),
		"coordinators cannot select grouping through display names or Matrix Space IDs");
	for (const request of [
		{ ...projectCreate.payload.request, workspace: "nested/project" },
		{ ...projectCreate.payload.request, workspace: "../escape" },
		{ ...projectCreate.payload.request, command: "touch owned" },
		{ ...projectCreate.payload.request, objective: "injected task" },
	]) assert.throws(() => parseManagedSessionEnvelope({ ...projectCreate, payload: { request } }), /managed-session envelope|immediate-child/);
	assert.throws(() => parseManagedSessionEnvelope({ ...projectCreate, role: "ordinary_adapter" }), /managed-session envelope/);
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
	assert.equal(parseManagedSessionEnvelope({ ...listResult, payload: { operation: "project.create", targetConversationId: conversationId,
		conversationState: "active", roomLink: "https://matrix.to/#/%21project%3Aexample.com" } }).type, "lifecycle.result");
	assert.equal(parseManagedSessionEnvelope({ ...listResult, payload: { operation: "project.reconcile.preview", reconciliationKey: `reconcile_${"a".repeat(32)}`,
		pending: 1, completed: 0, obsoleteSpaces: 1, items: [{ conversationId, concept: "work", workspace: "repo", projectDisplayName: "repo", checkoutDisplayName: "repo", status: "pending" }] } }).type, "lifecycle.result");
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

test("aloop lifecycle notices are ordinary-adapter-only and strictly bounded", () => {
	const lifecycle = {
		protocolVersion: MANAGED_SESSION_PROTOCOL_VERSION, messageId: "aloop-1", conversationId,
		role: "ordinary_adapter", type: "aloop.notice",
		payload: { scopeSessionId: "session-scope", lifecycleId: `aloop_${"a".repeat(32)}`, kind: "startup", epic: 53, issue: 66, body: "Aloop started.", timestamp: "2026-09-03T00:00:00.000Z" },
	};
	assert.equal(parseManagedSessionEnvelope(lifecycle).type, "aloop.notice");
	assert.throws(() => parseManagedSessionEnvelope({ ...lifecycle, role: "coordinator_adapter" }), /managed-session envelope/);
	assert.throws(() => parseManagedSessionEnvelope({ ...lifecycle, payload: { ...lifecycle.payload, body: "x".repeat(1_601) } }), /managed-session envelope/);
	assert.throws(() => parseManagedSessionEnvelope({ ...lifecycle, payload: { ...lifecycle.payload, artifactDirectory: "/tmp/private" } }), /managed-session envelope/);
	assert.equal(parseManagedSessionEnvelope({
		protocolVersion: MANAGED_SESSION_PROTOCOL_VERSION, messageId: "aloop-ack", conversationId, role: "relay", type: "aloop.acknowledge",
		inReplyTo: "aloop-1", payload: { lifecycleId: lifecycle.payload.lifecycleId, status: "projected" },
	}).type, "aloop.acknowledge");
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

test("stable project grouping metadata is strict, atomic, and optional before explicit reconciliation", () => {
	const legacy = manifest(); assert.deepEqual(parseConversationManifest(legacy), legacy);
	const grouped = { ...legacy, projectKey: `project_${"a".repeat(32)}`, projectDisplayName: "main-project", checkoutDisplayName: "feature-worktree" };
	assert.deepEqual(parseConversationManifest(grouped), grouped);
	assert.throws(() => parseConversationManifest({ ...legacy, projectKey: grouped.projectKey }), /stable project identity/);
	assert.throws(() => parseConversationManifest({ ...grouped, projectKey: "project_bad" }));
	const { placement: _placement, ...withoutPlacement } = grouped;
	assert.throws(() => parseConversationManifest({ ...withoutPlacement, kind: "coordinator", hostSpace: "!host:example.com" }), /conversation manifest|stable project identity/);
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

test("runtime parser binds checkpoint poll mappings to one durable checkpoint projection", () => {
	const checkpointEntry = deriveTranscriptEntryId("pi-session-1", "checkpoint:test");
	const transactionId = deriveMatrixTransactionId(conversationId, checkpointEntry, 0);
	const intentBase = { checkpointId: "checkpoint-test", originDeliveryId: deliveryId, entryId: checkpointEntry, transactionId,
		question: "Choose", options: [{ answerId: deriveCheckpointPollAnswerId("checkpoint-test", 0), text: "Exact option" }] };
	const intent = { ...intentBase, intentHash: deriveCheckpointPollIntentHash(intentBase) };
	const projection = { entryId: checkpointEntry, kind: "checkpoint", status: "projecting", contentHash: intent.intentHash, originDeliveryId: deliveryId,
		chunks: [{ chunkId: deriveChunkId(checkpointEntry, 0), transactionId, status: "pending" }] };
	assert.deepEqual(parseHostRuntimeState(runtime({ projection: [projection], publishingCheckpointPoll: intent })).conversations[0]?.publishingCheckpointPoll, intent);
	assert.throws(() => parseHostRuntimeState(runtime({ projection: [projection], publishingCheckpointPoll: intent,
		activeCheckpointPoll: { ...intent, pollEventId: "$poll" } })), /cannot be publishing and active/);
	assert.throws(() => parseHostRuntimeState(runtime({ projection: [projection], publishingCheckpointPoll: { ...intent, transactionId: deriveMatrixTransactionId(conversationId, checkpointEntry, 1) } })), /invalid checkpoint poll/);
	assert.throws(() => parseHostRuntimeState(runtime({ projection: [projection], activeCheckpointPoll: { ...intent, pollEventId: "$poll",
		options: [{ answerId: "same", text: "One" }, { answerId: "same", text: "Two" }] } })), /invalid checkpoint poll/);
	const closing = { ...intent, pollEventId: "$poll", resolutionEventId: "$answer", selectedAnswerId: intent.options[0]!.answerId,
		closureTransactionId: deriveMatrixTransactionId(conversationId, "$poll", 0), fallback: "Selection accepted" };
	const pollInputs = [
		{ deliveryId, matrixEventId: "$origin", kind: "prompt", body: "Choose", status: "completed" },
		{ deliveryId: deriveDeliveryId(conversationId, "$answer"), matrixEventId: "$answer", kind: "prompt", body: "Exact option", status: "accepted" },
	];
	assert.deepEqual(parseHostRuntimeState(runtime({ pendingInputs: pollInputs, projection: [projection], closingCheckpointPolls: [closing] })).conversations[0]?.closingCheckpointPolls, [closing]);
	assert.throws(() => parseHostRuntimeState(runtime({ pendingInputs: pollInputs, projection: [projection], closingCheckpointPolls: [{ ...closing, closureTransactionId: transactionId }] })), /invalid closing checkpoint poll/);
	const substitutedInputs = [pollInputs[0], { ...pollInputs[1], body: "Substituted" }];
	assert.throws(() => parseHostRuntimeState(runtime({ pendingInputs: substitutedInputs, projection: [projection], closingCheckpointPolls: [{
		...closing, question: "Changed", options: [{ answerId: deriveCheckpointPollAnswerId("checkpoint-test", 0), text: "Substituted" }],
	}] })), /invalid closing checkpoint poll/);
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
