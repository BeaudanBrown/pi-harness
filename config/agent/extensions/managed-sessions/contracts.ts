import { createHash } from "node:crypto";
import { Type, type TSchema } from "typebox";
import { Check, Errors } from "typebox/value";

export const MANAGED_SESSION_PROTOCOL_VERSION = "1.0.0" as const;
export const MANAGED_SESSION_STATE_VERSION = "1.0.0" as const;
export const MAX_NDJSON_FRAME_BYTES = 64 * 1024;
export const MAX_INPUT_TEXT_LENGTH = 16_000;
export const MAX_TRANSCRIPT_TEXT_LENGTH = 64_000;
export const MAX_PENDING_INPUTS = 2_048;
export const MAX_PROJECTION_ENTRIES = 4_096;

const strictObject = <T extends Record<string, TSchema>>(properties: T) =>
	Type.Object(properties, { additionalProperties: false });
const boundedString = (maxLength: number, minLength = 1) => Type.String({ minLength, maxLength });
const identifier = Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" });
const stableId = (prefix: string) => Type.String({ pattern: `^${prefix}_[a-f0-9]{32}$` });
const timestamp = Type.String({ minLength: 20, maxLength: 35 });
const nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);

export const ConversationIdSchema = stableId("conv");
export const DeliveryIdSchema = stableId("delivery");
export const TranscriptEntryIdSchema = stableId("entry");
export const ChunkIdSchema = stableId("chunk");
export const MatrixTransactionIdSchema = Type.String({ pattern: "^pi_[a-f0-9]{48}$" });

export const WorkspaceIdentitySchema = strictObject({
	rootKey: identifier,
	workspace: boundedString(128),
	relativeCwd: Type.String({ minLength: 0, maxLength: 512 }),
});

const requestedCodeFields = {
	codeOrDiffRequested: Type.Optional(Type.Literal(true)),
	requestedCodeOrDiff: Type.Optional(boundedString(1_000)),
};
const checkpointPayload = Type.Union([
	strictObject({
		kind: Type.Literal("question"),
		decision: boundedString(1_200),
		context: Type.Optional(boundedString(1_200)),
		options: Type.Optional(Type.Array(boundedString(300), { minItems: 1, maxItems: 8 })),
		...requestedCodeFields,
	}),
	strictObject({
		kind: Type.Literal("blocked"),
		blockerEvidence: boundedString(2_200),
		requiredIntervention: boundedString(1_200),
		...requestedCodeFields,
	}),
	strictObject({
		kind: Type.Literal("issue_complete"),
		issueOrObjective: boundedString(500),
		implementationSummary: boundedString(1_200),
		verificationEvidence: boundedString(1_200),
		caveats: boundedString(800),
		gitCommitState: boundedString(800),
		approvalRequest: boundedString(600),
		...requestedCodeFields,
	}),
]);

const adapterRole = Type.Union([Type.Literal("ordinary_adapter"), Type.Literal("coordinator_adapter")]);
const lifecycleArguments = Type.Union([
	strictObject({ operation: Type.Literal("workspace.list") }),
	strictObject({ operation: Type.Literal("conversation.list") }),
	strictObject({ operation: Type.Literal("conversation.status"), targetConversationId: ConversationIdSchema }),
	strictObject({
		operation: Type.Literal("conversation.start"),
		creationKey: identifier,
		concept: boundedString(128),
		placement: WorkspaceIdentitySchema,
		projectSpace: Type.Optional(boundedString(128)),
	}),
	strictObject({ operation: Type.Literal("conversation.resume"), targetConversationId: ConversationIdSchema }),
	strictObject({ operation: Type.Literal("conversation.stop"), targetConversationId: ConversationIdSchema }),
	strictObject({
		operation: Type.Literal("conversation.delete"),
		targetConversationId: ConversationIdSchema,
		confirmed: Type.Literal(true),
	}),
]);

const baseEnvelope = {
	protocolVersion: Type.Literal(MANAGED_SESSION_PROTOCOL_VERSION),
	messageId: identifier,
	conversationId: ConversationIdSchema,
};
const clientEnvelope = <T extends Record<string, TSchema>>(role: TSchema, type: string, payload: T) =>
	strictObject({ ...baseEnvelope, role, type: Type.Literal(type), payload: strictObject(payload) });
