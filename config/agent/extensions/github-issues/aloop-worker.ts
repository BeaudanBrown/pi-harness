import { spawn } from "node:child_process";
import { constants, createWriteStream } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import * as path from "node:path";
import { resolveAgentProfile, withProjectWorkerOptIn, type AgentProfile } from "../agent-profiles/core.js";
import { collectSessionUsage, readNestedModelUsage, type NestedModelUsage } from "../agent-profiles/usage.js";

import { prepareResultPublication, syncAttemptDirectory, writeAttemptIdentity } from "./aloop-artifacts.js";
import { preserveAttempt, preservationSummary, type PreservationEvidence } from "./aloop-preservation.js";

const ALOOP_ROOT = ".pi/tmp/aloop";
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_TIMEOUT_MS = 4 * 60 * 60 * 1000;
const SHUTDOWN_GRACE_MS = 1_000;
const MAX_CAPTURE_BYTES = 10 * 1024 * 1024;
const MAX_SUMMARY_BYTES = 2_000;
const DEFAULT_GIT_TIMEOUT_MS = 30_000;
const POSTFLIGHT_RESERVE_MS = 5_000;

export type AloopAttemptType = "implementation" | "remediation";

export type AloopWorkerHandoffContext = {
	attemptType: AloopAttemptType;
	commit: string | null;
	successful: boolean;
	approach: string;
	verification: string[];
	acceptanceCriteriaAssessment: string[];
	discoveredWork: string[];
	nextAction: string;
	timestamp: string;
};

export type AloopWorkerInput = {
	cwd: string;
	attemptType: AloopAttemptType;
	supervisorApproach: string;
	epic: { number: number; title: string; body: string };
	issue: { number: number; title: string; body: string };
	priorHandoffs?: AloopWorkerHandoffContext[];
	projectWorkerResources?: { extensions: string[]; tools: string[] };
	workerFeedbackCommand?: { argv: string[]; timeoutMs: number };
	issueContext?: unknown;
	issueBaseCommit?: string;
	workerKind?: "implementation" | "patch";
	patchDirection?: string;
	parentArtifactDirectory?: string;
	launcher?: string[];
	modelRef?: string;
	timeoutMs?: number;
	deadlineMs?: number;
	spawnDeadlineMs?: number;
	signal?: AbortSignal;
	env?: NodeJS.ProcessEnv;
};

export type AloopWorkerResultStatus = "candidate-complete" | "already-satisfied" | "incomplete" | "decision-required" | "environment-blocked";

export type AloopWorkerResult = {
	status: AloopWorkerResultStatus;
	summary: string;
	verification: string[];
	acceptanceCriteria: Array<{ criterion: string; satisfied: boolean; evidence: string }>;
	discoveredWork: string[];
	nextAction: string;
};

export type AttemptContractAssessment = {
	valid: boolean;
	commit: string | null;
	violations: string[];
};

export type AloopAttemptOutcome = {
	status: "completed" | "worker-failed" | "timeout" | "cancelled" | "contract-violation" | "missing-submission" | "invalid-result";
	summary: string;
	commit: string | null;
	workerResult: AloopWorkerResult | null;
	contract: AttemptContractAssessment;
	process: { exitCode: number | null; signal: NodeJS.Signals | null; timedOut: boolean; cancelled: boolean; durationMs: number };
	submission?: "valid" | "missing" | "invalid";
	preservation?: PreservationEvidence;
	modelUsage?: NestedModelUsage[];
	artifacts: { directory: string; prompt: string; stdout: string; stderr: string; result: string; submission?: string; context?: string; diff?: string; stagedDiff?: string; untracked?: string };
};

type ProcessResult = {
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	timedOut: boolean;
	cancelled: boolean;
	durationMs: number;
	stdoutTail: string;
};

function truncateBytes(value: string, limit: number): string {
	const bytes = Buffer.from(value, "utf8");
	if (bytes.length <= limit) return value;
	return `${bytes.subarray(bytes.length - limit).toString("utf8")}\n[earlier output truncated]`;
}

function appendTail(current: string, chunk: Buffer): string {
	return truncateBytes(current + chunk.toString("utf8"), MAX_CAPTURE_BYTES);
}

