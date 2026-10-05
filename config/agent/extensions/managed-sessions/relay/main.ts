#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { MatrixError } from "../../matrix-shared/http.js";
import { resolve } from "node:path";
import {
	MANAGED_SESSION_PROTOCOL_VERSION,
	deriveConversationId,
	hasMatrixBinding,
	type ManagedAdapterLiveStatus,
	type ManagedSessionEnvelope,
} from "../contracts.js";
import { bootstrapCoordinator, type CoordinatorIdentity } from "./coordinator-bootstrap.js";
import { CoordinatorRouter } from "./coordinator-router.js";
import { ConversationManifestStore } from "./manifest-store.js";
import { ManagedSessionIpcServer } from "./ipc-server.js";
import { HostLifecycle } from "./host-lifecycle.js";
import { RelayEventProjector } from "./event-projector.js";
import { managedMatrixConfigFromEnvironment, ManagedMatrixClient } from "./matrix-client.js";
import { peerUidFromHelper } from "./peer-uid.js";
import { RelayRegistry, RelayRegistryError } from "./registry.js";
import { hostRelayLockPath, HostRelayLock } from "./relay-lock.js";
import { TranscriptProjector } from "./transcript-projector.js";
import { ActivityProjector } from "./activity-projector.js";
import { parseAloopLifecycleEvent } from "../aloop-lifecycle.js";
import { ControlPollPublisher } from "./control-poll-publisher.js";
import { redactManagedValue } from "./redaction.js";
import { migrateManagedSessionStoresV1ToV2 } from "./v2-migration.js";
import { BlobSpool } from "./blob-spool.js";
import { ManagedImageTransport } from "./image-media.js";
import { ManagedArtifactExporter } from "./artifact-export.js";
import { renderManagedConversationStatus } from "./status.js";
import { prepareRelayStateDirectory } from "./state-directory.js";
import { AtomicJsonFile } from "./atomic-json.js";
import { retryMatrixStartup } from "./startup-retry.js";
import { RecoveryAlerts } from "./recovery-alerts.js";
import { RecoveryMonitor } from "./recovery-monitor.js";
import { LiveHierarchy } from "./live-hierarchy.js";
import { LocalEnrollmentReconciler } from "./local-enrollment-reconciler.js";
import { readHostPolicy } from "./host-policy.js";
import { HostDispatcher } from "./host-dispatcher.js";
import { HostApprovalRuntime } from "./host-approval-runtime.js";
import { HostApprovalStore } from "./host-approval-store.js";
import { ManagedHostMutationOwner, isManagedHostPreview } from "./host-mutation-owner.js";
import { HostReadModel } from "./host-read-model.js";
import { HostMatrixCommands } from "./host-matrix-commands.js";
import { HostAccountClient } from "./host-account-client.js";
import { HostAccountOwner } from "./host-account-owner.js";
import { ConversationRetirement } from "./conversation-retirement.js";
import { HostControlServer } from "./host-control-server.js";

function required(environment: NodeJS.ProcessEnv, name: string): string {
	const value = environment[name]?.trim();
	if (!value) throw new Error(`${name} is required`);
	return value;
}

export interface RunningRelay {
	registry: RelayRegistry;
	server: ManagedSessionIpcServer;
	stop(): Promise<void>;
}

