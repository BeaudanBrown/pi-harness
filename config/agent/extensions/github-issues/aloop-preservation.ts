import { constants } from "node:fs";
import { lstat, mkdir, open, writeFile } from "node:fs/promises";
import * as path from "node:path";

export type PreservationEvidence = {
	version: 1;
	head: string | null;
	commits: number | null;
	staged: number | null;
	unstaged: number | null;
	untracked: number | null;
	capture: "complete" | "incomplete";
	failures: string[];
};

type GitResult = { code: number | null; stdout: string; stderr: string };
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_FILES = 1_000;

/** Preserve evidence without deleting, staging, or committing source files.
 * Failures are operation labels, never raw stderr or private paths.
 */
export async function preserveAttempt(input: {
	cwd: string;
	directory: string;
	base: string;
	git: (args: string[]) => Promise<GitResult>;
}): Promise<{ evidence: PreservationEvidence; status: string | null; ancestor: boolean | null }> {
	const evidence: PreservationEvidence = { version: 1, head: null, commits: null, staged: null, unstaged: null, untracked: null, capture: "complete", failures: [] };
	const fail = (label: string) => { evidence.capture = "incomplete"; evidence.failures.push(label); };
	const inspect = async (label: string, args: string[]): Promise<string | null> => {
		try {
			const result = await input.git(args);
			if (result.code !== 0 || Buffer.byteLength(result.stdout) > MAX_BYTES) throw new Error("Git inspection failed or exceeded limit");
			return result.stdout;
		} catch { fail(label); return null; }
	};
	const save = async (label: string, file: string, contents: string | null) => {
		if (contents === null) return;
		try { await writeFile(path.join(input.directory, file), contents, { mode: 0o600, flag: "wx" }); }
		catch { fail(label); }
	};
	evidence.head = (await inspect("HEAD inspection", ["rev-parse", "HEAD"]))?.trim() ?? null;
	let ancestor: boolean | null = null;
	if (evidence.head) {
		try {
			const result = await input.git(["merge-base", "--is-ancestor", input.base, evidence.head]);
			if (result.code !== 0 && result.code !== 1) throw new Error("ancestry unavailable");
			ancestor = result.code === 0;
			if (!ancestor) fail("non-descendant HEAD");
		} catch { fail("ancestry inspection"); }
		if (ancestor) {
			const count = await inspect("commit inspection", ["rev-list", "--count", `${input.base}..${evidence.head}`]);
			if (count !== null && /^\d+$/.test(count.trim()) && Number.isSafeInteger(Number(count))) evidence.commits = Number(count);
			else if (count !== null) fail("invalid commit count");
		}
	}
	const scope = ["--", "."];
	const status = await inspect("worktree inspection", ["status", "--porcelain=v1", "-z", "--untracked-files=all", ...scope]);
	let untracked: string[] | null = null;
	if (status !== null) {
		let staged = 0, unstaged = 0;
		untracked = [];
		const entries = status.split("\0");
		for (let i = 0; i < entries.length; i++) {
			const entry = entries[i]!;
			if (!entry) continue;
			if (entry.startsWith("?? ")) {
				if (!entry.slice(3).startsWith(".pi/tmp/aloop/")) untracked.push(entry.slice(3));
			}
			else {
				if (entry[0] !== " ") staged++;
				if (entry[1] !== " ") unstaged++;
				if (/[RC]/.test(entry.slice(0, 2))) i++; // porcelain -z rename source
			}
		}
		evidence.staged = staged; evidence.unstaged = unstaged; evidence.untracked = untracked.length;
	}
	await save("worktree patch write", "worktree.patch", await inspect("worktree patch capture", ["diff", "--no-ext-diff", "--no-textconv", "--binary", ...scope]));
	await save("staged patch write", "staged.patch", await inspect("staged patch capture", ["diff", "--no-ext-diff", "--no-textconv", "--cached", "--binary", ...scope]));
	await save("untracked manifest write", "untracked-files.json", untracked === null ? null : `${JSON.stringify(untracked, null, 2)}\n`);
	let bytes = 0;
	if (untracked && untracked.length > MAX_FILES) fail("untracked file count limit");
	for (const file of (untracked ?? []).slice(0, MAX_FILES)) {
		try {
			const parts = file.split("/");
			if (path.isAbsolute(file) || parts.some((part) => !part || part === "." || part === "..")) throw new Error("invalid path");
			for (let i = 1; i < parts.length; i++) {
				const parent = await lstat(path.join(input.cwd, ...parts.slice(0, i)));
				if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error("unsafe parent");
			}
			const source = await open(path.join(input.cwd, file), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
			try {
				const stat = await source.stat();
				if (!stat.isFile() || stat.size > MAX_BYTES - bytes) throw new Error("unsupported or oversized file");
				const contents = Buffer.alloc(stat.size);
				let offset = 0;
				while (offset < contents.length) {
					const read = await source.read(contents, offset, contents.length - offset, offset);
					if (!read.bytesRead) throw new Error("file changed during capture");
					offset += read.bytesRead;
				}
				const after = await source.stat();
				if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error("file changed during capture");
				bytes += contents.length;
				const target = path.join(input.directory, "untracked", file);
				await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
				await writeFile(target, contents, { mode: 0o600, flag: "wx" });
			} finally { await source.close(); }
		} catch { if (!evidence.failures.includes("untracked content capture")) fail("untracked content capture"); }
	}
	return { evidence, status, ancestor };
}

export function parsePreservationEvidence(value: unknown): PreservationEvidence | undefined {
	if (value === undefined) return undefined; // historical attempt
	const v = value as Partial<PreservationEvidence> | null;
	const count = (n: unknown) => n === null || (typeof n === "number" && Number.isSafeInteger(n) && n >= 0);
	if (v && v.version === 1 && (v.head === null || (typeof v.head === "string" && /^[a-f0-9]{40,64}$/.test(v.head)))
		&& [v.commits, v.staged, v.unstaged, v.untracked].every(count)
		&& (v.capture === "complete" || v.capture === "incomplete")
		&& Array.isArray(v.failures) && v.failures.length <= 20 && v.failures.every((s) => typeof s === "string" && s.length <= 100)
		&& (v.capture !== "complete" || (v.head !== null && [v.commits, v.staged, v.unstaged, v.untracked].every((n) => n !== null) && v.failures.length === 0))) return v as PreservationEvidence;
	return { version: 1, head: null, commits: null, staged: null, unstaged: null, untracked: null, capture: "incomplete", failures: ["invalid preservation record"] };
}

export function preservationSummary(evidence: PreservationEvidence, includeFailures = true): string {
	const count = (value: number | null) => value === null ? "unknown" : String(value);
	return `Git evidence: ${count(evidence.commits)} commits; ${count(evidence.staged)} staged, ${count(evidence.unstaged)} unstaged, ${count(evidence.untracked)} untracked paths. Preservation: ${evidence.capture}.${includeFailures && evidence.failures.length ? ` Failed: ${evidence.failures.join(", ")}. Original workspace retained; inspect before continuing.` : ""}`;
}
