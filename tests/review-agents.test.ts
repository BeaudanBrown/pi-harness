import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
	buildReviewPrompt,
	DEFAULT_REVIEW_MODEL,
	parseReviewModelRef,
	REVIEW_THINKING_LEVEL,
	runReviewTasks,
	validateReviewRequest,
	type ReviewTask,
} from "../config/agent/extensions/review-agents/core.js";
import {
	captureWorktreeSnapshot,
	MAX_REVIEW_DIFF_BYTES,
	type GitRunner,
} from "../config/agent/extensions/review-agents/snapshot.js";

const execFileAsync = promisify(execFile);

async function createRepository(t: test.TestContext): Promise<{ root: string; git: GitRunner; run: (args: string[]) => Promise<string> }> {
	const root = await mkdtemp(path.join(tmpdir(), "review-agents-test-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	const run = async (args: string[]) => (await execFileAsync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 })).stdout;
	const git: GitRunner = async (args, cwd = root, indexPath) => (await execFileAsync("git", args, {
		cwd,
		encoding: "utf8",
		maxBuffer: 32 * 1024 * 1024,
		env: indexPath ? { ...process.env, GIT_INDEX_FILE: indexPath } : process.env,
	})).stdout;
	await run(["init", "--quiet"]);
	await run(["config", "user.name", "Review Test"]);
	await run(["config", "user.email", "review@example.invalid"]);
	await writeFile(path.join(root, "tracked.txt"), "base\n");
	await run(["add", "tracked.txt"]);
	await run(["commit", "--quiet", "-m", "base"]);
	return { root, git, run };
}

const tasks: ReviewTask[] = [
	{ axis: "standards", instructions: "Check the repository standards." },
	{ axis: "spec", instructions: "Check the implementation against issue #14." },
];

test("review agents default to Terra with low thinking", () => {
	assert.equal(DEFAULT_REVIEW_MODEL, "openai-codex/gpt-5.6-terra");
	assert.equal(REVIEW_THINKING_LEVEL, "low");
});

test("review model references preserve provider-qualified model IDs", () => {
	assert.deepEqual(parseReviewModelRef(DEFAULT_REVIEW_MODEL), {
		provider: "openai-codex",
		id: "gpt-5.6-terra",
	});
	assert.equal(parseReviewModelRef("gpt-5.6-terra"), undefined);
	assert.equal(parseReviewModelRef("openai-codex/"), undefined);
});

test("review requests allow one or two distinct axes", () => {
	assert.doesNotThrow(() => validateReviewRequest("main", tasks));
	assert.doesNotThrow(() => validateReviewRequest("main", [tasks[0]!]));
	assert.doesNotThrow(() => validateReviewRequest("main", tasks, "worktree"));
	assert.doesNotThrow(() => validateReviewRequest(undefined, tasks, "audit"));
	assert.throws(() => validateReviewRequest("main", tasks, "audit"), /does not accept/);
	assert.throws(() => validateReviewRequest(undefined, tasks), /requires.*fixed point/);
	assert.throws(() => validateReviewRequest("-invalid", tasks), /fixed point/);
	assert.throws(() => validateReviewRequest("main", []), /one or two/);
	assert.throws(() => validateReviewRequest("main", [tasks[0]!, tasks[0]!]), /only once/);
});

test("review prompts share pinned git context while keeping axis instructions separate", () => {
	const prompt = buildReviewPrompt(tasks[0]!, {
		mode: "diff",
		fixedPoint: "main",
		resolvedFixedPoint: "abc123",
		resolvedHead: "def456",
		diffPath: ".pi/tmp/reviews/example/diff.patch",
		commitsPath: ".pi/tmp/reviews/example/commits.txt",
		changedFiles: ["src/example.ts"],
		repositoryPath: ".pi/tmp/reviews/example/repository",
	});

	assert.match(prompt, /Review axis: standards/);
	assert.match(prompt, /main/);
	assert.match(prompt, /git diff abc123\.\.\.def456/);
	assert.doesNotMatch(prompt, /git diff main\.\.\.HEAD/);
	assert.match(prompt, /diff\.patch/);
	assert.match(prompt, /src\/example\.ts/);
	assert.match(prompt, /Check the repository standards/);
	assert.match(prompt, /severity \(critical, high, medium, or low\)/);
	assert.match(prompt, /current issue, dependent issue, deployment-only, or justified deferral/);

	const worktree = buildReviewPrompt(tasks[1]!, {
		mode: "worktree",
		fixedPoint: "main",
		resolvedFixedPoint: "abc123",
		resolvedHead: "def456",
		resolvedSnapshot: "snapshot789",
		diffPath: ".pi/tmp/reviews/worktree/diff.patch",
		commitsPath: ".pi/tmp/reviews/worktree/commits.txt",
		changedFiles: ["src/uncommitted.ts"],
		repositoryPath: ".pi/tmp/reviews/worktree/repository",
	});
	assert.match(worktree, /Pinned uncommitted worktree context/);
	assert.match(worktree, /snapshot789/);
	assert.match(worktree, /mutable source worktree/);

	const audit = buildReviewPrompt(tasks[1]!, {
		mode: "audit",
		resolvedHead: "def456",
		auditContextPath: ".pi/tmp/reviews/audit/audit-context.txt",
		repositoryPath: ".pi/tmp/reviews/audit/repository",
	});
	assert.match(audit, /Review mode: audit/);
	assert.match(audit, /intentionally no diff/);
	assert.match(audit, /def456/);
});

test("review tasks start concurrently and preserve input order", async () => {
	const started: string[] = [];
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});

	const resultPromise = runReviewTasks(tasks, async (task) => {
		started.push(task.axis);
		await gate;
		return `${task.axis} result`;
	});

	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(started, ["standards", "spec"]);
	release();
	assert.deepEqual(await resultPromise, ["standards result", "spec result"]);
});

