import type { parseArgs } from "@earendil-works/pi-coding-agent";

type NativeArguments = ReturnType<typeof parseArgs>;
type Kind = "scalar" | "boolean" | "list" | "repeat" | "trust" | "mode" | "selection" | "forbidden";
type Option = Exclude<keyof NativeArguments, "messages" | "fileArgs" | "unknownFlags" | "diagnostics">;

// Exhaustive over the pinned public API: SDK additions require a deliberate
// transport decision rather than silently forwarding a new authority selector.
const OPTIONS = {
	provider: ["--provider", "scalar"], model: ["--model", "scalar"], apiKey: ["--api-key", "forbidden"],
	systemPrompt: ["--system-prompt", "scalar"], appendSystemPrompt: ["--append-system-prompt", "repeat"], thinking: ["--thinking", "scalar"],
	continue: ["--continue", "selection"], resume: ["--resume", "selection"], session: ["--session", "selection"],
	sessionId: ["--session-id", "selection"], fork: ["--fork", "selection"], sessionDir: ["--session-dir", "selection"],
	help: ["--help", "forbidden"], version: ["--version", "forbidden"], noSession: ["--no-session", "forbidden"],
	print: ["--print", "forbidden"], export: ["--export", "forbidden"], listModels: ["--list-models", "forbidden"],
	mode: ["--mode", "mode"], name: ["--name", "scalar"], models: ["--models", "list"],
	tools: ["--tools", "list"], excludeTools: ["--exclude-tools", "list"], noTools: ["--no-tools", "boolean"], noBuiltinTools: ["--no-builtin-tools", "boolean"],
	extensions: ["--extension", "repeat"], noExtensions: ["--no-extensions", "boolean"],
	skills: ["--skill", "repeat"], noSkills: ["--no-skills", "boolean"],
	promptTemplates: ["--prompt-template", "repeat"], noPromptTemplates: ["--no-prompt-templates", "boolean"],
	themes: ["--theme", "repeat"], useTheme: ["--use-theme", "scalar"], noThemes: ["--no-themes", "boolean"],
	noContextFiles: ["--no-context-files", "boolean"], offline: ["--offline", "boolean"],
	tuiMode: ["--tui-mode", "scalar"], verbose: ["--verbose", "boolean"], projectTrustOverride: ["--approve", "trust"],
} as const satisfies Record<Option, readonly [string, Kind]>;
const RESERVED = new Set([...Object.values(OPTIONS).map(([flag]) => flag.slice(2)), "no-approve"]);

/**
 * Canonical argv for an already-resolved new/dormant managed invocation. This
 * preserves parsed literal values, not spelling/order of equivalent CLI flags.
 * Session selection is deliberately absent: the owner supplies its fixed file.
 * Do not use this as ownership/admission validation or replay startup prompts.
 */
export function managedInvocationArguments(parsed: NativeArguments): string[] {
	if (parsed.diagnostics.length) throw new Error("Resolve native CLI diagnostics before a managed launch");
	const result: string[] = [];
	for (const key of Object.keys(OPTIONS) as Option[]) {
		const [flag, kind]: readonly [string, Kind] = OPTIONS[key]; const value = parsed[key];
		if (value === undefined || kind === "selection") continue;
		if (kind === "forbidden") throw new Error(`Managed launch does not forward ${flag}; use pi-local-only when appropriate`);
		if (kind === "trust") { result.push(value ? "--approve" : "--no-approve"); continue; }
		if (kind === "boolean") { if (value) result.push(flag); continue; }
		if (kind === "mode" && value !== "text") throw new Error("Managed automatic launch requires interactive mode");
		if (kind === "list" || kind === "repeat") {
			if (!Array.isArray(value) || value.some(item => typeof item !== "string")) throw new Error("Invalid native array option");
			if (kind === "list") result.push(flag, value.join(","));
			else for (const item of value) result.push(flag, item);
		} else {
			if (typeof value !== "string") throw new Error("Invalid native scalar option");
			result.push(flag, value);
		}
	}
	for (const [name, value] of parsed.unknownFlags) {
		// A missing core value or --session=... is reported as unknown by Pi.
		// Re-emitting that as a bare flag could consume our fixed session option.
		if (RESERVED.has(name)) throw new Error("Incomplete or assignment-style core options cannot be forwarded; use native flag/value syntax");
		if (value === true) result.push(`--${name}`);
		else if (typeof value === "string") result.push(`--${name}=${value}`);
		else throw new Error("Invalid native extension flag");
	}
	// Pi collects files and messages separately even when interleaved in argv.
	// A delimiter preserves option-looking prompt text and unknown boolean flags.
	result.push("--", ...parsed.fileArgs.map(path => `@${path}`), ...parsed.messages);
	if (result.some(value => value.includes("\0"))) throw new Error("Native arguments cannot contain NUL bytes");
	return result;
}
