import { deflateRawSync, inflateRawSync } from "node:zlib";
import { createHash } from "node:crypto";
import type { EpicIssueContext, GitHubEpicContext, IssueHandoff } from "../github-issues/github-context.js";

const HANDOFF_PREFIX = "pi-aloop-handoff:v2:";
const HANDOFF_V3_PREFIX = "<!-- pi-aloop-handoff:v3:";

export type AloopHandoffV3 = {
	version: 3;
	issue: number;
	issueBaseCommit: string;
	commitRange: string;
	outcome: "accepted" | "incomplete" | "decision-required" | "environment-blocked" | "rejected";
	summary: string;
	outstandingFindings: string[];
	decisions: string[];
	verification: string[];
	nextAction: string;
	attemptKey: string;
	timestamp: string;
};

export function formatAloopHandoffV3(input: AloopHandoffV3): string {
	const payload = Buffer.from(JSON.stringify(input), "utf8").toString("base64url");
	const lines = input.outcome === "accepted"
		? [`Aloop accepted ${input.commitRange}.`, input.summary, `Outstanding: ${input.outstandingFindings.join("; ") || "none"}.`, `Decisions: ${input.decisions.join("; ") || "none"}.`, `Verification: ${input.verification.join("; ") || "none"}.`, `Next: ${input.nextAction}`]
		: [`Aloop attempt settled as ${input.outcome}.`, input.summary, `Outstanding: ${input.outstandingFindings.join("; ") || "none"}.`, `Decisions: ${input.decisions.join("; ") || "none"}.`, `Next: ${input.nextAction}`];
	return `${lines.join("\n\n")}\n\n${HANDOFF_V3_PREFIX}${payload} -->`;
}

export function parseAloopHandoffV3(body: string): AloopHandoffV3 | null {
	const start = body.indexOf(HANDOFF_V3_PREFIX);
	if (start < 0) return null;
	const encoded = body.slice(start + HANDOFF_V3_PREFIX.length).split(" -->", 1)[0]?.trim();
	if (!encoded) return null;
	try {
		const value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
		const strings = (items: unknown) => Array.isArray(items) && items.every((item) => typeof item === "string");
		const outcomes = ["accepted", "incomplete", "decision-required", "environment-blocked", "rejected"];
		const expectedKeys = ["attemptKey", "commitRange", "decisions", "issue", "issueBaseCommit", "nextAction", "outcome", "outstandingFindings", "summary", "timestamp", "verification", "version"];
		const exactKeys = value && typeof value === "object" && !Array.isArray(value) && JSON.stringify(Object.keys(value).sort()) === JSON.stringify(expectedKeys);
		const valid = exactKeys && value?.version === 3 && Number.isInteger(value.issue) && value.issue > 0
			&& typeof value.issueBaseCommit === "string" && /^[0-9a-f]{7,64}$/i.test(value.issueBaseCommit)
			&& typeof value.commitRange === "string" && /^[0-9a-f]{7,64}\.\.[0-9a-f]{7,64}$/i.test(value.commitRange)
			&& value.commitRange.split("..", 1)[0] === value.issueBaseCommit
			&& outcomes.includes(value.outcome) && typeof value.summary === "string" && value.summary.trim()
			&& strings(value.outstandingFindings) && strings(value.decisions) && strings(value.verification)
			&& typeof value.nextAction === "string" && value.nextAction.trim()
			&& typeof value.attemptKey === "string" && /^[a-f0-9]{24}$/.test(value.attemptKey)
			&& typeof value.timestamp === "string" && !Number.isNaN(Date.parse(value.timestamp));
		return valid ? value as AloopHandoffV3 : null;
	} catch { return null; }
}

export type AloopAttemptHandoff = {
	version: 1;
	issue: number;
	attemptType: "implementation" | "remediation";
	commit: string | null;
	verificationReceiptId?: string;
	successful: boolean;
	approach: string;
	materiallyNewApproach: boolean;
	verification: string[];
	acceptanceCriteriaAssessment: string[];
	discoveredWork: string[];
	nextAction: string;
	artifactDirectory: string;
	timestamp: string;
};

export const DEFAULT_ALOOP_MAX_MINUTES = 60;
export const DEFAULT_ALOOP_MAX_WORKER_LAUNCHES = 20;
export const MAX_ALOOP_MINUTES = 240;
export const MAX_ALOOP_WORKER_LAUNCHES = 20;

