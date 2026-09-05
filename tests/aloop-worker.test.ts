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
	resolveProjectWorkerResources,
	runAloopPatchWorker,
	runAloopWorker,
	selectAloopPatchModel,
	runIsolatedAloopProcess,
} from "../config/agent/extensions/github-issues/aloop-worker.js";
import { resolveAgentProfile, withProjectWorkerOptIn } from "../config/agent/extensions/agent-profiles/core.js";

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
	supervisorApproach: "Use the exact protocol fixture and repair only the failing seam.",
	epic: { number: 48, title: "Epic", body: "Coordinate implementation." },
	issue: { number: 50, title: "Worker execution", body: "Implement the isolated worker." },
	priorHandoffs: [{
		attemptType: "implementation" as const,
		commit: "abcdef1",
		successful: false,
		approach: "Initial implementation",
		verification: ["Unit tests passed but protocol review failed."],
		acceptanceCriteriaAssessment: ["Stable payload was malformed."],
		discoveredWork: ["Use the normative stable fixture."],
		nextAction: "Replace the hybrid payload with the exact fixture.",
		timestamp: "2026-09-01T00:00:00Z",
	}],
};

test("worker prompt and command are compact, non-interactive, and deny supervisor-owned mutations", () => {
	const prompt = buildAloopWorkerPrompt(workerInput);
	const command = buildAloopWorkerCommand({ launcher: ["node", "pi.js"], prompt, modelRef: "provider/model" });

	assert.deepEqual(command.slice(0, 2), ["node", "pi.js"]);
	assert.equal(command.includes("--mode") && command.includes("json"), true);
	assert.equal(command.includes("--no-session"), true);
	assert.equal(command.includes("--no-extensions"), true);
	assert.equal(command.includes("--approve"), true);
	assert.deepEqual(command.slice(command.indexOf("--thinking"), command.indexOf("--thinking") + 2), ["--thinking", "medium"]);
	assert.equal(command.at(-1), prompt);
	assert.match(prompt, /aloop_issue_context first/);
	assert.match(prompt, /Never push, fetch, mutate GitHub/);
	assert.match(prompt, /one or more coherent local commits/);
	assert.match(prompt, /strict implementation boundary/);
	assert.doesNotMatch(prompt, /Use the exact protocol fixture|Stable payload was malformed|Replace the hybrid payload/);
	assert.doesNotMatch(prompt, /Coordinate implementation|Implement the isolated worker|Worker execution/);
	assert.doesNotMatch(prompt, /pi-aloop-handoff:v2:|final assistant message/);
	assert.match(prompt, /aloop_submit_result/);
});

