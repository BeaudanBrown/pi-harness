import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, lstat, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
	MANAGED_SESSION_STATE_VERSION,
	deriveConversationId,
	deriveGenerationId,
	deriveTranscriptEntryId,
	type ConversationManifest,
	type ManagedSessionEnvelope,
	type WorkspaceIdentity,
} from "../contracts.js";
import { AtomicJsonFile, ensurePrivateDirectory } from "./atomic-json.js";
import { ManagedSessionIpcServer } from "./ipc-server.js";
import { ManagedMatrixClient } from "./matrix-client.js";
import { ProjectReconciler } from "./project-reconciliation.js";
import { RelayRegistry, RelayRegistryError } from "./registry.js";

export interface ManagedWindow {
	conversationId: string;
	sessionName: string;
	windowId: string;
	paneId: string;
	rootKey: string;
	workspace: string;
	relativeCwd: string;
	role: "conversation";
}

export interface ResolvedWorkspace extends WorkspaceIdentity {
	workspacePath: string;
	cwd: string;
	projectKey: string;
	projectDisplayName: string;
	checkoutDisplayName: string;
}

function hasValidProjectIdentity(value: Record<string, unknown>): value is Record<string, unknown> & Pick<ResolvedWorkspace, "projectKey" | "projectDisplayName" | "checkoutDisplayName"> {
	return typeof value.projectKey === "string" && /^project_[a-f0-9]{32}$/.test(value.projectKey) &&
		[value.projectDisplayName, value.checkoutDisplayName].every((item) => typeof item === "string" && item.length > 0 && item.length <= 128 && !/[\u0000-\u001f\u007f/]/.test(item));
}

function safeJsonObject(value: string, failure: string): Record<string, unknown> {
	let parsed: unknown;
	try { parsed = JSON.parse(value); } catch { throw new RelayRegistryError("launch_failed", failure); }
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new RelayRegistryError("launch_failed", failure);
	return parsed as Record<string, unknown>;
}

export function parseProjectWindow(result: Record<string, unknown>, manifest: ConversationManifest): ManagedWindow {
	if (manifest.kind !== "project" || !manifest.placement) throw new RelayRegistryError("invalid_state", "Project window requires project placement");
	const placement = manifest.placement;
	const expected = {
		conversationId: manifest.conversationId, role: "conversation", rootKey: placement.rootKey,
		workspace: placement.workspace, relativeCwd: placement.relativeCwd,
	} as const;
	for (const [field, value] of Object.entries(expected)) {
		if (result[field] !== value) throw new RelayRegistryError("launch_failed", `Project launcher returned an invalid ${field}`);
	}
	if (typeof result.sessionName !== "string" || !result.sessionName) throw new RelayRegistryError("launch_failed", "Project launcher returned an invalid sessionName");
	if (typeof result.windowId !== "string" || !/^@[0-9]+$/.test(result.windowId)) throw new RelayRegistryError("launch_failed", "Project launcher returned an invalid windowId");
	if (typeof result.paneId !== "string" || !/^%[0-9]+$/.test(result.paneId)) throw new RelayRegistryError("launch_failed", "Project launcher returned an invalid paneId");
	const fields = new Set(["conversationId", "sessionName", "windowId", "paneId", "role", "rootKey", "workspace", "relativeCwd"]);
	if (Object.keys(result).some((field) => !fields.has(field))) throw new RelayRegistryError("launch_failed", "Project launcher returned unexpected fields");
	return {
		conversationId: manifest.conversationId, sessionName: result.sessionName, windowId: result.windowId, paneId: result.paneId,
		rootKey: placement.rootKey, workspace: placement.workspace, relativeCwd: placement.relativeCwd, role: "conversation",
	};
}

interface MatrixProvisioningIntent {
	conversationId: string; concept: string; projectKey: string; projectDisplayName: string; checkoutDisplayName: string;
	projectSpaceId?: string; hostSpaceLinked?: boolean; roomId?: string; roomLinked?: boolean;
}

function parseMatrixProvisioningIntent(value: unknown): MatrixProvisioningIntent {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new RelayRegistryError("invalid_state", "Matrix provisioning intent is malformed");
	const item = value as Record<string, unknown>; const required = ["conversationId", "concept", "projectKey", "projectDisplayName", "checkoutDisplayName"];
	const allowed = new Set([...required, "projectSpaceId", "hostSpaceLinked", "roomId", "roomLinked"]);
	if (Object.keys(item).some((key) => !allowed.has(key)) || required.some((key) => typeof item[key] !== "string") ||
		!/^conv_[a-f0-9]{32}$/.test(String(item.conversationId)) || !/^project_[a-f0-9]{32}$/.test(String(item.projectKey)) ||
		!(typeof item.concept === "string" && item.concept.length > 0 && item.concept.length <= 128 && !/[\u0000-\u001f\u007f]/.test(item.concept)) ||
		![item.projectDisplayName, item.checkoutDisplayName].every((field) => typeof field === "string" && field.length > 0 && field.length <= 128 && !/[\u0000-\u001f\u007f/]/.test(field)) ||
		[item.projectSpaceId, item.roomId].some((field) => field !== undefined && (typeof field !== "string" || field.length < 1 || field.length > 255)) ||
		[item.hostSpaceLinked, item.roomLinked].some((field) => field !== undefined && typeof field !== "boolean") ||
		(item.hostSpaceLinked === true && !item.projectSpaceId) || (item.roomId && !item.projectSpaceId) || (item.roomLinked === true && !item.roomId)) {
		throw new RelayRegistryError("invalid_state", "Matrix provisioning intent is malformed");
	}
	return item as unknown as MatrixProvisioningIntent;
}