export async function startManagedSessionRelay(environment: NodeJS.ProcessEnv = process.env, signal?: AbortSignal): Promise<RunningRelay> {
	const runtimeDirectory = resolve(required(environment, "PI_MANAGED_SESSIONS_RUNTIME_DIR"));
	const stateDirectory = resolve(required(environment, "PI_MANAGED_SESSIONS_STATE_DIR"));
	const manifestDirectory = resolve(required(environment, "PI_MANAGED_SESSIONS_MANIFEST_DIR"));
	const hostId = required(environment, "PI_MANAGED_SESSIONS_HOST_ID");
	const graceMilliseconds = Number(environment.PI_MANAGED_SESSIONS_RESTART_GRACE_MS ?? "10000");
	if (!Number.isSafeInteger(graceMilliseconds) || graceMilliseconds < 0 || graceMilliseconds > 300_000) {
		throw new Error("PI_MANAGED_SESSIONS_RESTART_GRACE_MS must be between 0 and 300000");
	}
	const expectedUid = process.getuid?.();
	const peerUidHelper = environment.PI_MANAGED_SESSIONS_PEER_UID_HELPER?.trim();
	const relayLockHelper = environment.PI_MANAGED_SESSIONS_RELAY_LOCK_HELPER?.trim();
	if (expectedUid !== undefined && ["linux", "darwin", "freebsd", "openbsd", "netbsd"].includes(process.platform) && (!peerUidHelper || !relayLockHelper)) {
		throw new Error("Packaged peer-UID and relay-lock helpers are required on this platform");
	}
	const policyPath = environment.PI_MANAGED_HOST_ACTION_POLICY?.trim();
	if (policyPath && (expectedUid === undefined || !peerUidHelper)) throw new Error("Host controls require OS peer verification");
	if (policyPath && resolve(environment.PI_MANAGED_SESSIONS_SOCKET ?? resolve(runtimeDirectory, "relay.sock")) === resolve(runtimeDirectory, "control.sock"))
		throw new Error("Host controls and adapter IPC require separate socket paths");
	const hostPolicy = policyPath ? await readHostPolicy(policyPath) : undefined;
	const relayLock = relayLockHelper ? new HostRelayLock(relayLockHelper, await hostRelayLockPath(hostId, expectedUid)) : undefined;
	await relayLock?.acquire();
	const manifestStore = new ConversationManifestStore(manifestDirectory);
	const registry = new RelayRegistry(hostId, stateDirectory, manifestStore);
	let server: ManagedSessionIpcServer | undefined;
	let controlServer: HostControlServer | undefined;
	let coordinatorRouter: CoordinatorRouter | undefined;
	let recoveryMonitor: RecoveryMonitor | undefined;
	let hierarchy: LiveHierarchy | undefined;
	let localEnrollments: LocalEnrollmentReconciler | undefined;
	let hostLifecycle: HostLifecycle | undefined;
	let retirement: ConversationRetirement | undefined;
	let hostApprovals: HostApprovalRuntime | undefined;
	let account: HostAccountOwner | undefined;
	let matrixHostCommands: HostMatrixCommands | undefined;
	let activityProjector: ActivityProjector | undefined;
	let closeArtifactExporter = async (): Promise<void> => undefined;
	let closeNotices = async (): Promise<void> => undefined;
	try {
		await prepareRelayStateDirectory(hostId, stateDirectory, runtimeDirectory, manifestStore);
		await registry.load();
		// Ephemeral observation, never a recovery source. No tokens or error text.
		let lastSuccessfulSyncAt: string | null = null;
		let matrixHealthy = false;
		let matrixAuthenticated = false;
		const runtimeBuild = environment.PI_MANAGED_RELAY_BUILD ?? "unknown";
		const healthFile = new AtomicJsonFile<{ status: "starting" | "healthy" | "blocked"; lastSuccessfulSyncAt: string | null; runtimeBuild: string }>(
			resolve(runtimeDirectory, "sync-health.json"), (value) => value as { status: "starting" | "healthy" | "blocked"; lastSuccessfulSyncAt: string | null; runtimeBuild: string });
		await healthFile.write({ status: "starting", lastSuccessfulSyncAt, runtimeBuild });
		const syncHealth = async (healthy: boolean): Promise<void> => {
			matrixHealthy = healthy;
			await recoveryMonitor?.health(healthy);
			if (healthy) lastSuccessfulSyncAt = new Date().toISOString();
			await healthFile.write({ status: healthy ? "healthy" : "blocked", lastSuccessfulSyncAt, runtimeBuild });
		};
		const matrix = new ManagedMatrixClient(managedMatrixConfigFromEnvironment(environment), fetch, [...new Set([...registry.managedRoomIds(), ...registry.retirementRoomIds()])], { maxAttempts: 1 });
		const spool = new BlobSpool(resolve(stateDirectory, "media-spool"));
		const media = new ManagedImageTransport(spool, matrix);
		await media.initialize(registry.liveMediaBlobIds());
		const artifactExporter = new ManagedArtifactExporter(spool, registry, matrix, {
			notice: async (conversationId, uploadId) => eventProjector.projectNotice(conversationId, `${uploadId}:failed`,
				"Artifact export failed permanently at the media service. Resolve the service error and request a new export; conversation history is preserved.", "notify"),
		});
		closeArtifactExporter = () => artifactExporter.close();
		const controlPollPublisher = new ControlPollPublisher(registry, matrix, undefined, () => matrixHealthy ? "notify" : "silent");
		const coordinatorValues = [
			environment.PI_MANAGED_COORDINATOR_WORKSPACE_DIR,
			environment.PI_MANAGED_COORDINATOR_SESSION_FILE,
			environment.PI_MANAGED_COORDINATOR_LAUNCHER,
		];
		if (coordinatorValues.some((value) => value?.trim()) && !coordinatorValues.every((value) => value?.trim())) {
			throw new Error("Coordinator workspace, session file, and launcher must be configured together");
		}
		let coordinator: CoordinatorIdentity | undefined;
		const transcriptProjector = new TranscriptProjector(registry, matrix);
		activityProjector = new ActivityProjector(stateDirectory, registry, matrix);
		await activityProjector.load();
		const recoveryAlerts: RecoveryAlerts = new RecoveryAlerts(resolve(stateDirectory, "recovery-alerts.json"), (alert) => eventProjector.projectRecoveryAlert(alert));
		await recoveryAlerts.load();
		const eventProjector = new RelayEventProjector(registry, matrix, recoveryAlerts, () => matrixHealthy ? "notify" : "silent");
		await eventProjector.startNoticeOutbox(resolve(stateDirectory, "notice-outbox.json"),
			(message) => process.stderr.write(`pi-managed-session-relay: ${redactManagedValue(message, environment)}\n`));
		closeNotices = () => eventProjector.close();
		registry.beginRestartReconciliation();
		const response = (conversationId: string, inReplyTo: string, type: "self.result" | "recovery.acknowledge" | "input.result" | "media.result" | "artifact.acknowledge" | "transcript.acknowledge" | "checkpoint.acknowledge" | "activity.acknowledge" | "aloop.acknowledge" | "lifecycle.result", payload: Record<string, unknown>): ManagedSessionEnvelope => ({
			protocolVersion: MANAGED_SESSION_PROTOCOL_VERSION,
			messageId: `relay-${randomUUID()}`,
			conversationId,
			role: "relay",
			type,
			inReplyTo,
			payload,
		});
		server = new ManagedSessionIpcServer(registry, {
			runtimeDirectory,
			socketPath: environment.PI_MANAGED_SESSIONS_SOCKET,
			expectedUid,
			hostApprovalsEnabled: Boolean(hostPolicy && coordinatorValues.every((value) => value?.trim())),
			peerUid: peerUidHelper ? (socket) => peerUidFromHelper(peerUidHelper, socket) : undefined,
			onAttachment: async (attachment) => {
				// Admission is local; Matrix replay and overlays wait for a real binding.
				if (!registry.manifestByConversationId(attachment.conversationId)) return;
				await activityProjector?.attachmentConnected(attachment.conversationId);
				if (registry.promotion(attachment.conversationId)?.phase === "shutdown_requested") {
					server!.sendToConversation({ protocolVersion: MANAGED_SESSION_PROTOCOL_VERSION, messageId: `relay-promotion-${randomUUID()}`,
						conversationId: attachment.conversationId, role: "relay", type: "promotion.shutdown", payload: {} });
				}
				if (coordinatorRouter) await coordinatorRouter.attachmentReady(attachment.conversationId);
				else for (const control of registry.pendingControls(attachment.conversationId).filter((item) =>
					!registry.hasGenerationBoundary(attachment.conversationId) || item.name === "new" && item.argument === "--confirm")) {
					await activityProjector?.beginOperationFeedback(attachment.conversationId, control.controlId);
					server!.sendToConversation({ protocolVersion: MANAGED_SESSION_PROTOCOL_VERSION, messageId: `relay-control-${randomUUID()}`,
						conversationId: attachment.conversationId, role: "relay", type: "control.deliver", payload: {
							controlId: control.controlId, name: control.name, ...(control.argument ? { argument: control.argument } : {}),
						} });
				}
			},
			onAttachmentDisconnect: async (attachment, reason) => {
				hostApprovals?.disconnected(attachment);
				retirement?.kick();
				activityProjector?.attachmentDisconnected(attachment.conversationId);
				if (reason === "shutdown" && registry.promotion(attachment.conversationId)?.phase === "shutdown_confirmed") {
					await hostLifecycle?.completeTerminalPromotion(attachment.conversationId).catch((error) => {
						process.stderr.write(`pi-managed-session-relay: terminal promotion failed: ${redactManagedValue(error instanceof Error ? error.message : "unknown failure", environment)}\n`);
					});
				}
			},
			onUnboundEnvelope: async (envelope) => {
				if (envelope.type !== "self.bind" || envelope.role !== "ordinary_adapter") return undefined;
				const payload = envelope.payload as {
					creationKey: string; concept: string; sessionId: string; attachmentNonce: string;
					bindingBoundaryEntryId: string; sourceCwd: string; sourceSessionFile: string; requestedCapabilities?: string[];
				};
				if (!hostLifecycle) throw new RelayRegistryError("invalid_state", "Terminal-session promotion is unavailable");
				const local = payload.requestedCapabilities?.includes("local-enrollment-v1");
				const manifest = local ? await hostLifecycle.prepareLocalTerminalEnrollment(payload) : await hostLifecycle.prepareTerminalPromotion(payload);
				return response(manifest.conversationId, envelope.messageId, "self.result", {
					operation: "self.bind", status: "ok", boundConversationId: manifest.conversationId,
					...(local ? { matrixBinding: hasMatrixBinding(manifest) ? "bound" : "pending" } : {}),
				});
			},
			onEnvelope: async (envelope, attachment) => {
				if (envelope.type.startsWith("host.")) {
					if (!hostApprovals) throw new RelayRegistryError("invalid_state", "Host approvals are unavailable");
					return hostApprovals.handle(envelope, attachment);
				}
				if (!registry.manifestByConversationId(attachment.conversationId) && !["self.status", "control.result", "refresh.result"].includes(envelope.type)) {
					throw new RelayRegistryError("matrix_unavailable", "Local conversation is active; Matrix binding is pending");
				}
				if (envelope.type === "recovery.confirm") {
					recoveryMonitor?.confirm(envelope, attachment);
					return response(attachment.conversationId, envelope.messageId, "recovery.acknowledge", { requestId: envelope.payload.requestId });
				}
				if (envelope.type === "control.result") {
					const payload = envelope.payload as { controlId: string; status: "ok" | "rejected"; message: string; options?: string[];
						generation?: { model?: string; thinking?: string }; selection?: { model: string } | { thinking: string }; liveStatus?: ManagedAdapterLiveStatus };
					const resultState = registry.controlResultState(attachment.conversationId, payload.controlId);
					if (resultState === "unknown") throw new RelayRegistryError("not_found", "Pending managed control was not found");
					if (resultState === "pending") {
						const manifest = registry.manifestByConversationId(attachment.conversationId);
						if (!manifest) throw new RelayRegistryError("not_found", "Managed conversation is unavailable");
						const source = registry.pendingControls(attachment.conversationId).find((control) => control.controlId === payload.controlId);
						if ((source?.name === "status") !== (payload.liveStatus !== undefined) ||
							(payload.liveStatus !== undefined && (payload.status !== "ok" || payload.options || payload.generation || payload.selection))) {
							throw new RelayRegistryError("invalid_state", "Live status metadata does not match an authorized status control");
						}
						if (payload.generation) {
							if (!source || source.name !== "new" || source.argument !== "--confirm" || payload.status !== "ok" || payload.options || !hostLifecycle) {
								throw new RelayRegistryError("invalid_state", "Fresh generation result does not match an authorized confirmed control");
							}
							await registry.beginGenerationTransition(attachment.conversationId, payload.controlId, payload.generation);
							await registry.acknowledgeControlResult(attachment.conversationId, payload.controlId);
							await activityProjector!.endOperationFeedback(attachment.conversationId, payload.controlId);
							setImmediate(() => { void hostLifecycle!.requestNewGeneration(manifest, payload.controlId, payload.generation!).catch((error) =>
								process.stderr.write(`pi-managed-session-relay: generation transition failed: ${redactManagedValue(error instanceof Error ? error.message : "unknown failure", environment)}\n`)); });
							return response(attachment.conversationId, envelope.messageId, "self.result", { operation: "control.result", status: "ok" });
						}
						if (payload.selection) {
							const selection = "model" in payload.selection ? { kind: "model" as const, value: payload.selection.model }
								: { kind: "thinking" as const, value: payload.selection.thinking };
							if (!source || source.name !== selection.kind || source.argument !== selection.value ||
								payload.status !== "ok" || payload.options || payload.generation) {
								throw new RelayRegistryError("invalid_state", `${selection.kind === "model" ? "Model" : "Thinking"} selection result does not match an authorized exact control`);
							}
							if (selection.kind === "model") await registry.updateActiveGenerationModel(attachment.conversationId, selection.value);
							else await registry.updateActiveGenerationThinking(attachment.conversationId, selection.value);
						}
						let projectedMessage = payload.message;
						if (payload.liveStatus) {
							const runtime = registry.snapshot().conversations.find((item) => item.conversationId === attachment.conversationId);
							if (!runtime) throw new RelayRegistryError("not_found", "Managed runtime status is unavailable");
							projectedMessage = renderManagedConversationStatus(manifest, runtime, payload.liveStatus,
								registry.listManifests().filter((item) => item.kind === "project" && !item.projectKey).length, payload.controlId);
						}
						if (payload.options?.length) {
							if (!source || (source.name !== "model" && source.name !== "thinking")) {
								throw new RelayRegistryError("invalid_state", "Managed control options require a model or thinking scope");
							}
							const options = payload.options.map((option, index) => ({ answerId: `pi-control-${index}`, command: option }));
							await controlPollPublisher.publish({ conversationId: manifest.conversationId, roomId: manifest.roomId,
								sourceControl: source, scope: source.name, prompt: payload.message, options });
						} else await eventProjector.projectNotice(manifest.conversationId, payload.controlId, projectedMessage);
						await registry.acknowledgeControlResult(attachment.conversationId, payload.controlId);
						if (source?.name === "new" && payload.status === "rejected") setImmediate(() => {
							void coordinatorRouter?.attachmentReady(attachment.conversationId).catch(() => undefined);
						});
					}
					await activityProjector!.endOperationFeedback(attachment.conversationId, payload.controlId);
					return response(attachment.conversationId, envelope.messageId, "self.result", { operation: "control.result", status: "ok" });
				}
				if (envelope.type === "refresh.result") {
					if (!hostLifecycle) throw new Error("Managed lifecycle unavailable");
					hostLifecycle.acceptRefreshResult(attachment.conversationId, String(envelope.payload.refreshId), String(envelope.payload.status));
					return response(attachment.conversationId, envelope.messageId, "self.result", { operation: "refresh.result", status: "ok" });
				}
				if (envelope.type === "artifact.begin") {
					if (attachment.role !== "ordinary_adapter") throw new RelayRegistryError("permission_denied", "Artifact export requires an ordinary managed adapter");
					const status = await artifactExporter.begin(attachment.conversationId, envelope.payload as never);
					return response(attachment.conversationId, envelope.messageId, "artifact.acknowledge", { uploadId: envelope.payload.uploadId, status });
				}
				if (envelope.type === "artifact.chunk") {
					if (attachment.role !== "ordinary_adapter") throw new RelayRegistryError("permission_denied", "Artifact export requires an ordinary managed adapter");
					const payload = envelope.payload as { uploadId: string; blobId: string; index: number; sha256: string; data: string };
					const status = await artifactExporter.chunk(attachment.conversationId, payload);
					return response(attachment.conversationId, envelope.messageId, "artifact.acknowledge", { uploadId: payload.uploadId, status });
				}
				if (envelope.type === "media.reject") {
					const payload = envelope.payload as { deliveryId: string; blobId: string; reason: "unsupported_model" | "invalid_media" };
					const input = registry.pendingInputs(attachment.conversationId).find((candidate) => candidate.deliveryId === payload.deliveryId && candidate.media?.blobId === payload.blobId);
					if (!input) throw new RelayRegistryError("not_found", "Pending managed image was not found");
					await registry.acknowledgeInput(attachment.conversationId, payload.deliveryId, "cancelled");
					await eventProjector.projectNotice(attachment.conversationId, `${payload.deliveryId}:media-rejected`, payload.reason === "unsupported_model"
						? "The active model does not support image input. The image was not delivered; choose an image-capable model and resend it."
						: "The managed image transfer failed validation and was not delivered.");
					await media.consume(payload.blobId, registry.liveMediaBlobIds());
					setImmediate(() => { void coordinatorRouter?.attachmentReady(attachment.conversationId).catch(() => undefined); });
					return response(attachment.conversationId, envelope.messageId, "media.result", { deliveryId: payload.deliveryId, blobId: payload.blobId, status: "rejected" });
				}
				if (envelope.type === "input.acknowledge") {
					const payload = envelope.payload as { deliveryId: string; status: string; piEntryId?: string; completionKind?: string };
					const input = registry.pendingInputs(attachment.conversationId).find((candidate) => candidate.deliveryId === payload.deliveryId);
					const command = payload.completionKind === "extension_command" ? input?.body?.match(/^\/([^\s]+)/)?.[1] : undefined;
					if (payload.completionKind === "extension_command" && !command) {
						throw new RelayRegistryError("invalid_state", "Extension-command completion did not match a command delivery");
					}
					await registry.acknowledgeInput(attachment.conversationId, payload.deliveryId, payload.status, payload.piEntryId, payload.completionKind);
					if (["persisted", "completed", "cancelled"].includes(payload.status)) setImmediate(() => {
						void coordinatorRouter?.attachmentReady(attachment.conversationId).catch(() => undefined);
					});
					if (command && (payload.status === "completed" || payload.status === "cancelled")) await activityProjector!.endOperationFeedback(attachment.conversationId, payload.deliveryId);
					if (input?.media && (payload.status === "completed" || payload.status === "cancelled")) await media.consume(input.media.blobId, registry.liveMediaBlobIds());
					if (command && command !== "aloop" && !command.startsWith("aloop-")) await eventProjector.projectNotice(attachment.conversationId, `${payload.deliveryId}:command`, `Command dispatched: /${command}`);
					return response(attachment.conversationId, envelope.messageId, "input.result", {
						deliveryId: payload.deliveryId, status: payload.status,
					});
				}
				if (envelope.type === "activity.update" || envelope.type === "activity.finalize") {
					const status = await activityProjector!.project(envelope);
					return response(attachment.conversationId, envelope.messageId, "activity.acknowledge", {
						activityId: envelope.payload.activityId, revision: envelope.payload.revision, status,
					});
				}
				if (envelope.type === "transcript.offer") {
					if (envelope.payload.kind === "assistant_final" && activityProjector!.hasUnfinalized(attachment.conversationId)) throw new RelayRegistryError("invalid_state", "Final activity snapshot must be persisted before the final answer");
					await transcriptProjector.project(envelope);
					return response(attachment.conversationId, envelope.messageId, "transcript.acknowledge", {
						entryId: envelope.payload.entryId, status: "projected",
					});
				}
				if (envelope.type === "checkpoint.offer") {
					await eventProjector.projectCheckpoint(envelope);
					return response(attachment.conversationId, envelope.messageId, "checkpoint.acknowledge", {
						checkpointId: envelope.payload.checkpointId, status: "projected",
					});
				}
				if (envelope.type === "aloop.notice") {
					if (attachment.role !== "ordinary_adapter") throw new RelayRegistryError("permission_denied", "Aloop lifecycle projection requires an ordinary managed adapter");
					const lifecycle = parseAloopLifecycleEvent({ version: 1, ...envelope.payload });
					const lifecycleManifest = registry.manifestByConversationId(attachment.conversationId);
					if (!lifecycle || !lifecycleManifest || lifecycle.scopeSessionId !== lifecycleManifest.piSessionId) throw new RelayRegistryError("invalid_state", "Aloop lifecycle notice failed scope or privacy validation");
					await eventProjector.projectNotice(attachment.conversationId, `aloop:${lifecycle.lifecycleId}`, lifecycle.body);
					return response(attachment.conversationId, envelope.messageId, "aloop.acknowledge", {
						lifecycleId: envelope.payload.lifecycleId, status: "projected",
					});
				}
				if (envelope.type === "lifecycle.request") {
					if (!hostLifecycle || attachment.role !== "coordinator_adapter") throw new RelayRegistryError("permission_denied", "Coordinator lifecycle is unavailable");
					const operation = (envelope.payload.request as Record<string, unknown>).operation;
					if (typeof operation !== "string" || !["workspace.list", "worktree.list", "conversation.list", "conversation.status"].includes(operation))
						throw new RelayRegistryError("invalid_state", "Legacy model mutations require upgraded approved host controls");
					return response(attachment.conversationId, envelope.messageId, "lifecycle.result", await hostLifecycle.request(envelope));
				}
				if (envelope.type === "self.promote") {
					await registry.requestPromotion(attachment.conversationId);
					return response(attachment.conversationId, envelope.messageId, "self.result", { operation: "self.promote", status: "ok" });
				}
				if (envelope.type === "self.status") {
					return response(attachment.conversationId, envelope.messageId, "self.result", {
						operation: "self.status", status: "ok", conversationState: registry.conversationState(attachment.conversationId),
					});
				}
				if (envelope.type === "self.delete") {
					// The old frame proves neither a human action nor a live approved tool.
					// Never reinterpret its former unbind-only meaning as destructive consent.
					throw new RelayRegistryError("invalid_state", "Legacy deletion requires upgraded approved host controls");
				}
				return undefined;
			},
		});
		recoveryMonitor = new RecoveryMonitor(recoveryAlerts, registry, server,
			(conversationId) => !coordinatorRouter || coordinatorRouter.hasRecoveryBacklog(conversationId),
			(message) => process.stderr.write(`pi-managed-session-relay: ${message}\n`), 5_000,
			async (conversationId) => hostApprovals?.recoveryAttention(conversationId));
		await recoveryMonitor.health(false);
		recoveryMonitor.start();
		if (coordinatorValues.every((value) => value?.trim())) {
			hierarchy = new LiveHierarchy(resolve(stateDirectory, "live-workspaces"), hostId, matrix,
				() => registry.listManifests().find((manifest) => manifest.kind === "coordinator"),
				(conversationId) => Boolean(registry.retirement(conversationId)));
			await hierarchy.load();
			const accountDevice = environment.PI_MANAGED_ACCOUNT_DEVICE_ID?.trim();
			if (accountDevice) {
				account = new HostAccountOwner(new HostAccountClient(resolve(stateDirectory, "account"), hostId, matrix.operatorUserId, accountDevice, matrix), registry, matrix, hierarchy);
				await account.initialize();
			}
			const projectSessionDirectory = environment.PI_MANAGED_PROJECT_SESSION_DIR?.trim() || resolve(stateDirectory, "project-sessions");
			hostLifecycle = new HostLifecycle({
				hostId, launcher: environment.PI_MANAGED_COORDINATOR_LAUNCHER!.trim(), projectSessionDirectory: resolve(projectSessionDirectory),
				socketPath: server.socketPath, registry, matrix, hierarchy, server, environment, spaceCleanupAccount: account,
				coordinator: { launcher: environment.PI_MANAGED_COORDINATOR_LAUNCHER!.trim(),
					sessionFile: coordinatorValues[1]!.trim(), workspaceDirectory: coordinatorValues[0]!.trim() },
				projectNotice: async (sourceId, manifest, body) => eventProjector.projectNotice(manifest.conversationId, sourceId, body),
				generationReady: async (conversationId) => coordinatorRouter?.attachmentReady(conversationId),
				endOperationFeedback: (conversationId, operationId) => activityProjector!.endOperationFeedback(conversationId, operationId),
				retireConversation: (conversationId) => {
					if (!retirement) throw new RelayRegistryError("invalid_state", "Canonical retirement is unavailable");
					return retirement.retire(conversationId);
				},
			});
		}
		retirement = new ConversationRetirement({ registry, matrix, hierarchy, server, account,
			matrixAuthenticated: () => matrixAuthenticated,
			windows: hostLifecycle?.exactWindows ?? { check: async () => { throw Error("Exact launcher is unavailable"); }, terminate: async () => { throw Error("Exact launcher is unavailable"); } },
			cancelApprovals: (conversationId) => hostApprovals?.cancelRun(conversationId),
			onFailure: () => process.stderr.write("pi-managed-session-relay: retirement cleanup is pending\n") });
		if (hostPolicy) {
			const reads = new HostReadModel({ hostId, registry, lifecycle: hostLifecycle, windowFirstOpen: Boolean(hostLifecycle), accountState: () => account?.client.status() ?? "unavailable", accountSetup: id => account?.client.setupState(id) ?? "pending", matrixReady: () => {
				const age = lastSuccessfulSyncAt ? Date.now() - Date.parse(lastSuccessfulSyncAt) : Infinity;
				return matrixHealthy && age >= 0 && age < 120_000;
			} });
			const owner = hostLifecycle ? new ManagedHostMutationOwner({ registry, lifecycle: hostLifecycle, retirement, server, account,
				activeRun: async (id) => {
					const witness = await hostApprovals!.controls.proofs.request(id);
					if (!witness) throw new Error("Active target run observation is unavailable");
					return witness.phase === "active" ? { runId: witness.runId } : undefined;
				} }) : undefined;
			const dispatchOptions: ConstructorParameters<typeof HostDispatcher>[0] = {
				hostId, protectedConversationId: deriveConversationId(hostId, "coordinator"), policy: hostPolicy,
				read: (request) => owner && isManagedHostPreview(request.action) ? owner.preview(request.action) : reads.read(request),
				humanMutation: owner ? request => owner.executeHuman(request) : undefined,
				...(hostLifecycle ? { launch: (action: { operation: "conversation.open" | "conversation.resume"; conversationId: string }) =>
					action.operation === "conversation.open" ? hostLifecycle!.openConversation(action.conversationId) : hostLifecycle!.resumeConversation(action.conversationId) } : {}) };
			if (hostLifecycle) {
				const store = new HostApprovalStore(resolve(stateDirectory, "host-approvals"), hostId); await store.load();
				hostApprovals = new HostApprovalRuntime({ ...dispatchOptions, store, matrix, operatorUserIds: new Set([matrix.operatorUserId]),
					notificationDisposition: () => matrixHealthy ? "notify" : "silent",
					onNotifyingPoll: async (record) => {
						const manifest = registry.manifestByConversationId(record.request.actor.conversationId);
						if (manifest && registry.activeGeneration(manifest).generationId === record.request.actor.generationId) await recoveryAlerts.originalAccepted(manifest.conversationId, manifest.piSessionId);
					},
					owner: owner!,
					attachment: (id) => server!.attachment(id), capable: (id) => server!.supports(id, "approval-v1"),
					send: (envelope) => server!.sendToConversation(envelope), room: (id) => registry.manifestByConversationId(id)?.roomId,
					acceptedInput: (id, deliveryId) => {
						const manifest = registry.manifestByConversationId(id); if (!manifest) return undefined;
						const input = registry.pendingInputs(id).find((entry) => entry.deliveryId === deliveryId);
						return input?.status === "persisted" ? { deliveryId, roomId: manifest.roomId, eventId: input.matrixEventId, senderUserId: input.senderUserId, status: "persisted" as const } : undefined;
					} });
			}
			const dispatcher = hostApprovals?.dispatcher ?? new HostDispatcher(dispatchOptions);
			matrixHostCommands = new HostMatrixCommands(resolve(stateDirectory, "host-commands", "intake.json"), hostId, matrix.operatorUserId, dispatcher,
				(eventId, manifest, text) => eventProjector.projectNotice(manifest.conversationId, `${eventId}:host-result`, text));
			await matrixHostCommands.load();
			controlServer = new HostControlServer({ runtimeDirectory, expectedUid: expectedUid!, peerUid: (socket) => peerUidFromHelper(peerUidHelper!, socket),
				dispatcher });
		}
		// Compose owners before negotiating approval capability, without waiting for Matrix.
		await server.start();
		const uncertainApprovals = await hostApprovals?.recover();
		if (uncertainApprovals?.length) process.stderr.write("pi-managed-session-relay: previous host action outcomes are unknown; inspect state before explicitly trying again\n");
		await controlServer?.start();
		retirement.start();
		const authenticatedUserId = await retryMatrixStartup(() => matrix.whoami(signal), async () => {
			await syncHealth(false);
			process.stderr.write("pi-managed-session-relay: waiting for Matrix startup connectivity; local IPC remains available\n");
		}, signal);
		if (authenticatedUserId !== matrix.botUserId) throw new Error("Matrix whoami did not match PI_MATRIX_BOT_USER_ID");
		matrixAuthenticated = true; retirement.kick();
		// Pending publications are reconciled in independent room workers, never on the boot/intake path.
		if (coordinatorValues.every((value) => value?.trim())) {
			coordinator = await retryMatrixStartup(() => bootstrapCoordinator(hostId, {
				workspaceDirectory: coordinatorValues[0]!.trim(),
				sessionFile: coordinatorValues[1]!.trim(),
				concept: environment.PI_MANAGED_COORDINATOR_CONCEPT?.trim() || `${hostId} coordinator`,
			}, registry, matrix, signal), async () => {
				await syncHealth(false);
				process.stderr.write("pi-managed-session-relay: coordinator provisioning remains pending; local IPC is available; unresolved ownership or creation requires explicit reconciliation\n");
			}, signal, undefined, (error) => error.code !== "cancelled");
		}
		if (hostLifecycle) {
			const pendingReconciliation = hostLifecycle.pendingReconciliationCount();
			if (pendingReconciliation > 0) process.stderr.write(`pi-managed-session-relay: ${pendingReconciliation} managed project conversation(s) require explicit Space reconciliation\n`);
		}
		artifactExporter.start();
		if (coordinator) {
			const identity = coordinator;
			coordinatorRouter = new CoordinatorRouter(identity.manifest, registry, matrix, server, async (manifest) => {
				try {
					await hostLifecycle!.wake(manifest);
				} catch (error) {
					await registry.recordLaunchError(manifest.conversationId, "launch_failed",
						error instanceof Error ? error.message : "Managed conversation launch failed");
					throw error;
				}
			}, async (sourceId, manifest, error) => {
				const transient = error instanceof MatrixError && error.retryable;
				await eventProjector.projectNotice(manifest.conversationId, `${sourceId}:launch-${transient ? "retry" : "failed"}`,
					"Managed conversation wake failed; queued input remains available for retry.", transient ? "silent" : "notify");
			}, async (sourceId, manifest, body) => eventProjector.projectNotice(manifest.conversationId, sourceId, body),
			(message) => process.stderr.write(`pi-managed-session-relay: managed routing unavailable: ${redactManagedValue(message, environment)}\n`),
			(conversationId) => controlPollPublisher.reconcile(conversationId), (conversationId) => eventProjector!.checkpointPollPublisher.reconcile(conversationId), media,
			(conversationId, operationId) => activityProjector!.beginOperationFeedback(conversationId, operationId),
			(conversationId, operationId) => activityProjector!.endOperationFeedback(conversationId, operationId), syncHealth,
			async (manifest) => {
				if (manifest.kind === "coordinator") await registry.recordCoordinatorDeparture(manifest.conversationId);
				else await retirement!.retire(manifest.conversationId);
			}, (vote) => hostApprovals?.vote(vote) ?? Promise.resolve(false), response => account?.client.ingest(response) ?? Promise.resolve(),
			(manifest, eventId, sender, body) => matrixHostCommands?.accept(manifest, eventId, sender, body) ?? Promise.resolve(false));
			await coordinatorRouter.loadInbox(resolve(stateDirectory, "inbox.json"));
			coordinatorRouter.start();
			account?.start(id => retirement!.retire(id));
			await hostLifecycle!.reconcileGenerationTransitions();
			if (registry.conversationState(identity.manifest.conversationId) === "active") await coordinatorRouter.attachmentReady(identity.manifest.conversationId);
		}
		if (hostLifecycle && hierarchy && server) {
			const lifecycle = hostLifecycle; const ipc = server;
			localEnrollments = new LocalEnrollmentReconciler(() => registry.localConversations().map((item) => item.conversationId), async (conversationId, signal) => {
				await lifecycle.completeLocalEnrollment(conversationId, signal); signal.throwIfAborted();
				if (ipc.supports(conversationId, "local-enrollment-v1")) ipc.sendToConversation({ protocolVersion: MANAGED_SESSION_PROTOCOL_VERSION,
					messageId: `relay-binding-${randomUUID()}`, conversationId, role: "relay", type: "binding.status", payload: { matrixBinding: "bound" } });
				if (registry.isActiveGenerationAttached(conversationId)) {
					await activityProjector?.attachmentConnected(conversationId);
					await coordinatorRouter?.attachmentReady(conversationId);
				}
			}, (conversationId, error) => process.stderr.write(`pi-managed-session-relay: local Matrix binding pending (${conversationId}): ${redactManagedValue(error instanceof Error ? error.message : "unavailable", environment).slice(0, 800)}\n`));
			localEnrollments.start();
		}
	} catch (error) {
		await matrixHostCommands?.close().catch(() => undefined);
		await account?.close().catch(() => undefined);
		await controlServer?.close().catch(() => undefined);
		await hostApprovals?.close().catch(() => undefined);
		await retirement?.close().catch(() => undefined);
		const enrollmentClosing = localEnrollments?.close();
		await hierarchy?.close().catch(() => undefined);
		await enrollmentClosing;
		await closeArtifactExporter().catch(() => undefined);
		await recoveryMonitor?.close().catch(() => undefined);
		await closeNotices().catch(() => undefined);
		await coordinatorRouter?.stop().catch(() => undefined);
		await matrixHostCommands?.close().catch(() => undefined);
		await activityProjector?.close().catch(() => undefined);
		await server?.close({ preserveAttachments: true }).catch(() => undefined);
		await relayLock?.release();
		throw error;
	}
	const reconciliationTimer = setTimeout(() => {
		void registry.finishRestartReconciliation()
			.then(() => hostLifecycle?.recoverTerminalPromotions())
			.then(() => coordinatorRouter?.reconcileWake()).catch(async () => {
			process.stderr.write("pi-managed-session-relay: restart reconciliation failed\n");
			await matrixHostCommands?.close().catch(() => undefined);
			await account?.close().catch(() => undefined);
			await controlServer?.close().catch(() => undefined);
			await hostApprovals?.close().catch(() => undefined);
			await retirement?.close().catch(() => undefined);
			await server.close({ preserveAttachments: true }).catch(() => undefined);
			const enrollmentClosing = localEnrollments?.close();
			await hierarchy?.close().catch(() => undefined);
			await enrollmentClosing;
			await relayLock?.release().catch(() => undefined);
			process.exitCode = 1;
		});
	}, graceMilliseconds);
	reconciliationTimer.unref();
	let stopped = false;
	let stopWork: Promise<void> | undefined;
	let runtimeUpdate: Promise<void> | undefined;
	const desiredRuntime = environment.PI_MANAGED_PROJECT_RUNTIME_ID;
	const runtimeUpdateTimer = desiredRuntime && /^[a-f0-9]{64}$/.test(desiredRuntime) ? setInterval(() => {
		if (stopped || runtimeUpdate || !hostLifecycle) return;
		runtimeUpdate = hostLifecycle.reconcileRuntimeUpdates(desiredRuntime).catch(() => {
			process.stderr.write("pi-managed-session-relay: managed runtime update deferred\n");
		}).finally(() => { runtimeUpdate = undefined; });
	}, Math.max(graceMilliseconds, 30_000)) : undefined;
	runtimeUpdateTimer?.unref();
	return {
		registry,
		server,
		stop() { return stopWork ??= (async () => {
			stopped = true;
			const controlClosing = controlServer?.close();
			if (runtimeUpdateTimer) clearInterval(runtimeUpdateTimer);
			hostLifecycle?.stopRuntimeUpdates();
			await runtimeUpdate;
			clearTimeout(reconciliationTimer);
			await matrixHostCommands?.close();
			await account?.close();
			await hostApprovals?.close();
			await retirement?.close();
			const enrollmentClosing = localEnrollments?.close();
			await hierarchy?.close();
			await enrollmentClosing;
			await closeArtifactExporter();
			await coordinatorRouter?.stop();
			await matrixHostCommands?.close();
			await recoveryMonitor?.close();
			await closeNotices();
			await activityProjector?.close();
			await server.close({ preserveAttachments: true });
			await controlClosing;
			await relayLock?.release();
		})(); },
	};
}

