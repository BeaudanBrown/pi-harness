import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EpicIssueContext, GitHubEpicContext, IssueHandoff } from "../config/agent/extensions/github-issues/github-context.js";
import {
	assessAloopRunBudget,
	buildEpicReport,
	buildSupervisorKickoff,
	evaluateEpicClosure,
	evaluateRetryBoundary,
	evaluateSupervisorAttempt,
	findOutstandingAttempts,
	formatAloopHandoff,
	handoffCommentsForIssue,
	parseAloopHandoffs,
	parseAloopRunRequest,
	requireAloopClaim,
	selectAloopLeaf,
	validateSuccessfulHandoffEvidence,
	type AloopAttemptHandoff,
} from "../config/agent/extensions/aloop/core.js";

function issue(overrides: Partial<EpicIssueContext> & Pick<EpicIssueContext, "number" | "title">): EpicIssueContext {
	return {
		number: overrides.number,
		title: overrides.title,
		body: overrides.body ?? "",
		state: overrides.state ?? "open",
		labels: overrides.labels ?? [],
		assignee: overrides.assignee ?? null,
		parent: overrides.parent ?? null,
		container: overrides.container ?? { number: 1, title: "Epic", state: "open" },
		children: overrides.children ?? [],
		blockers: overrides.blockers ?? [],
		recentHandoffs: overrides.recentHandoffs ?? [],
	};
}

function context(descendants?: EpicIssueContext[]): GitHubEpicContext {
	return {
		epic: { number: 1, title: "Epic", state: "open" },
		issues: [
			issue({ number: 1, title: "Epic", body: "## Acceptance criteria\n\n- All children complete\n- Verification passes", children: (descendants ?? []).map((item) => item.number) }),
			...(descendants ?? []),
		],
		executableLeaves: (descendants ?? [])
			.filter((item) => item.state === "open" && item.children.length === 0 && !item.blockers.some((blocker) => blocker.state === "open"))
			.map((item) => item.number),
	};
}

function handoff(overrides: Partial<AloopAttemptHandoff> = {}): AloopAttemptHandoff {
	return {
		version: 1,
		issue: 2,
		attemptType: "implementation",
		commit: "abcdef1",
		successful: false,
		approach: "Initial approach",
		materiallyNewApproach: false,
		verification: ["tests failed"],
		acceptanceCriteriaAssessment: ["criterion remains unmet"],
		discoveredWork: [],
		nextAction: "Remediate.",
		artifactDirectory: ".pi/tmp/aloop/attempt",
		timestamp: "2026-09-01T00:00:00.000Z",
		...overrides,
	};
}

function comment(id: number, body: string, createdAt: string): IssueHandoff {
	return { id, author: "supervisor", body, createdAt, url: `comment/${id}` };
}

test("aloop invocations have explicit bounded runtime and attempt budgets", () => {
	assert.deepEqual(parseAloopRunRequest("#48"), { epic: 48, maxMinutes: 30, maxAttempts: 3 });
	assert.deepEqual(parseAloopRunRequest("48 --max-minutes=12 --max-attempts 2"), { epic: 48, maxMinutes: 12, maxAttempts: 2 });
	assert.throws(() => parseAloopRunRequest("#48 --max-minutes 0"), /between 1 and 240/);
	assert.throws(() => parseAloopRunRequest("#48 --max-attempts 21"), /between 1 and 20/);
	assert.throws(() => parseAloopRunRequest("#48 --max-minutes 5 --max-minutes 6"), /Duplicate/);
	assert.equal(assessAloopRunBudget({ deadlineMs: 2_000, maxAttempts: 2, attemptsStarted: 1, settled: false }, 1_000).allowed, true);
	assert.match(assessAloopRunBudget({ deadlineMs: 2_000, maxAttempts: 2, attemptsStarted: 2, settled: false }, 1_000).reason ?? "", /attempt limit/);
	assert.match(assessAloopRunBudget({ deadlineMs: 2_000, maxAttempts: 2, attemptsStarted: 0, settled: false }, 2_000).reason ?? "", /time limit/);
	assert.match(assessAloopRunBudget({ deadlineMs: 2_000, maxAttempts: 2, attemptsStarted: 0, settled: true }, 1_000).reason ?? "", /settled/);
});

test("selection accepts only open unblocked descendant leaves", () => {
	const parent = issue({ number: 2, title: "Parent", children: [3] });
	const blocked = issue({ number: 3, title: "Blocked", blockers: [{ number: 9, title: "Blocker", state: "open" }] });
	const ready = issue({ number: 4, title: "Ready", assignee: "someone", labels: [] });
	const graph = context([parent, blocked, ready]);

	const selected = selectAloopLeaf(graph, 4);
	assert.equal(selected.title, "Ready");
	assert.doesNotThrow(() => requireAloopClaim(selected, "someone"));
	assert.throws(() => requireAloopClaim(selected, "different-user"), /must be claimed/);
	assert.throws(() => selectAloopLeaf(graph, 2), /not an open, unblocked/);
	assert.throws(() => selectAloopLeaf(graph, 3), /not an open, unblocked/);
});

