// Target contracts for epic #103 / foundation #104. Runtime adoption is staged by the dependent issues;
// this module does not change the existing adapter wire or persistence readers.
import { createHash } from "node:crypto";
import { Type, type Static, type TSchema } from "typebox";
import { Check } from "typebox/value";
import { MatrixRoomIdSchema } from "../matrix-shared/room-id.js";
import { ConversationIdSchema, MatrixUserIdSchema, WorkspaceIdentitySchema } from "./identity-contracts.js";
import { ForkSummarySchema, parseForkSummary } from "./fork-context.js";

/** Opaque discovery key, not ownership authority; never expose native session IDs. */
export function savedSessionKey(hostId: string, sessionId: string): string {
	const hash = createHash("sha256").update("pi-managed-sessions:saved-session:live-v1\0");
	for (const part of [hostId, sessionId]) hash.update(`${Buffer.byteLength(part)}:`).update(part);
	return `session_${hash.digest("hex").slice(0, 32)}`;
}

export const HOST_CONTROL_VERSION = "1.0.0" as const;
export const HOST_CONTROL_FRAME_BYTES = 64 * 1024;
export const ACCOUNT_ACTION_VERSION = "1.0.0" as const;
export const APPROVAL_LIFETIME_MS = 15 * 60_000;
export const HOST_INVENTORY_PAGE_SIZE = 50;
export const HOST_INVENTORY_MAX_PAGE_SIZE = 100;
export const LIVE_WORKSPACE_CAPABILITIES = [
	"host-control-v1", "approval-v1", "retirement-v1", "generation-navigation-v1",
	"commentary-v1", "notification-disposition-v1", "window-first-open-v1", "saved-session-open-v1", "saved-session-import-v1",
] as const;
const strict = <T extends Record<string, TSchema>>(properties: T) => Type.Object(properties, { additionalProperties: false });
const text = (maxLength: number) => Type.String({ minLength: 1, maxLength });
const identifier = Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" });
const stable = (prefix: string) => Type.String({ pattern: `^${prefix}_[a-f0-9]{32}$` });
const digest = Type.String({ pattern: "^[a-f0-9]{64}$" });
const room = MatrixRoomIdSchema;
const gitRef = Type.String({ minLength: 1, maxLength: 255, pattern: "^[A-Za-z0-9][A-Za-z0-9._/@+/-]*$" });
const page = { limit: Type.Optional(Type.Integer({ minimum: 1, maximum: HOST_INVENTORY_MAX_PAGE_SIZE })), cursor: Type.Optional(text(256)) };
const workspace = { rootKey: identifier, workspace: text(128) };
const target = { conversationId: ConversationIdSchema };
const creation = { creationKey: identifier, title: text(128) };
const preview = { previewId: stable("preview"), confirmed: Type.Literal(true) };
const action = <O extends string, T extends Record<string, TSchema>>(operation: O, properties: T) => strict({ operation: Type.Literal(operation), ...properties });