export type AloopRunRequest = {
	epic: number;
	maxMinutes: number;
	maxWorkerLaunches: number;
};

export type AloopAttemptRecord = {
	issue: number;
	commit: string | null;
	artifactDirectory: string;
	status: string;
};

export type AloopRunBudget = {
	deadlineMs: number;
	maxWorkerLaunches: number;
	workerLaunchesStarted: number;
	settled: boolean;
};

export type VerificationReceipt = {
	commit: string;
	command: string[];
	exitStatus: number;
	timestamp: string;
	sourceIdentity: string;
	derivationIdentity?: string;
	productionIntegration?: string[];
	productionIntegrationExitStatus?: number;
};

export type SupervisorAttemptGate = {
	allowed: boolean;
	reasons: string[];
};

export type ClosureEvidence = {
	verification: Array<{ check: string; passed: boolean; evidence: string }>;
	acceptanceCriteria: Array<{ criterion: string; satisfied: boolean; evidence: string }>;
	descendantReviews: Array<{ issue: number; reviewed: boolean; evidence: string }>;
};

export function evaluateSupervisorAttempt(input: {
	returnedCommit: string | null;
	currentHead: string;
	worktreeStatus: string;
	receipt: VerificationReceipt | null;
	acceptanceCriteria: Array<{ satisfied: boolean; evidence: string }>;
	productionIntegrationRequired?: boolean;
	productionIntegrationEvidence?: string;
}): SupervisorAttemptGate {
	const reasons: string[] = [];
	if (!input.returnedCommit) reasons.push("The worker returned no valid commit.");
	if (input.returnedCommit && input.currentHead !== input.returnedCommit) reasons.push("The returned commit differs from the current Git HEAD.");
	if (input.worktreeStatus.trim()) reasons.push("The worktree changed after verification.");
	if (!input.receipt) reasons.push("Independent supervisor verification has no durable receipt.");
	else {
		if (input.receipt.commit !== input.returnedCommit || input.receipt.commit !== input.currentHead) reasons.push("The verification receipt is bound to a different commit.");
		if (input.receipt.exitStatus !== 0) reasons.push(`Supervisor verification failed with exit status ${input.receipt.exitStatus}.`);
		if (input.receipt.command.length === 0 || !input.receipt.sourceIdentity.trim() || !Number.isFinite(Date.parse(input.receipt.timestamp))) reasons.push("The verification receipt is incomplete.");
	}
	if (input.acceptanceCriteria.some((criterion) => !criterion.satisfied || !criterion.evidence.trim())) reasons.push("At least one acceptance criterion lacks passing evidence.");
	if (input.productionIntegrationRequired && !input.productionIntegrationEvidence?.trim()) reasons.push("Production packaging or entry-point reachability is unproven.");
	return { allowed: reasons.length === 0, reasons };
}

function positiveBoundedInteger(value: string, option: string, maximum: number): number {
	if (!/^\d+$/.test(value)) throw new Error(`${option} must be a positive integer.`);
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) throw new Error(`${option} must be between 1 and ${maximum}.`);
	return parsed;
}

