import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";

export const AGENT_PROFILE_NAMES = [
	"engineering-full",
	"aloop-implementation",
	"aloop-patch",
	"review-worker",
	"diagnostic-worker",
	"managed-coordinator",
	"pi-local",
] as const;

export type AgentProfileName = typeof AGENT_PROFILE_NAMES[number];
export type AgentToolPolicy = "extension-defaults" | "allowlist";
export type ProjectResourcePolicy = "discovery" | "aloop-opt-in" | "none";

export type AgentProfile = {
	name: AgentProfileName;
	extensions: string[];
	skills: string[];
	prompts: string[];
	themes: string[];
	contextFiles: boolean;
	builtinTools: boolean;
	projectResourcePolicy: ProjectResourcePolicy;
	toolPolicy: AgentToolPolicy;
	systemPrompt: string;
	tools: string[];
	inactiveTools: string[];
};

type RawProfile = Omit<AgentProfile, "name" | "inactiveTools">;
type RawVariant = {
	base: AgentProfileName;
	excludeExtensions?: string[];
	excludeSkills?: string[];
	excludePrompts?: string[];
	excludeThemes?: string[];
	inactiveTools?: string[];
};
type ProfileDocument = {
	version: 1;
	profiles: Record<AgentProfileName, RawProfile>;
	variants: Record<string, RawVariant>;
};

const DEFAULT_PROFILE_PATH = path.resolve(__dirname, "../../profiles.json");

function defaultProfilePath(): string {
	const configured = process.env.PI_HARNESS_AGENT_PROFILES?.trim();
	if (configured) return path.resolve(configured);
	if (existsSync(DEFAULT_PROFILE_PATH)) return DEFAULT_PROFILE_PATH;
	return path.resolve(process.cwd(), "config/agent/profiles.json");
}

function stringArray(value: unknown, field: string): string[] {
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
		throw new Error(`Agent profile ${field} must be an array of non-empty strings.`);
	}
	return [...new Set(value as string[])];
}

