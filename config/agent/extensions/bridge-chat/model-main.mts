import fs from "node:fs";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createChatSession, runQuestion } from "./model.mjs";
import { createQuestionServer, listenPrivate } from "./socket.js";

async function main(): Promise<void> {
	process.umask(0o077);
	const [socketPath, authPath, model] = process.argv.slice(2);
	if (!socketPath || !authPath || !/^[a-zA-Z0-9._-]{1,100}$/.test(model ?? "")) throw Error("Configuration");
	const st = fs.lstatSync(authPath);
	if (!st.isFile() || st.uid !== process.getuid?.() || (st.mode & 0o077)) throw Error("Existing Pi auth must be a private user-owned regular file");
	// Use Pi's real file and its normal shared sibling lock, never a copied token.
	// Disable custom model files, catalog IO, and availability scans of unrelated providers.
	const runtime = await ModelRuntime.create({ authPath, modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
	if (!(await runtime.listCredentials()).some(c => c.providerId === "openai-codex" && c.type === "oauth")) throw Error("Existing Pi Codex login required");
	const server = createQuestionServer(async (question, signal) => {
		const session = await createChatSession(runtime, model, process.cwd());
		try { return await runQuestion(session, question, signal); }
		finally { session.dispose(); }
	});
	listenPrivate(server, socketPath);
}
void main().catch(() => { console.error("pi-chat-model: startup failed (details redacted)"); process.exitCode = 1; });