test("retry boundary stops after two unchanged unsuccessful attempts", () => {
	const failures = [handoff(), handoff({ attemptType: "remediation", approach: "Same approach" })];
	assert.deepEqual(evaluateRetryBoundary(failures, false), {
		allowed: false,
		unsuccessfulAttempts: 2,
		reason: "Two unsuccessful attempts without a materially new approach require user intervention.",
	});
	assert.equal(evaluateRetryBoundary(failures, true).allowed, true);
	assert.equal(evaluateRetryBoundary([...failures, handoff({ successful: true })], false).unsuccessfulAttempts, 0);
	assert.equal(evaluateRetryBoundary([...failures, handoff({ materiallyNewApproach: true })], false).unsuccessfulAttempts, 0);
});

test("durable handoff markers round trip in comment order and feed recovery prompts", () => {
	const first = formatAloopHandoff(handoff());
	const second = formatAloopHandoff(handoff({
		attemptType: "remediation",
		commit: "abcdef2",
		successful: true,
		approach: "Materially different remediation",
		materiallyNewApproach: true,
		nextAction: "Close child.",
		artifactDirectory: ".pi/tmp/aloop/remediation",
	}));
	const comments = [
		comment(3, second, "2026-09-01T02:00:00Z"),
		comment(1, "ordinary comment", "2026-09-01T00:00:00Z"),
		comment(2, first, "2026-09-01T01:00:00Z"),
	];
	const parsed = parseAloopHandoffs(comments);
	assert.deepEqual(parsed.map((item) => item.commit), ["abcdef1", "abcdef2"]);
	assert.equal(parsed[1]?.successful, true);

	const mismatched = formatAloopHandoff(handoff({
		issue: 3,
		commit: "abcdef3",
		artifactDirectory: ".pi/tmp/aloop/unrecorded",
	}));
	const child = issue({ number: 2, title: "Child", recentHandoffs: [...comments, comment(4, mismatched, "2026-09-01T03:00:00Z")] });
	assert.deepEqual(handoffCommentsForIssue(child).map((item) => item.id), [3, 1, 2]);
	const graph = context([child]);
	const outstanding = findOutstandingAttempts(graph, [
		{ issue: 2, commit: "abcdef1", artifactDirectory: ".pi/tmp/aloop/attempt", status: "completed" },
		{ issue: 2, commit: "abcdef3", artifactDirectory: ".pi/tmp/aloop/unrecorded", status: "completed" },
		{ issue: 99, commit: "abcdef4", artifactDirectory: ".pi/tmp/aloop/other-epic", status: "completed" },
	]);
	assert.deepEqual(outstanding.map((attempt) => attempt.commit), ["abcdef3"]);
	const kickoff = buildSupervisorKickoff(graph, "abcdef2 accepted remediation", outstanding, { deadlineMs: Date.parse("2026-09-01T04:00:00Z"), maxAttempts: 3 });
	assert.match(kickoff, /#2 remediation abcdef2: accepted=true/);
	assert.match(kickoff, /#2 abcdef3 completed: \.pi\/tmp\/aloop\/unrecorded/);
	assert.doesNotMatch(kickoff, /#2 implementation abcdef3/);
	assert.match(kickoff, /recover it from its result artifact and Git commit/);
	assert.match(kickoff, /Maximum fresh worker attempts: 3/);
	assert.match(kickoff, /deliberately bounded/);
	assert.match(kickoff, /atomically self-claims an unassigned leaf/);
	assert.match(kickoff, /GitHub and Git are authoritative/);
	assert.match(kickoff, /After every attempt/);
	assert.match(kickoff, /two unsuccessful attempts/);
	assert.match(kickoff, /aloop_check_closure/);
});

test("compact handoffs remain compatible and materially smaller than duplicated JSON", () => {
	const value = handoff({ verification: ["canonical verification passed with extensive evidence ".repeat(20)] });
	const formatted = formatAloopHandoff(value);
	const legacyBytes = Buffer.from(JSON.stringify(value), "utf8").toString("base64url").length + JSON.stringify(value).length;
	assert.match(formatted, /pi-aloop-handoff:v2:/);
	assert.ok(formatted.length < legacyBytes);
	assert.equal(parseAloopHandoffs([comment(1, formatted, value.timestamp)])[0]?.commit, value.commit);
});

test("commit-bound preflight catches files omitted by Git-backed verification", () => {
	const repository = mkdtempSync(join(tmpdir(), "aloop-git-backed-"));
	try {
		const git = (...args: string[]) => execFileSync("git", args, { cwd: repository, encoding: "utf8" });
		git("init", "-q");
		git("config", "user.email", "aloop-test@example.invalid");
		git("config", "user.name", "Aloop Test");
		writeFileSync(join(repository, "tracked.txt"), "tracked\n");
		git("add", "tracked.txt");
		git("commit", "-qm", "base");

		// A Git-backed Nix source sees only HEAD here, so this eventual source file
		// can be absent from a falsely passing check until it is committed later.
		writeFileSync(join(repository, "eventual-source.ts"), "export const omitted = true;\n");
		assert.doesNotMatch(git("ls-tree", "-r", "--name-only", "HEAD"), /eventual-source\.ts/);
		const preflight = git("status", "--porcelain=v1", "--untracked-files=all");
		assert.match(preflight, /\?\? eventual-source\.ts/);
		git("add", "eventual-source.ts");
		git("commit", "-qm", "eventual source");
		assert.match(git("ls-tree", "-r", "--name-only", "HEAD"), /eventual-source\.ts/);
	} finally {
		rmSync(repository, { recursive: true, force: true });
	}
});

test("supervisor gate binds successful evidence to a clean exact commit", () => {
	const receipt = { commit: "abcdef1", command: "nix run .#verify", exitStatus: 0, timestamp: "2026-09-01T00:00:00Z", sourceIdentity: "tree:123" };
	assert.deepEqual(evaluateSupervisorAttempt({ returnedCommit: "abcdef1", currentHead: "abcdef1", worktreeStatus: "", receipt, acceptanceCriteria: [{ satisfied: true, evidence: "test" }]}), { allowed: true, reasons: [] });
	const changed = evaluateSupervisorAttempt({ returnedCommit: "abcdef1", currentHead: "abcdef2", worktreeStatus: " M source.ts", receipt, acceptanceCriteria: [{ satisfied: false, evidence: "" }], productionIntegrationRequired: true });
	assert.equal(changed.allowed, false);
	assert.match(changed.reasons.join(" "), /differs.*changed after verification.*acceptance criterion.*Production packaging/i);
});

test("successful handoffs require passing evidence for every selected-issue criterion", () => {
	const issueBody = "## Acceptance criteria\n\n- Exact bytes are published\n- Retry is idempotent";
	assert.deepEqual(validateSuccessfulHandoffEvidence({
		issueBody,
		verification: ["canonical verification passed"],
		acceptanceCriteriaAssessment: [
			"PASS — Exact bytes are published — byte equality assertion passed",
			"PASS — Retry is idempotent — duplicate publication returned the existing comment",
		],
	}), []);
	const reasons = validateSuccessfulHandoffEvidence({
		issueBody,
		verification: ["FAIL canonical build"],
		acceptanceCriteriaAssessment: [
			"PASS Exact bytes are published",
			"PARTIAL — Retry is idempotent — dry-run only",
		],
	});
	assert.match(reasons.join(" "), /passing verification evidence/i);
	assert.match(reasons.join(" "), /Exact bytes are published/);
	assert.match(reasons.join(" "), /Retry is idempotent/);
	assert.match(reasons.join(" "), /cannot contain failed, partial, or blocked/i);
	assert.match(validateSuccessfulHandoffEvidence({ issueBody: "No criteria", verification: ["passed"], acceptanceCriteriaAssessment: [] }).join(" "), /no parseable acceptance criteria/i);
});

test("closure gate requires closed descendants, review, verification, and every epic criterion", () => {
	const openGraph = context([issue({ number: 2, title: "Open child" })]);
	const blocked = evaluateEpicClosure(openGraph, { verification: [], acceptanceCriteria: [], descendantReviews: [] });
	assert.equal(blocked.allowed, false);
	assert.match(blocked.reasons.join(" "), /Open descendants/);
	assert.match(blocked.reasons.join(" "), /review evidence/);
	assert.match(blocked.reasons.join(" "), /No project verification/);
	assert.match(blocked.reasons.join(" "), /acceptance criteria/);

	const closedGraph = context([issue({ number: 2, title: "Closed child", state: "closed" })]);
	const allowed = evaluateEpicClosure(closedGraph, {
		verification: [{ check: "canonical", passed: true, evidence: "140 tests passed" }],
		acceptanceCriteria: [
			{ criterion: "All children complete", satisfied: true, evidence: "#2 is closed after review" },
			{ criterion: "Verification passes", satisfied: true, evidence: "canonical gate passed" },
		],
		descendantReviews: [{ issue: 2, reviewed: true, evidence: "acceptance evidence assessed" }],
	});
	assert.deepEqual(allowed, { allowed: true, reasons: [] });
});

test("user-facing epic report distinguishes closure from a human-decision stop", () => {
	const closed = buildEpicReport({
		epicNumber: 1,
		closed: true,
		completedIssues: [{ number: 2, title: "Child", commit: "abcdef2" }],
		verification: ["canonical gate passed"],
		deferredWork: [],
	});
	assert.match(closed, /Epic #1: closed/);
	assert.match(closed, /#2 Child \(abcdef2\)/);

	const stopped = buildEpicReport({
		epicNumber: 1,
		closed: false,
		completedIssues: [],
		verification: [],
		deferredWork: ["scope question"],
		humanDecision: "Choose compatibility policy.",
	});
	assert.match(stopped, /Epic #1: stopped/);
	assert.match(stopped, /Human decision required/);
	assert.match(stopped, /Choose compatibility policy/);
});
