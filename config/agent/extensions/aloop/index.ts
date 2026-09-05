import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { lstat, mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import * as path from "node:path";
import { Type } from "typebox";
import { closeCurrentRepositoryIssue, publishExactIssueComment, retrieveCurrentRepositoryEpicContext } from "../github-issues/index.js";
import { DEFAULT_ALOOP_PATCH_MODEL, runAloopPatchWorker, runAloopWorker, selectAloopPatchModel } from "../github-issues/aloop-worker.js";
import { balancedLogExcerpt, runDurableCommand, writeDurableResult } from "../worker-runner/command-execution.js";
import { DEFAULT_REVIEW_MODEL } from "../review-agents/core.js";
import { snapshotAloopPolicy, type AloopCommandDefinition, type AloopPolicySnapshot } from "./policy.js";
import { ALOOP_LIFECYCLE_ENTRY_TYPE, clearAloopLifecycle, createAloopLifecycleEvent, delegateManagedAloopCheckpoint, publishAloopLifecycleEvent, registerManagedAloopAbortDelegate, sanitizeAloopCheckpointText, type AloopLifecycleKind } from "../managed-sessions/aloop-lifecycle.js";
import {
	ALOOP_HANDOFF_LIMITS,
	acceptedOpenAloopIssues,
	assessAloopRunBudget,
	buildSupervisorKickoff,
	evaluateEpicClosure,
	findOutstandingAttempts,
	formatAloopHandoffV3,
	parseAloopHandoffV3,
	nextIssueRetryNumber,
	parseAloopHandoffs,
	parseAloopRunRequest,
	selectAloopLeaf,
	validatedAcceptedCurrentStateHandoff,
	validatedChildReviewEvidence,
	type AloopAttemptRecord,
	type AloopRunBudget,
	type ClosureEvidence,
} from "./core.js";

const TOOL_NAMES = ["aloop_context", "aloop_abort", "aloop_launch_worker", "aloop_review_attempt", "aloop_apply_patch", "aloop_finish_attempt", "aloop_checkpoint", "aloop_epic_completion"];
const ALL_ALOOP_TOOLS = TOOL_NAMES;
const STATUS_KEY = "aloop";
const MAX_COMMENT_LIMIT = 20;
const MAX_COMMENT_BODY = 20_000;

import { parsePreservationEvidence, preservationSummary, type PreservationEvidence } from "../github-issues/aloop-preservation.js";

type PendingHandoff = {
	preservation?: PreservationEvidence;
	issue: number;
	commit: string | null;
	artifactDirectory: string;
	patchArtifacts?: Array<{ commit: string | null; artifactDirectory: string; status: string; preservation?: PreservationEvidence }>;
};


const LaunchWorkerParams = Type.Object({
	issue: Type.Number({ minimum: 1, description: "Selected open, unblocked descendant leaf issue number." }),
	attempt_type: Type.Optional(Type.Union([Type.Literal("implementation"), Type.Literal("remediation")])),
	timeout_ms: Type.Optional(Type.Number({ minimum: 1, maximum: 14_400_000 })),
});

const MAX_PATCH_TIMEOUT_MS = 20 * 60_000;
const CheckpointParams = Type.Object({
	issue: Type.Number({ minimum: 1 }),
	decision: Type.String({ minLength: 1, maxLength: 1_200 }),
	options: Type.Array(Type.String({ minLength: 1, maxLength: 300 }), { maxItems: 8 }),
	kind: Type.Optional(Type.Union([Type.Literal("general"), Type.Literal("review")])),
});

const ApplyPatchParams = Type.Object({
	issue: Type.Number({ minimum: 1, description: "Issue whose unsettled full attempt needs a narrow correction." }),
	correction: Type.String({ minLength: 1, description: "Exact bounded correction for the targeted patch worker." }),
	timeout_ms: Type.Optional(Type.Number({ minimum: 1, maximum: MAX_PATCH_TIMEOUT_MS })),
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
	const patchArtifactDirectories = new Set<string>();
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
			let preservation = parsePreservationEvidence(result.preservation);
			let commit = result.commit === null ? null : typeof result.commit === "string" && /^[0-9a-f]{7,64}$/i.test(result.commit) ? result.commit : undefined;
			if (commit === undefined || typeof result.status !== "string") continue;
			try {
				const patchPath = path.join(root, entry.name, "patch-attempts.json");
				const patchStatus = await lstat(patchPath);
				if (!patchStatus.isSymbolicLink() && patchStatus.isFile() && patchStatus.size <= 1_000_000) {
					const patches = JSON.parse(await readFile(patchPath, "utf8"));
					if (Array.isArray(patches)) {
						for (const patch of patches) {
							const patchPreservation = parsePreservationEvidence(patch.preservation);
							if (patchPreservation?.capture === "incomplete") preservation = patchPreservation;
							if (typeof patch?.artifactDirectory === "string") patchArtifactDirectories.add(patch.artifactDirectory);
							if (typeof patch?.commit === "string" && /^[0-9a-f]{7,64}$/i.test(patch.commit)) commit = patch.commit;
						}
					}
				}
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			records.push({ issue: Number(match[1]), commit, artifactDirectory, status: result.status, preservation });
		} catch {
			// Ignore incomplete or malformed attempt artifacts; they carry no recoverable structured outcome.
		}
	}
	return records.filter((record) => !patchArtifactDirectories.has(record.artifactDirectory));
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
	let activeSessionId: string | null = null;
	let pendingHandoffs: PendingHandoff[] = [];
	const issueBaseCommits = new Map<number, string>();
	const attemptReviews = new Map<number, { base: string; head: string; available: boolean; details?: unknown; error?: string }>();
	let workerRunning = false;
	let runBudget: AloopRunBudget | null = null;
	let policySnapshot: AloopPolicySnapshot | null = null;
	let cachedContext: Awaited<ReturnType<typeof retrieveCurrentRepositoryEpicContext>> | null = null;
	let supervisorLogin: string | null = null;
	const pendingHumanBoundaries = new Set<string>();
	const publishedAttemptDigests = new Map<string, string>();
	let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
	let removeAbortListener: (() => void) | null = null;
	let removeManagedAbortDelegate: (() => void) | null = null;

	function projectLifecycle(kind: AloopLifecycleKind, epic: number, body: string, issue?: number): void {
		const event = createAloopLifecycleEvent(kind, epic, body, issue, activeSessionId ?? "standalone");
		pi.appendEntry(ALOOP_LIFECYCLE_ENTRY_TYPE, event);
		publishAloopLifecycleEvent(event);
	}

	function clearDeadlineTimer(): void {
		if (deadlineTimer) clearTimeout(deadlineTimer);
		deadlineTimer = null;
	}

	function deactivate(): void {
		clearDeadlineTimer();
		removeAbortListener?.();
		removeAbortListener = null;
		removeManagedAbortDelegate?.();
		removeManagedAbortDelegate = null;
		activeEpic = null;
		activeSessionId = null;
		pendingHandoffs = [];
		issueBaseCommits.clear();
		attemptReviews.clear();
		workerRunning = false;
		runBudget = null;
		policySnapshot = null;
		cachedContext = null;
		supervisorLogin = null;
		pendingHumanBoundaries.clear();
		publishedAttemptDigests.clear();
		pi.setActiveTools(pi.getActiveTools().filter((name) => !ALL_ALOOP_TOOLS.includes(name)));
	}

	function activate(epic: number, ctx: ExtensionContext, recovered: PendingHandoff[], maxMinutes: number, maxWorkerLaunches: number): AloopRunBudget {
		clearDeadlineTimer();
		activeEpic = epic;
		activeSessionId = ctx.sessionManager.getSessionId();
		pendingHandoffs = recovered;
		issueBaseCommits.clear();
		runBudget = { deadlineMs: Date.now() + maxMinutes * 60_000, maxWorkerLaunches, workerLaunchesStarted: 0, settled: false };
		const abort = () => {
			if (activeEpic !== epic || pendingHumanBoundaries.size > 0) return;
			projectLifecycle("cancelled", epic, `Aloop #${epic} was cancelled from the managed session. Active subprocesses were terminated and durable recovery state was preserved.`);
			deactivate();
		};
		removeManagedAbortDelegate = registerManagedAloopAbortDelegate(activeSessionId, () => {
			if (activeEpic !== epic) return;
			projectLifecycle("cancelled", epic, `Aloop #${epic} was cancelled from the managed session. Active subprocesses were terminated and durable recovery state was preserved.`);
			deactivate();
		});
		const runSignal = ctx.signal;
		if (runSignal) {
			runSignal.addEventListener("abort", abort, { once: true });
			removeAbortListener = () => runSignal.removeEventListener("abort", abort);
		}
		deadlineTimer = setTimeout(() => {
			if (!runBudget || runBudget.settled) return;
			projectLifecycle("bounded-stop", epic, `Aloop #${epic} reached its ${maxMinutes}-minute shared implementation limit. Recovery state is preserved; run /aloop #${epic} again to continue.`);
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

	pi.on("session_start", (_event, ctx) => {
		deactivate();
		clearAloopLifecycle(ctx.sessionManager.getSessionId());
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
	});
	pi.on("session_shutdown", (_event, ctx) => {
		deactivate();
		clearAloopLifecycle(ctx.sessionManager.getSessionId());
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
	});
	pi.on("agent_settled", (_event, ctx) => {
		if (pendingHumanBoundaries.size > 0) {
			if (ctx.hasUI && activeEpic !== null) ctx.ui.setStatus(STATUS_KEY, `aloop: #${activeEpic} awaiting human command`);
			return;
		}
		if (!runBudget || runBudget.settled) return;
		runBudget.settled = true;
		clearDeadlineTimer();
		if (activeEpic !== null) projectLifecycle("bounded-stop", activeEpic, `Aloop #${activeEpic} settled for this invocation. Durable recovery state is preserved; run /aloop #${activeEpic} again to continue.`);
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

	function recoveryAuthorizationBody(issue: number, handoff: { attemptKey: string; commitRange: string }, acceptedBody: string, closureHead: string): string {
		const payload = Buffer.from(JSON.stringify({ version: 1, issue, attemptKey: handoff.attemptKey, reviewedHead: handoff.commitRange.split("..").at(-1), closureHead, commentSha256: createHash("sha256").update(acceptedBody).digest("hex") }), "utf8").toString("base64url");
		return `Human closure-recovery authorization recorded for #${issue}.\n\n<!-- pi-aloop-recovery-authorization:v1:${payload} -->`;
	}

	function recoveryDecisionBoundary(issue: number) {
		return {
			content: [{ type: "text" as const, text: `Accepted handoff #${issue} needs a human closure-recovery decision before it can settle.` }],
			details: { settled: false, checkpoint: true, issue, humanDecisionRequired: true },
			terminate: true,
		};
	}

	function authenticatedSupervisorComment(author: string | null): boolean {
		return supervisorLogin !== null && author === supervisorLogin;
	}

	function recoveryAuthorized(issue: number, handoff: { attemptKey: string; commitRange: string }, body: string, closureHead: string, comments: Array<{ author: string | null; body: string }>): boolean {
		const expected = { version: 1, issue, attemptKey: handoff.attemptKey, reviewedHead: handoff.commitRange.split("..").at(-1), closureHead, commentSha256: createHash("sha256").update(body).digest("hex") };
		return comments.some((comment) => {
			if (!authenticatedSupervisorComment(comment.author)) return false;
			const encoded = comment.body.match(/<!-- pi-aloop-recovery-authorization:v1:([A-Za-z0-9_-]+) -->/)?.[1];
			if (!encoded) return false;
			try { return JSON.stringify(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"))) === JSON.stringify(expected); } catch { return false; }
		});
	}

	function checkpointState(issue: { recentHandoffs: Array<{ body: string }> }): { open: string[]; resolved: string[] } {
		const open = issue.recentHandoffs.flatMap((comment) => comment.body.match(/pi-aloop-decision:([a-f0-9]{20}):open/)?.[1] ?? []);
		const resolved = issue.recentHandoffs.flatMap((comment) => comment.body.match(/pi-aloop-decision:([a-f0-9]{20}):resolved/)?.[1] ?? []);
		return { open, resolved };
	}

	function reviewCheckpointState(issue: { recentHandoffs: Array<{ author: string | null; body: string }> }, head: string): { open: string[]; resolved: string[] } {
		const token = `:${head}:`;
		const open = issue.recentHandoffs.flatMap((comment) => authenticatedSupervisorComment(comment.author) && comment.body.match(new RegExp(`pi-aloop-review-decision:([a-f0-9]{20})${token}open`))?.[1] ? [comment.body.match(new RegExp(`pi-aloop-review-decision:([a-f0-9]{20})${token}open`))![1]!] : []);
		const resolved = issue.recentHandoffs.flatMap((comment) => authenticatedSupervisorComment(comment.author) && comment.body.match(new RegExp(`pi-aloop-review-decision:([a-f0-9]{20})${token}resolved`))?.[1] ? [comment.body.match(new RegExp(`pi-aloop-review-decision:([a-f0-9]{20})${token}resolved`))![1]!] : []);
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
			activeSessionId = ctx.sessionManager.getSessionId();
			if (!ctx.isIdle()) {
				ctx.ui.notify("/aloop must be started while Pi is idle; abort the active turn or wait for it to settle, then retry.", "warning");
				return;
			}
			const status = await pi.exec("git", ["status", "--porcelain=v1", "--untracked-files=all"], { timeout: 10_000 });
			if (status.code !== 0) throw new Error((status.stderr || status.stdout || "Could not inspect the worktree.").trim());
			if (status.stdout.trim()) {
				projectLifecycle("startup-failure", epic, `Aloop #${epic} did not start because the worktree is dirty. Commit or intentionally clean the tree, then invoke it again.`);
				ctx.ui.notify("/aloop requires a clean worktree before supervision starts.", "error");
				return;
			}
			let startupPolicy: AloopPolicySnapshot;
			try { startupPolicy = await loadCommittedPolicy(ctx.cwd, ctx.signal); }
			catch (error) {
				projectLifecycle("startup-failure", epic, `Aloop #${epic} could not load its committed verification policy. No worker was started.`);
				throw error;
			}
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
				projectLifecycle("startup-failure", epic, `Aloop #${epic} could not load its GitHub issue context. No worker was started.`);
				deactivate();
				if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
				throw error;
			}
			cachedContext = context;
			if (context.epic.state !== "open") {
				projectLifecycle("startup-failure", epic, `Aloop #${epic} did not start because the epic is not open.`);
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
				const identity = await pi.exec("gh", ["api", "user", "--jq", ".login"], { cwd: ctx.cwd, timeout: startupTimeout(), signal: ctx.signal });
				supervisorLogin = identity.code === 0 && /^[A-Za-z0-9-]{1,39}$/.test(identity.stdout.trim()) ? identity.stdout.trim() : null;
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
				const selected = cachedFrontier(context).find((number) => !acceptedOpenAloopIssues(context).includes(number));
				const supervisorModel = activeModelRef(ctx) ?? "unavailable";
				const patchModel = startupPolicy.policy.patchWorkerModel?.trim() || DEFAULT_ALOOP_PATCH_MODEL;
				const reviewModel = process.env.PI_HARNESS_REVIEW_MODEL?.trim() || DEFAULT_REVIEW_MODEL;
				projectLifecycle("startup", epic, `Aloop started for epic #${epic}. ${selected ? `Selected child: #${selected}.` : "No executable child is currently available."} Shared budget: ${request.maxMinutes} minutes and ${request.maxWorkerLaunches} full-worker launches. Models — supervisor/implementation: ${supervisorModel}; patch: ${patchModel}; review: ${reviewModel}.`);
				if (outstanding.length) projectLifecycle("recovery", epic, `Aloop recovered ${outstanding.length} unsettled attempt${outstanding.length === 1 ? "" : "s"}. No duplicate worker will start before recovery settles.`);
				pi.sendUserMessage(buildSupervisorKickoff(context, history.stdout, outstanding, budget));
			} catch (error) {
				projectLifecycle("startup-failure", epic, `Aloop #${epic} failed during startup before any new worker was launched. Recovery state is preserved.`);
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
			pendingHumanBoundaries.delete(`epic:${prepared.head}`);
			pi.sendUserMessage(`Human approval recorded for epic #${activeEpic} at ${prepared.head}. Continue with aloop_epic_completion apply.`);
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
			const genericMarker = [...state.open].reverse().find((marker) => !state.resolved.includes(marker));
			const reviewOpen = issue.recentHandoffs.flatMap((comment) => comment.body.match(/pi-aloop-review-decision:([a-f0-9]{20}):([a-f0-9]{7,64}):open/) ? [{ marker: comment.body.match(/pi-aloop-review-decision:([a-f0-9]{20}):([a-f0-9]{7,64}):open/)![1]!, head: comment.body.match(/pi-aloop-review-decision:([a-f0-9]{20}):([a-f0-9]{7,64}):open/)![2]! }] : []).reverse().find(({ marker, head }) => !reviewCheckpointState(issue, head).resolved.includes(marker));
			const openMarker = reviewOpen?.marker ?? genericMarker;
			if (!openMarker) throw new Error("No open aloop checkpoint exists for this issue.");
			const body = reviewOpen
				? `Aloop human review decision recorded: ${decision}\n\n<!-- pi-aloop-review-decision:${openMarker}:${reviewOpen.head}:resolved -->`
				: `Aloop human decision recorded: ${decision}\n\n<!-- pi-aloop-decision:${openMarker}:resolved -->`;
			if (!reviewOpen) await writeDurableResult(path.resolve(ctx.cwd, ".pi/tmp/aloop/decisions", `${openMarker}.json`), { version: 1, marker: openMarker, issue: issueNumber, decision, approvedAt: new Date().toISOString(), approvedVia: "aloop-decision command" });
			await dependencies.publishComment(ctx.cwd, issueNumber, body, false, { signal: ctx.signal });
			const publication: any = await dependencies.publishComment(ctx.cwd, issueNumber, body, true, { signal: ctx.signal });
			const author = typeof publication?.author === "string" ? publication.author : typeof publication?.user?.login === "string" ? publication.user.login : null;
			issue.recentHandoffs.push({ id: Date.now(), author, body, createdAt: new Date().toISOString(), url: null });
			pendingHumanBoundaries.delete(`decision:${openMarker}`);
			projectLifecycle("checkpoint", activeEpic!, `Decision recorded for child #${issueNumber}. A fresh worker may continue from the durable GitHub decision.`, issueNumber);
			pi.sendUserMessage(`Human decision recorded for #${issueNumber}: ${decision}. Continue the aloop supervision flow.`);
			if (ctx.hasUI) ctx.ui.notify(`Recorded decision for #${issueNumber}.`, "info");
		},
	});

	pi.registerCommand("aloop-authorize-recovery", {
		description: "Human authorization to close one accepted handoff requiring GitHub-recorded authorization: /aloop-authorize-recovery <issue> <attempt-key>",
		handler: async (args, ctx) => {
			const match = args.trim().match(/^#?(\d+)\s+([a-f0-9]{24})$/);
			if (!match) throw new Error("Usage: /aloop-authorize-recovery <issue> <attempt-key>");
			const issue = Number(match[1]);
			const attemptKey = match[2]!;
			const context = await currentContext(ctx.cwd, ctx.signal);
			const child = context.issues.find((candidate) => candidate.number === issue);
			const acceptedComment = child?.recentHandoffs.find((comment) => {
				const handoff = parseAloopHandoffV3(comment.body);
				return handoff?.issue === issue && handoff.attemptKey === attemptKey && handoff.outcome === "accepted";
			});
			const accepted = acceptedComment && parseAloopHandoffV3(acceptedComment.body);
			if (!child || !accepted || !acceptedComment || child.state === "closed") throw new Error("No matching open accepted handoff requires recovery authorization.");
			const [headResult, statusResult] = await Promise.all([
				pi.exec("git", ["rev-parse", "HEAD"], { cwd: ctx.cwd, timeout: 30_000, signal: ctx.signal }),
				pi.exec("git", ["status", "--porcelain=v1", "--untracked-files=all", "--", ".", ":(exclude).pi/tmp/aloop"], { cwd: ctx.cwd, timeout: 30_000, signal: ctx.signal }),
			]);
			if (headResult.code !== 0 || statusResult.code !== 0 || statusResult.stdout.trim()) throw new Error("Recovery authorization requires a clean current HEAD.");
			const body = recoveryAuthorizationBody(issue, accepted, acceptedComment.body, headResult.stdout.trim());
			await dependencies.publishComment(ctx.cwd, issue, body, false, { signal: ctx.signal });
			const publication: any = await dependencies.publishComment(ctx.cwd, issue, body, true, { signal: ctx.signal });
			const author = typeof publication?.author === "string" ? publication.author : typeof publication?.user?.login === "string" ? publication.user.login : null;
			child.recentHandoffs.push({ id: Date.now(), author, body, createdAt: new Date().toISOString(), url: null });
			pendingHumanBoundaries.delete(`recovery:${attemptKey}`);
			projectLifecycle("recovery", activeEpic!, `Human closure-recovery authorization was recorded for child #${issue}. Finalization may resume.`, issue);
			pi.sendUserMessage(`Human closure-recovery authorization recorded for #${issue} attempt ${attemptKey}. Continue with aloop_finish_attempt.`);
			if (ctx.hasUI) ctx.ui.notify(`Authorized closure recovery for #${issue} attempt ${attemptKey}.`, "info");
		},
	});

	pi.registerCommand("aloop-abort", {
		description: "Abort the active aloop invocation and preserve durable recovery state.",
		handler: async (_args, ctx) => {
			if (activeEpic !== null) projectLifecycle("cancelled", activeEpic, `Aloop #${activeEpic} was cancelled. Active subprocesses were terminated and durable recovery state was preserved.`);
			deactivate();
			ctx.abort();
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
			if (activeEpic !== null) projectLifecycle("cancelled", activeEpic, `Aloop #${activeEpic} was cancelled. Active subprocesses were terminated and durable recovery state was preserved.`);
			deactivate();
			ctx.abort();
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
				pendingHandoffs.push({ issue: issue.number, commit: outcome.commit, artifactDirectory: outcome.artifacts.directory, preservation: outcome.preservation });
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
			} catch (error) {
				if (activeEpic !== null) projectLifecycle("startup-failure", activeEpic, `Aloop could not complete the requested worker launch for child #${params.issue}. No later review, verification, or GitHub mutation was started; recovery state is preserved.`, params.issue);
				throw error;
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
					modelRef, timeoutMs: Math.min(params.timeout_ms ?? MAX_PATCH_TIMEOUT_MS, MAX_PATCH_TIMEOUT_MS), spawnDeadlineMs: runBudget.deadlineMs, signal,
				});
				if (outcome.preservation?.capture === "incomplete") pending.preservation = outcome.preservation;
				pending.patchArtifacts = [...(pending.patchArtifacts ?? []), { commit: outcome.commit, artifactDirectory: outcome.artifacts.directory, status: outcome.status, preservation: outcome.preservation }];
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
			summary: Type.String({ minLength: 1, maxLength: ALOOP_HANDOFF_LIMITS.summary }),
			outstanding_findings: Type.Array(Type.String({ maxLength: ALOOP_HANDOFF_LIMITS.finding }), { maxItems: ALOOP_HANDOFF_LIMITS.findings }),
			decisions: Type.Array(Type.String({ maxLength: ALOOP_HANDOFF_LIMITS.decision }), { maxItems: ALOOP_HANDOFF_LIMITS.decisions }),
			verification: Type.Array(Type.String({ maxLength: ALOOP_HANDOFF_LIMITS.verification }), { maxItems: 3, description: "Advisory entries; aloop reserves three additional slots for review, canonical, and production receipts." }),
			next_action: Type.String({ minLength: 1, maxLength: ALOOP_HANDOFF_LIMITS.nextAction }),
		}),
		async execute(_id, params: { issue: number; outcome: "accepted" | "incomplete" | "decision-required" | "environment-blocked" | "rejected"; summary: string; outstanding_findings: string[]; decisions: string[]; verification: string[]; next_action: string }, signal, onUpdate, ctx) {
			if (params.outcome === "accepted" && params.outstanding_findings.length > 0) throw new Error("Accepted finalization requires all outstanding findings to be resolved.");
			const context = await currentContext(ctx.cwd, signal);
			const issue = context.issues.find((candidate) => candidate.number === params.issue);
			if (!issue) throw new Error("Issue is not in the active epic.");
			const pending = pendingHandoffs.find((candidate) => candidate.issue === params.issue);
			if (!pending) {
				const settled = issue.recentHandoffs.map((comment) => parseAloopHandoffV3(comment.body)).filter((value) => value?.issue === params.issue).at(-1);
				if (settled) {
					if (settled.outcome === "accepted" && issue.state !== "closed") {
						const settledComment = [...issue.recentHandoffs].reverse().find((comment) => {
							const handoff = parseAloopHandoffV3(comment.body);
							return handoff?.issue === params.issue && handoff.attemptKey === settled.attemptKey && handoff.outcome === "accepted";
						});
						if (!settledComment) throw new Error("Accepted handoff comment is missing its durable GitHub body.");
						const expectedHead = settled.commitRange.split("..").at(-1)!;
						const [head, status] = await Promise.all([
							pi.exec("git", ["rev-parse", "HEAD"], { cwd: ctx.cwd, timeout: 30_000, signal }),
							pi.exec("git", ["status", "--porcelain=v1", "--untracked-files=all", "--", ".", ":(exclude).pi/tmp/aloop"], { cwd: ctx.cwd, timeout: 30_000, signal }),
						]);
						if (head.code !== 0 || status.code !== 0 || status.stdout.trim()) throw new Error("Recovery closure requires a clean current worktree.");
						const closureHead = head.stdout.trim();
						const validated = validatedAcceptedCurrentStateHandoff(issue, closureHead, supervisorLogin);
						if (!validated || validated.handoff.attemptKey !== settled.attemptKey || validated.body !== settledComment.body) {
							throw new Error("Recovery closure requires the latest accepted v3 handoff with no findings and durable review and canonical verification evidence bound to the clean current HEAD.");
						}
						const automaticProvenance = publishedAttemptDigests.get(settled.attemptKey) === createHash("sha256").update(settledComment.body).digest("hex") || authenticatedSupervisorComment(settledComment.author);
						const explicitAuthorization = recoveryAuthorized(params.issue, settled, settledComment.body, closureHead, issue.recentHandoffs);
						if (!automaticProvenance && !explicitAuthorization) {
							pendingHumanBoundaries.add(`recovery:${settled.attemptKey}`);
							return recoveryDecisionBoundary(params.issue);
						}
						if (!explicitAuthorization && closureHead !== expectedHead) throw new Error("Published accepted handoff no longer matches the clean current HEAD.");
						await dependencies.closeIssue(ctx.cwd, params.issue, { signal });
						issue.state = "closed";
						pendingHumanBoundaries.delete(`recovery:${settled.attemptKey}`);
					}
					const recoveredFrontier = cachedFrontier(context);
					projectLifecycle("attempt-settled", activeEpic!, `Recovered child #${params.issue} already settled as ${settled.outcome}.${settled.outcome === "accepted" ? " The child is closed." : " Recovery state remains available."} Next executable frontier: ${recoveredFrontier.map((number) => `#${number}`).join(", ") || "none"}.`, params.issue);
					return { content: [{ type: "text", text: `Attempt #${params.issue} was already settled as ${settled.outcome}.` }], details: { settled: true, closed: settled.outcome === "accepted", idempotent: true, handoff: settled, frontier: recoveredFrontier } };
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
			if (pending.preservation) {
				verification.unshift(`Worker preservation: ${pending.preservation.capture}.`);
				if (params.outcome === "accepted" && pending.preservation.capture !== "complete") {
					throw new Error("Accepted finalization requires complete preservation evidence; inspect retained workspace before continuing.");
				}
			}
			const checkpoints = checkpointState(issue);
			const attestedResolutions = new Set<string>();
			for (const marker of checkpoints.open) if (checkpoints.resolved.includes(marker) && await decisionAttested(ctx.cwd, marker)) attestedResolutions.add(marker);
			if (checkpoints.open.some((marker) => !attestedResolutions.has(marker))) throw new Error("Attempt finalization is blocked by an unresolved or unattested human checkpoint.");
			const reviewCheckpoints = reviewCheckpointState(issue, head);
			if (reviewCheckpoints.open.some((marker) => !reviewCheckpoints.resolved.includes(marker))) throw new Error("Attempt finalization is blocked by an unresolved authenticated review checkpoint.");
			if (params.outcome === "accepted") {
				if (statusResult.stdout.trim()) throw new Error("Accepted finalization requires a clean worktree.");
				const hasReviewDecision = reviewCheckpoints.open.some((marker) => reviewCheckpoints.resolved.includes(marker));
				if ((!review || review.head !== head || !review.available) && !hasReviewDecision) throw new Error("Accepted finalization requires fresh independent review at the current HEAD; unavailable review requires a resolved authenticated review checkpoint bound to that HEAD.");
				verification.push(review?.available && review.head === head
					? `Independent review completed at ${head}.`
					: `Human review decision recorded at ${head}.`);
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
			if (publishedHandoff?.outcome === "accepted") {
				const validated = validatedAcceptedCurrentStateHandoff(issue, head, supervisorLogin);
				if (!validated || validated.body !== publishedComment?.body) throw new Error("Published accepted handoff is not the latest fully reviewed and verified current-state snapshot.");
			}
			const handoff = publishedHandoff ?? { version: 3 as const, issue: params.issue, issueBaseCommit: base, commitRange: `${base}..${head}`, outcome: params.outcome, summary: pending.preservation && params.outcome !== "accepted" ? preservationSummary(pending.preservation, false) : params.summary, outstandingFindings: params.outstanding_findings, decisions: params.decisions, verification, nextAction: params.next_action, attemptKey, timestamp: new Date().toISOString() };
			const body = publishedComment?.body ?? formatAloopHandoffV3(handoff);
			if (params.outcome === "accepted") {
				const durable = parseAloopHandoffV3(body);
				const durableHead = durable?.commitRange.split("..").at(-1);
				const hasReview = durable?.verification.some((item) => item === `Independent review completed at ${durableHead}.` || item === `Human review decision recorded at ${durableHead}.`) ?? false;
				const hasCanonical = durable?.verification.some((item) => item === `Canonical command passed at ${durableHead}.`) ?? false;
				if (!durable || durable.outstandingFindings.length > 0 || !hasReview || !hasCanonical) throw new Error("Accepted handoff normalization must retain review and canonical verification bound to HEAD.");
			}
			if (!publishedComment) {
				await dependencies.publishComment(ctx.cwd, params.issue, body, false, { signal });
				try {
					const publication: any = await dependencies.publishComment(ctx.cwd, params.issue, body, true, { signal });
					const author = typeof publication?.author === "string" ? publication.author : typeof publication?.user?.login === "string" ? publication.user.login : null;
					issue.recentHandoffs.push({ id: Date.now(), author, body, createdAt: handoff.timestamp, url: null });
					if (publication?.status !== "existing" || authenticatedSupervisorComment(author)) publishedAttemptDigests.set(attemptKey, createHash("sha256").update(body).digest("hex"));
				} catch (error) {
					const refreshed = await currentContext(ctx.cwd, signal, true);
					const refreshedIssue = refreshed.issues.find((candidate) => candidate.number === params.issue);
					const exactPublished = refreshedIssue?.recentHandoffs.find((comment) => comment.body === body);
					if (!exactPublished) throw error;
					issue.recentHandoffs.push(exactPublished);
					if (authenticatedSupervisorComment(exactPublished.author)) publishedAttemptDigests.set(attemptKey, createHash("sha256").update(body).digest("hex"));
				}
			}
			if (params.outcome === "accepted") {
				await writeDurableResult(path.resolve(ctx.cwd, ".pi/tmp/aloop/finalizations", `${attemptKey}.json`), { version: 1, attemptKey, issue: params.issue, head, commentSha256: createHash("sha256").update(body).digest("hex") });
			}
			pendingHandoffs = pendingHandoffs.filter((candidate) => candidate !== pending);
			if (params.outcome === "accepted" && issue.state !== "closed") {
				const durableComment = [...issue.recentHandoffs].reverse().find((comment) => comment.body === body);
				const automaticProvenance = durableComment !== undefined && (
					publishedAttemptDigests.get(attemptKey) === createHash("sha256").update(durableComment.body).digest("hex")
					|| authenticatedSupervisorComment(durableComment.author)
				);
				const explicitAuthorization = durableComment !== undefined
					&& recoveryAuthorized(params.issue, handoff, durableComment.body, head, issue.recentHandoffs);
				if (!automaticProvenance && !explicitAuthorization) {
					pendingHumanBoundaries.add(`recovery:${attemptKey}`);
					return recoveryDecisionBoundary(params.issue);
				}
				await dependencies.closeIssue(ctx.cwd, params.issue, { signal });
				issue.state = "closed";
				const cachedIssue = cachedContext?.issues.find((candidate) => candidate.number === params.issue);
				if (cachedIssue) cachedIssue.state = "closed";
			}
			const frontier = cachedFrontier(context);
			projectLifecycle("attempt-settled", activeEpic!, `Child #${params.issue} settled as ${params.outcome}.${params.outcome === "accepted" ? " The child was closed." : " Recovery state was retained."} Next executable frontier: ${frontier.map((number) => `#${number}`).join(", ") || "none"}.`, params.issue);
			return { content: [{ type: "text", text: `Attempt #${params.issue} settled as ${params.outcome}.${params.outcome === "accepted" ? " Child closed." : ""} Next frontier: ${frontier.map((number) => `#${number}`).join(", ") || "none"}.` }], details: { settled: true, closed: params.outcome === "accepted", handoff, frontier } };
		},
	});

	pi.registerTool({
		name: "aloop_checkpoint",
		label: "Aloop Checkpoint",
		description: "Create or resolve a transport-neutral human decision boundary and record it on the child issue.",
		promptSnippet: "Stop for a durable human decision when supervisor judgment cannot proceed safely.",
		parameters: CheckpointParams,
		async execute(_id, params: { issue: number; decision: string; options: string[]; kind?: "general" | "review" }, signal, _onUpdate, ctx) {
			const context = await currentContext(ctx.cwd, signal);
			const issue = context.issues.find((candidate) => candidate.number === params.issue);
			if (!issue) throw new Error("Checkpoint issue is not in the active epic.");
			const headResult = params.kind === "review" ? await pi.exec("git", ["rev-parse", "HEAD"], { cwd: ctx.cwd, timeout: 30_000, signal }) : null;
			if (headResult && headResult.code !== 0) throw new Error("Could not bind review checkpoint to the current HEAD.");
			const head = headResult?.stdout.trim();
			const marker = createHash("sha256").update(`${params.issue}:${params.kind ?? "general"}:${head ?? ""}:${params.decision}`).digest("hex").slice(0, 20);
			const markerText = params.kind === "review" ? `pi-aloop-review-decision:${marker}:${head}:open` : `pi-aloop-decision:${marker}:open`;
			const body = `Aloop needs a human ${params.kind === "review" ? "review" : "decision"}: ${params.decision}\n\n${params.options.map((option) => `- ${option}`).join("\n")}\n\nReply with \`/aloop-decision ${params.issue} <decision>\`.\n\n<!-- ${markerText} -->`;
			if (!issue.recentHandoffs.some((comment) => comment.body.includes(markerText))) {
				await dependencies.publishComment(ctx.cwd, params.issue, body, false, { signal });
				const publication: any = await dependencies.publishComment(ctx.cwd, params.issue, body, true, { signal });
				const author = typeof publication?.author === "string" ? publication.author : typeof publication?.user?.login === "string" ? publication.user.login : null;
				issue.recentHandoffs.push({ id: Date.now(), author, body, createdAt: new Date().toISOString(), url: null });
			}
			pendingHumanBoundaries.add(`decision:${marker}`);
			const delegated = await delegateManagedAloopCheckpoint(activeSessionId!, `aloop-${marker}`, {
				kind: "question", decision: sanitizeAloopCheckpointText(`Aloop decision for child #${params.issue}: ${params.decision}`),
				context: `The decision is recorded on GitHub before a fresh worker continues. Reply with /aloop-decision ${params.issue} followed by the chosen decision.`,
				...(params.options.length ? { options: params.options.map(sanitizeAloopCheckpointText) } : {}),
			});
			if (!delegated) projectLifecycle("checkpoint", activeEpic!, `Aloop needs a human decision for child #${params.issue}: ${params.decision} Reply with /aloop-decision ${params.issue} followed by the chosen decision.`, params.issue);
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
							const evidence = validatedChildReviewEvidence(issue, supervisorLogin);
							return { issue: issue.number, reviewed: issue.state === "closed" && evidence !== null, evidence: evidence ?? "No validated accepted handoff binds durable review and verification." };
						}),
				};
				const gate = evaluateEpicClosure(context, evidence);
				if (!gate.allowed) return { content: [{ type: "text", text: `Epic evidence is incomplete: ${gate.reasons.join(" ")}` }], details: { ready: false, gate, evidence } };
				await writeDurableResult(approvalPath, { version: 2, epic: context.epic.number, head, policySha256: snapshot.sha256, evidence, preparedAt: new Date().toISOString() });
				pendingHumanBoundaries.add(`epic:${head}`);
				projectLifecycle("epic-ready", context.epic.number, `Epic #${context.epic.number} passed final verification with ${evidence.descendantReviews.length} reviewed descendants and ${evidence.acceptanceCriteria.length} evidenced acceptance criteria. Explicit approval is required before closure: /aloop-approve-epic ${head}`);
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

}

export default registerAloopExtension;