test("implementation worker command resolves declared resources and explicit project opt-ins", async () => {
	const cwd = await mkdtemp(path.join(tmpdir(), "aloop-profile-resources-"));
	try {
		await mkdir(path.join(cwd, ".pi"), { recursive: true });
		await writeFile(path.join(cwd, ".pi", "worker.ts"), "export default () => {};\n");
		const project = await resolveProjectWorkerResources(cwd, { extensions: [".pi/worker.ts"], tools: ["project_lookup"] });
		const profile = withProjectWorkerOptIn(resolveAgentProfile("aloop-implementation"), { tools: project.tools });
		const command = buildAloopWorkerCommand({
			launcher: ["node", "pi.js"], prompt: "work", profile, projectExtensions: project.extensions,
			resourceRoots: { harness: "/nix/harness", mattSkills: "/nix/matt", lspExtension: "/nix/lsp/index.ts" },
		});
		assert.ok(command.includes("/nix/harness/extensions/review-agents/index.ts"));
		assert.ok(command.includes("/nix/harness/extensions/aloop-worker-runtime/index.ts"));
		assert.ok(command.includes("/nix/lsp/index.ts"));
		assert.equal(command.filter((argument) => argument === path.join(cwd, ".pi", "worker.ts")).length, 1);
		assert.equal(command.some((argument) => argument.includes("extensions/repo/") || argument.endsWith("worker.ts/index.ts")), false);
		assert.match(command[command.indexOf("--tools") + 1]!, /project_lookup/);
		assert.doesNotMatch(command[command.indexOf("--tools") + 1]!, /github_issue_mutate/);
		await assert.rejects(resolveProjectWorkerResources(cwd, { extensions: ["../escape.ts"], tools: [] }), /escapes/);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("structured worker submissions are parsed without final-message JSON", () => {
	const result = {
		status: "candidate-complete",
		summary: "Implemented.",
		verification: ["tests passed"],
		acceptanceCriteria: [{ criterion: "works", satisfied: true, evidence: "test" }],
		discoveredWork: [],
		nextAction: "Close the issue.",
	};
	assert.deepEqual(parseAloopWorkerResult(JSON.stringify(result)), result);
	assert.throws(() => parseAloopWorkerResult("not-json"), /not valid JSON/);
	assert.throws(() => parseAloopWorkerResult(JSON.stringify({ ...result, status: "legacy" })), /invalid status/);
});

test("attempt contract allows multiple/no-change outcomes and protects successful cleanliness and ancestry", () => {
	assert.equal(assessAttemptContract({ beforeHead: "a", afterHead: "c", commitCount: 2, beforeIsAncestor: true, worktreeStatus: "", workerStatus: "candidate-complete" }).valid, true);
	assert.equal(assessAttemptContract({ beforeHead: "a", afterHead: "a", commitCount: 0, beforeIsAncestor: true, worktreeStatus: "", workerStatus: "already-satisfied" }).valid, true);
	assert.match(assessAttemptContract({ beforeHead: "a", afterHead: "a", commitCount: 0, beforeIsAncestor: true, worktreeStatus: "", workerStatus: "candidate-complete" }).violations.join(" "), /requires at least one/);
	assert.match(assessAttemptContract({ beforeHead: "a", afterHead: "b", commitCount: 1, beforeIsAncestor: true, worktreeStatus: " M file", workerStatus: "candidate-complete" }).violations.join(" "), /clean worktree/);
	assert.equal(assessAttemptContract({ beforeHead: "a", afterHead: "b", commitCount: 1, beforeIsAncestor: true, worktreeStatus: " M file", workerStatus: "incomplete" }).valid, true);
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
			issueContext: { relationships: { blockedBy: [49] }, decision: "Use v3" },
			launcher: [process.execPath, fakeWorker],
			env: { FAKE_ALOOP_MODE: "success" },
		});
		assert.equal(outcome.status, "completed");
		assert.match(outcome.commit ?? "", /^[0-9a-f]{40}$/);
		assert.equal(outcome.workerResult?.status, "candidate-complete");
		assert.equal(outcome.modelUsage?.[0]?.inputTokens, 7);
		assert.match(await readFile(path.join(cwd, outcome.artifacts.submission!), "utf8"), /candidate-complete/);
		const contextArtifact = await readFile(path.join(cwd, outcome.artifacts.context!), "utf8");
		assert.match(contextArtifact, /issueBaseCommit/);
		assert.match(contextArtifact, /"blockedBy": \[\s*49/);
		assert.match(contextArtifact, /"decision": "Use v3"/);
		assert.match(await readFile(path.join(cwd, outcome.artifacts.stderr), "utf8"), /synthetic stderr/);
		assert.equal((await exec("git", ["status", "--porcelain=v1", "--untracked-files=all", "--", ".", ":(exclude).pi/tmp/aloop"], { cwd })).stdout.trim(), "");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("implementation workers preserve project PATH precedence and append configured LSP fallbacks", async () => {
	const cwd = await createRepository();
	const previous = process.env.PI_HARNESS_LSP_FALLBACK_PATH;
	process.env.PI_HARNESS_LSP_FALLBACK_PATH = "/harness/lsp-fallback/bin";
	try {
		const projectPath = `/project/dev-shell/bin:${process.env.PATH}`;
		const outcome = await runAloopWorker({
			...workerInput,
			cwd,
			launcher: [process.execPath, fakeWorker],
			env: { FAKE_ALOOP_MODE: "environment", PATH: projectPath },
		});
		assert.equal(outcome.status, "completed");
		const environment = JSON.parse(await readFile(path.join(cwd, "worker-environment.json"), "utf8"));
		assert.equal(environment.path, `${projectPath}:/harness/lsp-fallback/bin`);
	} finally {
		if (previous === undefined) delete process.env.PI_HARNESS_LSP_FALLBACK_PATH;
		else process.env.PI_HARNESS_LSP_FALLBACK_PATH = previous;
		await rm(cwd, { recursive: true, force: true });
	}
});

test("targeted patch workers use the narrow profile, medium thinking, model fallback, and structured submission", async () => {
	assert.equal(selectAloopPatchModel({ available: (value) => value.includes("terra"), active: "active/model" }), "openai-codex/gpt-5.6-terra");
	assert.equal(selectAloopPatchModel({ configured: "missing/model", available: () => false, active: "active/model" }), "active/model");
	const cwd = await createRepository();
	try {
		const outcome = await runAloopPatchWorker({
			cwd, epic: workerInput.epic, issue: workerInput.issue, correction: "Change only the failing assertion.",
			projectWorkerResources: { extensions: ["missing-review-extension.ts"], tools: ["review_agents", "web_search"] },
			launcher: [process.execPath, fakeWorker], env: { FAKE_ALOOP_MODE: "patch", PI_HARNESS_RESOURCES_ROOT: path.resolve("config/agent") }, modelRef: "active/model",
		});
		assert.equal(outcome.status, "completed");
		assert.equal(outcome.workerResult?.status, "candidate-complete");
		const artifact = JSON.parse(await readFile(path.join(cwd, outcome.artifacts.result), "utf8"));
		assert.ok(artifact.command.includes("active/model"));
		assert.ok(artifact.command.includes("medium"));
		assert.match(artifact.command.join(" "), /aloop-patch-runtime/);
		assert.doesNotMatch(artifact.command[artifact.command.indexOf("--tools") + 1], /review_agents|github_issue|web_search|remote_|aloop_issue_context/);
		assert.doesNotMatch(artifact.command.join(" "), /missing-review-extension/);
	} finally { await rm(cwd, { recursive: true, force: true }); }
});

test("targeted patch spawn deadline is enforced at the process boundary", async () => {
	const cwd = await createRepository();
	try {
		const outcome = await runAloopPatchWorker({
			cwd, epic: workerInput.epic, issue: workerInput.issue, correction: "Change one assertion.",
			launcher: [process.execPath, fakeWorker], env: { FAKE_ALOOP_MODE: "patch" }, spawnDeadlineMs: Date.now() - 1,
		});
		assert.equal(outcome.status, "worker-failed");
		assert.match(outcome.summary, /spawn deadline/);
		await assert.rejects(readFile(path.join(cwd, "worker-one.txt"), "utf8"));
	} finally { await rm(cwd, { recursive: true, force: true }); }
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

test("worker execution accepts explicit no-change and multiple-commit outcomes", async () => {
	for (const mode of ["no-commit", "multiple-commits"]) {
		const cwd = await createRepository();
		try {
			const outcome = await runAloopWorker({
				...workerInput,
				cwd,
				launcher: [process.execPath, fakeWorker],
				env: { FAKE_ALOOP_MODE: mode },
			});
			assert.equal(outcome.status, "completed");
			assert.equal(outcome.contract.valid, true);
			assert.equal(outcome.workerResult?.status, mode === "no-commit" ? "already-satisfied" : "candidate-complete");
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	}
});

test("missing and unsuccessful submissions preserve reconstructable Git artifacts", async () => {
	for (const mode of ["missing-submission", "dirty"]) {
		const cwd = await createRepository();
		try {
			const outcome = await runAloopWorker({
				...workerInput, cwd, launcher: [process.execPath, fakeWorker], env: { FAKE_ALOOP_MODE: mode },
			});
			assert.equal(outcome.status, mode === "missing-submission" ? "missing-submission" : "completed");
			assert.equal(outcome.contract.valid, true);
			const untracked = JSON.parse(await readFile(path.join(cwd, outcome.artifacts.untracked!), "utf8"));
			if (mode === "dirty") {
				assert.deepEqual(untracked, ["dirty.txt"]);
				assert.equal(await readFile(path.join(cwd, outcome.artifacts.directory, "untracked/dirty.txt"), "utf8"), "preserve me\n");
			}
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

test("cancelled full workers preserve dirty partial work and finalized artifacts", async () => {
	const cwd = await createRepository();
	const controller = new AbortController();
	setTimeout(() => controller.abort(), 100).unref?.();
	try {
		const outcome = await runAloopWorker({
			...workerInput, cwd, launcher: [process.execPath, fakeWorker], env: { FAKE_ALOOP_MODE: "timeout" }, timeoutMs: 5_000, signal: controller.signal,
		});
		assert.equal(outcome.status, "cancelled");
		assert.deepEqual(JSON.parse(await readFile(path.join(cwd, outcome.artifacts.untracked!), "utf8")), ["timeout-partial.txt"]);
		assert.equal(JSON.parse(await readFile(path.join(cwd, outcome.artifacts.result), "utf8")).status, "cancelled");
	} finally { await rm(cwd, { recursive: true, force: true }); }
});

test("timed-out full workers preserve dirty partial work and reconstruction artifacts", async () => {
	const cwd = await createRepository();
	try {
		const outcome = await runAloopWorker({
			...workerInput, cwd, launcher: [process.execPath, fakeWorker], env: { FAKE_ALOOP_MODE: "timeout" }, timeoutMs: 250,
		});
		assert.equal(outcome.status, "timeout");
		assert.equal(outcome.preservation?.capture, "complete");
		assert.equal(outcome.preservation?.untracked, 1);
		assert.match(outcome.summary, /0 commits; 0 staged, 0 unstaged, 1 untracked paths/);
		const persisted = JSON.parse(await readFile(path.join(cwd, outcome.artifacts.result), "utf8"));
		assert.deepEqual(persisted.preservation, outcome.preservation);
		const untracked = JSON.parse(await readFile(path.join(cwd, outcome.artifacts.untracked!), "utf8"));
		assert.deepEqual(untracked, ["timeout-partial.txt"]);
		assert.equal(await readFile(path.join(cwd, outcome.artifacts.directory, "untracked/timeout-partial.txt"), "utf8"), "preserve me\n");
	} finally { await rm(cwd, { recursive: true, force: true }); }
});

test("failed postflight HEAD inspection persists unknown rather than invented zero-change state", async () => {
	const cwd = await createRepository();
	const originalPath = process.env.PATH;
	try {
		const realGit = (await exec("sh", ["-c", "command -v git"])).stdout.trim();
		const bin = path.join(cwd, ".pi", "fault-bin");
		await mkdir(bin, { recursive: true });
		await writeFile(path.join(bin, "git"), `#!/bin/sh\nif [ "$1" = rev-parse ] && [ -f timeout-partial.txt ]; then exit 1; fi\nexec "${realGit}" "$@"\n`);
		await chmod(path.join(bin, "git"), 0o755);
		process.env.PATH = `${bin}:${originalPath}`;
		const outcome = await runAloopWorker({ ...workerInput, cwd, launcher: [process.execPath, fakeWorker], env: { FAKE_ALOOP_MODE: "timeout" }, timeoutMs: 250 });
		const record = JSON.parse(await readFile(path.join(cwd, outcome.artifacts.result), "utf8"));
		assert.equal(record.afterHead, null);
		assert.equal(record.commitCount, null);
		assert.equal(outcome.preservation?.commits, null);
		assert.equal(outcome.contract.valid, false);
		assert.match(outcome.summary, /unknown commits/);
		assert.equal(await readFile(path.join(cwd, "timeout-partial.txt"), "utf8"), "preserve me\n");
	} finally {
		process.env.PATH = originalPath;
		await rm(cwd, { recursive: true, force: true });
	}
});

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