function boundedText(value: string, limit: number): string {
	return value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 1))}…`;
}

function positiveIssueNumber(value: number, field: string): number {
	if (!Number.isInteger(value) || value < 1) throw new Error(`${field} must be a positive integer.`);
	return value;
}

export function resolveAloopArtifactPath(cwd: string, ...segments: string[]): string {
	const root = path.resolve(cwd, ALOOP_ROOT);
	if (segments.length === 0 || segments.some((segment) => !segment || path.isAbsolute(segment))) {
		throw new Error("Aloop artifact paths require non-empty relative segments.");
	}
	const resolved = path.resolve(root, ...segments);
	if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error("Aloop artifact path escapes .pi/tmp/aloop/.");
	return resolved;
}

export async function prepareAloopArtifactDirectory(cwd: string, attemptId: string): Promise<string> {
	const root = path.resolve(cwd, ALOOP_ROOT);
	const directory = resolveAloopArtifactPath(cwd, attemptId);
	for (const candidate of [path.resolve(cwd, ".pi"), path.resolve(cwd, ".pi/tmp"), root, directory]) {
		try {
			await mkdir(candidate, { mode: candidate === directory ? 0o700 : 0o755 });
			await syncAttemptDirectory(path.dirname(candidate));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		const status = await lstat(candidate);
		if (status.isSymbolicLink() || !status.isDirectory()) {
			throw new Error(`Aloop artifact directory contains a symbolic link or non-directory component: ${path.relative(cwd, candidate)}`);
		}
	}
	return directory;
}

export function buildAloopWorkerPrompt(input: Omit<AloopWorkerInput, "cwd" | "launcher" | "modelRef" | "timeoutMs" | "deadlineMs" | "spawnDeadlineMs" | "signal" | "env">): string {
	positiveIssueNumber(input.epic.number, "epic.number");
	positiveIssueNumber(input.issue.number, "issue.number");
	if (input.workerKind === "patch") {
		if (!input.patchDirection?.trim()) throw new Error("Targeted patch workers require a narrow correction.");
		return `You are a fresh targeted patch worker for child issue #${input.issue.number}. Make only this correction:\n\n${boundedText(input.patchDirection, 4_000)}\n\nStay inside the issue boundary. Use source, LSP, and focused diagnostic tools as useful. Do not review, browse, access GitHub or Matrix, run canonical verification, or orchestrate other agents. Create one or more coherent local commits, then call aloop_submit_patch_result as your final action. Do not rely on final-message JSON.`;
	}
	return `You are a fresh issue-owning Pi worker for epic #${input.epic.number}, child issue #${input.issue.number}, attempt type ${input.attemptType}.

Call aloop_issue_context first and derive the issue body, relationships, decisions, base commit, and prior findings from that immutable startup snapshot. The selected child is the strict implementation boundary.

Read repository guidance. Implement the issue, use LSP and focused checks, request independent review, remediate findings you accept, and create one or more coherent local commits. Never push, fetch, mutate GitHub, contact the operator, run canonical acceptance, or broaden scope. Project worker feedback is advisory. If material ambiguity or an environment blocker prevents safe completion, stop instead of guessing.

Finish every outcome by calling aloop_submit_result as your final action. Use candidate-complete for committed clean work, already-satisfied when no change is needed, incomplete for unfinished work, decision-required for material ambiguity, or environment-blocked for an external blocker. Do not rely on final-message JSON.`;
}

