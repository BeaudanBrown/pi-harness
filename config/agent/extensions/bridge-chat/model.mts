import {
	createAgentSession, createExtensionRuntime, defineTool, ModelRuntime, SessionManager, SettingsManager,
	type AgentSession, type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import { createWebSearchTool } from "../web-search/index.js";
import { MAX_ANSWER, MAX_QUESTION } from "./limits.js";

export const CHAT_SYSTEM_PROMPT = "You are Pi, a concise general assistant. Answer this question independently. Use web_search when helpful, especially for current facts, and cite source URLs for searched claims. You have no access to local files, shell, chats, previous requests or other tools. Never claim you performed actions outside web search.";
export const CHAT_TOOL_NAMES = Object.freeze(["web_search"]);

/** No default loader: nothing is discovered from the user's Pi directory or cwd. */
export function chatResources(): ResourceLoader {
	return {
		getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
		getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => CHAT_SYSTEM_PROMPT, getSystemPromptSource: () => undefined,
		getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [],
		extendResources: () => {}, reload: async () => {},
	};
}
export async function createChatSession(runtime: ModelRuntime, modelId: string, cwd: string): Promise<AgentSession> {
	const model = runtime.getModel("openai-codex", modelId);
	if (!model) throw Error("Configured Pi model unavailable");
	const search = createWebSearchTool(undefined, async (_ctx, signal) => (await runtime.getAuth("openai-codex", { signal }))?.auth.apiKey);
	const restrictedSearch = defineTool({ ...search, execute: async (...args: Parameters<typeof search.execute>) => {
		try {
			return await search.execute(...args);
		} catch { throw Error("Web search unavailable"); }
	} });
	const { session } = await createAgentSession({
		cwd, agentDir: cwd, model, modelRuntime: runtime, thinkingLevel: "off",
		noTools: "builtin", tools: [...CHAT_TOOL_NAMES],
		customTools: [restrictedSearch],
		sessionManager: SessionManager.inMemory(cwd),
		settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
		resourceLoader: chatResources(),
	});
	if (JSON.stringify(session.agent.state.tools.map(t => t.name)) !== JSON.stringify(CHAT_TOOL_NAMES) || session.sessionFile || session.messages.length) {
		session.dispose(); throw Error("Chat capability invariant failed");
	}
	return session;
}
export async function runQuestion(session: AgentSession, question: string, signal: AbortSignal): Promise<string> {
	if (!question.trim() || Buffer.byteLength(question) > MAX_QUESTION || session.messages.length) throw Error("Invalid fresh request");
	let turns = 0, bytes = 0;
	const abort = () => { void session.abort().catch(() => {}); };
	const unsubscribe = session.subscribe(event => {
		if (event.type === "turn_start" && ++turns > 4) abort();
		if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
			bytes += Buffer.byteLength(event.assistantMessageEvent.delta);
			if (bytes > MAX_ANSWER) abort();
		}
	});
	signal.addEventListener("abort", abort, { once: true });
	try {
		signal.throwIfAborted();
		await session.prompt(question, { expandPromptTemplates: false });
		signal.throwIfAborted();
		if (turns > 4 || bytes > MAX_ANSWER) throw Error("Chat budget exceeded");
		const last = session.messages.at(-1);
		if (!last || last.role !== "assistant" || last.stopReason !== "stop") throw Error("Incomplete answer");
		const text = last.content.filter(p => p.type === "text").map(p => p.text).join("\n").trim();
		if (!text || Buffer.byteLength(text) > MAX_ANSWER) throw Error("Answer size");
		return text;
	} finally { signal.removeEventListener("abort", abort); unsubscribe(); }
}