const unboundClientEnvelope = <T extends Record<string, TSchema>>(role: TSchema, type: string, payload: T) =>
	strictObject({
		protocolVersion: Type.Literal(MANAGED_SESSION_PROTOCOL_VERSION),
		messageId: identifier,
		role,
		type: Type.Literal(type),
		payload: strictObject(payload),
	});
const relayEnvelopeWithPayload = (type: string, payload: TSchema) =>
	strictObject({
		...baseEnvelope,
		role: Type.Literal("relay"),
		type: Type.Literal(type),
		inReplyTo: Type.Optional(identifier),
		payload,
	});
const relayEnvelope = <T extends Record<string, TSchema>>(type: string, payload: T) =>
	relayEnvelopeWithPayload(type, strictObject(payload));

const attachmentFields = {
	sessionId: identifier,
	attachmentNonce: Type.String({ pattern: "^[A-Za-z0-9_-]{32,128}$" }),
	bindingBoundaryEntryId: TranscriptEntryIdSchema,
};

export const ManagedSessionEnvelopeSchema = Type.Union([
	clientEnvelope(adapterRole, "attachment.attach", attachmentFields),
	clientEnvelope(adapterRole, "attachment.detach", {
		attachmentId: identifier,
		reason: Type.Union([
			Type.Literal("shutdown"),
			Type.Literal("session_change"),
			Type.Literal("stop"),
			Type.Literal("bridge_delete"),
		]),
	}),
	clientEnvelope(adapterRole, "session.change", {
		attachmentId: identifier,
		oldSessionId: identifier,
		newSessionId: identifier,
		newConversationId: Type.Optional(ConversationIdSchema),
	}),
	clientEnvelope(adapterRole, "input.acknowledge", {
		deliveryId: DeliveryIdSchema,
		status: Type.Union([
			Type.Literal("accepted"),
			Type.Literal("persisted"),
			Type.Literal("completed"),
			Type.Literal("cancelled"),
		]),
		piEntryId: Type.Optional(TranscriptEntryIdSchema),
		completionKind: Type.Optional(Type.Literal("extension_command")),
	}),
	clientEnvelope(adapterRole, "transcript.offer", {
		entryId: TranscriptEntryIdSchema,
		piSessionId: identifier,
		piEntryKey: identifier,
		kind: Type.Union([Type.Literal("local_user"), Type.Literal("assistant_final")]),
		body: boundedString(MAX_TRANSCRIPT_TEXT_LENGTH),
	}),
	clientEnvelope(Type.Literal("ordinary_adapter"), "activity.update", {
		activityId: stableId("activity"),
		revision: Type.Integer({ minimum: 0 }),
		state: Type.Union([Type.Literal("busy"), Type.Literal("tool"), Type.Literal("compaction")]),
		tools: Type.Optional(Type.Array(strictObject({
			name: boundedString(128),
			state: Type.Union([Type.Literal("running"), Type.Literal("completed"), Type.Literal("error")]),
			count: Type.Integer({ minimum: 1 }),
		}), { maxItems: 64 })),
	}),
	clientEnvelope(Type.Literal("ordinary_adapter"), "activity.finalize", {
		activityId: stableId("activity"), revision: Type.Integer({ minimum: 1 }),
		outcome: Type.Union([Type.Literal("completed"), Type.Literal("checkpoint"), Type.Literal("cancelled"), Type.Literal("interrupted"), Type.Literal("failed")]),
		durationMs: Type.Optional(Type.Integer({ minimum: 0 })), model: Type.Optional(boundedString(256)), thinking: Type.Optional(boundedString(32)), generation: Type.Optional(Type.Integer({ minimum: 1 })),
		context: Type.Optional(strictObject({ usedTokens: Type.Integer({ minimum: 0 }), remainingTokens: Type.Integer({ minimum: 0 }), limitTokens: Type.Integer({ minimum: 1 }), deltaTokens: Type.Integer() })),
		run: Type.Optional(strictObject({ inputTokens: Type.Integer({ minimum: 0 }), outputTokens: Type.Integer({ minimum: 0 }), modelTurns: Type.Integer({ minimum: 0 }) })),
		tools: Type.Optional(strictObject({ total: Type.Integer({ minimum: 0 }), errors: Type.Integer({ minimum: 0 }), counts: Type.Array(strictObject({ name: boundedString(128), count: Type.Integer({ minimum: 1 }) }), { maxItems: 64 }) })),
		compactions: Type.Optional(Type.Integer({ minimum: 0 })),
	}),
	clientEnvelope(adapterRole, "control.result", {
		controlId: stableId("control"),
		status: Type.Union([Type.Literal("ok"), Type.Literal("rejected")]),
		message: boundedString(4_096),
		options: Type.Optional(Type.Array(boundedString(255), { minItems: 1, maxItems: 20 })),
	}),
	clientEnvelope(adapterRole, "checkpoint.offer", {
		checkpointId: identifier,
		originDeliveryId: DeliveryIdSchema,
		checkpoint: checkpointPayload,
	}),
	unboundClientEnvelope(Type.Literal("ordinary_adapter"), "self.bind", {
		creationKey: identifier,
		concept: boundedString(128),
		sessionId: identifier,
		attachmentNonce: Type.String({ pattern: "^[A-Za-z0-9_-]{32,128}$" }),
		bindingBoundaryEntryId: TranscriptEntryIdSchema,
		placement: WorkspaceIdentitySchema,
	}),
	clientEnvelope(Type.Literal("ordinary_adapter"), "self.status", {}),
	clientEnvelope(Type.Literal("ordinary_adapter"), "self.delete", { confirmed: Type.Literal(true) }),
	clientEnvelope(Type.Literal("coordinator_adapter"), "lifecycle.request", {
		request: lifecycleArguments,
	}),
	relayEnvelope("attachment.accepted", {
		attachmentId: identifier,
		state: Type.Union([Type.Literal("starting"), Type.Literal("active"), Type.Literal("dormant")]),
	}),
	relayEnvelope("control.deliver", {
		controlId: stableId("control"),
		name: Type.Union([
			Type.Literal("help"), Type.Literal("status"), Type.Literal("model"), Type.Literal("thinking"),
			Type.Literal("compact"), Type.Literal("new"), Type.Literal("stop"),
		]),
		argument: Type.Optional(boundedString(4_096)),
	}),
	relayEnvelope("input.deliver", {
		deliveryId: DeliveryIdSchema,
		matrixEventId: boundedString(255),
		kind: Type.Union([
			Type.Literal("prompt"),
			Type.Literal("follow_up"),
			Type.Literal("steer"),
			Type.Literal("abort"),
		]),
		body: Type.Optional(boundedString(MAX_INPUT_TEXT_LENGTH)),
	}),
	relayEnvelope("input.result", {
		deliveryId: DeliveryIdSchema,
		status: Type.Union([Type.Literal("accepted"), Type.Literal("persisted"), Type.Literal("completed"), Type.Literal("cancelled")]),
	}),
	relayEnvelope("transcript.acknowledge", {
		entryId: TranscriptEntryIdSchema,
		status: Type.Union([Type.Literal("accepted"), Type.Literal("projected")]),
	}),
	relayEnvelope("checkpoint.acknowledge", {
		checkpointId: identifier,
		status: Type.Union([Type.Literal("accepted"), Type.Literal("projected")]),
	}),
	relayEnvelope("activity.acknowledge", {
		activityId: stableId("activity"),
		revision: Type.Integer({ minimum: 0 }),
		status: Type.Union([Type.Literal("updated"), Type.Literal("finalized")]),
	}),
	relayEnvelopeWithPayload("self.result", Type.Union([
		strictObject({ operation: Type.Literal("self.bind"), status: Type.Literal("ok"), boundConversationId: ConversationIdSchema }),
		strictObject({
			operation: Type.Literal("self.status"),
			status: Type.Literal("ok"),
			conversationState: Type.Union([Type.Literal("starting"), Type.Literal("active"), Type.Literal("dormant")]),
		}),
		strictObject({ operation: Type.Literal("self.delete"), status: Type.Literal("ok") }),
		strictObject({ operation: Type.Literal("control.result"), status: Type.Literal("ok") }),
	])),
	relayEnvelopeWithPayload("lifecycle.result", Type.Union([
		strictObject({
			operation: Type.Literal("workspace.list"),
			workspaces: Type.Array(strictObject({ rootKey: identifier, workspace: boundedString(128) }), { maxItems: 4_096 }),
		}),
		strictObject({
			operation: Type.Literal("conversation.list"),
			conversations: Type.Array(strictObject({
				conversationId: ConversationIdSchema,
				concept: boundedString(128),
				kind: Type.Union([Type.Literal("project"), Type.Literal("coordinator")]),
				state: Type.Union([Type.Literal("starting"), Type.Literal("active"), Type.Literal("dormant")]),
			}), { maxItems: 4_096 }),
		}),
		strictObject({
			operation: Type.Literal("conversation.status"),
			targetConversationId: ConversationIdSchema,
			conversationState: Type.Union([Type.Literal("starting"), Type.Literal("active"), Type.Literal("dormant")]),
		}),
		strictObject({
			operation: Type.Union([
				Type.Literal("conversation.start"), Type.Literal("conversation.resume"), Type.Literal("conversation.stop"), Type.Literal("conversation.delete"),
			]),
			targetConversationId: ConversationIdSchema,
			conversationState: Type.Optional(Type.Union([Type.Literal("starting"), Type.Literal("active"), Type.Literal("dormant")])),
		}),
	])),
	relayEnvelope("termination.request", {
		deliveryId: Type.Optional(DeliveryIdSchema),
		reason: Type.Union([Type.Literal("stop"), Type.Literal("abort"), Type.Literal("bridge_delete")]),
	}),
	relayEnvelope("error", {
		code: Type.Union([
			Type.Literal("invalid_message"),
			Type.Literal("unsupported_version"),
			Type.Literal("permission_denied"),
			Type.Literal("attachment_conflict"),
			Type.Literal("invalid_nonce"),
			Type.Literal("not_found"),
			Type.Literal("invalid_state"),
			Type.Literal("capacity_reached"),
			Type.Literal("launch_failed"),
			Type.Literal("matrix_unavailable"),
		]),
		message: boundedString(500),
		retryable: Type.Boolean(),
	}),
]);

