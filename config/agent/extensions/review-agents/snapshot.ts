import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

export const MAX_REVIEW_DIFF_BYTES = 8 * 1024 * 1024;

export type GitRunner = (args: string[], cwd?: string, indexPath?: string) => Promise<string>;

export type WorktreeSnapshot = {
	repositoryRoot: string;
	resolvedFixedPoint: string;
	resolvedHead: string;
	resolvedBase: string;
	snapshotCommit: string;
	snapshotTree: string;
	diff: string;
	commits: string;
	changedFiles: string[];
};

/**
 * Materialize the current tracked and untracked (but not ignored) worktree as a
 * synthetic Git commit. A private temporary index keeps the source index and
 * worktree untouched; every later review operation is pinned to the returned
 * commit, so subsequent source changes cannot alter the review.
 */
export async function captureWorktreeSnapshot(git: GitRunner, cwd: string, fixedPoint: string): Promise<WorktreeSnapshot> {
	const repositoryRoot = (await git(["rev-parse", "--show-toplevel"], cwd)).trim();
	const [resolvedFixedPoint, resolvedHead] = await Promise.all([
		git(["rev-parse", "--verify", `${fixedPoint}^{commit}`], repositoryRoot),
		git(["rev-parse", "HEAD"], repositoryRoot),
	]);
	const fixed = resolvedFixedPoint.trim();
	const head = resolvedHead.trim();
	const resolvedBase = (await git(["merge-base", fixed, head], repositoryRoot)).trim();
	const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "pi-review-index-"));
	const indexPath = path.join(temporaryDirectory, "index");

	try {
		await git(["read-tree", head], repositoryRoot, indexPath);
		await git(["add", "-A", "--", "."], repositoryRoot, indexPath);
		const snapshotTree = (await git(["write-tree"], repositoryRoot, indexPath)).trim();
		const snapshotCommit = (await git([
			"-c", "user.name=pi review snapshot",
			"-c", "user.email=pi-review@invalid",
			"commit-tree", snapshotTree, "-p", head, "-m", "pi review worktree snapshot",
		], repositoryRoot)).trim();
		const [diff, commits, changedFilesText] = await Promise.all([
			git(["diff", "--no-ext-diff", "--no-textconv", resolvedBase, snapshotCommit, "--"], repositoryRoot),
			git(["log", "--format=%h %s", `${fixed}..${head}`, "--"], repositoryRoot),
			git(["diff", "--name-only", resolvedBase, snapshotCommit, "--"], repositoryRoot),
		]);
		const diffBytes = Buffer.byteLength(diff, "utf8");
		if (diffBytes > MAX_REVIEW_DIFF_BYTES) {
			throw new Error(`review_agents worktree snapshot diff is ${diffBytes} bytes; the limit is ${MAX_REVIEW_DIFF_BYTES} bytes.`);
		}
		if (!diff.trim()) throw new Error(`review_agents found no diff for worktree snapshot ${snapshotCommit}.`);
		return {
			repositoryRoot,
			resolvedFixedPoint: fixed,
			resolvedHead: head,
			resolvedBase,
			snapshotCommit,
			snapshotTree,
			diff,
			commits,
			changedFiles: changedFilesText.split("\n").map((file) => file.trim()).filter(Boolean),
		};
	} finally {
		await rm(temporaryDirectory, { recursive: true, force: true });
	}
}
