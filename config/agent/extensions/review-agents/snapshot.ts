import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

export const MAX_REVIEW_DIFF_BYTES = 8 * 1024 * 1024;

export type GitRunner = (args: string[], cwd?: string, indexPath?: string) => Promise<string>;

export type WorktreeSnapshot = {
	repositoryRoot: string;
	repositoryPath: string;
	resolvedFixedPoint: string;
	resolvedHead: string;
	resolvedBase: string;
	snapshotCommit: string;
	snapshotTree: string;
	diff: string;
	commits: string;
	changedFiles: string[];
	dispose: () => Promise<void>;
};

/**
 * Materialize the current tracked and untracked (but not ignored) worktree in a
 * private Git object database and index, then check it out as a plain immutable
 * file snapshot. The source worktree, index, refs, and object database are not
 * changed. The caller owns the returned temporary snapshot until dispose().
 */
export async function captureWorktreeSnapshot(git: GitRunner, cwd: string, fixedPoint: string): Promise<WorktreeSnapshot> {
	const repositoryRoot = (await git(["rev-parse", "--show-toplevel"], cwd)).trim();
	const [resolvedFixedPoint, resolvedHead, sourceGitDirectory] = await Promise.all([
		git(["rev-parse", "--verify", `${fixedPoint}^{commit}`], repositoryRoot),
		git(["rev-parse", "HEAD"], repositoryRoot),
		git(["rev-parse", "--path-format=absolute", "--git-common-dir"], repositoryRoot),
	]);
	const fixed = resolvedFixedPoint.trim();
	const head = resolvedHead.trim();
	const resolvedBase = (await git(["merge-base", fixed, head], repositoryRoot)).trim();
	const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "pi-review-snapshot-"));
	const privateGitDirectory = path.join(temporaryDirectory, "git");
	const indexPath = path.join(temporaryDirectory, "index");
	const repositoryPath = path.join(temporaryDirectory, "repository");
	const privateGitArgs = ["--git-dir", privateGitDirectory];
	const sourceWorktreeArgs = [...privateGitArgs, "--work-tree", repositoryRoot];

	try {
		await git(["init", "--quiet", "--bare", privateGitDirectory], repositoryRoot);
		const alternatesDirectory = path.join(privateGitDirectory, "objects", "info");
		await mkdir(alternatesDirectory, { recursive: true });
		await writeFile(path.join(alternatesDirectory, "alternates"), `${path.join(sourceGitDirectory.trim(), "objects")}\n`, "utf8");
		await git([...sourceWorktreeArgs, "read-tree", head], repositoryRoot, indexPath);
		await git([...sourceWorktreeArgs, "add", "-A", "--", "."], repositoryRoot, indexPath);
		const snapshotTree = (await git([...sourceWorktreeArgs, "write-tree"], repositoryRoot, indexPath)).trim();
		const snapshotCommit = (await git([
			...sourceWorktreeArgs,
			"-c", "user.name=pi review snapshot",
			"-c", "user.email=pi-review@invalid",
			"commit-tree", snapshotTree, "-p", head, "-m", "pi review worktree snapshot",
		], repositoryRoot)).trim();
		const [diff, commits, changedFilesText] = await Promise.all([
			git([...sourceWorktreeArgs, "diff", "--no-ext-diff", "--no-textconv", resolvedBase, snapshotCommit, "--"], repositoryRoot),
			git(["log", "--format=%h %s", `${fixed}..${head}`, "--"], repositoryRoot),
			git([...sourceWorktreeArgs, "diff", "--name-only", resolvedBase, snapshotCommit, "--"], repositoryRoot),
		]);
		const diffBytes = Buffer.byteLength(diff, "utf8");
		if (diffBytes > MAX_REVIEW_DIFF_BYTES) {
			throw new Error(`review_agents worktree snapshot diff is ${diffBytes} bytes; the limit is ${MAX_REVIEW_DIFF_BYTES} bytes.`);
		}
		if (!diff.trim()) throw new Error(`review_agents found no diff for worktree snapshot ${snapshotCommit}.`);
		await mkdir(repositoryPath);
		await git([...privateGitArgs, "--work-tree", repositoryPath, "checkout-index", "--all", "--force"], repositoryRoot, indexPath);
		return {
			repositoryRoot,
			repositoryPath,
			resolvedFixedPoint: fixed,
			resolvedHead: head,
			resolvedBase,
			snapshotCommit,
			snapshotTree,
			diff,
			commits,
			changedFiles: changedFilesText.split("\n").map((file) => file.trim()).filter(Boolean),
			dispose: () => rm(temporaryDirectory, { recursive: true, force: true }),
		};
	} catch (error) {
		await rm(temporaryDirectory, { recursive: true, force: true });
		throw error;
	}
}