const projectManifest = strictObject({
	schemaVersion: Type.Literal(MANAGED_SESSION_STATE_VERSION),
	kind: Type.Literal("project"),
	conversationId: ConversationIdSchema,
	ownerHostId: identifier,
	creationKey: identifier,
	concept: boundedString(128),
	piSessionId: identifier,
	roomId: boundedString(255),
	placement: WorkspaceIdentitySchema,
	projectSpace: Type.Optional(boundedString(128)),
	bindingBoundaryEntryId: TranscriptEntryIdSchema,
	createdAt: timestamp,
});
const coordinatorManifest = strictObject({
	schemaVersion: Type.Literal(MANAGED_SESSION_STATE_VERSION),
	kind: Type.Literal("coordinator"),
	conversationId: ConversationIdSchema,
	ownerHostId: identifier,
	creationKey: identifier,
	concept: boundedString(128),
	piSessionId: identifier,
	roomId: boundedString(255),
	hostSpace: Type.Optional(boundedString(255)),
	bindingBoundaryEntryId: TranscriptEntryIdSchema,
	createdAt: timestamp,
});
export const ConversationManifestSchema = Type.Union([projectManifest, coordinatorManifest]);

const pendingInput = strictObject({
	deliveryId: DeliveryIdSchema,
	matrixEventId: boundedString(255),
	kind: Type.Union([
		Type.Literal("prompt"),
		Type.Literal("follow_up"),
		Type.Literal("steer"),
		Type.Literal("abort"),
	]),
	body: Type.Optional(boundedString(MAX_INPUT_TEXT_LENGTH)),
	piEntryId: Type.Optional(TranscriptEntryIdSchema),
	status: Type.Union([
		Type.Literal("accepted"),
		Type.Literal("delivered"),
		Type.Literal("persisted"),
		Type.Literal("completed"),
		Type.Literal("cancelled"),
	]),
});
const projectionEntry = strictObject({
	entryId: TranscriptEntryIdSchema,
	kind: Type.Union([
		Type.Literal("matrix_user"),
		Type.Literal("local_user"),
		Type.Literal("assistant_final"),
		Type.Literal("checkpoint"),
		Type.Literal("notice"),
	]),
	status: Type.Union([Type.Literal("offered"), Type.Literal("projecting"), Type.Literal("projected")]),
	contentHash: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
	originDeliveryId: Type.Optional(DeliveryIdSchema),
	chunks: Type.Array(strictObject({
		chunkId: ChunkIdSchema,
		transactionId: MatrixTransactionIdSchema,
		status: Type.Union([Type.Literal("pending"), Type.Literal("sent")]),
	}), { maxItems: 64 }),
});
const runtimeConversation = strictObject({
	conversationId: ConversationIdSchema,
	state: Type.Union([Type.Literal("starting"), Type.Literal("active"), Type.Literal("dormant")]),
	attachmentNonceHash: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
	attachment: nullable(
		strictObject({
			attachmentId: identifier,
			sessionId: identifier,
			connectedAt: timestamp,
		}),
	),
	matrixCursor: Type.Union([
		strictObject({ status: Type.Literal("bootstrap") }),
		strictObject({ status: Type.Literal("established"), since: boundedString(2_048) }),
	]),
	pendingInputs: Type.Array(pendingInput, { maxItems: MAX_PENDING_INPUTS }),
	projection: Type.Array(projectionEntry, { maxItems: MAX_PROJECTION_ENTRIES }),
	managedWindow: nullable(
		strictObject({
			sessionName: boundedString(128),
			windowId: boundedString(64),
			paneId: boundedString(64),
		}),
	),
	lastLaunchError: Type.Optional(strictObject({ code: identifier, message: boundedString(500), at: timestamp })),
});
export const HostRuntimeStateSchema = strictObject({
	schemaVersion: Type.Literal(MANAGED_SESSION_STATE_VERSION),
	hostId: identifier,
	conversations: Type.Array(runtimeConversation, { maxItems: 4_096 }),
});