export function buildAloopWorkerCommand(options: {
	launcher: string[];
	prompt: string;
	modelRef?: string;
	profile?: AgentProfile;
	resourceRoots?: { harness?: string; mattSkills?: string; lspExtension?: string };
	projectExtensions?: string[];
}): string[] {
	if (options.launcher.length === 0 || options.launcher.some((part) => !part)) throw new Error("Aloop worker launcher must be a non-empty argv array.");
	const profile = options.profile ?? resolveAgentProfile("aloop-implementation");
	const roots = options.resourceRoots ?? {};
	const extensionPaths = profile.extensions.flatMap((name) => {
		if (name === "lsp") return roots.lspExtension ? [roots.lspExtension] : [];
		if (name === "pi-r" || name === "agentgraph") return [];
		return roots.harness ? [path.join(roots.harness, "extensions", name, "index.ts")] : [];
	});
	const skillPaths = profile.skills.flatMap((name) => {
		if (name === "harness") return roots.harness ? [path.join(roots.harness, "skills")] : [];
		if (name === "matt-pocock") return roots.mattSkills ? [roots.mattSkills] : [];
		return [];
	});
	const promptPaths = profile.prompts.flatMap((name) => name === "harness" && roots.harness ? [path.join(roots.harness, "prompts")] : []);
	return [
		...options.launcher,
		"--mode", "json",
		"--no-session",
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--no-themes",
		...extensionPaths.flatMap((extension) => ["--extension", extension]),
		...(options.projectExtensions ?? []).flatMap((extension) => ["--extension", extension]),
		...skillPaths.flatMap((skill) => ["--skill", skill]),
		...promptPaths.flatMap((prompt) => ["--prompt-template", prompt]),
		"--approve",
		"--tools", profile.tools.join(","),
		...(options.modelRef ? ["--model", options.modelRef] : []),
		"--thinking", "medium",
		options.prompt,
	];
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function parseAloopWorkerResult(document: string): AloopWorkerResult {
	let parsed: any;
	try { parsed = JSON.parse(document); } catch { throw new Error("Aloop submission was not valid JSON."); }
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Aloop submission must be a JSON object.");
	if (!["candidate-complete", "already-satisfied", "incomplete", "decision-required", "environment-blocked"].includes(parsed.status)) {
		throw new Error("Aloop submission has an invalid status.");
	}
	if (typeof parsed.summary !== "string" || !parsed.summary.trim() || typeof parsed.nextAction !== "string" || !parsed.nextAction.trim()) {
		throw new Error("Aloop submission requires non-empty summary and nextAction strings.");
	}
	if (!isStringArray(parsed.verification) || !isStringArray(parsed.discoveredWork)) throw new Error("Aloop submission verification and discoveredWork must be string arrays.");
	if (!Array.isArray(parsed.acceptanceCriteria) || !parsed.acceptanceCriteria.every((criterion: any) =>
		criterion && typeof criterion.criterion === "string" && typeof criterion.satisfied === "boolean" && typeof criterion.evidence === "string")) {
		throw new Error("Aloop submission acceptanceCriteria is invalid.");
	}
	return {
		status: parsed.status,
		summary: boundedText(parsed.summary, 2_000),
		verification: parsed.verification.slice(0, 20).map((item: string) => boundedText(item, 1_000)),
		acceptanceCriteria: parsed.acceptanceCriteria.slice(0, 20).map((criterion: any) => ({
			criterion: boundedText(criterion.criterion, 1_000), satisfied: criterion.satisfied,
			evidence: boundedText(criterion.evidence, 2_000),
		})),
		discoveredWork: parsed.discoveredWork.slice(0, 20).map((item: string) => boundedText(item, 1_000)),
		nextAction: boundedText(parsed.nextAction, 1_000),
	};
}

export function parseAloopPatchResult(document: string): AloopWorkerResult {
	let parsed: any;
	try { parsed = JSON.parse(document); } catch { throw new Error("Aloop patch submission was not valid JSON."); }
	if (!parsed || !["patched", "no-change", "incomplete", "environment-blocked"].includes(parsed.status)) {
		throw new Error("Aloop patch submission has an invalid status.");
	}
	if (typeof parsed.summary !== "string" || !parsed.summary.trim() || typeof parsed.nextAction !== "string" || !parsed.nextAction.trim() || !isStringArray(parsed.verification)) {
		throw new Error("Aloop patch submission is incomplete.");
	}
	return {
		status: parsed.status === "patched" ? "candidate-complete" : parsed.status === "no-change" ? "already-satisfied" : parsed.status,
		summary: boundedText(parsed.summary, 2_000), verification: parsed.verification.slice(0, 20),
		acceptanceCriteria: [], discoveredWork: [], nextAction: boundedText(parsed.nextAction, 1_000),
	};
}

export function assessAttemptContract(input: {
	beforeHead: string;
	afterHead: string | null;
	commitCount: number | null;
	beforeIsAncestor: boolean | null;
	worktreeStatus: string | null;
	workerStatus?: AloopWorkerResultStatus;
}): AttemptContractAssessment {
	const violations: string[] = [];
	if (input.afterHead === null || input.commitCount === null || input.beforeIsAncestor === null || input.worktreeStatus === null) {
		return { valid: false, commit: null, violations: ["Git settlement state is unknown; inspect retained workspace before acceptance."] };
	}
	if (!input.beforeIsAncestor) violations.push("The attempt rewrote or removed the starting commit.");
	if ((input.workerStatus === "candidate-complete" || input.workerStatus === "already-satisfied") && input.worktreeStatus.trim()) {
		violations.push("Successful candidate outcomes require a clean worktree.");
	}
	if (input.workerStatus === "candidate-complete" && (input.commitCount === 0 || input.afterHead === input.beforeHead)) {
		violations.push("candidate-complete requires at least one new commit.");
	}
	return { valid: violations.length === 0, commit: input.beforeIsAncestor && input.afterHead !== input.beforeHead ? input.afterHead : null, violations };
}

async function terminateProcessGroup(pid: number, graceMs: number): Promise<void> {
	const signal = (value: NodeJS.Signals): void => {
		try { process.kill(-pid, value); } catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
		}
	};
	const alive = (): boolean => {
		try { process.kill(-pid, 0); return true; } catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
			throw error;
		}
	};
	signal("SIGTERM");
	const deadline = Date.now() + graceMs;
	while (alive() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
	if (alive()) signal("SIGKILL");
}

