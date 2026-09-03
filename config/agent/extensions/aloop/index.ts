import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { lstat, mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import * as path from "node:path";
import { Type } from "typebox";
import { closeCurrentRepositoryIssue, publishExactIssueComment, retrieveCurrentRepositoryEpicContext } from "../github-issues/index.js";
import { runAloopPatchWorker, runAloopWorker, selectAloopPatchModel } from "../github-issues/aloop-worker.js";
import { balancedLogExcerpt, runDurableCommand, writeDurableResult } from "../worker-runner/command-execution.js";
import { snapshotAloopPolicy, type AloopCommandDefinition, type AloopPolicySnapshot } from "./policy.js";
import {
	acceptedOpenAloopIssues,
	assessAloopRunBudget,
	buildSupervisorKickoff,
	closeAcceptedAloopIssue,
	createAloopHandoffSpoolRecord,
	evaluateEpicClosure,
	findOutstandingAttempts,
	formatAloopHandoff,
	formatAloopHandoffV3,
	parseAloopHandoffV3,
	nextIssueRetryNumber,
	parseAloopHandoffs,
	parseAloopRunRequest,
	publishPreparedAloopHandoff,
	recognizeClosedAloopRetry,
	selectAloopLeaf,
	validateAloopHandoffSpoolRecord,
	validateSuccessfulHandoffEvidence,
	type AloopAttemptRecord,
	type AloopRunBudget,
	type ClosureEvidence,
} from "./core.js";

const LEGACY_TOOL_NAMES = ["aloop_supervisor_verify", "aloop_prepare_handoff", "aloop_publish_handoff", "aloop_close_accepted_issue", "aloop_check_closure"];
const TOOL_NAMES = ["aloop_context", "aloop_abort", "aloop_launch_worker", "aloop_review_attempt", "aloop_apply_patch", "aloop_finish_attempt", "aloop_checkpoint", "aloop_epic_completion"];
const ALL_ALOOP_TOOLS = [...TOOL_NAMES, ...LEGACY_TOOL_NAMES];
const STATUS_KEY = "aloop";
const MAX_COMMENT_LIMIT = 20;
const MAX_COMMENT_BODY = 20_000;

function sameArgv(left: unknown, right: string[] | undefined): boolean {
	return right !== undefined && Array.isArray(left) && left.length === right.length && left.every((value, index) => value === right[index]);
}

type PendingHandoff = {
	issue: number;
	commit: string | null;
	artifactDirectory: string;
	patchArtifacts?: Array<{ commit: string | null; artifactDirectory: string; status: string }>;
};


const LaunchWorkerParams = Type.Object({
	issue: Type.Number({ minimum: 1, description: "Selected open, unblocked descendant leaf issue number." }),
	attempt_type: Type.Optional(Type.Union([Type.Literal("implementation"), Type.Literal("remediation")])),
	timeout_ms: Type.Optional(Type.Number({ minimum: 1, maximum: 14_400_000 })),
});

const ApplyPatchParams = Type.Object({
	issue: Type.Number({ minimum: 1, description: "Issue whose unsettled full attempt needs a narrow correction." }),
	correction: Type.String({ minLength: 1, description: "Exact bounded correction for the targeted patch worker." }),
	timeout_ms: Type.Optional(Type.Number({ minimum: 1, maximum: 14_400_000 })),
});

const SupervisorVerifyParams = Type.Object({
	commit: Type.String({ minLength: 7, description: "Exact full or abbreviated worker commit to verify with the repository-owned .aloop.json policy." }),
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
	dry_run: Type.Boolean({ description: "Must be true before closure is applied." }),
});

const VerificationEvidenceParams = Type.Array(Type.Object({
	check: Type.String({ minLength: 1 }),
	passed: Type.Boolean(),
	evidence: Type.String(),
}));
const AcceptanceEvidenceParams = Type.Array(Type.Object({
	criterion: Type.String({ minLength: 1 }),
	satisfied: Type.Boolean(),
	evidence: Type.String(),
}));
const DescendantReviewParams = Type.Array(Type.Object({
	issue: Type.Number({ minimum: 1 }),
	reviewed: Type.Boolean(),
	evidence: Type.String(),
}));

const ClosureCheckParams = Type.Object({
	verification: VerificationEvidenceParams,
	acceptance_criteria: AcceptanceEvidenceParams,
	descendant_reviews: DescendantReviewParams,
});

const EpicCompletionParams = Type.Object({
	phase: Type.Union([Type.Literal("prepare"), Type.Literal("apply")]),
	acceptance_criteria: Type.Optional(AcceptanceEvidenceParams),
});

function activeModelRef(ctx: ExtensionContext): string | undefined {
	return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
}

function registeredModel(ctx: ExtensionContext, reference: string): boolean {
	const slash = reference.indexOf("/");
	if (slash <= 0 || slash === reference.length - 1) return false;
	const model = ctx.modelRegistry.find(reference.slice(0, slash), reference.slice(slash + 1));
	return model !== undefined && ctx.modelRegistry.hasConfiguredAuth(model);
}

export async function scanAttemptArtifacts(cwd: string): Promise<AloopAttemptRecord[]> {
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
			let commit = result.commit === null ? null : typeof result.commit === "string" && /^[0-9a-f]{7,64}$/i.test(result.commit) ? result.commit : undefined;
			if (commit === undefined || typeof result.status !== "string") continue;
			try {
				const patchPath = path.join(root, entry.name, "patch-attempts.json");
				const patchStatus = await lstat(patchPath);
				if (!patchStatus.isSymbolicLink() && patchStatus.isFile() && patchStatus.size <= 1_000_000) {
					const patches = JSON.parse(await readFile(patchPath, "utf8"));
					if (Array.isArray(patches)) {
						for (const patch of patches) if (typeof patch?.commit === "string" && /^[0-9a-f]{7,64}$/i.test(patch.commit)) commit = patch.commit;
					}
				}
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
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

async function invokeReviewAgents(pi: ExtensionAPI, ctx: ExtensionContext, params: any, signal?: AbortSignal, onUpdate?: (value: any) => void): Promise<any> {
	let reviewTool: any;
	const reviewApi = Object.create(pi) as ExtensionAPI;
	reviewApi.registerTool = (tool: any) => { if (tool.name === "review_agents") reviewTool = tool; };
	const reviewModule: any = await import("../review-agents/index.js");
	const extension = reviewModule.default?.default ?? reviewModule.default;
	extension(reviewApi);
	if (!reviewTool) throw new Error("Could not initialize independent review.");
	return await reviewTool.execute("aloop-review", params, signal, onUpdate, ctx);
}

export type AloopExtensionDependencies = {
	closeIssue: typeof closeCurrentRepositoryIssue;
	publishComment: typeof publishExactIssueComment;
	retrieveEpicContext: typeof retrieveCurrentRepositoryEpicContext;
	runWorker: typeof runAloopWorker;
	runPatchWorker: typeof runAloopPatchWorker;
	runReview: typeof invokeReviewAgents;
	diagnoseCommand: (ctx: ExtensionContext, params: { name: string; command: string[]; task: string }, result: Awaited<ReturnType<typeof runDurableCommand>>, excerpt: string, signal?: AbortSignal) => Promise<{ summary: string; modelRef?: string; error?: string }>;
};

const defaultDependencies: AloopExtensionDependencies = {
	closeIssue: closeCurrentRepositoryIssue,
	publishComment: publishExactIssueComment,
	retrieveEpicContext: retrieveCurrentRepositoryEpicContext,
	runWorker: runAloopWorker,
	runPatchWorker: runAloopPatchWorker,
	runReview: invokeReviewAgents,
	diagnoseCommand: async (...args) => (await import("../worker-runner/index.js")).diagnoseCommandResult(...args),
};

export function registerAloopExtension(pi: ExtensionAPI, overrides: Partial<AloopExtensionDependencies> = {}): void {
	const dependencies = { ...defaultDependencies, ...overrides };
	let activeEpic: number | null = null;
	let pendingHandoffs: PendingHandoff[] = [];
	const issueBaseCommits = new Map<number, string>();
	const attemptReviews = new Map<number, { base: string; head: string; available: boolean; details?: unknown; error?: string }>();
	let workerRunning = false;
	let runBudget: AloopRunBudget | null = null;
	let policySnapshot: AloopPolicySnapshot | null = null;
	let cachedContext: Awaited<ReturnType<typeof retrieveCurrentRepositoryEpicContext>> | null = null;
	const dryRunHandoffIds = new Set<string>();
	const dryRunClosureIds = new Set<string>();
	const issuedReceipts = new Map<string, { document: string; issue: number; commit: string; artifactDirectory: string }>();
	let deadlineTimer: ReturnType<typeof setTimeout> | null = null;

	function clearDeadlineTimer(): void {
		if (deadlineTimer) clearTimeout(deadlineTimer);
		deadlineTimer = null;
	}

	function deactivate(): void {
		clearDeadlineTimer();
		activeEpic = null;
		pendingHandoffs = [];
		issueBaseCommits.clear();
		attemptReviews.clear();
		workerRunning = false;
		runBudget = null;
		policySnapshot = null;
		cachedContext = null;
		dryRunHandoffIds.clear();
		dryRunClosureIds.clear();
		issuedReceipts.clear();
		pi.setActiveTools(pi.getActiveTools().filter((name) => !ALL_ALOOP_TOOLS.includes(name)));
	}

	function activate(epic: number, ctx: ExtensionContext, recovered: PendingHandoff[], maxMinutes: number, maxWorkerLaunches: number): AloopRunBudget {
		clearDeadlineTimer();
		activeEpic = epic;
		pendingHandoffs = recovered;
		issueBaseCommits.clear();
		runBudget = { deadlineMs: Date.now() + maxMinutes * 60_000, maxWorkerLaunches, workerLaunchesStarted: 0, settled: false };
		deadlineTimer = setTimeout(() => {
			if (!runBudget || runBudget.settled) return;
			pi.setActiveTools(pi.getActiveTools().filter((name) => name !== "aloop_launch_worker" && name !== "aloop_apply_patch"));
			if (ctx.hasUI) {
				ctx.ui.notify(`Aloop #${epic} reached its ${maxMinutes}-minute limit. Run /aloop again to resume.`, "warning");
				ctx.ui.setStatus(STATUS_KEY, `aloop: #${epic} time limit reached`);
			}
		}, maxMinutes * 60_000);
		deadlineTimer.unref?.();
		pi.setActiveTools([...new Set([...pi.getActiveTools(), ...TOOL_NAMES])]);
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, `aloop: #${epic} · ${maxMinutes}m · ${maxWorkerLaunches} worker launches`);
		return runBudget;
	}

	async function currentContext(cwd: string, signal?: AbortSignal, refresh = false) {
		if (activeEpic === null || !runBudget) throw new Error("Run /aloop #<epic> before using aloop supervisor tools.");
		if (!cachedContext || refresh) cachedContext = await dependencies.retrieveEpicContext(cwd, activeEpic, undefined, {
			commentLimit: MAX_COMMENT_LIMIT, commentBodyLimit: MAX_COMMENT_BODY, signal,
		});
		return cachedContext;
	}

	async function loadCommittedPolicy(cwd: string, signal?: AbortSignal): Promise<AloopPolicySnapshot> {
		const head = await pi.exec("git", ["rev-parse", "HEAD"], { cwd, timeout: 30_000, signal });
		if (head.code !== 0) throw new Error((head.stderr || "Could not resolve HEAD for the aloop policy snapshot.").trim());
		const startCommit = head.stdout.trim();
		const document = await pi.exec("git", ["show", `${startCommit}:.aloop.json`], { cwd, timeout: 30_000, signal });
		if (document.code !== 0) throw new Error((document.stderr || `Commit ${startCommit} does not contain .aloop.json.`).trim());
		if (Buffer.byteLength(document.stdout, "utf8") > 20_000) throw new Error("Committed .aloop.json is oversized.");
		return snapshotAloopPolicy(document.stdout, startCommit);
	}

	function activePolicy(): AloopPolicySnapshot {
		if (!policySnapshot) throw new Error("The active aloop invocation has no committed verification-policy snapshot.");
		return policySnapshot;
	}

	async function assertCleanHead(expectedHead: string, ctx: ExtensionContext, signal?: AbortSignal): Promise<void> {
		const [head, status] = await Promise.all([
			pi.exec("git", ["rev-parse", "HEAD"], { cwd: ctx.cwd, timeout: 30_000, signal }),
			pi.exec("git", ["status", "--porcelain=v1", "--untracked-files=all", "--", ".", ":(exclude).pi/tmp/aloop"], { cwd: ctx.cwd, timeout: 30_000, signal }),
		]);
		if (head.code !== 0 || head.stdout.trim() !== expectedHead || status.code !== 0 || status.stdout.trim()) {
			throw new Error(`Verification changed the expected clean HEAD ${expectedHead}; attempt remains unsettled.`);
		}
	}

	async function executeVerificationCommand(
		label: string,
		definition: AloopCommandDefinition,
		ctx: ExtensionContext,
		signal?: AbortSignal,
		onUpdate?: (value: any) => void,
	) {
		const timeoutMs = definition.timeoutMs;
		const root = path.resolve(ctx.cwd, ".pi/tmp/aloop/verification");
		await mkdir(root, { recursive: true, mode: 0o700 });
		let directory = "";
		for (let attempt = 0; attempt < 5; attempt += 1) {
			const id = `${Date.now()}-${label.replace(/[^a-z0-9-]+/gi, "-").toLowerCase()}-${randomBytes(6).toString("hex")}`;
			const candidate = path.join(root, id);
			try { await mkdir(candidate, { mode: 0o700 }); directory = candidate; break; } catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			}
		}
		if (!directory) throw new Error("Could not allocate a unique verification artifact directory.");
		const logPath = path.join(directory, "command.log");
		const resultPath = path.join(directory, "result.json");
		onUpdate?.({ content: [{ type: "text", text: `Running ${label}: ${definition.argv.join(" ")}` }], details: { argv: definition.argv, timeoutMs } });
		const result = await runDurableCommand({ cwd: ctx.cwd, command: definition.argv, logPath, resultPath, timeoutMs, signal });
		let diagnosis: Awaited<ReturnType<AloopExtensionDependencies["diagnoseCommand"]>> | undefined;
		if (result.code !== 0 || result.timedOut || result.cancelled || result.spawnError) {
			const log = await readFile(logPath, "utf8");
			diagnosis = await dependencies.diagnoseCommand(ctx, {
				name: label,
				command: definition.argv,
				task: "Diagnose the first actionable root cause while preserving the command result as authoritative.",
			}, result, balancedLogExcerpt(log, 80_000), signal);
			await writeDurableResult(resultPath, { ...result, diagnosis });
		}
		return { result, diagnosis, logPath: path.relative(ctx.cwd, logPath), resultPath: path.relative(ctx.cwd, resultPath) };
	}

	async function reusableReceipt(cwd: string, expected: string, sourceIdentity: string, pending: PendingHandoff, snapshot: AloopPolicySnapshot) {
		const directory = path.resolve(cwd, ".pi/tmp/aloop/receipts");
		let names: string[];
		try { names = (await readdir(directory)).filter((name) => /^verify-[0-9a-f]{12}-[0-9]+-[0-9a-f]{8}\.json$/.test(name)).sort().reverse(); }
		catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
		for (const name of names.slice(0, 200)) {
			try {
				const receiptPath = path.join(directory, name);
				const status = await lstat(receiptPath);
				if (!status.isFile() || status.isSymbolicLink() || status.size > 100_000) continue;
				const document = await readFile(receiptPath, "utf8");
				const receipt = JSON.parse(document);
				if (receipt.commit !== expected || receipt.sourceIdentity !== sourceIdentity || receipt.policySha256 !== snapshot.sha256
					|| receipt.issue !== pending.issue || receipt.artifactDirectory !== pending.artifactDirectory
					|| receipt.exitStatus !== 0 || receipt.canonicalTimedOut === true || receipt.canonicalCancelled === true || receipt.canonicalSpawnError
					|| receipt.postVerificationHead !== expected || receipt.postVerificationClean !== true
					|| (snapshot.policy.productionIntegration?.frequency === "issue" && (receipt.productionIntegrationExitStatus !== 0 || receipt.productionIntegrationTimedOut === true || receipt.productionIntegrationCancelled === true || receipt.productionIntegrationSpawnError))) continue;
				return { receiptId: name.slice(0, -5), receiptPath: path.relative(cwd, receiptPath), receipt, document };
			} catch { /* Malformed historical receipts are not reusable. */ }
		}
		return undefined;
	}

	pi.on("session_start", (_event, ctx) => {
		deactivate();
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
	});
	pi.on("session_shutdown", (_event, ctx) => {
		deactivate();
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
	});
	pi.on("agent_settled", (_event, ctx) => {
		if (!runBudget || runBudget.settled) return;
		runBudget.settled = true;
		clearDeadlineTimer();
		pi.setActiveTools(pi.getActiveTools().filter((name) => !ALL_ALOOP_TOOLS.includes(name)));
		if (ctx.hasUI && activeEpic !== null) ctx.ui.setStatus(STATUS_KEY, `aloop: #${activeEpic} settled · rerun to continue`);
	});

	function refreshPending(context: Awaited<ReturnType<typeof retrieveCurrentRepositoryEpicContext>>): void {
		pendingHandoffs = pendingHandoffs.filter((pending) => !handoffWasRecorded(context, pending));
	}

	async function decisionAttested(cwd: string, marker: string): Promise<boolean> {
		try {
			const record = JSON.parse(await readFile(path.resolve(cwd, ".pi/tmp/aloop/decisions", `${marker}.json`), "utf8"));
			return record?.version === 1 && record?.marker === marker && record?.approvedVia === "aloop-decision command" && typeof record?.decision === "string" && typeof record?.approvedAt === "string";
		} catch { return false; }
	}

	function recoveryAuthorized(issue: { recentHandoffs: Array<{ body: string }> }, attemptKey: string): boolean {
		return issue.recentHandoffs.some((comment) => comment.body.includes(`<!-- pi-aloop-recovery:${attemptKey}:authorized -->`));
	}

	function checkpointState(issue: { recentHandoffs: Array<{ body: string }> }): { open: string[]; resolved: string[] } {
		const open = issue.recentHandoffs.flatMap((comment) => comment.body.match(/pi-aloop-decision:([a-f0-9]{20}):open/)?.[1] ?? []);
		const resolved = issue.recentHandoffs.flatMap((comment) => comment.body.match(/pi-aloop-decision:([a-f0-9]{20}):resolved/)?.[1] ?? []);
		return { open, resolved };
	}

	function cachedFrontier(context: Awaited<ReturnType<typeof retrieveCurrentRepositoryEpicContext>>): number[] {
		return context.issues
			.filter((issue) => issue.number !== context.epic.number && issue.state === "open")
			.filter((issue) => !issue.children.some((child) => context.issues.find((candidate) => candidate.number === child)?.state === "open"))
			.filter((issue) => issue.blockers.every((blocker) => context.issues.find((candidate) => candidate.number === blocker.number)?.state === "closed"))
			.sort((left, right) => Number(!left.labels.includes("ready-for-agent")) - Number(!right.labels.includes("ready-for-agent")) || left.number - right.number)
			.map((issue) => issue.number);
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
			const startupPolicy = await loadCommittedPolicy(ctx.cwd, ctx.signal);
			const budget = activate(epic, ctx, [], request.maxMinutes, request.maxWorkerLaunches);
			policySnapshot = startupPolicy;
			let context;
			try {
				context = await dependencies.retrieveEpicContext(ctx.cwd, epic, undefined, {
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
			cachedContext = context;
			if (context.epic.state !== "open") {
				deactivate();
				ctx.ui.notify(`Epic #${epic} is not open.`, "warning");
				return;
			}
			if (ctx.hasUI) {
				const descendants = context.issues.filter((issue) => issue.number !== context.epic.number);
				const closed = descendants.filter((issue) => issue.state === "closed").length;
				ctx.ui.setStatus(STATUS_KEY, `aloop: #${epic} · children ${closed}/${descendants.length} · launches 0/${budget.maxWorkerLaunches}`);
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
				for (const record of branchRecords) {
					try {
						const snapshot = JSON.parse(await readFile(path.resolve(ctx.cwd, record.artifactDirectory, "issue-context.json"), "utf8"));
						if (Number.isInteger(snapshot?.selectedIssue?.number) && typeof snapshot.issueBaseCommit === "string" && !issueBaseCommits.has(snapshot.selectedIssue.number)) {
							issueBaseCommits.set(snapshot.selectedIssue.number, snapshot.issueBaseCommit);
						}
					} catch { /* Legacy attempts have no issue-context snapshot. */ }
				}
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

	pi.registerCommand("aloop-approve-epic", {
		description: "Human approval for the durably prepared epic HEAD: /aloop-approve-epic <commit>",
		handler: async (args, ctx) => {
			if (!activeEpic || !policySnapshot) throw new Error("No active aloop epic is awaiting approval.");
			const approvalPath = path.resolve(ctx.cwd, ".pi/tmp/aloop/epic-approval.json");
			const prepared = JSON.parse(await readFile(approvalPath, "utf8"));
			if (args.trim() !== prepared.head || prepared.epic !== activeEpic || prepared.policySha256 !== policySnapshot.sha256) throw new Error("Approval must name the exact durably prepared HEAD.");
			await writeDurableResult(approvalPath, { ...prepared, approved: true, approvedAt: new Date().toISOString(), approvedVia: "aloop-approve-epic command" });
			if (ctx.hasUI) ctx.ui.notify(`Approved epic #${activeEpic} at ${prepared.head}.`, "info");
		},
	});

	pi.registerCommand("aloop-decision", {
		description: "Record a human decision for a child: /aloop-decision <issue> <decision>",
		handler: async (args, ctx) => {
			const match = args.trim().match(/^#?(\d+)\s+(.+)$/s);
			if (!match) throw new Error("Usage: /aloop-decision <issue> <decision>");
			const issueNumber = Number(match[1]);
			const decision = match[2]!.trim();
			const context = await currentContext(ctx.cwd, ctx.signal);
			const issue = context.issues.find((candidate) => candidate.number === issueNumber);
			if (!issue) throw new Error("Decision issue is not in the active epic.");
			const state = checkpointState(issue);
			const openMarker = [...state.open].reverse().find((marker) => !state.resolved.includes(marker));
			if (!openMarker) throw new Error("No open aloop checkpoint exists for this issue.");
			const body = `Aloop human decision recorded: ${decision}\n\n<!-- pi-aloop-decision:${openMarker}:resolved -->`;
			await writeDurableResult(path.resolve(ctx.cwd, ".pi/tmp/aloop/decisions", `${openMarker}.json`), { version: 1, marker: openMarker, issue: issueNumber, decision, approvedAt: new Date().toISOString(), approvedVia: "aloop-decision command" });
			await dependencies.publishComment(ctx.cwd, issueNumber, body, false, { signal: ctx.signal });
			await dependencies.publishComment(ctx.cwd, issueNumber, body, true, { signal: ctx.signal });
			issue.recentHandoffs.push({ id: Date.now(), author: null, body, createdAt: new Date().toISOString(), url: null });
			if (ctx.hasUI) ctx.ui.notify(`Recorded decision for #${issueNumber}.`, "info");
		},
	});

	pi.registerCommand("aloop-authorize-recovery", {
		description: "Human authorization to close one accepted handoff lacking local provenance: /aloop-authorize-recovery <issue> <attempt-key>",
		handler: async (args, ctx) => {
			const match = args.trim().match(/^#?(\d+)\s+([a-f0-9]{24})$/);
			if (!match) throw new Error("Usage: /aloop-authorize-recovery <issue> <attempt-key>");
			const issue = Number(match[1]);
			const attemptKey = match[2]!;
			const context = await currentContext(ctx.cwd, ctx.signal);
			const child = context.issues.find((candidate) => candidate.number === issue);
			const accepted = child?.recentHandoffs.map((comment) => parseAloopHandoffV3(comment.body)).find((handoff) => handoff?.issue === issue && handoff.attemptKey === attemptKey && handoff.outcome === "accepted");
			if (!child || !accepted || child.state === "closed") throw new Error("No matching open accepted handoff requires recovery authorization.");
			const body = `Aloop human recovery authorization recorded for accepted attempt ${attemptKey}.\n\n<!-- pi-aloop-recovery:${attemptKey}:authorized -->`;
			await dependencies.publishComment(ctx.cwd, issue, body, false, { signal: ctx.signal });
			await dependencies.publishComment(ctx.cwd, issue, body, true, { signal: ctx.signal });
			child.recentHandoffs.push({ id: Date.now(), author: null, body, createdAt: new Date().toISOString(), url: null });
			if (ctx.hasUI) ctx.ui.notify(`Authorized closure recovery for #${issue} attempt ${attemptKey}.`, "info");
		},
	});

	pi.registerCommand("aloop-abort", {
		description: "Abort the active aloop invocation and preserve durable recovery state.",
		handler: async (_args, ctx) => {
			ctx.abort();
			deactivate();
			pi.appendEntry("aloop-abort", { timestamp: new Date().toISOString(), reason: "explicit command" });
			if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, "aloop: aborted; recovery state preserved");
		},
	});

	pi.registerTool({
		name: "aloop_abort",
		label: "Aloop Abort",
		description: "Immediately abort active work and prevent further aloop effects while preserving recovery artifacts.",
		promptSnippet: "Abort the aloop invocation when explicitly requested.",
		parameters: Type.Object({ reason: Type.String({ minLength: 1 }) }),
		async execute(_id, params: { reason: string }, _signal, _onUpdate, ctx) {
			pi.appendEntry("aloop-abort", { timestamp: new Date().toISOString(), reason: params.reason });
			ctx.abort();
			deactivate();
			return { content: [{ type: "text", text: `Aloop aborted: ${params.reason}. Durable attempt state was preserved.` }], details: { aborted: true }, terminate: true };
		},
	});

	pi.registerTool({
		name: "aloop_context",
		label: "Aloop Context",
		description: "Return the active cached epic graph, pending attempt state, budget, and next frontier; optionally refresh GitHub once explicitly.",
		promptSnippet: "Use aloop_context for supervisor navigation and explicit refresh.",
		parameters: Type.Object({ refresh: Type.Optional(Type.Boolean()) }),
		async execute(_id, params: { refresh?: boolean }, signal, _onUpdate, ctx) {
			const context = await currentContext(ctx.cwd, signal, params.refresh === true);
			refreshPending(context);
			const acceptedOpen = acceptedOpenAloopIssues(context);
			const closureRecoveries = acceptedOpen;
			const unverifiedAccepted: number[] = [];
			const frontier = cachedFrontier(context).filter((number) => !acceptedOpen.includes(number));
			const details = { epic: context.epic, issues: context.issues, frontier, closureRecoveries, unverifiedAccepted, pendingAttempts: pendingHandoffs, budget: runBudget };
			return { content: [{ type: "text", text: `Epic #${context.epic.number}; frontier ${frontier.map((number) => `#${number}`).join(", ") || "none"}; accepted awaiting closure ${closureRecoveries.map((number) => `#${number}`).join(", ") || "none"}; accepted requiring human recovery ${unverifiedAccepted.map((number) => `#${number}`).join(", ") || "none"}; pending ${pendingHandoffs.map((item) => `#${item.issue}`).join(", ") || "none"}.` }], details };
		},
	});

	pi.registerTool({
		name: "aloop_launch_worker",
		label: "Aloop Launch Worker",
		description: "Launch one fresh sequential implementation or remediation worker for an executable epic leaf.",
		promptSnippet: "Launch one fresh aloop implementation worker and return bounded artifact-backed attempt evidence.",
		promptGuidelines: [
			"Use aloop_launch_worker only for one executable descendant leaf at a time after /aloop activation.",
			"After every aloop_launch_worker result, call aloop_review_attempt, remediate as needed, then settle it through aloop_finish_attempt before launching another worker.",
		],
		parameters: LaunchWorkerParams,
		async execute(_id, params: { issue: number; attempt_type?: "implementation" | "remediation"; timeout_ms?: number }, signal, onUpdate, ctx) {
			if (workerRunning) throw new Error("An aloop worker is already running; workers must remain sequential.");
			workerRunning = true;
			try {
				const attemptType = params.attempt_type ?? "implementation";
				if (!runBudget) throw new Error("Run /aloop #<epic> before launching a worker.");
				const budgetAssessment = assessAloopRunBudget(runBudget, Date.now());
				if (!budgetAssessment.allowed) throw new Error(budgetAssessment.reason);
				let context = await currentContext(ctx.cwd, signal);
				refreshPending(context);
				const acceptedOpen = acceptedOpenAloopIssues(context);
				if (acceptedOpen.length > 0) {
					throw new Error(`Accepted handoffs await child closure for ${acceptedOpen.map((number) => `#${number}`).join(", ")}. Recover them with aloop_finish_attempt before launching another worker.`);
				}
				if (pendingHandoffs.length > 0) {
					throw new Error(`Outstanding attempts have no durable structured handoff comments: ${pendingHandoffs.map((pending) => `#${pending.issue} (${pending.artifactDirectory})`).join(", ")}. Record them before another worker.`);
				}
				const issue = selectAloopLeaf(context, params.issue);
				const handoffs = parseAloopHandoffs(issue.recentHandoffs).filter((handoff) => handoff.issue === issue.number);
				const epic = context.issues.find((candidate) => candidate.number === context.epic.number)!;
				const launchBudget = assessAloopRunBudget(runBudget, Date.now());
				if (!launchBudget.allowed) throw new Error(launchBudget.reason);
				runBudget.workerLaunchesStarted += 1;
				attemptReviews.delete(issue.number);
				const workerLaunchNumber = runBudget.workerLaunchesStarted;
				const retryNumber = nextIssueRetryNumber(handoffs, attemptType);
				const descendants = context.issues.filter((candidate) => candidate.number !== context.epic.number);
				const closedDescendants = descendants.filter((candidate) => candidate.state === "closed").length;
				const startedAt = Date.now();
				if (!issueBaseCommits.has(issue.number)) {
					const base = await pi.exec("git", ["rev-parse", "HEAD"], { cwd: ctx.cwd, timeout: 30_000, signal });
					if (base.code !== 0) throw new Error((base.stderr || "Could not resolve issue base commit.").trim());
					issueBaseCommits.set(issue.number, base.stdout.trim());
				}
				const workerTimeoutMs = Math.min(params.timeout_ms ?? 30 * 60_000, launchBudget.remainingMs);
				const finalLaunchNotice = workerLaunchNumber === runBudget.maxWorkerLaunches ? " This is the final permitted worker launch for this invocation." : "";
				const issueRunLabel = attemptType === "remediation" ? `remediation retry ${retryNumber}` : "initial implementation";
				if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, `aloop: #${epic.number} · children ${closedDescendants}/${descendants.length} · launches ${workerLaunchNumber}/${runBudget.maxWorkerLaunches} · ${issueRunLabel}`);
				const progress = () => onUpdate?.({
					content: [{ type: "text", text: `Aloop worker launch ${workerLaunchNumber}/${runBudget!.maxWorkerLaunches} for #${issue.number} (${issueRunLabel}); epic children ${closedDescendants}/${descendants.length} closed (${Math.floor((Date.now() - startedAt) / 1_000)}s elapsed; ${Math.ceil((runBudget!.deadlineMs - Date.now()) / 60_000)}m remaining; hard timeout ${Math.ceil(workerTimeoutMs / 60_000)}m).${finalLaunchNotice}` }],
					details: { issue: issue.number, attemptType: params.attempt_type, retryNumber, workerLaunchNumber, maxWorkerLaunches: runBudget!.maxWorkerLaunches, finalPermittedWorkerLaunch: workerLaunchNumber === runBudget!.maxWorkerLaunches, closedDescendants, totalDescendants: descendants.length, elapsedMs: Date.now() - startedAt, remainingMs: Math.max(0, runBudget!.deadlineMs - Date.now()), timeoutMs: workerTimeoutMs },
				});
				progress();
				const heartbeat = setInterval(progress, 15_000);
				heartbeat.unref?.();
				let outcome: Awaited<ReturnType<typeof runAloopWorker>>;
				try {
					const policy = activePolicy().policy;
					outcome = await dependencies.runWorker({
						cwd: ctx.cwd,
						attemptType,
						supervisorApproach: "Derive the issue and implement it within the selected child boundary.",
						epic: { number: epic.number, title: epic.title, body: epic.body },
						issue: { number: issue.number, title: issue.title, body: issue.body },
						priorHandoffs: handoffs,
						projectWorkerResources: policy.workerResources,
						workerFeedbackCommand: policy.workerFeedbackCommand,
						issueContext: context,
						issueBaseCommit: issueBaseCommits.get(issue.number),
						modelRef: activeModelRef(ctx),
						timeoutMs: workerTimeoutMs,
						deadlineMs: runBudget.deadlineMs,
						signal,
					});
				} finally {
					clearInterval(heartbeat);
				}
				pendingHandoffs.push({ issue: issue.number, commit: outcome.commit, artifactDirectory: outcome.artifacts.directory });
				if (outcome.modelUsage?.length) pi.appendEntry("aloop-model-usage", { issue: issue.number, kind: "full-worker", usage: outcome.modelUsage });
				const text = [
					`Attempt status: ${outcome.status}`,
					`Issue: #${issue.number}`,
					`Commit: ${outcome.commit ?? "none"}`,
					`Summary: ${outcome.summary}`,
					`Artifacts: ${outcome.artifacts.directory}`,
					`Structured result: ${outcome.artifacts.result}`,
					"Next required action: call aloop_review_attempt, remediate findings as needed, then call aloop_finish_attempt.",
				].join("\n");
				return { content: [{ type: "text", text }], details: outcome };
			} finally {
				workerRunning = false;
			}
		},
	});

	pi.registerTool({
		name: "aloop_review_attempt",
		label: "Aloop Review Attempt",
		description: "Run fresh Standards and Spec reviewers against the cumulative selected-issue state.",
		promptSnippet: "Review the cumulative issue state independently before finalization.",
		parameters: Type.Object({ issue: Type.Number({ minimum: 1 }) }),
		async execute(_id, params: { issue: number }, signal, onUpdate, ctx) {
			const pending = pendingHandoffs.find((candidate) => candidate.issue === params.issue);
			if (!pending) throw new Error("Aloop review requires an unsettled full attempt.");
			const context = await currentContext(ctx.cwd, signal);
			const issue = context.issues.find((candidate) => candidate.number === params.issue);
			if (!issue) throw new Error("Issue is not in the active epic.");
			const headResult = await pi.exec("git", ["rev-parse", "HEAD"], { cwd: ctx.cwd, timeout: 30_000, signal });
			if (headResult.code !== 0) throw new Error((headResult.stderr || "Could not resolve HEAD.").trim());
			const head = headResult.stdout.trim();
			const base = issueBaseCommits.get(params.issue) ?? head;
			try {
				const mode = base === head ? "audit" : "diff";
				const result = await dependencies.runReview(pi, ctx, {
					mode, ...(mode === "diff" ? { fixed_point: base } : {}),
					tasks: [
						{ axis: "standards", instructions: `Review cumulative work for issue #${issue.number} against repository standards. Report concrete defects only.` },
						{ axis: "spec", instructions: `Review cumulative work for issue #${issue.number}: ${issue.title}.\n\nEpic context:\n${(context.issues.find((candidate) => candidate.number === context.epic.number)?.body ?? "").slice(0, 12_000)}\n\nSelected issue specification and acceptance criteria:\n${issue.body.slice(0, 16_000)}\n\nReport unmet criteria only.` },
					],
				}, signal, onUpdate);
				attemptReviews.set(params.issue, { base, head, available: true, details: result.details });
				return result;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				attemptReviews.set(params.issue, { base, head, available: false, error: message });
				return { content: [{ type: "text", text: `Independent review unavailable: ${message}. A human checkpoint is required before automatic closure.` }], details: { available: false, base, head, error: message } };
			}
		},
	});

	pi.registerTool({
		name: "aloop_apply_patch",
		label: "Aloop Apply Patch",
		description: "Launch one sequential targeted patch worker for an unsettled full attempt without consuming full-worker counters.",
		promptSnippet: "Use a targeted patch worker for one narrow correction during supervisor settlement.",
		promptGuidelines: ["Use only for a narrow correction to an existing unsettled full attempt. It cannot replace a full worker after the implementation budget expires."],
		parameters: ApplyPatchParams,
		async execute(_id, params: { issue: number; correction: string; timeout_ms?: number }, signal, _onUpdate, ctx) {
			if (workerRunning) throw new Error("An aloop worker is already running; patch workers must remain sequential.");
			if (!runBudget || activeEpic === null) throw new Error("Run /aloop #<epic> before launching a patch worker.");
			if (Date.now() >= runBudget.deadlineMs) throw new Error("Targeted patches cannot start after the implementation budget expires.");
			const pending = pendingHandoffs.find((candidate) => candidate.issue === params.issue);
			if (!pending) throw new Error("Targeted patches require an unsettled full attempt for the same issue.");
			workerRunning = true;
			try {
				const context = await currentContext(ctx.cwd, signal);
				const epic = context.issues.find((candidate) => candidate.number === activeEpic);
				const issue = context.issues.find((candidate) => candidate.number === params.issue);
				if (!epic || !issue) throw new Error("The patch issue is not in the active epic snapshot.");
				const policy = activePolicy().policy;
				const modelRef = selectAloopPatchModel({
					configured: policy.patchWorkerModel,
					active: activeModelRef(ctx),
					available: (reference) => registeredModel(ctx, reference),
				});
				if (Date.now() >= runBudget.deadlineMs) throw new Error("Targeted patch preflight crossed the implementation deadline; no patch process was started.");
				const outcome = await dependencies.runPatchWorker({
					cwd: ctx.cwd, epic: { number: epic.number, title: epic.title, body: epic.body },
					issue: { number: issue.number, title: issue.title, body: issue.body }, correction: params.correction,
					issueContext: context, issueBaseCommit: issueBaseCommits.get(issue.number), projectWorkerResources: policy.workerResources,
					modelRef, timeoutMs: params.timeout_ms ?? 30 * 60_000, spawnDeadlineMs: runBudget.deadlineMs, signal,
				});
				pending.patchArtifacts = [...(pending.patchArtifacts ?? []), { commit: outcome.commit, artifactDirectory: outcome.artifacts.directory, status: outcome.status }];
				if (outcome.commit) pending.commit = outcome.commit;
				const patchRecordPath = path.resolve(ctx.cwd, pending.artifactDirectory, "patch-attempts.json");
				const artifactRoot = path.resolve(ctx.cwd, ".pi/tmp/aloop");
				if (!patchRecordPath.startsWith(`${artifactRoot}${path.sep}`)) throw new Error("Pending attempt artifact path escapes .pi/tmp/aloop.");
				await writeFile(patchRecordPath, `${JSON.stringify(pending.patchArtifacts, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
				if (outcome.modelUsage?.length) pi.appendEntry("aloop-model-usage", { issue: issue.number, kind: "patch-worker", usage: outcome.modelUsage });
				return {
					content: [{ type: "text", text: `Patch status: ${outcome.status}\nIssue: #${issue.number}\nCommit: ${outcome.commit ?? "none"}\nSummary: ${outcome.summary}\nArtifacts: ${outcome.artifacts.directory}` }],
					details: { ...outcome, fullWorkerLaunchesStarted: runBudget.workerLaunchesStarted },
				};
			} finally { workerRunning = false; }
		},
	});

	pi.registerTool({
		name: "aloop_finish_attempt",
		label: "Aloop Finish Attempt",
		description: "Settle one full attempt: verify accepted work, publish one v3 handoff, close accepted children, and return the next frontier.",
		promptSnippet: "Finalize the reviewed attempt with hidden idempotent verification/publication/closure plumbing.",
		parameters: Type.Object({
			issue: Type.Number({ minimum: 1 }),
			outcome: Type.Union([Type.Literal("accepted"), Type.Literal("incomplete"), Type.Literal("decision-required"), Type.Literal("environment-blocked"), Type.Literal("rejected")]),
			summary: Type.String({ minLength: 1 }),
			outstanding_findings: Type.Array(Type.String()),
			decisions: Type.Array(Type.String()),
			verification: Type.Array(Type.String()),
			next_action: Type.String({ minLength: 1 }),
		}),
		async execute(_id, params: { issue: number; outcome: "accepted" | "incomplete" | "decision-required" | "environment-blocked" | "rejected"; summary: string; outstanding_findings: string[]; decisions: string[]; verification: string[]; next_action: string }, signal, onUpdate, ctx) {
			const context = await currentContext(ctx.cwd, signal);
			const issue = context.issues.find((candidate) => candidate.number === params.issue);
			if (!issue) throw new Error("Issue is not in the active epic.");
			const pending = pendingHandoffs.find((candidate) => candidate.issue === params.issue);
			if (!pending) {
				const settled = issue.recentHandoffs.map((comment) => parseAloopHandoffV3(comment.body)).filter((value) => value?.issue === params.issue).at(-1);
				if (settled) {
					if (settled.outcome === "accepted" && issue.state !== "closed") {
						const settledComment = [...issue.recentHandoffs].reverse().find((comment) => parseAloopHandoffV3(comment.body)?.attemptKey === settled.attemptKey);
						if (!settledComment && !recoveryAuthorized(issue, settled.attemptKey)) {
							throw new Error(`Accepted handoff lacks durable GitHub evidence; human authorization is required: /aloop-authorize-recovery ${params.issue} ${settled.attemptKey}`);
						}
						const expectedHead = settled.commitRange.split("..").at(-1);
						const [head, status] = await Promise.all([
							pi.exec("git", ["rev-parse", "HEAD"], { cwd: ctx.cwd, timeout: 30_000, signal }),
							pi.exec("git", ["status", "--porcelain=v1", "--untracked-files=all", "--", ".", ":(exclude).pi/tmp/aloop"], { cwd: ctx.cwd, timeout: 30_000, signal }),
						]);
						if (head.code !== 0 || head.stdout.trim() !== expectedHead || status.code !== 0 || status.stdout.trim()) throw new Error("Published accepted handoff no longer matches the clean current HEAD.");
						await dependencies.closeIssue(ctx.cwd, params.issue, { signal });
						issue.state = "closed";
					}
					return { content: [{ type: "text", text: `Attempt #${params.issue} was already settled as ${settled.outcome}.` }], details: { settled: true, closed: settled.outcome === "accepted", idempotent: true, handoff: settled, frontier: cachedFrontier(context) } };
				}
				throw new Error("No unsettled full attempt exists for this issue.");
			}
			const headResult = await pi.exec("git", ["rev-parse", "HEAD"], { cwd: ctx.cwd, timeout: 30_000, signal });
			const statusResult = await pi.exec("git", ["status", "--porcelain=v1", "--untracked-files=all", "--", ".", ":(exclude).pi/tmp/aloop"], { cwd: ctx.cwd, timeout: 30_000, signal });
			if (headResult.code !== 0 || statusResult.code !== 0) throw new Error("Could not inspect final attempt state.");
			const head = headResult.stdout.trim();
			const base = issueBaseCommits.get(params.issue) ?? head;
			const review = attemptReviews.get(params.issue);
			const verification = [...params.verification];
			const checkpoints = checkpointState(issue);
			const attestedResolutions = new Set<string>();
			for (const marker of checkpoints.open) if (checkpoints.resolved.includes(marker) && await decisionAttested(ctx.cwd, marker)) attestedResolutions.add(marker);
			const hasResolvedCheckpoint = checkpoints.open.some((marker) => attestedResolutions.has(marker));
			if (checkpoints.open.some((marker) => !attestedResolutions.has(marker))) throw new Error("Attempt finalization is blocked by an unresolved or unattested human checkpoint.");
			if (params.outcome === "accepted") {
				if (statusResult.stdout.trim()) throw new Error("Accepted finalization requires a clean worktree.");
				if ((!review || review.head !== head || !review.available) && !hasResolvedCheckpoint) throw new Error("Accepted finalization requires fresh independent review at the current HEAD; unavailable review requires a resolved human checkpoint.");
				const policy = activePolicy().policy;
				const canonical = await executeVerificationCommand("canonical", policy.canonicalCommand, ctx, signal, onUpdate);
				if (canonical.result.code !== 0 || canonical.result.timedOut || canonical.result.cancelled || canonical.result.spawnError) {
					return { content: [{ type: "text", text: `Canonical verification failed. Attempt remains unsettled. ${canonical.diagnosis}` }], details: { settled: false, canonical } };
				}
				await assertCleanHead(head, ctx, signal);
				verification.push(`Canonical command passed at ${head}.`);
				if (policy.productionIntegration?.frequency === "issue") {
					const production = await executeVerificationCommand("production-integration", policy.productionIntegration.command, ctx, signal, onUpdate);
					if (production.result.code !== 0 || production.result.timedOut || production.result.cancelled || production.result.spawnError) {
						return { content: [{ type: "text", text: `Production integration failed. Attempt remains unsettled. ${production.diagnosis}` }], details: { settled: false, canonical, production } };
					}
					await assertCleanHead(head, ctx, signal);
					verification.push(`Production integration passed at ${head}.`);
				}
			}
			const attemptKey = createHash("sha256").update(`${params.issue}:${pending.artifactDirectory}`).digest("hex").slice(0, 24);
			const publishedComment = [...issue.recentHandoffs].reverse().find((comment) => parseAloopHandoffV3(comment.body)?.attemptKey === attemptKey);
			const publishedHandoff = publishedComment && parseAloopHandoffV3(publishedComment.body);
			if (publishedHandoff && (publishedHandoff.issue !== params.issue || publishedHandoff.commitRange !== `${base}..${head}` || publishedHandoff.outcome !== params.outcome)) {
				throw new Error("Published handoff attempt key conflicts with the current finalization state.");
			}
			const handoff = publishedHandoff ?? { version: 3 as const, issue: params.issue, issueBaseCommit: base, commitRange: `${base}..${head}`, outcome: params.outcome, summary: params.summary, outstandingFindings: params.outstanding_findings, decisions: params.decisions, verification, nextAction: params.next_action, attemptKey, timestamp: new Date().toISOString() };
			const body = publishedComment?.body ?? formatAloopHandoffV3(handoff);
			if (!publishedComment) {
				await dependencies.publishComment(ctx.cwd, params.issue, body, false, { signal });
				try {
					await dependencies.publishComment(ctx.cwd, params.issue, body, true, { signal });
					issue.recentHandoffs.push({ id: Date.now(), author: null, body, createdAt: handoff.timestamp, url: null });
				} catch (error) {
					const refreshed = await currentContext(ctx.cwd, signal, true);
					const refreshedIssue = refreshed.issues.find((candidate) => candidate.number === params.issue);
					if (!refreshedIssue?.recentHandoffs.some((comment) => parseAloopHandoffV3(comment.body)?.attemptKey === attemptKey)) throw error;
				}
			}
			pendingHandoffs = pendingHandoffs.filter((candidate) => candidate !== pending);
			if (params.outcome === "accepted" && issue.state !== "closed") {
				await dependencies.closeIssue(ctx.cwd, params.issue, { signal });
				issue.state = "closed";
				const cachedIssue = cachedContext?.issues.find((candidate) => candidate.number === params.issue);
				if (cachedIssue) cachedIssue.state = "closed";
			}
			const frontier = cachedFrontier(context);
			return { content: [{ type: "text", text: `Attempt #${params.issue} settled as ${params.outcome}.${params.outcome === "accepted" ? " Child closed." : ""} Next frontier: ${frontier.map((number) => `#${number}`).join(", ") || "none"}.` }], details: { settled: true, closed: params.outcome === "accepted", handoff, frontier } };
		},
	});

	pi.registerTool({
		name: "aloop_checkpoint",
		label: "Aloop Checkpoint",
		description: "Create or resolve a transport-neutral human decision boundary and record it on the child issue.",
		promptSnippet: "Stop for a durable human decision when supervisor judgment cannot proceed safely.",
		parameters: Type.Object({
			issue: Type.Number({ minimum: 1 }), decision: Type.String({ minLength: 1 }), options: Type.Array(Type.String()),
		}),
		async execute(_id, params: { issue: number; decision: string; options: string[] }, signal, _onUpdate, ctx) {
			const context = await currentContext(ctx.cwd, signal);
			const issue = context.issues.find((candidate) => candidate.number === params.issue);
			if (!issue) throw new Error("Checkpoint issue is not in the active epic.");
			const marker = createHash("sha256").update(`${params.issue}:${params.decision}`).digest("hex").slice(0, 20);
			const body = `Aloop needs a human decision: ${params.decision}\n\n${params.options.map((option) => `- ${option}`).join("\n")}\n\nReply with \`/aloop-decision ${params.issue} <decision>\`.\n\n<!-- pi-aloop-decision:${marker}:open -->`;
			if (!issue.recentHandoffs.some((comment) => comment.body.includes(`pi-aloop-decision:${marker}:open`))) {
				await dependencies.publishComment(ctx.cwd, params.issue, body, false, { signal });
				await dependencies.publishComment(ctx.cwd, params.issue, body, true, { signal });
				issue.recentHandoffs.push({ id: Date.now(), author: null, body, createdAt: new Date().toISOString(), url: null });
			}
			return { content: [{ type: "text", text: `Human decision required for #${params.issue}: ${params.decision}. Reply with /aloop-decision ${params.issue} <decision>.` }], details: { checkpoint: true, resolved: false, marker }, terminate: true };
		},
	});

	pi.registerTool({
		name: "aloop_epic_completion",
		label: "Aloop Epic Completion",
		description: "Verify and prepare complete epic evidence for human approval, then close the parent only after explicit approval.",
		promptSnippet: "Use two-phase epic completion; preparation requires final review and acceptance evidence and is a mandatory human approval boundary.",
		parameters: EpicCompletionParams,
		async execute(_id, params: { phase: "prepare" | "apply"; acceptance_criteria?: ClosureEvidence["acceptanceCriteria"] }, signal, onUpdate, ctx) {
			const context = await currentContext(ctx.cwd, signal, true);
			const open = context.issues.filter((issue) => issue.number !== context.epic.number && issue.state === "open");
			let unresolvedDecisions = 0;
			for (const child of context.issues.filter((issue) => issue.number !== context.epic.number)) {
				const state = checkpointState(child);
				for (const marker of state.open) if (!state.resolved.includes(marker) || !(await decisionAttested(ctx.cwd, marker))) unresolvedDecisions += 1;
			}
			if (open.length || pendingHandoffs.length || unresolvedDecisions) throw new Error(`Epic completion is blocked by ${open.length} open descendants, ${pendingHandoffs.length} unsettled attempts, and ${unresolvedDecisions} unresolved decisions.`);
			const headResult = await pi.exec("git", ["rev-parse", "HEAD"], { cwd: ctx.cwd, timeout: 30_000, signal });
			if (headResult.code !== 0) throw new Error("Could not resolve epic HEAD.");
			const head = headResult.stdout.trim();
			const approvalPath = path.resolve(ctx.cwd, ".pi/tmp/aloop/epic-approval.json");
			if (params.phase === "prepare") {
				if (!params.acceptance_criteria) throw new Error("Epic preparation requires acceptance_criteria evidence.");
				const snapshot = activePolicy();
				const policy = snapshot.policy;
				await assertCleanHead(head, ctx, signal);
				const canonical = await executeVerificationCommand("epic-canonical", policy.canonicalCommand, ctx, signal, onUpdate);
				if (canonical.result.code !== 0 || canonical.result.timedOut || canonical.result.cancelled || canonical.result.spawnError) {
					return { content: [{ type: "text", text: `Epic canonical verification failed: ${canonical.diagnosis?.summary ?? "see retained diagnostic logs"}` }], details: { ready: false, canonical } };
				}
				await assertCleanHead(head, ctx, signal);
				const verification: ClosureEvidence["verification"] = [{ check: "canonical", passed: true, evidence: `Canonical command passed at ${head}.` }];
				if (policy.productionIntegration?.frequency === "epic") {
					const production = await executeVerificationCommand("epic-production-integration", policy.productionIntegration.command, ctx, signal, onUpdate);
					if (production.result.code !== 0 || production.result.timedOut || production.result.cancelled || production.result.spawnError) return { content: [{ type: "text", text: `Epic production integration failed: ${production.diagnosis?.summary ?? "see retained diagnostic logs"}` }], details: { ready: false, canonical, production } };
					await assertCleanHead(head, ctx, signal);
					verification.push({ check: "production integration", passed: true, evidence: `Epic production integration passed at ${head}.` });
				}
				const evidence: ClosureEvidence = {
					verification,
					acceptanceCriteria: params.acceptance_criteria,
					descendantReviews: context.issues
						.filter((issue) => issue.number !== context.epic.number)
						.map((issue) => {
							const durableHandoff = [...issue.recentHandoffs].reverse().find((comment) => /pi-aloop-handoff:/.test(comment.body));
							return { issue: issue.number, reviewed: issue.state === "closed" && durableHandoff !== undefined, evidence: durableHandoff ? `Closed with durable supervised handoff ${durableHandoff.url ?? "recorded on GitHub"}.` : "No durable supervised handoff found." };
						}),
				};
				const gate = evaluateEpicClosure(context, evidence);
				if (!gate.allowed) return { content: [{ type: "text", text: `Epic evidence is incomplete: ${gate.reasons.join(" ")}` }], details: { ready: false, gate, evidence } };
				await writeDurableResult(approvalPath, { version: 2, epic: context.epic.number, head, policySha256: snapshot.sha256, evidence, preparedAt: new Date().toISOString() });
				return { content: [{ type: "text", text: `Epic #${context.epic.number} passed final verification at ${head}; all ${evidence.descendantReviews.length} descendants have durable supervised handoffs and ${evidence.acceptanceCriteria.length} epic criteria have evidence. Human approval is required: /aloop-approve-epic ${head}` }], details: { ready: true, epic: context.epic.number, head, evidence }, terminate: true };
			}
			let durableApproval: any = null;
			try { durableApproval = JSON.parse(await readFile(approvalPath, "utf8")); } catch { /* Missing preparation is rejected below. */ }
			if (durableApproval?.version !== 2 || durableApproval?.approved !== true || durableApproval?.approvedVia !== "aloop-approve-epic command" || typeof durableApproval?.approvedAt !== "string" || durableApproval?.head !== head || durableApproval?.epic !== context.epic.number || durableApproval?.policySha256 !== activePolicy().sha256) {
				throw new Error("Epic apply requires the human /aloop-approve-epic command for the unchanged durably prepared HEAD.");
			}
			const gate = evaluateEpicClosure(context, durableApproval.evidence as ClosureEvidence);
			if (!gate.allowed) throw new Error(`Prepared epic evidence is no longer sufficient: ${gate.reasons.join(" ")}`);
			await assertCleanHead(head, ctx, signal);
			await dependencies.closeIssue(ctx.cwd, context.epic.number, { signal });
			context.epic.state = "closed";
			try { await unlink(approvalPath); } catch { /* Closure is already durable remotely. */ }
			return { content: [{ type: "text", text: `Closed epic #${context.epic.number} after explicit approval of the final evidence.` }], details: { closed: true, epic: context.epic.number, head } };
		},
	});

	pi.registerTool({
		name: "aloop_supervisor_verify",
		label: "Aloop Supervisor Verify",
		description: "Independently run a repository-defined check against an exact committed, clean source tree and persist a commit-bound receipt.",
		promptSnippet: "Verify the returned worker commit independently before accepting its handoff.",
		promptGuidelines: ["Pass only the worker commit. The tool loads and executes the repository-owned .aloop.json policy. Any untracked or modified source blocks verification; any later change invalidates the receipt."],
		parameters: SupervisorVerifyParams,
		async execute(_id, params: { commit: string }, signal, onUpdate, ctx) {
			if (!runBudget) throw new Error("Run /aloop #<epic> before supervisor verification.");
			const inspect = async (args: string[]) => {
				const remaining = assessAloopRunBudget(runBudget!, Date.now());
				if (!remaining.allowed) throw new Error(remaining.reason);
				const result = await pi.exec("git", args, { timeout: Math.max(1, Math.min(30_000, remaining.remainingMs)), signal });
				if (result.code !== 0) throw new Error((result.stderr || result.stdout || `git ${args[0]} failed`).trim());
				return result.stdout.trim();
			};
			const snapshot = activePolicy();
			const policy = snapshot.policy;
			const expected = await inspect(["rev-parse", `${params.commit}^{commit}`]);
			const pendingAttempt = pendingHandoffs.find((pending) => pending.commit === expected);
			if (!pendingAttempt) throw new Error(`Supervisor verification requires a pending worker attempt at ${expected}; launch and commit the worker attempt first.`);
			const beforeHead = await inspect(["rev-parse", "HEAD"]);
			const beforeStatus = await inspect(["status", "--porcelain=v1", "--untracked-files=all"]);
			if (beforeHead !== expected) throw new Error(`Returned commit ${expected} differs from current HEAD ${beforeHead}.`);
			if (beforeStatus) throw new Error("Supervisor verification requires a clean worktree, including no untracked files. Commit intended sources before verification.");
			const sourceIdentity = `tree:${await inspect(["rev-parse", `${expected}^{tree}`])}`;
			const reusable = await reusableReceipt(ctx.cwd, expected, sourceIdentity, pendingAttempt, snapshot);
			if (reusable) {
				issuedReceipts.set(reusable.receiptId, { document: reusable.document, issue: pendingAttempt.issue, commit: expected, artifactDirectory: pendingAttempt.artifactDirectory });
				return { content: [{ type: "text", text: `Reused valid supervisor verification receipt ${reusable.receiptPath} at ${expected}.` }], details: { valid: true, reused: true, ...reusable } };
			}
			const canonical = await executeVerificationCommand("canonical verification", policy.canonicalCommand, ctx, signal, onUpdate);
			const canonicalPassed = canonical.result.code === 0 && !canonical.result.timedOut && !canonical.result.cancelled && !canonical.result.spawnError;
			const issueProduction = policy.productionIntegration?.frequency === "issue" && canonicalPassed
				? await executeVerificationCommand("issue production integration", policy.productionIntegration.command, ctx, signal, onUpdate)
				: undefined;
			const afterHead = await inspect(["rev-parse", "HEAD"]);
			const afterStatus = await inspect(["status", "--porcelain=v1", "--untracked-files=all"]);
			const receipt = {
				version: 2,
				issue: pendingAttempt.issue,
				artifactDirectory: pendingAttempt.artifactDirectory,
				commit: expected,
				command: policy.canonicalCommand.argv,
				exitStatus: canonical.result.code,
				timestamp: new Date().toISOString(),
				sourceIdentity,
				policySha256: snapshot.sha256,
				policyStartCommit: snapshot.startCommit,
				canonicalLog: canonical.logPath,
				canonicalResult: canonical.resultPath,
				canonicalTimedOut: canonical.result.timedOut,
				canonicalCancelled: canonical.result.cancelled,
				canonicalSpawnError: canonical.result.spawnError,
				productionIntegration: issueProduction ? policy.productionIntegration!.command.argv : undefined,
				productionIntegrationExitStatus: issueProduction?.result.code,
				productionIntegrationLog: issueProduction?.logPath,
				productionIntegrationTimedOut: issueProduction?.result.timedOut,
				productionIntegrationCancelled: issueProduction?.result.cancelled,
				productionIntegrationSpawnError: issueProduction?.result.spawnError,
				postVerificationHead: afterHead,
				postVerificationClean: afterStatus === "",
			};
			const receiptId = `verify-${expected.slice(0, 12)}-${Date.now()}-${randomBytes(4).toString("hex")}`;
			const receiptDirectory = path.resolve(ctx.cwd, ".pi/tmp/aloop/receipts");
			await mkdir(receiptDirectory, { recursive: true, mode: 0o700 });
			const receiptPath = path.join(receiptDirectory, `${receiptId}.json`);
			const receiptDocument = `${JSON.stringify(receipt, null, 2)}\n`;
			await writeFile(receiptPath, receiptDocument, { encoding: "utf8", mode: 0o600, flag: "wx" });
			const productionPassed = policy.productionIntegration?.frequency !== "issue"
				|| (issueProduction?.result.code === 0 && !issueProduction.result.timedOut && !issueProduction.result.cancelled && !issueProduction.result.spawnError);
			const valid = canonicalPassed && productionPassed && afterHead === expected && afterStatus === "";
			if (valid) issuedReceipts.set(receiptId, { document: receiptDocument, issue: pendingAttempt.issue, commit: expected, artifactDirectory: pendingAttempt.artifactDirectory });
			return {
				content: [{ type: "text", text: `${valid ? "Supervisor verification passed" : "Supervisor verification failed or was invalidated"} at ${expected}. Receipt: .pi/tmp/aloop/receipts/${receiptId}.json (canonical exit ${canonical.result.code}; production exit ${issueProduction?.result.code ?? "not-required-for-issue"}; post-check clean=${afterStatus === ""}).` }],
				details: { valid, receiptId, receiptPath: `.pi/tmp/aloop/receipts/${receiptId}.json`, receipt, canonical, production: issueProduction },
			};
		},
	});

	pi.registerTool({
		name: "aloop_prepare_handoff",
		label: "Aloop Prepare Handoff",
		description: "Format a bounded durable aloop attempt handoff comment after the supervisor assesses worker evidence.",
		promptSnippet: "Prepare the exact structured GitHub comment required after every aloop worker attempt.",
		promptGuidelines: ["Use aloop_prepare_handoff after every aloop_launch_worker result, then publish its returned ID with aloop_publish_handoff using dry-run first and apply second. Never copy the encoded comment through the model or use generic issue mutation."],
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
				const issuedReceipt = issuedReceipts.get(params.verification_receipt_id);
				if (!issuedReceipt || issuedReceipt.issue !== params.issue || issuedReceipt.commit !== params.commit || issuedReceipt.artifactDirectory !== params.artifact_directory) throw new Error("Accepted handoffs require a receipt issued after the matching worker attempt in this invocation.");
				const snapshot = activePolicy();
				const policy = snapshot.policy;
				const receiptPath = path.resolve(ctx.cwd, `.pi/tmp/aloop/receipts/${params.verification_receipt_id}.json`);
				const receiptStatus = await lstat(receiptPath);
				if (receiptStatus.isSymbolicLink() || !receiptStatus.isFile() || receiptStatus.size > 100_000) throw new Error("Supervisor verification receipt is unsafe or oversized.");
				const receiptDocument = await readFile(receiptPath, "utf8");
				if (receiptDocument !== issuedReceipt.document) throw new Error("Supervisor verification receipt changed after it was issued.");
				const receipt = JSON.parse(receiptDocument);
				const head = await pi.exec("git", ["rev-parse", `${params.commit}^{commit}`], { timeout: 10_000, signal });
				const currentHead = await pi.exec("git", ["rev-parse", "HEAD"], { timeout: 10_000, signal });
				const worktree = await pi.exec("git", ["status", "--porcelain=v1", "--untracked-files=all"], { timeout: 10_000, signal });
				if (head.code !== 0 || currentHead.code !== 0 || worktree.code !== 0) throw new Error("Could not validate the supervisor verification receipt against Git.");
				const expected = head.stdout.trim();
				const issueProduction = policy.productionIntegration?.frequency === "issue" ? policy.productionIntegration.command.argv : undefined;
				if (receipt.commit !== expected || receipt.policySha256 !== snapshot.sha256 || !sameArgv(receipt.command, policy.canonicalCommand.argv)
					|| (issueProduction !== undefined && (!sameArgv(receipt.productionIntegration, issueProduction) || receipt.productionIntegrationExitStatus !== 0))
					|| currentHead.stdout.trim() !== expected || receipt.exitStatus !== 0 || receipt.postVerificationHead !== expected || receipt.postVerificationClean !== true || worktree.stdout.trim()) {
					throw new Error("Accepted handoff is not bound to a passing policy-matched receipt at the current clean commit; rerun supervisor verification after all source changes.");
				}
			}
			const comment = formatAloopHandoff({
				issue: params.issue,
				attemptType: params.attempt_type,
				commit: params.commit ?? null,
				verificationReceiptId: params.verification_receipt_id,
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
			const spoolRecord = createAloopHandoffSpoolRecord(params.issue, comment);
			const handoffId = spoolRecord.id;
			const spoolDirectory = path.resolve(ctx.cwd, ".pi/tmp/aloop/handoffs");
			await mkdir(spoolDirectory, { recursive: true, mode: 0o700 });
			const spoolPath = path.join(spoolDirectory, `${handoffId}.json`);
			const record = `${JSON.stringify(spoolRecord)}\n`;
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
			const record = validateAloopHandoffSpoolRecord(JSON.parse(await readFile(spoolPath, "utf8")), params.handoff_id);
			const result = await publishPreparedAloopHandoff({
				record,
				handoffId: params.handoff_id,
				dryRun: params.dry_run,
				dryRunHandoffIds,
				publish: async (issue, comment, apply) => await dependencies.publishComment(ctx.cwd, issue, comment, apply, { signal, deadlineMs: runBudget!.deadlineMs }),
			});
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
		promptGuidelines: ["Use only after aloop_publish_handoff applies the exact prepared bytes. Always dry-run before apply; never use generic issue closure for accepted aloop attempts."],
		parameters: CloseAcceptedIssueParams,
		async execute(_id, params: { issue: number; handoff_id: string; verification_receipt_id: string; dry_run: boolean }, signal, _onUpdate, ctx) {
			const context = await currentContext(ctx.cwd, signal, true);
			const issue = context.issues.find((candidate) => candidate.number === params.issue);
			if (!issue) throw new Error(`Issue #${params.issue} is absent from the active epic context.`);
			if (issue.state === "closed") {
				const retry = recognizeClosedAloopRetry({
					issue,
					epicNumber: context.epic.number,
					handoffId: params.handoff_id,
					receiptId: params.verification_receipt_id,
				});
				return { content: [{ type: "text", text: `Closure already applied for #${params.issue} at ${retry.commit}.` }], details: { issue: params.issue, commit: retry.commit, handoffId: params.handoff_id, receiptId: params.verification_receipt_id, dryRun: params.dry_run, applied: false, alreadyClosed: true } };
			}

			const issuedReceipt = issuedReceipts.get(params.verification_receipt_id);
			if (!issuedReceipt || issuedReceipt.issue !== params.issue) throw new Error("Accepted issue closure requires the immutable receipt issued for this worker attempt.");
			const snapshot = activePolicy();
			const policy = snapshot.policy;
			const spoolPath = path.resolve(ctx.cwd, `.pi/tmp/aloop/handoffs/${params.handoff_id}.json`);
			const spoolStatus = await lstat(spoolPath);
			if (!spoolStatus.isFile() || spoolStatus.isSymbolicLink() || spoolStatus.size > 100_000) throw new Error("Prepared handoff spool entry is unsafe or oversized.");
			const spool = validateAloopHandoffSpoolRecord(JSON.parse(await readFile(spoolPath, "utf8")), params.handoff_id);

			const receiptPath = path.resolve(ctx.cwd, `.pi/tmp/aloop/receipts/${params.verification_receipt_id}.json`);
			const receiptStatus = await lstat(receiptPath);
			if (!receiptStatus.isFile() || receiptStatus.isSymbolicLink() || receiptStatus.size > 100_000) throw new Error("Supervisor verification receipt is unsafe or oversized.");
			const receiptDocument = await readFile(receiptPath, "utf8");
			if (receiptDocument !== issuedReceipt.document) throw new Error("Supervisor verification receipt changed after it was issued.");
			const receipt = JSON.parse(receiptDocument);
			const issueProduction = policy.productionIntegration?.frequency === "issue" ? policy.productionIntegration.command.argv : undefined;
			if (receipt.policySha256 !== snapshot.sha256 || !sameArgv(receipt.command, policy.canonicalCommand.argv)
				|| (issueProduction !== undefined && !sameArgv(receipt.productionIntegration, issueProduction))) {
				throw new Error("The supervisor receipt does not match the invocation's committed verification-policy snapshot.");
			}
			const head = await pi.exec("git", ["rev-parse", "HEAD"], { timeout: 10_000, signal });
			const status = await pi.exec("git", ["status", "--porcelain=v1", "--untracked-files=all"], { timeout: 10_000, signal });
			if (head.code !== 0 || status.code !== 0) throw new Error("Could not inspect Git before accepted issue closure.");
			const closure = await closeAcceptedAloopIssue({
				issue,
				epicNumber: context.epic.number,
				handoffId: params.handoff_id,
				spool,
				receiptId: params.verification_receipt_id,
				receipt,
				currentHead: head.stdout.trim(),
				worktreeStatus: status.stdout,
				dryRun: params.dry_run,
				dryRunClosureIds,
				close: async (issueNumber) => await dependencies.closeIssue(ctx.cwd, issueNumber, { signal, deadlineMs: runBudget!.deadlineMs }),
			});
			const action = params.dry_run ? "Closure dry run complete" : closure.alreadyClosed ? "Closure already applied" : "Closed verified issue";
			return { content: [{ type: "text", text: `${action} for #${params.issue} at ${closure.commit}.` }], details: { issue: params.issue, handoffId: params.handoff_id, receiptId: params.verification_receipt_id, dryRun: params.dry_run, ...closure } };
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
		}, signal, onUpdate, ctx) {
			const context = await currentContext(ctx.cwd, signal);
			refreshPending(context);
			const reasons: string[] = pendingHandoffs.map((pending) => `Attempt handoff for #${pending.issue} is not durable on GitHub (${pending.artifactDirectory}).`);
			const epicProduction = activePolicy().policy.productionIntegration;
			if (epicProduction?.frequency === "epic") {
				const beforeHead = await pi.exec("git", ["rev-parse", "HEAD"], { cwd: ctx.cwd, timeout: 30_000, signal });
				const beforeStatus = await pi.exec("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: ctx.cwd, timeout: 30_000, signal });
				if (beforeHead.code !== 0 || beforeStatus.code !== 0 || beforeStatus.stdout.trim()) {
					reasons.push("Epic production integration requires a clean readable HEAD.");
				} else {
					const production = await executeVerificationCommand("epic production integration", epicProduction.command, ctx, signal, onUpdate);
					const afterHead = await pi.exec("git", ["rev-parse", "HEAD"], { cwd: ctx.cwd, timeout: 30_000, signal });
					const afterStatus = await pi.exec("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: ctx.cwd, timeout: 30_000, signal });
					if (afterHead.code !== 0 || afterStatus.code !== 0) reasons.push("Could not verify HEAD and worktree cleanliness after epic production integration.");
					if (production.result.code !== 0 || production.result.timedOut || production.result.cancelled) reasons.push(`Epic production integration failed; log: ${production.logPath}.`);
					if (afterHead.stdout.trim() !== beforeHead.stdout.trim() || afterStatus.stdout.trim()) reasons.push("Epic production integration changed HEAD or the worktree.");
				}
			}
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

export default registerAloopExtension;
