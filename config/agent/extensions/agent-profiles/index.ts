import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { activeToolsForProfile, resolveAgentProfile, withProjectWorkerOptIn } from "./core.js";

export default function agentProfilesExtension(pi: ExtensionAPI): void {
	const name = process.env.PI_HARNESS_AGENT_PROFILE?.trim();
	if (!name) return;
	let profile = resolveAgentProfile(name);
	const projectTools = process.env.PI_HARNESS_PROJECT_WORKER_TOOLS?.trim();
	if (projectTools) {
		const parsed: unknown = JSON.parse(projectTools);
		if (!Array.isArray(parsed) || parsed.some((tool) => typeof tool !== "string")) throw new Error("PI_HARNESS_PROJECT_WORKER_TOOLS must be a JSON string array.");
		profile = withProjectWorkerOptIn(profile, { tools: parsed as string[] });
	}
	const apply = () => pi.setActiveTools(activeToolsForProfile(profile, pi.getActiveTools()));
	pi.on("session_start", apply);
	if (profile.systemPrompt) {
		pi.on("before_agent_start", (event) => ({ systemPrompt: `${event.systemPrompt}\n\n${profile.systemPrompt}` }));
	}
}