export interface WorkspaceIdentity {
	rootKey: string;
	workspace: string;
	relativeCwd: string;
}
export interface ConversationManifest {
	schemaVersion: typeof MANAGED_SESSION_STATE_VERSION;
	kind: "project" | "coordinator";
	conversationId: string;
	ownerHostId: string;
	creationKey: string;
	concept: string;
	piSessionId: string;
	roomId: string;
	placement?: WorkspaceIdentity;
	projectSpace?: string;
	hostSpace?: string;
	bindingBoundaryEntryId: string;
	createdAt: string;
}
export interface HostRuntimeState {
	schemaVersion: typeof MANAGED_SESSION_STATE_VERSION;
	hostId: string;
	conversations: Array<{
		conversationId: string;
		state: "starting" | "active" | "dormant";
		attachmentNonceHash?: string;
		attachment: null | { attachmentId: string; sessionId: string; connectedAt: string };
		matrixCursor: { status: "bootstrap" } | { status: "established"; since: string };
		pendingInputs: Array<{ deliveryId: string; matrixEventId: string; kind: string; body?: string; piEntryId?: string; status: string }>;
		projection: Array<{
			entryId: string;
			kind: string;
			status: string;
			contentHash?: string;
			originDeliveryId?: string;
			chunks: Array<{ chunkId: string; transactionId: string; status: string }>;
		}>;
		managedWindow: null | { sessionName: string; windowId: string; paneId: string };
		lastLaunchError?: { code: string; message: string; at: string };
	}>;
}
export interface ManagedSessionEnvelope {
	protocolVersion: typeof MANAGED_SESSION_PROTOCOL_VERSION;
	messageId: string;
	conversationId?: string;
	role: "ordinary_adapter" | "coordinator_adapter" | "relay";
	type: string;
	inReplyTo?: string;
	payload: Record<string, unknown>;
}

