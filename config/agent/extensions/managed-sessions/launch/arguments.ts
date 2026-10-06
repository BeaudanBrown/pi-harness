import type { parseArgs } from "@earendil-works/pi-coding-agent";

type NativeArguments = ReturnType<typeof parseArgs>;
const SELECTION = new Set<string>(["continue", "resume", "session", "sessionId", "sessionDir"]);
const PARSER_FIELDS = new Set<string>(["messages", "fileArgs", "unknownFlags", "diagnostics"]);
const UNSUPPORTED = "Managed launch supports bare pi and explicit resume only; use pi-local-only for startup overrides";

/**
 * Apply only to human interactive candidates, before any managed side effect.
 * Input is the public parser result for USER arguments, not injected harness
 * resources. Selection still requires read-only resolution and host ownership
 * checks. No prompts, resource paths or other startup arguments are forwarded.
 */
export function assertBasicManagedInvocation(parsed: NativeArguments): void {
	if (parsed.diagnostics.length || parsed.messages.length || parsed.fileArgs.length || parsed.unknownFlags.size) throw new Error(UNSUPPORTED);
	for (const [key, value] of Object.entries(parsed)) {
		if (value === undefined || PARSER_FIELDS.has(key)) continue;
		if (!SELECTION.has(key)) throw new Error(UNSUPPORTED);
		if (typeof value === "string" && (!value || value.includes("\0"))) throw new Error("Managed resume requires a nonempty valid selector");
	}
	if (parsed.sessionId !== undefined && (parsed.session !== undefined || parsed.continue || parsed.resume)) {
		throw new Error("--session-id cannot be combined with other resume selectors");
	}
	if (parsed.sessionDir !== undefined && !(parsed.session !== undefined || parsed.sessionId !== undefined || parsed.continue || parsed.resume)) {
		throw new Error("Managed session storage is host-owned; use pi-local-only for a custom new-session directory");
	}
}