export async function runIsolatedAloopProcess(options: {
	cwd: string;
	command: string[];
	stdoutPath: string;
	stderrPath: string;
	timeoutMs: number;
	deadlineMs?: number;
	spawnDeadlineMs?: number;
	shutdownGraceMs?: number;
	signal?: AbortSignal;
	env?: NodeJS.ProcessEnv;
}): Promise<ProcessResult> {
	if (process.platform !== "linux" && process.platform !== "darwin") throw new Error("Aloop workers require process-group cleanup on Linux or macOS.");
	if (options.command.length === 0) throw new Error("Aloop worker command is empty.");
	if (options.signal?.aborted) throw new Error("Aloop worker launch was cancelled before spawn.");
	if (options.deadlineMs !== undefined && options.deadlineMs <= Date.now()) throw new Error("Aloop worker deadline expired before spawn.");
	if (options.spawnDeadlineMs !== undefined && options.spawnDeadlineMs <= Date.now()) throw new Error("Aloop worker spawn deadline expired before setup.");
	await mkdir(path.dirname(options.stdoutPath), { recursive: true });
	const stdout = createWriteStream(options.stdoutPath, { flags: "wx", mode: 0o600 });
	const stderr = createWriteStream(options.stderrPath, { flags: "wx", mode: 0o600 });
	await Promise.all([once(stdout, "open"), once(stderr, "open")]);
	const remainingMs = options.deadlineMs === undefined ? options.timeoutMs : Math.min(options.timeoutMs, options.deadlineMs - Date.now());
	if (options.signal?.aborted || remainingMs <= 0 || (options.spawnDeadlineMs !== undefined && Date.now() >= options.spawnDeadlineMs)) {
		await Promise.all([new Promise<void>((done) => stdout.end(done)), new Promise<void>((done) => stderr.end(done))]);
		throw new Error(options.signal?.aborted
			? "Aloop worker launch was cancelled before spawn."
			: options.spawnDeadlineMs !== undefined && Date.now() >= options.spawnDeadlineMs
				? "Aloop worker spawn deadline expired immediately before spawn."
				: "Aloop worker deadline expired before spawn.");
	}
	const started = Date.now();
	let stdoutTail = "";
	let timedOut = false;
	let cancelled = false;
	let termination: Promise<void> | null = null;
	let settled = false;

	return await new Promise((resolve, reject) => {
		const child = spawn(options.command[0]!, options.command.slice(1), {
			cwd: options.cwd,
			env: { ...process.env, ...options.env },
			stdio: ["ignore", "pipe", "pipe"],
			detached: true,
		});
		const stop = (reason: "timeout" | "cancelled") => {
			if (!child.pid || termination) return;
			timedOut = reason === "timeout";
			cancelled = reason === "cancelled";
			termination = terminateProcessGroup(child.pid, options.shutdownGraceMs ?? SHUTDOWN_GRACE_MS);
		};
		const timer = setTimeout(() => stop("timeout"), remainingMs);
		const abort = () => stop("cancelled");
		options.signal?.addEventListener("abort", abort, { once: true });
		if (options.signal?.aborted) abort();
		child.stdout.on("data", (chunk: Buffer) => { stdout.write(chunk); stdoutTail = appendTail(stdoutTail, chunk); });
		child.stderr.on("data", (chunk: Buffer) => stderr.write(chunk));
		child.once("error", async (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", abort);
			await Promise.all([
				new Promise<void>((done) => stdout.end(done)),
				new Promise<void>((done) => stderr.end(done)),
			]);
			reject(error);
		});
		child.once("close", async (exitCode, signal) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", abort);
			try {
				if (termination) await termination;
				await Promise.all([
					new Promise<void>((done) => stdout.end(done)),
					new Promise<void>((done) => stderr.end(done)),
				]);
				resolve({ exitCode, signal, timedOut, cancelled, durationMs: Date.now() - started, stdoutTail });
			} catch (error) { reject(error); }
		});
	});
}