export class ManagedSessionContractError extends Error {
	constructor(
		readonly code: "malformed" | "unsupported_version" | "invalid_state" | "conflict",
		message: string,
	) {
		super(message);
		this.name = "ManagedSessionContractError";
	}
}

function schemaError(schema: TSchema, value: unknown): string {
	const first = [...Errors(schema, value)][0];
	return first ? `${first.instancePath || "/"}: ${first.message}` : "schema validation failed";
}

function assertSchema(schema: TSchema, value: unknown, label: string): void {
	if (!Check(schema, value)) {
		throw new ManagedSessionContractError("malformed", `${label}: ${schemaError(schema, value)}`);
	}
}

function assertTimestamp(value: string, label: string): void {
	if (!Number.isFinite(Date.parse(value))) {
		throw new ManagedSessionContractError("malformed", `${label} is not a valid timestamp`);
	}
}

function assertWorkspaceIdentity(value: WorkspaceIdentity): void {
	if (/^(?:\/|\\)/.test(value.relativeCwd) || value.relativeCwd.includes("\\")) {
		throw new ManagedSessionContractError("malformed", "relativeCwd must be a portable relative path");
	}
	const segments = value.relativeCwd === "" ? [] : value.relativeCwd.split("/");
	if (segments.some((segment) => segment === "" || segment === "." || segment === ".." || /[\u0000-\u001f\u007f]/.test(segment))) {
		throw new ManagedSessionContractError("malformed", "relativeCwd contains an unsafe path segment");
	}
	if (/[\u0000-\u001f\u007f/]/.test(value.workspace)) {
		throw new ManagedSessionContractError("malformed", "workspace must name one immediate child directory");
	}
}