export function parseAloopRunRequest(value: string): AloopRunRequest {
	const tokens = value.trim().split(/\s+/).filter(Boolean);
	const epicMatch = tokens.shift()?.match(/^#?(\d+)$/);
	if (!epicMatch) throw new Error("Usage: /aloop #<epic> [--max-minutes <1-240>] [--max-worker-launches <1-20>]");
	const epic = positiveBoundedInteger(epicMatch[1]!, "Epic number", Number.MAX_SAFE_INTEGER);
	let maxMinutes = DEFAULT_ALOOP_MAX_MINUTES;
	let maxWorkerLaunches = DEFAULT_ALOOP_MAX_WORKER_LAUNCHES;
	const seen = new Set<string>();
	while (tokens.length > 0) {
		const token = tokens.shift()!;
		const equals = token.match(/^(--max-minutes|--max-worker-launches)=(.+)$/);
		const option = equals?.[1] ?? token;
		if (option !== "--max-minutes" && option !== "--max-worker-launches") throw new Error(`Unknown /aloop option: ${token}`);
		if (seen.has(option)) throw new Error(`Duplicate /aloop option: ${option}`);
		seen.add(option);
		const raw = equals?.[2] ?? tokens.shift();
		if (!raw) throw new Error(`${option} requires a value.`);
		if (option === "--max-minutes") maxMinutes = positiveBoundedInteger(raw, option, MAX_ALOOP_MINUTES);
		else maxWorkerLaunches = positiveBoundedInteger(raw, option, MAX_ALOOP_WORKER_LAUNCHES);
	}
	return { epic, maxMinutes, maxWorkerLaunches };
}

export type AloopBudgetAssessment = {
	allowed: boolean;
	reason?: string;
	remainingMs: number;
	workerLaunchesRemaining: number;
	finalPermittedWorkerLaunch: boolean;
};

export function assessAloopRunBudget(budget: AloopRunBudget, nowMs: number): AloopBudgetAssessment {
	const remainingMs = Math.max(0, budget.deadlineMs - nowMs);
	const workerLaunchesRemaining = Math.max(0, budget.maxWorkerLaunches - budget.workerLaunchesStarted);
	const assessment = { remainingMs, workerLaunchesRemaining, finalPermittedWorkerLaunch: workerLaunchesRemaining === 1 };
	if (budget.settled) return { ...assessment, allowed: false, reason: "This aloop invocation has settled. Run /aloop again to continue from durable state." };
	if (remainingMs === 0) return { ...assessment, allowed: false, reason: "This aloop invocation reached its time limit. Run /aloop again to continue from durable state." };
	if (workerLaunchesRemaining === 0) return { ...assessment, allowed: false, reason: `This aloop invocation reached its ${budget.maxWorkerLaunches}-worker-launch limit. Run /aloop again to continue from durable state.` };
	return { ...assessment, allowed: true };
}

function bounded(value: string, limit: number): string {
	return value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 1))}…`;
}

function normalizedText(value: string): string {
	return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function boundedStrings(values: string[], count = 8, length = 250): string[] {
	return values.slice(0, count).map((value) => bounded(value, length));
}

export function normalizeAloopHandoff(input: Omit<AloopAttemptHandoff, "version"> & { version?: 1 }): AloopAttemptHandoff {
	if (!Number.isInteger(input.issue) || input.issue < 1) throw new Error("Aloop handoff issue must be a positive integer.");
	if (input.attemptType !== "implementation" && input.attemptType !== "remediation") throw new Error("Aloop handoff attemptType is invalid.");
	if (input.commit !== null && !/^[0-9a-f]{7,64}$/i.test(input.commit)) throw new Error("Aloop handoff commit must be a Git object ID or null.");
	if (input.verificationReceiptId !== undefined && !/^verify-[0-9a-f]{12}-[0-9]+-[0-9a-f]{8}$/.test(input.verificationReceiptId)) throw new Error("Aloop handoff verification receipt ID is invalid.");
	if (typeof input.successful !== "boolean" || typeof input.materiallyNewApproach !== "boolean") throw new Error("Aloop handoff outcome flags are invalid.");
	if (![input.verification, input.acceptanceCriteriaAssessment, input.discoveredWork].every((items) => Array.isArray(items) && items.every((item) => typeof item === "string"))) {
		throw new Error("Aloop handoff evidence fields must be string arrays.");
	}
	if (typeof input.timestamp !== "string" || !Number.isFinite(Date.parse(input.timestamp))) throw new Error("Aloop handoff timestamp is invalid.");
	if (![input.approach, input.nextAction, input.artifactDirectory].every((value) => typeof value === "string" && value.trim())) {
		throw new Error("Aloop handoff requires approach, nextAction, and artifactDirectory.");
	}
	return {
		version: 1,
		issue: input.issue,
		attemptType: input.attemptType,
		commit: input.commit,
		verificationReceiptId: input.verificationReceiptId,
		successful: input.successful,
		approach: bounded(input.approach.trim(), 1_000),
		materiallyNewApproach: input.materiallyNewApproach,
		verification: boundedStrings(input.verification),
		acceptanceCriteriaAssessment: boundedStrings(input.acceptanceCriteriaAssessment),
		discoveredWork: boundedStrings(input.discoveredWork),
		nextAction: bounded(input.nextAction.trim(), 1_000),
		artifactDirectory: bounded(input.artifactDirectory.trim(), 500),
		timestamp: input.timestamp,
	};
}

export function formatAloopHandoff(input: Omit<AloopAttemptHandoff, "version"> & { version?: 1 }): string {
	const handoff = normalizeAloopHandoff(input);
	// Compact keys plus DEFLATE avoid duplicating the human-readable evidence in a
	// large Base64 JSON marker. The visible Markdown remains intentionally concise.
	const compact = { v: 2, i: handoff.issue, y: handoff.attemptType, c: handoff.commit, u: handoff.verificationReceiptId, s: handoff.successful, a: handoff.approach, n: handoff.materiallyNewApproach, q: handoff.verification, r: handoff.acceptanceCriteriaAssessment, d: handoff.discoveredWork, x: handoff.nextAction, p: handoff.artifactDirectory, t: handoff.timestamp };
	const encoded = deflateRawSync(Buffer.from(JSON.stringify(compact), "utf8"), { level: 9 }).toString("base64url");
	const list = (items: string[]) => items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : "- None";
	return `<!-- ${HANDOFF_PREFIX}${encoded} -->

