import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import * as path from "node:path";
import { Type } from "typebox";
import { claimCurrentRepositoryIssue, closeCurrentRepositoryIssue, currentGitHubLogin, publishExactIssueComment, retrieveCurrentRepositoryEpicContext } from "../github-issues/index.js";
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
	validateSuccessfulHandoffEvidence,
	type AloopAttemptRecord,
	type AloopRunBudget,
	type ClosureEvidence,
} from "./core.js";

const TOOL_NAMES = ["aloop_launch_worker", "aloop_supervisor_verify", "aloop_prepare_handoff", "aloop_publish_handoff", "aloop_close_accepted_issue", "aloop_check_closure"];
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

const SupervisorVerifyParams = Type.Object({
	commit: Type.String({ minLength: 7, description: "Exact full or abbreviated worker commit to verify." }),
	command: Type.String({ minLength: 1, description: "Repository-defined canonical verification command." }),
	production_integration: Type.Optional(Type.String({ description: "Packaging or production entry-point evidence when applicable." })),
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
	verification_receipt_id: Type.Optional(Type.String({ pattern: "^verify-[0-9a-f]{12}-[0-9]+-[0-9a-f]{8}$", description: "Required for an accepted handoff; returned by aloop_supervisor_verify." })),
});

const PublishHandoffParams = Type.Object({
	handoff_id: Type.String({ pattern: "^[a-f0-9]{24}$", description: "Short ID returned by aloop_prepare_handoff." }),
	dry_run: Type.Boolean({ description: "Must be true before publication is applied." }),
});

