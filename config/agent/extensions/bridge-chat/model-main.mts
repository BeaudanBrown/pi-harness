import fs from "node:fs";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createChatSession, runQuestion } from "./model.mjs";
import { createQuestionServer, listenPrivate } from "./socket.js";
import type { WorkspacePolicy } from "./workspace-tools.mjs";
import { FileSession, type FilePolicy } from "./file-tools.mjs";
import { sweepFiles } from "./file-store.js";
import { WORKSPACE_TIMEOUT_MS, MODEL_TIMEOUT_MS } from "./socket.js";

async function main(): Promise<void> {
	process.umask(0o077);
	const [socketPath, authPath, model, policyPath] = process.argv.slice(2);
	const policy: (WorkspacePolicy & { files?: FilePolicy }) | undefined = policyPath ? JSON.parse(fs.readFileSync(policyPath, "utf8")) : undefined;
	if (policy && (typeof policy.socket !== "string" || !policy.socket.startsWith("/") || !policy.commands || typeof policy.commands !== "object" || Array.isArray(policy.commands) || Object.values(policy.commands).some(v => typeof v !== "string"))) throw Error("Workspace policy");
	if (policy?.files) {
		if (!policy.files.directory?.startsWith("/") || !policy.files.downloader?.startsWith("/nix/store/")) throw Error("File policy");
		const sweep = () => { try { sweepFiles(policy.files!.directory); } catch { console.error('{"event":"file_staging_full"}'); } };
		sweep(); setInterval(sweep, 3600000).unref();
	}
	if (!socketPath || !authPath || !/^[a-zA-Z0-9._-]{1,100}$/.test(model ?? "")) throw Error("Configuration");
	const st = fs.lstatSync(authPath);
	if (!st.isFile() || st.uid !== process.getuid?.() || (st.mode & 0o077)) throw Error("Existing Pi auth must be a private user-owned regular file");
	// Use Pi's real file and its normal shared sibling lock, never a copied token.
	// Disable custom model files, catalog IO, and availability scans of unrelated providers.
	const runtime = await ModelRuntime.create({ authPath, modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
	if (!(await runtime.listCredentials()).some(c => c.providerId === "openai-codex" && c.type === "oauth")) throw Error("Existing Pi Codex login required");
	const server = createQuestionServer(async (question, signal, workspace) => {
		if (workspace && !policy) throw Error("No approved workspace");
		const fileSession = policy?.files ? new FileSession(policy.files, workspace ? policy : undefined) : undefined;
		let success = false;
		const session = await createChatSession(runtime, model, process.cwd(), workspace ? policy : undefined, fileSession);
		try {
			const text = await runQuestion(session, question, signal, workspace || fileSession ? 24 : 4);
			const files = fileSession?.finish(true) ?? [];
			success = true;
			return files.length ? { text, files } : text;
		} finally { session.dispose(); if (!success) fileSession?.finish(false); }
	}, policy?.files ? WORKSPACE_TIMEOUT_MS : MODEL_TIMEOUT_MS);
	listenPrivate(server, socketPath);
}
void main().catch(() => { console.error("pi-chat-model: startup failed (details redacted)"); process.exitCode = 1; });