export const HostActionSchema = Type.Union([
	action("host.status", {}),
	action("workspace.list", page),
	action("project.create", { ...workspace, ...creation }),
	action("worktree.list", { ...workspace, ...page }),
	action("worktree.create", { ...workspace, creationKey: identifier, baseRef: gitRef, branch: gitRef }),
	action("worktree.conversation.create", { ...workspace, ...creation, baseRef: gitRef, branch: gitRef }),
	action("worktree.conversation.fork", { ...workspace, ...creation, sourceConversationId: ConversationIdSchema, baseRef: gitRef, branch: gitRef, summary: ForkSummarySchema }),
	action("worktree.remove.preview", { ...workspace, mergeTarget: Type.Optional(gitRef) }),
	action("worktree.remove.apply", preview),
	action("worktree.conversation.cleanup.preview", { ...target, mergeTarget: Type.Optional(gitRef) }),
	action("worktree.conversation.cleanup.apply", preview),
	action("worktree.branch.preview", { ...workspace, branch: gitRef, mergeTarget: gitRef }),
	action("worktree.branch.delete", preview),
	action("conversation.list", page),
	action("conversation.status", target),
	action("conversation.create", { ...creation, placement: WorkspaceIdentitySchema, expectedSessionKey: Type.Optional(stable("session")) }),
	action("conversation.open", { ...target, expectedGenerationId: Type.Optional(stable("generation")) }),
	action("conversation.resume", target),
	action("conversation.stop", target),
	action("conversation.refresh", { ...target, confirmed: Type.Literal(true) }),
	action("conversation.migrate", { ...target, confirmed: Type.Literal(true) }),
	action("conversation.admin.preview", { conversationIds: Type.Array(ConversationIdSchema, { minItems: 1, maxItems: 100, uniqueItems: true }), includeSpaces: Type.Optional(Type.Literal(true)) }),
	action("conversation.admin.apply", preview),
	action("conversation.recover.preview", target),
	action("conversation.recover.apply", { ...preview, operatorClosed: Type.Literal(true), acceptIncompleteInspection: Type.Literal(true) }),
	action("conversation.delete", { ...target, confirmed: Type.Literal(true) }),
	action("conversation.delete.preview", { conversationIds: Type.Array(ConversationIdSchema, { minItems: 1, maxItems: 100, uniqueItems: true }) }),
	action("conversation.delete.apply", preview),
	action("space.reconcile.preview", {}),
	action("space.reconcile.apply", preview),
	action("space.cleanup.preview", {}),
	action("space.cleanup.apply", preview),
	action("coordinator.membership.restore", { confirmed: Type.Literal(true) }),
]);
export type HostAction = Static<typeof HostActionSchema>;

// This context is supplied by the authenticated frontend, never model arguments.
const matrixOrigin = { roomId: room, eventId: text(255), senderUserId: MatrixUserIdSchema };
const modelActor = { kind: Type.Literal("model"), requestId: identifier, conversationId: ConversationIdSchema, generationId: stable("generation"), runId: identifier, toolCallId: identifier };
export const HostActorSchema = Type.Union([
	strict({ kind: Type.Literal("human_local"), requestId: identifier }),
	strict({ kind: Type.Literal("human_matrix"), requestId: identifier, conversationId: ConversationIdSchema, ...matrixOrigin }),
	strict({ ...modelActor, presentation: Type.Literal("local_dialog") }),
	strict({ ...modelActor, presentation: Type.Literal("matrix_poll"), origin: strict(matrixOrigin) }),
]);
export type HostActor = Static<typeof HostActorSchema>;
export const HostRequestSchema = strict({ version: Type.Literal(HOST_CONTROL_VERSION), actor: HostActorSchema, action: HostActionSchema });
export type HostRequest = Static<typeof HostRequestSchema>;

export const HOST_ERROR_EXITS = {
	invalid_request: 2, unavailable: 3, not_found: 4, retired: 4,
	forbidden: 5, approval_required: 5, denied: 5, expired: 5, cancelled: 5,
	conflict: 6, busy: 6, stale_preview: 6, upgrade_required: 7,
	pending: 8, failed: 9,
} as const;

const readOperationNames = [
	"host.status", "workspace.list", "worktree.list", "conversation.list", "conversation.status",
	"worktree.remove.preview", "worktree.conversation.cleanup.preview", "worktree.branch.preview", "conversation.delete.preview",
	"space.reconcile.preview", "space.cleanup.preview", "conversation.recover.preview", "conversation.admin.preview",
] as const satisfies readonly HostAction["operation"][];
const readOperations = new Set<HostAction["operation"]>(readOperationNames);
export type HostReadAction = Extract<HostAction, { operation: typeof readOperationNames[number] }>;
export function isHostReadAction(action: HostAction): action is HostReadAction { return readOperations.has(action.operation); }
export function isHostMutation(action: Pick<HostAction, "operation">): boolean { return !readOperations.has(action.operation); }
export function requiresModelApproval(action: HostAction): boolean { return isHostMutation(action); }