## Aloop attempt handoff

- Attempt type: ${handoff.attemptType}
- Commit: ${handoff.commit ? `\`${handoff.commit}\`` : "None"}
- Verification receipt: ${handoff.verificationReceiptId ? `\`${handoff.verificationReceiptId}\`` : "None"}
- Accepted: ${handoff.successful ? "yes" : "no"}
- Approach: ${handoff.approach}
- Materially new approach: ${handoff.materiallyNewApproach ? "yes" : "no"}
- Attempt artifacts: \`${handoff.artifactDirectory}\`

### Verification
${list(handoff.verification)}

### Acceptance-criteria assessment
${list(handoff.acceptanceCriteriaAssessment)}

### Discovered work
${list(handoff.discoveredWork)}

### Next action
${handoff.nextAction}`;
}

export function parseAloopHandoffs(comments: IssueHandoff[]): AloopAttemptHandoff[] {
	const parsed: Array<AloopAttemptHandoff & { commentCreatedAt: string; commentId: number }> = [];
	for (const comment of comments) {
		const match = comment.body.match(/<!-- pi-aloop-handoff:(v[12]):([A-Za-z0-9_-]+) -->/);
		if (!match) continue;
		try {
			const payload = Buffer.from(match[2]!, "base64url");
			const decoded = match[1] === "v2" ? inflateRawSync(payload, { maxOutputLength: 64_000 }).toString("utf8") : payload.toString("utf8");
			const value = JSON.parse(decoded);
			const raw = match[1] === "v2" ? { version: 1, issue: value.i, attemptType: value.y, commit: value.c, verificationReceiptId: value.u, successful: value.s, approach: value.a, materiallyNewApproach: value.n, verification: value.q, acceptanceCriteriaAssessment: value.r, discoveredWork: value.d, nextAction: value.x, artifactDirectory: value.p, timestamp: value.t } : value;
			if (!raw || raw.version !== 1 || typeof raw !== "object") continue;
			const handoff = normalizeAloopHandoff(raw);
			parsed.push({ ...handoff, commentCreatedAt: comment.createdAt, commentId: comment.id });
		} catch {
			// Ignore malformed or manually edited markers; visible comment text remains available to the supervisor.
		}
	}
	return parsed
		.sort((left, right) => left.commentCreatedAt.localeCompare(right.commentCreatedAt) || left.commentId - right.commentId)
		.map(({ commentCreatedAt: _createdAt, commentId: _commentId, ...handoff }) => handoff);
}

export function authorizeHandoffPublication(input: {
	handoffId: string;
	dryRun: boolean;
	dryRunHandoffIds: Set<string>;
}): void {
	if (!/^[0-9a-f]{24}$/.test(input.handoffId)) throw new Error("Prepared handoff ID is invalid.");
	if (input.dryRun) {
		input.dryRunHandoffIds.add(input.handoffId);
		return;
	}
	if (!input.dryRunHandoffIds.has(input.handoffId)) {
		throw new Error(`Handoff ${input.handoffId} must complete a dry run before publication.`);
	}
}

export async function publishPreparedAloopHandoff<T>(input: {
	record: AloopHandoffSpoolRecord;
	handoffId: string;
	dryRun: boolean;
	dryRunHandoffIds: Set<string>;
	publish: (issue: number, comment: string, apply: boolean) => Promise<T>;
}): Promise<T> {
	const record = validateAloopHandoffSpoolRecord(input.record, input.handoffId);
	authorizeHandoffPublication(input);
	return await input.publish(record.issue, record.comment, !input.dryRun);
}

export type AloopHandoffSpoolRecord = {
	version: 1;
	id: string;
	issue: number;
	sha256: string;
	comment: string;
};

