import assert from "node:assert/strict";
import fsPromises from "node:fs/promises";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import { prepareResultPublication, scanAttemptArtifacts, writeAttemptIdentity, type AttemptIdentity } from "../config/agent/extensions/github-issues/aloop-artifacts.js";

const base = "a".repeat(40);
async function fixture(t: test.TestContext) {
	const cwd = await mkdtemp(path.join(tmpdir(), "aloop-artifacts-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	return cwd;
}
async function attempt(cwd: string, suffix = "100-abcdef", extra: Partial<AttemptIdentity> = {}) {
	const artifactDirectory = `.pi/tmp/aloop/issue-2-${suffix}`;
	const directory = path.join(cwd, artifactDirectory);
	await mkdir(directory, { recursive: true });
	const identity: AttemptIdentity = { version: 1, issue: 2, epic: 1, artifactDirectory, beforeHead: base, issueBaseCommit: base, workerKind: "implementation", ...extra };
	await writeAttemptIdentity(directory, identity);
	return { directory, identity };
}
const preservation = { version: 1, head: base, commits: 0, staged: 0, unstaged: 0, untracked: 0, capture: "complete", failures: [] };
function finalResult(identity: AttemptIdentity) {
	return { beforeHead: identity.beforeHead, status: "completed", commit: null, preservation, artifacts: { directory: identity.artifactDirectory } };
}

for (const state of ["missing", "empty", "truncated", "malformed", "mismatched", "oversized", "symlink", "invalid-preservation"] as const) {
	test(`scanner retains ${state} final result as interrupted without inventing a commit`, async (t) => {
		const cwd = await fixture(t);
		const { directory, identity } = await attempt(cwd);
		const file = path.join(directory, "result.json");
		if (state === "invalid-preservation") await writeFile(file, JSON.stringify({ ...finalResult(identity), commit: base, preservation: {} }));
		if (state === "empty") await writeFile(file, "");
		if (state === "truncated") await writeFile(file, '{"status":"completed",');
		if (state === "malformed") await writeFile(file, "not JSON");
		if (state === "mismatched") await writeFile(file, JSON.stringify({ status: "completed", commit: base, artifacts: { directory: "foreign" } }));
		if (state === "oversized") await writeFile(file, " ".repeat(1_000_001));
		if (state === "symlink") {
			await writeFile(path.join(cwd, "outside"), "private");
			await symlink(path.join(cwd, "outside"), file);
		}
		await writeFile(path.join(directory, ".result-leftover.tmp"), '{"commit":"not published"}');
		const before = await readdir(directory);
		const [record] = await scanAttemptArtifacts(cwd);
		assert.equal(record?.status, "interrupted");
		assert.equal(record?.commit, null);
		assert.equal(record?.beforeHead, base);
		assert.equal(record?.issueBaseCommit, base);
		assert.equal(record?.preservation?.capture, "incomplete");
		assert.equal(record?.preservation?.commits, null);
		assert.deepEqual(await readdir(directory), before);
		assert.deepEqual(await scanAttemptArtifacts(cwd), [record]);
	});
}

test("invalid new metadata does not downgrade a final result to legacy acceptance", async (t) => {
	const cwd = await fixture(t);
	const { directory, identity } = await attempt(cwd);
	await writeFile(path.join(directory, "issue-context.json"), JSON.stringify({ version: 1, selectedIssue: { number: 2 }, issueBaseCommit: base, attemptStartCommit: base }));
	await writeFile(path.join(directory, "attempt.json"), "{");
	await writeFile(path.join(directory, "result.json"), JSON.stringify(finalResult(identity)));
	assert.equal((await scanAttemptArtifacts(cwd))[0]?.status, "interrupted");
});

test("legacy startup context recovers interrupted identity; foreign context cannot", async (t) => {
	const cwd = await fixture(t);
	const { directory } = await attempt(cwd);
	await unlink(path.join(directory, "attempt.json"));
	const contextPath = path.join(directory, "issue-context.json");
	await writeFile(contextPath, JSON.stringify({ version: 1, selectedIssue: { number: 2 }, issueBaseCommit: base, attemptStartCommit: base }));
	assert.equal((await scanAttemptArtifacts(cwd))[0]?.status, "interrupted");
	await writeFile(contextPath, JSON.stringify({ version: 1, selectedIssue: { number: 99 }, issueBaseCommit: base, attemptStartCommit: base }));
	assert.deepEqual(await scanAttemptArtifacts(cwd), []);
});

test("atomic publication exposes whole documents and replaces the reserved inode", async (t) => {
	const cwd = await fixture(t);
	const { directory, identity } = await attempt(cwd);
	const file = path.join(directory, "result.json");
	await writeFile(file, '{"reserved":true}\n');
	const inode = (await lstat(file)).ino;
	const { publish, close } = await prepareResultPublication(directory);
	t.after(close);
	let done = false;
	const result = finalResult(identity);
	const pending = publish(result).finally(() => { done = true; });
	while (!done) {
		const observed = JSON.parse(await readFile(file, "utf8"));
		assert.ok(observed.reserved === true || observed.status === "completed");
	}
	await pending;
	assert.deepEqual(JSON.parse(await readFile(file, "utf8")), result);
	assert.notEqual((await lstat(file)).ino, inode);
	assert.equal((await scanAttemptArtifacts(cwd))[0]?.status, "completed");
	assert.equal((await lstat(file)).mode & 0o777, 0o600);
	assert.deepEqual((await readdir(directory)).sort(), ["attempt.json", "result.json"]);
});

test("failed oversized publication retains recoverable identity and previous result", async (t) => {
	const cwd = await fixture(t);
	const { directory } = await attempt(cwd);
	const file = path.join(directory, "result.json");
	await writeFile(file, "");
	const { publish, close } = await prepareResultPublication(directory);
	t.after(close);
	await assert.rejects(publish({ oversized: "x".repeat(1_000_000) }), /record limit/);
	assert.equal(await readFile(file, "utf8"), "");
	assert.equal((await scanAttemptArtifacts(cwd))[0]?.status, "interrupted");
});

for (const replacement of ["result", "directory"] as const) {
	test(`publication rejects replaced ${replacement} without writing through symlinks`, async (t) => {
		const cwd = await fixture(t);
		const { directory } = await attempt(cwd);
		const file = path.join(directory, "result.json");
		await writeFile(file, "");
		const { publish, close } = await prepareResultPublication(directory);
		t.after(close);
		const outside = path.join(cwd, "outside");
		await mkdir(outside);
		await writeFile(path.join(outside, "result.json"), "keep");
		if (replacement === "result") {
			await unlink(file); await symlink(path.join(outside, "result.json"), file);
		} else {
			await rename(directory, `${directory}-old`); await symlink(outside, directory);
		}
		await assert.rejects(publish({ success: true }), /replaced/);
		assert.equal(await readFile(path.join(outside, "result.json"), "utf8"), "keep");
		assert.deepEqual(await readdir(outside), ["result.json"]);
	});
}

test("directory swap between check and temp creation cannot redirect publication writes", async (t) => {
	const cwd = await fixture(t);
	const { directory } = await attempt(cwd);
	await writeFile(path.join(directory, "result.json"), "");
	const { publish, close } = await prepareResultPublication(directory);
	t.after(close);
	const outside = path.join(cwd, "outside");
	await mkdir(outside);
	await writeFile(path.join(outside, "result.json"), "keep");
	const originalOpen = fsPromises.open;
	let swapped = false;
	t.mock.method(fsPromises, "open", async (...args: Parameters<typeof originalOpen>) => {
		if (!swapped && String(args[0]).includes(".result-")) {
			swapped = true;
			await rename(directory, `${directory}-old`);
			await symlink(outside, directory);
		}
		return originalOpen(...args);
	});
	await assert.rejects(publish({ success: true }), /replaced/);
	assert.equal(swapped, true);
	assert.equal(await readFile(path.join(outside, "result.json"), "utf8"), "keep");
	assert.deepEqual(await readdir(outside), ["result.json"]);
	assert.deepEqual((await readdir(`${directory}-old`)).sort(), ["attempt.json", "result.json"]);
});

test("directory swap immediately before rename stays bound to original directory", async (t) => {
	const cwd = await fixture(t);
	const { directory } = await attempt(cwd);
	await writeFile(path.join(directory, "result.json"), "");
	const { publish, close } = await prepareResultPublication(directory);
	t.after(close);
	const outside = path.join(cwd, "outside");
	await mkdir(outside);
	await writeFile(path.join(outside, "result.json"), "keep");
	const originalRename = fsPromises.rename;
	t.mock.method(fsPromises, "rename", async (source: Parameters<typeof originalRename>[0], target: Parameters<typeof originalRename>[1]) => {
		if (String(source).includes(".result-")) {
			await originalRename(directory, `${directory}-old`);
			await symlink(outside, directory);
		}
		return originalRename(source, target);
	});
	await assert.rejects(publish({ success: true }), /replaced/);
	assert.equal(await readFile(path.join(outside, "result.json"), "utf8"), "keep");
	assert.deepEqual(await readdir(outside), ["result.json"]);
	assert.deepEqual(JSON.parse(await readFile(path.join(`${directory}-old`, "result.json"), "utf8")), { success: true });
});

test("patch startup identity recovers parent association before ledger publication", async (t) => {
	const cwd = await fixture(t);
	const parent = await attempt(cwd);
	await writeFile(path.join(parent.directory, "result.json"), JSON.stringify(finalResult(parent.identity)));
	await attempt(cwd, "101-fedcba", { workerKind: "patch", parentArtifactDirectory: parent.identity.artifactDirectory });
	const records = await scanAttemptArtifacts(cwd);
	assert.equal(records.length, 1);
	assert.equal(records[0]?.artifactDirectory, parent.identity.artifactDirectory);
	assert.equal(records[0]?.status, "interrupted");
	assert.equal(records[0]?.preservation?.capture, "incomplete");
});

test("ledger cannot suppress an explicitly identified implementation as a patch", async (t) => {
	const cwd = await fixture(t);
	const parent = await attempt(cwd);
	const other = await attempt(cwd, "101-fedcba");
	await writeFile(path.join(parent.directory, "patch-attempts.json"), JSON.stringify([{ artifactDirectory: other.identity.artifactDirectory }]));
	assert.equal((await scanAttemptArtifacts(cwd)).length, 2);
});

test("malformed patch ledger retains parent evidence; cross-issue link cannot suppress another issue", async (t) => {
	const cwd = await fixture(t);
	const parent = await attempt(cwd);
	await writeFile(path.join(parent.directory, "result.json"), JSON.stringify(finalResult(parent.identity)));
	await writeFile(path.join(parent.directory, "patch-attempts.json"), "{");
	assert.equal((await scanAttemptArtifacts(cwd))[0]?.preservation?.capture, "incomplete");
	const foreign = ".pi/tmp/aloop/issue-3-102-aaaaaa";
	await mkdir(path.join(cwd, foreign));
	await writeFile(path.join(cwd, foreign, "result.json"), JSON.stringify({ status: "timeout", commit: null, artifacts: { directory: foreign } }));
	await writeFile(path.join(parent.directory, "patch-attempts.json"), JSON.stringify([{ artifactDirectory: foreign }]));
	assert.equal((await scanAttemptArtifacts(cwd)).length, 2);
});
