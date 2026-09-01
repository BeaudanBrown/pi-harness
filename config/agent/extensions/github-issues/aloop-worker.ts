import { spawn } from "node:child_process";
import { constants, createWriteStream } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import * as path from "node:path";
import type { IssueHandoff } from "./github-context.js";

const ALOOP_ROOT = ".pi/tmp/aloop";
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_TIMEOUT_MS = 4 * 60 * 60 * 1000;
const SHUTDOWN_GRACE_MS = 1_000;
const MAX_CAPTURE_BYTES = 10 * 1024 * 1024;
const MAX_SUMMARY_BYTES = 2_000;
const DEFAULT_GIT_TIMEOUT_MS = 30_000;
const POSTFLIGHT_RESERVE_MS = 5_000;

export type AloopAttemptType = "implementation" | "remediation";

export type AloopWorkerInput = {
	cwd: string;
	attemptType: AloopAttemptType;
	epic: { number: number; title: string; body: string };
	issue: { number: number; title: string; body: string };
	priorHandoffs?: IssueHandoff[];
	launcher?: string[];
	modelRef?: string;
	timeoutMs?: number;
	deadlineMs?: number;
	signal?: AbortSignal;
	env?: NodeJS.ProcessEnv;
};

export type AloopWorkerResult = {
	status: "implemented" | "needs-remediation" | "blocked";
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
	status: "completed" | "worker-failed" | "timeout" | "cancelled" | "contract-violation" | "invalid-result";
	summary: string;
	commit: string | null;
	workerResult: AloopWorkerResult | null;
	contract: AttemptContractAssessment;
	process: { exitCode: number | null; signal: NodeJS.Signals | null; timedOut: boolean; cancelled: boolean; durationMs: number };
	artifacts: { directory: string; prompt: string; stdout: string; stderr: string; result: string };
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

export function buildAloopWorkerPrompt(input: Omit<AloopWorkerInput, "cwd" | "launcher" | "modelRef" | "timeoutMs" | "deadlineMs" | "signal" | "env">): string {
	positiveIssueNumber(input.epic.number, "epic.number");
	positiveIssueNumber(input.issue.number, "issue.number");
	const handoffs = (input.priorHandoffs ?? []).slice(-5).map((handoff) =>
		`- ${handoff.createdAt || "unknown time"} by ${handoff.author ?? "unknown"}: ${boundedText(handoff.body, 2_000)}`,
	);
	return `You are a fresh implementation worker for one GitHub issue. Work only in the current repository and complete one ${input.attemptType} attempt.

Safety and ownership rules:
- Do not use GitHub APIs, GitHub issue tools, or gh to mutate issues, comments, labels, relationships, or assignments. The supervisor owns GitHub.
- Do not push or fetch. Make changes only in this clean local worktree.
- Read and follow the repository guidance, including AGENTS.md and relevant docs.
- Finish with a clean worktree and exactly one new local commit. Do not amend or rewrite commits that existed before this attempt.
- Run focused checks and the project-required verification appropriate to this issue.
- Stay within the selected issue. Report newly discovered work instead of expanding scope.

Epic #${input.epic.number}: ${input.epic.title}
${boundedText(input.epic.body, 4_000)}

Selected issue #${input.issue.number}: ${input.issue.title}
${boundedText(input.issue.body, 12_000)}

Recent supervisor handoffs:
${handoffs.length > 0 ? handoffs.join("\n") : "- None"}

Your final assistant message must contain only one JSON object with this exact shape:
{
  "status": "implemented" | "needs-remediation" | "blocked",
  "summary": "concise implementation summary",
  "verification": ["checks and outcomes"],
  "acceptanceCriteria": [{"criterion": "criterion text", "satisfied": true, "evidence": "specific evidence"}],
  "discoveredWork": ["newly discovered work, if any"],
  "nextAction": "what the supervisor should do next"
}
Do not wrap the JSON in Markdown fences.`;
}

export function buildAloopWorkerCommand(options: {
	launcher: string[];
	prompt: string;
	modelRef?: string;
}): string[] {
	if (options.launcher.length === 0 || options.launcher.some((part) => !part)) throw new Error("Aloop worker launcher must be a non-empty argv array.");
	return [
		...options.launcher,
		"--mode", "json",
		"--no-session",
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--no-themes",
		"--approve",
		"--tools", "read,bash,edit,write,grep,find,ls",
		...(options.modelRef ? ["--model", options.modelRef] : []),
		"--thinking", "low",
		options.prompt,
	];
}

function textFromAssistantMessage(message: any): string | null {
	if (message?.role !== "assistant" || !Array.isArray(message.content)) return null;
	const text = message.content
		.filter((part: any) => part?.type === "text" && typeof part.text === "string")
		.map((part: any) => part.text)
		.join("\n")
		.trim();
	return text || null;
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function parseAloopWorkerResult(jsonl: string): AloopWorkerResult {
	let finalText: string | null = null;
	for (const line of jsonl.split("\n")) {
		if (!line.trim()) continue;
		let record: any;
		try {
			record = JSON.parse(line);
		} catch {
			continue;
		}
		if (record?.type === "message_end") finalText = textFromAssistantMessage(record.message) ?? finalText;
	}
	if (!finalText) throw new Error("Pi JSON stream did not contain a final assistant text message.");
	let parsed: any;
	try {
		parsed = JSON.parse(finalText);
	} catch {
		throw new Error("Final assistant message was not a JSON object.");
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Worker result must be a JSON object.");
	if (!["implemented", "needs-remediation", "blocked"].includes(parsed.status)) throw new Error("Worker result has an invalid status.");
	if (typeof parsed.summary !== "string" || typeof parsed.nextAction !== "string") throw new Error("Worker result requires summary and nextAction strings.");
	if (!isStringArray(parsed.verification) || !isStringArray(parsed.discoveredWork)) throw new Error("Worker result verification and discoveredWork must be string arrays.");
	if (!Array.isArray(parsed.acceptanceCriteria) || !parsed.acceptanceCriteria.every((criterion: any) =>
		criterion && typeof criterion.criterion === "string" && typeof criterion.satisfied === "boolean" && typeof criterion.evidence === "string")) {
		throw new Error("Worker result acceptanceCriteria is invalid.");
	}
	return {
		status: parsed.status,
		summary: boundedText(parsed.summary, 2_000),
		verification: parsed.verification.slice(0, 20).map((item: string) => boundedText(item, 1_000)),
		acceptanceCriteria: parsed.acceptanceCriteria.slice(0, 20).map((criterion: any) => ({
			criterion: boundedText(criterion.criterion, 1_000),
			satisfied: criterion.satisfied,
			evidence: boundedText(criterion.evidence, 2_000),
		})),
		discoveredWork: parsed.discoveredWork.slice(0, 20).map((item: string) => boundedText(item, 1_000)),
		nextAction: boundedText(parsed.nextAction, 1_000),
	};
}

export function assessAttemptContract(input: {
	beforeHead: string;
	afterHead: string;
	commitCount: number;
	beforeIsAncestor: boolean;
	worktreeStatus: string;
}): AttemptContractAssessment {
	const violations: string[] = [];
	if (input.worktreeStatus.trim()) violations.push("Worktree is not clean after the attempt.");
	if (!input.beforeIsAncestor) violations.push("The attempt rewrote or removed the starting commit.");
	if (input.commitCount === 0 || input.afterHead === input.beforeHead) violations.push("The attempt did not create a commit.");
	else if (input.commitCount !== 1) violations.push(`The attempt created ${input.commitCount} commits instead of exactly one.`);
	return { valid: violations.length === 0, commit: violations.length === 0 ? input.afterHead : null, violations };
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
	shutdownGraceMs?: number;
	signal?: AbortSignal;
	env?: NodeJS.ProcessEnv;
}): Promise<ProcessResult> {
	if (process.platform !== "linux" && process.platform !== "darwin") throw new Error("Aloop workers require process-group cleanup on Linux or macOS.");
	if (options.command.length === 0) throw new Error("Aloop worker command is empty.");
	if (options.signal?.aborted) throw new Error("Aloop worker launch was cancelled before spawn.");
	if (options.deadlineMs !== undefined && options.deadlineMs <= Date.now()) throw new Error("Aloop worker deadline expired before spawn.");
	await mkdir(path.dirname(options.stdoutPath), { recursive: true });
	const stdout = createWriteStream(options.stdoutPath, { flags: "wx", mode: 0o600 });
	const stderr = createWriteStream(options.stderrPath, { flags: "wx", mode: 0o600 });
	await Promise.all([once(stdout, "open"), once(stderr, "open")]);
	const remainingMs = options.deadlineMs === undefined ? options.timeoutMs : Math.min(options.timeoutMs, options.deadlineMs - Date.now());
	if (options.signal?.aborted || remainingMs <= 0) {
		await Promise.all([new Promise<void>((done) => stdout.end(done)), new Promise<void>((done) => stderr.end(done))]);
		throw new Error(options.signal?.aborted ? "Aloop worker launch was cancelled before spawn." : "Aloop worker deadline expired before spawn.");
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
			else resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
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
		child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
		child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
		child.once("error", (error) => finish(error));
		child.once("close", (code) => finish(undefined, code));
		if (options.signal?.aborted) abort();
	});
}

async function git(cwd: string, args: string[], options: GitCommandOptions = {}): Promise<string> {
	const result = await gitResult(cwd, args, options);
	if (result.code !== 0) throw new Error((result.stderr || result.stdout || `git ${args.join(" ")} failed`).trim());
	return result.stdout;
}

async function worktreeStatus(cwd: string, options: GitCommandOptions = {}): Promise<string> {
	return await git(cwd, ["status", "--porcelain=v1", "--untracked-files=all"], options);
}

async function isAncestor(cwd: string, ancestor: string, descendant: string, options: GitCommandOptions = {}): Promise<boolean> {
	const result = await gitResult(cwd, ["merge-base", "--is-ancestor", ancestor, descendant], options);
	if (result.code === 0) return true;
	if (result.code === 1) return false;
	throw new Error(result.stderr || "git merge-base --is-ancestor failed.");
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
	const prompt = buildAloopWorkerPrompt(input);
	const attemptId = `issue-${input.issue.number}-${Date.now()}-${randomUUID().slice(0, 8)}`;
	const directory = await prepareAloopArtifactDirectory(input.cwd, attemptId);
	const promptPath = resolveAloopArtifactPath(input.cwd, attemptId, "prompt.md");
	const stdoutPath = resolveAloopArtifactPath(input.cwd, attemptId, "stdout.jsonl");
	const stderrPath = resolveAloopArtifactPath(input.cwd, attemptId, "stderr.log");
	const resultPath = resolveAloopArtifactPath(input.cwd, attemptId, "result.json");
	const noFollow = constants.O_NOFOLLOW ?? 0;
	const promptFile = await open(promptPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
	try {
		await promptFile.writeFile(`${prompt}\n`, "utf8");
	} finally {
		await promptFile.close();
	}
	const resultFile = await open(resultPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
	try {
	const command = buildAloopWorkerCommand({ launcher: input.launcher ?? defaultLauncher(), prompt, modelRef: input.modelRef });
	const remainingBeforeSpawn = input.deadlineMs === undefined ? MAX_TIMEOUT_MS : input.deadlineMs - Date.now() - POSTFLIGHT_RESERVE_MS;
	if (remainingBeforeSpawn <= 0) throw new Error("Aloop worker deadline expired during preflight; worker was not spawned.");
	const timeoutMs = Math.max(1, Math.min(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, remainingBeforeSpawn));
	const processStarted = Date.now();
	let launchError: string | null = null;
	let processResult: ProcessResult;
	try {
		processResult = await runIsolatedAloopProcess({
			cwd: input.cwd,
			command,
			stdoutPath,
			stderrPath,
			timeoutMs,
			deadlineMs: input.deadlineMs === undefined ? undefined : input.deadlineMs - POSTFLIGHT_RESERVE_MS,
			signal: input.signal,
			env: input.env,
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
	const afterHead = await git(input.cwd, ["rev-parse", "HEAD"], gitOptions);
	const worktreeStatusAfter = await worktreeStatus(input.cwd, gitOptions);
	const beforeIsAncestor = await isAncestor(input.cwd, beforeHead, afterHead, gitOptions);
	const commitCount = beforeIsAncestor ? Number(await git(input.cwd, ["rev-list", "--count", `${beforeHead}..${afterHead}`], gitOptions)) : 0;
	const contract = assessAttemptContract({ beforeHead, afterHead, commitCount, beforeIsAncestor, worktreeStatus: worktreeStatusAfter });
	let workerResult: AloopWorkerResult | null = null;
	let parseError: string | null = null;
	if (!launchError) {
		try {
			workerResult = parseAloopWorkerResult(processResult.stdoutTail);
		} catch (error) {
			parseError = error instanceof Error ? error.message : String(error);
		}
	}
	const status = processResult.timedOut ? "timeout"
		: processResult.cancelled ? "cancelled"
			: launchError ? "worker-failed"
				: !contract.valid ? "contract-violation"
					: processResult.exitCode !== 0 ? "worker-failed"
						: parseError ? "invalid-result"
							: "completed";
	const fallback = contract.violations.join(" ") || `Worker exited with code ${processResult.exitCode ?? "unknown"}.`;
	const summary = boundedText(workerResult?.summary ?? launchError ?? parseError ?? fallback, MAX_SUMMARY_BYTES);
	const relative = (value: string) => path.relative(input.cwd, value);
	const outcome: AloopAttemptOutcome = {
		status,
		summary,
		commit: contract.commit,
		workerResult,
		contract,
		process: {
			exitCode: processResult.exitCode,
			signal: processResult.signal,
			timedOut: processResult.timedOut,
			cancelled: processResult.cancelled,
			durationMs: processResult.durationMs,
		},
		artifacts: {
			directory: relative(directory),
			prompt: relative(promptPath),
			stdout: relative(stdoutPath),
			stderr: relative(stderrPath),
			result: relative(resultPath),
		},
	};
	const [openedResult, currentResult] = await Promise.all([resultFile.stat(), lstat(resultPath)]);
	if (!currentResult.isFile() || openedResult.dev !== currentResult.dev || openedResult.ino !== currentResult.ino) {
		throw new Error("Aloop result artifact was replaced during worker execution.");
	}
	await resultFile.writeFile(
		`${JSON.stringify({ ...outcome, command: command.slice(0, -1), beforeHead, afterHead, commitCount, worktreeStatus: worktreeStatusAfter, launchError, parseError }, null, 2)}\n`,
		"utf8",
	);
	return outcome;
	} finally {
		await resultFile.close();
	}
}
