import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, lstat, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
	MANAGED_SESSION_STATE_VERSION,
	deriveConversationId,
	deriveTranscriptEntryId,
	type ConversationManifest,
	type ManagedSessionEnvelope,
	type WorkspaceIdentity,
} from "../contracts.js";
import { ensurePrivateDirectory } from "./atomic-json.js";
import { ManagedSessionIpcServer } from "./ipc-server.js";
import { ManagedMatrixClient } from "./matrix-client.js";
import { RelayRegistry, RelayRegistryError } from "./registry.js";

interface ManagedWindow {
	conversationId: string;
	sessionName: string;
	windowId: string;
	paneId: string;
	rootKey: string;
	workspace: string;
	relativeCwd: string;
	role: "conversation";
}

interface ResolvedWorkspace extends WorkspaceIdentity {
	workspacePath: string;
	cwd: string;
}

function safeJsonObject(value: string, failure: string): Record<string, unknown> {
	let parsed: unknown;
	try { parsed = JSON.parse(value); } catch { throw new RelayRegistryError("launch_failed", failure); }
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new RelayRegistryError("launch_failed", failure);
	return parsed as Record<string, unknown>;
}

async function durableProjectSession(path: string, cwd: string, conversationId: string, creationKey: string, concept: string): Promise<{ sessionId: string; boundaryEntryId: string }> {
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
			data?.version !== MANAGED_SESSION_STATE_VERSION || data.creationKey !== creationKey || data.concept !== concept || data.sessionId !== header.id) {
			throw new RelayRegistryError("invalid_state", "Existing project Pi session does not match its durable binding identity");
		}
		if ((info.mode & 0o077) !== 0) await chmod(path, 0o600);
		return { sessionId: header.id, boundaryEntryId: deriveTranscriptEntryId(header.id, boundary.id) };
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
	}
	const sessionId = `managed-${conversationId.slice(5)}`;
	const boundaryKey = `managed-boundary-${conversationId.slice(5)}`;
	const now = new Date().toISOString();
	const entries = [
		{ type: "session", version: 3, id: sessionId, timestamp: now, cwd },
		{ type: "custom", id: boundaryKey, parentId: null, timestamp: now, customType: "managed-session.binding-boundary",
			data: { version: MANAGED_SESSION_STATE_VERSION, creationKey, concept, sessionId } },
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

	constructor(private readonly options: {
		hostId: string;
		launcher: string;
		projectSessionDirectory: string;
		socketPath: string;
		registry: RelayRegistry;
		matrix: ManagedMatrixClient;
		server: ManagedSessionIpcServer;
		environment?: NodeJS.ProcessEnv;
	}) {
		if (!isAbsolute(options.launcher)) throw new Error("Managed lifecycle launcher must be absolute");
	}

	async request(envelope: ManagedSessionEnvelope): Promise<Record<string, unknown>> {
		if (envelope.role !== "coordinator_adapter" || envelope.type !== "lifecycle.request") throw new RelayRegistryError("permission_denied", "Coordinator lifecycle capability is required");
		const request = envelope.payload.request as Record<string, unknown>;
		switch (request.operation) {
			case "workspace.list": return { operation: "workspace.list", workspaces: await this.workspaceList() };
			case "conversation.list": return { operation: "conversation.list", conversations: this.options.registry.listConversations() };
			case "conversation.status": return this.status(String(request.targetConversationId));
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

	async wake(manifest: ConversationManifest): Promise<void> {
		if (manifest.kind === "coordinator") throw new RelayRegistryError("permission_denied", "Coordinator wake uses its dedicated launcher");
		await this.launchProject(manifest);
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

	private async start(request: { creationKey: string; concept: string; placement: WorkspaceIdentity; projectSpace?: string }): Promise<Record<string, unknown>> {
		const conversationId = deriveConversationId(this.options.hostId, request.creationKey);
		const existing = this.options.registry.manifestByCreationKey(request.creationKey);
		if (existing) {
			if (existing.kind !== "project" || existing.conversationId !== conversationId || existing.concept !== request.concept ||
				JSON.stringify(existing.placement) !== JSON.stringify(request.placement)) throw new RelayRegistryError("invalid_state", "Conversation start retry conflicts with existing identity");
			await this.resume(existing.conversationId);
			return { operation: "conversation.start", targetConversationId: existing.conversationId, conversationState: this.options.registry.conversationState(existing.conversationId) };
		}
		if (this.options.registry.listManifests().some((item) => item.concept === request.concept)) throw new RelayRegistryError("invalid_state", "Managed conversation concept already exists on this host");
		const resolvedValue = await this.invoke("workspace-resolve", request.placement);
		const resolved = resolvedValue as unknown as ResolvedWorkspace;
		if (resolved.rootKey !== request.placement.rootKey || resolved.workspace !== request.placement.workspace || resolved.relativeCwd !== request.placement.relativeCwd ||
			typeof resolved.cwd !== "string" || !isAbsolute(resolved.cwd) || typeof resolved.workspacePath !== "string" || !isAbsolute(resolved.workspacePath)) {
			throw new RelayRegistryError("launch_failed", "Workspace launcher returned an invalid canonical placement");
		}
		await this.invoke("root-ensure", request.placement);
		const sessionFile = join(resolve(this.options.projectSessionDirectory), conversationId, "session.jsonl");
		const session = await durableProjectSession(sessionFile, resolved.cwd, conversationId, request.creationKey, request.concept);
		const coordinator = this.options.registry.listManifests().find((item) => item.kind === "coordinator");
		let projectSpace = request.projectSpace ? undefined : this.options.registry.listManifests().find((item) => item.kind === "project" &&
			item.placement?.rootKey === request.placement.rootKey && item.placement.workspace === request.placement.workspace)?.projectSpace;
		let createdSpace = false;
		if (!projectSpace) { projectSpace = await this.options.matrix.createPrivateSpace(request.projectSpace || request.placement.workspace); createdSpace = true; }
		let roomId: string | undefined;
		let registered = false;
		try {
			if (createdSpace && coordinator?.kind === "coordinator" && coordinator.hostSpace) await this.options.matrix.addSpaceChild(coordinator.hostSpace, projectSpace);
			roomId = await this.options.matrix.createPrivateRoom(`pi · ${request.concept}`);
			await this.options.matrix.addSpaceChild(projectSpace, roomId);
			const nonce = randomBytes(32).toString("base64url");
			const manifest: ConversationManifest = {
				schemaVersion: MANAGED_SESSION_STATE_VERSION, kind: "project", conversationId, ownerHostId: this.options.hostId,
				creationKey: request.creationKey, concept: request.concept, piSessionId: session.sessionId, roomId,
				placement: request.placement, projectSpace, bindingBoundaryEntryId: session.boundaryEntryId, createdAt: new Date().toISOString(),
			};
			await this.options.registry.createProjectConversation(manifest, nonce);
			registered = true;
			await this.launchProject(manifest, nonce, sessionFile);
			return { operation: "conversation.start", targetConversationId: conversationId, conversationState: this.options.registry.conversationState(conversationId) };
		} catch (error) {
			if (!registered) {
				if (roomId) await this.options.matrix.leaveRoom(roomId).catch(() => undefined);
				if (createdSpace && projectSpace) await this.options.matrix.leaveRoom(projectSpace).catch(() => undefined);
			}
			throw error;
		}
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
		await this.options.registry.cancelPendingInputs(conversationId);
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
		const sessionFile = existingSessionFile ?? join(resolve(this.options.projectSessionDirectory), manifest.conversationId, "session.jsonl");
		const resolved = await this.invoke("workspace-resolve", manifest.placement);
		if (typeof resolved.cwd !== "string" || !isAbsolute(resolved.cwd)) throw new RelayRegistryError("launch_failed", "Workspace launcher omitted canonical cwd");
		const root = await this.invoke("root-ensure", manifest.placement);
		if (typeof root.sessionName !== "string" || !root.sessionName) throw new RelayRegistryError("launch_failed", "Root launcher omitted its tmux session name");
		const session = await durableProjectSession(sessionFile, resolved.cwd, manifest.conversationId, manifest.creationKey, manifest.concept);
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
				});
				window = this.parseWindow(result, manifest);
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

	private parseWindow(result: Record<string, unknown>, manifest: ConversationManifest): ManagedWindow {
		const placement = manifest.placement!;
		if (result.conversationId !== manifest.conversationId || result.role !== "conversation" || typeof result.sessionName !== "string" ||
			typeof result.windowId !== "string" || !/^@[0-9]+$/.test(result.windowId) || typeof result.paneId !== "string" || !/^%[0-9]+$/.test(result.paneId) ||
			result.rootKey !== placement.rootKey || result.workspace !== placement.workspace || result.relativeCwd !== placement.relativeCwd) {
			throw new RelayRegistryError("launch_failed", "Project launcher returned an invalid managed window");
		}
		return {
			conversationId: manifest.conversationId, sessionName: result.sessionName, windowId: result.windowId, paneId: result.paneId,
			rootKey: placement.rootKey, workspace: placement.workspace, relativeCwd: placement.relativeCwd, role: "conversation",
		} as ManagedWindow;
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
