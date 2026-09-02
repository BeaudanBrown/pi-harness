import { createHash, randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { RemoteCheckpointSchema, renderRemoteCheckpoint, validateRemoteCheckpoint } from "../checkpoint.js";
import { deriveActivityId, deriveGenerationId } from "../v2-contracts.js";
import {
	MANAGED_SESSION_STATE_VERSION,
	MAX_PROJECTION_ENTRIES,
	type ManagedSessionEnvelope,
	type WorkspaceIdentity,
} from "../contracts.js";
import { BoundAdapterClient, CoordinatorAdapterClient, ManagedAdapterError, requestSelfBind } from "./client.js";
import {
	BINDING_BOUNDARY_ENTRY_TYPE,
	CHECKPOINT_ENTRY_TYPE,
	BINDING_ENTRY_TYPE,
	DELIVERY_ENTRY_TYPE,
	PROJECTION_DIAGNOSTIC_ENTRY_TYPE,
	PROJECTION_ENTRY_TYPE,
	UNBOUND_ENTRY_TYPE,
	type AdapterRole,
	type DeliveryMarker,
	type ProjectionMarker,
	type SessionBinding,
	findDeliveredUserEntry,
	hasBackfillDiagnostic,
	hasProjectionCapacityDiagnostic,
	planTranscriptBackfill,
	normalizeConcept,
	persistedEntryId,
	restoreBindingAttempt,
	restoreCheckpoints,
	restoreDeliveries,
	restoreProjections,
	restoreSessionBinding,
	transcriptOfferWithinFrame,
} from "./state.js";

type ActivityOutcome = "completed" | "checkpoint" | "cancelled" | "interrupted" | "failed";
interface BusyActivity {
	activityId: string; revision: number; startedAt: number; startContext?: number; inputTokens: number; outputTokens: number;
	modelTurns: number; toolTotal: number; toolErrors: number; compactions: number; requestedOutcome?: ActivityOutcome;
	toolCounts: Map<string, number>; activeTools: Map<string, string>; failedTools: Set<string>; timer?: NodeJS.Timeout; work: Promise<void>;
}

interface AdapterEnvironment {
	socketPath: string;
	attachmentNonce?: string;
	conversationId?: string;
	concept?: string;
	bindingBoundaryEntryId?: string;
	placement?: WorkspaceIdentity;
}

function environmentConfig(environment: NodeJS.ProcessEnv): AdapterEnvironment {
	const socketPath = environment.PI_MANAGED_SESSIONS_SOCKET?.trim();
	if (!socketPath) throw new ManagedAdapterError("PI_MANAGED_SESSIONS_SOCKET is required");
	const attachmentNonce = environment.PI_MANAGED_SESSION_ATTACHMENT_NONCE?.trim();
	if (attachmentNonce && !/^[A-Za-z0-9_-]{32,128}$/.test(attachmentNonce)) throw new ManagedAdapterError("Managed-session attachment nonce is invalid");
	const rootKey = environment.PI_MANAGED_SESSION_ROOT_KEY?.trim();
	const workspace = environment.PI_MANAGED_SESSION_WORKSPACE?.trim();
	const relativeCwd = environment.PI_MANAGED_SESSION_RELATIVE_CWD?.trim() ?? "";
	if ((rootKey || workspace) && (!rootKey || !workspace)) throw new ManagedAdapterError("Managed-session workspace placement is incomplete");
	return {
		socketPath,
		attachmentNonce,
		conversationId: environment.PI_MANAGED_SESSION_CONVERSATION_ID?.trim(),
		concept: environment.PI_MANAGED_SESSION_CONCEPT?.trim(),
		bindingBoundaryEntryId: environment.PI_MANAGED_SESSION_BINDING_BOUNDARY_ENTRY_ID?.trim(),
		placement: rootKey && workspace ? { rootKey, workspace, relativeCwd } : undefined,
	};
}

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) ctx.ui.notify(message, level);
}

function appendMarker<T>(pi: ExtensionAPI, ctx: ExtensionContext, customType: string, data: T): string {
	pi.appendEntry(customType, data);
	const entryId = ctx.sessionManager.getLeafId();
	if (!entryId) throw new ManagedAdapterError(`Pi did not persist ${customType}`);
	return entryId;
}

function bootstrapBinding(pi: ExtensionAPI, ctx: ExtensionContext, role: AdapterRole, config: AdapterEnvironment): SessionBinding | undefined {
	if (!config.conversationId && !config.bindingBoundaryEntryId && !config.concept) return undefined;
	if (!config.conversationId || !/^conv_[a-f0-9]{32}$/.test(config.conversationId) ||
		!config.bindingBoundaryEntryId || !/^entry_[a-f0-9]{32}$/.test(config.bindingBoundaryEntryId) || !config.concept) {
		throw new ManagedAdapterError("Managed-session bootstrap binding is incomplete");
	}
	const binding: SessionBinding = {
		version: MANAGED_SESSION_STATE_VERSION,
		conversationId: config.conversationId,
		concept: config.concept,
		sessionId: ctx.sessionManager.getSessionId(),
		bindingBoundaryEntryId: config.bindingBoundaryEntryId,
		role,
	};
	appendMarker(pi, ctx, BINDING_ENTRY_TYPE, binding);
	return binding;
}