async function main(): Promise<void> {
	if (process.argv[2] === "--migrate-v1-to-v2") {
		if (process.argv.length !== 3) throw new Error("--migrate-v1-to-v2 accepts no additional arguments");
		const stateDirectory = resolve(required(process.env, "PI_MANAGED_SESSIONS_STATE_DIR"));
		const manifestDirectory = resolve(required(process.env, "PI_MANAGED_SESSIONS_MANIFEST_DIR"));
		await migrateManagedSessionStoresV1ToV2(resolve(stateDirectory, "registry.json"), manifestDirectory);
		return;
	}
	if (process.argv.length !== 2) throw new Error("Managed-session relay accepts only --migrate-v1-to-v2");
	const startup = new AbortController();
	const cancelStartup = () => startup.abort();
	process.once("SIGINT", cancelStartup);
	process.once("SIGTERM", cancelStartup);
	let relay: RunningRelay;
	try { relay = await startManagedSessionRelay(process.env, startup.signal); }
	finally {
		process.removeListener("SIGINT", cancelStartup);
		process.removeListener("SIGTERM", cancelStartup);
	}
	let stopping = false;
	const stop = () => {
		if (stopping) return;
		stopping = true;
		void relay.stop().then(() => process.exit(0), () => process.exit(1));
	};
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
}

if (require.main === module) {
	main().catch((error: unknown) => {
		const message = error instanceof Error ? error.message : "Managed-session relay failed";
		process.stderr.write(`pi-managed-session-relay: ${redactManagedValue(message)}\n`);
		process.exitCode = 1;
	});
}