// protectedConversationId is resolved by the host, never supplied by the model.
export function hostActionPolicy(action: HostAction, actor: HostActor, protectedConversationId: string): "forbidden" | "approval" | "direct" {
	const destructive = ["conversation.stop", "conversation.delete", "conversation.migrate", "conversation.recover.preview"];
	if (destructive.includes(action.operation) && "conversationId" in action && action.conversationId === protectedConversationId) return "forbidden";
	// Preview-based apply also revalidates all resolved targets before execution.
	return actor.kind === "model" && isHostMutation(action) ? "approval" : "direct";
}

const enumeration = <T extends string>(values: T[]) => Type.Enum(values);
const runtimeState = enumeration(["running", "stopped", "unknown"]);
const launchState = enumeration(["none", "prepared", "window_created", "attached", "failed"]);
const setupState = enumeration(["pending", "ready", "disconnected", "notification_setup_uncertain"]);
const cleanupState = enumeration(["pending", "complete", "failed"]);
const errorCode = enumeration(Object.keys(HOST_ERROR_EXITS) as Array<keyof typeof HOST_ERROR_EXITS>);
const capabilities = Type.Array(enumeration([...LIVE_WORKSPACE_CAPABILITIES]), { maxItems: LIVE_WORKSPACE_CAPABILITIES.length, uniqueItems: true });
const windowSchema = strict({ sessionName: text(128), windowId: Type.String({ pattern: "^@[0-9]+$" }), paneId: Type.String({ pattern: "^%[0-9]+$" }), conversationId: ConversationIdSchema });
const summaryFields = { conversationId: ConversationIdSchema, title: text(128), runtimeState, launchState, setupState, activeGenerationId: stable("generation"), sessionKey: Type.Optional(stable("session")), window: Type.Optional(windowSchema), errorCode: Type.Optional(errorCode), capabilities };
const displayFields = { projectDisplayName: Type.Optional(text(128)), checkoutDisplayName: Type.Optional(text(128)) };
const projectSummaryFields = { placement: Type.Optional(WorkspaceIdentitySchema), ...displayFields };
const summary = Type.Union([
	strict({ ...summaryFields, kind: Type.Literal("coordinator") }),
	strict({ ...summaryFields, kind: Type.Literal("project"), checkoutId: stable("checkout"), projectKey: stable("project"), ...projectSummaryFields }),
	strict({ ...summaryFields, kind: Type.Literal("project"), reconciliationRequired: Type.Literal(true), projectKey: Type.Optional(stable("project")), ...projectSummaryFields }),
]);
export type HostConversationSummary = Static<typeof summary>;
const availability = enumeration(["available", "unavailable"]);
const listResult = <T extends TSchema>(item: T) => strict({ items: Type.Array(item, { maxItems: HOST_INVENTORY_MAX_PAGE_SIZE }), nextCursor: Type.Union([text(256), Type.Null()]) });
const created = strict({ conversationId: ConversationIdSchema, launchId: stable("launch"), setupState });
const launched = strict({ conversationId: ConversationIdSchema, launchId: stable("launch"), launchState });
const cleanup = strict({ operationId: stable("operation"), cleanupState });
export const HostPreviewTargetSchema = Type.Union([
	strict({ kind: Type.Literal("conversation"), conversationId: ConversationIdSchema }),
	strict({ kind: Type.Literal("worktree"), checkoutId: stable("checkout"), rootKey: identifier, workspace: text(128) }),
	strict({ kind: Type.Literal("space"), roomId: room }),
	strict({ kind: Type.Literal("branch"), checkoutId: stable("checkout"), branch: gitRef, tip: Type.String({ pattern: "^[a-f0-9]{40,64}$" }), mergeTarget: gitRef, mergeCommit: Type.String({ pattern: "^[a-f0-9]{40,64}$" }) }),
]);
const previewResult = strict({ previewId: stable("preview"), expiresAt: Type.String({ format: "date-time" }), targets: Type.Array(HostPreviewTargetSchema, { maxItems: 100 }), activeRuns: Type.Array(strict({ conversationId: ConversationIdSchema, runId: identifier }), { maxItems: 100 }), blockers: Type.Array(text(512), { maxItems: 100 }), warnings: Type.Optional(Type.Array(text(512), { maxItems: 10 })) });
export const HostResultSchemas = {
	"host.status": strict({ hostId: identifier, relayState: enumeration(["ready", "disconnected"]), capabilities, accountState: enumeration(["ready", "pending", "unavailable"]) }),
	"workspace.list": listResult(Type.Union([
		strict({ rootKey: identifier, workspace: text(128), checkoutId: stable("checkout"), projectKey: stable("project"), availability, ...displayFields }),
		strict({ rootKey: identifier, workspace: text(128), reconciliationRequired: Type.Literal(true), projectKey: Type.Optional(stable("project")), availability, ...displayFields }),
	])),
	"project.create": created,
	"worktree.list": listResult(strict({ rootKey: identifier, workspace: text(128), checkoutId: stable("checkout"), branch: Type.Optional(gitRef), locked: Type.Boolean(), availability })),
	"worktree.create": strict({ rootKey: identifier, workspace: text(128), checkoutId: stable("checkout") }),
	"worktree.conversation.create": created,
	"worktree.conversation.fork": strict({ ...created.properties, roomLink: text(512) }),
	"worktree.remove.preview": previewResult,
	"worktree.remove.apply": cleanup,
	"worktree.conversation.cleanup.preview": previewResult,
	"worktree.conversation.cleanup.apply": cleanup,
	"worktree.branch.preview": previewResult,
	"worktree.branch.delete": cleanup,
	"conversation.list": listResult(summary),
	"conversation.status": summary,
	"conversation.create": created,
	"conversation.open": strict({ conversationId: ConversationIdSchema, launchId: stable("launch"), launchState, window: windowSchema }),
	"conversation.resume": launched,
	"conversation.stop": strict({ conversationId: ConversationIdSchema, runtimeState }),
	"conversation.refresh": launched,
	"conversation.migrate": strict({ conversationId: ConversationIdSchema, migrationState: enumeration(["awaiting_exit", "ready"]), message: text(512) }),
	"conversation.delete": strict({ conversationId: ConversationIdSchema, retirementId: stable("retirement"), cleanupState }),
	"conversation.admin.preview": previewResult,
	"conversation.admin.apply": cleanup,
	"conversation.recover.preview": previewResult,
	"conversation.recover.apply": cleanup,
	"conversation.delete.preview": previewResult,
	"conversation.delete.apply": cleanup,
	"space.reconcile.preview": previewResult,
	"space.reconcile.apply": cleanup,
	"space.cleanup.preview": previewResult,
	"space.cleanup.apply": cleanup,
	"coordinator.membership.restore": strict({ conversationId: ConversationIdSchema, setupState }),
} satisfies Record<HostAction["operation"], TSchema>;
const responseBase = { version: Type.Literal(HOST_CONTROL_VERSION), requestId: identifier };
export const HostErrorResponseSchema = strict({ ...responseBase, ok: Type.Literal(false), error: strict({ code: errorCode, message: text(512), retryable: Type.Boolean() }) });
export type HostErrorCode = keyof typeof HOST_ERROR_EXITS;
export type HostResult<O extends HostAction["operation"]> = Static<(typeof HostResultSchemas)[O]>;
export type HostErrorResponse = Static<typeof HostErrorResponseSchema>;
export type HostResponse<O extends HostAction["operation"] = HostAction["operation"]> = HostErrorResponse | {
	version: typeof HOST_CONTROL_VERSION; requestId: string; ok: true; data: HostResult<O>;
};
export function parseHostResponse<O extends HostAction["operation"]>(operation: O, value: unknown): HostResponse<O> {
	const response = validate<HostResponse<O>>(Type.Union([strict({ ...responseBase, ok: Type.Literal(true), data: HostResultSchemas[operation] }), HostErrorResponseSchema]), value);
	if (response.ok && (operation === "conversation.status" || operation === "conversation.list")) {
		const summaries = operation === "conversation.status" ? [response.data as HostConversationSummary] : (response.data as HostResult<"conversation.list">).items;
		for (const item of summaries) if (item.kind === "project" && item.placement) validatePlacement(item.placement);
	}
	if (response.ok && (operation === "workspace.list" || operation === "worktree.list")) {
		for (const item of (response.data as HostResult<"workspace.list"> | HostResult<"worktree.list">).items) validatePlacement(item);
	}
	return response;
}