type GitCommandOptions = { signal?: AbortSignal; deadlineMs?: number; timeoutMs?: number };

async function gitResult(cwd: string, args: string[], options: GitCommandOptions = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
	if (process.platform !== "linux" && process.platform !== "darwin") throw new Error("Aloop Git checks require process-group cleanup on Linux or macOS.");
	if (options.signal?.aborted) throw new Error(`Git command aborted before spawn: git ${args.join(" ")}`);
	const timeoutMs = Math.min(options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS, options.deadlineMs === undefined ? Number.MAX_SAFE_INTEGER : options.deadlineMs - Date.now());
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error(`Git command deadline expired before spawn: git ${args.join(" ")}`);
	return await new Promise((resolve, reject) => {
		const child = spawn("git", args, { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		let settled = false;
		const cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); };
		const finish = (error?: Error, code: number | null = null) => {
			if (settled) return;
			settled = true;
			cleanup();
			if (error) reject(error);
			else resolve({ code, stdout, stderr: stderr.trim() });
		};
		const terminate = (reason: string) => {
			if (settled) return;
			try { if (child.pid) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch { /* process group may have exited */ }
			finish(new Error(`${reason}: git ${args.join(" ")}`));
		};
		const abort = () => terminate("Git command aborted");
		const timer = setTimeout(() => terminate(`Git command timed out after ${Math.trunc(timeoutMs)}ms`), timeoutMs);
		timer.unref?.();
		options.signal?.addEventListener("abort", abort, { once: true });
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
			if (Buffer.byteLength(stdout) > MAX_CAPTURE_BYTES) terminate("Git output exceeded capture limit");
		});
		child.stderr.on("data", (chunk: Buffer) => { stderr = appendTail(stderr, chunk); });
		child.once("error", (error) => finish(error));
		child.once("close", (code) => finish(undefined, code));
		if (options.signal?.aborted) abort();
	});
}

async function git(cwd: string, args: string[], options: GitCommandOptions = {}): Promise<string> {
	const result = await gitResult(cwd, args, options);
	if (result.code !== 0) throw new Error((result.stderr || result.stdout || `git ${args.join(" ")} failed`).trim());
	return result.stdout.trim();
}

async function worktreeStatus(cwd: string, options: GitCommandOptions = {}): Promise<string> {
	return await git(cwd, ["status", "--porcelain=v1", "--untracked-files=all"], options);
}

