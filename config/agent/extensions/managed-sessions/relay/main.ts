#!/usr/bin/env node
import { resolve } from "node:path";
import { ConversationManifestStore } from "./manifest-store.js";
import { ManagedSessionIpcServer } from "./ipc-server.js";
import { managedMatrixConfigFromEnvironment, ManagedMatrixClient } from "./matrix-client.js";
import { peerUidFromHelper } from "./peer-uid.js";
import { RelayRegistry } from "./registry.js";
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
		server = new ManagedSessionIpcServer(registry, {
			runtimeDirectory,
			socketPath: environment.PI_MANAGED_SESSIONS_SOCKET,
			expectedUid,
			peerUid: peerUidHelper ? (socket) => peerUidFromHelper(peerUidHelper, socket) : undefined,
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