function validate<T>(schema: TSchema, value: unknown): T {
	if (Buffer.byteLength(`${JSON.stringify(value)}\n`, "utf8") > HOST_CONTROL_FRAME_BYTES) throw new Error("Live-workspace frame exceeds 64 KiB");
	if (!Check(schema, value)) throw new Error("Invalid live-workspace contract");
	return value as T;
}
function validatePlacement(placement: { rootKey: string; workspace: string; relativeCwd?: string }): void {
	if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(placement.rootKey)) throw new Error("Invalid workspace root key");
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(placement.workspace) || placement.workspace === "." || placement.workspace === "..") throw new Error("Invalid workspace name");
	if (placement.relativeCwd !== undefined && placement.relativeCwd !== "" &&
		(placement.relativeCwd.startsWith("/") || placement.relativeCwd.split("/").some((part) => !part || part === "." || part === "..") || /[\\\u0000-\u001f\u007f]/.test(placement.relativeCwd))) throw new Error("Invalid relative cwd");
}
export function parseHostAction(value: unknown): HostAction {
	const result = validate<HostAction>(HostActionSchema, value);
	const placement = "placement" in result ? result.placement : "workspace" in result ? result : undefined;
	if (placement) validatePlacement(placement);
	if (result.operation === "worktree.conversation.fork") parseForkSummary(result.summary);
	if ("title" in result && /[\u0000-\u001f\u007f]/.test(result.title)) throw new Error("Invalid title");
	return result;
}
export function parseHostRequest(value: unknown): HostRequest {
	const request = validate<HostRequest>(HostRequestSchema, value);
	parseHostAction(request.action);
	return request;
}