export async function resolveProjectWorkerResources(
	cwd: string,
	resources: AloopWorkerInput["projectWorkerResources"],
): Promise<{ extensions: string[]; tools: string[] }> {
	if (!resources) return { extensions: [], tools: [] };
	const tools = [...new Set(resources.tools)];
	if (tools.some((tool) => !/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(tool))) throw new Error(".aloop.json contains an invalid project worker tool name.");
	const repository = await realpath(cwd);
	const extensions: string[] = [];
	for (const configured of [...new Set(resources.extensions)]) {
		if (path.isAbsolute(configured) || !configured.trim()) throw new Error("Project worker extension paths must be non-empty and repository-relative.");
		const lexical = path.resolve(cwd, configured);
		if (!lexical.startsWith(`${path.resolve(cwd)}${path.sep}`)) throw new Error("Project worker extension path escapes the repository.");
		const resolved = await realpath(lexical);
		if (!resolved.startsWith(`${repository}${path.sep}`)) throw new Error("Project worker extension resolves outside the repository.");
		const status = await lstat(resolved);
		if (!status.isFile()) throw new Error(`Project worker extension is not a file: ${configured}`);
		extensions.push(resolved);
	}
	return { extensions, tools };
}

function defaultLauncher(): string[] {
	const script = process.argv[1];
	if (!script) throw new Error("Cannot locate the running Pi CLI script; provide an explicit aloop launcher.");
	return [process.execPath, script];
}