test("worktree snapshots preserve a clean committed diff", async (t) => {
	const { root, git, run } = await createRepository(t);
	const fixed = (await run(["rev-parse", "HEAD"])).trim();
	await writeFile(path.join(root, "tracked.txt"), "committed\n");
	await run(["commit", "-am", "committed change", "--quiet"]);

	const snapshot = await captureWorktreeSnapshot(git, root, fixed);
	t.after(snapshot.dispose);
	assert.deepEqual(snapshot.changedFiles, ["tracked.txt"]);
	assert.match(snapshot.diff, /\+committed/);
	assert.equal((await run(["status", "--porcelain"])), "");
});

test("worktree snapshots combine staged, unstaged, and untracked files without changing source state", async (t) => {
	const { root, git, run } = await createRepository(t);
	const fixed = (await run(["rev-parse", "HEAD"])).trim();
	await writeFile(path.join(root, "staged.txt"), "staged\n");
	await run(["add", "staged.txt"]);
	await writeFile(path.join(root, "tracked.txt"), "unstaged\n");
	await writeFile(path.join(root, "untracked.txt"), "untracked\n");
	const statusBefore = await run(["status", "--porcelain=v1"]);
	const objectsBefore = await run(["count-objects", "-v"]);

	const snapshot = await captureWorktreeSnapshot(git, root, fixed);
	t.after(snapshot.dispose);
	assert.deepEqual(snapshot.changedFiles.sort(), ["staged.txt", "tracked.txt", "untracked.txt"]);
	assert.equal(await readFile(path.join(snapshot.repositoryPath, "staged.txt"), "utf8"), "staged\n");
	assert.equal(await readFile(path.join(snapshot.repositoryPath, "tracked.txt"), "utf8"), "unstaged\n");
	assert.equal(await readFile(path.join(snapshot.repositoryPath, "untracked.txt"), "utf8"), "untracked\n");
	assert.equal(await run(["status", "--porcelain=v1"]), statusBefore);
	assert.equal(await run(["count-objects", "-v"]), objectsBefore);
});

test("worktree snapshots retain binary bytes and remain stable when the source changes", async (t) => {
	const { root, git, run } = await createRepository(t);
	const fixed = (await run(["rev-parse", "HEAD"])).trim();
	const original = Buffer.from([0, 1, 2, 255, 10]);
	await writeFile(path.join(root, "image.bin"), original);

	const objectsBefore = await run(["count-objects", "-v"]);
	const snapshot = await captureWorktreeSnapshot(git, root, fixed);
	t.after(snapshot.dispose);
	await writeFile(path.join(root, "image.bin"), Buffer.from([9, 9, 9]));
	assert.deepEqual(await readFile(path.join(snapshot.repositoryPath, "image.bin")), original);
	assert.deepEqual(await readFile(path.join(root, "image.bin")), Buffer.from([9, 9, 9]));
	assert.equal(await run(["count-objects", "-v"]), objectsBefore);
});

test("worktree snapshots reject oversized textual diffs without mutating the worktree", async (t) => {
	const { root, git, run } = await createRepository(t);
	const fixed = (await run(["rev-parse", "HEAD"])).trim();
	await writeFile(path.join(root, "oversized.txt"), `changed-${"x".repeat(MAX_REVIEW_DIFF_BYTES + 1024)}\n`);
	const statusBefore = await run(["status", "--porcelain=v1"]);

	await assert.rejects(() => captureWorktreeSnapshot(git, root, fixed), /limit is/);
	assert.equal(await run(["status", "--porcelain=v1"]), statusBefore);
});