interface ProjectCreationIntent {
	creationKey: string; rootKey: string; workspace: string; concept: string; projectSpace?: string;
	projectKey?: string; projectDisplayName?: string; checkoutDisplayName?: string;
	sessionPersisted: boolean; projectSpaceId?: string; hostSpaceLinked?: boolean; roomId?: string; roomLinked?: boolean;
}

function parseProjectCreationIntent(value: unknown): ProjectCreationIntent {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new RelayRegistryError("invalid_state", "Project creation intent is malformed");
	const item = value as Record<string, unknown>;
	const allowed = new Set(["creationKey", "rootKey", "workspace", "concept", "projectSpace", "projectKey", "projectDisplayName", "checkoutDisplayName", "sessionPersisted", "projectSpaceId", "hostSpaceLinked", "roomId", "roomLinked"]);
	if (Object.keys(item).some((key) => !allowed.has(key)) || ![item.creationKey, item.rootKey, item.workspace, item.concept].every((field) => typeof field === "string" && field.length > 0 && field.length <= 128 && !/[\u0000-\u001f\u007f]/.test(field)) ||
		typeof item.sessionPersisted !== "boolean" || (item.projectSpace !== undefined && (typeof item.projectSpace !== "string" || item.projectSpace.length < 1 || item.projectSpace.length > 128)) ||
		(item.projectKey !== undefined && (typeof item.projectKey !== "string" || !/^project_[a-f0-9]{32}$/.test(item.projectKey))) ||
		[item.projectDisplayName, item.checkoutDisplayName].some((field) => field !== undefined && (typeof field !== "string" || field.length < 1 || field.length > 128 || /[\u0000-\u001f\u007f]/.test(field))) ||
		[item.projectKey, item.projectDisplayName, item.checkoutDisplayName].some((field) => field !== undefined) && [item.projectKey, item.projectDisplayName, item.checkoutDisplayName].some((field) => field === undefined) ||
		(item.projectSpaceId !== undefined && (typeof item.projectSpaceId !== "string" || item.projectSpaceId.length > 255)) || (item.hostSpaceLinked !== undefined && typeof item.hostSpaceLinked !== "boolean") ||
		(item.roomId !== undefined && (typeof item.roomId !== "string" || item.roomId.length > 255)) || (item.roomLinked !== undefined && typeof item.roomLinked !== "boolean") ||
		(item.projectSpaceId !== undefined && item.sessionPersisted !== true) || (item.hostSpaceLinked === true && !item.projectSpaceId) || (item.roomId && !item.projectSpaceId) || (item.roomLinked === true && !item.roomId)) {
		throw new RelayRegistryError("invalid_state", "Project creation intent is malformed");
	}
	return item as unknown as ProjectCreationIntent;
}