function assertInputBody(kind: string, body: string | undefined): void {
	if ((kind === "abort") === (body !== undefined)) {
		throw new ManagedSessionContractError("malformed", "abort input must omit body and all other input kinds require body");
	}
}

function assertSemanticEnvelope(envelope: ManagedSessionEnvelope): void {
	if (envelope.type === "input.deliver") {
		const payload = envelope.payload as { kind: string; body?: string };
		assertInputBody(payload.kind, payload.body);
	}
	if (envelope.type === "input.acknowledge") {
		const payload = envelope.payload as { status: string; piEntryId?: string; completionKind?: string };
		if (payload.status === "persisted" && !payload.piEntryId) {
			throw new ManagedSessionContractError("malformed", "persisted input acknowledgement requires piEntryId");
		}
		if (payload.completionKind === "extension_command") {
			if (payload.status !== "completed" || payload.piEntryId) throw new ManagedSessionContractError("malformed", "extension-command completion must be terminal and omit piEntryId");
		} else if (payload.status === "completed" && !payload.piEntryId) {
			throw new ManagedSessionContractError("malformed", "ordinary completed input acknowledgement requires piEntryId");
		}
	}
	if (envelope.type === "activity.update") {
		const payload = envelope.payload as { state: string; tools?: Array<{ name: string }> };
		if (payload.state !== "tool" && payload.tools !== undefined) throw new ManagedSessionContractError("malformed", "busy activity update must omit tools");
		if (payload.state === "tool" && (!payload.tools?.length || new Set(payload.tools.map((tool) => tool.name)).size !== payload.tools.length)) throw new ManagedSessionContractError("malformed", "tool activity update requires unique collapsed names");
	}
	if (envelope.type === "activity.finalize") {
		const payload = envelope.payload as { context?: { usedTokens: number; remainingTokens: number; limitTokens: number }; tools?: { total: number; errors: number; counts: Array<{ count: number }> } };
		if (payload.context && payload.context.usedTokens + payload.context.remainingTokens !== payload.context.limitTokens) throw new ManagedSessionContractError("malformed", "activity context must be balanced");
		if (payload.tools && (payload.tools.errors > payload.tools.total || payload.tools.counts.reduce((sum, item) => sum + item.count, 0) !== payload.tools.total)) throw new ManagedSessionContractError("malformed", "activity tool totals must be balanced");
	}
	if (envelope.type === "checkpoint.offer") {
		const payload = envelope.payload as { checkpoint: { codeOrDiffRequested?: true; requestedCodeOrDiff?: string } };
		if ((payload.checkpoint.codeOrDiffRequested === true) !== (payload.checkpoint.requestedCodeOrDiff !== undefined)) {
			throw new ManagedSessionContractError("malformed", "checkpoint requested-code fields must appear together");
		}
	}
	if (envelope.type === "self.bind") {
		assertWorkspaceIdentity((envelope.payload as { placement: WorkspaceIdentity }).placement);
	}
	if (envelope.type === "lifecycle.request") {
		const payload = envelope.payload as { request: { operation: string; placement?: WorkspaceIdentity } };
		if (payload.request.operation === "conversation.start" && payload.request.placement) {
			assertWorkspaceIdentity(payload.request.placement);
		}
	}
}

export function parseManagedSessionEnvelope(value: unknown): ManagedSessionEnvelope {
	if (typeof value === "object" && value !== null && "protocolVersion" in value &&
		(value as { protocolVersion?: unknown }).protocolVersion !== MANAGED_SESSION_PROTOCOL_VERSION) {
		throw new ManagedSessionContractError("unsupported_version", "unsupported managed-session protocol version");
	}
	assertSchema(ManagedSessionEnvelopeSchema, value, "managed-session envelope");
	const envelope = value as ManagedSessionEnvelope;
	assertSemanticEnvelope(envelope);
	return envelope;
}

