#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
	MANAGED_SESSION_PROTOCOL_VERSION,
	MANAGED_SESSION_STATE_VERSION,
	deriveConversationId,
	type ConversationManifest,
	type ManagedSessionEnvelope,
	type WorkspaceIdentity,
} from "../contracts.js";
import { bootstrapCoordinator, type CoordinatorIdentity } from "./coordinator-bootstrap.js";
import { launchCoordinator } from "./coordinator-launcher.js";
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
import { redactManagedValue } from "./redaction.js";
import { migrateManagedSessionStoresV1ToV2 } from "./v2-migration.js";

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

export async function startManagedSessionRelay(environment: NodeJS.ProcessEnv = process.env): Promise<RunningRelay> {
	const runtimeDirectory = resolve(required(environment, "PI_MANAGED_SESSIONS_RUNTIME_DIR"));
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
	const relayLock = relayLockHelper ? new HostRelayLock(relayLockHelper, await hostRelayLockPath(hostId, expectedUid)) : undefined;
	await relayLock?.acquire();
	const registry = new RelayRegistry(hostId, runtimeDirectory, new ConversationManifestStore(manifestDirectory));
	let server: ManagedSessionIpcServer | undefined;
	let coordinatorRouter: CoordinatorRouter | undefined;
	let hostLifecycle: HostLifecycle | undefined;
	try {
		await registry.load();
		const matrix = new ManagedMatrixClient(managedMatrixConfigFromEnvironment(environment), fetch, registry.managedRoomIds());
		const authenticatedUserId = await matrix.whoami();
		if (authenticatedUserId !== matrix.botUserId) throw new Error("Matrix whoami did not match PI_MATRIX_BOT_USER_ID");
		const coordinatorValues = [
			environment.PI_MANAGED_COORDINATOR_WORKSPACE_DIR,
			environment.PI_MANAGED_COORDINATOR_SESSION_FILE,
			environment.PI_MANAGED_COORDINATOR_LAUNCHER,
		];
		if (coordinatorValues.some((value) => value?.trim()) && !coordinatorValues.every((value) => value?.trim())) {
			throw new Error("Coordinator workspace, session file, and launcher must be configured together");
		}
		let coordinator: CoordinatorIdentity | undefined;
		if (coordinatorValues.every((value) => value?.trim())) {
			coordinator = await bootstrapCoordinator(hostId, {
				workspaceDirectory: coordinatorValues[0]!.trim(),
				sessionFile: coordinatorValues[1]!.trim(),
				concept: environment.PI_MANAGED_COORDINATOR_CONCEPT?.trim() || `${hostId} coordinator`,
			}, registry, matrix);
		}
		const transcriptProjector = new TranscriptProjector(registry, matrix);
		const eventProjector = new RelayEventProjector(registry, matrix);
		registry.beginRestartReconciliation();
		const response = (conversationId: string, inReplyTo: string, type: "self.result" | "input.result" | "transcript.acknowledge" | "checkpoint.acknowledge" | "lifecycle.result", payload: Record<string, unknown>): ManagedSessionEnvelope => ({
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
			peerUid: peerUidHelper ? (socket) => peerUidFromHelper(peerUidHelper, socket) : undefined,
			onAttachment: async (attachment) => {
				await coordinatorRouter?.attachmentReady(attachment.conversationId);
			},
			onUnboundEnvelope: async (envelope) => {
				if (envelope.type !== "self.bind" || envelope.role !== "ordinary_adapter") return undefined;
				const payload = envelope.payload as {
					creationKey: string; concept: string; sessionId: string; attachmentNonce: string;
					bindingBoundaryEntryId: string; placement: WorkspaceIdentity;
				};
				const conversationId = deriveConversationId(hostId, payload.creationKey);
				const existing = registry.manifestByCreationKey(payload.creationKey);
				let manifest: ConversationManifest;
				if (existing) {
					if (existing.conversationId !== conversationId || existing.concept !== payload.concept ||
						existing.piSessionId !== payload.sessionId || existing.bindingBoundaryEntryId !== payload.bindingBoundaryEntryId ||
						JSON.stringify(existing.placement) !== JSON.stringify(payload.placement)) {
						throw new RelayRegistryError("invalid_state", "Self-binding retry conflicts with the existing conversation");
					}
					manifest = await registry.createProjectConversation(existing, payload.attachmentNonce);
				} else {
					const roomId = await matrix.createPrivateRoom(`pi · ${payload.concept}`);
					manifest = {
						schemaVersion: MANAGED_SESSION_STATE_VERSION,
						kind: "project",
						conversationId,
						ownerHostId: hostId,
						creationKey: payload.creationKey,
						concept: payload.concept,
						piSessionId: payload.sessionId,
						roomId,
						placement: payload.placement,
						bindingBoundaryEntryId: payload.bindingBoundaryEntryId,
						createdAt: new Date().toISOString(),
					};
					try {
						manifest = await registry.createProjectConversation(manifest, payload.attachmentNonce);
					} catch (error) {
						await matrix.leaveRoom(roomId).catch(() => undefined);
						throw error;
					}
				}
				return response(manifest.conversationId, envelope.messageId, "self.result", {
					operation: "self.bind", status: "ok", boundConversationId: manifest.conversationId,
				});
			},
			onEnvelope: async (envelope, attachment) => {
				if (envelope.type === "input.acknowledge") {
					const payload = envelope.payload as { deliveryId: string; status: string; piEntryId?: string; completionKind?: string };
					const input = registry.pendingInputs(attachment.conversationId).find((candidate) => candidate.deliveryId === payload.deliveryId);
					const command = payload.completionKind === "extension_command" ? input?.body?.match(/^\/([^\s]+)/)?.[1] : undefined;
					if (payload.completionKind === "extension_command" && !command) {
						throw new RelayRegistryError("invalid_state", "Extension-command completion did not match a command delivery");
					}
					await registry.acknowledgeInput(attachment.conversationId, payload.deliveryId, payload.status, payload.piEntryId, payload.completionKind);
					if (command) await eventProjector.projectNotice(attachment.conversationId, `${payload.deliveryId}:command`, `Command dispatched: /${command}`);
					return response(attachment.conversationId, envelope.messageId, "input.result", {
						deliveryId: payload.deliveryId, status: payload.status,
					});
				}
				if (envelope.type === "transcript.offer") {
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
				if (envelope.type === "lifecycle.request") {
					if (!hostLifecycle || attachment.role !== "coordinator_adapter") throw new RelayRegistryError("permission_denied", "Coordinator lifecycle is unavailable");
					return response(attachment.conversationId, envelope.messageId, "lifecycle.result", await hostLifecycle.request(envelope));
				}
				if (envelope.type === "self.status") {
					return response(attachment.conversationId, envelope.messageId, "self.result", {
						operation: "self.status", status: "ok", conversationState: registry.conversationState(attachment.conversationId),
					});
				}
				if (envelope.type === "self.delete") {
					const deleted = await registry.deleteConversation(attachment.conversationId);
					try {
						await matrix.leaveRoom(deleted.manifest.roomId);
					} catch (error) {
						await registry.restoreDeletedConversation(deleted);
						throw error;
					}
					return response(attachment.conversationId, envelope.messageId, "self.result", {
						operation: "self.delete", status: "ok",
					});
				}
				return undefined;
			},
		});
		await server.start();
		if (coordinator) {
			const projectSessionDirectory = environment.PI_MANAGED_PROJECT_SESSION_DIR?.trim() || resolve(runtimeDirectory, "project-sessions");
			hostLifecycle = new HostLifecycle({
				hostId, launcher: environment.PI_MANAGED_COORDINATOR_LAUNCHER!.trim(), projectSessionDirectory: resolve(projectSessionDirectory),
				socketPath: server.socketPath, registry, matrix, server, environment,
			});
			const identity = coordinator;
			coordinatorRouter = new CoordinatorRouter(identity.manifest, registry, matrix, server, async (manifest) => {
				try {
					if (manifest.kind === "project") await hostLifecycle!.wake(manifest);
					else await launchCoordinator({
						launcher: environment.PI_MANAGED_COORDINATOR_LAUNCHER!.trim(), manifest,
						sessionFile: identity.sessionFile, workspaceDirectory: identity.workspaceDirectory,
						socketPath: server!.socketPath, registry, environment,
					});
				} catch (error) {
					await registry.recordLaunchError(manifest.conversationId, "launch_failed",
						error instanceof Error ? error.message : "Managed conversation launch failed");
					throw error;
				}
			}, async (sourceId, manifest) => {
				await eventProjector.projectNotice(manifest.conversationId, `${sourceId}:launch-failed`,
					"Managed conversation wake failed; queued input remains available for retry.");
			}, async (sourceId, manifest, body) => eventProjector.projectNotice(manifest.conversationId, sourceId, body),
			(message) => process.stderr.write(`pi-managed-session-relay: managed routing unavailable: ${redactManagedValue(message, environment)}\n`));
			coordinatorRouter.start();
			if (registry.conversationState(identity.manifest.conversationId) === "active") await coordinatorRouter.attachmentReady(identity.manifest.conversationId);
		}
	} catch (error) {
		await coordinatorRouter?.stop().catch(() => undefined);
		await server?.close({ preserveAttachments: true }).catch(() => undefined);
		await relayLock?.release();
		throw error;
	}
	const reconciliationTimer = setTimeout(() => {
		void registry.finishRestartReconciliation().then(() => coordinatorRouter?.reconcileWake()).catch(async () => {
			process.stderr.write("pi-managed-session-relay: restart reconciliation failed\n");
			await server.close({ preserveAttachments: true }).catch(() => undefined);
			await relayLock?.release().catch(() => undefined);
			process.exitCode = 1;
		});
	}, graceMilliseconds);
	reconciliationTimer.unref();
	let stopped = false;
	return {
		registry,
		server,
		async stop() {
			if (stopped) return;
			stopped = true;
			clearTimeout(reconciliationTimer);
			await coordinatorRouter?.stop();
			await server.close({ preserveAttachments: true });
			await relayLock?.release();
		},
	};
}

async function main(): Promise<void> {
	if (process.argv[2] === "--migrate-v1-to-v2") {
		if (process.argv.length !== 3) throw new Error("--migrate-v1-to-v2 accepts no additional arguments");
		const runtimeDirectory = resolve(required(process.env, "PI_MANAGED_SESSIONS_RUNTIME_DIR"));
		const manifestDirectory = resolve(required(process.env, "PI_MANAGED_SESSIONS_MANIFEST_DIR"));
		await migrateManagedSessionStoresV1ToV2(resolve(runtimeDirectory, "registry.json"), manifestDirectory);
		return;
	}
	if (process.argv.length !== 2) throw new Error("Managed-session relay accepts only --migrate-v1-to-v2");
	const relay = await startManagedSessionRelay();
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