// Machine-only Matrix to-device messages. The authenticated Matrix sender and
// configured host/account mapping are checked outside this syntax boundary.
const accountBase = { version: Type.Literal(ACCOUNT_ACTION_VERSION), requestId: stable("account"), hostId: identifier, payloadDigest: digest };
const placementProof = {
	hostSpaceId: room,
	project: Type.Optional(strict({ projectKey: stable("project"), spaceId: room })),
	checkout: Type.Optional(strict({ checkoutId: stable("checkout"), spaceId: room })),
};
export const AccountActionSchema = Type.Union([
	strict({ ...accountBase, operation: Type.Literal("room.ensure"), roomId: room, kind: Type.Union([Type.Literal("host_space"), Type.Literal("project_space"), Type.Literal("worktree_space"), Type.Literal("conversation"), Type.Literal("coordinator")]),
		...placementProof, conversationId: Type.Optional(ConversationIdSchema), creationKey: identifier,
		notificationSetup: Type.Union([Type.Literal("new_room"), Type.Literal("preserve")]) }),
	strict({ ...accountBase, operation: Type.Literal("room.retire"), roomId: room, conversationId: ConversationIdSchema, retirementId: stable("retirement") }),
	strict({ ...accountBase, operation: Type.Literal("space.retire"), roomId: room, cleanupId: stable("cleanup"), hostSpaceId: room }),
	strict({ ...accountBase, operation: Type.Literal("coordinator.membership.restore"), roomId: room, conversationId: ConversationIdSchema, hostSpaceId: room,
		departureEventId: Type.String({ pattern: "^\\$[^\\s]+$", maxLength: 255 }) }),
]);
export type AccountAction = Static<typeof AccountActionSchema>;
export const AccountAckSchema = strict({ ...accountBase, revision: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }), status: Type.Union([
	Type.Literal("pending"), Type.Literal("complete"), Type.Literal("notification_setup_uncertain"), Type.Literal("rejected"),
]), code: Type.Optional(Type.Union([Type.Literal("departed"), Type.Literal("unsupported_encryption"), Type.Literal("unverified"), Type.Literal("conflict")])),
	departureEventId: Type.Optional(Type.String({ pattern: "^\\$[^\\s]+$", maxLength: 255 })) });