export function parseNdjsonEnvelope(frame: string | Uint8Array): ManagedSessionEnvelope {
	if (frame instanceof Uint8Array && frame.byteLength > MAX_NDJSON_FRAME_BYTES) {
		throw new ManagedSessionContractError("malformed", `managed-session frame exceeds ${MAX_NDJSON_FRAME_BYTES} bytes`);
	}
	let text: string;
	if (typeof frame === "string") {
		text = frame;
	} else {
		try {
			text = new TextDecoder("utf-8", { fatal: true }).decode(frame);
		} catch {
			throw new ManagedSessionContractError("malformed", "managed-session frame is not valid UTF-8");
		}
	}
	if (Buffer.byteLength(text, "utf8") > MAX_NDJSON_FRAME_BYTES) {
		throw new ManagedSessionContractError("malformed", `managed-session frame exceeds ${MAX_NDJSON_FRAME_BYTES} bytes`);
	}
	if (!text.endsWith("\n") || text.slice(0, -1).includes("\n") || text.includes("\r")) {
		throw new ManagedSessionContractError("malformed", "managed-session frame must be exactly one LF-terminated NDJSON record");
	}
	let value: unknown;
	try {
		value = JSON.parse(text.slice(0, -1));
	} catch {
		throw new ManagedSessionContractError("malformed", "managed-session frame is not valid JSON");
	}
	return parseManagedSessionEnvelope(value);
}

export function encodeNdjsonEnvelope(value: unknown): string {
	const envelope = parseManagedSessionEnvelope(value);
	const frame = `${JSON.stringify(envelope)}\n`;
	if (Buffer.byteLength(frame, "utf8") > MAX_NDJSON_FRAME_BYTES) {
		throw new ManagedSessionContractError("malformed", `managed-session frame exceeds ${MAX_NDJSON_FRAME_BYTES} bytes`);
	}
	return frame;
}

export function parseConversationManifest(value: unknown): ConversationManifest {
	if (typeof value === "object" && value !== null && "schemaVersion" in value &&
		(value as { schemaVersion?: unknown }).schemaVersion !== MANAGED_SESSION_STATE_VERSION) {
		throw new ManagedSessionContractError("unsupported_version", "unsupported conversation manifest version");
	}
	assertSchema(ConversationManifestSchema, value, "conversation manifest");
	const manifest = value as ConversationManifest;
	assertTimestamp(manifest.createdAt, "createdAt");
	if (manifest.placement) assertWorkspaceIdentity(manifest.placement);
	return manifest;
}

export function parseHostRuntimeState(value: unknown): HostRuntimeState {
	if (typeof value === "object" && value !== null && "schemaVersion" in value &&
		(value as { schemaVersion?: unknown }).schemaVersion !== MANAGED_SESSION_STATE_VERSION) {
		throw new ManagedSessionContractError("unsupported_version", "unsupported host runtime state version");
	}
	let candidate = value;
	if (typeof value === "object" && value !== null && Array.isArray((value as { conversations?: unknown }).conversations)) {
		const migrated = structuredClone(value) as { conversations: Array<Record<string, unknown>> };
		let changed = false;
		for (const conversation of migrated.conversations) {
			if (!("matrixCursor" in conversation)) {
				conversation.matrixCursor = typeof conversation.matrixSince === "string"
					? { status: "established", since: conversation.matrixSince } : { status: "bootstrap" };
				delete conversation.matrixSince; changed = true;
			}
		}
		if (changed) candidate = migrated;
	}
	assertSchema(HostRuntimeStateSchema, candidate, "host runtime state");
	const state = candidate as HostRuntimeState;
	const conversationIds = new Set<string>();
	for (const conversation of state.conversations) {
		if (conversationIds.has(conversation.conversationId)) {
			throw new ManagedSessionContractError("conflict", `duplicate runtime conversation ${conversation.conversationId}`);
		}
		conversationIds.add(conversation.conversationId);
		if (conversation.state === "active" && conversation.attachment === null) {
			throw new ManagedSessionContractError("invalid_state", `active conversation ${conversation.conversationId} has no attachment`);
		}
		if (conversation.state === "dormant" && conversation.attachment !== null) {
			throw new ManagedSessionContractError("invalid_state", `dormant conversation ${conversation.conversationId} has an attachment`);
		}
		const deliveries = new Set<string>();
		const matrixEvents = new Set<string>();
		for (const input of conversation.pendingInputs) {
			if (deliveries.has(input.deliveryId) || matrixEvents.has(input.matrixEventId)) {
				throw new ManagedSessionContractError("conflict", `conflicting pending input in ${conversation.conversationId}`);
			}
			deliveries.add(input.deliveryId);
			matrixEvents.add(input.matrixEventId);
			assertInputBody(input.kind, input.body);
		}
		if (conversation.attachment) assertTimestamp(conversation.attachment.connectedAt, "attachment.connectedAt");
		if (conversation.lastLaunchError) assertTimestamp(conversation.lastLaunchError.at, "lastLaunchError.at");
		const entries = new Set<string>();
		const checkpointOrigins = new Set<string>();
		const chunks = new Set<string>();
		const transactions = new Set<string>();
		for (const projection of conversation.projection) {
			if (entries.has(projection.entryId)) {
				throw new ManagedSessionContractError("conflict", `duplicate projection entry ${projection.entryId}`);
			}
			entries.add(projection.entryId);
			if ((projection.kind === "checkpoint") !== (projection.originDeliveryId !== undefined)) {
				throw new ManagedSessionContractError("invalid_state", `checkpoint projection ${projection.entryId} has invalid origin metadata`);
			}
			if (projection.originDeliveryId) {
				if (checkpointOrigins.has(projection.originDeliveryId)) throw new ManagedSessionContractError("conflict", `duplicate checkpoint origin ${projection.originDeliveryId}`);
				checkpointOrigins.add(projection.originDeliveryId);
			}
			for (const chunk of projection.chunks) {
				if (chunks.has(chunk.chunkId)) {
					throw new ManagedSessionContractError("conflict", `duplicate projection chunk ${chunk.chunkId}`);
				}
				if (transactions.has(chunk.transactionId)) {
					throw new ManagedSessionContractError("conflict", `duplicate Matrix transaction ${chunk.transactionId}`);
				}
				chunks.add(chunk.chunkId);
				transactions.add(chunk.transactionId);
			}
		}
	}
	return state;
}