const CloseAcceptedIssueParams = Type.Object({
	issue: Type.Number({ minimum: 1 }),
	handoff_id: Type.String({ pattern: "^[a-f0-9]{24}$", description: "Published successful handoff ID." }),
	verification_receipt_id: Type.String({ pattern: "^verify-[0-9a-f]{12}-[0-9]+-[0-9a-f]{8}$" }),
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
				let issue = selectAloopLeaf(context, params.issue);
				const commandOptions = { signal, deadlineMs: runBudget.deadlineMs };
				const login = await currentGitHubLogin(ctx.cwd, undefined, commandOptions);
				if (issue.assignee === null) {
					await claimCurrentRepositoryIssue(ctx.cwd, issue.number, commandOptions);
					const claimedContext = await currentContext(ctx.cwd, signal);
					refreshPending(claimedContext);
					issue = selectAloopLeaf(claimedContext, params.issue);
				}
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
				const finalAttemptNotice = attemptNumber === runBudget.maxAttempts ? " This is the final permitted attempt for this invocation." : "";
				const progress = () => onUpdate?.({
					content: [{ type: "text", text: `Aloop attempt ${attemptNumber}/${runBudget!.maxAttempts} for #${issue.number} is running (${Math.floor((Date.now() - startedAt) / 1_000)}s elapsed; ${Math.ceil((runBudget!.deadlineMs - Date.now()) / 60_000)}m remaining; hard timeout ${Math.ceil(workerTimeoutMs / 60_000)}m).${finalAttemptNotice}` }],
					details: { issue: issue.number, attemptNumber, maxAttempts: runBudget!.maxAttempts, finalPermittedAttempt: attemptNumber === runBudget!.maxAttempts, elapsedMs: Date.now() - startedAt, remainingMs: Math.max(0, runBudget!.deadlineMs - Date.now()), timeoutMs: workerTimeoutMs },
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
					"Next required action: independently assess the issue acceptance criteria, call aloop_prepare_handoff, publish its ID with aloop_publish_handoff (dry-run then apply), and only then close/remediate/continue.",
				].join("\n");
				return { content: [{ type: "text", text }], details: outcome };
			} finally {
				workerRunning = false;
			}
		},
	});

	pi.registerTool({
		name: "aloop_supervisor_verify",
		label: "Aloop Supervisor Verify",
		description: "Independently run a repository-defined check against an exact committed, clean source tree and persist a commit-bound receipt.",
		promptSnippet: "Verify the returned worker commit independently before accepting its handoff.",
		promptGuidelines: ["Run after the worker's final commit. Any untracked or modified source blocks verification; any later change invalidates the receipt."],
		parameters: SupervisorVerifyParams,
		async execute(_id, params: { commit: string; command: string; production_integration?: string }, signal, onUpdate, ctx) {
			if (!runBudget) throw new Error("Run /aloop #<epic> before supervisor verification.");
			const inspect = async (args: string[]) => {
				const remaining = assessAloopRunBudget(runBudget!, Date.now());
				if (!remaining.allowed) throw new Error(remaining.reason);
				const result = await pi.exec("git", args, { timeout: Math.max(1, Math.min(30_000, remaining.remainingMs)), signal });
				if (result.code !== 0) throw new Error((result.stderr || result.stdout || `git ${args[0]} failed`).trim());
				return result.stdout.trim();
			};
			const expected = await inspect(["rev-parse", `${params.commit}^{commit}`]);
			const beforeHead = await inspect(["rev-parse", "HEAD"]);
			const beforeStatus = await inspect(["status", "--porcelain=v1", "--untracked-files=all"]);
			if (beforeHead !== expected) throw new Error(`Returned commit ${expected} differs from current HEAD ${beforeHead}.`);
			if (beforeStatus) throw new Error("Supervisor verification requires a clean worktree, including no untracked files. Commit intended sources before verification.");
			const sourceIdentity = `tree:${await inspect(["rev-parse", `${expected}^{tree}`])}`;
			onUpdate?.({ content: [{ type: "text", text: `Running supervisor verification at ${expected.slice(0, 12)}: ${params.command}` }], details: { commit: expected, command: params.command } });
			const remaining = assessAloopRunBudget(runBudget, Date.now());
			if (!remaining.allowed) throw new Error(remaining.reason);
			const result = await pi.exec("bash", ["-lc", params.command], { timeout: Math.max(1, remaining.remainingMs), signal });
			const afterHead = await inspect(["rev-parse", "HEAD"]);
			const afterStatus = await inspect(["status", "--porcelain=v1", "--untracked-files=all"]);
			const receipt = {
				commit: expected,
				command: params.command,
				exitStatus: result.code,
				timestamp: new Date().toISOString(),
				sourceIdentity,
				productionIntegration: params.production_integration?.trim() || undefined,
				postVerificationHead: afterHead,
				postVerificationClean: afterStatus === "",
			};
			const receiptId = `verify-${expected.slice(0, 12)}-${Date.now()}-${randomBytes(4).toString("hex")}`;
			const receiptDirectory = path.resolve(ctx.cwd, ".pi/tmp/aloop/receipts");
			await mkdir(receiptDirectory, { recursive: true, mode: 0o700 });
			const receiptPath = path.join(receiptDirectory, `${receiptId}.json`);
			await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
			const valid = result.code === 0 && afterHead === expected && afterStatus === "";
			return {
				content: [{ type: "text", text: `${valid ? "Supervisor verification passed" : "Supervisor verification failed or was invalidated"} at ${expected}. Receipt: .pi/tmp/aloop/receipts/${receiptId}.json (exit ${result.code}; post-check clean=${afterStatus === ""}).` }],
				details: { valid, receiptId, receiptPath: `.pi/tmp/aloop/receipts/${receiptId}.json`, receipt, stdout: result.stdout, stderr: result.stderr },
			};
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
			verification: string[]; acceptance_criteria_assessment: string[]; discovered_work: string[]; next_action: string; artifact_directory: string; verification_receipt_id?: string;
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
			if (params.successful) {
				if (!params.commit || !params.verification_receipt_id) throw new Error("Accepted handoffs require a commit and independent supervisor verification receipt ID.");
				const selectedIssue = context.issues.find((candidate) => candidate.number === params.issue);
				if (!selectedIssue || selectedIssue.number === context.epic.number) throw new Error("Accepted handoffs apply only to descendants of the active epic.");
				const evidenceReasons = validateSuccessfulHandoffEvidence({
					issueBody: selectedIssue.body,
					verification: params.verification,
					acceptanceCriteriaAssessment: params.acceptance_criteria_assessment,
				});
				if (evidenceReasons.length > 0) throw new Error(`Accepted handoff lacks required evidence:\n- ${evidenceReasons.join("\n- ")}`);
				const receiptPath = path.resolve(ctx.cwd, `.pi/tmp/aloop/receipts/${params.verification_receipt_id}.json`);
				const receiptStatus = await lstat(receiptPath);
				if (receiptStatus.isSymbolicLink() || !receiptStatus.isFile() || receiptStatus.size > 100_000) throw new Error("Supervisor verification receipt is unsafe or oversized.");
				const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
				const head = await pi.exec("git", ["rev-parse", `${params.commit}^{commit}`], { timeout: 10_000, signal });
				const currentHead = await pi.exec("git", ["rev-parse", "HEAD"], { timeout: 10_000, signal });
				const worktree = await pi.exec("git", ["status", "--porcelain=v1", "--untracked-files=all"], { timeout: 10_000, signal });
				if (head.code !== 0 || currentHead.code !== 0 || worktree.code !== 0) throw new Error("Could not validate the supervisor verification receipt against Git.");
				const expected = head.stdout.trim();
				if (receipt.commit !== expected || currentHead.stdout.trim() !== expected || receipt.exitStatus !== 0 || receipt.postVerificationHead !== expected || receipt.postVerificationClean !== true || worktree.stdout.trim()) {
					throw new Error("Accepted handoff is not bound to a passing receipt at the current clean commit; rerun supervisor verification after all source changes.");
				}
			}
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
			const bytes = Buffer.from(comment, "utf8");
			const handoffId = createHash("sha256").update(`${params.issue}\0`).update(bytes).digest("hex").slice(0, 24);
			const spoolDirectory = path.resolve(ctx.cwd, ".pi/tmp/aloop/handoffs");
			await mkdir(spoolDirectory, { recursive: true, mode: 0o700 });
			const spoolPath = path.join(spoolDirectory, `${handoffId}.json`);
			const record = `${JSON.stringify({ version: 1, id: handoffId, issue: params.issue, sha256: createHash("sha256").update(bytes).digest("hex"), comment })}\n`;
			try {
				await writeFile(spoolPath, record, { encoding: "utf8", mode: 0o600, flag: "wx" });
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST" || await readFile(spoolPath, "utf8") !== record) throw error;
			}
			return {
				content: [{ type: "text", text: `Prepared handoff ${handoffId} for #${params.issue} (${bytes.length} bytes). Call aloop_publish_handoff with dry_run=true, then with dry_run=false; do not copy the comment through the model.` }],
				details: { issue: params.issue, handoffId, byteLength: bytes.length, spoolPath: `.pi/tmp/aloop/handoffs/${handoffId}.json` },
			};
		},
	});

	pi.registerTool({
		name: "aloop_publish_handoff",
		label: "Aloop Publish Handoff",
		description: "Dry-run or idempotently publish the exact prepared handoff bytes by short ID.",
		promptSnippet: "Publish a prepared handoff by ID without copying its encoded comment.",
		promptGuidelines: ["Always call with dry_run=true before dry_run=false. The spooled bytes are authoritative."],
		parameters: PublishHandoffParams,
		async execute(_id, params: { handoff_id: string; dry_run: boolean }, signal, _onUpdate, ctx) {
			if (!runBudget) throw new Error("Run /aloop #<epic> before publishing a handoff.");
			const spoolPath = path.resolve(ctx.cwd, `.pi/tmp/aloop/handoffs/${params.handoff_id}.json`);
			const status = await lstat(spoolPath);
			if (status.isSymbolicLink() || !status.isFile() || status.size > 100_000) throw new Error("Prepared handoff spool entry is unsafe or oversized.");
			const record = JSON.parse(await readFile(spoolPath, "utf8"));
			if (record?.version !== 1 || record.id !== params.handoff_id || !Number.isInteger(record.issue) || typeof record.comment !== "string") throw new Error("Prepared handoff spool entry is malformed.");
			const digest = createHash("sha256").update(Buffer.from(record.comment, "utf8")).digest("hex");
			if (digest !== record.sha256) throw new Error("Prepared handoff bytes failed integrity validation.");
			const result = await publishExactIssueComment(ctx.cwd, record.issue, record.comment, !params.dry_run, { signal, deadlineMs: runBudget.deadlineMs });
			return {
				content: [{ type: "text", text: `${params.dry_run ? "Dry run complete" : "Publication complete"} for handoff ${params.handoff_id} on #${record.issue}; ${Buffer.byteLength(record.comment)} exact bytes.` }],
				details: { handoffId: params.handoff_id, issue: record.issue, dryRun: params.dry_run, byteLength: Buffer.byteLength(record.comment), result },
			};
		},
	});

	pi.registerTool({
		name: "aloop_close_accepted_issue",
		label: "Aloop Close Accepted Issue",
		description: "Close a child only when its exact successful handoff is published and its supervisor receipt still matches the current clean commit.",
		promptSnippet: "Close a verified child through the receipt-gated aloop operation.",
		promptGuidelines: ["Use only after aloop_publish_handoff applies the exact prepared bytes; never use generic issue closure for accepted aloop attempts."],
		parameters: CloseAcceptedIssueParams,
		async execute(_id, params: { issue: number; handoff_id: string; verification_receipt_id: string }, signal, _onUpdate, ctx) {
			const context = await currentContext(ctx.cwd, signal);
			const issue = context.issues.find((candidate) => candidate.number === params.issue);
			if (!issue || issue.number === context.epic.number) throw new Error("Receipt-gated closure applies only to a descendant of the active epic.");
			if (issue.state !== "open") throw new Error(`Issue #${params.issue} is not open.`);

			const spoolPath = path.resolve(ctx.cwd, `.pi/tmp/aloop/handoffs/${params.handoff_id}.json`);
			const spoolStatus = await lstat(spoolPath);
			if (!spoolStatus.isFile() || spoolStatus.isSymbolicLink() || spoolStatus.size > 100_000) throw new Error("Prepared handoff spool entry is unsafe or oversized.");
			const spool = JSON.parse(await readFile(spoolPath, "utf8"));
			if (spool?.version !== 1 || spool.id !== params.handoff_id || spool.issue !== params.issue || typeof spool.comment !== "string") throw new Error("Prepared handoff does not identify this issue.");
			const digest = createHash("sha256").update(Buffer.from(spool.comment, "utf8")).digest("hex");
			if (digest !== spool.sha256 || !issue.recentHandoffs.some((comment) => comment.body === spool.comment)) throw new Error("The exact prepared handoff is not durably published on GitHub.");
			const [handoff] = parseAloopHandoffs([spool.comment]);
			if (!handoff?.successful || !handoff.commit) throw new Error("Only a successful commit-bearing handoff may close an issue.");

			const receiptPath = path.resolve(ctx.cwd, `.pi/tmp/aloop/receipts/${params.verification_receipt_id}.json`);
			const receiptStatus = await lstat(receiptPath);
			if (!receiptStatus.isFile() || receiptStatus.isSymbolicLink() || receiptStatus.size > 100_000) throw new Error("Supervisor verification receipt is unsafe or oversized.");
			const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
			const head = await pi.exec("git", ["rev-parse", "HEAD"], { timeout: 10_000, signal });
			const status = await pi.exec("git", ["status", "--porcelain=v1", "--untracked-files=all"], { timeout: 10_000, signal });
			if (head.code !== 0 || status.code !== 0 || status.stdout.trim() || head.stdout.trim() !== handoff.commit || receipt.commit !== handoff.commit || receipt.exitStatus !== 0 || receipt.postVerificationHead !== handoff.commit || receipt.postVerificationClean !== true) {
				throw new Error("Closure blocked: the published handoff, receipt, and current clean Git commit do not match.");
			}
			const result = await closeCurrentRepositoryIssue(ctx.cwd, params.issue, { signal, deadlineMs: runBudget!.deadlineMs });
			return { content: [{ type: "text", text: `Closed verified issue #${params.issue} at ${handoff.commit}.` }], details: { issue: params.issue, commit: handoff.commit, handoffId: params.handoff_id, receiptId: params.verification_receipt_id, result } };
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