export function createAloopHandoffSpoolRecord(issue: number, comment: string): AloopHandoffSpoolRecord {
	const bytes = Buffer.from(comment, "utf8");
	return {
		version: 1,
		id: createHash("sha256").update(`${issue}\0`).update(bytes).digest("hex").slice(0, 24),
		issue,
		sha256: createHash("sha256").update(bytes).digest("hex"),
		comment,
	};
}

export function validateAloopHandoffSpoolRecord(value: unknown, expectedId: string): AloopHandoffSpoolRecord {
	const record = value as Partial<AloopHandoffSpoolRecord> | null;
	if (record?.version !== 1 || record.id !== expectedId || !Number.isInteger(record.issue) || typeof record.comment !== "string" || typeof record.sha256 !== "string") {
		throw new Error("Prepared handoff spool entry is malformed.");
	}
	const expected = createAloopHandoffSpoolRecord(record.issue!, record.comment);
	if (record.id !== expected.id || record.sha256 !== expected.sha256) throw new Error("Prepared handoff bytes failed integrity validation.");
	return record as AloopHandoffSpoolRecord;
}

export function handoffCommentsForIssue(issue: EpicIssueContext): IssueHandoff[] {
	return issue.recentHandoffs.filter((comment) => {
		const structured = parseAloopHandoffs([comment]);
		return structured.length === 0 || structured.some((handoff) => handoff.issue === issue.number);
	});
}

export function selectAloopLeaf(context: GitHubEpicContext, issueNumber: number): EpicIssueContext {
	if (!context.executableLeaves.includes(issueNumber)) {
		throw new Error(`#${issueNumber} is not an open, unblocked descendant leaf of epic #${context.epic.number}.`);
	}
	const issue = context.issues.find((candidate) => candidate.number === issueNumber);
	if (!issue) throw new Error(`#${issueNumber} is absent from the recursive epic context.`);
	return issue;
}

export function findOutstandingAttempts(context: GitHubEpicContext, records: AloopAttemptRecord[]): AloopAttemptRecord[] {
	const descendants = new Set(context.issues.filter((issue) => issue.number !== context.epic.number).map((issue) => issue.number));
	const recorded = new Set(context.issues.flatMap((issue) => issue.recentHandoffs.flatMap((comment) => {
		const legacy = parseAloopHandoffs([comment])
			.filter((handoff) => handoff.issue === issue.number)
			.map((handoff) => `${handoff.issue}:${handoff.commit ?? "none"}:${handoff.artifactDirectory}`);
		const v3 = parseAloopHandoffV3(comment.body);
		return v3?.issue === issue.number ? [...legacy, `v3:${v3.attemptKey}`] : legacy;
	})));
	return records
		.filter((record) => descendants.has(record.issue))
		.filter((record) => !recorded.has(`${record.issue}:${record.commit ?? "none"}:${record.artifactDirectory}`)
			&& !recorded.has(`v3:${createHash("sha256").update(`${record.issue}:${record.artifactDirectory}`).digest("hex").slice(0, 24)}`))
		.sort((left, right) => left.artifactDirectory.localeCompare(right.artifactDirectory));
}

export function nextIssueRetryNumber(handoffs: AloopAttemptHandoff[], attemptType: "implementation" | "remediation"): number {
	if (attemptType === "implementation") return 0;
	let failuresSinceAcceptance = 0;
	for (let index = handoffs.length - 1; index >= 0; index -= 1) {
		if (handoffs[index]!.successful) break;
		failuresSinceAcceptance += 1;
	}
	return Math.max(1, failuresSinceAcceptance);
}

export function evaluateRetryBoundary(
	handoffs: AloopAttemptHandoff[],
	materiallyNewApproach: boolean,
): { allowed: boolean; unsuccessfulAttempts: number; reason?: string } {
	let unsuccessfulAttempts = 0;
	for (let index = handoffs.length - 1; index >= 0; index -= 1) {
		const handoff = handoffs[index]!;
		if (handoff.successful || handoff.materiallyNewApproach) break;
		unsuccessfulAttempts += 1;
	}
	if (unsuccessfulAttempts >= 2 && !materiallyNewApproach) {
		return {
			allowed: false,
			unsuccessfulAttempts,
			reason: "Two unsuccessful attempts without a materially new approach require user intervention.",
		};
	}
	return { allowed: true, unsuccessfulAttempts };
}

