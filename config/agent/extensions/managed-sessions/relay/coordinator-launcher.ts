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

function parseWindow(value: string, expectedConversationId: string): WindowResult {
	let parsed: unknown;
	try { parsed = JSON.parse(value); } catch { throw new RelayRegistryError("launch_failed", "Coordinator launcher returned invalid JSON"); }
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new RelayRegistryError("launch_failed", "Coordinator launcher returned an invalid window");
	const result = parsed as Record<string, unknown>;
	if (result.conversationId !== expectedConversationId || result.role !== "coordinator" || result.sessionName !== "default" ||
		typeof result.windowId !== "string" || !/^@[0-9]+$/.test(result.windowId) ||
		typeof result.paneId !== "string" || !/^%[0-9]+$/.test(result.paneId) ||
		Object.keys(result).some((key) => !["conversationId", "sessionName", "windowId", "paneId", "role", "rootKey", "workspace", "relativeCwd"].includes(key))) {
		throw new RelayRegistryError("launch_failed", "Coordinator launcher returned an invalid managed window");
	}
	return { sessionName: result.sessionName, windowId: result.windowId, paneId: result.paneId };
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
	const nonce = randomBytes(32).toString("base64url");
	await options.registry.setAttachmentNonce(options.manifest.conversationId, nonce);
	const launcherEnvironment = { ...options.environment };
	for (const name of Object.keys(launcherEnvironment)) {
		if (name.startsWith("PI_MATRIX_")) delete launcherEnvironment[name];
	}
	const child = spawn(options.launcher, ["managed", "coordinator-ensure"], {
		stdio: ["pipe", "pipe", "pipe"],
		env: {
			...launcherEnvironment,
			PI_MANAGED_SESSION_LAUNCH_ROLE: "coordinator",
			PI_MANAGED_SESSIONS_SOCKET: options.socketPath,
			PI_MANAGED_SESSION_CONVERSATION_ID: options.manifest.conversationId,
			PI_MANAGED_SESSION_CONCEPT: options.manifest.concept,
			PI_MANAGED_SESSION_BINDING_BOUNDARY_ENTRY_ID: options.manifest.bindingBoundaryEntryId,
			PI_MANAGED_SESSION_ATTACHMENT_NONCE: nonce,
			PI_MANAGED_COORDINATOR_SESSION_FILE: options.sessionFile,
			PI_MANAGED_COORDINATOR_CWD: options.workspaceDirectory,
		},
	});
	child.stdin.end(`${JSON.stringify({ conversationId: options.manifest.conversationId })}\n`);
	let stdout = "";
	let stderr = "";
	const limit = 64 * 1024;
	child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => { stdout += chunk; if (Buffer.byteLength(stdout) > limit) child.kill("SIGKILL"); });
	child.stderr.on("data", (chunk: string) => { stderr += chunk; if (Buffer.byteLength(stderr) > limit) child.kill("SIGKILL"); });
	const code = await new Promise<number | null>((resolve, reject) => {
		const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new RelayRegistryError("launch_failed", "Coordinator launcher timed out")); }, 15_000);
		child.once("error", (error) => { clearTimeout(timer); reject(new RelayRegistryError("launch_failed", `Coordinator launcher failed: ${error.message}`)); });
		child.once("close", (status) => { clearTimeout(timer); resolve(status); });
	});
	if (code !== 0) throw new RelayRegistryError("launch_failed", `Coordinator launcher exited ${code ?? "without status"}`);
	await options.registry.setManagedWindow(options.manifest.conversationId, parseWindow(stdout, options.manifest.conversationId));
}
