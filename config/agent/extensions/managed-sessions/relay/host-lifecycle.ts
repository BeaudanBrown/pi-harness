import { createHash, randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { parseExactWindowProof, assertExactWindowBinding, type ExactWindowProof } from "../exact-window-contracts.js";
import { ExactWindowClient } from "./exact-window-client.js";
import { launchCoordinator as ensureCoordinatorWindow } from "./coordinator-launcher.js";
import type { RetirementRecord } from "./retirement-store.js";
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { chmod, copyFile, lstat, open, readFile, readdir, rename, rm, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
	MANAGED_SESSION_STATE_VERSION,
	deriveConversationId,
	deriveGenerationId,
	deriveTranscriptEntryId,
	type ConversationManifest,
	type PendingLocalConversation,
	type RegisteredConversation,
	hasMatrixBinding,
	type ManagedSessionEnvelope,
	type WorkspaceIdentity,
} from "../contracts.js";
import { deriveCheckoutId } from "../managed-provenance.js";
import { parseHostAction, type HostAction, type HostResult } from "../live-workspace-contracts.js";
import type { FrozenJson } from "./host-approval-record.js";
import { AtomicJsonFile, ensurePrivateDirectory } from "./atomic-json.js";
import { ManagedSessionIpcServer } from "./ipc-server.js";
import { ManagedMatrixClient } from "./matrix-client.js";
import { ProjectReconciler, type SpaceCleanupAccount, type LiveSpacePreview } from "./project-reconciliation.js";
import { ProjectSpaces } from "./project-spaces.js";
import { LiveHierarchy } from "./live-hierarchy.js";
import { RelayRegistry, RelayRegistryError } from "./registry.js";

export const PROJECT_ATTACHMENT_TIMEOUT_MS = 60_000;

export async function waitForProjectAttachment(options: {
	timeoutMs: number;
	state: () => "active" | string;
	inspectWindow: () => Promise<boolean>;
	now?: () => number;
	sleep?: (milliseconds: number) => Promise<void>;
	inspectionIntervalMs?: number;
}): Promise<"attached" | "exited" | "timeout"> {
	const now = options.now ?? Date.now;
	const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>((resolveWait) => setTimeout(resolveWait, milliseconds)));
	const deadline = now() + options.timeoutMs;
	let nextInspection = now() + (options.inspectionIntervalMs ?? 1_000);
	while (options.state() !== "active" && now() < deadline) {
		await sleep(Math.min(100, Math.max(1, deadline - now())));
		if (options.state() === "active") return "attached";
		if (now() >= nextInspection) {
			const live = await options.inspectWindow();
			if (options.state() === "active") return "attached";
			if (!live) return "exited";
			nextInspection = now() + (options.inspectionIntervalMs ?? 1_000);
		}
	}
	if (options.state() === "active") return "attached";
	const live = await options.inspectWindow();
	if (options.state() === "active") return "attached";
	return live ? "timeout" : "exited";
}

export interface ManagedWindow {
	ownership?: ExactWindowProof;
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

export interface TerminalBindingInput {
	creationKey: string; concept: string; sessionId: string; attachmentNonce: string;
	bindingBoundaryEntryId: string; sourceCwd: string; sourceSessionFile: string;
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
	const fields = new Set(["conversationId", "sessionName", "windowId", "paneId", "role", "rootKey", "workspace", "relativeCwd", "ownership"]);
	if (Object.keys(result).some((field) => !fields.has(field))) throw new RelayRegistryError("launch_failed", "Project launcher returned unexpected fields");
	const ownership = result.ownership === undefined ? undefined : parseExactWindowProof(result.ownership);
	assertExactWindowBinding(manifest.conversationId, { sessionName: result.sessionName, windowId: result.windowId, paneId: result.paneId, ownership });
	return {
		...(ownership ? { ownership } : {}),
		conversationId: manifest.conversationId, sessionName: result.sessionName, windowId: result.windowId, paneId: result.paneId,
		rootKey: placement.rootKey, workspace: placement.workspace, relativeCwd: placement.relativeCwd, role: "conversation",
	};
}

interface MatrixConversationBinding { roomId: string; projectSpace: string; checkoutId?: string; checkoutSpace?: string }
type ProvisionedProject = MatrixConversationBinding & Pick<ResolvedWorkspace, "projectKey" | "projectDisplayName" | "checkoutDisplayName">;

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
	liveHierarchy?: true;
	creationKey: string; rootKey: string; workspace: string; concept: string; projectSpace?: string;
	projectKey?: string; projectDisplayName?: string; checkoutDisplayName?: string;
	sessionPersisted: boolean; projectSpaceId?: string; hostSpaceLinked?: boolean; roomId?: string; roomLinked?: boolean;
}

interface BranchPlan {
	rootKey: string; projectWorkspace: string; commonDir: string; mainPath: string;
	branch: string; head: string; mergeTarget: string; mergeCommit: string;
}

interface WorktreePlan {
	rootKey: string; sourceWorkspace: string; projectWorkspace: string; targetWorkspace: string; commonDir: string; mainPath: string;
	targetPath: string; baseRef: string; baseCommit: string; branch: string;
}

type CreationAction = Extract<HostAction, { operation: "project.create" | "conversation.create" | "worktree.create" | "worktree.conversation.create" }>;
interface FrozenWorktreeCreation { intent?: WorktreeCreationIntent; plan?: WorktreePlan }

interface WorktreeCreationIntent extends WorktreePlan {
	creationKey: string; requestedBaseRef: string; worktreeKey: string; phase: "planned" | "created"; concept?: string; conversationCreationKey?: string;
}

interface WorktreeRemovalIntent {
	removalKey: string; rootKey: string; workspace: string; projectWorkspace: string; path: string; commonDir: string; mainPath: string;
	branch: string; head: string; clean: boolean; locked: boolean; mergeTarget?: string; mergeCommit?: string; merged?: boolean;
	targetConversationId?: string; phase: "planned" | "stopped" | "removed" | "bridge_deleted" | "branch_deleted";
}

function boundedHostString(item: Record<string, unknown>, field: string, max = 4096): string {
	const value = item[field];
	if (typeof value !== "string" || value.length < 1 || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
		throw new RelayRegistryError("invalid_state", `Managed worktree ${field} is malformed`);
	}
	return value;
}

function parseWorktreePlan(value: unknown): WorktreePlan {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new RelayRegistryError("invalid_state", "Managed worktree plan is malformed");
	const item = value as Record<string, unknown>;
	const fields = ["rootKey", "sourceWorkspace", "projectWorkspace", "targetWorkspace", "commonDir", "mainPath", "targetPath", "baseRef", "baseCommit", "branch"];
	if (Object.keys(item).some((key) => !fields.includes(key))) throw new RelayRegistryError("invalid_state", "Managed worktree plan has unexpected fields");
	const result = Object.fromEntries(fields.map((field) => [field, boundedHostString(item, field, field.endsWith("Path") || field === "commonDir" ? 4096 : 255)])) as unknown as WorktreePlan;
	if (!/^refs\/(heads|remotes|tags)\//.test(result.baseRef) || !/^[a-f0-9]{40,64}$/.test(result.baseCommit) ||
		![result.rootKey, result.sourceWorkspace, result.projectWorkspace, result.targetWorkspace].every((field) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(field)) ||
		![result.commonDir, result.mainPath, result.targetPath].every(isAbsolute)) throw new RelayRegistryError("invalid_state", "Managed worktree plan identity is invalid");
	return result;
}

function parseWorktreeCreationIntent(value: unknown): WorktreeCreationIntent {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new RelayRegistryError("invalid_state", "Managed worktree creation intent is malformed");
	const item = value as Record<string, unknown>;
	const planFields = ["rootKey", "sourceWorkspace", "projectWorkspace", "targetWorkspace", "commonDir", "mainPath", "targetPath", "baseRef", "baseCommit", "branch"];
	const plan = parseWorktreePlan(Object.fromEntries(planFields.map((field) => [field, item[field]])));
	const allowed = new Set([...planFields, "creationKey", "requestedBaseRef", "worktreeKey", "phase", "concept", "conversationCreationKey"]);
	if (Object.keys(item).some((key) => !allowed.has(key)) || !/^worktree_[a-f0-9]{32}$/.test(String(item.worktreeKey)) ||
		!["planned", "created"].includes(String(item.phase)) || typeof item.creationKey !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(item.creationKey) ||
		typeof item.requestedBaseRef !== "string" || item.requestedBaseRef.length > 255 || typeof item.worktreeKey !== "string" ||
		[item.concept, item.conversationCreationKey].some((field) => field !== undefined && (typeof field !== "string" || field.length < 1 || field.length > 128 || /[\u0000-\u001f\u007f]/.test(field)))) {
		throw new RelayRegistryError("invalid_state", "Managed worktree creation intent is malformed");
	}
	return { ...plan, creationKey: String(item.creationKey), requestedBaseRef: String(item.requestedBaseRef), worktreeKey: String(item.worktreeKey), phase: item.phase as WorktreeCreationIntent["phase"],
		...(item.concept ? { concept: String(item.concept) } : {}), ...(item.conversationCreationKey ? { conversationCreationKey: String(item.conversationCreationKey) } : {}) };
}

