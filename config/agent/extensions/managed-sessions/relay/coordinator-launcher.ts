import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parseExactWindowProof, assertExactWindowBinding, type ExactWindowProof } from "../exact-window-contracts.js";
import { ExactWindowClient } from "./exact-window-client.js";
import type { ConversationManifest } from "../contracts.js";
import { RelayRegistry, RelayRegistryError } from "./registry.js";

function safeJsonObject(value: string, label: string): Record<string, unknown> {
	let parsed: unknown;
	try { parsed = JSON.parse(value); } catch { throw new RelayRegistryError("launch_failed", `${label} returned invalid JSON`); }
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new RelayRegistryError("launch_failed", `${label} returned an invalid object`);
	return parsed as Record<string, unknown>;
}

function parseWindow(value: string, expectedConversationId: string, launchId: string): ExactWindowProof {
	const result = safeJsonObject(value, "Coordinator launcher");
	if (result.conversationId !== expectedConversationId || result.role !== "coordinator" || result.sessionName !== "default" ||
		typeof result.windowId !== "string" || !/^@[0-9]+$/.test(result.windowId) ||
		typeof result.paneId !== "string" || !/^%[0-9]+$/.test(result.paneId) ||
		Object.keys(result).some((key) => !["conversationId", "sessionName", "windowId", "paneId", "role", "ownership"].includes(key))) {
		throw new RelayRegistryError("launch_failed", "Coordinator launcher returned an invalid managed window");
	}
	const proof = parseExactWindowProof(result.ownership);
	assertExactWindowBinding(expectedConversationId, { sessionName: result.sessionName, windowId: result.windowId, paneId: result.paneId, ownership: proof });
	if (proof.launchId !== launchId || !proof.processBootId || !proof.processStartTicks) throw new RelayRegistryError("launch_failed", "Coordinator launch changed its reserved identity");
	return proof;
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
}): Promise<ExactWindowProof> {
	if (!isAbsolute(options.launcher)) throw new Error("Coordinator launcher must be an absolute executable path");
	if (options.manifest.kind !== "coordinator") throw new RelayRegistryError("permission_denied", "Only the coordinator can use the coordinator launcher");
	const launcherEnvironment = { ...options.environment };
	for (const name of Object.keys(launcherEnvironment)) if (name.startsWith("PI_MATRIX_")) delete launcherEnvironment[name];
	const conversationId = options.manifest.conversationId;
	const exact = new ExactWindowClient(async (operation, request) => safeJsonObject(await invokeLauncher(options.launcher, operation, request, launcherEnvironment), operation));
	const saved = options.registry.managedWindow(conversationId);
	const launchIdentity = options.registry.launchIdentity(conversationId);
	let existing: ExactWindowProof | undefined;
	if (saved || launchIdentity) {
		try { existing = await exact.inspect(conversationId); }
		catch (error) {
			if (!saved?.ownership || await exact.check(saved.ownership) !== "gone") throw error;
		}
	}
	if (existing) {
		const launch = launchIdentity;
		if (existing.sessionName !== "default" || !existing.processBootId || !existing.processStartTicks ||
			(saved ? !isDeepStrictEqual(saved.ownership, existing) : !launch || launch.launchId !== existing.launchId)) {
			throw new RelayRegistryError("launch_failed", "Coordinator window has no matching durable exact ownership; inspect it manually");
		}
		await options.registry.setManagedWindow(conversationId, { sessionName: existing.sessionName, windowId: existing.windowId, paneId: existing.paneId, ownership: existing });
		return existing;
	}
	if (saved && (!saved.ownership || await exact.check(saved.ownership) !== "gone")) throw new RelayRegistryError("launch_failed", "Coordinator process exit is unverified; inspect retained panes manually");
	await options.registry.setManagedWindow(conversationId, null);
	const nonce = randomBytes(32).toString("base64url");
	const launch = await options.registry.prepareProjectLaunch(conversationId, nonce);
	const request = { conversationId, launchId: launch.launchId };
	const window = parseWindow(await invokeLauncher(options.launcher, "coordinator-ensure-exact", request, {
		...launcherEnvironment,
		PI_MANAGED_SESSION_LAUNCH_ROLE: "coordinator",
		PI_MANAGED_SESSIONS_SOCKET: options.socketPath,
		PI_MANAGED_SESSION_CONVERSATION_ID: options.manifest.conversationId,
		PI_MANAGED_SESSION_CONCEPT: options.manifest.concept,
		PI_MANAGED_SESSION_BINDING_BOUNDARY_ENTRY_ID: options.manifest.bindingBoundaryEntryId,
		PI_MANAGED_SESSION_ATTACHMENT_NONCE: nonce,
		PI_MANAGED_COORDINATOR_SESSION_FILE: options.sessionFile,
		PI_MANAGED_COORDINATOR_CWD: options.workspaceDirectory,
		...(options.manifest.selectedModel ? { PI_MANAGED_SESSION_MODEL: options.manifest.selectedModel } : {}),
		...(options.manifest.selectedThinking ? { PI_MANAGED_SESSION_THINKING: options.manifest.selectedThinking } : {}),
	}), conversationId, launch.launchId);
	await options.registry.setManagedWindow(conversationId, { sessionName: window.sessionName, windowId: window.windowId, paneId: window.paneId, ownership: window });
	return window;
}
