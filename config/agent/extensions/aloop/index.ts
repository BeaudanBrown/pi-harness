import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { lstat, readdir, readFile } from "node:fs/promises";
import * as path from "node:path";
import { Type } from "typebox";
import { currentGitHubLogin, retrieveCurrentRepositoryEpicContext } from "../github-issues/index.js";
import { runAloopWorker } from "../github-issues/aloop-worker.js";
import {
	assessAloopRunBudget,
	buildSupervisorKickoff,
	evaluateEpicClosure,
	evaluateRetryBoundary,
	findOutstandingAttempts,
	formatAloopHandoff,
	handoffCommentsForIssue,
	parseAloopHandoffs,
	parseAloopRunRequest,
	requireAloopClaim,
	selectAloopLeaf,
	type AloopAttemptRecord,
	type AloopRunBudget,
	type ClosureEvidence,
} from "./core.js";

const TOOL_NAMES = ["aloop_launch_worker", "aloop_prepare_handoff", "aloop_check_closure"];
const STATUS_KEY = "aloop";
const MAX_COMMENT_LIMIT = 20;
const MAX_COMMENT_BODY = 20_000;

type PendingHandoff = {
	issue: number;
	commit: string | null;
	artifactDirectory: string;
};

const LaunchWorkerParams = Type.Object({
	issue: Type.Number({ minimum: 1, description: "Selected open, unblocked descendant leaf issue number." }),
	attempt_type: Type.String({ description: "implementation or remediation" }),
	approach: Type.String({ minLength: 1, description: "Concise description of this attempt's approach." }),
	materially_new_approach: Type.Optional(Type.Boolean({ description: "True only when this differs materially from prior unsuccessful approaches." })),
	timeout_ms: Type.Optional(Type.Number({ minimum: 1, maximum: 14_400_000 })),
});

const PrepareHandoffParams = Type.Object({
	issue: Type.Number({ minimum: 1 }),
	attempt_type: Type.String({ description: "implementation or remediation" }),
	commit: Type.Optional(Type.String({ description: "Attempt commit, omitted when the attempt produced no valid commit." })),
	successful: Type.Boolean({ description: "Supervisor acceptance result, not merely the worker's claim." }),
	approach: Type.String({ minLength: 1 }),
	materially_new_approach: Type.Boolean(),
	verification: Type.Array(Type.String()),
	acceptance_criteria_assessment: Type.Array(Type.String()),
	discovered_work: Type.Array(Type.String()),
	next_action: Type.String({ minLength: 1 }),
	artifact_directory: Type.String({ minLength: 1 }),
});

const ClosureCheckParams = Type.Object({
	verification: Type.Array(Type.Object({
		check: Type.String({ minLength: 1 }),
		passed: Type.Boolean(),
		evidence: Type.String(),
	})),
	acceptance_criteria: Type.Array(Type.Object({
		criterion: Type.String({ minLength: 1 }),
		satisfied: Type.Boolean(),
		evidence: Type.String(),
	})),
	descendant_reviews: Type.Array(Type.Object({
		issue: Type.Number({ minimum: 1 }),
		reviewed: Type.Boolean(),
		evidence: Type.String(),
	})),
});

function activeModelRef(ctx: ExtensionContext): string | undefined {
	return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
}