function parseWorktreeRemovalIntent(value: unknown): WorktreeRemovalIntent {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new RelayRegistryError("invalid_state", "Managed worktree removal intent is malformed");
	const item = value as Record<string, unknown>;
	const required = ["removalKey", "rootKey", "workspace", "projectWorkspace", "path", "commonDir", "mainPath", "branch", "head", "phase"];
	const optional = ["clean", "locked", "mergeTarget", "mergeCommit", "merged", "targetConversationId"];
	if (Object.keys(item).some((key) => ![...required, ...optional].includes(key)) || required.some((field) => typeof item[field] !== "string") ||
		!/^worktree_remove_[a-f0-9]{32}$/.test(String(item.removalKey)) || !["planned", "stopped", "removed", "bridge_deleted", "branch_deleted"].includes(String(item.phase)) ||
		typeof item.clean !== "boolean" || typeof item.locked !== "boolean" || (item.merged !== undefined && typeof item.merged !== "boolean") ||
		![item.rootKey, item.workspace, item.projectWorkspace].every((field) => typeof field === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(field)) ||
		![item.path, item.commonDir, item.mainPath].every((field) => typeof field === "string" && field.length <= 4096 && isAbsolute(field)) ||
		typeof item.branch !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/@+/-]{0,254}$/.test(item.branch) || typeof item.head !== "string" || !/^[a-f0-9]{40,64}$/.test(item.head) ||
		[item.mergeTarget, item.mergeCommit, item.merged].some((field) => field !== undefined) && [item.mergeTarget, item.mergeCommit, item.merged].some((field) => field === undefined) ||
		(item.mergeTarget !== undefined && (typeof item.mergeTarget !== "string" || !/^refs\/(heads|remotes|tags)\//.test(item.mergeTarget))) ||
		(item.mergeCommit !== undefined && (typeof item.mergeCommit !== "string" || !/^[a-f0-9]{40,64}$/.test(item.mergeCommit))) ||
		(item.targetConversationId !== undefined && (typeof item.targetConversationId !== "string" || !/^conv_[a-f0-9]{32}$/.test(item.targetConversationId)))) {
		throw new RelayRegistryError("invalid_state", "Managed worktree removal intent is malformed");
	}
	return item as unknown as WorktreeRemovalIntent;
}

function lifecycleDigest(domain: string, ...parts: string[]): string {
	const hash = createHash("sha256").update(`pi-managed-sessions:${domain}:v1\0`);
	for (const part of parts) hash.update(`${Buffer.byteLength(part)}:`).update(part);
	return hash.digest("hex").slice(0, 32);
}

function parseProjectCreationIntent(value: unknown): ProjectCreationIntent {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new RelayRegistryError("invalid_state", "Project creation intent is malformed");
	const item = value as Record<string, unknown>;
	const allowed = new Set(["liveHierarchy", "creationKey", "rootKey", "workspace", "concept", "projectSpace", "projectKey", "projectDisplayName", "checkoutDisplayName", "sessionPersisted", "projectSpaceId", "hostSpaceLinked", "roomId", "roomLinked"]);
	if (Object.keys(item).some((key) => !allowed.has(key)) || ![item.creationKey, item.rootKey, item.workspace, item.concept].every((field) => typeof field === "string" && field.length > 0 && field.length <= 128 && !/[\u0000-\u001f\u007f]/.test(field)) ||
		(item.liveHierarchy !== undefined && item.liveHierarchy !== true) || typeof item.sessionPersisted !== "boolean" || (item.projectSpace !== undefined && (typeof item.projectSpace !== "string" || item.projectSpace.length < 1 || item.projectSpace.length > 128)) ||
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

async function ensureWorktreeIntentCapacity(directory: string): Promise<void> {
	const path = await ensurePrivateDirectory(directory);
	const entries = await readdir(path);
	if (entries.filter((entry) => entry.endsWith(".json")).length >= 1_024) throw new RelayRegistryError("capacity_reached", "Managed worktree lifecycle intent capacity was reached");
}

async function readPrivateIntent<T>(file: AtomicJsonFile<T>): Promise<T | undefined> {
	const value = await file.read(); if (value === undefined) return undefined;
	const info = await lstat(file.path);
	if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || (process.getuid?.() !== undefined && info.uid !== process.getuid!())) {
		throw new RelayRegistryError("invalid_state", "Managed lifecycle intent is not a private relay-user file");
	}
	return value;
}

async function durableProjectSession(path: string, cwd: string, conversationId: string, creationKey: string, concept: string, ordinal = 1, mustExist = false): Promise<{ sessionId: string; boundaryEntryId: string }> {
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
		if (mustExist) throw new RelayRegistryError("invalid_state", "The persisted Pi session file is unavailable");
	}
	const directory = await ensurePrivateDirectory(dirname(path));
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
	private readonly launches = new Map<string, { window: Promise<void>; ready: Promise<void> }>();
	private readonly creations = new Map<string, Promise<Record<string, unknown>>>();
	private readonly worktreeOperations = new Map<string, { identity?: string; promise: Promise<unknown> }>();
	private readonly provisions = new Map<string, { identity: string; promise: Promise<MatrixConversationBinding> }>();
	private readonly promotions = new Map<string, Promise<void>>();
	private readonly generationRetries = new Map<string, NodeJS.Timeout>();
	private readonly refreshWaiters = new Map<string, { refreshId: string; resolve: (ready: boolean) => void }>();
	private runtimeUpdateRunning = false;
	private runtimeUpdatesStopped = false;
	stopRuntimeUpdates(): void { this.runtimeUpdatesStopped = true; }

	async reconcileRuntimeUpdates(runtimeId: string): Promise<void> {
		if (this.runtimeUpdateRunning || this.runtimeUpdatesStopped) return;
		this.runtimeUpdateRunning = true;
		try {
			for (const manifest of this.options.registry.listManifests()) {
				if (this.runtimeUpdatesStopped) break;
				if (manifest.kind !== "project" || !manifest.placement) continue;
				const runtime = this.options.registry.snapshot().conversations.find((item) => item.conversationId === manifest.conversationId);
				// Never wake dormant work or infer that an unknown/disconnected process
				// is idle. Refresh itself holds delivery and obtains live idle consent.
				if (!runtime?.attachment || runtime.state !== "active" || runtime.attachment.runtimeId === runtimeId ||
					!this.options.registry.managedWindow(manifest.conversationId) || runtime.pendingControls.length ||
					this.options.registry.hasGenerationBoundary(manifest.conversationId) || this.options.registry.isRefreshing(manifest.conversationId)) continue;
				try { await this.refresh(manifest.conversationId, { attachmentId: runtime.attachment.attachmentId, desiredRuntimeId: runtimeId }); }
				catch { /* Busy, unknown and failed launches remain pending; retry on the next bounded poll. */ }
			}
		} finally { this.runtimeUpdateRunning = false; }
	}
	private readonly reconciler: ProjectReconciler;
	private readonly projectSpaces: ProjectSpaces;
	readonly exactWindows: Pick<ExactWindowClient, "inspect" | "check" | "terminate">;

	constructor(private readonly options: {
		hostId: string;
		launcher: string;
		projectSessionDirectory: string;
		socketPath: string;
		registry: RelayRegistry;
		matrix: ManagedMatrixClient;
		hierarchy?: LiveHierarchy;
		spaceCleanupAccount?: SpaceCleanupAccount;
		server: ManagedSessionIpcServer;
		environment?: NodeJS.ProcessEnv;
		projectNotice?: (sourceId: string, manifest: ConversationManifest, body: string) => Promise<void>;
		generationReady?: (conversationId: string) => Promise<void>;
		generationRetryMs?: number;
		attachmentTimeoutMs?: number;
		coordinator?: { launcher: string; sessionFile: string; workspaceDirectory: string };
		endOperationFeedback?: (conversationId: string, operationId: string) => Promise<void>;
		retireConversation?: (conversationId: string) => Promise<RetirementRecord>;
	}) {
		if (!isAbsolute(options.launcher)) throw new Error("Managed lifecycle launcher must be absolute");
		if (options.attachmentTimeoutMs !== undefined && (!Number.isSafeInteger(options.attachmentTimeoutMs) || options.attachmentTimeoutMs < 100 || options.attachmentTimeoutMs > 10 * 60_000)) {
			throw new Error("Managed lifecycle attachment timeout must be between 100ms and 10 minutes");
		}
		this.exactWindows = new ExactWindowClient((operation, request) => this.invoke(operation, request));
		this.projectSpaces = new ProjectSpaces(options.registry, options.matrix);
		this.reconciler = new ProjectReconciler({ registry: options.registry, matrix: options.matrix, intentDirectory: options.projectSessionDirectory,
			resolveWorkspace: (placement) => this.resolveWorkspaceIdentity(placement), hierarchy: options.hierarchy, account: options.spaceCleanupAccount });
	}

	pendingReconciliationCount(): number { return this.reconciler.pendingCount(); }
	spaceApprovalPreview(cleanup: boolean): Promise<LiveSpacePreview> { return this.reconciler.previewLive(cleanup); }
	executeSpaceApproval(snapshot: LiveSpacePreview, cleanup: boolean): Promise<{ remaining: number }> { return this.reconciler.applyLive(snapshot, cleanup); }

	async request(envelope: ManagedSessionEnvelope): Promise<Record<string, unknown>> {
		if (envelope.role !== "coordinator_adapter" || envelope.type !== "lifecycle.request") throw new RelayRegistryError("permission_denied", "Coordinator lifecycle capability is required");
		const request = envelope.payload.request as Record<string, unknown>;
		if (typeof request.targetConversationId === "string" && this.options.registry.isRefreshing(request.targetConversationId) && request.operation !== "conversation.status") {
			throw new RelayRegistryError("invalid_state", "Conversation refresh is already in progress");
		}
		switch (request.operation) {
			case "workspace.list": return { operation: "workspace.list", workspaces: await this.workspaceList() };
			case "worktree.list": return this.worktreeList(String(request.rootKey), String(request.workspace));
			case "worktree.create": return this.createWorktree(request as never, false);
			case "worktree.conversation.create": return this.createWorktree(request as never, true);
			case "worktree.remove.preview": return this.previewWorktreeRemoval(request as never);
			case "worktree.remove.apply":
				if (request.confirmed !== true) throw new RelayRegistryError("permission_denied", "Worktree removal requires explicit confirmation");
				return this.applyWorktreeRemoval(String(request.removalKey), false);
			case "worktree.conversation.cleanup.preview": return this.previewConversationCleanup(String(request.targetConversationId), request.mergeTarget === undefined ? undefined : String(request.mergeTarget));
			case "worktree.conversation.cleanup.apply":
				if (request.confirmed !== true) throw new RelayRegistryError("permission_denied", "Bundled worktree cleanup requires explicit confirmation");
				return this.applyWorktreeRemoval(String(request.removalKey), true);
			case "worktree.branch.delete":
				if (request.confirmed !== true) throw new RelayRegistryError("permission_denied", "Managed branch deletion requires separate explicit confirmation");
				return this.deleteWorktreeBranch(String(request.removalKey));
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
			case "conversation.refresh":
				if (request.confirmed !== true) throw new RelayRegistryError("permission_denied", "Refresh requires explicit confirmation");
				return this.refresh(String(request.targetConversationId));
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

	provisionConversationMatrix(conversationId: string, concept: string, resolved: ResolvedWorkspace, creationKey?: string): Promise<MatrixConversationBinding> {
		const identity = JSON.stringify([conversationId, concept, resolved.projectKey, resolved.rootKey, resolved.workspace, resolved.workspacePath, resolved.relativeCwd, creationKey]);
		const running = this.provisions.get(conversationId);
		if (running) {
			if (running.identity !== identity) return Promise.reject(new RelayRegistryError("invalid_state", "Concurrent provisioning changed its target"));
			return running.promise;
		}
		const provision = this.provisionConversationMatrixOnce(conversationId, concept, resolved, creationKey)
			.finally(() => { if (this.provisions.get(conversationId)?.promise === provision) this.provisions.delete(conversationId); });
		this.provisions.set(conversationId, { identity, promise: provision }); return provision;
	}

	private async provisionConversationMatrixOnce(conversationId: string, concept: string, resolved: ResolvedWorkspace, creationKey?: string): Promise<MatrixConversationBinding> {
		const intentPath = join(resolve(this.options.projectSessionDirectory), conversationId, "matrix-provisioning.json");
		const file = new AtomicJsonFile(intentPath, parseMatrixProvisioningIntent);
		let intent = await file.read(); const retry = intent !== undefined;
		if (this.options.hierarchy && (!intent || this.options.hierarchy.status(conversationId))) {
			if (!creationKey || deriveConversationId(this.options.hostId, creationKey) !== conversationId) throw new RelayRegistryError("invalid_state", "Hierarchy provisioning requires its exact creation identity");
			await this.options.hierarchy.prepare({ creationKey, projectKey: resolved.projectKey, canonicalCheckoutRoot: resolved.workspacePath,
				projectTitle: resolved.projectDisplayName, checkoutTitle: resolved.checkoutDisplayName, conversationTitle: concept });
			const { roomId, projectSpace, checkoutId, checkoutSpace } = await this.options.hierarchy.provision(conversationId);
			return { roomId, projectSpace, checkoutId, checkoutSpace };
		}
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
			intent = { ...intent, projectSpaceId: await this.projectSpaces.ensure(resolved.projectKey, resolved.projectDisplayName, retry) };
			await file.write(intent);
		} else await this.projectSpaces.assertTarget(resolved.projectKey, intent.projectSpaceId);
		const projectSpace = intent.projectSpaceId;
		if (!projectSpace) throw new RelayRegistryError("invalid_state", "Project Space identity is unavailable");
		const coordinator = this.options.registry.listManifests().find((item) => item.kind === "coordinator");
		if (!intent.hostSpaceLinked) { if (coordinator?.kind === "coordinator" && coordinator.hostSpace) await this.options.matrix.addSpaceChild(coordinator.hostSpace, projectSpace);
			intent = { ...intent, hostSpaceLinked: true }; await file.write(intent); }
		if (!intent.roomId) { intent = { ...intent, roomId: await this.options.matrix.createPrivateRoomIdempotent(
			`pi · ${resolved.checkoutDisplayName} · ${concept}`, `pi-${conversationId.slice(5)}-room`) }; await file.write(intent); }
		else if (await this.options.matrix.resolvePrivateRoomAlias(`pi-${conversationId.slice(5)}-room`, false) !== intent.roomId) {
			throw new RelayRegistryError("invalid_state", "Project room no longer matches its deterministic alias");
		}
		const roomId = intent.roomId;
		if (!roomId) throw new RelayRegistryError("invalid_state", "Project room identity is unavailable");
		if (!intent.roomLinked) { await this.options.matrix.addSpaceChild(projectSpace, roomId); intent = { ...intent, roomLinked: true }; await file.write(intent); }
		return { roomId, projectSpace };
	}

	private async inspectTerminalSource(input: TerminalBindingInput) {
		if (input.creationKey === "coordinator") throw new RelayRegistryError("permission_denied", "Coordinator identity is protected");
		const identified = await this.invoke("workspace-identify", { cwd: input.sourceCwd });
		const placement = { rootKey: identified.rootKey, workspace: identified.workspace, relativeCwd: identified.relativeCwd };
		if (![placement.rootKey, placement.workspace, placement.relativeCwd].every((value) => typeof value === "string") ||
			Object.keys(identified).some((field) => !["rootKey", "workspace", "relativeCwd", "cwd"].includes(field)) ||
			identified.cwd !== input.sourceCwd) throw new RelayRegistryError("launch_failed", "Workspace launcher could not identify the terminal Pi placement");
		const resolved = await this.resolveWorkspaceIdentity(placement as WorkspaceIdentity);
		if (resolved.cwd !== input.sourceCwd) throw new RelayRegistryError("invalid_state", "Terminal Pi cwd differs from its host-resolved placement");
		const conversationId = deriveConversationId(this.options.hostId, input.creationKey);
		const session = await durableProjectSession(input.sourceSessionFile, resolved.cwd, conversationId, input.creationKey, input.concept, 1, true);
		if (session.sessionId !== input.sessionId || session.boundaryEntryId !== input.bindingBoundaryEntryId) {
			throw new RelayRegistryError("invalid_state", "Terminal Pi session differs from its durable promotion boundary");
		}
		return { conversationId, resolved, placement: placement as WorkspaceIdentity };
	}

	async prepareLocalTerminalEnrollment(input: TerminalBindingInput): Promise<RegisteredConversation> {
		if (!this.options.hierarchy) throw new RelayRegistryError("invalid_state", "Local enrollment is unavailable");
		const { conversationId, resolved, placement } = await this.inspectTerminalSource(input);
		const existing = this.options.registry.registeredConversation(conversationId);
		if (existing) {
			if (existing.kind !== "project" || existing.creationKey !== input.creationKey || existing.concept !== input.concept ||
				existing.piSessionId !== input.sessionId || existing.bindingBoundaryEntryId !== input.bindingBoundaryEntryId ||
				JSON.stringify(existing.placement) !== JSON.stringify(placement)) throw new RelayRegistryError("invalid_state", "Local enrollment retry changed its source identity");
			if (hasMatrixBinding(existing)) return this.options.registry.createProjectConversation(existing, input.attachmentNonce, input.sourceSessionFile);
			if (existing.projectKey !== resolved.projectKey || existing.checkoutId !== deriveCheckoutId(this.options.hostId, resolved.projectKey, resolved.workspacePath)) {
				throw new RelayRegistryError("invalid_state", "Local checkout identity changed during enrollment");
			}
			return this.options.registry.registerLocalConversation(existing, input.attachmentNonce, input.sourceSessionFile);
		}
		const reserved = await this.options.hierarchy.prepare({ creationKey: input.creationKey, projectKey: resolved.projectKey,
			canonicalCheckoutRoot: resolved.workspacePath, projectTitle: resolved.projectDisplayName, checkoutTitle: resolved.checkoutDisplayName, conversationTitle: input.concept });
		const createdAt = new Date().toISOString(); const generationId = deriveGenerationId(conversationId, 1);
		const local: PendingLocalConversation = { version: 1, kind: "project", conversationId, ownerHostId: this.options.hostId,
			creationKey: input.creationKey, concept: input.concept, piSessionId: input.sessionId, placement,
			projectKey: resolved.projectKey, projectDisplayName: resolved.projectDisplayName, checkoutDisplayName: resolved.checkoutDisplayName,
			checkoutId: reserved.checkoutId, bindingBoundaryEntryId: input.bindingBoundaryEntryId, createdAt, activeGenerationId: generationId,
			generations: [{ generationId, ordinal: 1, piSessionId: input.sessionId, bindingBoundaryEntryId: input.bindingBoundaryEntryId, createdAt }] };
		return this.options.registry.registerLocalConversation(local, input.attachmentNonce, input.sourceSessionFile);
	}

	/** No Pi session reads, launches or promotion are needed to finish a local binding. */
	async completeLocalEnrollment(conversationId: string, signal?: AbortSignal): Promise<ConversationManifest> {
		signal?.throwIfAborted();
		const local = this.options.registry.registeredConversation(conversationId);
		if (!local) throw new RelayRegistryError("not_found", "Local enrollment is unavailable");
		if (hasMatrixBinding(local)) return local;
		if (!this.options.hierarchy) throw new RelayRegistryError("invalid_state", "Local enrollment is unavailable");
		const resolved = await this.resolveWorkspaceIdentity(local.placement);
		if (resolved.projectKey !== local.projectKey || deriveCheckoutId(this.options.hostId, resolved.projectKey, resolved.workspacePath) !== local.checkoutId) {
			throw new RelayRegistryError("invalid_state", "Local checkout identity changed during provisioning");
		}
		signal?.throwIfAborted();
		const binding = await this.options.hierarchy.provision(conversationId);
		signal?.throwIfAborted();
		return this.options.registry.completeLocalBinding(conversationId, binding);
	}

	async prepareTerminalPromotion(input: TerminalBindingInput): Promise<ConversationManifest> {
		const { conversationId, resolved, placement } = await this.inspectTerminalSource(input);
		const existing = this.options.registry.manifestByCreationKey(input.creationKey);
		if (existing) {
			if (existing.kind !== "project" || existing.conversationId !== conversationId || existing.concept !== input.concept ||
				existing.piSessionId !== input.sessionId || existing.bindingBoundaryEntryId !== input.bindingBoundaryEntryId ||
				JSON.stringify(existing.placement) !== JSON.stringify(placement)) throw new RelayRegistryError("invalid_state", "Promotion retry conflicts with the existing conversation");
			return this.options.registry.createProjectConversation(existing, input.attachmentNonce, input.sourceSessionFile);
		}
		const grouped = await this.provisionConversationMatrix(conversationId, input.concept, resolved, input.creationKey);
		const createdAt = new Date().toISOString(); const generationId = deriveGenerationId(conversationId, 1);
		const manifest: ConversationManifest = {
			schemaVersion: MANAGED_SESSION_STATE_VERSION, kind: "project", conversationId, ownerHostId: this.options.hostId,
			creationKey: input.creationKey, concept: input.concept, piSessionId: input.sessionId, roomId: grouped.roomId,
			placement: placement as WorkspaceIdentity, projectKey: resolved.projectKey, projectDisplayName: resolved.projectDisplayName,
			checkoutDisplayName: resolved.checkoutDisplayName, projectSpace: grouped.projectSpace,
			...(grouped.checkoutId ? { checkoutId: grouped.checkoutId, checkoutSpace: grouped.checkoutSpace } : {}),
			bindingBoundaryEntryId: input.bindingBoundaryEntryId, createdAt, activeGenerationId: generationId,
			generations: [{ generationId, ordinal: 1, piSessionId: input.sessionId, bindingBoundaryEntryId: input.bindingBoundaryEntryId, createdAt }],
		};
		return this.options.registry.createProjectConversation(manifest, input.attachmentNonce, input.sourceSessionFile);
	}

	async completeTerminalPromotion(conversationId: string): Promise<void> {
		const existing = this.promotions.get(conversationId);
		if (existing) return existing;
		const operation = this.completeTerminalPromotionOnce(conversationId).finally(() => this.promotions.delete(conversationId));
		this.promotions.set(conversationId, operation);
		return operation;
	}

	private async completeTerminalPromotionOnce(conversationId: string): Promise<void> {
		const promotion = this.options.registry.promotion(conversationId);
		if (!promotion || promotion.phase === "prepared" || promotion.phase === "shutdown_requested" || this.options.registry.conversationState(conversationId) !== "dormant") return;
		const manifest = this.projectManifest(conversationId);
		const destination = join(resolve(this.options.projectSessionDirectory), conversationId, "session.jsonl");
		const resolved = await this.resolveWorkspaceIdentity(manifest.placement!);
		if (promotion.phase === "shutdown_confirmed") {
			await this.adoptPromotedSession(promotion.sourceSessionFile, destination);
			const session = await durableProjectSession(destination, resolved.cwd, conversationId, manifest.creationKey, manifest.concept, 1, true);
			if (session.sessionId !== manifest.piSessionId || session.boundaryEntryId !== manifest.bindingBoundaryEntryId) {
				throw new RelayRegistryError("invalid_state", "Adopted Pi session conflicts with its managed conversation");
			}
			await this.options.registry.markPromotionAdopted(conversationId);
		}
		await this.launchProject(manifest, undefined, destination);
		await this.options.registry.finishPromotion(conversationId);
	}

	async recoverTerminalPromotions(): Promise<void> {
		for (const conversationId of this.options.registry.pendingPromotionConversationIds()) {
			await this.completeTerminalPromotion(conversationId);
		}
	}

	private async adoptPromotedSession(source: string, destination: string): Promise<void> {
		await ensurePrivateDirectory(dirname(destination));
		try {
			const target = await lstat(destination);
			if (!target.isFile() || target.isSymbolicLink() || (process.getuid?.() !== undefined && target.uid !== process.getuid!())) {
				throw new RelayRegistryError("invalid_state", "Managed promotion destination is unsafe");
			}
			try { await lstat(source); } catch (error) {
				if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
				throw error;
			}
			const [sourceBytes, destinationBytes] = await Promise.all([readFile(source), readFile(destination)]);
			if (!sourceBytes.equals(destinationBytes)) throw new RelayRegistryError("invalid_state", "Source and managed promotion session files conflict");
			await unlink(source);
			return;
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
		}
		const sourceInfo = await lstat(source);
		if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink() || (process.getuid?.() !== undefined && sourceInfo.uid !== process.getuid!())) {
			throw new RelayRegistryError("invalid_state", "Terminal Pi session source is unsafe");
		}
		try {
			await rename(source, destination);
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "EXDEV")) throw error;
			const temporary = `${destination}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
			try {
				await copyFile(source, temporary, fsConstants.COPYFILE_EXCL);
				const file = await open(temporary, "r"); try { await file.sync(); } finally { await file.close(); }
				await rename(temporary, destination);
				await unlink(source);
			} catch (copyError) {
				await rm(temporary, { force: true });
				throw copyError;
			}
		}
	}

	async wake(manifest: ConversationManifest): Promise<void> {
		await this.resume(manifest.conversationId);
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
		if (this.options.registry.retirement(conversationId) || this.generationRetries.has(conversationId)) return;
		const timer = setTimeout(() => {
			this.generationRetries.delete(conversationId);
			void this.runGenerationTransition(conversationId, transitionId, true).catch(() => this.scheduleGenerationRetry(conversationId, transitionId));
		}, this.options.generationRetryMs ?? 5_000);
		timer.unref(); this.generationRetries.set(conversationId, timer);
	}

	private runGenerationTransition(conversationId: string, transitionId: string, recovering: boolean): Promise<void> {
		const manifest = this.projectManifest(conversationId);
		return this.runWorktreeOperation(this.workspaceOperationKey(manifest.placement!), () => this.runGenerationTransitionOnce(conversationId, transitionId, recovering), `generation:${transitionId}`);
	}

	private async runGenerationTransitionOnce(conversationId: string, transitionId: string, recovering: boolean): Promise<void> {
		let manifest = this.projectManifest(conversationId);
		let transition = this.options.registry.generationTransitions().find((item) => item.conversationId === conversationId)?.transition;
		if (!transition || transition.transitionId !== transitionId) return;
		try {
			await this.options.projectNotice?.(`${transitionId}:${recovering ? "recovered" : "requested"}`, manifest, recovering
				? `Recovering fresh Pi session generation ${transition.ordinal}; the Matrix room and prior sessions remain preserved.`
				: `Fresh Pi session generation ${transition.ordinal} requested; preserving this room and all prior Pi sessions.`);
			const resolved = await this.invoke("workspace-resolve", manifest.placement!);
			if (typeof resolved.cwd !== "string" || !isAbsolute(resolved.cwd)) throw new RelayRegistryError("launch_failed", "Workspace launcher omitted canonical cwd");
			const root = await this.invoke("root-resolve", manifest.placement!);
			if (typeof root.sessionName !== "string" || !root.sessionName) throw new RelayRegistryError("launch_failed", "Root launcher omitted its tmux session name");
			const sessionFile = join(resolve(this.options.projectSessionDirectory), conversationId, `generation-${transition.ordinal}.jsonl`);
			if (manifest.activeGenerationId !== transition.toGenerationId || !this.options.registry.isActiveGenerationAttached(conversationId)) {
				const session = await durableProjectSession(sessionFile, resolved.cwd, conversationId, manifest.creationKey, manifest.concept, transition.ordinal);
				await this.options.registry.recordGenerationSession(conversationId, transitionId, session);
				const attachment = this.options.server.attachment(conversationId);
				manifest = await this.options.registry.activateGeneration(conversationId, transitionId);
				const persistedWindow = this.options.registry.managedWindow(conversationId);
				const inspectedWindow = await this.inspectProjectWindow(manifest, root.sessionName);
				if (persistedWindow && inspectedWindow && (persistedWindow.windowId !== inspectedWindow.windowId || persistedWindow.paneId !== inspectedWindow.paneId)) {
					throw new RelayRegistryError("invalid_state", "Generation transition window identity changed before termination");
				}
				if (attachment) this.options.server.sendToAttachment(attachment, { protocolVersion: "1.0.0", messageId: `relay-generation-${randomBytes(8).toString("hex")}`,
					conversationId, role: "relay", type: "termination.request", payload: { reason: "generation_change" } });
				if (persistedWindow) await this.stopExactWindow(conversationId, persistedWindow);
				else if (inspectedWindow) throw new RelayRegistryError("invalid_state", "Generation transition has no frozen window ownership");
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

	async workspaceList(): Promise<Array<{ rootKey: string; workspace: string }>> {
		const result = await this.invoke("workspace-list", {});
		if (!Array.isArray(result.workspaces) || result.workspaces.length > 4_096 || result.workspaces.some((item) => typeof item !== "object" || item === null ||
			typeof (item as Record<string, unknown>).rootKey !== "string" || typeof (item as Record<string, unknown>).workspace !== "string")) {
			throw new RelayRegistryError("launch_failed", "Workspace launcher returned an invalid list");
		}
		const rows = result.workspaces as Array<{ rootKey: string; workspace: string }>;
		for (const row of rows) parseHostAction({ operation: "worktree.list", rootKey: row.rootKey, workspace: row.workspace });
		return rows.map(({ rootKey, workspace }) => ({ rootKey, workspace }));
	}

	/** Metadata-only Git inventory: never runs per-row status or reads lifecycle intent files. */
	async worktreeInventory(rootKey: string, workspace: string): Promise<HostResult<"worktree.list">["items"]> {
		parseHostAction({ operation: "worktree.list", rootKey, workspace });
		const result = await this.invoke("worktree-inventory", { rootKey, workspace });
		if (result.rootKey !== rootKey || typeof result.projectKey !== "string" || !/^project_[a-f0-9]{32}$/.test(result.projectKey) ||
			typeof result.projectWorkspace !== "string" || !Array.isArray(result.worktrees) || result.worktrees.length > 256 ||
			Object.keys(result).some((field) => !["rootKey", "projectWorkspace", "projectKey", "worktrees"].includes(field)))
			throw new RelayRegistryError("launch_failed", "Worktree metadata inventory is invalid");
		parseHostAction({ operation: "worktree.list", rootKey, workspace: result.projectWorkspace });
		const projectKey = result.projectKey;
		const rows = result.worktrees.map((value): HostResult<"worktree.list">["items"][number] => {
			if (typeof value !== "object" || value === null || Array.isArray(value)) throw new RelayRegistryError("launch_failed", "Worktree metadata item is invalid");
			const item = value as Record<string, unknown>;
			if (typeof item.workspace !== "string" || typeof item.workspacePath !== "string" || item.workspacePath.length > 4_096 || !isAbsolute(item.workspacePath) ||
				resolve(item.workspacePath) !== item.workspacePath || basename(item.workspacePath) !== item.workspace || /[\u0000-\u001f\u007f]/.test(item.workspacePath) ||
				typeof item.locked !== "boolean" || typeof item.isMain !== "boolean" || typeof item.head !== "string" || !/^[a-f0-9]{40,64}$/.test(item.head) ||
				(item.branch !== undefined && (typeof item.branch !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/@+/-]{0,254}$/.test(item.branch))) ||
				Object.keys(item).some((field) => !["workspace", "workspacePath", "locked", "isMain", "head", "branch"].includes(field)))
				throw new RelayRegistryError("launch_failed", "Worktree metadata item is invalid");
			parseHostAction({ operation: "worktree.list", rootKey, workspace: item.workspace });
			return { rootKey, workspace: item.workspace, checkoutId: deriveCheckoutId(this.options.hostId, projectKey, item.workspacePath),
				...(typeof item.branch === "string" ? { branch: item.branch } : {}), locked: item.locked, availability: "available" };
		});
		if (new Set(rows.map((row) => row.checkoutId)).size !== rows.length) throw new RelayRegistryError("launch_failed", "Duplicate worktree metadata identity");
		return rows;
	}

	private workspaceOperationKey(placement: WorkspaceIdentity): string { return `workspace:${placement.rootKey}:${placement.workspace}`; }

	private runWorktreeOperation<T>(key: string, operation: () => Promise<T>, identity?: string): Promise<T> {
		const running = this.worktreeOperations.get(key);
		if (running) {
			if (identity && identity === running.identity) return running.promise as Promise<T>;
			return Promise.reject(new RelayRegistryError("invalid_state", "Conflicting workspace operation is already in progress; retry explicitly"));
		}
		const work = operation().finally(() => { if (this.worktreeOperations.get(key)?.promise === work) this.worktreeOperations.delete(key); });
		this.worktreeOperations.set(key, { identity, promise: work }); return work;
	}

	private async worktreeList(rootKey: string, workspace: string): Promise<Record<string, unknown>> {
		const result = await this.invoke("worktree-list", { rootKey, workspace });
		if (result.rootKey !== rootKey || typeof result.projectWorkspace !== "string" || typeof result.commonDir !== "string" || !isAbsolute(result.commonDir) || !Array.isArray(result.worktrees) || result.worktrees.length > 256 ||
			Object.keys(result).some((field) => !["rootKey", "projectWorkspace", "commonDir", "worktrees"].includes(field))) {
			throw new RelayRegistryError("launch_failed", "Worktree launcher returned an invalid inventory");
		}
		const worktrees = result.worktrees.map((value) => {
			if (typeof value !== "object" || value === null || Array.isArray(value)) throw new RelayRegistryError("launch_failed", "Worktree launcher returned an invalid inventory item");
			const item = value as Record<string, unknown>;
			if (typeof item.workspace !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(item.workspace) || typeof item.head !== "string" || !/^[a-f0-9]{40,64}$/.test(item.head) ||
				typeof item.isMain !== "boolean" || typeof item.locked !== "boolean" || typeof item.clean !== "boolean" ||
				(item.branch !== undefined && (typeof item.branch !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/@+/-]{0,254}$/.test(item.branch))) || Object.keys(item).some((field) => !["workspace", "head", "branch", "isMain", "locked", "clean"].includes(field))) {
				throw new RelayRegistryError("launch_failed", "Worktree launcher returned an invalid inventory item");
			}
			const conversations = this.options.registry.listManifests().filter((manifest) => manifest.kind === "project" && manifest.placement?.rootKey === rootKey && manifest.placement.workspace === item.workspace)
				.map((manifest) => manifest.conversationId).slice(0, 256);
			return { ...item, conversations };
		});
		return { operation: "worktree.list", rootKey, workspace, worktrees, intents: await this.worktreeIntentStatuses(result.commonDir) };
	}

	private async worktreeIntentStatuses(commonDir: string): Promise<Array<Record<string, unknown>>> {
		const directory = join(resolve(this.options.projectSessionDirectory), "worktrees");
		let names: string[];
		try { names = (await readdir(directory)).filter((name) => name.endsWith(".json")); }
		catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return []; throw error; }
		if (names.length > 1_024) throw new RelayRegistryError("capacity_reached", "Managed worktree lifecycle intent capacity was exceeded");
		const statuses: Array<Record<string, unknown>> = [];
		for (const name of names.sort()) {
			const path = join(directory, name); const info = await lstat(path);
			if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || (process.getuid?.() !== undefined && info.uid !== process.getuid!())) {
				throw new RelayRegistryError("invalid_state", "Managed worktree lifecycle intent is not a private relay-user file");
			}
			let value: unknown; try { value = JSON.parse(await readFile(path, "utf8")); } catch { throw new RelayRegistryError("invalid_state", "Managed worktree lifecycle intent is malformed"); }
			if (typeof value !== "object" || value === null || Array.isArray(value)) throw new RelayRegistryError("invalid_state", "Managed worktree lifecycle intent is malformed");
			const item = value as Record<string, unknown>;
			if (item.worktreeKey !== undefined) {
				const intent = parseWorktreeCreationIntent(value); if (intent.commonDir === commonDir) statuses.push({ kind: "creation", key: intent.worktreeKey, workspace: intent.targetWorkspace, branch: intent.branch, phase: intent.phase });
			} else {
				const intent = parseWorktreeRemovalIntent(value); if (intent.commonDir === commonDir) statuses.push({ kind: "removal", key: intent.removalKey, workspace: intent.workspace, branch: intent.branch, phase: intent.phase });
			}
		}
		return statuses;
	}

	/** Read-only owner preparation; no lifecycle slot is held while consent is pending. */
	async freezeCreation(action: CreationAction): Promise<FrozenJson> {
		const existing = this.options.registry.manifestByCreationKey(action.creationKey);
		if (action.operation === "project.create") {
			const matches = (await this.workspaceList()).filter((item) => item.rootKey === action.rootKey && item.workspace === action.workspace);
			return JSON.parse(JSON.stringify({ existing: existing ?? null, matches })) as FrozenJson;
		}
		if (action.operation === "conversation.create") return JSON.parse(JSON.stringify({ existing: existing ?? null, workspace: await this.resolveWorkspaceIdentity(action.placement) })) as FrozenJson;
		const file = new AtomicJsonFile(join(resolve(this.options.projectSessionDirectory), "worktrees", `${lifecycleDigest("worktree-intent", action.creationKey)}.json`), parseWorktreeCreationIntent);
		const intent = await readPrivateIntent(file);
		if (intent) {
			if (intent.rootKey !== action.rootKey || intent.sourceWorkspace !== action.workspace || intent.requestedBaseRef !== action.baseRef || intent.branch !== action.branch ||
				intent.concept !== (action.operation === "worktree.conversation.create" ? action.title : undefined)) throw new RelayRegistryError("invalid_state", "Worktree creation identity conflicts with its saved intent");
			return JSON.parse(JSON.stringify({ intent })) as FrozenJson;
		}
		const plan = parseWorktreePlan(await this.invoke("worktree-create-preview", { rootKey: action.rootKey, workspace: action.workspace, baseRef: action.baseRef, branch: action.branch }));
		return JSON.parse(JSON.stringify({ plan })) as FrozenJson;
	}

	async executeCreation(action: CreationAction, frozen: FrozenJson): Promise<unknown> {
		if (!isDeepStrictEqual(await this.freezeCreation(action), frozen)) throw new RelayRegistryError("invalid_state", "Approved creation preconditions changed");
		let result: Record<string, unknown>;
		if (action.operation === "project.create") result = await this.createProject({ rootKey: action.rootKey, workspace: action.workspace, creationKey: action.creationKey, concept: action.title });
		else if (action.operation === "conversation.create") result = await this.start({ creationKey: action.creationKey, concept: action.title, placement: action.placement });
		else {
			result = await this.createWorktree({ creationKey: action.creationKey, rootKey: action.rootKey, workspace: action.workspace,
				baseRef: action.baseRef, branch: action.branch, ...(action.operation === "worktree.conversation.create" ? { concept: action.title } : {}) },
				action.operation === "worktree.conversation.create", frozen as FrozenWorktreeCreation);
			if (action.operation === "worktree.create") {
				const workspace = String(result.workspace); const identity = await this.resolveWorkspaceIdentity({ rootKey: action.rootKey, workspace, relativeCwd: "" });
				return { rootKey: action.rootKey, workspace, checkoutId: deriveCheckoutId(this.options.hostId, identity.projectKey, identity.workspacePath) };
			}
		}
		const conversationId = String(result.targetConversationId); const launchId = this.options.registry.launchIdentity(conversationId)?.launchId;
		if (!launchId) throw new RelayRegistryError("invalid_state", "Created conversation has no managed launch identity");
		return { conversationId, launchId, setupState: "pending" };
	}

	private createWorktree(request: { creationKey: string; rootKey: string; workspace: string; baseRef: string; branch: string; concept?: string }, bundled: boolean, frozen?: FrozenWorktreeCreation): Promise<Record<string, unknown>> {
		return this.runWorktreeOperation(`create:${request.creationKey}`, () => this.createWorktreeOnce(request, bundled, frozen), JSON.stringify([request, bundled, frozen]));
	}

	private async createWorktreeOnce(request: { creationKey: string; rootKey: string; workspace: string; baseRef: string; branch: string; concept?: string }, bundled: boolean, frozen?: FrozenWorktreeCreation): Promise<Record<string, unknown>> {
		if (bundled !== Boolean(request.concept)) throw new RelayRegistryError("invalid_state", "Bundled worktree creation requires one conversation concept");
		const intentPath = join(resolve(this.options.projectSessionDirectory), "worktrees", `${lifecycleDigest("worktree-intent", request.creationKey)}.json`);
		const file = new AtomicJsonFile(intentPath, parseWorktreeCreationIntent);
		let intent = await readPrivateIntent(file); const retry = intent !== undefined;
		if (frozen && !isDeepStrictEqual(intent, frozen.intent)) throw new RelayRegistryError("invalid_state", "Approved worktree intent changed before admission");
		if (intent) {
			for (const [field, value] of Object.entries({ creationKey: request.creationKey, rootKey: request.rootKey, sourceWorkspace: request.workspace, requestedBaseRef: request.baseRef, branch: request.branch,
				...(request.concept ? { concept: request.concept } : {}) })) if ((intent as unknown as Record<string, unknown>)[field] !== value) {
				throw new RelayRegistryError("invalid_state", "Worktree creation retry conflicts with its durable intent");
			}
		} else {
			const plan = parseWorktreePlan(await this.invoke("worktree-create-preview", { rootKey: request.rootKey, workspace: request.workspace, baseRef: request.baseRef, branch: request.branch }));
			if (frozen && !isDeepStrictEqual(plan, frozen.plan)) throw new RelayRegistryError("invalid_state", "Approved worktree base or placement changed before admission");
			const worktreeKey = `worktree_${lifecycleDigest("worktree", this.options.hostId, plan.rootKey, plan.commonDir, plan.branch)}`;
			const conversationCreationKey = request.concept ? `worktree-conversation-${lifecycleDigest("worktree-conversation", worktreeKey, request.concept)}` : undefined;
			intent = { ...plan, creationKey: request.creationKey, requestedBaseRef: request.baseRef, worktreeKey, phase: "planned", ...(request.concept ? { concept: request.concept, conversationCreationKey } : {}) };
			await ensureWorktreeIntentCapacity(dirname(intentPath)); await file.write(intent);
		}
		const created = await this.runWorktreeOperation(`repository:${intent.commonDir}`, () => this.invoke("worktree-create-apply", { ...intent, resumeExisting: retry }));
		if (created.rootKey !== intent.rootKey || created.workspace !== intent.targetWorkspace || created.branch !== intent.branch || created.baseCommit !== intent.baseCommit ||
			Object.keys(created).some((field) => !["rootKey", "workspace", "branch", "baseCommit"].includes(field))) throw new RelayRegistryError("launch_failed", "Worktree launcher returned an invalid creation result");
		if (intent.phase !== "created") { intent = { ...intent, phase: "created" }; await file.write(intent); }
		if (!bundled) return { operation: "worktree.create", worktreeKey: intent.worktreeKey, rootKey: intent.rootKey, workspace: intent.targetWorkspace, branch: intent.branch, baseCommit: intent.baseCommit };
		const conversationCreationKey = intent.conversationCreationKey; const concept = intent.concept;
		if (!conversationCreationKey || !concept) throw new RelayRegistryError("invalid_state", "Bundled worktree creation lost its conversation identity");
		const started = await this.start({ creationKey: conversationCreationKey, concept, placement: { rootKey: intent.rootKey, workspace: intent.targetWorkspace, relativeCwd: "" } });
		const conversationId = String(started.targetConversationId); const manifest = this.projectManifest(conversationId);
		const roomLink = `https://matrix.to/#/${encodeURIComponent(manifest.roomId)}`;
		return { operation: "worktree.conversation.create", worktreeKey: intent.worktreeKey, rootKey: intent.rootKey, workspace: intent.targetWorkspace,
			branch: intent.branch, baseCommit: intent.baseCommit, targetConversationId: conversationId, conversationState: this.options.registry.conversationState(conversationId), roomLink };
	}

	async removalApprovalPreview(action: Extract<HostAction, { operation: "worktree.remove.preview" | "worktree.conversation.cleanup.preview" }>): Promise<{ intent: WorktreeRemovalIntent; checkoutId: string; activeConversations: string[] }> {
		const preview = action.operation === "worktree.remove.preview"
			? await this.previewWorktreeRemoval({ rootKey: action.rootKey, workspace: action.workspace, ...(action.mergeTarget ? { mergeTarget: action.mergeTarget } : {}) })
			: await this.previewConversationCleanup(action.conversationId, action.mergeTarget);
		const intent = await this.removalApprovalSnapshot(String(preview.removalKey));
		const identity = await this.resolveWorkspaceIdentity({ rootKey: intent.rootKey, workspace: intent.projectWorkspace, relativeCwd: "" });
		return { intent, checkoutId: deriveCheckoutId(this.options.hostId, identity.projectKey, intent.path), activeConversations: preview.activeConversations as string[] };
	}

	async removalApprovalSnapshot(removalKey: string): Promise<WorktreeRemovalIntent> {
		if (!/^worktree_remove_[a-f0-9]{32}$/.test(removalKey)) throw new RelayRegistryError("invalid_state", "Invalid removal identity");
		const intent = await readPrivateIntent(new AtomicJsonFile(join(resolve(this.options.projectSessionDirectory), "worktrees", `${removalKey}.json`), parseWorktreeRemovalIntent));
		if (!intent) throw new RelayRegistryError("not_found", "Removal preview is unavailable");
		return intent;
	}

	executeRemovalApproval(snapshot: FrozenJson, bundled: boolean, retire?: (conversationId: string) => Promise<unknown>): Promise<Record<string, unknown>> {
		const intent = snapshot as unknown as WorktreeRemovalIntent;
		return this.applyWorktreeRemoval(intent.removalKey, bundled, { snapshot: intent, retire });
	}

	private async previewWorktreeRemoval(request: { rootKey: string; workspace: string; mergeTarget?: string }, targetConversationId?: string): Promise<Record<string, unknown>> {
		const raw = await this.invoke("worktree-remove-preview", request);
		const placeholder = `worktree_remove_${"0".repeat(32)}`;
		const parsed = parseWorktreeRemovalIntent({ ...raw, removalKey: placeholder, phase: "planned", ...(targetConversationId ? { targetConversationId } : {}) });
		const removalKey = `worktree_remove_${lifecycleDigest("worktree-removal", this.options.hostId, parsed.rootKey, parsed.commonDir, parsed.workspace, parsed.branch, parsed.head, parsed.mergeTarget ?? "", targetConversationId ?? "independent")}`;
		const intent: WorktreeRemovalIntent = { ...parsed, removalKey };
		const file = new AtomicJsonFile(join(resolve(this.options.projectSessionDirectory), "worktrees", `${removalKey}.json`), parseWorktreeRemovalIntent);
		const existing = await readPrivateIntent(file);
		if (existing && JSON.stringify(existing) !== JSON.stringify(intent)) throw new RelayRegistryError("invalid_state", "Worktree removal preview key conflicts with an existing intent");
		if (!existing) { await ensureWorktreeIntentCapacity(dirname(file.path)); await file.write(intent); }
		const activeConversations = this.options.registry.listManifests().filter((manifest) => manifest.kind === "project" && manifest.placement?.rootKey === intent.rootKey && manifest.placement.workspace === intent.workspace &&
			this.options.registry.conversationState(manifest.conversationId) !== "dormant").map((manifest) => manifest.conversationId).slice(0, 256);
		return { operation: targetConversationId ? "worktree.conversation.cleanup.preview" : "worktree.remove.preview", removalKey, rootKey: intent.rootKey, workspace: intent.workspace,
			branch: intent.branch, head: intent.head, clean: intent.clean, locked: intent.locked, activeConversations, ...(targetConversationId ? { targetConversationId } : {}),
			...(intent.mergeTarget ? { mergeTarget: intent.mergeTarget, merged: intent.merged } : {}) };
	}

	private previewConversationCleanup(conversationId: string, mergeTarget?: string): Promise<Record<string, unknown>> {
		const manifest = this.projectManifest(conversationId);
		if (!manifest.placement || manifest.placement.relativeCwd !== "") throw new RelayRegistryError("invalid_state", "Bundled worktree cleanup requires a checkout-root conversation");
		return this.previewWorktreeRemoval({ rootKey: manifest.placement.rootKey, workspace: manifest.placement.workspace, ...(mergeTarget ? { mergeTarget } : {}) }, conversationId);
	}

	private applyWorktreeRemoval(removalKey: string, bundled: boolean, approved?: { snapshot: WorktreeRemovalIntent; retire?: (conversationId: string) => Promise<unknown> }): Promise<Record<string, unknown>> {
		return this.runWorktreeOperation(`remove:${removalKey}`, () => this.applyWorktreeRemovalOnce(removalKey, bundled, approved));
	}

	private async applyWorktreeRemovalOnce(removalKey: string, bundled: boolean, approved?: { snapshot: WorktreeRemovalIntent; retire?: (conversationId: string) => Promise<unknown> }): Promise<Record<string, unknown>> {
		const file = new AtomicJsonFile(join(resolve(this.options.projectSessionDirectory), "worktrees", `${removalKey}.json`), parseWorktreeRemovalIntent);
		const intent = await readPrivateIntent(file); if (!intent || intent.removalKey !== removalKey) throw new RelayRegistryError("not_found", "Managed worktree removal preview was not found");
		if (bundled !== Boolean(intent.targetConversationId)) throw new RelayRegistryError("invalid_state", "Worktree removal mode conflicts with its preview");
		if (!intent.clean || intent.locked) throw new RelayRegistryError("invalid_state", "Managed worktree must be clean and unlocked before removal");
		return this.runWorktreeOperation(this.workspaceOperationKey({ rootKey: intent.rootKey, workspace: intent.workspace, relativeCwd: "" }),
			() => this.applyWorktreeRemovalLocked(file, intent, bundled, approved));
	}

	private async applyWorktreeRemovalLocked(file: AtomicJsonFile<WorktreeRemovalIntent>, initialIntent: WorktreeRemovalIntent, bundled: boolean, approved?: { snapshot: WorktreeRemovalIntent; retire?: (conversationId: string) => Promise<unknown> }): Promise<Record<string, unknown>> {
		if (approved && !isDeepStrictEqual(await readPrivateIntent(file), approved.snapshot)) throw new RelayRegistryError("invalid_state", "Approved removal intent changed before admission");
		const retire = approved?.retire ?? ((id: string) => this.delete(id));
		let intent = initialIntent; const removalKey = intent.removalKey;
		const removal = intent;
		const bound = this.options.registry.listManifests().filter((manifest) => manifest.kind === "project" && manifest.placement?.rootKey === removal.rootKey && manifest.placement.workspace === removal.workspace);
		if (!bundled && bound.some((manifest) => this.options.registry.conversationState(manifest.conversationId) !== "dormant")) throw new RelayRegistryError("invalid_state", "An active managed conversation is using this worktree");
		if (bundled && bound.some((manifest) => manifest.conversationId !== removal.targetConversationId && this.options.registry.conversationState(manifest.conversationId) !== "dormant")) {
			throw new RelayRegistryError("invalid_state", "Another active managed conversation is using this worktree");
		}
		const selected = bundled ? this.options.registry.manifestByConversationId(intent.targetConversationId!) : undefined;
		if (selected && intent.phase !== "planned" && this.options.registry.conversationState(selected.conversationId) !== "dormant") {
			throw new RelayRegistryError("invalid_state", "Bundled cleanup preview became stale when its selected conversation resumed");
		}
		if (bundled && intent.phase !== "bridge_deleted" && intent.phase !== "branch_deleted") {
			const targetId = intent.targetConversationId!;
			const target = this.options.registry.manifestByConversationId(targetId);
			if (target) {
				if (this.options.registry.conversationState(targetId) === "starting") throw new RelayRegistryError("invalid_state", "Bundled worktree cleanup cannot interrupt a starting conversation");
				if (intent.phase === "planned") {
					const fresh = await this.invoke("worktree-remove-preview", { rootKey: intent.rootKey, workspace: intent.workspace, ...(intent.mergeTarget ? { mergeTarget: intent.mergeTarget } : {}) });
					const checked = parseWorktreeRemovalIntent({ ...fresh, removalKey, phase: "planned", targetConversationId: targetId });
					if (!isDeepStrictEqual(checked, intent)) throw new RelayRegistryError("invalid_state", "Bundled cleanup preview changed; obtain new confirmation");
				}
				await retire(targetId);
			}
			await this.waitForRetirementStop(targetId);
			if (intent.phase === "planned") { intent = { ...intent, phase: "stopped" }; await file.write(intent); }
		}
		if (["planned", "stopped"].includes(intent.phase)) {
			await this.runWorktreeOperation(`repository:${intent.commonDir}`, () => this.invoke("worktree-remove-apply", { ...intent, resumeExisting: true }));
			intent = { ...intent, phase: "removed" }; await file.write(intent);
		}
		let bridgeDeleted: boolean | undefined;
		if (bundled && intent.phase === "removed") {
			const target = this.options.registry.manifestByConversationId(intent.targetConversationId!);
			if (target) await retire(target.conversationId);
			intent = { ...intent, phase: "bridge_deleted" }; await file.write(intent); bridgeDeleted = true;
		} else if (bundled) bridgeDeleted = true;
		return { operation: bundled ? "worktree.conversation.cleanup.apply" : "worktree.remove.apply", removalKey, workspaceRemoved: true, ...(bridgeDeleted ? { bridgeDeleted } : {}) };
	}

	private async waitForRetirementStop(conversationId: string): Promise<void> {
		for (let attempt = 0; attempt < 60; attempt++) {
			const retired = this.options.registry.retirement(conversationId);
			if (!retired) throw new RelayRegistryError("invalid_state", "Bundled cleanup requires committed retirement");
			const stop = retired.cleanup?.find((effect) => effect.kind === "stop");
			if (!retired.cleanup || stop?.phase === "done") return;
			if (!stop || stop.phase === "blocked") break;
			await new Promise((resolveWait) => setTimeout(resolveWait, 250));
		}
		throw new RelayRegistryError("invalid_state", "Conversation is retired but physical stop is unverified; worktree remains preserved");
	}

	async branchApprovalPreview(action: Extract<HostAction, { operation: "worktree.branch.preview" }>): Promise<{ plan: BranchPlan; checkoutId: string }> {
		const raw = await this.invoke("worktree-branch-preview", { rootKey: action.rootKey, workspace: action.workspace, branch: action.branch, mergeTarget: action.mergeTarget });
		const fields = ["rootKey", "projectWorkspace", "commonDir", "mainPath", "branch", "head", "mergeTarget", "mergeCommit"];
		if (Object.keys(raw).length !== fields.length || fields.some((key) => typeof raw[key] !== "string")) throw new RelayRegistryError("invalid_state", "Invalid branch preview");
		const plan = Object.fromEntries(fields.map((key) => [key, boundedHostString(raw, key, key === "commonDir" || key === "mainPath" ? 4096 : 255)])) as unknown as BranchPlan;
		if (plan.rootKey !== action.rootKey || plan.branch !== action.branch || !isAbsolute(plan.commonDir) || !isAbsolute(plan.mainPath) ||
			![plan.head, plan.mergeCommit].every((id) => /^[a-f0-9]{40,64}$/.test(id))) throw new RelayRegistryError("invalid_state", "Branch preview identity changed");
		const identity = await this.resolveWorkspaceIdentity({ rootKey: action.rootKey, workspace: plan.projectWorkspace, relativeCwd: "" });
		if (identity.workspacePath !== plan.mainPath) throw new RelayRegistryError("invalid_state", "Branch repository identity changed");
		return { plan, checkoutId: deriveCheckoutId(this.options.hostId, identity.projectKey, identity.workspacePath) };
	}

	executeBranchApproval(snapshot: FrozenJson): Promise<Record<string, unknown>> {
		const frozen = snapshot as unknown as Awaited<ReturnType<HostLifecycle["branchApprovalPreview"]>>;
		const plan = frozen.plan;
		return this.runWorktreeOperation(`repository:${plan.commonDir}`, async () => {
			const current = await this.branchApprovalPreview({ operation: "worktree.branch.preview", rootKey: plan.rootKey, workspace: plan.projectWorkspace, branch: plan.branch, mergeTarget: plan.mergeTarget });
			if (!isDeepStrictEqual(current, frozen)) throw new RelayRegistryError("invalid_state", "Approved branch target changed before admission");
			const result = await this.invoke("worktree-branch-delete", { ...plan, resumeExisting: false });
			if (result.branch !== plan.branch || result.deleted !== true || Object.keys(result).some((key) => !["branch", "deleted"].includes(key))) throw new RelayRegistryError("launch_failed", "Invalid branch deletion result");
			return result;
		});
	}

	private deleteWorktreeBranch(removalKey: string, approved?: WorktreeRemovalIntent): Promise<Record<string, unknown>> {
		return this.runWorktreeOperation(`branch:${removalKey}`, async () => {
			const file = new AtomicJsonFile(join(resolve(this.options.projectSessionDirectory), "worktrees", `${removalKey}.json`), parseWorktreeRemovalIntent);
			let intent = await readPrivateIntent(file); if (!intent || intent.removalKey !== removalKey) throw new RelayRegistryError("not_found", "Managed worktree removal preview was not found");
			if (approved && !isDeepStrictEqual(intent, approved)) throw new RelayRegistryError("invalid_state", "Approved branch target changed before admission");
			if (!["removed", "bridge_deleted", "branch_deleted"].includes(intent.phase) || !intent.mergeTarget || !intent.mergeCommit || intent.merged !== true) {
				throw new RelayRegistryError("invalid_state", "Branch deletion requires a completed removal previewed as fully merged");
			}
			const result = await this.runWorktreeOperation(`repository:${intent.commonDir}`, () => this.invoke("worktree-branch-delete", { ...intent, resumeExisting: true }));
			if (result.branch !== intent.branch || result.deleted !== true || Object.keys(result).some((field) => !["branch", "deleted"].includes(field))) throw new RelayRegistryError("launch_failed", "Worktree launcher returned an invalid branch deletion result");
			if (intent.phase !== "branch_deleted") { intent = { ...intent, phase: "branch_deleted" }; await file.write(intent); }
			return { operation: "worktree.branch.delete", removalKey, branch: intent.branch, branchDeleted: true };
		});
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
		const intentPath = join(resolve(this.options.projectSessionDirectory), conversationId, "project-creation.json");
		const intentFile = new AtomicJsonFile(intentPath, parseProjectCreationIntent);
		let intent = await intentFile.read(); const retry = intent !== undefined;
		if (intent) { const info = await lstat(intentPath); if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 ||
			(process.getuid?.() !== undefined && info.uid !== process.getuid!())) throw new RelayRegistryError("invalid_state", "Existing project creation intent is not a private relay-user file"); }
		const expectedIntent = { creationKey: request.creationKey, rootKey: request.rootKey, workspace: request.workspace, concept: request.concept };
		if (intent) {
			for (const [key, value] of Object.entries(expectedIntent)) if ((intent as unknown as Record<string, unknown>)[key] !== value) throw new RelayRegistryError("invalid_state", "Project creation retry conflicts with its durable intent");
		} else { intent = { ...expectedIntent, sessionPersisted: false, ...(this.options.hierarchy ? { liveHierarchy: true as const } : {}) }; await intentFile.write(intent); }
		if (intent.liveHierarchy && !this.options.hierarchy) throw new RelayRegistryError("invalid_state", "Live hierarchy provisioning is required to resume this creation");
		const created = await this.invoke("project-create", { rootKey: request.rootKey, workspace: request.workspace,
			creationKey: request.creationKey, resumeExisting: retry });
		const expectedFields = new Set(["rootKey", "workspace", "relativeCwd", "workspacePath", "cwd", "projectKey", "projectDisplayName", "checkoutDisplayName"]);
		if (created.rootKey !== request.rootKey || created.workspace !== request.workspace || created.relativeCwd !== "" ||
			typeof created.workspacePath !== "string" || !isAbsolute(created.workspacePath) || created.cwd !== created.workspacePath || !hasValidProjectIdentity(created) ||
			Object.keys(created).some((field) => !expectedFields.has(field))) throw new RelayRegistryError("launch_failed", "Project launcher returned an invalid created workspace");
		const creationIdentity = { projectKey: created.projectKey,
			projectDisplayName: intent.liveHierarchy && intent.projectDisplayName ? intent.projectDisplayName : created.projectDisplayName,
			checkoutDisplayName: intent.liveHierarchy && intent.checkoutDisplayName ? intent.checkoutDisplayName : created.checkoutDisplayName };
		if (intent.projectKey) {
			for (const [key, value] of Object.entries(creationIdentity)) if ((intent as unknown as Record<string, unknown>)[key] !== value) throw new RelayRegistryError("invalid_state", "Project creation retry changed its host-resolved project identity");
		} else { intent = { ...intent, ...creationIdentity }; await intentFile.write(intent); }
		const sessionFile = join(resolve(this.options.projectSessionDirectory), conversationId, "session.jsonl");
		await durableProjectSession(sessionFile, created.cwd, conversationId, request.creationKey, request.concept);
		if (!intent.sessionPersisted) { intent = { ...intent, sessionPersisted: true }; await intentFile.write(intent); }
		let matrixBinding: MatrixConversationBinding;
		if (intent.liveHierarchy) {
			matrixBinding = await this.provisionConversationMatrix(conversationId, request.concept, { ...created, ...creationIdentity } as unknown as ResolvedWorkspace, request.creationKey);
		} else {
			// Pre-upgrade interrupted operations retain their original alias namespace and layout.
			const roomAliasKey = conversationId.slice(5);
			if (!intent.projectSpaceId) { intent = { ...intent, projectSpaceId: await this.projectSpaces.ensure(created.projectKey, created.projectDisplayName, retry) }; await intentFile.write(intent); }
			else await this.projectSpaces.assertTarget(created.projectKey, intent.projectSpaceId);
			const projectSpaceId = intent.projectSpaceId;
			if (!projectSpaceId) throw new RelayRegistryError("invalid_state", "Project creation Space identity is unavailable");
			const coordinator = this.options.registry.listManifests().find((item) => item.kind === "coordinator");
			if (!intent.hostSpaceLinked) { if (coordinator?.kind === "coordinator" && coordinator.hostSpace) await this.options.matrix.addSpaceChild(coordinator.hostSpace, projectSpaceId); intent = { ...intent, hostSpaceLinked: true }; await intentFile.write(intent); }
			if (!intent.roomId) { intent = { ...intent, roomId: await this.options.matrix.createPrivateRoomIdempotent(`pi · ${created.checkoutDisplayName} · ${request.concept}`, `pi-${roomAliasKey}-room`) }; await intentFile.write(intent); }
			else if (await this.options.matrix.resolvePrivateRoomAlias(`pi-${roomAliasKey}-room`, false) !== intent.roomId) {
				throw new RelayRegistryError("invalid_state", "Project creation room no longer matches its deterministic alias");
			}
			const roomId = intent.roomId;
			if (!roomId) throw new RelayRegistryError("invalid_state", "Project creation room identity is unavailable");
			if (!intent.roomLinked) { await this.options.matrix.addSpaceChild(projectSpaceId, roomId); intent = { ...intent, roomLinked: true }; await intentFile.write(intent); }
			matrixBinding = { projectSpace: projectSpaceId, roomId };
		}
		await this.start({ creationKey: request.creationKey, concept: request.concept, placement },
			{ ...matrixBinding, ...creationIdentity });
		const manifest = this.options.registry.manifestByCreationKey(request.creationKey);
		if (!manifest || manifest.kind !== "project" || manifest.roomId.length > 255) throw new RelayRegistryError("invalid_state", "Created project conversation is unavailable");
		const roomLink = `https://matrix.to/#/${encodeURIComponent(manifest.roomId)}`;
		if (roomLink.length > 512) throw new RelayRegistryError("invalid_state", "Created project room link exceeded its bound");
		return { operation: "project.create", targetConversationId: manifest.conversationId,
			conversationState: this.options.registry.conversationState(manifest.conversationId), roomLink };
	}

	private start(request: { creationKey: string; concept: string; placement: WorkspaceIdentity },
		provisioned?: ProvisionedProject): Promise<Record<string, unknown>> {
		return this.runWorktreeOperation(this.workspaceOperationKey(request.placement), () => this.startOnce(request, provisioned),
			`create:${deriveConversationId(this.options.hostId, request.creationKey)}:${JSON.stringify([request.concept, request.placement])}`);
	}

	private async startOnce(request: { creationKey: string; concept: string; placement: WorkspaceIdentity },
		provisioned?: ProvisionedProject): Promise<Record<string, unknown>> {
		const conversationId = deriveConversationId(this.options.hostId, request.creationKey);
		const existing = this.options.registry.manifestByCreationKey(request.creationKey);
		if (existing) {
			if (existing.kind !== "project" || existing.conversationId !== conversationId || existing.concept !== request.concept ||
				JSON.stringify(existing.placement) !== JSON.stringify(request.placement)) throw new RelayRegistryError("invalid_state", "Conversation start retry conflicts with existing identity");
			await this.resumeOnce(existing.conversationId);
			return { operation: "conversation.start", targetConversationId: existing.conversationId, conversationState: this.options.registry.conversationState(existing.conversationId) };
		}
		const resolved = await this.resolveWorkspaceIdentity(request.placement);
		const sessionFile = join(resolve(this.options.projectSessionDirectory), conversationId, "session.jsonl");
		const session = await durableProjectSession(sessionFile, resolved.cwd, conversationId, request.creationKey, request.concept);
		const identity = provisioned ?? resolved;
		const matrixBinding = provisioned ?? await this.provisionConversationMatrix(conversationId, request.concept, resolved, request.creationKey);
		const { projectSpace, roomId } = matrixBinding;
		const nonce = randomBytes(32).toString("base64url");
		const createdAt = new Date().toISOString(); const generationId = deriveGenerationId(conversationId, 1);
		const manifest: ConversationManifest = {
			schemaVersion: MANAGED_SESSION_STATE_VERSION, kind: "project", conversationId, ownerHostId: this.options.hostId,
			creationKey: request.creationKey, concept: request.concept, piSessionId: session.sessionId, roomId,
			placement: request.placement, projectKey: identity.projectKey, projectDisplayName: identity.projectDisplayName,
			checkoutDisplayName: identity.checkoutDisplayName, projectSpace,
			...(matrixBinding.checkoutId ? { checkoutId: matrixBinding.checkoutId, checkoutSpace: matrixBinding.checkoutSpace } : {}), bindingBoundaryEntryId: session.boundaryEntryId, createdAt,
			activeGenerationId: generationId, generations: [{ generationId, ordinal: 1, piSessionId: session.sessionId, bindingBoundaryEntryId: session.boundaryEntryId, createdAt }],
		};
		await this.options.registry.createProjectConversation(manifest, nonce);
		await this.launchProject(manifest, nonce, sessionFile);
		return { operation: "conversation.start", targetConversationId: conversationId, conversationState: this.options.registry.conversationState(conversationId) };
	}

	/** Returns an exact target, never switches a client, and does not cancel readiness observation. */
	async openConversation(conversationId: string): Promise<HostResult<"conversation.open">> {
		const manifest = this.liveManifest(conversationId);
		const running = this.worktreeOperations.get(this.launchOperationKey(manifest));
		if (running && running.identity !== `launch:${conversationId}` && !running.identity?.startsWith(`create:${conversationId}:`)) {
			throw new RelayRegistryError("invalid_state", "Conflicting workspace operation is already in progress; retry explicitly");
		}
		const ready = this.resume(conversationId);
		// The relay, not the requesting picker connection, owns the bounded observer.
		void ready.catch(() => undefined);
		let launch = this.launches.get(conversationId);
		if (!launch && running?.identity?.startsWith(`create:${conversationId}:`)) {
			// Registration may be visible while its final durable write is still
			// completing. Join that writer without waiting for Pi attachment.
			let settled = false;
			void ready.then(() => { settled = true; }, () => { settled = true; });
			while (!launch && !settled) {
				await new Promise((resolve) => setTimeout(resolve, 10));
				launch = this.launches.get(conversationId);
			}
		}
		if (launch) await launch.window;
		else await ready;
		const window = this.options.registry.managedWindow(conversationId);
		if (!window?.ownership) throw new RelayRegistryError("invalid_state", "Open requires exact managed window ownership");
		assertExactWindowBinding(conversationId, window);
		if (await this.exactWindows.check(window.ownership) !== "match") {
			throw new RelayRegistryError("launch_failed", "Open target disappeared or changed; inspect the retained window before retry");
		}
		this.liveManifest(conversationId); // Retirement wins an asynchronous observation.
		if (!isDeepStrictEqual(window, this.options.registry.managedWindow(conversationId))) {
			throw new RelayRegistryError("invalid_state", "Open target changed during observation");
		}
		return { conversationId, launchId: window.ownership.launchId,
			launchState: this.options.registry.conversationState(conversationId) === "active" ? "attached" : "window_created",
			window: { conversationId, sessionName: window.sessionName, windowId: window.windowId, paneId: window.paneId } };
	}

	async resumeConversation(conversationId: string): Promise<HostResult<"conversation.resume">> {
		await this.resume(conversationId);
		const target = await this.openConversation(conversationId);
		return { conversationId, launchId: target.launchId, launchState: target.launchState };
	}

	private launchOperationKey(manifest: ConversationManifest): string {
		return manifest.kind === "coordinator" ? "coordinator" : this.workspaceOperationKey(manifest.placement!);
	}

	private resume(conversationId: string): Promise<Record<string, unknown>> {
		const manifest = this.liveManifest(conversationId);
		const key = this.launchOperationKey(manifest);
		const creating = this.worktreeOperations.get(key)?.identity;
		const identity = creating?.startsWith(`create:${conversationId}:`) ? creating : `launch:${conversationId}`;
		return this.runWorktreeOperation(key, () => this.resumeOnce(conversationId), identity).then(() => ({
			operation: "conversation.resume", targetConversationId: conversationId, conversationState: this.options.registry.conversationState(conversationId),
		}));
	}

	private async resumeOnce(conversationId: string): Promise<Record<string, unknown>> {
		const manifest = this.liveManifest(conversationId);
		if (manifest.kind === "coordinator") {
			if (this.options.registry.conversationState(conversationId) !== "active") await this.launch(conversationId, async (windowCreated) => {
				const config = this.options.coordinator;
				if (!config) throw new RelayRegistryError("invalid_state", "Coordinator launch configuration is unavailable");
				try {
					const proof = await ensureCoordinatorWindow({ ...config, manifest, registry: this.options.registry,
						socketPath: this.options.socketPath, environment: this.options.environment });
					windowCreated();
					const result = await waitForProjectAttachment({ timeoutMs: this.options.attachmentTimeoutMs ?? PROJECT_ATTACHMENT_TIMEOUT_MS,
						state: () => this.options.registry.conversationState(conversationId),
						inspectWindow: async () => await this.exactWindows.check(proof) === "match" });
					if (result !== "attached") throw new RelayRegistryError("launch_failed", result === "timeout" ? "Coordinator attachment timed out; inspect the retained window" : "Coordinator window exited or changed; inspect retained panes manually");
				} catch (error) {
					await this.options.registry.recordLaunchError(conversationId, "launch_failed", error instanceof Error ? error.message : "Coordinator launch failed");
					throw error;
				}
			});
		} else if (this.options.registry.conversationState(conversationId) !== "active") {
			const promotion = this.options.registry.promotion(conversationId);
			if (promotion?.phase === "prepared") throw new RelayRegistryError("invalid_state", "Terminal promotion must be retried from its source Pi session");
			if (promotion) await this.completeTerminalPromotion(conversationId);
			else await this.launchProject(manifest);
		}
		return { operation: "conversation.resume", targetConversationId: conversationId, conversationState: this.options.registry.conversationState(conversationId) };
	}

	acceptRefreshResult(conversationId: string, refreshId: string, status: string): void {
		const waiter = this.refreshWaiters.get(conversationId);
		if (!waiter || waiter.refreshId !== refreshId) throw new RelayRegistryError("invalid_state", "Refresh request is no longer pending");
		waiter.resolve(status === "ready");
	}

	async refreshApproved(conversationId: string, attachmentId?: string): Promise<HostResult<"conversation.refresh">> {
		await this.refresh(conversationId, attachmentId ? { attachmentId } : undefined);
		const launchId = this.options.registry.launchIdentity(conversationId)?.launchId;
		if (!launchId) throw new RelayRegistryError("invalid_state", "Refreshed conversation has no launch identity");
		return { conversationId, launchId, launchState: this.options.registry.conversationState(conversationId) === "active" ? "attached" : "failed" };
	}

	private async refresh(conversationId: string, expected?: { attachmentId: string; desiredRuntimeId?: string }): Promise<Record<string, unknown>> {
		const manifest = this.projectManifest(conversationId);
		this.options.registry.beginRefresh(conversationId);
		try {
			return await this.runWorktreeOperation(this.workspaceOperationKey(manifest.placement!), async () => {
				// Resolve configuration before touching the running process.
				await this.resolveWorkspaceIdentity(manifest.placement!);
				if (expected) {
					const attachment = this.options.registry.snapshot().conversations.find((item) => item.conversationId === conversationId)?.attachment;
					if (attachment?.attachmentId !== expected.attachmentId || (expected.desiredRuntimeId !== undefined && attachment.runtimeId === expected.desiredRuntimeId)) {
						throw new RelayRegistryError("invalid_state", "Runtime refresh deferred: attachment changed during resolution");
					}
				}
				const window = this.options.registry.managedWindow(conversationId);
				if (this.options.registry.conversationState(conversationId) === "active") {
					if (!window) throw new RelayRegistryError("invalid_state", "Refresh requires an exact managed window");
					const refreshId = `refresh-${randomBytes(16).toString("hex")}`;
					let timer: NodeJS.Timeout | undefined;
					try {
						const ready = await new Promise<boolean>((resolve, reject) => {
							this.refreshWaiters.set(conversationId, { refreshId, resolve });
							timer = setTimeout(() => reject(new RelayRegistryError("invalid_state", "Refresh refused: live idle state could not be confirmed")), 10_000);
							if (!this.options.server.sendToConversation({ protocolVersion: "1.0.0", messageId: refreshId, conversationId,
								role: "relay", type: "refresh.request", payload: { refreshId } })) reject(new RelayRegistryError("invalid_state", "Refresh refused: adapter is disconnected"));
						});
						if (!ready) throw new RelayRegistryError("invalid_state", "Refresh refused: Pi is busy; no work was cancelled");
					} finally { if (timer) clearTimeout(timer); this.refreshWaiters.delete(conversationId); }
					// The adapter shuts down gracefully only if still idle. Never force
					// an attached process to exit, even after a successful idle response.
					for (let attempt = 0; attempt < 100 && this.options.registry.conversationState(conversationId) === "active"; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 100));
					if (this.options.registry.conversationState(conversationId) !== "dormant") throw new RelayRegistryError("invalid_state", "Refresh refused: Pi did not shut down idle");
					await this.stopExactWindow(conversationId, window, false);
					await this.options.registry.setManagedWindow(conversationId, null);
				} else {
					if (window) await this.stopExactWindow(conversationId, window, false);
					else if (await this.exactWindows.inspect(conversationId)) throw new RelayRegistryError("invalid_state", "Refresh refused: an unattached process cannot be proven idle");
					await this.options.registry.setManagedWindow(conversationId, null);
				}
				await this.launchProject(manifest);
				return { operation: "conversation.refresh", targetConversationId: conversationId, conversationState: this.options.registry.conversationState(conversationId) };
			});
		} finally {
			this.options.registry.endRefresh(conversationId);
			if (this.options.registry.conversationState(conversationId) === "active") await this.options.generationReady?.(conversationId);
		}
	}

	private stop(conversationId: string): Promise<Record<string, unknown>> {
		const manifest = this.projectManifest(conversationId);
		return this.runWorktreeOperation(this.workspaceOperationKey(manifest.placement!), () => this.stopOnce(conversationId));
	}

	private async stopOnce(conversationId: string): Promise<Record<string, unknown>> {
		this.projectManifest(conversationId);
		const window = this.options.registry.managedWindow(conversationId);
		if (!window) throw new RelayRegistryError("invalid_state", "Active managed conversation has no exact window identity");
		const attachment = this.options.server.attachment(conversationId);
		const commandFeedback = this.options.registry.pendingInputs(conversationId).filter((input) => input.kind === "prompt" && input.body?.startsWith("/")).map((input) => input.deliveryId);
		await this.options.registry.cancelPendingInputs(conversationId);
		for (const operationId of commandFeedback) await this.options.endOperationFeedback?.(conversationId, operationId);
		if (attachment) this.options.server.sendToAttachment(attachment, { protocolVersion: "1.0.0", messageId: `relay-stop-${randomBytes(8).toString("hex")}`,
			conversationId, role: "relay", type: "termination.request", payload: { reason: "stop" } });
		await this.stopExactWindow(conversationId, window);
		// Retain the proof of the exited instance so later retirement can verify
		// absence rather than losing its only process identity.
		for (let attempt = 0; attempt < 20 && this.options.registry.conversationState(conversationId) !== "dormant"; attempt += 1) {
			await new Promise((resolveWait) => setTimeout(resolveWait, 50));
		}
		if (this.options.registry.conversationState(conversationId) !== "dormant") {
			throw new RelayRegistryError("invalid_state", "Managed adapter did not disconnect after exact window termination");
		}
		return { operation: "conversation.stop", targetConversationId: conversationId, conversationState: "dormant" };
	}

	private async delete(conversationId: string): Promise<Record<string, unknown>> {
		this.projectManifest(conversationId);
		if (!this.options.retireConversation) throw new RelayRegistryError("invalid_state", "Canonical retirement is unavailable");
		const retired = await this.options.retireConversation(conversationId);
		return { operation: "conversation.delete", targetConversationId: conversationId, retirementId: retired.retirementId,
			cleanupState: retired.cleanup?.some((effect) => effect.phase === "blocked") ? "failed" : retired.cleanup ? "pending" : "complete" };
	}

	private liveManifest(conversationId: string): ConversationManifest {
		const manifest = this.options.registry.manifestByConversationId(conversationId);
		if (!manifest) throw new RelayRegistryError("not_found", "Managed conversation was not found");
		return manifest;
	}

	private projectManifest(conversationId: string): ConversationManifest {
		const manifest = this.liveManifest(conversationId);
		if (manifest.kind !== "project") throw new RelayRegistryError("permission_denied", "Coordinator lifecycle cannot modify the guaranteed coordinator");
		return manifest;
	}

	private launchProject(manifest: ConversationManifest, existingNonce?: string, existingSessionFile?: string): Promise<void> {
		return this.launch(manifest.conversationId, (windowCreated) => this.launchProjectOnce(manifest, existingNonce, existingSessionFile, windowCreated));
	}

	private launch(conversationId: string, run: (windowCreated: () => void) => Promise<void>): Promise<void> {
		const inProgress = this.launches.get(conversationId);
		if (inProgress) return inProgress.ready;
		let windowCreated!: () => void; let windowFailed!: (error: unknown) => void;
		const window = new Promise<void>((resolve, reject) => { windowCreated = resolve; windowFailed = reject; });
		// Resume-only callers need not observe the earlier window promise.
		void window.catch(() => undefined);
		const ready = run(windowCreated)
			.catch((error) => { windowFailed(error); throw error; })
			.finally(() => { if (this.launches.get(conversationId)?.ready === ready) this.launches.delete(conversationId); });
		this.launches.set(conversationId, { window, ready });
		return ready;
	}

	private async launchProjectOnce(manifest: ConversationManifest, existingNonce?: string, existingSessionFile?: string, windowCreated?: () => void): Promise<void> {
		if (manifest.kind !== "project" || !manifest.placement) throw new RelayRegistryError("invalid_state", "Project launch requires project placement");
		const nonce = existingNonce ?? randomBytes(32).toString("base64url");
		const activeGeneration = this.options.registry.activeGeneration(manifest);
		const sessionFile = existingSessionFile ?? join(resolve(this.options.projectSessionDirectory), manifest.conversationId,
			activeGeneration.ordinal === 1 ? "session.jsonl" : `generation-${activeGeneration.ordinal}.jsonl`);
		const resolved = await this.invoke("workspace-resolve", manifest.placement);
		if (typeof resolved.cwd !== "string" || !isAbsolute(resolved.cwd) || typeof resolved.workspacePath !== "string" || !isAbsolute(resolved.workspacePath)) throw new RelayRegistryError("launch_failed", "Workspace launcher omitted canonical workspace paths");
		const root = await this.invoke("root-resolve", manifest.placement);
		if (typeof root.sessionName !== "string" || !root.sessionName) throw new RelayRegistryError("launch_failed", "Root launcher omitted its tmux session name");
		const session = await durableProjectSession(sessionFile, resolved.cwd, manifest.conversationId, manifest.creationKey, manifest.concept, activeGeneration.ordinal);
		if (session.sessionId !== manifest.piSessionId || session.boundaryEntryId !== manifest.bindingBoundaryEntryId) {
			throw new RelayRegistryError("invalid_state", "Project Pi session identity conflicts with the conversation manifest");
		}
		await this.options.registry.beginLaunch(manifest.conversationId);
		let attachmentTimedOut = false;
		let windowObserved = false;
		try {
			const inspected = await this.inspectProjectWindow(manifest, root.sessionName);
			let window: ManagedWindow;
			if (inspected) {
				window = inspected;
			} else {
				await this.options.registry.setManagedWindow(manifest.conversationId, null);
				const launch = await this.options.registry.prepareProjectLaunch(manifest.conversationId, nonce);
				const creator = new ExactWindowClient((operation, request) => this.invoke(operation, request, {
					PI_MANAGED_SESSION_LAUNCH_ROLE: "project", PI_MANAGED_SESSIONS_SOCKET: this.options.socketPath,
					PI_MANAGED_SESSION_CONVERSATION_ID: manifest.conversationId, PI_MANAGED_SESSION_CONCEPT: manifest.concept,
					PI_MANAGED_SESSION_BINDING_BOUNDARY_ENTRY_ID: manifest.bindingBoundaryEntryId,
					PI_MANAGED_SESSION_ATTACHMENT_NONCE: nonce, PI_MANAGED_PROJECT_SESSION_FILE: sessionFile,
					PI_MANAGED_SESSION_WORKSPACE_PATH: resolved.workspacePath as string,
					PI_MANAGED_SESSION_ROOT_KEY: manifest.placement!.rootKey,
					PI_MANAGED_SESSION_WORKSPACE: manifest.placement!.workspace,
					PI_MANAGED_SESSION_RELATIVE_CWD: manifest.placement!.relativeCwd,
					...((manifest.selectedModel ?? activeGeneration.model) ? { PI_MANAGED_SESSION_MODEL: manifest.selectedModel ?? activeGeneration.model } : {}),
					...((manifest.selectedThinking ?? activeGeneration.thinking) ? { PI_MANAGED_SESSION_THINKING: manifest.selectedThinking ?? activeGeneration.thinking } : {}),
				}));
				const ownership = await creator.create(manifest.conversationId, launch.launchId, manifest.placement);
				if (ownership.sessionName !== root.sessionName) throw new RelayRegistryError("launch_failed", "Created window changed its project session");
				window = { ...manifest.placement, conversationId: manifest.conversationId, role: "conversation", ownership,
					sessionName: ownership.sessionName, windowId: ownership.windowId, paneId: ownership.paneId };
			}
			await this.options.registry.setManagedWindow(manifest.conversationId, {
				sessionName: window.sessionName, windowId: window.windowId, paneId: window.paneId, ...(window.ownership ? { ownership: window.ownership } : {}),
			});
			windowObserved = true;
			windowCreated?.();
			const attachment = await waitForProjectAttachment({
				timeoutMs: this.options.attachmentTimeoutMs ?? PROJECT_ATTACHMENT_TIMEOUT_MS,
				state: () => this.options.registry.conversationState(manifest.conversationId),
				inspectWindow: async () => {
					const state = await this.exactWindows.check(window.ownership!);
					if (state === "changed") throw new RelayRegistryError("launch_failed", "Window ownership changed or a dead pane remains; inspect and close it manually before retry");
					return state === "match";
				},
			});
			if (attachment === "exited") throw new RelayRegistryError("launch_failed", "Managed project Pi exited before attachment");
			if (attachment === "timeout") {
				attachmentTimedOut = true;
				throw new RelayRegistryError("launch_failed", "Managed project Pi attachment timed out");
			}
		} catch (error) {
			const attached = this.options.registry.conversationState(manifest.conversationId) === "active";
			if (attached && windowObserved) return;
			// A live window that misses the deadline remains eligible to attach; terminating it
			// would race the adapter's active-state transition at the exact timeout boundary.
			if (attachmentTimedOut) {
				await this.options.registry.recordLaunchError(manifest.conversationId, "launch_failed", "Managed project Pi attachment timed out; inspect the retained window before retry");
				throw error;
			}
			// Failure is not cleanup consent. Preserve the failed pane and its proof;
			// manual closure plus verified process exit is required before retry.
			if (!attached) await this.options.registry.markDormant(manifest.conversationId);
			await this.options.registry.recordLaunchError(manifest.conversationId, "launch_failed", error instanceof Error ? error.message : "Project launch failed");
			throw error;
		}
	}

	private async inspectProjectWindow(manifest: ConversationManifest, expectedSessionName: string): Promise<ManagedWindow | undefined> {
		const persisted = this.options.registry.managedWindow(manifest.conversationId);
		const launch = this.options.registry.launchIdentity(manifest.conversationId);
		// A first admission can create the first tmux server/window. The launcher
		// independently rejects duplicate markers; no inspection error is treated as absence.
		if (!persisted && !launch) return undefined;
		let proof: ExactWindowProof | undefined;
		try { proof = await this.exactWindows.inspect(manifest.conversationId); }
		catch (error) {
			if (persisted?.ownership && await this.exactWindows.check(persisted.ownership) === "gone") return undefined;
			throw error;
		}
		if (!proof) {
			if (persisted) await this.stopExactWindow(manifest.conversationId, persisted, false);
			return undefined;
		}
		if (!proof.processBootId || proof.processStartTicks === undefined || proof.sessionName !== expectedSessionName ||
			(persisted ? !isDeepStrictEqual(persisted.ownership, proof) : !launch || launch.launchId !== proof.launchId || launch.generationId !== this.options.registry.activeGeneration(manifest).generationId))
			throw new RelayRegistryError("launch_failed", "Window has no matching durable exact ownership; inspect it manually");
		return { ...manifest.placement!, conversationId: manifest.conversationId, role: "conversation", ownership: proof,
			sessionName: proof.sessionName, windowId: proof.windowId, paneId: proof.paneId };
	}

	private async stopExactWindow(conversationId: string, window: Pick<ManagedWindow, "ownership" | "sessionName" | "windowId" | "paneId">, force = true): Promise<void> {
		if (!window.ownership) throw new RelayRegistryError("invalid_state", "Window has no exact process ownership; inspect it manually");
		assertExactWindowBinding(conversationId, window);
		const state = await this.exactWindows.check(window.ownership);
		if (state === "gone") return;
		if (state === "changed" || !force) throw new RelayRegistryError("invalid_state", "Window exit is unverified; inspect and close retained panes manually before retry");
		await this.exactWindows.terminate(window.ownership);
		if (await this.exactWindows.check(window.ownership) !== "gone") throw new RelayRegistryError("invalid_state", "Original process exit is unverified; cleanup remains pending");
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