async function durableProjectSession(path: string, cwd: string, conversationId: string, creationKey: string, concept: string, ordinal = 1): Promise<{ sessionId: string; boundaryEntryId: string }> {
	const directory = await ensurePrivateDirectory(dirname(path));
	try {
		const info = await lstat(path);
		if (!info.isFile() || info.isSymbolicLink() || (process.getuid?.() !== undefined && info.uid !== process.getuid!())) {
			throw new RelayRegistryError("invalid_state", "Existing project Pi session is not a private relay-user file");
		}
		const text = await readFile(path, "utf8");
		const lines = text.trimEnd().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
		const header = lines[0];
		const boundaries = lines.filter((entry) => entry.type === "custom" && entry.customType === "managed-session.binding-boundary");
		const boundary = boundaries.length === 1 ? boundaries[0] : undefined;
		const data = boundary?.data as Record<string, unknown> | undefined;
		if (header?.type !== "session" || typeof header.id !== "string" || header.cwd !== cwd || typeof boundary?.id !== "string" ||
			data?.version !== MANAGED_SESSION_STATE_VERSION || data.creationKey !== creationKey || data.concept !== concept || data.sessionId !== header.id ||
			(ordinal > 1 && (data.ordinal !== ordinal || data.generationId !== deriveGenerationId(conversationId, ordinal)))) {
			throw new RelayRegistryError("invalid_state", "Existing project Pi session does not match its durable binding identity");
		}
		if ((info.mode & 0o077) !== 0) await chmod(path, 0o600);
		return { sessionId: header.id, boundaryEntryId: deriveTranscriptEntryId(header.id, boundary.id) };
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
	}
	const sessionId = ordinal === 1 ? `managed-${conversationId.slice(5)}` : `managed-${conversationId.slice(5)}-g${ordinal}`;
	const boundaryKey = ordinal === 1 ? `managed-boundary-${conversationId.slice(5)}` : `managed-boundary-${conversationId.slice(5)}-g${ordinal}`;
	const now = new Date().toISOString();
	const entries = [
		{ type: "session", version: 3, id: sessionId, timestamp: now, cwd },
		{ type: "custom", id: boundaryKey, parentId: null, timestamp: now, customType: "managed-session.binding-boundary",
			data: { version: MANAGED_SESSION_STATE_VERSION, creationKey, concept, sessionId, ...(ordinal > 1 ? { ordinal, generationId: deriveGenerationId(conversationId, ordinal) } : {}) } },
	];
	const temporary = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
	const file = await open(temporary, "wx", 0o600);
	try {
		await file.writeFile(`${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
		await file.sync();
	} catch (error) {
		await file.close();
		await rm(temporary, { force: true });
		throw error;
	}
	await file.close();
	try { await rename(temporary, path); }
	catch (error) { await rm(temporary, { force: true }); throw error; }
	const parent = await open(directory, "r");
	try { await parent.sync(); } finally { await parent.close(); }
	return { sessionId, boundaryEntryId: deriveTranscriptEntryId(sessionId, boundaryKey) };
}

export class HostLifecycle {
	private readonly launches = new Map<string, Promise<void>>();
	private readonly creations = new Map<string, Promise<Record<string, unknown>>>();
	private readonly provisions = new Map<string, Promise<{ roomId: string; projectSpace: string }>>();
	private readonly generationRetries = new Map<string, NodeJS.Timeout>();
	private readonly reconciler: ProjectReconciler;

	constructor(private readonly options: {
		hostId: string;
		launcher: string;
		projectSessionDirectory: string;
		socketPath: string;
		registry: RelayRegistry;
		matrix: ManagedMatrixClient;
		server: ManagedSessionIpcServer;
		environment?: NodeJS.ProcessEnv;
		projectNotice?: (sourceId: string, manifest: ConversationManifest, body: string) => Promise<void>;
		generationReady?: (conversationId: string) => Promise<void>;
		generationRetryMs?: number;
		endOperationFeedback?: (conversationId: string, operationId: string) => Promise<void>;
	}) {
		if (!isAbsolute(options.launcher)) throw new Error("Managed lifecycle launcher must be absolute");
		this.reconciler = new ProjectReconciler({ registry: options.registry, matrix: options.matrix, intentDirectory: options.projectSessionDirectory,
			resolveWorkspace: (placement) => this.resolveWorkspaceIdentity(placement) });
	}

	pendingReconciliationCount(): number { return this.reconciler.pendingCount(); }

	async request(envelope: ManagedSessionEnvelope): Promise<Record<string, unknown>> {
		if (envelope.role !== "coordinator_adapter" || envelope.type !== "lifecycle.request") throw new RelayRegistryError("permission_denied", "Coordinator lifecycle capability is required");
		const request = envelope.payload.request as Record<string, unknown>;
		switch (request.operation) {
			case "workspace.list": return { operation: "workspace.list", workspaces: await this.workspaceList() };
			case "conversation.list": return { operation: "conversation.list", conversations: this.options.registry.listConversations() };
			case "conversation.status": return this.status(String(request.targetConversationId));
			case "project.create": return this.createProject(request as never);
			case "project.reconcile.preview": return this.reconciler.preview();
			case "project.reconcile.apply":
				if (request.confirmed !== true) throw new RelayRegistryError("permission_denied", "Project reconciliation requires explicit confirmation");
				return this.reconciler.apply(String(request.reconciliationKey));
			case "project.space.cleanup":
				if (request.confirmed !== true) throw new RelayRegistryError("permission_denied", "Obsolete Space cleanup requires explicit confirmation");
				return this.reconciler.cleanup(String(request.reconciliationKey));
			case "conversation.start": return this.start(request as never);
			case "conversation.resume": return this.resume(String(request.targetConversationId));
			case "conversation.stop": return this.stop(String(request.targetConversationId));
			case "conversation.delete": {
				if (request.confirmed !== true) throw new RelayRegistryError("permission_denied", "Conversation bridge deletion requires explicit confirmation");
				return this.delete(String(request.targetConversationId));
			}
			default: throw new RelayRegistryError("invalid_state", "Unknown lifecycle operation");
		}
	}

	async resolveWorkspaceIdentity(placement: WorkspaceIdentity): Promise<ResolvedWorkspace> {
		const value = await this.invoke("workspace-resolve", placement);
		if (value.rootKey !== placement.rootKey || value.workspace !== placement.workspace || value.relativeCwd !== placement.relativeCwd ||
			typeof value.cwd !== "string" || !isAbsolute(value.cwd) || typeof value.workspacePath !== "string" || !isAbsolute(value.workspacePath) ||
			!hasValidProjectIdentity(value) || Object.keys(value).some((field) => !["rootKey", "workspace", "relativeCwd", "workspacePath", "cwd", "projectKey", "projectDisplayName", "checkoutDisplayName"].includes(field))) {
			throw new RelayRegistryError("launch_failed", "Workspace launcher returned an invalid canonical placement or project identity");
		}
		return value as unknown as ResolvedWorkspace;
	}

	provisionConversationMatrix(conversationId: string, concept: string, resolved: ResolvedWorkspace): Promise<{ roomId: string; projectSpace: string }> {
		const running = this.provisions.get(conversationId); if (running) return running;
		const provision = this.provisionConversationMatrixOnce(conversationId, concept, resolved)
			.finally(() => { if (this.provisions.get(conversationId) === provision) this.provisions.delete(conversationId); });
		this.provisions.set(conversationId, provision); return provision;
	}

	private async provisionConversationMatrixOnce(conversationId: string, concept: string, resolved: ResolvedWorkspace): Promise<{ roomId: string; projectSpace: string }> {
		const intentPath = join(resolve(this.options.projectSessionDirectory), conversationId, "matrix-provisioning.json");
		const file = new AtomicJsonFile(intentPath, parseMatrixProvisioningIntent);
		let intent = await file.read();
		if (intent) {
			const info = await lstat(intentPath); if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 ||
				(process.getuid?.() !== undefined && info.uid !== process.getuid!())) throw new RelayRegistryError("invalid_state", "Existing Matrix provisioning intent is not a private relay-user file");
			const expected = { conversationId, concept, projectKey: resolved.projectKey, projectDisplayName: resolved.projectDisplayName, checkoutDisplayName: resolved.checkoutDisplayName };
			for (const [key, value] of Object.entries(expected)) if ((intent as unknown as Record<string, unknown>)[key] !== value) throw new RelayRegistryError("invalid_state", "Matrix provisioning retry changed its host-resolved identity");
		} else {
			intent = { conversationId, concept, projectKey: resolved.projectKey, projectDisplayName: resolved.projectDisplayName, checkoutDisplayName: resolved.checkoutDisplayName };
			await file.write(intent);
		}
		if (!intent.projectSpaceId) {
			const matchingSpaces = new Set(this.options.registry.listManifests().filter((item) => item.kind === "project" && item.projectKey === resolved.projectKey)
				.map((item) => item.projectSpace).filter((item): item is string => Boolean(item)));
			if (matchingSpaces.size > 1) throw new RelayRegistryError("invalid_state", "Stable project identity maps to conflicting Matrix Spaces");
			intent = { ...intent, projectSpaceId: [...matchingSpaces][0] ?? await this.options.matrix.createPrivateSpaceIdempotent(resolved.projectDisplayName,
				`pi-${resolved.projectKey.slice("project_".length)}-space`) }; await file.write(intent);
		}
		const projectSpace = intent.projectSpaceId;
		if (!projectSpace) throw new RelayRegistryError("invalid_state", "Project Space identity is unavailable");
		const coordinator = this.options.registry.listManifests().find((item) => item.kind === "coordinator");
		if (!intent.hostSpaceLinked) { if (coordinator?.kind === "coordinator" && coordinator.hostSpace) await this.options.matrix.addSpaceChild(coordinator.hostSpace, projectSpace);
			intent = { ...intent, hostSpaceLinked: true }; await file.write(intent); }
		if (!intent.roomId) { intent = { ...intent, roomId: await this.options.matrix.createPrivateRoomIdempotent(
			`pi · ${resolved.checkoutDisplayName} · ${concept}`, `pi-${conversationId.slice(5)}-room`) }; await file.write(intent); }
		const roomId = intent.roomId;
		if (!roomId) throw new RelayRegistryError("invalid_state", "Project room identity is unavailable");
		if (!intent.roomLinked) { await this.options.matrix.addSpaceChild(projectSpace, roomId); intent = { ...intent, roomLinked: true }; await file.write(intent); }
		return { roomId, projectSpace };
	}

	async wake(manifest: ConversationManifest): Promise<void> {
		if (manifest.kind === "coordinator") throw new RelayRegistryError("permission_denied", "Coordinator wake uses its dedicated launcher");
		await this.launchProject(manifest);
	}

	async requestNewGeneration(manifest: ConversationManifest, sourceControlId: string, metadata: { model?: string; thinking?: string }): Promise<void> {
		const transition = await this.options.registry.beginGenerationTransition(manifest.conversationId, sourceControlId, metadata);
		try { await this.runGenerationTransition(manifest.conversationId, transition.transitionId, false); }
		catch (error) { this.scheduleGenerationRetry(manifest.conversationId, transition.transitionId); throw error; }
	}

	async reconcileGenerationTransitions(): Promise<void> {
		for (const item of this.options.registry.generationTransitions()) {
			try { await this.runGenerationTransition(item.conversationId, item.transition.transitionId, true); }
			catch { this.scheduleGenerationRetry(item.conversationId, item.transition.transitionId); }
		}
	}

	private scheduleGenerationRetry(conversationId: string, transitionId: string): void {
		if (this.generationRetries.has(conversationId)) return;
		const timer = setTimeout(() => {
			this.generationRetries.delete(conversationId);
			void this.runGenerationTransition(conversationId, transitionId, true).catch(() => this.scheduleGenerationRetry(conversationId, transitionId));
		}, this.options.generationRetryMs ?? 5_000);
		timer.unref(); this.generationRetries.set(conversationId, timer);
	}

	private async runGenerationTransition(conversationId: string, transitionId: string, recovering: boolean): Promise<void> {
		let manifest = this.projectManifest(conversationId);
		let transition = this.options.registry.generationTransitions().find((item) => item.conversationId === conversationId)?.transition;
		if (!transition || transition.transitionId !== transitionId) return;
		try {
			await this.options.projectNotice?.(`${transitionId}:${recovering ? "recovered" : "requested"}`, manifest, recovering
				? `Recovering fresh Pi session generation ${transition.ordinal}; the Matrix room and prior sessions remain preserved.`
				: `Fresh Pi session generation ${transition.ordinal} requested; preserving this room and all prior Pi sessions.`);
			const resolved = await this.invoke("workspace-resolve", manifest.placement!);
			if (typeof resolved.cwd !== "string" || !isAbsolute(resolved.cwd)) throw new RelayRegistryError("launch_failed", "Workspace launcher omitted canonical cwd");
			const root = await this.invoke("root-ensure", manifest.placement!);
			if (typeof root.sessionName !== "string" || !root.sessionName) throw new RelayRegistryError("launch_failed", "Root launcher omitted its tmux session name");
			const sessionFile = join(resolve(this.options.projectSessionDirectory), conversationId, `generation-${transition.ordinal}.jsonl`);
			if (manifest.activeGenerationId !== transition.toGenerationId || !this.options.registry.isActiveGenerationAttached(conversationId)) {
				const session = await durableProjectSession(sessionFile, resolved.cwd, conversationId, manifest.creationKey, manifest.concept, transition.ordinal);
				await this.options.registry.recordGenerationSession(conversationId, transitionId, session);
				manifest = await this.options.registry.activateGeneration(conversationId, transitionId);
				const persistedWindow = this.options.registry.managedWindow(conversationId);
				const inspectedWindow = this.parseWindowInspection(await this.invoke("window-inspect", { conversationId }), manifest, root.sessionName);
				if (persistedWindow && inspectedWindow && (persistedWindow.windowId !== inspectedWindow.windowId || persistedWindow.paneId !== inspectedWindow.paneId)) {
					throw new RelayRegistryError("invalid_state", "Generation transition window identity changed before termination");
				}
				this.options.server.sendToConversation({ protocolVersion: "1.0.0", messageId: `relay-generation-${randomBytes(8).toString("hex")}`,
					conversationId, role: "relay", type: "termination.request", payload: { reason: "generation_change" } });
				if (inspectedWindow) await this.invoke("window-terminate", { conversationId, windowId: inspectedWindow.windowId, paneId: inspectedWindow.paneId });
				await this.options.registry.setManagedWindow(conversationId, null);
				await this.launchProject(manifest, randomBytes(32).toString("base64url"), sessionFile);
			}
			await this.options.registry.markGenerationAttached(conversationId, transitionId);
			transition = this.options.registry.generationTransitions().find((item) => item.conversationId === conversationId)?.transition;
			await this.options.projectNotice?.(`${transitionId}:completed`, manifest,
				`Fresh Pi session generation ${transition?.ordinal ?? this.options.registry.activeGeneration(manifest).ordinal} is active. Your next message will be its first prompt.`);
			await this.options.registry.completeGenerationTransition(conversationId, transitionId);
			await this.options.generationReady?.(conversationId);
		} catch (error) {
			await this.options.registry.failGenerationTransition(conversationId, transitionId, error);
			manifest = this.projectManifest(conversationId);
			await this.options.projectNotice?.(`${transitionId}:failed`, manifest,
				"Fresh Pi session generation failed to activate. The room and prior Pi session files remain preserved; recovery will retry deterministically.").catch(() => undefined);
			throw error;
		}
	}

	private async workspaceList(): Promise<Array<{ rootKey: string; workspace: string }>> {
		const result = await this.invoke("workspace-list", {});
		if (!Array.isArray(result.workspaces) || result.workspaces.some((item) => typeof item !== "object" || item === null ||
			typeof (item as Record<string, unknown>).rootKey !== "string" || typeof (item as Record<string, unknown>).workspace !== "string")) {
			throw new RelayRegistryError("launch_failed", "Workspace launcher returned an invalid list");
		}
		return result.workspaces as Array<{ rootKey: string; workspace: string }>;
	}

	private status(conversationId: string): Record<string, unknown> {
		this.options.registry.manifestByConversationId(conversationId) ?? (() => { throw new RelayRegistryError("not_found", "Managed conversation was not found"); })();
		return { operation: "conversation.status", targetConversationId: conversationId, conversationState: this.options.registry.conversationState(conversationId) };
	}

	private createProject(request: { creationKey: string; rootKey: string; workspace: string; concept: string }): Promise<Record<string, unknown>> {
		const conversationId = deriveConversationId(this.options.hostId, request.creationKey);
		const inProgress = this.creations.get(conversationId); if (inProgress) return inProgress;
		const creation = this.createProjectOnce(request).finally(() => { if (this.creations.get(conversationId) === creation) this.creations.delete(conversationId); });
		this.creations.set(conversationId, creation); return creation;
	}

	private async createProjectOnce(request: { creationKey: string; rootKey: string; workspace: string; concept: string }): Promise<Record<string, unknown>> {
		const placement: WorkspaceIdentity = { rootKey: request.rootKey, workspace: request.workspace, relativeCwd: "" };
		const conversationId = deriveConversationId(this.options.hostId, request.creationKey);
		const existing = this.options.registry.manifestByCreationKey(request.creationKey);
		if (existing && (existing.kind !== "project" || existing.conversationId !== conversationId || existing.concept !== request.concept ||
			JSON.stringify(existing.placement) !== JSON.stringify(placement))) throw new RelayRegistryError("invalid_state", "Project creation retry conflicts with existing identity");
		if (!existing && this.options.registry.listManifests().some((item) => item.concept === request.concept)) {
			throw new RelayRegistryError("invalid_state", "Managed conversation concept already exists on this host");
		}
		const intentPath = join(resolve(this.options.projectSessionDirectory), conversationId, "project-creation.json");
		const intentFile = new AtomicJsonFile(intentPath, parseProjectCreationIntent);
		let intent = await intentFile.read(); const retry = intent !== undefined;
		if (intent) { const info = await lstat(intentPath); if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 ||
			(process.getuid?.() !== undefined && info.uid !== process.getuid!())) throw new RelayRegistryError("invalid_state", "Existing project creation intent is not a private relay-user file"); }
		const expectedIntent = { creationKey: request.creationKey, rootKey: request.rootKey, workspace: request.workspace, concept: request.concept };
		if (intent) {
			for (const [key, value] of Object.entries(expectedIntent)) if ((intent as unknown as Record<string, unknown>)[key] !== value) throw new RelayRegistryError("invalid_state", "Project creation retry conflicts with its durable intent");
		} else { intent = { ...expectedIntent, sessionPersisted: false }; await intentFile.write(intent); }
		const created = await this.invoke("project-create", { rootKey: request.rootKey, workspace: request.workspace,
			creationKey: request.creationKey, resumeExisting: retry });
		const expectedFields = new Set(["rootKey", "workspace", "relativeCwd", "workspacePath", "cwd", "projectKey", "projectDisplayName", "checkoutDisplayName"]);
		if (created.rootKey !== request.rootKey || created.workspace !== request.workspace || created.relativeCwd !== "" ||
			typeof created.workspacePath !== "string" || !isAbsolute(created.workspacePath) || created.cwd !== created.workspacePath || !hasValidProjectIdentity(created) ||
			Object.keys(created).some((field) => !expectedFields.has(field))) throw new RelayRegistryError("launch_failed", "Project launcher returned an invalid created workspace");
		const creationIdentity = { projectKey: created.projectKey, projectDisplayName: created.projectDisplayName, checkoutDisplayName: created.checkoutDisplayName };
		if (intent.projectKey) {
			for (const [key, value] of Object.entries(creationIdentity)) if ((intent as unknown as Record<string, unknown>)[key] !== value) throw new RelayRegistryError("invalid_state", "Project creation retry changed its host-resolved project identity");
		} else { intent = { ...intent, ...creationIdentity }; await intentFile.write(intent); }
		const sessionFile = join(resolve(this.options.projectSessionDirectory), conversationId, "session.jsonl");
		await durableProjectSession(sessionFile, created.cwd, conversationId, request.creationKey, request.concept);
		if (!intent.sessionPersisted) { intent = { ...intent, sessionPersisted: true }; await intentFile.write(intent); }
		const roomAliasKey = conversationId.slice(5); const projectAliasKey = created.projectKey.slice("project_".length);
		if (!intent.projectSpaceId) { intent = { ...intent, projectSpaceId: await this.options.matrix.createPrivateSpaceIdempotent(created.projectDisplayName, `pi-${projectAliasKey}-space`) }; await intentFile.write(intent); }
		const projectSpaceId = intent.projectSpaceId;
		if (!projectSpaceId) throw new RelayRegistryError("invalid_state", "Project creation Space identity is unavailable");
		const coordinator = this.options.registry.listManifests().find((item) => item.kind === "coordinator");
		if (!intent.hostSpaceLinked) { if (coordinator?.kind === "coordinator" && coordinator.hostSpace) await this.options.matrix.addSpaceChild(coordinator.hostSpace, projectSpaceId); intent = { ...intent, hostSpaceLinked: true }; await intentFile.write(intent); }
		if (!intent.roomId) { intent = { ...intent, roomId: await this.options.matrix.createPrivateRoomIdempotent(`pi · ${created.checkoutDisplayName} · ${request.concept}`, `pi-${roomAliasKey}-room`) }; await intentFile.write(intent); }
		const roomId = intent.roomId;
		if (!roomId) throw new RelayRegistryError("invalid_state", "Project creation room identity is unavailable");
		if (!intent.roomLinked) { await this.options.matrix.addSpaceChild(projectSpaceId, roomId); intent = { ...intent, roomLinked: true }; await intentFile.write(intent); }
		await this.start({ creationKey: request.creationKey, concept: request.concept, placement },
			{ projectSpace: projectSpaceId, roomId, ...creationIdentity });
		const manifest = this.options.registry.manifestByCreationKey(request.creationKey);
		if (!manifest || manifest.kind !== "project" || manifest.roomId.length > 255) throw new RelayRegistryError("invalid_state", "Created project conversation is unavailable");
		const roomLink = `https://matrix.to/#/${encodeURIComponent(manifest.roomId)}`;
		if (roomLink.length > 512) throw new RelayRegistryError("invalid_state", "Created project room link exceeded its bound");
		return { operation: "project.create", targetConversationId: manifest.conversationId,
			conversationState: this.options.registry.conversationState(manifest.conversationId), roomLink };
	}

	private async start(request: { creationKey: string; concept: string; placement: WorkspaceIdentity },
		provisioned?: { projectSpace: string; roomId: string; projectKey: string; projectDisplayName: string; checkoutDisplayName: string }): Promise<Record<string, unknown>> {
		const conversationId = deriveConversationId(this.options.hostId, request.creationKey);
		const existing = this.options.registry.manifestByCreationKey(request.creationKey);
		if (existing) {
			if (existing.kind !== "project" || existing.conversationId !== conversationId || existing.concept !== request.concept ||
				JSON.stringify(existing.placement) !== JSON.stringify(request.placement)) throw new RelayRegistryError("invalid_state", "Conversation start retry conflicts with existing identity");
			await this.resume(existing.conversationId);
			return { operation: "conversation.start", targetConversationId: existing.conversationId, conversationState: this.options.registry.conversationState(existing.conversationId) };
		}
		if (this.options.registry.listManifests().some((item) => item.concept === request.concept)) throw new RelayRegistryError("invalid_state", "Managed conversation concept already exists on this host");
		const resolved = await this.resolveWorkspaceIdentity(request.placement);
		await this.invoke("root-ensure", request.placement);
		const sessionFile = join(resolve(this.options.projectSessionDirectory), conversationId, "session.jsonl");
		const session = await durableProjectSession(sessionFile, resolved.cwd, conversationId, request.creationKey, request.concept);
		const identity = provisioned ?? resolved;
		const matrixBinding = provisioned ?? await this.provisionConversationMatrix(conversationId, request.concept, resolved);
		const { projectSpace, roomId } = matrixBinding;
		const nonce = randomBytes(32).toString("base64url");
		const createdAt = new Date().toISOString(); const generationId = deriveGenerationId(conversationId, 1);
		const manifest: ConversationManifest = {
			schemaVersion: MANAGED_SESSION_STATE_VERSION, kind: "project", conversationId, ownerHostId: this.options.hostId,
			creationKey: request.creationKey, concept: request.concept, piSessionId: session.sessionId, roomId,
			placement: request.placement, projectKey: identity.projectKey, projectDisplayName: identity.projectDisplayName,
			checkoutDisplayName: identity.checkoutDisplayName, projectSpace, bindingBoundaryEntryId: session.boundaryEntryId, createdAt,
			activeGenerationId: generationId, generations: [{ generationId, ordinal: 1, piSessionId: session.sessionId, bindingBoundaryEntryId: session.boundaryEntryId, createdAt }],
		};
		await this.options.registry.createProjectConversation(manifest, nonce);
		await this.launchProject(manifest, nonce, sessionFile);
		return { operation: "conversation.start", targetConversationId: conversationId, conversationState: this.options.registry.conversationState(conversationId) };
	}

	private async resume(conversationId: string): Promise<Record<string, unknown>> {
		const manifest = this.projectManifest(conversationId);
		await this.invoke("root-ensure", manifest.placement!);
		if (this.options.registry.conversationState(conversationId) !== "active") await this.launchProject(manifest);
		return { operation: "conversation.resume", targetConversationId: conversationId, conversationState: this.options.registry.conversationState(conversationId) };
	}

	private async stop(conversationId: string): Promise<Record<string, unknown>> {
		this.projectManifest(conversationId);
		const window = this.options.registry.managedWindow(conversationId);
		if (!window) throw new RelayRegistryError("invalid_state", "Active managed conversation has no exact window identity");
		const commandFeedback = this.options.registry.pendingInputs(conversationId).filter((input) => input.kind === "prompt" && input.body?.startsWith("/")).map((input) => input.deliveryId);
		await this.options.registry.cancelPendingInputs(conversationId);
		for (const operationId of commandFeedback) await this.options.endOperationFeedback?.(conversationId, operationId);
		this.options.server.sendToConversation({ protocolVersion: "1.0.0", messageId: `relay-stop-${randomBytes(8).toString("hex")}`,
			conversationId, role: "relay", type: "termination.request", payload: { reason: "stop" } });
		await this.invoke("window-terminate", { conversationId, windowId: window.windowId, paneId: window.paneId });
		await this.options.registry.setManagedWindow(conversationId, null);
		for (let attempt = 0; attempt < 20 && this.options.registry.conversationState(conversationId) !== "dormant"; attempt += 1) {
			await new Promise((resolveWait) => setTimeout(resolveWait, 50));
		}
		if (this.options.registry.conversationState(conversationId) !== "dormant") {
			throw new RelayRegistryError("invalid_state", "Managed adapter did not disconnect after exact window termination");
		}
		return { operation: "conversation.stop", targetConversationId: conversationId, conversationState: "dormant" };
	}

	private async delete(conversationId: string): Promise<Record<string, unknown>> {
		const manifest = this.projectManifest(conversationId);
		this.options.server.sendToConversation({ protocolVersion: "1.0.0", messageId: `relay-delete-${randomBytes(8).toString("hex")}`,
			conversationId, role: "relay", type: "termination.request", payload: { reason: "bridge_delete" } });
		const window = this.options.registry.managedWindow(conversationId);
		await this.invoke("bridge-clear", { conversationId, ...(window ? { windowId: window.windowId, paneId: window.paneId } : {}) });
		const deleted = await this.options.registry.deleteConversation(conversationId);
		try { await this.options.matrix.leaveRoom(manifest.roomId); }
		catch (error) { await this.options.registry.restoreDeletedConversation(deleted); throw error; }
		return { operation: "conversation.delete", targetConversationId: conversationId };
	}

	private projectManifest(conversationId: string): ConversationManifest {
		const manifest = this.options.registry.manifestByConversationId(conversationId);
		if (!manifest) throw new RelayRegistryError("not_found", "Managed conversation was not found");
		if (manifest.kind !== "project") throw new RelayRegistryError("permission_denied", "Coordinator lifecycle cannot modify the guaranteed coordinator");
		return manifest;
	}

	private async launchProject(manifest: ConversationManifest, existingNonce?: string, existingSessionFile?: string): Promise<void> {
		const inProgress = this.launches.get(manifest.conversationId);
		if (inProgress) return inProgress;
		const launch = this.launchProjectOnce(manifest, existingNonce, existingSessionFile)
			.finally(() => { if (this.launches.get(manifest.conversationId) === launch) this.launches.delete(manifest.conversationId); });
		this.launches.set(manifest.conversationId, launch);
		return launch;
	}

	private async launchProjectOnce(manifest: ConversationManifest, existingNonce?: string, existingSessionFile?: string): Promise<void> {
		if (manifest.kind !== "project" || !manifest.placement) throw new RelayRegistryError("invalid_state", "Project launch requires project placement");
		const nonce = existingNonce ?? randomBytes(32).toString("base64url");
		const activeGeneration = this.options.registry.activeGeneration(manifest);
		const sessionFile = existingSessionFile ?? join(resolve(this.options.projectSessionDirectory), manifest.conversationId,
			activeGeneration.ordinal === 1 ? "session.jsonl" : `generation-${activeGeneration.ordinal}.jsonl`);
		const resolved = await this.invoke("workspace-resolve", manifest.placement);
		if (typeof resolved.cwd !== "string" || !isAbsolute(resolved.cwd) || typeof resolved.workspacePath !== "string" || !isAbsolute(resolved.workspacePath)) throw new RelayRegistryError("launch_failed", "Workspace launcher omitted canonical workspace paths");
		const root = await this.invoke("root-ensure", manifest.placement);
		if (typeof root.sessionName !== "string" || !root.sessionName) throw new RelayRegistryError("launch_failed", "Root launcher omitted its tmux session name");
		const session = await durableProjectSession(sessionFile, resolved.cwd, manifest.conversationId, manifest.creationKey, manifest.concept, activeGeneration.ordinal);
		if (session.sessionId !== manifest.piSessionId || session.boundaryEntryId !== manifest.bindingBoundaryEntryId) {
			throw new RelayRegistryError("invalid_state", "Project Pi session identity conflicts with the conversation manifest");
		}
		await this.options.registry.beginLaunch(manifest.conversationId);
		try {
			const inspected = this.parseWindowInspection(await this.invoke("window-inspect", { conversationId: manifest.conversationId }), manifest, root.sessionName);
			let window: ManagedWindow;
			if (inspected) {
				window = inspected;
			} else {
				await this.options.registry.setAttachmentNonce(manifest.conversationId, nonce);
				const result = await this.invoke("window-create", { conversationId: manifest.conversationId, placement: manifest.placement }, {
					PI_MANAGED_SESSION_LAUNCH_ROLE: "project", PI_MANAGED_SESSIONS_SOCKET: this.options.socketPath,
					PI_MANAGED_SESSION_CONVERSATION_ID: manifest.conversationId, PI_MANAGED_SESSION_CONCEPT: manifest.concept,
					PI_MANAGED_SESSION_BINDING_BOUNDARY_ENTRY_ID: manifest.bindingBoundaryEntryId,
					PI_MANAGED_SESSION_ATTACHMENT_NONCE: nonce, PI_MANAGED_PROJECT_SESSION_FILE: sessionFile,
					PI_MANAGED_SESSION_WORKSPACE_PATH: resolved.workspacePath,
					...((manifest.selectedModel ?? activeGeneration.model) ? { PI_MANAGED_SESSION_MODEL: manifest.selectedModel ?? activeGeneration.model } : {}),
					...((manifest.selectedThinking ?? activeGeneration.thinking) ? { PI_MANAGED_SESSION_THINKING: manifest.selectedThinking ?? activeGeneration.thinking } : {}),
				});
				window = parseProjectWindow(result, manifest);
			}
			await this.options.registry.setManagedWindow(manifest.conversationId, {
				sessionName: window.sessionName, windowId: window.windowId, paneId: window.paneId,
			});
			for (let attempt = 0; attempt < 100 && this.options.registry.conversationState(manifest.conversationId) !== "active"; attempt += 1) {
				await new Promise((resolveWait) => setTimeout(resolveWait, 100));
			}
			if (this.options.registry.conversationState(manifest.conversationId) !== "active") {
				throw new RelayRegistryError("launch_failed", "Managed project Pi attachment timed out");
			}
		} catch (error) {
			await this.invoke("window-terminate", { conversationId: manifest.conversationId }).catch(() => undefined);
			await this.options.registry.markDormant(manifest.conversationId, true);
			await this.options.registry.recordLaunchError(manifest.conversationId, "launch_failed", error instanceof Error ? error.message : "Project launch failed");
			throw error;
		}
	}

	private parseWindowInspection(result: Record<string, unknown>, manifest: ConversationManifest, expectedSessionName: string): ManagedWindow | undefined {
		if (result.conversationId !== manifest.conversationId || typeof result.exists !== "boolean") {
			throw new RelayRegistryError("launch_failed", "Managed window inspection returned invalid identity");
		}
		if (!result.exists) {
			if (Object.keys(result).some((key) => !["conversationId", "exists"].includes(key))) {
				throw new RelayRegistryError("launch_failed", "Managed window inspection returned invalid absence");
			}
			return undefined;
		}
		if (result.sessionName !== expectedSessionName || typeof result.windowId !== "string" || !/^@[0-9]+$/.test(result.windowId) ||
			typeof result.paneId !== "string" || !/^%[0-9]+$/.test(result.paneId) ||
			Object.keys(result).some((key) => !["conversationId", "exists", "sessionName", "windowId", "paneId"].includes(key))) {
			throw new RelayRegistryError("launch_failed", "Managed window inspection returned invalid window identity");
		}
		const placement = manifest.placement!;
		return {
			conversationId: manifest.conversationId, sessionName: result.sessionName, windowId: result.windowId, paneId: result.paneId,
			rootKey: placement.rootKey, workspace: placement.workspace, relativeCwd: placement.relativeCwd, role: "conversation",
		} as ManagedWindow;
	}

	private async invoke(operation: string, request: object, extraEnvironment: NodeJS.ProcessEnv = {}): Promise<Record<string, unknown>> {
		const environment = { ...this.options.environment, ...extraEnvironment };
		for (const key of Object.keys(environment)) if (key.startsWith("PI_MATRIX_")) delete environment[key];
		const child = spawn(this.options.launcher, ["managed", operation], { stdio: ["pipe", "pipe", "pipe"], env: environment });
		child.stdin.end(`${JSON.stringify(request)}\n`);
		let stdout = ""; let bytes = 0;
		child.stdout.setEncoding("utf8"); child.stderr.resume();
		child.stdout.on("data", (chunk: string) => { bytes += Buffer.byteLength(chunk); if (bytes > 64 * 1024) child.kill("SIGKILL"); else stdout += chunk; });
		const code = await new Promise<number | null>((resolveCode, reject) => {
			const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new RelayRegistryError("launch_failed", `Managed ${operation} timed out`)); }, 15_000);
			child.once("error", () => { clearTimeout(timer); reject(new RelayRegistryError("launch_failed", `Managed ${operation} could not start`)); });
			child.once("close", (status) => { clearTimeout(timer); resolveCode(status); });
		});
		if (code !== 0) throw new RelayRegistryError("launch_failed", `Managed ${operation} failed`);
		return safeJsonObject(stdout, `Managed ${operation} returned invalid JSON`);
	}
}
