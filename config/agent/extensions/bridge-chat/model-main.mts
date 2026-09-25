import fs from "node:fs";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createChatSession, runQuestion } from "./model.mjs";
import { createQuestionServer, listenPrivate } from "./socket.js";
import type { WorkspacePolicy } from "./workspace-tools.mjs";

async function main(): Promise<void> {
	process.umask(0o077);
	const [socketPath, authPath, model, policyPath] = process.argv.slice(2);
	const policy: WorkspacePolicy | undefined = policyPath ? JSON.parse(fs.readFileSync(policyPath, "utf8")) : undefined;
	if (policy && (typeof policy.socket !== "string" || !policy.socket.startsWith("/") || !policy.commands || typeof policy.commands !== "object" || Array.isArray(policy.commands) || Object.values(policy.commands).some(v => typeof v !== "string"))) throw Error("Workspace policy");
	if (!socketPath || !authPath || !/^[a-zA-Z0-9._-]{1,100}$/.test(model ?? "")) throw Error("Configuration");
	const st = fs.lstatSync(authPath);
	if (!st.isFile() || st.uid !== process.getuid?.() || (st.mode & 0o077)) throw Error("Existing Pi auth must be a private user-owned regular file");
	// Use Pi's real file and its normal shared sibling lock, never a copied token.
	// Disable custom model files, catalog IO, and availability scans of unrelated providers.
	const runtime = await ModelRuntime.create({ authPath, modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
	if (!(await runtime.listCredentials()).some(c => c.providerId === "openai-codex" && c.type === "oauth")) throw Error("Existing Pi Codex login required");
	const server = createQuestionServer(async (question, signal, workspace) => {
		if (workspace && !policy) throw Error("No approved workspace");
		const session = await createChatSession(runtime, model, process.cwd(), workspace ? policy : undefined);
		try { return await runQuestion(session, question, signal, workspace ? 24 : 4); }
		finally { session.dispose(); }
	});
	listenPrivate(server, socketPath);
}
void main().catch(() => { console.error("pi-chat-model: startup failed (details redacted)"); process.exitCode = 1; });
