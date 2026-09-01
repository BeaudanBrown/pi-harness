import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
	assessAttemptContract,
	buildAloopWorkerCommand,
	buildAloopWorkerPrompt,
	parseAloopWorkerResult,
	prepareAloopArtifactDirectory,
	resolveAloopArtifactPath,
	runAloopWorker,
	runIsolatedAloopProcess,
} from "../config/agent/extensions/github-issues/aloop-worker.js";

const exec = promisify(execFile);
const fakeWorker = path.resolve("tests/fixtures/aloop-worker/fake-worker.mjs");

async function createRepository(): Promise<string> {
	const cwd = await mkdtemp(path.join(tmpdir(), "aloop-worker-test-"));
	await exec("git", ["init", "-q"], { cwd });
	await exec("git", ["config", "user.email", "aloop@example.invalid"], { cwd });
	await exec("git", ["config", "user.name", "Aloop Test"], { cwd });
	await writeFile(path.join(cwd, "README.md"), "fixture\n", "utf8");
	await writeFile(path.join(cwd, ".gitignore"), ".pi/\n", "utf8");
	await exec("git", ["add", "README.md", ".gitignore"], { cwd });
	await exec("git", ["commit", "-q", "-m", "initial"], { cwd });
	return cwd;
}

const workerInput = {
	attemptType: "implementation" as const,
	epic: { number: 48, title: "Epic", body: "Coordinate implementation." },
	issue: { number: 50, title: "Worker execution", body: "Implement the isolated worker." },
	priorHandoffs: [{ id: 1, author: "supervisor", body: "Prior evidence", createdAt: "2026-09-01", url: null }],
};

test("worker prompt and command are compact, non-interactive, and deny supervisor-owned mutations", () => {
	const prompt = buildAloopWorkerPrompt(workerInput);
	const command = buildAloopWorkerCommand({ launcher: ["node", "pi.js"], prompt, modelRef: "provider/model" });

	assert.deepEqual(command.slice(0, 2), ["node", "pi.js"]);
	assert.equal(command.includes("--mode") && command.includes("json"), true);
	assert.equal(command.includes("--no-session"), true);
	assert.equal(command.includes("--no-extensions"), true);
	assert.equal(command.includes("--approve"), true);
	assert.equal(command.at(-1), prompt);
	assert.match(prompt, /Do not use GitHub APIs/);
	assert.match(prompt, /Do not push or fetch/);
	assert.match(prompt, /exactly one new local commit/);
	assert.match(prompt, /final assistant message must contain only one JSON object/);
});

test("structured worker results are parsed from the final assistant JSON event", () => {
	const result = {
		status: "implemented",
		summary: "Implemented.",
		verification: ["tests passed"],
		acceptanceCriteria: [{ criterion: "works", satisfied: true, evidence: "test" }],
		discoveredWork: [],
		nextAction: "Close the issue.",
	};
	const stream = [
		JSON.stringify({ type: "session" }),
		"not-json startup noise",
		JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: JSON.stringify(result) }] } }),
	].join("\n");
	assert.deepEqual(parseAloopWorkerResult(stream), result);
	assert.throws(() => parseAloopWorkerResult(JSON.stringify({ type: "agent_end" })), /final assistant text/);
});

test("attempt contract rejects dirty, missing, rewritten, and multiple commits", () => {
	assert.equal(assessAttemptContract({ beforeHead: "a", afterHead: "b", commitCount: 1, beforeIsAncestor: true, worktreeStatus: "" }).valid, true);
	assert.match(assessAttemptContract({ beforeHead: "a", afterHead: "a", commitCount: 0, beforeIsAncestor: true, worktreeStatus: "" }).violations.join(" "), /did not create/);
	assert.match(assessAttemptContract({ beforeHead: "a", afterHead: "c", commitCount: 2, beforeIsAncestor: true, worktreeStatus: "" }).violations.join(" "), /2 commits/);
	assert.match(assessAttemptContract({ beforeHead: "a", afterHead: "b", commitCount: 1, beforeIsAncestor: true, worktreeStatus: " M file" }).violations.join(" "), /not clean/);
	assert.match(assessAttemptContract({ beforeHead: "a", afterHead: "b", commitCount: 0, beforeIsAncestor: false, worktreeStatus: "" }).violations.join(" "), /rewrote/);
});

test("artifact paths cannot escape the aloop temporary root", () => {
	const cwd = path.resolve("fixture-repo");
	assert.equal(resolveAloopArtifactPath(cwd, "attempt", "stdout.jsonl"), path.join(cwd, ".pi/tmp/aloop/attempt/stdout.jsonl"));
	assert.throws(() => resolveAloopArtifactPath(cwd, "..", "outside"), /escapes/);
	assert.throws(() => resolveAloopArtifactPath(cwd, "/absolute"), /relative segments/);
});

test("symlinked artifact roots are rejected without writing outside the repository", async () => {
	const cwd = await createRepository();
	const outside = await mkdtemp(path.join(tmpdir(), "aloop-artifact-outside-"));
	try {
		await symlink(outside, path.join(cwd, ".pi"));
		await assert.rejects(prepareAloopArtifactDirectory(cwd, "attempt"), /symbolic link/);
		assert.deepEqual(await readdir(outside), []);
	} finally {
		await rm(cwd, { recursive: true, force: true });
		await rm(outside, { recursive: true, force: true });
	}
});

test("artifact descriptors prevent worker-time symlink replacement from escaping", async () => {
	const cwd = await createRepository();
	const outside = path.join(await mkdtemp(path.join(tmpdir(), "aloop-result-outside-")), "result.json");
	try {
		await assert.rejects(
			runAloopWorker({
				...workerInput,
				cwd,
				launcher: [process.execPath, fakeWorker],
				env: { FAKE_ALOOP_MODE: "replace-result", FAKE_ALOOP_OUTSIDE: outside },
			}),
			/artifact was replaced/,
		);
		await assert.rejects(readFile(outside, "utf8"));
	} finally {
		await rm(cwd, { recursive: true, force: true });
		await rm(path.dirname(outside), { recursive: true, force: true });
	}
});

