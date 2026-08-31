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
import { ConversationManifestStore } from "./manifest-store.js";
import { ManagedSessionIpcServer } from "./ipc-server.js";
import { managedMatrixConfigFromEnvironment, ManagedMatrixClient } from "./matrix-client.js";
import { peerUidFromHelper } from "./peer-uid.js";
import { RelayRegistry, RelayRegistryError } from "./registry.js";
import { hostRelayLockPath, HostRelayLock } from "./relay-lock.js";

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
	try {
		await registry.load();
		const matrix = new ManagedMatrixClient(managedMatrixConfigFromEnvironment(environment), fetch, registry.managedRoomIds());
		const authenticatedUserId = await matrix.whoami();
		if (authenticatedUserId !== matrix.botUserId) throw new Error("Matrix whoami did not match PI_MATRIX_BOT_USER_ID");
		registry.beginRestartReconciliation();
		const response = (conversationId: string, inReplyTo: string, type: "self.result", payload: Record<string, unknown>): ManagedSessionEnvelope => ({
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
					const payload = envelope.payload as { deliveryId: string; status: string; piEntryId?: string };
					await registry.acknowledgeInput(attachment.conversationId, payload.deliveryId, payload.status, payload.piEntryId);
					return undefined;
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
	} catch (error) {
		await server?.close({ preserveAttachments: true }).catch(() => undefined);
		await relayLock?.release();
		throw error;
	}
	const reconciliationTimer = setTimeout(() => {
		void registry.finishRestartReconciliation().catch(async () => {
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
			await server.close({ preserveAttachments: true });
			await relayLock?.release();
		},
	};
}

async function main(): Promise<void> {
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
		process.stderr.write(`pi-managed-session-relay: ${message}\n`);
		process.exitCode = 1;
	});
}
