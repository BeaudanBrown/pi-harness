import { constants } from "node:fs";
import { link, lstat, mkdtemp, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { MANAGED_SESSION_STATE_VERSION, deriveTranscriptEntryId } from "../contracts.js";
import { ensurePrivateDirectory } from "../relay/atomic-json.js";
import { inspectSavedHistory } from "./history.js";

export interface ImportHistorySdk {
	CURRENT_SESSION_VERSION: number;
	parseSessionEntries(text: string): readonly unknown[];
	SessionManager: { forkFrom(source: string, cwd: string, directory: string): {
		getSessionFile(): string | undefined; getSessionId(): string; getLeafId(): string | null;
	} };
}

/** Local-only filesystem preparation. The caller must resolve host ownership first:
 * active/dormant history must be opened through its existing host binding, never
 * passed here as a new import. A retired verdict requires host retirement proof.
 * This helper neither registers nor launches a conversation or contacts Matrix.
 */
export async function prepareImportedHistory(input: {
	source: string; destination: string; cwd: string;
	conversationId: string; creationKey: string; concept: string;
	authority: "unregistered" | "retired";
}, sdk: ImportHistorySdk): Promise<{ sessionId: string; boundaryEntryId: string }> {
	const source = resolve(input.source); const destination = resolve(input.destination);
	if (source === destination || !/^conv_[a-f0-9]{32}$/.test(input.conversationId) ||
		!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.creationKey) || !input.concept.trim() || input.concept.length > 128 ||
		/[\u0000-\u001f\u007f]/.test(input.concept)) throw new Error("Invalid independent history import identity");
	if (await realpath(source) !== source) throw new Error("Saved history must use a canonical non-symlink path");
	const file = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	let text: string;
	try {
		const before = await file.stat({ bigint: true });
		if (!before.isFile() || before.nlink !== 1n || (process.getuid && before.uid !== BigInt(process.getuid()))) {
			throw new Error("Saved history is not a single-link regular file owned by this user");
		}
		text = await file.readFile("utf8");
		const after = await file.stat({ bigint: true });
		const current = await lstat(source, { bigint: true });
		if (before.dev !== current.dev || before.ino !== current.ino || before.size !== after.size ||
			before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs ||
			current.ctimeNs !== after.ctimeNs || await realpath(source) !== source) {
			throw new Error("Saved history changed during inspection; select it again");
		}
	} finally { await file.close(); }
	const inspection = inspectSavedHistory(text, sdk.parseSessionEntries, sdk.CURRENT_SESSION_VERSION);
	if (inspection.managedMarkers && input.authority !== "retired") throw new Error("Managed history requires existing binding or proven retirement authority");
	if (!inspection.cwd || inspection.cwd !== input.cwd) throw new Error("Saved history workspace does not match resolved placement");
	const directory = await ensurePrivateDirectory(dirname(destination));
	const staging = await mkdtemp(join(directory, ".history-import-"));
	try {
		// Fork a fixed validated snapshot, not a potentially still-running writer.
		const snapshot = join(staging, "source.jsonl");
		await writeFile(snapshot, text, { flag: "wx", mode: 0o600 });
		const fork = sdk.SessionManager.forkFrom(snapshot, input.cwd, staging);
		const forkPath = fork.getSessionFile(); const sessionId = fork.getSessionId(); const parentId = fork.getLeafId();
		if (!forkPath || dirname(forkPath) !== staging || sessionId === inspection.sessionId) throw new Error("SDK did not create an independent history copy");
		const copied = await readFile(forkPath, "utf8");
		const parsed = inspectSavedHistory(copied, sdk.parseSessionEntries, sdk.CURRENT_SESSION_VERSION);
		if (parsed.sessionId !== sessionId || parsed.cwd !== input.cwd || parsed.managedMarkers) throw new Error("Copied history retained ambiguous managed authority");
		const entries = copied.split("\n").filter(line => line.trim()).map(line => JSON.parse(line) as Record<string, unknown>);
		const boundaryId = `managed-boundary-${input.conversationId.slice(5)}`;
		if (entries.some(entry => entry.id === boundaryId) || (parentId !== null && !entries.some(entry => entry.id === parentId))) {
			throw new Error("Copied history has an ambiguous branch boundary");
		}
		// The standalone SDK manager is never used again. Publish a complete seed
		// before constructing any live writer; no private SDK persistence methods,
		// synthetic assistant entry, or appends to the original session are used.
		entries[0] = { ...entries[0], parentSession: source };
		entries.push({ type: "custom", id: boundaryId, parentId, timestamp: new Date().toISOString(),
			customType: "managed-session.binding-boundary", data: { version: MANAGED_SESSION_STATE_VERSION,
				creationKey: input.creationKey, concept: input.concept, sessionId } });
		const seed = join(staging, "seed.jsonl"); const output = await open(seed, "wx", 0o600);
		try { await output.writeFile(`${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`); await output.sync(); }
		finally { await output.close(); }
		// Exclusive atomic publication: a concurrent/previous attempt must never
		// overwrite an existing seed or a session which already has a live writer.
		await link(seed, destination);
		const parent = await open(directory, "r");
		try { await parent.sync(); } finally { await parent.close(); }
		return { sessionId, boundaryEntryId: deriveTranscriptEntryId(sessionId, boundaryId) };
	} finally { await rm(staging, { recursive: true, force: true }); }
}
