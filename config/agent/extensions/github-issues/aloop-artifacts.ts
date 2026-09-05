import { constants } from "node:fs";
import { lstat, open, readdir, realpath, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import type { AloopAttemptRecord } from "../aloop/core.js";
import { isPreservationEvidence, parsePreservationEvidence, type PreservationEvidence } from "./aloop-preservation.js";

const MAX_RECORD_BYTES = 1_000_000;
const ATTEMPT_PATH = /^\.pi\/tmp\/aloop\/issue-([1-9]\d*)-\d+-[a-f0-9]+$/;
const HASH = /^[a-f0-9]{40,64}$/i;
export type AttemptIdentity = {
	version: 1;
	issue: number;
	epic: number;
	artifactDirectory: string;
	beforeHead: string;
	issueBaseCommit: string;
	workerKind: "implementation" | "patch";
	parentArtifactDirectory?: string;
};

export async function syncAttemptDirectory(directory: string): Promise<void> {
	const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
	try { await handle.sync(); } finally { await handle.close(); }
}

/** Creates immutable startup identity before any worker is spawned. */
export async function writeAttemptIdentity(directory: string, identity: AttemptIdentity): Promise<void> {
	const match = ATTEMPT_PATH.exec(identity.artifactDirectory);
	if (identity.version !== 1 || !match || Number(match[1]) !== identity.issue || !Number.isSafeInteger(identity.issue)
		|| !Number.isSafeInteger(identity.epic) || identity.epic < 1 || !HASH.test(identity.beforeHead) || !HASH.test(identity.issueBaseCommit)
		|| !["implementation", "patch"].includes(identity.workerKind)
		|| (identity.parentArtifactDirectory !== undefined && (identity.workerKind !== "patch" || Number(ATTEMPT_PATH.exec(identity.parentArtifactDirectory)?.[1]) !== identity.issue || identity.parentArtifactDirectory === identity.artifactDirectory))) {
		throw new Error("Invalid aloop attempt identity.");
	}
	const document = `${JSON.stringify(identity)}\n`;
	if (Buffer.byteLength(document) > 4_096 || path.basename(identity.artifactDirectory) !== path.basename(directory)) throw new Error("Invalid aloop attempt identity size or directory.");
	const file = await open(path.join(directory, "attempt.json"), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
	try { await file.writeFile(document); await file.sync(); }
	finally { await file.close(); }
	await syncAttemptDirectory(directory);
}

/** Capture the reserved result and directory identities before running a worker.
 * Publication never follows a worker-replaced result or directory symlink.
 */
export async function prepareResultPublication(directory: string): Promise<{
	publish: (value: unknown) => Promise<void>;
	close: () => Promise<void>;
}> {
	const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
	try {
		const canonical = await realpath(directory);
		const directoryIdentity = await handle.stat();
		// Node has no openat/renameat interface. Descriptor paths keep every write,
		// rename and cleanup anchored even if the original pathname is swapped.
		const anchored = `${process.platform === "linux" ? "/proc/self/fd" : "/dev/fd"}/${handle.fd}`;
		const anchorStat = await lstat(`${anchored}/.`).catch(() => null);
		if (!anchorStat?.isDirectory() || anchorStat.dev !== directoryIdentity.dev || anchorStat.ino !== directoryIdentity.ino) {
			throw new Error("Aloop atomic publication requires directory-descriptor path support; no worker was started.");
		}
		const resultPath = path.join(anchored, "result.json");
		const reserved = await lstat(resultPath);
		if (!reserved.isFile() || reserved.isSymbolicLink()) throw new Error("Unsafe aloop result reservation.");
		const assertDirectory = async () => {
			const [dir, currentCanonical] = await Promise.all([lstat(directory), realpath(directory)]);
			if (!dir.isDirectory() || dir.isSymbolicLink() || dir.dev !== directoryIdentity.dev || dir.ino !== directoryIdentity.ino || currentCanonical !== canonical) throw new Error("Aloop result artifact was replaced during worker execution.");
		};
		const assertIdentity = async () => {
			await assertDirectory();
			const result = await lstat(resultPath);
			if (!result.isFile() || result.isSymbolicLink() || result.dev !== reserved.dev || result.ino !== reserved.ino) throw new Error("Aloop result artifact was replaced during worker execution.");
		};
		await assertIdentity();
		return {
			close: () => handle.close(),
			publish: async (value) => {
				const document = `${JSON.stringify(value, null, 2)}\n`;
				if (Buffer.byteLength(document) > MAX_RECORD_BYTES) throw new Error("Aloop result exceeds recovery record limit.");
				await assertIdentity();
				const temporary = path.join(anchored, `.result-${randomUUID()}.tmp`);
				const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
				try {
					await file.writeFile(document);
					await file.sync();
					await assertIdentity();
					await rename(temporary, resultPath);
					await handle.sync();
					await assertDirectory();
				} finally {
					await file.close();
					await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
				}
			},
		};
	} catch (error) { await handle.close(); throw error; }
}

async function readRecord(file: string): Promise<any | undefined> {
	try {
		const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		try {
			const stat = await handle.stat();
			if (!stat.isFile() || stat.size > MAX_RECORD_BYTES) return undefined;
			const bytes = Buffer.alloc(stat.size + 1);
			let length = 0;
			while (length < bytes.length) {
				const read = await handle.read(bytes, length, bytes.length - length, length);
				if (!read.bytesRead) break;
				length += read.bytesRead;
			}
			if (length !== stat.size) return undefined;
			return JSON.parse(bytes.subarray(0, length).toString("utf8"));
		} finally { await handle.close(); }
	} catch { return undefined; }
}

function incomplete(label: string): PreservationEvidence {
	return { version: 1, head: null, commits: null, staged: null, unstaged: null, untracked: null, capture: "incomplete", failures: [label] };
}

/** Read-only evidence discovery. Missing results never imply no work or acceptance. */
export async function scanAttemptArtifacts(cwd: string): Promise<AloopAttemptRecord[]> {
	const root = path.resolve(cwd, ".pi/tmp/aloop");
	for (const component of [path.resolve(cwd, ".pi"), path.resolve(cwd, ".pi/tmp"), root]) {
		const stat = await lstat(component).catch(() => null);
		if (!stat?.isDirectory() || stat.isSymbolicLink()) return [];
	}
	const entries = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory() && ATTEMPT_PATH.test(`.pi/tmp/aloop/${entry.name}`))
		.sort((a, b) => a.name.localeCompare(b.name)).slice(-200);
	const records = new Map<string, AloopAttemptRecord>();
	const parents = new Map<string, string>();
	const kinds = new Map<string, string>();
	const ledgers = new Map<string, any>();
	for (const entry of entries) {
		const artifactDirectory = `.pi/tmp/aloop/${entry.name}`;
		const directory = path.join(root, entry.name);
		const issue = Number(ATTEMPT_PATH.exec(artifactDirectory)![1]);
		if (!Number.isSafeInteger(issue)) continue;
		const identityPath = path.join(directory, "attempt.json");
		const hasIdentity = await lstat(identityPath).then(() => true, () => false);
		const identity = await readRecord(identityPath);
		const context = await readRecord(path.join(directory, "issue-context.json"));
		const validIdentity = identity?.version === 1 && identity.issue === issue && Number.isSafeInteger(identity.epic) && identity.epic > 0
			&& identity.artifactDirectory === artifactDirectory && HASH.test(identity.beforeHead) && HASH.test(identity.issueBaseCommit)
			&& ["implementation", "patch"].includes(identity.workerKind);
		const validContext = context?.version === 1 && context.selectedIssue?.number === issue && HASH.test(context.attemptStartCommit) && HASH.test(context.issueBaseCommit);
		const result = await readRecord(path.join(directory, "result.json"));
		const validResult = (!hasIdentity || validIdentity) && result?.artifacts?.directory === artifactDirectory
			&& (result.commit === null || (typeof result.commit === "string" && /^[a-f0-9]{7,64}$/i.test(result.commit)))
			&& ["completed", "worker-failed", "timeout", "cancelled", "contract-violation", "missing-submission", "invalid-result"].includes(result.status)
			&& (result.preservation === undefined ? !validIdentity : isPreservationEvidence(result.preservation))
			&& (!validIdentity || result.beforeHead === identity.beforeHead);
		if (!validResult && !validIdentity && !validContext) continue;
		const record: AloopAttemptRecord = {
			issue, artifactDirectory, commit: validResult ? result.commit : null,
			status: validResult ? result.status : "interrupted",
			preservation: validResult ? parsePreservationEvidence(result.preservation) : incomplete("interrupted result publication"),
			...(validIdentity || validContext ? { beforeHead: validIdentity ? identity.beforeHead : context.attemptStartCommit, issueBaseCommit: validIdentity ? identity.issueBaseCommit : context.issueBaseCommit } : {}),
		};
		records.set(artifactDirectory, record);
		if (validIdentity) {
			kinds.set(artifactDirectory, identity.workerKind);
			if (identity.workerKind === "patch" && typeof identity.parentArtifactDirectory === "string") parents.set(artifactDirectory, identity.parentArtifactDirectory);
		}
		const ledgerPath = path.join(directory, "patch-attempts.json");
		if (await lstat(ledgerPath).catch(() => null)) {
			const ledger = await readRecord(ledgerPath);
			if (!Array.isArray(ledger) || ledger.length > 200) record.preservation = incomplete("invalid patch bookkeeping");
			else ledgers.set(artifactDirectory, ledger);
		}
	}
	// Legacy ledgers are hints only; never suppress an unrelated or missing child.
	for (const [parentPath, ledger] of ledgers) {
		const parent = records.get(parentPath)!;
		for (const patch of ledger) {
			const child = records.get(patch?.artifactDirectory);
			if (!child || child.issue !== parent.issue || child.artifactDirectory === parentPath || kinds.get(parentPath) === "patch" || kinds.get(child.artifactDirectory) === "implementation"
				|| (parents.has(child.artifactDirectory) && parents.get(child.artifactDirectory) !== parentPath)) {
				parent.preservation = incomplete("invalid patch bookkeeping"); continue;
			}
			parents.set(child.artifactDirectory, parentPath);
		}
	}
	const grouped = new Set<string>();
	for (const [childPath, parentPath] of [...parents].sort(([a], [b]) => a.localeCompare(b))) {
		const child = records.get(childPath)!, parent = records.get(parentPath);
		if (!parent || child.issue !== parent.issue || childPath === parentPath || parents.has(parentPath)) {
			child.preservation = incomplete("unresolved patch parent"); continue;
		}
		if (child.commit) parent.commit = child.commit;
		if (child.status === "interrupted") parent.status = "interrupted";
		if (child.preservation?.capture === "incomplete") parent.preservation = child.preservation;
		grouped.add(childPath);
	}
	return [...records.values()].filter((record) => !grouped.has(record.artifactDirectory));
}
