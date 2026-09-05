import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import type { EpicIssueContext, GitHubEpicContext, IssueHandoff } from "../github-issues/github-context.js";

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

const REDACTED_HANDOFF_VALUE = "•";
export const ALOOP_HANDOFF_LIMITS = { summary: 200, nextAction: 200, findings: 6, finding: 80, decisions: 4, decision: 80, verificationItems: 6, verification: 100 } as const;

/** Removes local recovery plumbing before any caller-provided text reaches a GitHub handoff. */
function redactHandoffText(value: string): string {
	return value
		.replace(/\bfile:\/\/[^\s<>"']+/gi, REDACTED_HANDOFF_VALUE)
		.replace(/\b[A-Za-z]:[\\/][^\s<>"']+/g, REDACTED_HANDOFF_VALUE)
		.replace(/~[A-Za-z0-9._-]*[\\/][^\s<>"']+/g, REDACTED_HANDOFF_VALUE)
		.replace(/\\{1,2}[^\s<>"']+/g, REDACTED_HANDOFF_VALUE)
		.replace(/(^|[^A-Za-z0-9_\/])\/(?!\/)[^\s<>"']+/g, `$1${REDACTED_HANDOFF_VALUE}`)
		.replace(/\b\.pi\/tmp(?:\/[^\s<>"']*)?/g, REDACTED_HANDOFF_VALUE)
		.replace(/\bverify-[a-f0-9]{12}-\d+-[a-f0-9]{8}\b/gi, REDACTED_HANDOFF_VALUE)
		.replace(/\bspool(?:\s+(?:id|identifier))?\s*(?:[:=]\s*|\s+)[a-f0-9]{24,64}\b/gi, `spool ${REDACTED_HANDOFF_VALUE}`)
		.replace(/\b(?:spool|blob)-[a-z0-9][a-z0-9_-]{7,}\b/gi, REDACTED_HANDOFF_VALUE)
		.replace(/(?:<!--\s*)?pi-aloop-recovery-authorization:v\d+:[a-z0-9_-]+(?:\s*-->)?/gi, REDACTED_HANDOFF_VALUE);
}

export function normalizeAloopHandoffV3(input: AloopHandoffV3): AloopHandoffV3 {
	const text = (value: string) => redactHandoffText(value);
	const list = (values: string[]) => values.map(text);
	return { ...input, summary: text(input.summary), outstandingFindings: list(input.outstandingFindings), decisions: list(input.decisions), verification: list(input.verification), nextAction: text(input.nextAction) };
}

function visibleHandoffText(value: string): string {
	return value.replaceAll("<!--", "&lt;!--").replaceAll("-->", "--&gt;");
}

export function formatAloopHandoffV3(input: AloopHandoffV3): string {
	const limits = ALOOP_HANDOFF_LIMITS;
	const boundedList = (values: string[], count: number, length: number) => values.length <= count && values.every((value) => Array.from(value).length <= length);
	if (input.version !== 3 || !["accepted", "incomplete", "decision-required", "environment-blocked", "rejected"].includes(input.outcome)
		|| !Number.isInteger(input.issue) || input.issue <= 0 || !/^[0-9a-f]{7,64}$/i.test(input.issueBaseCommit)
		|| !/^[0-9a-f]{7,64}\.\.[0-9a-f]{7,64}$/i.test(input.commitRange) || input.commitRange.split("..", 1)[0] !== input.issueBaseCommit
		|| !/^[a-f0-9]{24}$/.test(input.attemptKey) || input.timestamp.length > 64 || Number.isNaN(Date.parse(input.timestamp))
		|| Array.from(input.summary).length > limits.summary || Array.from(input.nextAction).length > limits.nextAction
		|| !boundedList(input.outstandingFindings, limits.findings, limits.finding) || !boundedList(input.decisions, limits.decisions, limits.decision)
		|| !boundedList(input.verification, limits.verificationItems, limits.verification)
		|| (input.outcome === "accepted" && input.outstandingFindings.length > 0)) {
		throw new Error("Invalid fixed fields in aloop v3 handoff.");
	}
	const handoff = normalizeAloopHandoffV3(input);
	const payload = Buffer.from(JSON.stringify(handoff), "utf8").toString("base64url");
	const lines = handoff.outcome === "accepted"
		? [`Aloop accepted ${handoff.commitRange}.`, handoff.summary, "Outstanding: none.", `Decisions: ${handoff.decisions.join("; ") || "none"}.`, `Verification: ${handoff.verification.join("; ") || "none"}.`, `Next: ${handoff.nextAction}`]
		: [`Aloop attempt settled as ${handoff.outcome}.`, handoff.summary, `Outstanding: ${handoff.outstandingFindings.join("; ") || "none"}.`, `Decisions: ${handoff.decisions.join("; ") || "none"}.`, `Verification: ${handoff.verification.join("; ") || "none"}.`, `Next: ${handoff.nextAction}`];
	const body = `${lines.map(visibleHandoffText).join("\n\n")}\n\n${HANDOFF_V3_PREFIX}${payload} -->`;
	if (Buffer.byteLength(body) > 19_000) throw new Error("Aloop v3 handoff exceeds the safe GitHub retrieval bound.");
	return body;
}

export function parseAloopHandoffV3(body: string): AloopHandoffV3 | null {
	if (Buffer.byteLength(body) > 20_000) return null;
	const encodedPayloads = [...body.matchAll(/<!-- pi-aloop-handoff:v3:([A-Za-z0-9_-]+) -->/g)].map((match) => match[1]!).reverse();
	for (const encoded of encodedPayloads) try {
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
			&& Array.from(value.summary).length <= ALOOP_HANDOFF_LIMITS.summary
			&& value.outstandingFindings.length <= ALOOP_HANDOFF_LIMITS.findings && value.outstandingFindings.every((item: string) => Array.from(item).length <= ALOOP_HANDOFF_LIMITS.finding)
			&& value.decisions.length <= ALOOP_HANDOFF_LIMITS.decisions && value.decisions.every((item: string) => Array.from(item).length <= ALOOP_HANDOFF_LIMITS.decision)
			&& value.verification.length <= ALOOP_HANDOFF_LIMITS.verificationItems && value.verification.every((item: string) => Array.from(item).length <= ALOOP_HANDOFF_LIMITS.verification)
			&& !(value.outcome === "accepted" && value.outstandingFindings.length > 0)
			&& typeof value.nextAction === "string" && value.nextAction.trim() && Array.from(value.nextAction).length <= ALOOP_HANDOFF_LIMITS.nextAction
			&& typeof value.attemptKey === "string" && /^[a-f0-9]{24}$/.test(value.attemptKey)
			&& typeof value.timestamp === "string" && value.timestamp.length <= 64 && !Number.isNaN(Date.parse(value.timestamp));
		if (valid) return value as AloopHandoffV3;
	} catch { /* Continue to an earlier marker only when a later candidate is invalid. */ }
	return null;
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
	beforeHead?: string;
	issueBaseCommit?: string;
	preservation?: import("../github-issues/aloop-preservation.js").PreservationEvidence;
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

function parseLegacyAloopHandoff(value: unknown): AloopAttemptHandoff | null {
	const input = value as Partial<AloopAttemptHandoff> | null;
	if (!input || input.version !== 1 || typeof input.issue !== "number" || !Number.isInteger(input.issue) || input.issue < 1
		|| (input.attemptType !== "implementation" && input.attemptType !== "remediation")
		|| (input.commit !== null && (typeof input.commit !== "string" || !/^[0-9a-f]{7,64}$/i.test(input.commit)))
		|| (input.verificationReceiptId !== undefined && (typeof input.verificationReceiptId !== "string" || !/^verify-[a-f0-9]{12}-[0-9]+-[a-f0-9]{8}$/.test(input.verificationReceiptId)))
		|| typeof input.successful !== "boolean" || typeof input.approach !== "string" || typeof input.materiallyNewApproach !== "boolean"
		|| ![input.verification, input.acceptanceCriteriaAssessment, input.discoveredWork].every((items) => Array.isArray(items) && items.every((item) => typeof item === "string"))
		|| typeof input.nextAction !== "string" || typeof input.artifactDirectory !== "string" || typeof input.timestamp !== "string"
		|| !Number.isFinite(Date.parse(input.timestamp))) return null;
	return input as AloopAttemptHandoff;
}

/** Read-only compatibility for v1/v2 comments written by older aloop versions. */
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
			const handoff = parseLegacyAloopHandoff(raw);
			if (handoff) parsed.push({ ...handoff, commentCreatedAt: comment.createdAt, commentId: comment.id });
		} catch { /* Ignore malformed legacy comments. */ }
	}
	return parsed
		.sort((left, right) => left.commentCreatedAt.localeCompare(right.commentCreatedAt) || left.commentId - right.commentId)
		.map(({ commentCreatedAt: _createdAt, commentId: _commentId, ...handoff }) => handoff);
}

export function selectAloopLeaf(context: GitHubEpicContext, issueNumber: number): EpicIssueContext {
	if (!context.executableLeaves.includes(issueNumber)) {
		throw new Error(`#${issueNumber} is not an open, unblocked descendant leaf of epic #${context.epic.number}.`);
	}
	const issue = context.issues.find((candidate) => candidate.number === issueNumber);
	if (!issue) throw new Error(`#${issueNumber} is absent from the recursive epic context.`);
	return issue;
}

export type AloopAcceptedRecoveryRecord = { issue: number; head: string; commentSha256: string };

type CurrentStateHandoff = { handoff: AloopHandoffV3; body: string; author: string | null; url: string | null };

/** The newest valid v3 snapshot is authoritative; malformed comments are not state snapshots. */
export function latestCurrentStateHandoff(issue: Pick<EpicIssueContext, "number" | "recentHandoffs">): CurrentStateHandoff | null {
	for (const comment of [...issue.recentHandoffs].reverse()) {
		const handoff = parseAloopHandoffV3(comment.body);
		if (handoff?.issue === issue.number) return { handoff, body: comment.body, author: comment.author, url: comment.url };
	}
	return null;
}

/** Validates the single current v3 state used by both recovery and epic closure evidence. */
export function validatedAcceptedCurrentStateHandoff(issue: Pick<EpicIssueContext, "number" | "recentHandoffs">, expectedHead?: string, trustedAuthor?: string | null): CurrentStateHandoff | null {
	const current = latestCurrentStateHandoff(issue);
	if (!current || current.handoff.outcome !== "accepted" || current.handoff.outstandingFindings.length !== 0) return null;
	const head = current.handoff.commitRange.split("..").at(-1)!;
	if (expectedHead !== undefined && head !== expectedHead) return null;
	const independentReview = current.handoff.verification.some((item) => item === `Independent review completed at ${head}.`);
	const reviewOpen = new Map<string, string | null>();
	const reviewResolved = new Map<string, string | null>();
	for (const comment of issue.recentHandoffs) {
		const open = comment.body.match(/pi-aloop-review-decision:([a-f0-9]{20}):([a-f0-9]{7,64}):open/);
		if (open?.[2] === head) reviewOpen.set(open[1]!, comment.author);
		const resolved = comment.body.match(/pi-aloop-review-decision:([a-f0-9]{20}):([a-f0-9]{7,64}):resolved/);
		if (resolved?.[2] === head) reviewResolved.set(resolved[1]!, comment.author);
	}
	const humanReview = trustedAuthor !== null && trustedAuthor !== undefined && [...reviewOpen].some(([marker, author]) => author === trustedAuthor && reviewResolved.get(marker) === trustedAuthor);
	const reviewed = independentReview || humanReview;
	const verified = current.handoff.verification.some((item) => item === `Canonical command passed at ${head}.`);
	return reviewed && verified ? current : null;
}

export function validatedChildReviewEvidence(issue: Pick<EpicIssueContext, "number" | "recentHandoffs">, trustedAuthor: string | null): string | null {
	if (!trustedAuthor) return null;
	const current = validatedAcceptedCurrentStateHandoff(issue, undefined, trustedAuthor);
	if (!current || current.author !== trustedAuthor) return null;
	const head = current.handoff.commitRange.split("..").at(-1)!;
	return `Accepted v3 handoff ${current.url ?? "recorded on GitHub"} binds review and canonical verification to ${head}.`;
}

export function acceptedOpenAloopIssues(context: GitHubEpicContext, recoveryRecords?: ReadonlyMap<string, AloopAcceptedRecoveryRecord>): number[] {
	return context.issues
		.filter((issue) => issue.number !== context.epic.number && issue.state === "open")
		.filter((issue) => {
			const latest = issue.recentHandoffs
				.map((comment) => ({ handoff: parseAloopHandoffV3(comment.body), body: comment.body }))
				.filter((entry): entry is { handoff: AloopHandoffV3; body: string } => entry.handoff?.issue === issue.number)
				.at(-1);
			if (latest?.handoff.outcome !== "accepted") return false;
			if (!recoveryRecords) return true;
			const record = recoveryRecords.get(latest.handoff.attemptKey);
			return record?.issue === issue.number
				&& record.head === latest.handoff.commitRange.split("..").at(-1)
				&& record.commentSha256 === createHash("sha256").update(latest.body).digest("hex");
		})
		.map((issue) => issue.number)
		.sort((left, right) => left - right);
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

Accepted handoffs awaiting child closure:
${acceptedOpenAloopIssues(context).map((number) => `#${number}`).join(", ") || "- None"}

Outstanding attempt artifacts without durable GitHub handoffs:
${outstandingAttempts.length > 0 ? outstandingAttempts.map((attempt) => `- #${attempt.issue} ${attempt.commit ?? "no-commit"} ${attempt.status}: ${attempt.artifactDirectory}`).join("\n") : "- None"}

Recent Git history:
${bounded(gitHistory || "(no commits returned)", 8_000)}

Invocation resource budget:
${budget ? `- Hard deadline: ${new Date(budget.deadlineMs).toISOString()}\n- Maximum worker launches: ${budget.maxWorkerLaunches}` : "- Use the configured hard deadline and worker-launch cap."}

Operating procedure:
1. GitHub and Git are authoritative. Use aloop_context as the cached navigation view; request refresh only when external GitHub state may have changed. First recover any accepted handoff awaiting child closure by calling aloop_finish_attempt for that issue; never launch a duplicate worker for it.
2. Select one open, unblocked descendant leaf and call aloop_launch_worker. Full workers are fresh and sequential; labels and assignments are advisory.
3. For every returned or recovered attempt, call aloop_review_attempt. Use aloop_apply_patch for a narrow correction, a fresh full remediation worker for substantial work, or a trivial direct edit only when clearly safe. Review again after changes.
4. Call aloop_finish_attempt exactly once for the full attempt. It owns canonical verification, v3 handoff publication, accepted-child closure, crash recovery, and next-frontier selection. Never call legacy receipt/spool/closure tools.
5. If independent review is unavailable, canonical verification fails, or product/scope ambiguity needs a human, use aloop_checkpoint and stop. There is no semantic retry-count gate.
6. Continue review, optional remediation, finalization, and next-child selection until worker bounds or a genuine decision boundary. The implementation deadline and 20-launch cap stop new full workers; supervisor settlement may continue.
7. When all descendants are closed, call aloop_epic_completion with phase=prepare and complete final review/acceptance evidence. Request explicit human approval, then call phase=apply only for the unchanged prepared HEAD.
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
