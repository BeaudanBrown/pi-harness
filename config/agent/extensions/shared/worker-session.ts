import type { ResourceLoader } from "@earendil-works/pi-coding-agent";
import { resolveAgentProfile } from "../agent-profiles/core.js";

export function workerResourceLoader(name: "review-worker" | "diagnostic-worker", createRuntime: () => ReturnType<ResourceLoader["getExtensions"]>["runtime"]): ResourceLoader {
	const profile = resolveAgentProfile(name);
	return {
		getExtensions: () => ({ extensions: [], errors: [], runtime: createRuntime() }),
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => profile.systemPrompt,
		getSystemPromptSource: () => undefined,
		getAppendSystemPrompt: () => [],
		getAppendSystemPromptSources: () => [],
		extendResources: () => {},
		reload: async () => {},
	};
}

export function extractAssistantText(session: { messages: unknown[] }): string {
	for (const message of [...session.messages].reverse() as Array<{ role?: string; content?: unknown }>) {
		if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
		const parts = message.content.flatMap(part => typeof part === "string" ? [part] :
			part?.type === "text" && typeof part.text === "string" ? [part.text] : []);
		if (parts.length) return parts.join("\n").trim();
	}
	return "";
}
