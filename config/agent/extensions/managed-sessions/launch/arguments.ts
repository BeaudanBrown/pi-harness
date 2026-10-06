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
	if (parsed.sessionId !== undefined && !/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(parsed.sessionId)) {
		throw new Error("Invalid native session ID");
	}
	if (parsed.sessionId !== undefined && (parsed.session !== undefined || parsed.continue || parsed.resume)) {
		throw new Error("--session-id cannot be combined with other resume selectors");
	}
	if (parsed.sessionDir !== undefined && !(parsed.session !== undefined || parsed.sessionId !== undefined || parsed.continue || parsed.resume)) {
		throw new Error("Managed session storage is host-owned; use pi-local-only for a custom new-session directory");
	}
}

export interface SavedSessionCandidate { id: string; path: string; cwd: string }
export interface SavedSessionLists {
	/** Public SDK lists, newest first; these must never construct a writable manager. */
	list(cwd: string, directory?: string): Promise<SavedSessionCandidate[]>;
	listAll(directory?: string): Promise<SavedSessionCandidate[]>;
}
export type BasicSessionSelection =
	| { kind: "fresh" }
	| { kind: "picker"; candidates: SavedSessionCandidate[] }
	| { kind: "saved"; path: string; source: "path" | "local" | "global" };

/** Read-only selection, not admission: inspect selected bytes and host authority next. */
export async function resolveBasicSessionSelection(
	parsed: NativeArguments, cwd: string, sessions: SavedSessionLists,
	resolvePath: (path: string, cwd: string) => string,
): Promise<BasicSessionSelection> {
	assertBasicManagedInvocation(parsed);
	const directory = parsed.sessionDir === undefined ? undefined : resolvePath(parsed.sessionDir, cwd);
	const bounded = (rows: SavedSessionCandidate[]) => {
		if (rows.length > 4096) throw new Error("Saved-session inventory is too large; select an explicit file");
		return rows;
	};
	const match = (rows: SavedSessionCandidate[], selector: string, prefix: boolean) => {
		const exact = rows.filter(row => row.id === selector);
		const matches = exact.length ? exact : prefix ? rows.filter(row => row.id.startsWith(selector)) : [];
		if (matches.length > 1) throw new Error("Saved-session selector is ambiguous; select an explicit file");
		return matches[0];
	};
	if (parsed.session !== undefined) {
		// Pi's actual resolver treats separators or a .jsonl suffix as a path.
		if (parsed.session.includes("/") || parsed.session.includes("\\") || parsed.session.endsWith(".jsonl")) {
			return { kind: "saved", source: "path", path: resolvePath(parsed.session, cwd) };
		}
		const local = match(bounded(await sessions.list(cwd, directory)), parsed.session, true);
		if (local) return { kind: "saved", source: "local", path: local.path };
		const global = match(bounded(await sessions.listAll(directory)), parsed.session, true);
		if (global) return { kind: "saved", source: "global", path: global.path };
		throw new Error("Saved session was not found; no managed launch was admitted");
	}
	if (parsed.resume) return { kind: "picker", candidates: bounded(await sessions.list(cwd, directory)) };
	if (parsed.continue) {
		const latest = bounded(await sessions.list(cwd, directory))[0];
		return latest ? { kind: "saved", source: "local", path: latest.path } : { kind: "fresh" };
	}
	if (parsed.sessionId !== undefined) {
		const existing = match(bounded(await sessions.list(cwd, directory)), parsed.sessionId, false);
		if (!existing) throw new Error("Managed --session-id must select existing history; omit it for a fresh conversation");
		return { kind: "saved", source: "local", path: existing.path };
	}
	return { kind: "fresh" };
}
