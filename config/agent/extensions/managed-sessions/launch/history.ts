import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BINDING_ENTRY_TYPE, BINDING_BOUNDARY_ENTRY_TYPE, UNBOUND_ENTRY_TYPE } from "../adapter/state.js";
import { TREE_ENTRY_TYPE } from "../adapter/tree-boundary.js";

export interface SavedHistoryInspection {
	sessionId: string;
	cwd?: string;
	/** Conservative offline evidence, not proof of current host ownership/retirement. */
	managedMarkers: boolean;
}

/** POSIX CLI path semantics, checked against the pinned public SessionManager API. */
export function resolveNativeSessionPath(input: string, cwd: string): string {
	let normalized = input;
	if (normalized === "~") normalized = homedir();
	else if (normalized.startsWith("~/")) normalized = join(homedir(), normalized.slice(2));
	if (normalized.startsWith("file://")) normalized = fileURLToPath(normalized);
	return resolve(cwd, normalized);
}

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function sessionId(value: unknown): value is string {
	return typeof value === "string" && /^[^\s\u0000-\u001f\u007f]{1,128}$/u.test(value);
}

/**
 * Inspect bytes through Pi's public parser without constructing a writable
 * SessionManager. Unlike the native tolerant loader, refusal is mandatory when
 * malformed lines could conceal managed authority. The caller must additionally
 * check host-owned paths/identities; absence of these markers is not authority.
 */
export function inspectSavedHistory(
	text: string,
	parseEntries: (text: string) => readonly unknown[],
	currentVersion: number,
): SavedHistoryInspection {
	if (!Number.isSafeInteger(currentVersion) || currentVersion < 1) throw new Error("Unsupported SDK session format");
	const entries = parseEntries(text);
	const lines = text.split("\n").filter(line => line.trim().length > 0);
	if (entries.length !== lines.length || entries.length === 0 || entries.some(entry => !record(entry))) {
		throw new Error("Saved history cannot be safely inspected; explicit recovery is required");
	}
	const header = entries[0];
	if (!record(header) || header.type !== "session" || !sessionId(header.id) ||
		(header.version !== undefined && (!Number.isSafeInteger(header.version) || Number(header.version) < 1 || Number(header.version) > currentVersion)) ||
		(header.cwd !== undefined && (typeof header.cwd !== "string" || !isAbsolute(header.cwd) || /[\u0000-\u001f\u007f]/.test(header.cwd))) ||
		entries.slice(1).some(entry => record(entry) && entry.type === "session")) {
		throw new Error("Saved history has an unsupported or ambiguous session header");
	}
	let managedMarkers = false;
	for (const entry of entries.slice(1)) {
		if (!record(entry) || entry.type !== "custom" || typeof entry.customType !== "string") continue;
		const authority = entry.customType === BINDING_BOUNDARY_ENTRY_TYPE || entry.customType.startsWith(BINDING_ENTRY_TYPE) ||
			entry.customType === UNBOUND_ENTRY_TYPE || entry.customType === TREE_ENTRY_TYPE;
		if (!authority) continue;
		// A genuine new-ID history copy retains old metadata, not old ownership.
		// Missing/malformed scope is never evidence that a session is unbound.
		if (!record(entry.data) || !sessionId(entry.data.sessionId) || entry.data.sessionId === header.id) managedMarkers = true;
	}
	return { sessionId: header.id, ...(typeof header.cwd === "string" ? { cwd: header.cwd } : {}), managedMarkers };
}