export function createManagedSessionAdapterExtension(role: AdapterRole, environment: NodeJS.ProcessEnv = process.env) {
	return function managedSessionAdapter(pi: ExtensionAPI): void {
		let config: AdapterEnvironment;
		try { config = environmentConfig(environment); } catch (error) {
			pi.on("session_start", (_event, ctx) => notify(ctx, error instanceof Error ? error.message : "Managed-session adapter configuration failed", "error"));
			return;
		}
		let binding: SessionBinding | undefined;
		let client: BoundAdapterClient | undefined;
		let currentContext: ExtensionContext | undefined;
		let reconnectTimer: NodeJS.Timeout | undefined;
		let reconnectAttempt = 0;
		let stopped = false;
		let deliveries = new Map<string, DeliveryMarker>();
		let projections = restoreProjections([]);
		let checkpoints = restoreCheckpoints([]);
	let projectionRun: Promise<void> | undefined;
		let projectionRequestedContext: ExtensionContext | undefined;
		let projectionRetryTimer: NodeJS.Timeout | undefined;
		let projectionRetryAttempt = 0;
		const activeDeliveries = new Map<string, string>();
		const pendingUserPersistence: DeliveryMarker[] = [];
		const inFlightDeliveries = new Set<string>();
		const persistedRecoveryPending = new Set<string>();
		const expandedRecoveryPending = new Set<string>();
		let activity: BusyActivity | undefined;
		const safeToolName = (value: string): string => /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : "tool";
		const boundedToolName = (span: BusyActivity, value: string): string => { const safe = safeToolName(value); return span.toolCounts.has(safe) || span.toolCounts.size < 63 ? safe : "other"; };
		const activityTools = (span: BusyActivity) => [...span.toolCounts].sort(([left], [right]) => left.localeCompare(right)).slice(0, 64).map(([name, count]) => ({
			name, count, state: [...span.activeTools.values()].includes(name) ? "running" as const : span.failedTools.has(name) ? "error" as const : "completed" as const,
		}));
		const sendActivityUpdate = (span: BusyActivity, immediate = false, stateOverride?: "compaction"): void => {
			if (activity !== span || role !== "ordinary_adapter") return;
			const send = () => {
				span.timer = undefined;
				if (activity !== span || !client?.connected) return;
				const revision = ++span.revision;
				const tools = activityTools(span);
				const payload = { activityId: span.activityId, revision, state: stateOverride ?? (tools.length ? "tool" as const : "busy" as const), ...(!stateOverride && tools.length ? { tools } : {}) };
				span.work = span.work.then(() => client?.updateActivity(payload)).catch(() => undefined);
			};
			if (immediate) { if (span.timer) clearTimeout(span.timer); send(); return; }
			if (!span.timer) { span.timer = setTimeout(send, 750); span.timer.unref(); }
		};
		const finalizeActivity = async (ctx: ExtensionContext, outcome?: ActivityOutcome): Promise<void> => {
			const span = activity;
			if (!span || role !== "ordinary_adapter") return;
			if (span.timer) { clearTimeout(span.timer); span.timer = undefined; }
			await span.work;
			if (!client?.connected || activity !== span) { activity = undefined; return; }
			const context = ctx.getContextUsage();
			const used = context?.tokens;
			const limit = ctx.model?.contextWindow;
			const contextSnapshot = typeof used === "number" && typeof span.startContext === "number" && typeof limit === "number" &&
				Number.isFinite(limit) && limit > 0 && used >= 0 && used <= limit
				? { usedTokens: used, remainingTokens: limit - used, limitTokens: limit, deltaTokens: used - span.startContext } : undefined;
			span.revision += 1;
			await client.updateActivity({
				activityId: span.activityId, revision: span.revision, outcome: outcome ?? span.requestedOutcome ?? "completed", durationMs: Math.max(0, Date.now() - span.startedAt),
				...(ctx.model ? { model: `${ctx.model.provider}/${ctx.model.id}` } : {}), ...(ctx.thinkingLevel ? { thinking: ctx.thinkingLevel } : {}), generation: 1,
				...(contextSnapshot ? { context: contextSnapshot } : {}), run: { inputTokens: span.inputTokens, outputTokens: span.outputTokens, modelTurns: span.modelTurns },
				tools: { total: span.toolTotal, errors: span.toolErrors, counts: [...span.toolCounts].sort(([left], [right]) => left.localeCompare(right)).slice(0, 64).map(([name, count]) => ({ name, count })) }, compactions: span.compactions,
			}, true);
			activity = undefined;
		};

		const lifecycle = async (request: Record<string, unknown>) => {
			if (!binding || !client?.connected) throw new ManagedAdapterError("Coordinator relay connection is unavailable");
			const coordinatorClient = client;
			if (!(coordinatorClient instanceof CoordinatorAdapterClient)) throw new ManagedAdapterError("Coordinator lifecycle capability is unavailable");
			const result = await coordinatorClient.lifecycleRequest(request);
			return { content: [{ type: "text" as const, text: JSON.stringify(result.payload, null, 2) }], details: result.payload };
		};
		if (role === "coordinator_adapter") {
			pi.registerTool({ name: "remote_workspace_list", label: "List Managed Workspaces",
				description: "List immediate-child workspaces available for managed project conversations.", parameters: Type.Object({}, { additionalProperties: false }),
				execute: async () => lifecycle({ operation: "workspace.list" }) });
			pi.registerTool({ name: "remote_session_list", label: "List Managed Conversations",
				description: "List all host-owned managed conversations and lifecycle states.", parameters: Type.Object({}, { additionalProperties: false }),
				execute: async () => lifecycle({ operation: "conversation.list" }) });
			pi.registerTool({ name: "remote_session_status", label: "Managed Conversation Status",
				description: "Inspect one managed conversation lifecycle state.", parameters: Type.Object({ conversationId: Type.String({ pattern: "^conv_[a-f0-9]{32}$" }) }, { additionalProperties: false }),
				execute: async (_id, params) => lifecycle({ operation: "conversation.status", targetConversationId: params.conversationId }) });
			pi.registerTool({ name: "remote_session_start", label: "Start Managed Conversation",
				description: "Create an idle managed Pi conversation in an existing depth-one workspace. Do not include an objective or task context; the first Matrix message is the first task.",
				parameters: Type.Object({ rootKey: Type.String({ minLength: 1, maxLength: 128 }), workspace: Type.String({ minLength: 1, maxLength: 128 }),
					relativeCwd: Type.Optional(Type.String({ maxLength: 512 })), projectSpace: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
					concept: Type.String({ minLength: 1, maxLength: 128 }) }, { additionalProperties: false }),
				execute: async (toolCallId, params) => lifecycle({ operation: "conversation.start",
					creationKey: `coordinator-${createHash("sha256").update("pi-managed-sessions:coordinator-tool-call:v1\0").update(toolCallId).digest("hex").slice(0, 32)}`,
					concept: params.concept, placement: { rootKey: params.rootKey, workspace: params.workspace, relativeCwd: params.relativeCwd ?? "" },
					...(params.projectSpace ? { projectSpace: params.projectSpace } : {}) }) });
			for (const operation of ["resume", "stop"] as const) pi.registerTool({
				name: `remote_session_${operation}`, label: `${operation === "resume" ? "Resume" : "Stop"} Managed Conversation`,
				description: `${operation === "resume" ? "Resume the same persisted Pi session in a new managed window" : "Terminate only the exact managed Pi window and leave the conversation dormant"}.`,
				parameters: Type.Object({ conversationId: Type.String({ pattern: "^conv_[a-f0-9]{32}$" }) }, { additionalProperties: false }),
				execute: async (_id, params) => lifecycle({ operation: `conversation.${operation}`, targetConversationId: params.conversationId }),
			});
			pi.registerTool({ name: "remote_session_delete", label: "Delete Managed Bridge",
				description: "Delete only relay/Matrix bridge state after explicit confirmation. Pi session, process, managed window, workspace, and project files are preserved.",
				parameters: Type.Object({ conversationId: Type.String({ pattern: "^conv_[a-f0-9]{32}$" }), confirm: Type.Literal(true) }, { additionalProperties: false }),
				execute: async (_id, params) => lifecycle({ operation: "conversation.delete", targetConversationId: params.conversationId, confirmed: params.confirm }) });
		}

		pi.registerTool({
			name: "remote_checkpoint",
			label: "Remote Checkpoint",
			description: "Send one durable question, blocker, or issue-completion boundary to this managed Matrix conversation and hard-stop the current run pending a new reply.",
			promptSnippet: "Use remote_checkpoint only for an intentional question, blocked state, or issue-completion approval boundary.",
			promptGuidelines: [
				"Do not mirror routine progress, thinking, tool activity, or ordinary terminal answers to Matrix.",
				"Use issue_complete only with objective, implementation, verification, caveat, Git state, and exact approval-request evidence.",
				"Omit code and diffs unless the operator explicitly requested them.",
			],
			parameters: RemoteCheckpointSchema,
			async execute(toolCallId, params, _signal, _onUpdate, ctx) {
				if (!binding || !client?.connected) throw new ManagedAdapterError("remote_checkpoint requires an active managed Matrix conversation");
				for (const pending of [...pendingUserPersistence]) {
					const piEntryKey = findDeliveredUserEntry(ctx.sessionManager.getBranch(), pending.deliveryId);
					if (piEntryKey) {
						pendingUserPersistence.splice(pendingUserPersistence.indexOf(pending), 1);
						persistExpanded(ctx, pending, piEntryKey);
					}
				}
				const originDeliveryId = [...activeDeliveries.keys()].at(-1);
				if (!originDeliveryId) throw new ManagedAdapterError("remote_checkpoint requires an active Matrix delivery");
				const checkpointInput = validateRemoteCheckpoint(params);
				renderRemoteCheckpoint(checkpointInput);
				const checkpoint = checkpointInput as unknown as Record<string, unknown>;
				const checkpointId = `checkpoint-${createHash("sha256").update("pi-managed-sessions:checkpoint:v1\0").update(binding.conversationId).update("\0").update(originDeliveryId).update("\0").update(toolCallId).digest("hex").slice(0, 32)}`;
				const offered = { version: MANAGED_SESSION_STATE_VERSION, checkpointId, originDeliveryId, checkpoint, status: "offered" as const };
				appendMarker(pi, ctx, CHECKPOINT_ENTRY_TYPE, offered); checkpoints.set(checkpointId, offered);
				try {
					await client.offerCheckpoint({ checkpointId, originDeliveryId, checkpoint });
					const projected = { ...offered, status: "projected" as const };
					appendMarker(pi, ctx, CHECKPOINT_ENTRY_TYPE, projected); checkpoints.set(checkpointId, projected);
					const previous = deliveries.get(originDeliveryId);
					if (!previous?.piEntryId) throw new ManagedAdapterError("Checkpoint origin was not durably persisted");
					const completed = { ...previous, status: "completed" as const };
					recordDelivery(ctx, completed); activeDeliveries.delete(originDeliveryId); acknowledge(completed);
					if (activity) activity.requestedOutcome = "checkpoint";
					return { content: [{ type: "text" as const, text: "Remote checkpoint projected. The run is stopped pending new Matrix input." }],
						details: { checkpointId, kind: checkpoint.kind, waiting: true } };
				} finally { ctx.abort(); }
			},
		});

		function setStatus(ctx: ExtensionContext): void {
			if (!ctx.hasUI) return;
			ctx.ui.setStatus("managed-session", binding ? `${client?.connected ? "remote" : "remote offline"}: ${binding.concept}` : undefined);
		}

		function recordDelivery(ctx: ExtensionContext, marker: DeliveryMarker): string {
			const key = appendMarker(pi, ctx, DELIVERY_ENTRY_TYPE, marker);
			deliveries.set(marker.deliveryId, marker);
			return key;
		}

		function persistExpanded(ctx: ExtensionContext, expanded: DeliveryMarker, piEntryKey: string): DeliveryMarker {
			const persisted: DeliveryMarker = {
				...expanded, status: "persisted", piEntryId: persistedEntryId(binding!.sessionId, piEntryKey),
			};
			recordDelivery(ctx, persisted);
			activeDeliveries.set(persisted.deliveryId, persisted.piEntryId!);
			inFlightDeliveries.delete(persisted.deliveryId);
			acknowledge(persisted);
			return persisted;
		}

		function acknowledge(marker: DeliveryMarker): void {
			if (marker.status === "expanded" || marker.status === "reinjecting") return;
			const target = client;
			const ctx = currentContext;
			const currentBinding = binding;
			if (!target) return;
			void target.acknowledgeInput(marker.deliveryId, marker.status, marker.piEntryId, marker.completionKind).catch((error) => {
				if (error instanceof ManagedAdapterError && error.code === "capacity_reached" && marker.piEntryId && ctx && currentBinding &&
					currentContext === ctx && binding === currentBinding &&
					!hasProjectionCapacityDiagnostic(ctx.sessionManager.getBranch(), currentBinding, marker.piEntryId)) {
					appendMarker(pi, ctx, PROJECTION_DIAGNOSTIC_ENTRY_TYPE, {
						version: MANAGED_SESSION_STATE_VERSION, bindingBoundaryEntryId: currentBinding.bindingBoundaryEntryId,
						entryId: marker.piEntryId, limit: MAX_PROJECTION_ENTRIES, reason: "capacity_reached",
					});
					notify(ctx, `Managed Matrix-input provenance capacity was reached at ${marker.piEntryId}`, "error");
				}
				// All delivery states are durable and non-capacity failures replay after reconnect.
			});
		}

		async function projectEligibleEntries(ctx: ExtensionContext, localUsersOnly = false): Promise<void> {
			if (!binding || !client?.connected) return;
			const projectionBinding = binding;
			const projectionClient = client;
			const plan = planTranscriptBackfill(ctx.sessionManager.getBranch(), projectionBinding, deliveries, projections);
			if (plan.excessiveCount !== undefined) {
				if (!hasBackfillDiagnostic(ctx.sessionManager.getBranch(), projectionBinding, plan.excessiveCount)) {
					appendMarker(pi, ctx, PROJECTION_DIAGNOSTIC_ENTRY_TYPE, {
						version: MANAGED_SESSION_STATE_VERSION, bindingBoundaryEntryId: projectionBinding.bindingBoundaryEntryId,
						pendingCount: plan.excessiveCount, limit: MAX_PROJECTION_ENTRIES, reason: "backfill_limit",
					});
				}
				notify(ctx, `Managed transcript backfill has ${plan.excessiveCount} pending entries; bounded projection refused the batch`, "error");
				return;
			}
			for (const entry of plan.entries) {
				if (localUsersOnly && entry.kind !== "local_user") continue;
				if (!projectionClient.connected || binding !== projectionBinding || client !== projectionClient) return;
				let marker = projections.get(entry.entryId);
				if (!transcriptOfferWithinFrame(entry, projectionBinding)) {
					marker = { version: MANAGED_SESSION_STATE_VERSION, entryId: entry.entryId, piEntryKey: entry.piEntryKey,
						kind: entry.kind, status: "blocked", reason: "oversized" };
					recordProjectionMarker(ctx, marker);
					notify(ctx, `Managed transcript entry ${entry.piEntryKey} exceeds the projection size limit`, "error");
					continue;
				}
				if (!marker) {
					marker = { version: MANAGED_SESSION_STATE_VERSION, entryId: entry.entryId, piEntryKey: entry.piEntryKey,
						kind: entry.kind, status: "offered" };
					recordProjectionMarker(ctx, marker);
				}
				try {
					await projectionClient.offerTranscript({ ...entry, piSessionId: projectionBinding.sessionId });
				} catch (error) {
					if (error instanceof ManagedAdapterError && error.code === "capacity_reached") {
						const blocked: ProjectionMarker = { ...marker, status: "blocked", reason: "backfill_limit" };
						recordProjectionMarker(ctx, blocked);
						notify(ctx, `Managed transcript projection capacity was reached at ${entry.piEntryKey}`, "error");
					} else {
						notify(ctx, error instanceof Error ? error.message : "Managed transcript projection was interrupted", "warning");
						scheduleProjectionRetry(ctx);
					}
					return;
				}
				recordProjectionMarker(ctx, { ...marker, status: "projected" });
			}
			projectionRetryAttempt = 0;
			if (projectionRetryTimer) clearTimeout(projectionRetryTimer);
			projectionRetryTimer = undefined;
		}

		function recordProjectionMarker(ctx: ExtensionContext, marker: ProjectionMarker): void {
			appendMarker(pi, ctx, PROJECTION_ENTRY_TYPE, marker);
			projections.set(marker.entryId, marker);
		}

		function scheduleProjectionRetry(ctx: ExtensionContext): void {
			if (projectionRetryTimer || stopped || !binding) return;
			const delay = Math.min(30_000, 1_000 * (2 ** Math.min(projectionRetryAttempt, 5)));
			projectionRetryAttempt += 1;
			projectionRetryTimer = setTimeout(() => {
				projectionRetryTimer = undefined;
				queueProjection(ctx);
			}, delay);
			projectionRetryTimer.unref();
		}

		function queueProjection(ctx: ExtensionContext): void {
			projectionRequestedContext = ctx;
			if (projectionRun) return;
			projectionRun = (async () => {
				while (projectionRequestedContext) {
					const requestedContext = projectionRequestedContext;
					projectionRequestedContext = undefined;
					try { await projectEligibleEntries(requestedContext); }
					catch (error) { notify(requestedContext, error instanceof Error ? error.message : "Managed transcript projection failed", "error"); }
				}
			})().finally(() => { projectionRun = undefined; });
		}

		function replayAcknowledgements(): void {
			for (const marker of deliveries.values()) {
				if (["persisted", "completed", "cancelled"].includes(marker.status)) acknowledge(marker);
			}
		}

		async function handleDelivery(envelope: ManagedSessionEnvelope, ctx: ExtensionContext): Promise<void> {
			const payload = envelope.payload as {
				deliveryId: string; matrixEventId: string; kind: "prompt" | "follow_up" | "steer" | "abort"; body?: string;
			};
			const previous = deliveries.get(payload.deliveryId);
			let accepted: DeliveryMarker;
			if (previous) {
				if (previous.matrixEventId !== payload.matrixEventId || previous.kind !== payload.kind) throw new ManagedAdapterError("Conflicting duplicate delivery", "invalid_delivery");
				if (inFlightDeliveries.has(previous.deliveryId)) return;
				if (previous.status === "accepted") {
					accepted = previous;
					inFlightDeliveries.add(previous.deliveryId);
				} else if (previous.status === "expanded" || previous.status === "reinjecting") {
					// Recovery of the crash window between expansion and Pi persistence belongs to #45.
					// Retain the durable marker and do not risk injecting a duplicate here.
					return;
				} else {
					acknowledge(previous);
					return;
				}
			} else {
				accepted = {
					version: MANAGED_SESSION_STATE_VERSION,
					deliveryId: payload.deliveryId, matrixEventId: payload.matrixEventId, kind: payload.kind, status: "accepted",
				};
				recordDelivery(ctx, accepted);
				inFlightDeliveries.add(accepted.deliveryId);
				acknowledge(accepted);
			}
			if (payload.kind === "abort") {
				if (activity) activity.requestedOutcome = "cancelled";
				for (const deliveryId of new Set([...activeDeliveries.keys(), ...pendingUserPersistence.map((item) => item.deliveryId)])) {
					const interrupted = deliveries.get(deliveryId);
					if (!interrupted || interrupted.status === "completed" || interrupted.status === "cancelled") continue;
					const cancellation = { ...interrupted, status: "cancelled" as const };
					recordDelivery(ctx, cancellation); acknowledge(cancellation);
				}
				activeDeliveries.clear(); pendingUserPersistence.length = 0; persistedRecoveryPending.clear();
				ctx.abort();
				const cancelled = { ...accepted, status: "cancelled" as const };
				recordDelivery(ctx, cancelled);
				inFlightDeliveries.delete(cancelled.deliveryId);
				acknowledge(cancelled);
				return;
			}
			if (payload.body === undefined) throw new ManagedAdapterError("Relay delivery omitted input body");
			const idle = ctx.isIdle();
			const deliverAs = idle ? undefined : payload.kind === "steer" ? "steer" : "followUp";
			let provenanceRecorded = false;
			const recordExpanded = (expandedText: string) => {
				if (provenanceRecorded) return;
				provenanceRecorded = true;
				const expanded: DeliveryMarker = { ...accepted, status: "expanded", expandedText };
				recordDelivery(ctx, expanded);
				if (extensionCommand) {
					const completed: DeliveryMarker = { ...expanded, status: "completed", completionKind: "extension_command" };
					recordDelivery(ctx, completed); inFlightDeliveries.delete(expanded.deliveryId); acknowledge(completed);
				} else pendingUserPersistence.push(expanded);
			};
			const invocation = payload.body.match(/^\/([^\s]+)(?:\s|$)/)?.[1];
			const extensionCommand = Boolean(invocation && pi.getCommands().some((command) => command.name === invocation && command.source === "extension"));
			if (extensionCommand) recordExpanded(payload.body);
			try {
				pi.sendUserMessage(payload.body, {
					...(deliverAs ? { deliverAs } : {}),
					expandPromptTemplates: true,
					onPromptExpanded: recordExpanded,
				});
			} catch (error) {
				inFlightDeliveries.delete(accepted.deliveryId);
				throw error;
			}
		}

		async function handleEnvelope(envelope: ManagedSessionEnvelope): Promise<void> {
			const ctx = currentContext;
			if (!ctx || !binding) throw new ManagedAdapterError("Session context is unavailable");
			if (envelope.type === "input.deliver") return handleDelivery(envelope, ctx);
			if (envelope.type === "termination.request") {
				const reason = String(envelope.payload.reason);
				if (reason === "stop" || reason === "abort") {
					if (activity) activity.requestedOutcome = "cancelled";
					for (const deliveryId of new Set([...activeDeliveries.keys(), ...pendingUserPersistence.map((item) => item.deliveryId)])) {
						const interrupted = deliveries.get(deliveryId);
						if (!interrupted || interrupted.status === "completed" || interrupted.status === "cancelled") continue;
						const cancellation = { ...interrupted, status: "cancelled" as const };
						recordDelivery(ctx, cancellation); acknowledge(cancellation);
					}
					activeDeliveries.clear(); pendingUserPersistence.length = 0; persistedRecoveryPending.clear();
				}
				ctx.abort();
				if (reason === "stop") ctx.shutdown();
				if (reason === "bridge_delete") {
					appendMarker(pi, ctx, UNBOUND_ENTRY_TYPE, { version: MANAGED_SESSION_STATE_VERSION, sessionId: binding.sessionId, reason: "bridge_delete" });
					const detached = client;
					binding = undefined; client = undefined; setStatus(ctx);
					await detached?.close("bridge_delete");
				}
				return;
			}
			throw new ManagedAdapterError(`Unsupported relay operation ${envelope.type}`, "invalid_message");
		}

		function scheduleReconnect(ctx: ExtensionContext): void {
			if (stopped || !binding || reconnectTimer) return;
			const delay = Math.min(30_000, 250 * (2 ** Math.min(reconnectAttempt, 7)));
			reconnectAttempt += 1;
			reconnectTimer = setTimeout(() => {
				reconnectTimer = undefined;
				void connectBinding(ctx);
			}, delay);
			reconnectTimer.unref();
		}

		async function connectBinding(ctx: ExtensionContext): Promise<void> {
			if (!binding || stopped || client?.connected) return;
			if (!config.attachmentNonce) {
				notify(ctx, "Managed-session attachment nonce is unavailable", "error");
				return;
			}
			const Client = role === "coordinator_adapter" ? CoordinatorAdapterClient : BoundAdapterClient;
			const next = new Client({
				socketPath: config.socketPath, role, attachmentNonce: config.attachmentNonce, binding,
				onEnvelope: handleEnvelope,
				onDisconnect: () => { setStatus(ctx); scheduleReconnect(ctx); },
			});
			client = next;
			try {
				await next.connect();
				reconnectAttempt = 0;
				replayAcknowledgements();
				for (const marker of checkpoints.values()) {
					if (marker.status === "offered") {
						await next.offerCheckpoint({ checkpointId: marker.checkpointId, originDeliveryId: marker.originDeliveryId, checkpoint: marker.checkpoint });
						const projected = { ...marker, status: "projected" as const };
						appendMarker(pi, ctx, CHECKPOINT_ENTRY_TYPE, projected); checkpoints.set(marker.checkpointId, projected);
					}
					const origin = deliveries.get(marker.originDeliveryId);
					if (origin?.status === "persisted" && origin.piEntryId) {
						const completed = { ...origin, status: "completed" as const };
						recordDelivery(ctx, completed); activeDeliveries.delete(origin.deliveryId); acknowledge(completed);
					}
				}
				for (const deliveryId of expandedRecoveryPending) {
					expandedRecoveryPending.delete(deliveryId);
					const marker = deliveries.get(deliveryId);
					if (!marker?.expandedText) continue;
					const dispatching: DeliveryMarker = { ...marker, status: "reinjecting" };
					recordDelivery(ctx, dispatching); inFlightDeliveries.add(deliveryId); pendingUserPersistence.push(dispatching);
					pi.sendUserMessage(dispatching.expandedText!, {
						...(ctx.isIdle() ? {} : { deliverAs: marker.kind === "steer" ? "steer" as const : "followUp" as const }),
						expandPromptTemplates: false, onPromptExpanded: () => undefined,
					});
				}
				for (const deliveryId of persistedRecoveryPending) {
					persistedRecoveryPending.delete(deliveryId);
					pi.sendMessage({ customType: "managed-session.resume", content: "Continue the interrupted managed Matrix delivery.", display: false },
						{ deliverAs: "followUp", triggerTurn: true });
				}
				queueProjection(ctx);
			} catch (error) {
				await next.close("shutdown").catch(() => undefined);
				if (client === next) client = undefined;
				notify(ctx, error instanceof Error ? error.message : "Managed-session relay connection failed", "warning");
				scheduleReconnect(ctx);
			}
			setStatus(ctx);
		}

		pi.on("session_start", async (event, ctx) => {
			stopped = false;
			currentContext = ctx;
			const sessionId = ctx.sessionManager.getSessionId();
			if (event.reason === "new" || event.reason === "fork") {
				appendMarker(pi, ctx, UNBOUND_ENTRY_TYPE, { version: MANAGED_SESSION_STATE_VERSION, sessionId, reason: event.reason });
				binding = undefined;
			} else {
				binding = restoreSessionBinding(ctx.sessionManager.getBranch(), sessionId, role) ??
					(event.reason === "startup" ? bootstrapBinding(pi, ctx, role, config) : undefined);
			}
			deliveries = restoreDeliveries(ctx.sessionManager.getBranch());
			projections = restoreProjections(ctx.sessionManager.getBranch());
			checkpoints = restoreCheckpoints(ctx.sessionManager.getBranch());
			activeDeliveries.clear();
			persistedRecoveryPending.clear();
			expandedRecoveryPending.clear();
			pendingUserPersistence.length = 0;
			inFlightDeliveries.clear();
			const checkpointOrigins = new Set([...checkpoints.values()].map((marker) => marker.originDeliveryId));
			for (const marker of deliveries.values()) {
				if (marker.status === "persisted" && marker.piEntryId) {
					activeDeliveries.set(marker.deliveryId, marker.piEntryId);
					if (!checkpointOrigins.has(marker.deliveryId)) persistedRecoveryPending.add(marker.deliveryId);
				}
				if (binding && (marker.status === "expanded" || marker.status === "reinjecting")) {
					const piEntryKey = findDeliveredUserEntry(ctx.sessionManager.getBranch(), marker.deliveryId);
					if (piEntryKey) {
						persistExpanded(ctx, marker, piEntryKey);
						if (!checkpointOrigins.has(marker.deliveryId)) persistedRecoveryPending.add(marker.deliveryId);
					} else expandedRecoveryPending.add(marker.deliveryId);
				}
			}
			setStatus(ctx);
			if (binding) await connectBinding(ctx);
		});

		pi.on("agent_start", async (_event, ctx) => {
			if (role !== "ordinary_adapter" || !binding || activity) return;
			const source = ctx.sessionManager.getLeafId();
			if (!source) return;
			const span: BusyActivity = {
				activityId: deriveActivityId(deriveGenerationId(binding.conversationId, 1), source), revision: -1, startedAt: Date.now(),
				startContext: ctx.getContextUsage()?.tokens ?? undefined, inputTokens: 0, outputTokens: 0, modelTurns: 0, toolTotal: 0, toolErrors: 0, compactions: 0,
				toolCounts: new Map(), activeTools: new Map(), failedTools: new Set(), work: Promise.resolve(),
			};
			activity = span;
			sendActivityUpdate(span, true);
			await span.work;
		});
		pi.on("turn_end", (event) => {
			if (!activity || event.message.role !== "assistant") return;
			activity.modelTurns += 1; activity.inputTokens += event.message.usage.input; activity.outputTokens += event.message.usage.output;
			if (event.message.stopReason === "error") activity.requestedOutcome = "failed";
			else if (event.message.stopReason === "aborted" && !activity.requestedOutcome) activity.requestedOutcome = "interrupted";
		});
		pi.on("tool_execution_start", (event) => {
			if (!activity) return;
			const name = boundedToolName(activity, event.toolName); activity.activeTools.set(event.toolCallId, name); activity.toolTotal += 1;
			activity.toolCounts.set(name, (activity.toolCounts.get(name) ?? 0) + 1); sendActivityUpdate(activity);
		});
		pi.on("tool_execution_end", (event) => {
			if (!activity) return;
			const name = activity.activeTools.get(event.toolCallId) ?? boundedToolName(activity, event.toolName); activity.activeTools.delete(event.toolCallId);
			if (event.isError) { activity.toolErrors += 1; activity.failedTools.add(name); } sendActivityUpdate(activity);
		});
		pi.on("session_before_compact", () => { if (activity) sendActivityUpdate(activity, true, "compaction"); });
		pi.on("session_compact", () => { if (activity) { activity.compactions += 1; sendActivityUpdate(activity, true); } });
		pi.on("session_compact_failed", (event) => { if (activity) { if (!event.aborted) activity.requestedOutcome = "failed"; sendActivityUpdate(activity, true); } });

		pi.on("agent_settled", async (_event, ctx) => {
			for (let index = pendingUserPersistence.length - 1; index >= 0; index -= 1) {
				const marker = pendingUserPersistence[index]!;
				const piEntryKey = findDeliveredUserEntry(ctx.sessionManager.getBranch(), marker.deliveryId);
				if (!piEntryKey) continue;
				pendingUserPersistence.splice(index, 1);
				persistExpanded(ctx, marker, piEntryKey);
			}
			for (const [deliveryId, piEntryId] of activeDeliveries) {
				const previous = deliveries.get(deliveryId);
				if (!previous) continue;
				const completed: DeliveryMarker = { ...previous, status: "completed", piEntryId };
				recordDelivery(ctx, completed);
				acknowledge(completed);
			}
			activeDeliveries.clear();
			if (projectionRun) await projectionRun;
			await projectEligibleEntries(ctx, true);
			try { await finalizeActivity(ctx); }
			catch (error) { notify(ctx, error instanceof Error ? error.message : "Managed activity finalization failed", "error"); return; }
			await projectEligibleEntries(ctx);
		});

		pi.on("session_shutdown", async (event, ctx) => {
			stopped = true;
			if (activity) await finalizeActivity(ctx, activity.requestedOutcome ?? "interrupted").catch(() => undefined);
			if (reconnectTimer) clearTimeout(reconnectTimer);
			if (projectionRetryTimer) clearTimeout(projectionRetryTimer);
			reconnectTimer = undefined;
			projectionRetryTimer = undefined;
			const reason = event.reason === "quit" || event.reason === "reload" ? "shutdown" : "session_change";
			await client?.close(reason);
			client = undefined;
			currentContext = undefined;
			setStatus(ctx);
		});

		pi.registerCommand("remote", {
			description: role === "ordinary_adapter" ? "Bind, inspect, or delete this managed relay bridge" : "Inspect this coordinator relay bridge",
			handler: async (args, ctx) => {
				const input = args.trim();
				if (input === "status") {
					if (!binding) return notify(ctx, "This Pi session is not bound to a managed conversation");
					if (!client?.connected) return notify(ctx, `Managed conversation ${binding.concept} is offline`, "warning");
					try {
						const result = await client.selfStatus();
						notify(ctx, `Managed conversation ${binding.concept}: ${String(result.payload.conversationState)}`);
					} catch (error) { notify(ctx, error instanceof Error ? error.message : "Managed status failed", "error"); }
					return;
				}
				if (role !== "ordinary_adapter") return notify(ctx, "Coordinator supports only /remote status", "error");
				if (input === "delete --confirm") {
					if (!binding || !client?.connected) return notify(ctx, "No connected managed bridge to delete", "error");
					try {
						const result = await client.selfDelete();
						if (result.type !== "self.result" || result.payload.operation !== "self.delete" || result.payload.status !== "ok") throw new ManagedAdapterError("Relay did not confirm bridge deletion");
						appendMarker(pi, ctx, UNBOUND_ENTRY_TYPE, { version: MANAGED_SESSION_STATE_VERSION, sessionId: binding.sessionId, reason: "bridge_delete" });
						await client.close("bridge_delete");
						binding = undefined; client = undefined; setStatus(ctx);
						notify(ctx, "Managed bridge deleted; Pi session and process were preserved");
					} catch (error) { notify(ctx, error instanceof Error ? error.message : "Bridge deletion failed", "error"); }
					return;
				}
				if (input.startsWith("delete")) return notify(ctx, "Use /remote delete --confirm to delete only bridge metadata", "warning");
				if (input.startsWith("on ")) {
					if (binding) return notify(ctx, "This Pi session is already bound", "warning");
					if (!ctx.sessionManager.getSessionFile()) return notify(ctx, "Persist this Pi session before binding it", "error");
					if (!config.attachmentNonce) return notify(ctx, "Managed-session attachment nonce is unavailable", "error");
					if (!config.placement) return notify(ctx, "Managed-session workspace placement is unavailable", "error");
					const concept = normalizeConcept(input.slice(3));
					if (!concept) return notify(ctx, "Usage: /remote on <concept> (1-128 printable characters)", "error");
					const sessionId = ctx.sessionManager.getSessionId();
					const existingAttempt = restoreBindingAttempt(ctx.sessionManager.getBranch(), sessionId, concept);
					const creationKey = existingAttempt?.creationKey ?? `manual-${randomUUID()}`;
					const boundaryKey = existingAttempt?.entryKey ?? appendMarker(pi, ctx, BINDING_BOUNDARY_ENTRY_TYPE, {
						version: MANAGED_SESSION_STATE_VERSION, creationKey, concept, sessionId,
					});
					const bindingBoundaryEntryId = persistedEntryId(sessionId, boundaryKey);
					try {
						const conversationId = await requestSelfBind({
							socketPath: config.socketPath, role: "ordinary_adapter", creationKey, concept, sessionId,
							attachmentNonce: config.attachmentNonce, bindingBoundaryEntryId, placement: config.placement,
						});
						binding = { version: MANAGED_SESSION_STATE_VERSION, conversationId, concept, sessionId, bindingBoundaryEntryId, role };
						appendMarker(pi, ctx, BINDING_ENTRY_TYPE, binding);
						deliveries = restoreDeliveries(ctx.sessionManager.getBranch());
						await connectBinding(ctx);
						notify(ctx, `Bound managed conversation ${concept}`);
					} catch (error) { notify(ctx, error instanceof Error ? error.message : "Managed binding failed", "error"); }
					return;
				}
				notify(ctx, role === "ordinary_adapter" ? "Usage: /remote on <concept> | status | delete --confirm" : "Usage: /remote status", "warning");
			},
		});
	};
}
