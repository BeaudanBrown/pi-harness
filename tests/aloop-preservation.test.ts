import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { parsePreservationEvidence, preserveAttempt, preservationSummary } from "../config/agent/extensions/github-issues/aloop-preservation.js";

const exec = promisify(execFile);
async function fixture(t: test.TestContext) {
	const cwd = await mkdtemp(path.join(tmpdir(), "aloop-preservation-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	const git = async (args: string[]) => ({ code: 0, stderr: "", stdout: (await exec("git", args, { cwd })).stdout });
	await git(["init", "-q"]);
	await git(["config", "user.name", "Test"]);
	await git(["config", "user.email", "test@invalid"]);
	await writeFile(path.join(cwd, "tracked"), "before\n");
	await git(["add", "tracked"]);
	await git(["commit", "-qm", "base"]);
	const base = (await git(["rev-parse", "HEAD"])).stdout.trim();
	const directory = path.join(cwd, ".pi/tmp/aloop/attempt");
	await mkdir(directory, { recursive: true });
	return { cwd, git, base, directory };
}

test("preservation captures exact patches and unusual untracked names without changing source", async (t) => {
	const f = await fixture(t);
	await writeFile(path.join(f.cwd, "tracked"), "staged\n");
	await f.git(["add", "tracked"]);
	await writeFile(path.join(f.cwd, "tracked"), "unstaged\n");
	await writeFile(path.join(f.cwd, " odd\nname "), Buffer.from([0, 255, 10]));
	const { evidence } = await preserveAttempt(f);
	assert.equal(evidence.capture, "complete");
	assert.deepEqual([evidence.commits, evidence.staged, evidence.unstaged, evidence.untracked], [0, 1, 1, 1]);
	assert.match(await readFile(path.join(f.directory, "worktree.patch"), "utf8"), /\+unstaged\n/);
	assert.deepEqual(await readFile(path.join(f.directory, "untracked", " odd\nname ")), Buffer.from([0, 255, 10]));
	assert.equal(await readFile(path.join(f.cwd, "tracked"), "utf8"), "unstaged\n");
	assert.deepEqual(parsePreservationEvidence(evidence), evidence);
});

test("inspection failure is unknown, failed patch is not preserved as an empty success", async (t) => {
	const f = await fixture(t);
	const result = await preserveAttempt({ ...f, git: async (args) => args[0] === "status" || args[0] === "diff"
		? { code: 1, stdout: "", stderr: "private error detail" } : f.git(args) });
	assert.equal(result.evidence.capture, "incomplete");
	assert.equal(result.evidence.untracked, null);
	assert.match(preservationSummary(result.evidence), /unknown untracked/);
	assert.doesNotMatch(preservationSummary(result.evidence), /private error detail/);
	await assert.rejects(readFile(path.join(f.directory, "worktree.patch")), { code: "ENOENT" });
});

test("unsupported untracked symlink is retained and explicitly incomplete", async (t) => {
	const f = await fixture(t);
	await symlink("tracked", path.join(f.cwd, "link"));
	const { evidence } = await preserveAttempt(f);
	assert.equal(evidence.capture, "incomplete");
	assert.equal(evidence.untracked, 1);
	assert.equal(await readFile(path.join(f.cwd, "link"), "utf8"), "before\n");
});

test("unknown HEAD and failed artifact writes cannot produce complete preservation", async (t) => {
	const f = await fixture(t);
	await writeFile(path.join(f.directory, "worktree.patch"), "existing");
	const { evidence } = await preserveAttempt({ ...f, git: async (args) => {
		if (args[0] === "rev-parse") throw new Error("timeout");
		return f.git(args);
	} });
	assert.equal(evidence.head, null);
	assert.equal(evidence.commits, null);
	assert.equal(evidence.capture, "incomplete");
	assert.ok(evidence.failures.includes("worktree patch write"));
	assert.equal(await readFile(path.join(f.directory, "worktree.patch"), "utf8"), "existing");
});

test("historical records remain readable; malformed new evidence fails closed", () => {
	assert.equal(parsePreservationEvidence(undefined), undefined);
	assert.equal(parsePreservationEvidence({ capture: "complete" })?.capture, "incomplete");
});