function parseProfile(value: unknown, name: AgentProfileName): RawProfile {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Agent profile ${name} is malformed.`);
	const input = value as Record<string, unknown>;
	if (input.toolPolicy !== "extension-defaults" && input.toolPolicy !== "allowlist") throw new Error(`Agent profile ${name} has an invalid tool policy.`);
	if (input.projectResourcePolicy !== "discovery" && input.projectResourcePolicy !== "aloop-opt-in" && input.projectResourcePolicy !== "none") {
		throw new Error(`Agent profile ${name} has an invalid project resource policy.`);
	}
	if (typeof input.contextFiles !== "boolean" || typeof input.builtinTools !== "boolean") throw new Error(`Agent profile ${name} has invalid context/tool flags.`);
	if (typeof input.systemPrompt !== "string" || input.systemPrompt.length > 8_000) throw new Error(`Agent profile ${name} has an invalid system prompt.`);
	const tools = stringArray(input.tools, `${name}.tools`);
	if (input.toolPolicy === "allowlist" && tools.length === 0) throw new Error(`Agent profile ${name} requires a non-empty tool allowlist.`);
	return {
		extensions: stringArray(input.extensions, `${name}.extensions`),
		skills: stringArray(input.skills, `${name}.skills`),
		prompts: stringArray(input.prompts, `${name}.prompts`),
		themes: stringArray(input.themes, `${name}.themes`),
		contextFiles: input.contextFiles,
		builtinTools: input.builtinTools,
		projectResourcePolicy: input.projectResourcePolicy,
		toolPolicy: input.toolPolicy,
		systemPrompt: input.systemPrompt,
		tools,
	};
}

export function parseAgentProfileDocument(value: unknown): ProfileDocument {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Agent profile document is malformed.");
	const input = value as Record<string, unknown>;
	if (input.version !== 1 || !input.profiles || typeof input.profiles !== "object" || Array.isArray(input.profiles)) {
		throw new Error("Agent profile document must use version 1 and declare profiles.");
	}
	const rawProfiles = input.profiles as Record<string, unknown>;
	const profiles = {} as Record<AgentProfileName, RawProfile>;
	for (const name of AGENT_PROFILE_NAMES) profiles[name] = parseProfile(rawProfiles[name], name);
	const variants: Record<string, RawVariant> = {};
	if (!input.variants || typeof input.variants !== "object" || Array.isArray(input.variants)) throw new Error("Agent profile variants are malformed.");
	for (const [name, candidate] of Object.entries(input.variants as Record<string, unknown>)) {
		if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error(`Agent profile variant ${name} is malformed.`);
		const variant = candidate as Record<string, unknown>;
		if (!AGENT_PROFILE_NAMES.includes(variant.base as AgentProfileName)) throw new Error(`Agent profile variant ${name} has an unknown base.`);
		variants[name] = {
			base: variant.base as AgentProfileName,
			excludeExtensions: stringArray(variant.excludeExtensions ?? [], `${name}.excludeExtensions`),
			excludeSkills: stringArray(variant.excludeSkills ?? [], `${name}.excludeSkills`),
			excludePrompts: stringArray(variant.excludePrompts ?? [], `${name}.excludePrompts`),
			excludeThemes: stringArray(variant.excludeThemes ?? [], `${name}.excludeThemes`),
			inactiveTools: stringArray(variant.inactiveTools ?? [], `${name}.inactiveTools`),
		};
	}
	return { version: 1, profiles, variants };
}

export function loadAgentProfileDocument(profilePath = defaultProfilePath()): ProfileDocument {
	return parseAgentProfileDocument(JSON.parse(readFileSync(profilePath, "utf8")));
}

function without(values: string[], excluded: string[] = []): string[] {
	const omissions = new Set(excluded);
	return values.filter((value) => !omissions.has(value));
}

export function resolveAgentProfile(name: AgentProfileName | string, document = loadAgentProfileDocument()): AgentProfile {
	if (AGENT_PROFILE_NAMES.includes(name as AgentProfileName)) {
		const profileName = name as AgentProfileName;
		return { name: profileName, ...document.profiles[profileName], inactiveTools: [] };
	}
	const variant = document.variants[name];
	if (!variant) throw new Error(`Unknown agent profile: ${name}`);
	const base = resolveAgentProfile(variant.base, document);
	return {
		...base,
		extensions: without(base.extensions, variant.excludeExtensions),
		skills: without(base.skills, variant.excludeSkills),
		prompts: without(base.prompts, variant.excludePrompts),
		themes: without(base.themes, variant.excludeThemes),
		inactiveTools: [...new Set([...base.inactiveTools, ...(variant.inactiveTools ?? [])])],
	};
}

export function withProjectWorkerOptIn(
	profile: AgentProfile,
	optIn: { extensions?: string[]; tools?: string[] },
): AgentProfile {
	const extensions = stringArray(optIn.extensions ?? [], "projectWorker.extensions");
	const tools = stringArray(optIn.tools ?? [], "projectWorker.tools");
	if (profile.projectResourcePolicy !== "aloop-opt-in") {
		if (extensions.length || tools.length) throw new Error(`Agent profile ${profile.name} does not permit project worker resources.`);
		return profile;
	}
	const supervisorOnly = /^(?:remote_|agentgraph_|aloop_)|^github_issue_(?:mutate|relationship|migration|plan)$|^diagram_show$/;
	const forbidden = tools.find((tool) => supervisorOnly.test(tool));
	if (forbidden) throw new Error(`Project worker tool ${forbidden} is reserved for the supervisor or local interaction.`);
	return {
		...profile,
		extensions: [...new Set([...profile.extensions, ...extensions])],
		tools: [...new Set([...profile.tools, ...tools])],
	};
}

export function activeToolsForProfile(profile: AgentProfile, currentlyActive: string[]): string[] {
	const permitted = profile.toolPolicy === "allowlist" ? profile.tools : currentlyActive;
	const inactive = new Set(profile.inactiveTools);
	return permitted.filter((name) => !inactive.has(name));
}
