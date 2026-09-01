import { randomUUID } from "node:crypto";
import { chmod, lstat, open, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import {
	MANAGED_SESSION_STATE_VERSION,
	deriveConversationId,
	deriveTranscriptEntryId,
	type ConversationManifest,
} from "../contracts.js";
import { ensurePrivateDirectory } from "./atomic-json.js";
import { ManagedMatrixClient } from "./matrix-client.js";
import { RelayRegistry, RelayRegistryError } from "./registry.js";

const COORDINATOR_CREATION_KEY = "coordinator";
const COORDINATOR_INSTRUCTIONS = `# Managed session coordinator\n\nThis neutral workspace belongs to the host coordinator.\n\n- Coordinate managed Pi conversations; do not treat this workspace as a project.\n- Conversation objectives arrive as ordinary operator messages, never lifecycle metadata.\n- Use only coordinator-role lifecycle tools exposed by the managed-session adapter.\n- Do not delete or unbind the coordinator conversation.\n`;

export interface CoordinatorBootstrapConfig {
	workspaceDirectory: string;
	sessionFile: string;
	concept: string;
}

export interface CoordinatorIdentity {
	manifest: ConversationManifest;
	sessionFile: string;
	workspaceDirectory: string;
}

function validateConfig(config: CoordinatorBootstrapConfig): CoordinatorBootstrapConfig {
	const workspaceDirectory = resolve(config.workspaceDirectory);
	const sessionFile = resolve(config.sessionFile);
	if (!isAbsolute(config.workspaceDirectory) || !isAbsolute(config.sessionFile)) throw new Error("Coordinator workspace and session file must be absolute");
	if (config.concept.length < 1 || config.concept.length > 128) throw new Error("Coordinator concept must contain 1-128 characters");
	return { ...config, workspaceDirectory, sessionFile };
}

async function materializeSession(config: CoordinatorBootstrapConfig): Promise<{ sessionId: string; boundaryEntryId: string }> {
	await ensurePrivateDirectory(config.workspaceDirectory);
	const instructionsPath = resolve(config.workspaceDirectory, "AGENTS.md");
	await writeFile(instructionsPath, COORDINATOR_INSTRUCTIONS, { mode: 0o600 });
	await chmod(instructionsPath, 0o600);
	await ensurePrivateDirectory(dirname(config.sessionFile));
	try {
		const metadata = await lstat(config.sessionFile);
		if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("Coordinator Pi session must be a regular non-symlink file");
		const expectedUid = process.getuid?.();
		if (expectedUid !== undefined && metadata.uid !== expectedUid) throw new Error("Coordinator Pi session belongs to another user");
		await chmod(config.sessionFile, 0o600);
		const source = await readFile(config.sessionFile, "utf8");
		const lines = source.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
		const header = lines[0] as { type?: unknown; id?: unknown; cwd?: unknown } | undefined;
		const boundaries = lines.filter((entry) => entry.type === "custom" && entry.customType === "managed-session.binding-boundary") as
			Array<{ id?: unknown; data?: unknown }>;
		const boundary = boundaries.length === 1 ? boundaries[0] : undefined;
		const boundaryData = typeof boundary?.data === "object" && boundary.data !== null ? boundary.data as Record<string, unknown> : undefined;
		if (header?.type !== "session" || typeof header.id !== "string" || header.cwd !== config.workspaceDirectory || typeof boundary?.id !== "string" ||
			boundaryData?.version !== MANAGED_SESSION_STATE_VERSION || boundaryData.creationKey !== COORDINATOR_CREATION_KEY ||
			boundaryData.concept !== config.concept || boundaryData.sessionId !== header.id) {
			throw new Error("Existing coordinator Pi session does not match its durable bootstrap identity");
		}
		return { sessionId: header.id, boundaryEntryId: deriveTranscriptEntryId(header.id, boundary.id) };
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
	}
	const sessionId = randomUUID();
	const boundaryKey = randomUUID().replaceAll("-", "").slice(0, 8);
	const now = new Date().toISOString();
	const entries = [
		{ type: "session", version: 3, id: sessionId, timestamp: now, cwd: config.workspaceDirectory },
		{
			type: "custom", id: boundaryKey, parentId: null, timestamp: now, customType: "managed-session.binding-boundary",
			data: { version: MANAGED_SESSION_STATE_VERSION, creationKey: COORDINATOR_CREATION_KEY, concept: config.concept, sessionId },
		},
	];
	const file = await open(config.sessionFile, "wx", 0o600);
	try { await file.writeFile(`${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8"); await file.sync(); }
	finally { await file.close(); }
	const sessionDirectory = await open(dirname(config.sessionFile), "r");
	try { await sessionDirectory.sync(); } finally { await sessionDirectory.close(); }
	return { sessionId, boundaryEntryId: deriveTranscriptEntryId(sessionId, boundaryKey) };
}

async function createCoordinatorRooms(matrix: ManagedMatrixClient, hostId: string, concept: string): Promise<{ roomId: string; hostSpace: string }> {
	const hostSpace = await matrix.createPrivateSpace(`pi · ${hostId}`);
	try {
		const roomId = await matrix.createPrivateRoom(`pi · ${concept}`);
		try { await matrix.addSpaceChild(hostSpace, roomId); }
		catch (error) { await matrix.leaveRoom(roomId).catch(() => undefined); throw error; }
		return { roomId, hostSpace };
	} catch (error) {
		await matrix.leaveRoom(hostSpace).catch(() => undefined);
		throw error;
	}
}

export async function bootstrapCoordinator(
	hostId: string,
	configValue: CoordinatorBootstrapConfig,
	registry: RelayRegistry,
	matrix: ManagedMatrixClient,
): Promise<CoordinatorIdentity> {
	const config = validateConfig(configValue);
	const session = await materializeSession(config);
	const conversationId = deriveConversationId(hostId, COORDINATOR_CREATION_KEY);
	const existing = registry.manifestByCreationKey(COORDINATOR_CREATION_KEY);
	if (existing) {
		if (existing.kind !== "coordinator" || existing.conversationId !== conversationId || existing.piSessionId !== session.sessionId ||
			existing.bindingBoundaryEntryId !== session.boundaryEntryId || existing.concept !== config.concept) {
			throw new RelayRegistryError("invalid_state", "Coordinator session and manifest identity conflict");
		}
		if (await matrix.roomAccessible(existing.roomId)) {
			let hostSpace = existing.hostSpace;
			let createdSpace = false;
			if (!hostSpace || !(await matrix.roomAccessible(hostSpace))) {
				hostSpace = await matrix.createPrivateSpace(`pi · ${hostId}`);
				createdSpace = true;
			}
			try {
				await matrix.addSpaceChild(hostSpace, existing.roomId);
				const manifest = hostSpace === existing.hostSpace ? existing : await registry.replaceCoordinatorRoom(conversationId, existing.roomId, hostSpace);
				return { manifest, ...config };
			} catch (error) {
				if (createdSpace) await matrix.leaveRoom(hostSpace).catch(() => undefined);
				throw error;
			}
		}
		let hostSpace = existing.hostSpace;
		let createdSpace = false;
		if (!hostSpace || !(await matrix.roomAccessible(hostSpace))) {
			hostSpace = await matrix.createPrivateSpace(`pi · ${hostId}`);
			createdSpace = true;
		}
		const roomId = await matrix.createPrivateRoom(`pi · ${config.concept}`);
		try { await matrix.addSpaceChild(hostSpace, roomId); }
		catch (error) {
			await matrix.leaveRoom(roomId).catch(() => undefined);
			if (createdSpace) await matrix.leaveRoom(hostSpace).catch(() => undefined);
			throw error;
		}
		try {
			const manifest = await registry.replaceCoordinatorRoom(conversationId, roomId, hostSpace);
			return { manifest, ...config };
		} catch (error) {
			await matrix.leaveRoom(roomId).catch(() => undefined);
			if (createdSpace) await matrix.leaveRoom(hostSpace).catch(() => undefined);
			throw error;
		}
	}
	const rooms = await createCoordinatorRooms(matrix, hostId, config.concept);
	const manifest: ConversationManifest = {
		schemaVersion: MANAGED_SESSION_STATE_VERSION,
		kind: "coordinator",
		conversationId,
		ownerHostId: hostId,
		creationKey: COORDINATOR_CREATION_KEY,
		concept: config.concept,
		piSessionId: session.sessionId,
		roomId: rooms.roomId,
		hostSpace: rooms.hostSpace,
		bindingBoundaryEntryId: session.boundaryEntryId,
		createdAt: new Date().toISOString(),
	};
	try {
		return { manifest: await registry.createCoordinatorConversation(manifest), ...config };
	} catch (error) {
		await matrix.leaveRoom(rooms.roomId).catch(() => undefined);
		await matrix.leaveRoom(rooms.hostSpace).catch(() => undefined);
		throw error;
	}
}