test("dirty worktrees are rejected before a worker starts", async () => {
	const cwd = await createRepository();
	try {
		await writeFile(path.join(cwd, "dirty.txt"), "dirty\n", "utf8");
		await assert.rejects(runAloopWorker({ ...workerInput, cwd, launcher: [process.execPath, fakeWorker] }), /worktree is dirty/);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("deadline expiry during Git preflight prevents worker spawn", async () => {
	const cwd = await createRepository();
	const originalPath = process.env.PATH;
	try {
		const realGit = (await exec("sh", ["-c", "command -v git"])).stdout.trim();
		const bin = path.join(cwd, "slow-bin");
		await mkdir(bin);
		await writeFile(path.join(bin, "git"), `#!/bin/sh\nsleep 1\nexec "${realGit}" "$@"\n`, "utf8");
		await chmod(path.join(bin, "git"), 0o755);
		process.env.PATH = `${bin}:${originalPath}`;
		await assert.rejects(
			runAloopWorker({ ...workerInput, cwd, launcher: [process.execPath, fakeWorker], deadlineMs: Date.now() + 100 }),
			/Git command (?:timed out|deadline expired)/,
		);
		assert.equal((await exec(realGit, ["rev-list", "--count", "HEAD"], { cwd })).stdout.trim(), "1");
	} finally {
		process.env.PATH = originalPath;
		await rm(cwd, { recursive: true, force: true });
	}
});

test("tracked modifications under the artifact root still make the worktree dirty", async () => {
	const cwd = await createRepository();
	try {
		const tracked = path.join(cwd, ".pi/tmp/aloop/tracked.txt");
		await mkdir(path.dirname(tracked), { recursive: true });
		await writeFile(tracked, "tracked\n", "utf8");
		await exec("git", ["add", "-f", ".pi/tmp/aloop/tracked.txt"], { cwd });
		await exec("git", ["commit", "-q", "-m", "track artifact fixture"], { cwd });
		await writeFile(tracked, "modified\n", "utf8");
		await assert.rejects(runAloopWorker({ ...workerInput, cwd, launcher: [process.execPath, fakeWorker] }), /worktree is dirty/);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("worker execution records a clean one-commit attempt and complete artifacts", async () => {
	const cwd = await createRepository();
	try {
		const outcome = await runAloopWorker({
			...workerInput,
			cwd,
			launcher: [process.execPath, fakeWorker],
			env: { FAKE_ALOOP_MODE: "success" },
		});
		assert.equal(outcome.status, "completed");
		assert.match(outcome.commit ?? "", /^[0-9a-f]{40}$/);
		assert.equal(outcome.workerResult?.status, "implemented");
		assert.match(await readFile(path.join(cwd, outcome.artifacts.stdout), "utf8"), /message_end/);
		assert.match(await readFile(path.join(cwd, outcome.artifacts.stderr), "utf8"), /synthetic stderr/);
		assert.equal((await exec("git", ["status", "--porcelain=v1", "--untracked-files=all", "--", ".", ":(exclude).pi/tmp/aloop"], { cwd })).stdout.trim(), "");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("launcher failures return a bounded outcome and finalized result artifact", async () => {
	const cwd = await createRepository();
	try {
		const outcome = await runAloopWorker({ ...workerInput, cwd, launcher: [path.join(cwd, "missing-pi")] });
		assert.equal(outcome.status, "worker-failed");
		assert.match(outcome.summary, /ENOENT|spawn/);
		const artifact = JSON.parse(await readFile(path.join(cwd, outcome.artifacts.result), "utf8"));
		assert.match(artifact.launchError, /ENOENT|spawn/);
		assert.equal(await readFile(path.join(cwd, outcome.artifacts.stdout), "utf8"), "");
		assert.equal(await readFile(path.join(cwd, outcome.artifacts.stderr), "utf8"), "");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("worker execution rejects no-commit and multiple-commit attempts", async () => {
	for (const mode of ["no-commit", "multiple-commits"]) {
		const cwd = await createRepository();
		try {
			const outcome = await runAloopWorker({
				...workerInput,
				cwd,
				launcher: [process.execPath, fakeWorker],
				env: { FAKE_ALOOP_MODE: mode },
			});
			assert.equal(outcome.status, "contract-violation");
			assert.equal(outcome.contract.valid, false);
			assert.match(outcome.contract.violations.join(" "), mode === "no-commit" ? /did not create/ : /2 commits/);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	}
});

async function waitForExit(pid: number): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		try { process.kill(pid, 0); } catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
			throw error;
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.fail(`process ${pid} remained alive`);
}

test("timeouts terminate the complete worker process group", async () => {
	const cwd = await mkdtemp(path.join(tmpdir(), "aloop-timeout-test-"));
	try {
		const stdoutPath = path.join(cwd, "stdout.jsonl");
		const stderrPath = path.join(cwd, "stderr.log");
		const result = await runIsolatedAloopProcess({
			cwd,
			command: [process.execPath, fakeWorker],
			stdoutPath,
			stderrPath,
			timeoutMs: 250,
			shutdownGraceMs: 100,
			env: { FAKE_ALOOP_MODE: "timeout" },
		});
		assert.equal(result.timedOut, true);
		const grandchild = Number((await readFile(stderrPath, "utf8")).match(/grandchild:(\d+)/)?.[1]);
		assert.equal(Number.isInteger(grandchild), true);
		await waitForExit(grandchild);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});
