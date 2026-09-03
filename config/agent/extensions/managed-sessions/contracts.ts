import { createHash } from "node:crypto";
import { Type, type TSchema } from "typebox";
import { Check, Errors } from "typebox/value";

export const MANAGED_SESSION_PROTOCOL_VERSION = "1.0.0" as const;
export const MANAGED_SESSION_STATE_VERSION = "1.0.0" as const;
export const MAX_NDJSON_FRAME_BYTES = 64 * 1024;
export const MAX_INPUT_TEXT_LENGTH = 16_000;
export const MAX_TRANSCRIPT_TEXT_LENGTH = 64_000;
export const MAX_PENDING_INPUTS = 2_048;
export const MAX_PENDING_CONTROLS = 2_048;
export const MAX_COMPLETED_CONTROLS = 4_096;
export const MAX_CONTROL_POLL_OPTIONS = 20;
export const MAX_CHECKPOINT_POLL_OPTIONS = 8;
export const MAX_PROJECTION_ENTRIES = 4_096;
export const MAX_ARTIFACT_EXPORTS = 256;

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
export const GenerationIdSchema = stableId("generation");
export const TransitionIdSchema = stableId("transition");
const BlobIdSchema = stableId("blob");
const UploadIdSchema = stableId("upload");
const MediaDigestSchema = Type.String({ pattern: "^[a-f0-9]{64}$" });
const MediaMimeSchema = Type.Union([Type.Literal("image/jpeg"), Type.Literal("image/png"), Type.Literal("image/webp")]);
const ArtifactMimeSchema = Type.String({ minLength: 3, maxLength: 127, pattern: "^[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*$" });
const ArtifactMediaTypeSchema = Type.Union([Type.Literal("image"), Type.Literal("audio"), Type.Literal("file")]);
const mediaDescriptor = {
	blobId: BlobIdSchema, sha256: MediaDigestSchema, mimeType: MediaMimeSchema,
	byteLength: Type.Integer({ minimum: 1, maximum: 25 * 1024 * 1024 }),
	width: Type.Integer({ minimum: 1, maximum: 16_384 }), height: Type.Integer({ minimum: 1, maximum: 16_384 }),
	chunkCount: Type.Integer({ minimum: 1, maximum: 800 }),
};

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
		operation: Type.Literal("project.create"),
		creationKey: identifier,
		rootKey: identifier,
		workspace: boundedString(128),
		concept: boundedString(128),
	}),
	strictObject({
		operation: Type.Literal("conversation.start"),
		creationKey: identifier,
		concept: boundedString(128),
		placement: WorkspaceIdentitySchema,
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
	clientEnvelope(adapterRole, "media.reject", {
		deliveryId: DeliveryIdSchema, blobId: BlobIdSchema,
		reason: Type.Union([Type.Literal("unsupported_model"), Type.Literal("invalid_media")]),
	}),
	clientEnvelope(Type.Literal("ordinary_adapter"), "artifact.begin", {
		uploadId: UploadIdSchema, blobId: BlobIdSchema, sha256: MediaDigestSchema,
		filename: boundedString(255), mimeType: ArtifactMimeSchema, mediaType: ArtifactMediaTypeSchema,
		byteLength: Type.Integer({ minimum: 1, maximum: 25 * 1024 * 1024 }),
		chunkCount: Type.Integer({ minimum: 1, maximum: 800 }),
		width: Type.Optional(Type.Integer({ minimum: 1, maximum: 16_384 })),
		height: Type.Optional(Type.Integer({ minimum: 1, maximum: 16_384 })),
	}),
	clientEnvelope(Type.Literal("ordinary_adapter"), "artifact.chunk", {
		uploadId: UploadIdSchema, blobId: BlobIdSchema, index: Type.Integer({ minimum: 0, maximum: 799 }),
		sha256: MediaDigestSchema, data: Type.String({ minLength: 4, maxLength: 43_692, pattern: "^[A-Za-z0-9+/]+={0,2}$" }),
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
		generation: Type.Optional(strictObject({ model: Type.Optional(boundedString(256)), thinking: Type.Optional(boundedString(32)) })),
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
	clientEnvelope(Type.Literal("ordinary_adapter"), "aloop.notice", {
		scopeSessionId: identifier, lifecycleId: stableId("aloop"),
		kind: Type.Union([Type.Literal("startup"), Type.Literal("startup-failure"), Type.Literal("attempt-settled"), Type.Literal("checkpoint"), Type.Literal("bounded-stop"), Type.Literal("cancelled"), Type.Literal("epic-ready"), Type.Literal("recovery")]),
		epic: Type.Integer({ minimum: 1 }), issue: Type.Optional(Type.Integer({ minimum: 1 })), body: boundedString(1_600), timestamp,
	}),
	clientEnvelope(Type.Literal("ordinary_adapter"), "self.status", {}),
	clientEnvelope(Type.Literal("ordinary_adapter"), "self.delete", { confirmed: Type.Literal(true) }),
	clientEnvelope(Type.Literal("coordinator_adapter"), "lifecycle.request", {
		request: lifecycleArguments,
	}),
	relayEnvelope("attachment.accepted", {
		attachmentId: identifier,
		generation: Type.Optional(Type.Integer({ minimum: 1 })),
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
	relayEnvelope("media.begin", {
		deliveryId: DeliveryIdSchema, matrixEventId: boundedString(255), ...mediaDescriptor,
		caption: boundedString(MAX_INPUT_TEXT_LENGTH),
	}),
	relayEnvelope("media.chunk", {
		deliveryId: DeliveryIdSchema, blobId: BlobIdSchema, index: Type.Integer({ minimum: 0, maximum: 799 }),
		sha256: MediaDigestSchema, data: Type.String({ minLength: 4, maxLength: 43_692, pattern: "^[A-Za-z0-9+/]+={0,2}$" }),
	}),
	relayEnvelope("media.result", {
		deliveryId: DeliveryIdSchema, blobId: BlobIdSchema, status: Type.Literal("rejected"),
	}),
	relayEnvelope("artifact.acknowledge", {
		uploadId: UploadIdSchema, status: Type.Union([Type.Literal("ready"), Type.Literal("sent")]),
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
	relayEnvelope("aloop.acknowledge", {
		lifecycleId: stableId("aloop"), status: Type.Literal("projected"),
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
		strictObject({
			operation: Type.Literal("project.create"), targetConversationId: ConversationIdSchema,
			conversationState: Type.Union([Type.Literal("starting"), Type.Literal("active"), Type.Literal("dormant")]),
			roomLink: boundedString(512),
		}),
	])),
	relayEnvelope("termination.request", {
		deliveryId: Type.Optional(DeliveryIdSchema),
		reason: Type.Union([Type.Literal("stop"), Type.Literal("abort"), Type.Literal("bridge_delete"), Type.Literal("generation_change")]),
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

const sessionGeneration = strictObject({
	generationId: GenerationIdSchema, ordinal: Type.Integer({ minimum: 1 }), piSessionId: identifier,
	bindingBoundaryEntryId: TranscriptEntryIdSchema, createdAt: timestamp,
	model: Type.Optional(boundedString(256)), thinking: Type.Optional(boundedString(32)),
});
const generationManifestFields = {
	activeGenerationId: Type.Optional(GenerationIdSchema),
	generations: Type.Optional(Type.Array(sessionGeneration, { minItems: 1, maxItems: 256 })),
};
const ProjectKeySchema = Type.String({ pattern: "^project_[a-f0-9]{32}$" });
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
	projectKey: Type.Optional(ProjectKeySchema),
	projectDisplayName: Type.Optional(boundedString(128)),
	checkoutDisplayName: Type.Optional(boundedString(128)),
	projectSpace: Type.Optional(boundedString(255)),
	bindingBoundaryEntryId: TranscriptEntryIdSchema,
	createdAt: timestamp,
	...generationManifestFields,
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
	...generationManifestFields,
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
	media: Type.Optional(strictObject(mediaDescriptor)),
});
const pendingControl = strictObject({
	controlId: stableId("control"),
	matrixEventId: boundedString(255),
	name: Type.Union([
		Type.Literal("help"), Type.Literal("status"), Type.Literal("model"), Type.Literal("thinking"),
		Type.Literal("compact"), Type.Literal("new"), Type.Literal("stop"),
	]),
	argument: Type.Optional(boundedString(4_096)),
});
const controlPollScope = Type.Union([Type.Literal("model"), Type.Literal("thinking")]);
const controlPollOptions = Type.Array(strictObject({ answerId: boundedString(255), command: boundedString(255) }), { minItems: 1, maxItems: MAX_CONTROL_POLL_OPTIONS });
const publishingControlPoll = strictObject({
	sourceControl: pendingControl,
	scope: controlPollScope,
	transactionId: MatrixTransactionIdSchema,
	prompt: boundedString(4_096),
	options: controlPollOptions,
});
const activeControlPoll = strictObject({
	pollEventId: boundedString(255),
	sourceControlId: stableId("control"),
	scope: controlPollScope,
	options: controlPollOptions,
});
const checkpointPollOptions = Type.Array(strictObject({ answerId: boundedString(255), text: boundedString(300) }), { minItems: 1, maxItems: MAX_CHECKPOINT_POLL_OPTIONS });
const checkpointPollBase = {
	checkpointId: identifier,
	originDeliveryId: DeliveryIdSchema,
	entryId: TranscriptEntryIdSchema,
	transactionId: MatrixTransactionIdSchema,
	question: boundedString(4_096),
	options: checkpointPollOptions,
	intentHash: Type.String({ pattern: "^[a-f0-9]{64}$" }),
};
const publishingCheckpointPoll = strictObject(checkpointPollBase);
const activeCheckpointPoll = strictObject({ ...checkpointPollBase, pollEventId: boundedString(255) });
const closingCheckpointPoll = strictObject({
	...checkpointPollBase,
	pollEventId: boundedString(255),
	resolutionEventId: boundedString(255),
	selectedAnswerId: Type.Optional(boundedString(255)),
	closureTransactionId: MatrixTransactionIdSchema,
	fallback: Type.Union([Type.Literal("Selection accepted"), Type.Literal("Answered by text")]),
});
const artifactExport = strictObject({
	uploadId: UploadIdSchema, blobId: BlobIdSchema, sha256: MediaDigestSchema,
	filename: boundedString(255), mimeType: ArtifactMimeSchema, mediaType: ArtifactMediaTypeSchema,
	byteLength: Type.Integer({ minimum: 1, maximum: 25 * 1024 * 1024 }),
	width: Type.Optional(Type.Integer({ minimum: 1, maximum: 16_384 })),
	height: Type.Optional(Type.Integer({ minimum: 1, maximum: 16_384 })),
	transactionId: MatrixTransactionIdSchema,
	state: Type.Union([Type.Literal("spooled"), Type.Literal("created"), Type.Literal("uploaded"), Type.Literal("sent")]),
	mxcUrl: Type.Optional(boundedString(512)), reservationExpiresAt: Type.Optional(timestamp), eventId: Type.Optional(boundedString(255)), createdAt: timestamp,
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
	pendingControls: Type.Array(pendingControl, { maxItems: MAX_PENDING_CONTROLS }),
	completedControlIds: Type.Array(stableId("control"), { maxItems: MAX_COMPLETED_CONTROLS }),
	publishingControlPoll: nullable(publishingControlPoll),
	activeControlPoll: nullable(activeControlPoll),
	publishingCheckpointPoll: nullable(publishingCheckpointPoll),
	activeCheckpointPoll: nullable(activeCheckpointPoll),
	closingCheckpointPolls: Type.Array(closingCheckpointPoll, { maxItems: 64 }),
	artifactExports: Type.Array(artifactExport, { maxItems: MAX_ARTIFACT_EXPORTS }),
	projection: Type.Array(projectionEntry, { maxItems: MAX_PROJECTION_ENTRIES }),
	managedWindow: nullable(
		strictObject({
			sessionName: boundedString(128),
			windowId: boundedString(64),
			paneId: boundedString(64),
		}),
	),
	lastLaunchError: Type.Optional(strictObject({ code: identifier, message: boundedString(500), at: timestamp })),
	generationTransition: Type.Optional(nullable(strictObject({
		transitionId: TransitionIdSchema, sourceControlId: stableId("control"), phase: Type.Union([
			Type.Literal("requested"), Type.Literal("session_persisted"), Type.Literal("activated"), Type.Literal("attached"), Type.Literal("failed"),
		]),
		fromGenerationId: GenerationIdSchema, toGenerationId: GenerationIdSchema, ordinal: Type.Integer({ minimum: 2 }), requestedAt: timestamp,
		model: Type.Optional(boundedString(256)), thinking: Type.Optional(boundedString(32)),
		toPiSessionId: Type.Optional(identifier), toBindingBoundaryEntryId: Type.Optional(TranscriptEntryIdSchema),
		failure: Type.Optional(strictObject({ code: identifier, message: boundedString(500), at: timestamp })),
	}))),
});
export const HostRuntimeStateSchema = strictObject({
	schemaVersion: Type.Literal(MANAGED_SESSION_STATE_VERSION),
	hostId: identifier,
	conversations: Type.Array(runtimeConversation, { maxItems: 4_096 }),
});

export interface SessionGeneration {
	generationId: string; ordinal: number; piSessionId: string; bindingBoundaryEntryId: string; createdAt: string;
	model?: string; thinking?: string;
}

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
	projectKey?: string;
	projectDisplayName?: string;
	checkoutDisplayName?: string;
	projectSpace?: string;
	hostSpace?: string;
	bindingBoundaryEntryId: string;
	createdAt: string;
	activeGenerationId?: string;
	generations?: SessionGeneration[];
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
		pendingInputs: Array<{ deliveryId: string; matrixEventId: string; kind: string; body?: string; piEntryId?: string; status: string;
			media?: { blobId: string; sha256: string; mimeType: "image/jpeg" | "image/png" | "image/webp"; byteLength: number; width: number; height: number; chunkCount: number } }>;
		pendingControls: Array<{ controlId: string; matrixEventId: string; name: "help" | "status" | "model" | "thinking" | "compact" | "new" | "stop"; argument?: string }>;
		completedControlIds: string[];
		publishingControlPoll: null | {
			sourceControl: { controlId: string; matrixEventId: string; name: "help" | "status" | "model" | "thinking" | "compact" | "new" | "stop"; argument?: string };
			scope: "model" | "thinking"; transactionId: string; prompt: string;
			options: Array<{ answerId: string; command: string }>;
		};
		activeControlPoll: null | { pollEventId: string; sourceControlId: string; scope: "model" | "thinking"; options: Array<{ answerId: string; command: string }> };
		publishingCheckpointPoll: null | { checkpointId: string; originDeliveryId: string; entryId: string; transactionId: string; question: string; options: Array<{ answerId: string; text: string }>; intentHash: string };
		activeCheckpointPoll: null | { checkpointId: string; originDeliveryId: string; entryId: string; transactionId: string; question: string; options: Array<{ answerId: string; text: string }>; intentHash: string; pollEventId: string };
		closingCheckpointPolls: Array<{ checkpointId: string; originDeliveryId: string; entryId: string; transactionId: string; question: string; options: Array<{ answerId: string; text: string }>; intentHash: string; pollEventId: string; resolutionEventId: string; selectedAnswerId?: string; closureTransactionId: string; fallback: "Selection accepted" | "Answered by text" }>;
		artifactExports: Array<{ uploadId: string; blobId: string; sha256: string; filename: string; mimeType: string; mediaType: "image" | "audio" | "file"; byteLength: number; width?: number; height?: number; transactionId: string; state: "spooled" | "created" | "uploaded" | "sent"; mxcUrl?: string; reservationExpiresAt?: string; eventId?: string; createdAt: string }>;
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
		generationTransition?: null | {
			transitionId: string; sourceControlId: string; phase: "requested" | "session_persisted" | "activated" | "attached" | "failed";
			fromGenerationId: string; toGenerationId: string; ordinal: number; requestedAt: string; model?: string; thinking?: string;
			toPiSessionId?: string; toBindingBoundaryEntryId?: string; failure?: { code: string; message: string; at: string };
		};
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
	if (envelope.type === "media.chunk" || envelope.type === "artifact.chunk") {
		const payload = envelope.payload as { data: string; sha256: string };
		const decoded = Buffer.from(payload.data, "base64");
		if (decoded.length < 1 || decoded.length > 32 * 1024 || decoded.toString("base64") !== payload.data || createHash("sha256").update(decoded).digest("hex") !== payload.sha256) {
			throw new ManagedSessionContractError("malformed", "media chunk failed canonical base64, size, or digest validation");
		}
	}
	if (envelope.type === "media.begin" || envelope.type === "artifact.begin") {
		const payload = envelope.payload as { byteLength: number; chunkCount: number; mediaType?: string; width?: number; height?: number; filename?: string };
		if (Math.ceil(payload.byteLength / (32 * 1024)) !== payload.chunkCount ||
			(envelope.type === "media.begin" && (!payload.width || !payload.height || payload.width * payload.height > 40_000_000)) ||
			(envelope.type === "artifact.begin" && ((payload.mediaType === "image") !== (payload.width !== undefined && payload.height !== undefined) ||
				(payload.width !== undefined && payload.height !== undefined && payload.width * payload.height > 40_000_000) ||
				!payload.filename || /[\\/\u0000-\u001f\u007f]/.test(payload.filename)))) {
			throw new ManagedSessionContractError("malformed", "media descriptor failed chunk, filename, or dimension bounds");
		}
	}
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
	if (envelope.type === "control.result") {
		const payload = envelope.payload as { status: string; options?: string[]; generation?: unknown };
		if (payload.generation !== undefined && (envelope.role !== "ordinary_adapter" || payload.status !== "ok" || payload.options !== undefined)) {
			throw new ManagedSessionContractError("malformed", "generation metadata is permitted only on an accepted ordinary control result");
		}
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
		const payload = envelope.payload as { request: { operation: string; placement?: WorkspaceIdentity; workspace?: string } };
		if (payload.request.operation === "conversation.start" && payload.request.placement) assertWorkspaceIdentity(payload.request.placement);
		if (payload.request.operation === "project.create" && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(payload.request.workspace ?? "")) {
			throw new ManagedSessionContractError("malformed", "project workspace must be one safe immediate-child name");
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
	const projectIdentityFields = [manifest.projectKey, manifest.projectDisplayName, manifest.checkoutDisplayName];
	if (manifest.kind === "coordinator" && projectIdentityFields.some((field) => field !== undefined) ||
		manifest.kind === "project" && projectIdentityFields.some((field) => field !== undefined) &&
			(projectIdentityFields.some((field) => field === undefined) || projectIdentityFields.slice(1).some((field) => /[\u0000-\u001f\u007f/]/.test(field ?? "")))) {
		throw new ManagedSessionContractError("invalid_state", "stable project identity fields must appear together on project manifests only");
	}
	if ((manifest.activeGenerationId === undefined) !== (manifest.generations === undefined)) {
		throw new ManagedSessionContractError("invalid_state", "active generation and generation history must appear together");
	}
	if (manifest.generations) {
		const newest = manifest.generations.at(-1);
		if (!newest || newest.generationId !== manifest.activeGenerationId || newest.piSessionId !== manifest.piSessionId ||
			newest.bindingBoundaryEntryId !== manifest.bindingBoundaryEntryId || manifest.generations.some((generation, index) =>
				generation.ordinal !== index + 1 || generation.generationId !== deriveGenerationId(manifest.conversationId, generation.ordinal)) ||
			new Set(manifest.generations.map((generation) => generation.piSessionId)).size !== manifest.generations.length) {
			throw new ManagedSessionContractError("invalid_state", "conversation generation history is not contiguous or active");
		}
		for (const generation of manifest.generations) assertTimestamp(generation.createdAt, "generation.createdAt");
	}
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
			if (!("pendingControls" in conversation)) { conversation.pendingControls = []; changed = true; }
			if (!("completedControlIds" in conversation)) { conversation.completedControlIds = []; changed = true; }
			if (!("publishingControlPoll" in conversation)) { conversation.publishingControlPoll = null; changed = true; }
			if (!("activeControlPoll" in conversation)) { conversation.activeControlPoll = null; changed = true; }
			if (!("publishingCheckpointPoll" in conversation)) { conversation.publishingCheckpointPoll = null; changed = true; }
			if (!("activeCheckpointPoll" in conversation)) { conversation.activeCheckpointPoll = null; changed = true; }
			if (!("closingCheckpointPolls" in conversation)) { conversation.closingCheckpointPolls = []; changed = true; }
			if (!("artifactExports" in conversation)) { conversation.artifactExports = []; changed = true; }
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
		const liveMediaBlobs = new Set<string>();
		for (const input of conversation.pendingInputs) {
			if (deliveries.has(input.deliveryId) || matrixEvents.has(input.matrixEventId)) {
				throw new ManagedSessionContractError("conflict", `conflicting pending input in ${conversation.conversationId}`);
			}
			deliveries.add(input.deliveryId);
			matrixEvents.add(input.matrixEventId);
			assertInputBody(input.kind, input.body);
			if (input.media) {
				if (input.kind !== "prompt" || Math.ceil(input.media.byteLength / (32 * 1024)) !== input.media.chunkCount || input.media.width * input.media.height > 40_000_000) {
					throw new ManagedSessionContractError("invalid_state", `invalid pending media in ${conversation.conversationId}`);
				}
				if (input.status !== "completed" && input.status !== "cancelled" && liveMediaBlobs.has(input.media.blobId)) {
					throw new ManagedSessionContractError("conflict", `duplicate live media in ${conversation.conversationId}`);
				}
				if (input.status !== "completed" && input.status !== "cancelled") liveMediaBlobs.add(input.media.blobId);
			}
		}
		const controls = new Set<string>();
		for (const control of conversation.pendingControls) {
			if (controls.has(control.controlId) || matrixEvents.has(control.matrixEventId)) {
				throw new ManagedSessionContractError("conflict", `conflicting pending control in ${conversation.conversationId}`);
			}
			controls.add(control.controlId);
			matrixEvents.add(control.matrixEventId);
		}
		const completedControls = new Set(conversation.completedControlIds);
		if (completedControls.size !== conversation.completedControlIds.length || conversation.completedControlIds.some((id) => controls.has(id))) {
			throw new ManagedSessionContractError("conflict", `conflicting completed control in ${conversation.conversationId}`);
		}
		if (conversation.publishingControlPoll) {
			const poll = conversation.publishingControlPoll;
			const source = conversation.pendingControls.find((control) => control.controlId === poll.sourceControl.controlId);
			const answerIds = new Set(poll.options.map((option) => option.answerId));
			const commands = new Set(poll.options.map((option) => option.command));
			if (!source || JSON.stringify(source) !== JSON.stringify(poll.sourceControl) || poll.sourceControl.name !== poll.scope ||
				poll.transactionId !== deriveMatrixTransactionId(conversation.conversationId, poll.sourceControl.controlId, 0) ||
				answerIds.size !== poll.options.length || commands.size !== poll.options.length ||
				poll.options.some((option) => !option.command.startsWith(`!${poll.scope} `))) {
				throw new ManagedSessionContractError("conflict", `invalid publishing control poll in ${conversation.conversationId}`);
			}
		}
		if (conversation.activeControlPoll) {
			const answerIds = new Set(conversation.activeControlPoll.options.map((option) => option.answerId));
			const commands = new Set(conversation.activeControlPoll.options.map((option) => option.command));
			if (answerIds.size !== conversation.activeControlPoll.options.length || commands.size !== conversation.activeControlPoll.options.length ||
				conversation.activeControlPoll.options.some((option) => !option.command.startsWith(`!${conversation.activeControlPoll!.scope} `))) {
				throw new ManagedSessionContractError("conflict", `invalid active control poll in ${conversation.conversationId}`);
			}
		}
		if (conversation.publishingCheckpointPoll && conversation.activeCheckpointPoll) {
			throw new ManagedSessionContractError("conflict", `checkpoint poll cannot be publishing and active in ${conversation.conversationId}`);
		}
		const checkpointPoll = conversation.publishingCheckpointPoll ?? conversation.activeCheckpointPoll;
		if (checkpointPoll) {
			const answerIds = new Set(checkpointPoll.options.map((option) => option.answerId));
			const projection = conversation.projection.find((candidate) => candidate.entryId === checkpointPoll.entryId);
			const expectedHash = deriveCheckpointPollIntentHash(checkpointPoll);
			if (answerIds.size !== checkpointPoll.options.length || checkpointPoll.options.some((option, index) => option.answerId !== deriveCheckpointPollAnswerId(checkpointPoll.checkpointId, index)) ||
				checkpointPoll.intentHash !== expectedHash || projection?.contentHash !== expectedHash || projection?.kind !== "checkpoint" ||
				projection?.originDeliveryId !== checkpointPoll.originDeliveryId || projection?.chunks.length !== 1 ||
				projection?.chunks[0]?.transactionId !== checkpointPoll.transactionId) {
				throw new ManagedSessionContractError("conflict", `invalid checkpoint poll in ${conversation.conversationId}`);
			}
		}
		const closingPollIds = new Set<string>(); const closingResolutionIds = new Set<string>(); const closingTransactions = new Set<string>();
		for (const closing of conversation.closingCheckpointPolls) {
			const answerIds = new Set(closing.options.map((option) => option.answerId));
			const projection = conversation.projection.find((candidate) => candidate.entryId === closing.entryId);
			const origin = conversation.pendingInputs.find((candidate) => candidate.deliveryId === closing.originDeliveryId);
			const resolution = conversation.pendingInputs.find((candidate) => candidate.matrixEventId === closing.resolutionEventId);
			const selectedOption = closing.options.find((option) => option.answerId === closing.selectedAnswerId);
			const expectedHash = deriveCheckpointPollIntentHash(closing);
			if (closingPollIds.has(closing.pollEventId) || closingResolutionIds.has(closing.resolutionEventId) || closingTransactions.has(closing.closureTransactionId) ||
				closing.closureTransactionId !== deriveMatrixTransactionId(conversation.conversationId, closing.pollEventId, 0) || answerIds.size !== closing.options.length ||
				closing.options.some((option, index) => option.answerId !== deriveCheckpointPollAnswerId(closing.checkpointId, index)) ||
				closing.intentHash !== expectedHash || projection?.contentHash !== expectedHash || projection?.kind !== "checkpoint" || projection?.originDeliveryId !== closing.originDeliveryId || projection?.chunks.length !== 1 ||
				projection?.chunks[0]?.transactionId !== closing.transactionId || !origin || !resolution || resolution.kind !== "prompt" ||
				((closing.fallback === "Selection accepted") !== (closing.selectedAnswerId !== undefined)) ||
				(closing.fallback === "Selection accepted" && selectedOption?.text !== resolution.body)) {
				throw new ManagedSessionContractError("conflict", `invalid closing checkpoint poll in ${conversation.conversationId}`);
			}
			closingPollIds.add(closing.pollEventId); closingResolutionIds.add(closing.resolutionEventId); closingTransactions.add(closing.closureTransactionId);
		}
		if (conversation.activeCheckpointPoll && closingPollIds.has(conversation.activeCheckpointPoll.pollEventId)) {
			throw new ManagedSessionContractError("conflict", `active checkpoint poll is already closing in ${conversation.conversationId}`);
		}
		const uploadIds = new Set<string>();
		for (const artifact of conversation.artifactExports) {
			if (uploadIds.has(artifact.uploadId) || artifact.transactionId !== deriveMatrixTransactionId(conversation.conversationId, artifact.uploadId, 0) ||
				(artifact.mediaType === "image") !== (artifact.width !== undefined && artifact.height !== undefined) ||
				(artifact.width !== undefined && artifact.height !== undefined && artifact.width * artifact.height > 40_000_000) ||
				(["created", "uploaded", "sent"].includes(artifact.state) !== (artifact.mxcUrl !== undefined && artifact.reservationExpiresAt !== undefined)) ||
				((artifact.state === "sent") !== (artifact.eventId !== undefined))) {
				throw new ManagedSessionContractError("conflict", `invalid artifact export in ${conversation.conversationId}`);
			}
			assertTimestamp(artifact.createdAt, "artifactExport.createdAt");
			if (artifact.reservationExpiresAt) assertTimestamp(artifact.reservationExpiresAt, "artifactExport.reservationExpiresAt");
			uploadIds.add(artifact.uploadId);
		}
		if (conversation.attachment) assertTimestamp(conversation.attachment.connectedAt, "attachment.connectedAt");
		if (conversation.lastLaunchError) assertTimestamp(conversation.lastLaunchError.at, "lastLaunchError.at");
		if (conversation.generationTransition) {
			const transition = conversation.generationTransition;
			assertTimestamp(transition.requestedAt, "generationTransition.requestedAt");
			if (transition.failure) assertTimestamp(transition.failure.at, "generationTransition.failure.at");
			if (transition.transitionId !== deriveGenerationTransitionId(conversation.conversationId, transition.ordinal - 1, transition.ordinal) ||
				transition.fromGenerationId !== deriveGenerationId(conversation.conversationId, transition.ordinal - 1) ||
				transition.toGenerationId !== deriveGenerationId(conversation.conversationId, transition.ordinal) ||
				(["session_persisted", "activated", "attached"].includes(transition.phase) && (!transition.toPiSessionId || !transition.toBindingBoundaryEntryId)) ||
				(transition.phase === "failed") !== (transition.failure !== undefined)) {
				throw new ManagedSessionContractError("invalid_state", `invalid generation transition in ${conversation.conversationId}`);
			}
		}
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
			[creationKeys, manifest.creationKey, "creation key"],
		] as const) {
			if (set.has(value)) throw new ManagedSessionContractError("conflict", `duplicate ${label} identity ${value}`);
			set.add(value);
		}
		for (const session of manifest.generations?.map((generation) => generation.piSessionId) ?? [manifest.piSessionId]) {
			if (sessions.has(session)) throw new ManagedSessionContractError("conflict", `duplicate Pi session identity ${session}`);
			sessions.add(session);
		}
	}
	if (runtime.conversations.length !== manifests.length || runtime.conversations.some((item) => !ids.has(item.conversationId))) {
		throw new ManagedSessionContractError("conflict", "runtime conversations and synchronized manifests do not match exactly");
	}
	for (const conversation of runtime.conversations) {
		const manifest = manifests.find((candidate) => candidate.conversationId === conversation.conversationId)!;
		const transition = conversation.generationTransition;
		if (transition) {
			const activeGenerationId = manifest.activeGenerationId ?? deriveGenerationId(manifest.conversationId, 1);
			if (![transition.fromGenerationId, transition.toGenerationId].includes(activeGenerationId) ||
				(["activated", "attached"].includes(transition.phase) && activeGenerationId !== transition.toGenerationId) ||
				(transition.phase === "requested" && activeGenerationId !== transition.fromGenerationId) ||
				(activeGenerationId === transition.toGenerationId && (manifest.piSessionId !== transition.toPiSessionId ||
					manifest.bindingBoundaryEntryId !== transition.toBindingBoundaryEntryId))) {
				throw new ManagedSessionContractError("conflict", `generation transition and manifest disagree for ${conversation.conversationId}`);
			}
		}
		const transitionSourceSession = conversation.generationTransition && manifest.generations?.find((generation) =>
			generation.generationId === conversation.generationTransition?.fromGenerationId)?.piSessionId;
		if (conversation.attachment && conversation.attachment.sessionId !== manifest.piSessionId &&
			!(conversation.generationTransition?.phase === "session_persisted" && manifest.activeGenerationId === conversation.generationTransition.toGenerationId &&
				conversation.attachment.sessionId === transitionSourceSession)) {
			throw new ManagedSessionContractError("conflict", `runtime attachment is not the active generation for ${conversation.conversationId}`);
		}
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

export function deriveCheckpointPollAnswerId(checkpointId: string, index: number): string {
	if (!Number.isSafeInteger(index) || index < 0 || index >= MAX_CHECKPOINT_POLL_OPTIONS) throw new ManagedSessionContractError("malformed", "checkpoint poll answer index is out of bounds");
	return derive("answer", "checkpoint-poll-answer", [checkpointId, index]);
}

export function deriveCheckpointPollIntentHash(intent: {
	checkpointId: string; originDeliveryId: string; entryId: string; transactionId: string; question: string;
	options: Array<{ answerId: string; text: string }>;
}): string {
	const hash = createHash("sha256");
	hash.update("pi-managed-sessions:checkpoint-poll-intent:v1\0", "utf8");
	for (const value of [intent.checkpointId, intent.originDeliveryId, intent.entryId, intent.transactionId, intent.question,
		...intent.options.flatMap((option) => [option.answerId, option.text])]) {
		hash.update(`${Buffer.byteLength(value, "utf8")}:`, "utf8"); hash.update(value, "utf8");
	}
	return hash.digest("hex");
}

function deriveV2(prefix: string, domain: string, parts: readonly (string | number)[]): string {
	const hash = createHash("sha256"); hash.update(`pi-managed-sessions:${domain}:v2\0`, "utf8");
	for (const part of parts) { const value = String(part); hash.update(`${Buffer.byteLength(value, "utf8")}:`, "utf8"); hash.update(value, "utf8"); }
	return `${prefix}_${hash.digest("hex").slice(0, 32)}`;
}
export const deriveGenerationId = (conversationId: string, ordinal: number): string => deriveV2("generation", "generation", [conversationId, ordinal]);
export const deriveGenerationTransitionId = (conversationId: string, from: number, to: number): string => deriveV2("transition", "generation-transition", [conversationId, from, to]);

export const deriveProjectCreationKey = (rootKey: string, workspace: string): string =>
	derive("coordinator", "project-creation", [rootKey, workspace]);
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