export type AccountAck = Static<typeof AccountAckSchema>;
function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
	return JSON.stringify(value);
}
function accountRequestId(hostId: string, payloadDigest: string): string {
	const hash = createHash("sha256").update("pi-managed-sessions:account:live-v1\0");
	for (const part of [hostId, payloadDigest]) hash.update(`${Buffer.byteLength(part)}:${part}`);
	return `account_${hash.digest("hex").slice(0, 32)}`;
}
export function accountActionIdentity(value: Record<string, unknown>): { requestId: string; payloadDigest: string } {
	const body = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "requestId" && key !== "payloadDigest"));
	if (typeof body.hostId !== "string") throw new Error("Account host identity is required");
	const payloadDigest = createHash("sha256").update(canonical(body)).digest("hex");
	return { requestId: accountRequestId(body.hostId, payloadDigest), payloadDigest };
}
function checkAccountFrame(value: unknown): void {
	if (Buffer.byteLength(`${JSON.stringify(value)}\n`, "utf8") > 16 * 1024) throw new Error("Account frame exceeds 16 KiB");
}
export function parseAccountAction(value: unknown): AccountAction {
	checkAccountFrame(value);
	const action = validate<AccountAction>(AccountActionSchema, value);
	const expected = accountActionIdentity(action);
	if (action.requestId !== expected.requestId || action.payloadDigest !== expected.payloadDigest) throw new Error("Account action identity mismatch");
	if (action.operation === "space.retire" && action.roomId === action.hostSpaceId) throw new Error("Host Space is protected");
	if (action.operation !== "room.ensure") return action;
	const isConversation = action.kind === "conversation" || action.kind === "coordinator";
	if (isConversation !== (action.conversationId !== undefined)) throw new Error("Conversation identity mismatch");
	const needsProject = action.kind === "project_space" || action.kind === "worktree_space" || action.kind === "conversation";
	const needsCheckout = action.kind === "worktree_space" || action.kind === "conversation";
	if (needsProject !== (action.project !== undefined) || needsCheckout !== (action.checkout !== undefined)) throw new Error("Hierarchy identity mismatch");
	if ((action.kind === "host_space" && action.roomId !== action.hostSpaceId) ||
		(action.kind === "project_space" && action.roomId !== action.project!.spaceId) ||
		(action.kind === "worktree_space" && action.roomId !== action.checkout!.spaceId)) throw new Error("Space identity mismatch");
	if (!isConversation && action.notificationSetup !== "preserve") throw new Error("Space notification setup is forbidden");
	return action;
}
export function parseAccountAck(value: unknown): AccountAck {
	checkAccountFrame(value);
	const ack = validate<AccountAck>(AccountAckSchema, value);
	if (ack.departureEventId !== undefined && ack.code !== "departed") throw new Error("Unexpected account departure evidence");
	if (ack.requestId !== accountRequestId(ack.hostId, ack.payloadDigest)) throw new Error("Account acknowledgement identity mismatch");
	return ack;
}

export type NotificationDisposition = "silent" | "notify";
export type NotificationSetupState = "unattempted" | "attempted" | "confirmed" | "uncertain" | "preserved";
// An attempted state recovered after a crash is uncertain, never unattempted.
export function recoverNotificationSetup(state: NotificationSetupState): NotificationSetupState {
	return state === "attempted" ? "uncertain" : state;
}
