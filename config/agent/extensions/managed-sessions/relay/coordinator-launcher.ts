import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import type { ConversationManifest } from "../contracts.js";
import { RelayRegistry, RelayRegistryError } from "./registry.js";

interface WindowResult {
	sessionName: string;
	windowId: string;
	paneId: string;
}

function safeJsonObject(value: string, label: string): Record<string, unknown> {
	let parsed: unknown;
	try { parsed = JSON.parse(value); } catch { throw new RelayRegistryError("launch_failed", `${label} returned invalid JSON`); }
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new RelayRegistryError("launch_failed", `${label} returned an invalid object`);
	return parsed as Record<string, unknown>;
}

function parseWindow(value: string, expectedConversationId: string): WindowResult {
	const result = safeJsonObject(value, "Coordinator launcher");
	if (result.conversationId !== expectedConversationId || result.role !== "coordinator" || result.sessionName !== "default" ||
		typeof result.windowId !== "string" || !/^@[0-9]+$/.test(result.windowId) ||
		typeof result.paneId !== "string" || !/^%[0-9]+$/.test(result.paneId) ||
		Object.keys(result).some((key) => !["conversationId", "sessionName", "windowId", "paneId", "role"].includes(key))) {
		throw new RelayRegistryError("launch_failed", "Coordinator launcher returned an invalid managed window");
	}
	return { sessionName: result.sessionName, windowId: result.windowId, paneId: result.paneId };
}

function parseInspection(value: string, expectedConversationId: string): WindowResult | undefined {
	const result = safeJsonObject(value, "Managed window inspection");
	if (result.conversationId !== expectedConversationId || typeof result.exists !== "boolean") {
		throw new RelayRegistryError("launch_failed", "Managed window inspection returned invalid identity");
	}
	if (!result.exists) {
		if (Object.keys(result).some((key) => !["conversationId", "exists"].includes(key))) {
			throw new RelayRegistryError("launch_failed", "Managed window inspection returned invalid absence");
		}
		return undefined;
	}
	if (result.sessionName !== "default" || typeof result.windowId !== "string" || !/^@[0-9]+$/.test(result.windowId) ||
		typeof result.paneId !== "string" || !/^%[0-9]+$/.test(result.paneId) ||
		Object.keys(result).some((key) => !["conversationId", "exists", "sessionName", "windowId", "paneId"].includes(key))) {
		throw new RelayRegistryError("launch_failed", "Managed window inspection returned an invalid coordinator window");
	}
	return { sessionName: "default", windowId: result.windowId, paneId: result.paneId };
}

async function invokeLauncher(launcher: string, operation: string, request: object, environment: NodeJS.ProcessEnv): Promise<string> {
	const child = spawn(launcher, ["managed", operation], { stdio: ["pipe", "pipe", "pipe"], env: environment });
	child.stdin.end(`${JSON.stringify(request)}\n`);
	let stdout = "";
	let stderr = "";
	const limit = 64 * 1024;
	child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => { stdout += chunk; if (Buffer.byteLength(stdout) > limit) child.kill("SIGKILL"); });
	child.stderr.on("data", (chunk: string) => { stderr += chunk; if (Buffer.byteLength(stderr) > limit) child.kill("SIGKILL"); });
	const code = await new Promise<number | null>((resolve, reject) => {
		const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new RelayRegistryError("launch_failed", `Managed ${operation} timed out`)); }, 15_000);
		child.once("error", (error) => { clearTimeout(timer); reject(new RelayRegistryError("launch_failed", `Managed ${operation} failed: ${error.message}`)); });
		child.once("close", (status) => { clearTimeout(timer); resolve(status); });
	});
	if (code !== 0) throw new RelayRegistryError("launch_failed", `Managed ${operation} exited ${code ?? "without status"}`);
	return stdout;
}

export async function launchCoordinator(options: {
	launcher: string;
	manifest: ConversationManifest;
	sessionFile: string;
	workspaceDirectory: string;
	socketPath: string;
	registry: RelayRegistry;
	environment?: NodeJS.ProcessEnv;
}): Promise<void> {
	if (!isAbsolute(options.launcher)) throw new Error("Coordinator launcher must be an absolute executable path");
	if (options.manifest.kind !== "coordinator") throw new RelayRegistryError("permission_denied", "Only the coordinator can use the coordinator launcher");
	const launcherEnvironment = { ...options.environment };
	for (const name of Object.keys(launcherEnvironment)) if (name.startsWith("PI_MATRIX_")) delete launcherEnvironment[name];
	const request = { conversationId: options.manifest.conversationId };
	const existing = parseInspection(await invokeLauncher(options.launcher, "window-inspect", request, launcherEnvironment), options.manifest.conversationId);
	if (existing) {
		await options.registry.setManagedWindow(options.manifest.conversationId, existing);
		return;
	}
	const nonce = randomBytes(32).toString("base64url");
	await options.registry.setAttachmentNonce(options.manifest.conversationId, nonce);
	const window = parseWindow(await invokeLauncher(options.launcher, "coordinator-ensure", request, {
		...launcherEnvironment,
		PI_MANAGED_SESSION_LAUNCH_ROLE: "coordinator",
		PI_MANAGED_SESSIONS_SOCKET: options.socketPath,
		PI_MANAGED_SESSION_CONVERSATION_ID: options.manifest.conversationId,
		PI_MANAGED_SESSION_CONCEPT: options.manifest.concept,
		PI_MANAGED_SESSION_BINDING_BOUNDARY_ENTRY_ID: options.manifest.bindingBoundaryEntryId,
		PI_MANAGED_SESSION_ATTACHMENT_NONCE: nonce,
		PI_MANAGED_COORDINATOR_SESSION_FILE: options.sessionFile,
		PI_MANAGED_COORDINATOR_CWD: options.workspaceDirectory,
	}), options.manifest.conversationId);
	await options.registry.setManagedWindow(options.manifest.conversationId, window);
}