export async function runAloopWorker(input: AloopWorkerInput): Promise<AloopAttemptOutcome> {
	const gitOptions = { signal: input.signal, deadlineMs: input.deadlineMs };
	const initialStatus = await worktreeStatus(input.cwd, gitOptions);
	if (initialStatus) throw new Error("Aloop worker refused to start because the worktree is dirty.");
	const beforeHead = await git(input.cwd, ["rev-parse", "HEAD"], gitOptions);
	const profileName = input.workerKind === "patch" ? "aloop-patch" : "aloop-implementation";
	const projectResources = input.workerKind === "patch"
		? { extensions: [] as string[], tools: [] as string[] }
		: await resolveProjectWorkerResources(input.cwd, input.projectWorkerResources);
	const baseProfile = resolveAgentProfile(profileName);
	const profile = input.workerKind === "patch" ? baseProfile : withProjectWorkerOptIn(baseProfile, { tools: projectResources.tools });
	const prompt = buildAloopWorkerPrompt(input);
	const attemptId = `issue-${input.issue.number}-${Date.now()}-${randomUUID().slice(0, 8)}`;
	const directory = await prepareAloopArtifactDirectory(input.cwd, attemptId);
	const promptPath = resolveAloopArtifactPath(input.cwd, attemptId, "prompt.md");
	const stdoutPath = resolveAloopArtifactPath(input.cwd, attemptId, "stdout.jsonl");
	const stderrPath = resolveAloopArtifactPath(input.cwd, attemptId, "stderr.log");
	const resultPath = resolveAloopArtifactPath(input.cwd, attemptId, "result.json");
	const submissionPath = resolveAloopArtifactPath(input.cwd, attemptId, "submission.json");
	const contextPath = resolveAloopArtifactPath(input.cwd, attemptId, "issue-context.json");
	const diffPath = resolveAloopArtifactPath(input.cwd, attemptId, "worktree.patch");
	const stagedDiffPath = resolveAloopArtifactPath(input.cwd, attemptId, "staged.patch");
	const untrackedPath = resolveAloopArtifactPath(input.cwd, attemptId, "untracked-files.json");
	const usagePath = resolveAloopArtifactPath(input.cwd, attemptId, "nested-usage.jsonl");
	await writeFile(contextPath, `${JSON.stringify({
		version: 1, epic: input.epic, selectedIssue: input.issue, attemptType: input.attemptType,
		issueBaseCommit: input.issueBaseCommit ?? beforeHead, attemptStartCommit: beforeHead, priorHandoffs: input.priorHandoffs ?? [], snapshot: input.issueContext ?? null,
	}, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
	const noFollow = constants.O_NOFOLLOW ?? 0;
	const promptFile = await open(promptPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
	try {
		await promptFile.writeFile(`${prompt}\n`, "utf8");
	} finally {
		await promptFile.close();
	}
	const resultFile = await open(resultPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
	let publication: Awaited<ReturnType<typeof prepareResultPublication>> | undefined;
	try {
		await writeAttemptIdentity(directory, {
			version: 1, issue: input.issue.number, epic: input.epic.number,
			artifactDirectory: path.relative(input.cwd, directory), beforeHead,
			issueBaseCommit: input.issueBaseCommit ?? beforeHead, workerKind: input.workerKind ?? "implementation",
			...(input.parentArtifactDirectory ? { parentArtifactDirectory: input.parentArtifactDirectory } : {}),
		});
		publication = await prepareResultPublication(directory);
		const fallbackPath = process.env.PI_HARNESS_LSP_FALLBACK_PATH?.trim();
		const inheritedPath = input.env?.PATH ?? process.env.PATH;
		const workerEnvironment: NodeJS.ProcessEnv = {
			...input.env,
			...(fallbackPath ? { PATH: `${inheritedPath ?? ""}:${fallbackPath}` } : {}),
			PI_HARNESS_AGENT_PROFILE: profileName,
			PI_HARNESS_PROJECT_WORKER_TOOLS: JSON.stringify(projectResources.tools),
			PI_ALOOP_ISSUE_CONTEXT_PATH: contextPath,
			PI_ALOOP_SUBMISSION_PATH: submissionPath,
			PI_ALOOP_ATTEMPT_DIRECTORY: directory,
			PI_ALOOP_WORKER_FEEDBACK_COMMAND: input.workerFeedbackCommand ? JSON.stringify(input.workerFeedbackCommand) : "",
			PI_ALOOP_USAGE_LEDGER: usagePath,
		};
		const effectiveEnvironment: NodeJS.ProcessEnv = { ...process.env, ...workerEnvironment };
		const command = buildAloopWorkerCommand({
		launcher: input.launcher ?? defaultLauncher(), prompt, modelRef: input.modelRef, profile,
		resourceRoots: {
			harness: effectiveEnvironment.PI_HARNESS_RESOURCES_ROOT,
			mattSkills: effectiveEnvironment.PI_HARNESS_MATT_SKILLS_ROOT,
			lspExtension: effectiveEnvironment.PI_HARNESS_LSP_EXTENSION,
		},
		projectExtensions: projectResources.extensions,
	});
	const remainingBeforeSpawn = input.deadlineMs === undefined ? MAX_TIMEOUT_MS : input.deadlineMs - Date.now() - POSTFLIGHT_RESERVE_MS;
	if (remainingBeforeSpawn <= 0) throw new Error("Aloop worker deadline expired during preflight; worker was not spawned.");
	const timeoutMs = Math.max(1, Math.min(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, remainingBeforeSpawn));
	const processStarted = Date.now();
	let launchError: string | null = null;
	let processResult: ProcessResult;
	try {
		if (input.spawnDeadlineMs !== undefined && Date.now() >= input.spawnDeadlineMs) throw new Error("Aloop patch preflight crossed its spawn deadline; no worker process was started.");
		processResult = await runIsolatedAloopProcess({
			cwd: input.cwd,
			command,
			stdoutPath,
			stderrPath,
			timeoutMs,
			deadlineMs: input.deadlineMs === undefined ? undefined : input.deadlineMs - POSTFLIGHT_RESERVE_MS,
			spawnDeadlineMs: input.spawnDeadlineMs,
			signal: input.signal,
			env: workerEnvironment,
		});
	} catch (error) {
		launchError = error instanceof Error ? error.message : String(error);
		processResult = {
			exitCode: null,
			signal: null,
			timedOut: false,
			cancelled: false,
			durationMs: Date.now() - processStarted,
			stdoutTail: "",
		};
	}
	for (const logPath of [stdoutPath, stderrPath]) {
		try { await writeFile(logPath, "", { encoding: "utf8", mode: 0o600, flag: "wx" }); } catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
	}
	const settlementGitOptions: GitCommandOptions = { deadlineMs: Date.now() + 30_000 };
	const preserved = await preserveAttempt({ cwd: input.cwd, directory, base: beforeHead,
		git: (args) => gitResult(input.cwd, args, settlementGitOptions),
	});
	const afterHead = preserved.evidence.head;
	const worktreeStatusAfter = preserved.status;
	const beforeIsAncestor = preserved.ancestor;
	const commitCount = preserved.evidence.commits;
	let workerResult: AloopWorkerResult | null = null;
	let parseError: string | null = null;
	try {
		const submission = await readFile(submissionPath, "utf8");
		workerResult = input.workerKind === "patch" ? parseAloopPatchResult(submission) : parseAloopWorkerResult(submission);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") parseError = error instanceof Error ? error.message : String(error);
	}
	const contract = assessAttemptContract({
		beforeHead, afterHead, commitCount, beforeIsAncestor, worktreeStatus: worktreeStatusAfter,
		workerStatus: workerResult?.status,
	});
	if (preserved.evidence.capture !== "complete") {
		contract.valid = false;
		contract.violations.push("Preservation incomplete; inspect retained workspace before acceptance.");
	}
	const submissionMissing = workerResult === null && parseError === null;
	const status = processResult.timedOut ? "timeout"
		: processResult.cancelled ? "cancelled"
			: launchError ? "worker-failed"
				: !contract.valid ? "contract-violation"
					: processResult.exitCode !== 0 ? "worker-failed"
						: submissionMissing ? "missing-submission"
							: parseError ? "invalid-result"
								: "completed";
	const fallback = contract.violations.join(" ") || (submissionMissing ? "Worker exited without aloop_submit_result." : `Worker exited with code ${processResult.exitCode ?? "unknown"}.`);
	const summary = `${preservationSummary(preserved.evidence)}\nWorker report: ${boundedText(workerResult?.summary ?? launchError ?? parseError ?? fallback, MAX_SUMMARY_BYTES)}`;
	let stdoutDocument = "";
	try { stdoutDocument = await readFile(stdoutPath, "utf8"); } catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const primaryMessages = stdoutDocument.split("\n").flatMap((line) => {
		try { const record = JSON.parse(line); return record?.type === "message_end" ? [record.message] : []; } catch { return []; }
	});
	const modelUsage = [...collectSessionUsage(primaryMessages, input.workerKind === "patch" ? "patch" : "implementation"), ...await readNestedModelUsage(usagePath)];
	const relative = (value: string) => path.relative(input.cwd, value);
	const outcome: AloopAttemptOutcome = {
		status,
		summary,
		commit: contract.commit,
		workerResult,
		contract,
		submission: parseError ? "invalid" : submissionMissing ? "missing" : "valid",
		preservation: preserved.evidence,
		process: {
			exitCode: processResult.exitCode,
			signal: processResult.signal,
			timedOut: processResult.timedOut,
			cancelled: processResult.cancelled,
			durationMs: processResult.durationMs,
		},
		modelUsage,
		artifacts: {
			directory: relative(directory),
			prompt: relative(promptPath),
			stdout: relative(stdoutPath),
			stderr: relative(stderrPath),
			result: relative(resultPath),
			submission: relative(submissionPath),
			context: relative(contextPath),
			diff: relative(diffPath),
			stagedDiff: relative(stagedDiffPath),
			untracked: relative(untrackedPath),
		},
	};
	await publication.publish({ ...outcome, command: command.slice(0, -1), beforeHead, afterHead, commitCount, worktreeStatus: worktreeStatusAfter, launchError, parseError });
	return outcome;
	} finally {
		try { await publication?.close(); } finally { await resultFile.close(); }
	}
}

export const DEFAULT_ALOOP_PATCH_MODEL = "openai-codex/gpt-5.6-terra";

export function selectAloopPatchModel(input: {
	configured?: string;
	active?: string;
	available: (reference: string) => boolean;
}): string | undefined {
	const preferred = input.configured?.trim() || DEFAULT_ALOOP_PATCH_MODEL;
	if (input.available(preferred)) return preferred;
	return input.active?.trim() || undefined;
}

export type AloopPatchWorkerInput = Omit<AloopWorkerInput, "attemptType" | "supervisorApproach" | "workerKind" | "patchDirection"> & {
	correction: string;
};

/** Targeted settlement work. Callers deliberately do not charge this against full-worker launch/time counters. */
export function runAloopPatchWorker(input: AloopPatchWorkerInput): Promise<AloopAttemptOutcome> {
	return runAloopWorker({
		...input,
		attemptType: "remediation",
		supervisorApproach: "Targeted supervisor patch",
		workerKind: "patch",
		patchDirection: input.correction,
	});
}