export function parsePersistenceBundle(manifestValues: unknown[], runtimeValue: unknown): {
	manifests: ConversationManifest[];
	runtime: HostRuntimeState;
} {
	const manifests = manifestValues.map(parseConversationManifest);
	const runtime = parseHostRuntimeState(runtimeValue);
	const ids = new Set<string>();
	const rooms = new Set<string>();
	const sessions = new Set<string>();
	const creationKeys = new Set<string>();
	for (const manifest of manifests) {
		if (manifest.ownerHostId !== runtime.hostId) {
			throw new ManagedSessionContractError("conflict", `manifest ${manifest.conversationId} belongs to another host`);
		}
		for (const [set, value, label] of [
			[ids, manifest.conversationId, "conversation"],
			[rooms, manifest.roomId, "room"],
			[sessions, manifest.piSessionId, "Pi session"],
			[creationKeys, manifest.creationKey, "creation key"],
		] as const) {
			if (set.has(value)) throw new ManagedSessionContractError("conflict", `duplicate ${label} identity ${value}`);
			set.add(value);
		}
	}
	if (runtime.conversations.length !== manifests.length || runtime.conversations.some((item) => !ids.has(item.conversationId))) {
		throw new ManagedSessionContractError("conflict", "runtime conversations and synchronized manifests do not match exactly");
	}
	return { manifests, runtime };
}

function derive(prefix: string, domain: string, parts: readonly (string | number)[], length = 32): string {
	const hash = createHash("sha256");
	hash.update(`pi-managed-sessions:${domain}:v1\0`, "utf8");
	for (const part of parts) {
		const value = String(part);
		hash.update(`${Buffer.byteLength(value, "utf8")}:`, "utf8");
		hash.update(value, "utf8");
	}
	return `${prefix}_${hash.digest("hex").slice(0, length)}`;
}

export const deriveConversationId = (hostId: string, creationKey: string): string =>
	derive("conv", "conversation", [hostId, creationKey]);
export const deriveDeliveryId = (conversationId: string, matrixEventId: string): string =>
	derive("delivery", "matrix-delivery", [conversationId, matrixEventId]);
export const deriveTranscriptEntryId = (piSessionId: string, piEntryKey: string): string =>
	derive("entry", "pi-transcript-entry", [piSessionId, piEntryKey]);
export const deriveChunkId = (entryId: string, chunkIndex: number): string => {
	if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0) throw new ManagedSessionContractError("malformed", "chunk index must be a non-negative safe integer");
	return derive("chunk", "transcript-chunk", [entryId, chunkIndex]);
};
export const deriveMatrixTransactionId = (conversationId: string, sourceId: string, chunkIndex: number): string => {
	if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0) throw new ManagedSessionContractError("malformed", "chunk index must be a non-negative safe integer");
	return derive("pi", "matrix-transaction", [conversationId, sourceId, chunkIndex], 48);
};