async function scanAttemptArtifacts(cwd: string): Promise<AloopAttemptRecord[]> {
	const root = path.resolve(cwd, ".pi/tmp/aloop");
	let rootStatus;
	try {
		rootStatus = await lstat(root);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	if (rootStatus.isSymbolicLink() || !rootStatus.isDirectory()) return [];
	const entries = (await readdir(root, { withFileTypes: true }))
		.filter((entry) => entry.isDirectory() && /^issue-\d+-\d+-[a-f0-9]+$/.test(entry.name))
		.sort((left, right) => left.name.localeCompare(right.name))
		.slice(-200);
	const records: AloopAttemptRecord[] = [];
	for (const entry of entries) {
		const match = entry.name.match(/^issue-(\d+)-/);
		if (!match) continue;
		const resultPath = path.join(root, entry.name, "result.json");
		try {
			const status = await lstat(resultPath);
			if (status.isSymbolicLink() || !status.isFile() || status.size > 1_000_000) continue;
			const result = JSON.parse(await readFile(resultPath, "utf8"));
			const artifactDirectory = `.pi/tmp/aloop/${entry.name}`;
			if (result?.artifacts?.directory !== artifactDirectory) continue;
			const commit = result.commit === null ? null : typeof result.commit === "string" && /^[0-9a-f]{7,64}$/i.test(result.commit) ? result.commit : undefined;
			if (commit === undefined || typeof result.status !== "string") continue;
			records.push({ issue: Number(match[1]), commit, artifactDirectory, status: result.status });
		} catch {
			// Ignore incomplete or malformed attempt artifacts; they carry no recoverable structured outcome.
		}
	}
	return records;
}

function handoffWasRecorded(context: Awaited<ReturnType<typeof retrieveCurrentRepositoryEpicContext>>, pending: PendingHandoff): boolean {
	const issue = context.issues.find((candidate) => candidate.number === pending.issue);
	if (!issue) return false;
	return parseAloopHandoffs(issue.recentHandoffs).some((handoff) =>
		handoff.issue === pending.issue
		&& handoff.artifactDirectory === pending.artifactDirectory
		&& handoff.commit === pending.commit,
	);
}

export default function aloopExtension(pi: ExtensionAPI): void {
	let activeEpic: number | null = null;
	let pendingHandoffs: PendingHandoff[] = [];
	let workerRunning = false;
	let runBudget: AloopRunBudget | null = null;
	let deadlineTimer: ReturnType<typeof setTimeout> | null = null;

	function clearDeadlineTimer(): void {
		if (deadlineTimer) clearTimeout(deadlineTimer);
		deadlineTimer = null;
	}

	function deactivate(): void {
		clearDeadlineTimer();
		activeEpic = null;
		pendingHandoffs = [];
		workerRunning = false;
		runBudget = null;
		pi.setActiveTools(pi.getActiveTools().filter((name) => !TOOL_NAMES.includes(name)));
	}

	function activate(epic: number, ctx: ExtensionContext, recovered: PendingHandoff[], maxMinutes: number, maxAttempts: number): AloopRunBudget {
		clearDeadlineTimer();
		activeEpic = epic;
		pendingHandoffs = recovered;
		runBudget = { deadlineMs: Date.now() + maxMinutes * 60_000, maxAttempts, attemptsStarted: 0, settled: false };
		deadlineTimer = setTimeout(() => {
			if (!runBudget || runBudget.settled) return;
			ctx.abort();
			if (ctx.hasUI) {
				ctx.ui.notify(`Aloop #${epic} reached its ${maxMinutes}-minute limit. Run /aloop again to resume.`, "warning");
				ctx.ui.setStatus(STATUS_KEY, `aloop: #${epic} time limit reached`);
			}
		}, maxMinutes * 60_000);
		deadlineTimer.unref?.();
		pi.setActiveTools([...new Set([...pi.getActiveTools(), ...TOOL_NAMES])]);
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, `aloop: #${epic} · ${maxMinutes}m · ${maxAttempts} attempts`);
		return runBudget;
	}

	async function currentContext(cwd: string, signal?: AbortSignal) {
		if (activeEpic === null || !runBudget) throw new Error("Run /aloop #<epic> before using aloop supervisor tools.");
		return await retrieveCurrentRepositoryEpicContext(cwd, activeEpic, undefined, {
			commentLimit: MAX_COMMENT_LIMIT,
			commentBodyLimit: MAX_COMMENT_BODY,
			signal,
			deadlineMs: runBudget.deadlineMs,
		});
	}

	pi.on("session_start", (_event, ctx) => {
		deactivate();
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
	});
	pi.on("session_shutdown", (_event, ctx) => {
		clearDeadlineTimer();
		activeEpic = null;
		pendingHandoffs = [];
		workerRunning = false;
		runBudget = null;
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
	});
	pi.on("agent_settled", (_event, ctx) => {
		if (!runBudget || runBudget.settled) return;
		runBudget.settled = true;
		clearDeadlineTimer();
		if (ctx.hasUI && activeEpic !== null) ctx.ui.setStatus(STATUS_KEY, `aloop: #${activeEpic} settled · rerun to continue`);
	});

	function refreshPending(context: Awaited<ReturnType<typeof retrieveCurrentRepositoryEpicContext>>): void {
		pendingHandoffs = pendingHandoffs.filter((pending) => !handoffWasRecorded(context, pending));
	}

	pi.registerCommand("aloop", {
		description: "Supervise a GitHub epic with fresh sequential implementation workers",
		getArgumentCompletions: (prefix) => /^#?\d*$/.test(prefix) ? null : [{ value: "#", label: "#<epic>" }],
		handler: async (args, ctx) => {
			let request;
			try {
				request = parseAloopRunRequest(args);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
				return;
			}
			const epic = request.epic;
			if (!ctx.isIdle()) {
				ctx.ui.notify("/aloop must be started while Pi is idle; abort the active turn or wait for it to settle, then retry.", "warning");
				return;
			}
			const status = await pi.exec("git", ["status", "--porcelain=v1", "--untracked-files=all"], { timeout: 10_000 });
			if (status.code !== 0) throw new Error((status.stderr || status.stdout || "Could not inspect the worktree.").trim());
			if (status.stdout.trim()) {
				ctx.ui.notify("/aloop requires a clean worktree before supervision starts.", "error");
				return;
			}
			const budget = activate(epic, ctx, [], request.maxMinutes, request.maxAttempts);
			let context;
			try {
				context = await retrieveCurrentRepositoryEpicContext(ctx.cwd, epic, undefined, {
					commentLimit: MAX_COMMENT_LIMIT,
					commentBodyLimit: MAX_COMMENT_BODY,
					signal: ctx.signal,
					deadlineMs: budget.deadlineMs,
				});
			} catch (error) {
				deactivate();
				if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
				throw error;
			}
			if (context.epic.state !== "open") {
				deactivate();
				ctx.ui.notify(`Epic #${epic} is not open.`, "warning");
				return;
			}
			const startupTimeout = () => {
				const assessment = assessAloopRunBudget(budget, Date.now());
				if (!assessment.allowed) throw new Error(assessment.reason);
				return Math.max(1, Math.min(10_000, assessment.remainingMs));
			};
			try {
				const history = await pi.exec("git", ["log", "--oneline", "--decorate", "-30"], { timeout: startupTimeout() });
				if (history.code !== 0) throw new Error((history.stderr || history.stdout || "Could not inspect Git history.").trim());
				startupTimeout();
				const records = await scanAttemptArtifacts(ctx.cwd);
				startupTimeout();
				const branchRecords: AloopAttemptRecord[] = [];
				for (const record of records) {
					if (record.commit === null) {
						branchRecords.push(record);
						continue;
					}
					const ancestry = await pi.exec("git", ["merge-base", "--is-ancestor", record.commit, "HEAD"], { timeout: startupTimeout() });
					if (ancestry.code === 0) branchRecords.push(record);
					else if (ancestry.code !== 1) throw new Error((ancestry.stderr || ancestry.stdout || `Could not inspect attempt commit ${record.commit}.`).trim());
				}
				startupTimeout();
				const outstanding = findOutstandingAttempts(context, branchRecords);
				pendingHandoffs = outstanding;
				pi.setSessionName(`aloop-${epic}`);
				startupTimeout();
				pi.sendUserMessage(buildSupervisorKickoff(context, history.stdout, outstanding, budget));
			} catch (error) {
				deactivate();
				if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
				throw error;
			}
		},
	});

	pi.registerTool({
		name: "aloop_launch_worker",
		label: "Aloop Launch Worker",
		description: "Launch one fresh sequential implementation or remediation worker for an executable epic leaf.",
		promptSnippet: "Launch one fresh aloop implementation worker and return bounded artifact-backed attempt evidence.",
		promptGuidelines: [
			"Use aloop_launch_worker only for one executable descendant leaf at a time after /aloop activation.",
			"After every aloop_launch_worker result, independently assess evidence and publish a durable handoff before launching another worker.",
		],
		parameters: LaunchWorkerParams,
		async execute(_id, params: { issue: number; attempt_type: string; approach: string; materially_new_approach?: boolean; timeout_ms?: number }, signal, onUpdate, ctx) {
			if (workerRunning) throw new Error("An aloop worker is already running; workers must remain sequential.");
			workerRunning = true;
			try {
				if (params.attempt_type !== "implementation" && params.attempt_type !== "remediation") throw new Error("attempt_type must be implementation or remediation.");
				if (!runBudget) throw new Error("Run /aloop #<epic> before launching a worker.");
				const budgetAssessment = assessAloopRunBudget(runBudget, Date.now());
				if (!budgetAssessment.allowed) throw new Error(budgetAssessment.reason);
				const context = await currentContext(ctx.cwd, signal);
				refreshPending(context);
				if (pendingHandoffs.length > 0) {
					throw new Error(`Outstanding attempts have no durable structured handoff comments: ${pendingHandoffs.map((pending) => `#${pending.issue} (${pending.artifactDirectory})`).join(", ")}. Record them before another worker.`);
				}
				const issue = selectAloopLeaf(context, params.issue);
				const login = await currentGitHubLogin(ctx.cwd, undefined, { signal, deadlineMs: runBudget.deadlineMs });
				requireAloopClaim(issue, login);
				const handoffs = parseAloopHandoffs(issue.recentHandoffs).filter((handoff) => handoff.issue === issue.number);
				const retry = evaluateRetryBoundary(handoffs, params.materially_new_approach === true);
				if (!retry.allowed) throw new Error(retry.reason);
				const epic = context.issues.find((candidate) => candidate.number === context.epic.number)!;
				const launchBudget = assessAloopRunBudget(runBudget, Date.now());
				if (!launchBudget.allowed) throw new Error(launchBudget.reason);
				runBudget.attemptsStarted += 1;
				const attemptNumber = runBudget.attemptsStarted;
				const startedAt = Date.now();
				const workerTimeoutMs = Math.min(params.timeout_ms ?? 30 * 60_000, launchBudget.remainingMs);
				const progress = () => onUpdate?.({
					content: [{ type: "text", text: `Aloop attempt ${attemptNumber}/${runBudget!.maxAttempts} for #${issue.number} is running (${Math.floor((Date.now() - startedAt) / 1_000)}s elapsed; hard timeout ${Math.ceil(workerTimeoutMs / 60_000)}m).` }],
					details: { issue: issue.number, attemptNumber, maxAttempts: runBudget!.maxAttempts, elapsedMs: Date.now() - startedAt, timeoutMs: workerTimeoutMs },
				});
				progress();
				const heartbeat = setInterval(progress, 15_000);
				heartbeat.unref?.();
				let outcome: Awaited<ReturnType<typeof runAloopWorker>>;
				try {
					outcome = await runAloopWorker({
						cwd: ctx.cwd,
						attemptType: params.attempt_type,
						epic: { number: epic.number, title: epic.title, body: epic.body },
						issue: { number: issue.number, title: issue.title, body: issue.body },
						priorHandoffs: handoffCommentsForIssue(issue),
						modelRef: activeModelRef(ctx),
						timeoutMs: workerTimeoutMs,
						deadlineMs: runBudget.deadlineMs,
						signal,
					});
				} finally {
					clearInterval(heartbeat);
				}
				pendingHandoffs.push({ issue: issue.number, commit: outcome.commit, artifactDirectory: outcome.artifacts.directory });
				const text = [
					`Attempt status: ${outcome.status}`,
					`Issue: #${issue.number}`,
					`Commit: ${outcome.commit ?? "none"}`,
					`Summary: ${outcome.summary}`,
					`Artifacts: ${outcome.artifacts.directory}`,
					`Structured result: ${outcome.artifacts.result}`,
					"Next required action: independently assess the issue acceptance criteria, call aloop_prepare_handoff, publish that exact comment with github_issue_mutate (dry-run then apply), and only then close/remediate/continue.",
				].join("\n");
				return { content: [{ type: "text", text }], details: outcome };
			} finally {
				workerRunning = false;
			}
		},
	});

	pi.registerTool({
		name: "aloop_prepare_handoff",
		label: "Aloop Prepare Handoff",
		description: "Format a bounded durable aloop attempt handoff comment after the supervisor assesses worker evidence.",
		promptSnippet: "Prepare the exact structured GitHub comment required after every aloop worker attempt.",
		promptGuidelines: ["Use aloop_prepare_handoff after every aloop_launch_worker result, then publish its exact output with github_issue_mutate using dry-run first."],
		parameters: PrepareHandoffParams,
		async execute(_id, params: {
			issue: number; attempt_type: string; commit?: string; successful: boolean; approach: string; materially_new_approach: boolean;
			verification: string[]; acceptance_criteria_assessment: string[]; discovered_work: string[]; next_action: string; artifact_directory: string;
		}, signal, _onUpdate, ctx) {
			const context = await currentContext(ctx.cwd, signal);
			refreshPending(context);
			if (params.attempt_type !== "implementation" && params.attempt_type !== "remediation") throw new Error("attempt_type must be implementation or remediation.");
			const pending = pendingHandoffs.find((candidate) =>
				candidate.issue === params.issue
				&& candidate.commit === (params.commit ?? null)
				&& candidate.artifactDirectory === params.artifact_directory,
			);
			if (!pending) throw new Error("No outstanding worker attempt matches this handoff.");
			const comment = formatAloopHandoff({
				issue: params.issue,
				attemptType: params.attempt_type,
				commit: params.commit ?? null,
				successful: params.successful,
				approach: params.approach,
				materiallyNewApproach: params.materially_new_approach,
				verification: params.verification,
				acceptanceCriteriaAssessment: params.acceptance_criteria_assessment,
				discoveredWork: params.discovered_work,
				nextAction: params.next_action,
				artifactDirectory: params.artifact_directory,
				timestamp: new Date().toISOString(),
			});
			return {
				content: [{ type: "text", text: `Publish this exact comment on #${params.issue} with github_issue_mutate (dry-run, review, then apply):\n\n${comment}` }],
				details: { issue: params.issue, comment },
			};
		},
	});

	pi.registerTool({
		name: "aloop_check_closure",
		label: "Aloop Check Closure",
		description: "Gate epic closure on closed descendants, descendant review, project verification, and epic acceptance evidence.",
		promptSnippet: "Check whether the active aloop epic has enough evidence to close.",
		promptGuidelines: ["Call aloop_check_closure before closing an epic; do not close when it returns allowed=false."],
		parameters: ClosureCheckParams,
		async execute(_id, params: {
			verification: ClosureEvidence["verification"];
			acceptance_criteria: ClosureEvidence["acceptanceCriteria"];
			descendant_reviews: ClosureEvidence["descendantReviews"];
		}, signal, _onUpdate, ctx) {
			const context = await currentContext(ctx.cwd, signal);
			refreshPending(context);
			const reasons: string[] = pendingHandoffs.map((pending) => `Attempt handoff for #${pending.issue} is not durable on GitHub (${pending.artifactDirectory}).`);
			const gate = evaluateEpicClosure(context, {
				verification: params.verification,
				acceptanceCriteria: params.acceptance_criteria,
				descendantReviews: params.descendant_reviews,
			});
			reasons.push(...gate.reasons);
			const allowed = reasons.length === 0;
			return {
				content: [{ type: "text", text: allowed ? `Closure allowed for epic #${context.epic.number}.` : `Closure blocked for epic #${context.epic.number}:\n- ${reasons.join("\n- ")}` }],
				details: { allowed, reasons, epic: context.epic.number },
			};
		},
	});
}