export function validateSuccessfulHandoffEvidence(input: {
	issueBody: string;
	verification: string[];
	acceptanceCriteriaAssessment: string[];
}): string[] {
	const reasons: string[] = [];
	if (input.verification.length === 0 || input.verification.some((item) => !item.trim())) {
		reasons.push("Successful handoffs require non-empty verification evidence; the bound receipt determines mechanical pass/fail.");
	}
	const criteria = extractAcceptanceCriteria(input.issueBody);
	if (criteria.length > 0 && input.acceptanceCriteriaAssessment.length === 0) {
		reasons.push("Successful handoffs require the supervisor's acceptance assessment.");
	}
	if (input.acceptanceCriteriaAssessment.some((item) => !item.trim())) {
		reasons.push("Successful handoffs cannot contain empty acceptance assessments.");
	}
	return reasons;
}

export function extractAcceptanceCriteria(body: string): string[] {
	const lines = body.split("\n");
	const start = lines.findIndex((line) => /^##+\s+acceptance criteria\s*$/i.test(line.trim()));
	if (start < 0) return [];
	const criteria: string[] = [];
	for (const line of lines.slice(start + 1)) {
		if (/^##+\s+/.test(line.trim())) break;
		const match = line.match(/^\s*[-*]\s+(?:\[[ xX]\]\s*)?(.+?)\s*$/);
		if (match) criteria.push(match[1]!.trim());
	}
	return criteria;
}

export function recognizeClosedAloopRetry(input: {
	issue: EpicIssueContext;
	epicNumber: number;
	handoffId: string;
	receiptId: string;
}): { commit: string } {
	if (input.issue.number === input.epicNumber || input.issue.state !== "closed") throw new Error("Durable closure retry applies only to a closed descendant.");
	for (const comment of input.issue.recentHandoffs) {
		const spool = createAloopHandoffSpoolRecord(input.issue.number, comment.body);
		if (spool.id !== input.handoffId) continue;
		const [handoff] = parseAloopHandoffs([comment]);
		if (!handoff?.successful || !handoff.commit) throw new Error("Only a successful commit-bearing handoff identifies a completed closure.");
		if (handoff.verificationReceiptId !== input.receiptId) throw new Error("The published handoff is bound to a different supervisor verification receipt.");
		return { commit: handoff.commit };
	}
	throw new Error("No exact published handoff identifies this completed closure.");
}

export type AloopClosureReceipt = VerificationReceipt & {
	postVerificationHead: string;
	postVerificationClean: boolean;
};

export async function closeAcceptedAloopIssue<T>(input: {
	issue: EpicIssueContext;
	epicNumber: number;
	handoffId: string;
	spool: AloopHandoffSpoolRecord;
	receiptId: string;
	receipt: AloopClosureReceipt;
	currentHead: string;
	worktreeStatus: string;
	dryRun: boolean;
	dryRunClosureIds: Set<string>;
	close: (issue: number) => Promise<T>;
}): Promise<{ applied: boolean; alreadyClosed: boolean; result?: T; commit: string }> {
	if (input.issue.number === input.epicNumber) throw new Error("Receipt-gated closure applies only to a descendant of the active epic.");
	if (input.spool.issue !== input.issue.number) throw new Error("Prepared handoff does not identify this issue.");
	const spool = validateAloopHandoffSpoolRecord(input.spool, input.handoffId);
	if (!input.issue.recentHandoffs.some((comment) => comment.body === spool.comment)) throw new Error("The exact prepared handoff is not durably published on GitHub.");
	const [handoff] = parseAloopHandoffs([{ id: 0, author: "aloop", body: spool.comment, createdAt: "", url: "" }]);
	if (!handoff?.successful || !handoff.commit) throw new Error("Only a successful commit-bearing handoff may close an issue.");
	if (handoff.verificationReceiptId !== input.receiptId) throw new Error("The published handoff is bound to a different supervisor verification receipt.");
	const closureId = `${input.issue.number}:${input.handoffId}:${input.receiptId}`;
	// Once GitHub records the issue as closed, an exact published handoff is the
	// durable idempotency key. A later commit must not turn a successful retry
	// into an error or invoke closure a second time.
	if (input.issue.state === "closed") return { applied: false, alreadyClosed: true, commit: handoff.commit };
	if (input.dryRun) input.dryRunClosureIds.add(closureId);
	else if (!input.dryRunClosureIds.has(closureId)) throw new Error("Accepted issue closure must complete a dry run before apply.");
	const evidenceReasons = validateSuccessfulHandoffEvidence({
		issueBody: input.issue.body,
		verification: handoff.verification,
		acceptanceCriteriaAssessment: handoff.acceptanceCriteriaAssessment,
	});
	if (evidenceReasons.length > 0) throw new Error(`Closure blocked: ${evidenceReasons.join("; ")}.`);
	const gate = evaluateSupervisorAttempt({
		returnedCommit: handoff.commit,
		currentHead: input.currentHead,
		worktreeStatus: input.worktreeStatus,
		receipt: input.receipt,
		acceptanceCriteria: [{ satisfied: true, evidence: "The published handoff records supervisor acceptance." }],
		productionIntegrationRequired: input.receipt.productionIntegration !== undefined,
		productionIntegrationEvidence: input.receipt.productionIntegrationExitStatus === 0 ? input.receipt.productionIntegration?.join(" ") : undefined,
	});
	if (!gate.allowed || input.receipt.postVerificationHead !== handoff.commit || input.receipt.postVerificationClean !== true) {
		throw new Error(`Closure blocked: ${[...gate.reasons, "the published handoff, receipt, and current clean Git commit must match"].join("; ")}.`);
	}
	if (input.dryRun) return { applied: false, alreadyClosed: false, commit: handoff.commit };
	const result = await input.close(input.issue.number);
	return { applied: true, alreadyClosed: false, result, commit: handoff.commit };
}

export function evaluateEpicClosure(context: GitHubEpicContext, evidence: ClosureEvidence): { allowed: boolean; reasons: string[] } {
	const reasons: string[] = [];
	const descendants = context.issues.filter((issue) => issue.number !== context.epic.number);
	const open = descendants.filter((issue) => issue.state !== "closed").map((issue) => `#${issue.number}`);
	if (open.length > 0) reasons.push(`Open descendants remain: ${open.join(", ")}.`);

	const reviews = new Map(evidence.descendantReviews.map((review) => [review.issue, review]));
	const missingReviews = descendants
		.filter((issue) => !reviews.get(issue.number)?.reviewed || !reviews.get(issue.number)?.evidence.trim())
		.map((issue) => `#${issue.number}`);
	if (missingReviews.length > 0) reasons.push(`Descendant review evidence is missing: ${missingReviews.join(", ")}.`);

	if (evidence.verification.length === 0) reasons.push("No project verification evidence was supplied.");
	const failedChecks = evidence.verification.filter((check) => !check.passed || !check.evidence.trim()).map((check) => check.check);
	if (failedChecks.length > 0) reasons.push(`Project verification is incomplete or failed: ${failedChecks.join(", ")}.`);

	const expectedCriteria = extractAcceptanceCriteria(context.issues.find((issue) => issue.number === context.epic.number)?.body ?? "");
	const assessments = new Map(evidence.acceptanceCriteria.map((criterion) => [normalizedText(criterion.criterion), criterion]));
	const missingCriteria = expectedCriteria.filter((criterion) => {
		const assessment = assessments.get(normalizedText(criterion));
		return !assessment?.satisfied || !assessment.evidence.trim();
	});
	if (expectedCriteria.length === 0) reasons.push("The epic body contains no parseable acceptance criteria.");
	else if (missingCriteria.length > 0) reasons.push(`Epic acceptance criteria lack passing evidence: ${missingCriteria.join(" | ")}.`);

	return { allowed: reasons.length === 0, reasons };
}

function issueLine(issue: EpicIssueContext): string {
	const blockers = issue.blockers.filter((blocker) => blocker.state === "open").map((blocker) => `#${blocker.number}`);
	return `- #${issue.number} ${bounded(issue.title, 120)} — ${issue.state}; children=${issue.children.length}; open blockers=${blockers.join(",") || "none"}; assignee=${issue.assignee ?? "none"}`;
}

export function buildSupervisorKickoff(
	context: GitHubEpicContext,
	gitHistory: string,
	outstandingAttempts: AloopAttemptRecord[] = [],
	budget?: { deadlineMs: number; maxWorkerLaunches: number },
): string {
	const epicIssue = context.issues.find((issue) => issue.number === context.epic.number);
	const descendants = context.issues.filter((issue) => issue.number !== context.epic.number);
	const closedDescendants = descendants.filter((issue) => issue.state === "closed").length;
	const handoffLines = context.issues.flatMap((issue) => issue.recentHandoffs.flatMap((comment) => {
		const v3 = parseAloopHandoffV3(comment.body);
		if (v3?.issue === issue.number) return [`- #${issue.number} ${v3.outcome} ${v3.commitRange}: next=${bounded(v3.nextAction, 300)}`];
		return parseAloopHandoffs([comment]).filter((handoff) => handoff.issue === issue.number)
			.map((handoff) => `- #${issue.number} ${handoff.attemptType} ${handoff.commit ?? "no-commit"}: accepted=${handoff.successful}; next=${bounded(handoff.nextAction, 300)}`);
	}).slice(-3));
	return `Act as the LLM-led aloop supervisor for GitHub epic #${context.epic.number}: ${context.epic.title}.

Epic goal and acceptance criteria:
${bounded(epicIssue?.body ?? "", 12_000)}

Epic child progress: ${closedDescendants}/${descendants.length} closed; ${descendants.length - closedDescendants} open.

Recursive issue state:
${context.issues.map(issueLine).join("\n")}

Currently executable leaves (labels and assignments are advisory):
${context.executableLeaves.map((number) => `#${number}`).join(", ") || "none"}

Recent structured attempt handoffs:
${handoffLines.join("\n") || "- None"}

Outstanding attempt artifacts without durable GitHub handoffs:
${outstandingAttempts.length > 0 ? outstandingAttempts.map((attempt) => `- #${attempt.issue} ${attempt.commit ?? "no-commit"} ${attempt.status}: ${attempt.artifactDirectory}`).join("\n") : "- None"}

Recent Git history:
${bounded(gitHistory || "(no commits returned)", 8_000)}

Invocation resource budget:
${budget ? `- Hard deadline: ${new Date(budget.deadlineMs).toISOString()}\n- Maximum worker launches: ${budget.maxWorkerLaunches}` : "- Use the configured hard deadline and worker-launch cap."}

Operating procedure:
1. GitHub and Git are authoritative. Use aloop_context as the cached navigation view; request refresh only when external GitHub state may have changed.
2. Select one open, unblocked descendant leaf and call aloop_launch_worker. Full workers are fresh and sequential; labels and assignments are advisory.
3. For every returned or recovered attempt, call aloop_review_attempt. Use aloop_apply_patch for a narrow correction, a fresh full remediation worker for substantial work, or a trivial direct edit only when clearly safe. Review again after changes.
4. Call aloop_finish_attempt exactly once for the full attempt. It owns canonical verification, v3 handoff publication, accepted-child closure, crash recovery, and next-frontier selection. Never call legacy receipt/spool/closure tools.
5. If independent review is unavailable, canonical verification fails, or product/scope ambiguity needs a human, use aloop_checkpoint and stop. There is no semantic retry-count gate.
6. Continue review, optional remediation, finalization, and next-child selection until worker bounds or a genuine decision boundary. The implementation deadline and 20-launch cap stop new full workers; supervisor settlement may continue.
7. When all descendants are closed, call aloop_epic_completion with phase=prepare. Request explicit human approval, then call phase=apply with approved=true only for the unchanged prepared HEAD.
8. End with a concise report of completed children, commits, verification, deferred work, and the human-decision or epic-approval state.

Do not push. Do not restore tk or create ticket files. Keep working in this supervisor turn until the epic is complete or a genuine human decision is required.`;
}

export function buildEpicReport(input: {
	epicNumber: number;
	closed: boolean;
	completedIssues: Array<{ number: number; title: string; commit?: string | null }>;
	verification: string[];
	deferredWork: string[];
	humanDecision?: string;
}): string {
	const lines = [
		`Epic #${input.epicNumber}: ${input.closed ? "closed" : "stopped"}.`,
		"Completed children:",
		...(input.completedIssues.length > 0
			? input.completedIssues.map((issue) => `- #${issue.number} ${issue.title}${issue.commit ? ` (${issue.commit})` : ""}`)
			: ["- None"]),
		"Verification:",
		...(input.verification.length > 0 ? input.verification.map((item) => `- ${item}`) : ["- None recorded"]),
		"Deferred or discovered work:",
		...(input.deferredWork.length > 0 ? input.deferredWork.map((item) => `- ${item}`) : ["- None"]),
	];
	if (input.humanDecision) lines.push("Human decision required:", `- ${input.humanDecision}`);
	return lines.join("\n");
}
