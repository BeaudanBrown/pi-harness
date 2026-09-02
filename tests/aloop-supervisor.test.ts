import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { EpicIssueContext, GitHubEpicContext, IssueHandoff } from "../config/agent/extensions/github-issues/github-context.js";
import { registerAloopExtension } from "../config/agent/extensions/aloop/index.js";
import {
	assessAloopRunBudget,
	authorizeHandoffPublication,
	buildEpicReport,
	buildSupervisorKickoff,
	claimAndRefreshAloopLeaf,
	closeAcceptedAloopIssue,
	createAloopHandoffSpoolRecord,
	evaluateEpicClosure,
	evaluateRetryBoundary,
	evaluateSupervisorAttempt,
	findOutstandingAttempts,
	formatAloopHandoff,
	handoffCommentsForIssue,
	nextIssueRetryNumber,
	parseAloopHandoffs,
	parseAloopRunRequest,
	publishPreparedAloopHandoff,
	requireAloopClaim,
	selectAloopLeaf,
	validateAloopHandoffSpoolRecord,
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

test("aloop invocations separate worker-launch resource bounds from issue retries", () => {
	assert.deepEqual(parseAloopRunRequest("#48"), { epic: 48, maxMinutes: 30, maxWorkerLaunches: 20 });
	assert.deepEqual(parseAloopRunRequest("48 --max-minutes=12 --max-worker-launches 40"), { epic: 48, maxMinutes: 12, maxWorkerLaunches: 40 });
	assert.throws(() => parseAloopRunRequest("#48 --max-minutes 0"), /between 1 and 240/);
	assert.throws(() => parseAloopRunRequest("#48 --max-worker-launches 101"), /between 1 and 100/);
	assert.throws(() => parseAloopRunRequest("#48 --max-attempts 3"), /Unknown/);
	assert.throws(() => parseAloopRunRequest("#48 --max-minutes 5 --max-minutes 6"), /Duplicate/);
	assert.deepEqual(assessAloopRunBudget({ deadlineMs: 2_000, maxWorkerLaunches: 2, workerLaunchesStarted: 1, settled: false }, 1_000), {
		allowed: true,
		remainingMs: 1_000,
		workerLaunchesRemaining: 1,
		finalPermittedWorkerLaunch: true,
	});
	const exhausted = assessAloopRunBudget({ deadlineMs: 2_000, maxWorkerLaunches: 2, workerLaunchesStarted: 2, settled: false }, 1_000);
	assert.equal(exhausted.workerLaunchesRemaining, 0);
	assert.equal(exhausted.finalPermittedWorkerLaunch, false);
	assert.match(exhausted.reason ?? "", /worker-launch limit/);
	assert.match(assessAloopRunBudget({ deadlineMs: 2_000, maxWorkerLaunches: 2, workerLaunchesStarted: 0, settled: false }, 2_000).reason ?? "", /time limit/);
	assert.match(assessAloopRunBudget({ deadlineMs: 2_000, maxWorkerLaunches: 2, workerLaunchesStarted: 0, settled: true }, 1_000).reason ?? "", /settled/);
});

test("selection accepts only open unblocked descendant leaves", () => {
	const parent = issue({ number: 2, title: "Parent", children: [3] });
	const blocked = issue({ number: 3, title: "Blocked", blockers: [{ number: 9, title: "Blocker", state: "open" }] });
	const ready = issue({ number: 4, title: "Ready", assignee: "someone", labels: [] });
	const graph = context([parent, blocked, ready]);

	const selected = selectAloopLeaf(graph, 4);
	assert.equal(selected.title, "Ready");
	assert.doesNotThrow(() => requireAloopClaim(selected, "someone"));
	assert.throws(() => requireAloopClaim(issue({ number: 5, title: "Unassigned" }), "someone"), /must be claimed/);
	assert.throws(() => requireAloopClaim(selected, "different-user"), /must be claimed/);
	assert.throws(() => selectAloopLeaf(graph, 2), /not an open, unblocked/);
	assert.throws(() => selectAloopLeaf(graph, 3), /not an open, unblocked/);
});

test("claim operation handles unassigned, self, and foreign owners with post-claim refresh", async () => {
	const selfOwned = issue({ number: 2, title: "Leaf", assignee: "operator" });
	let claimCalls = 0;
	let refreshCalls = 0;
	const claimed = await claimAndRefreshAloopLeaf({
		context: context([issue({ number: 2, title: "Leaf" })]),
		issueNumber: 2,
		authenticatedLogin: "operator",
		claim: async (number) => { assert.equal(number, 2); claimCalls += 1; },
		refresh: async () => { refreshCalls += 1; return context([selfOwned]); },
	});
	assert.equal(claimed.issue.assignee, "operator");
	assert.equal(claimCalls, 1);
	assert.equal(refreshCalls, 1);

	await claimAndRefreshAloopLeaf({
		context: context([selfOwned]),
		issueNumber: 2,
		authenticatedLogin: "operator",
		claim: async () => { claimCalls += 1; },
		refresh: async () => { refreshCalls += 1; return context([selfOwned]); },
	});
	assert.equal(claimCalls, 1, "an existing self-assignment must not be claimed again");
	assert.equal(refreshCalls, 1, "the input context is already the required pre-launch refresh");

	await assert.rejects(() => claimAndRefreshAloopLeaf({
		context: context([issue({ number: 2, title: "Leaf", assignee: "other" })]),
		issueNumber: 2,
		authenticatedLogin: "operator",
		claim: async () => { claimCalls += 1; },
		refresh: async () => { refreshCalls += 1; return context([selfOwned]); },
	}), /must be claimed by operator/);
	assert.equal(claimCalls, 1);
	assert.equal(refreshCalls, 1);
});

test("retry accounting is per issue and only remediation launches receive retry numbers", () => {
	const failures = [handoff(), handoff({ attemptType: "remediation", approach: "Same approach" })];
	assert.equal(nextIssueRetryNumber([], "implementation"), 0);
	assert.equal(nextIssueRetryNumber(failures.slice(0, 1), "remediation"), 1);
	assert.equal(nextIssueRetryNumber(failures, "remediation"), 2);
	assert.equal(nextIssueRetryNumber([...failures, handoff({ successful: true })], "remediation"), 1);
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
		verificationReceiptId: "verify-abcdef200000-1-12345678",
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
	const kickoff = buildSupervisorKickoff(graph, "abcdef2 accepted remediation", outstanding, { deadlineMs: Date.parse("2026-09-01T04:00:00Z"), maxWorkerLaunches: 20 });
	assert.match(kickoff, /#2 remediation abcdef2: accepted=true/);
	assert.match(kickoff, /#2 abcdef3 completed: \.pi\/tmp\/aloop\/unrecorded/);
	assert.doesNotMatch(kickoff, /#2 implementation abcdef3/);
	assert.match(kickoff, /recover it from its result artifact and Git commit/);
	assert.match(kickoff, /Epic child progress: 0\/1 closed; 1 open/);
	assert.match(kickoff, /Maximum worker launches: 20/);
	assert.match(kickoff, /A worker launch on a new issue is not a retry/);
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

test("handoff publication requires dry-run first and permits idempotent retries", () => {
	const dryRuns = new Set<string>();
	const handoffId = "0123456789abcdef01234567";
	assert.throws(
		() => authorizeHandoffPublication({ handoffId, dryRun: false, dryRunHandoffIds: dryRuns }),
		/must complete a dry run/,
	);
	authorizeHandoffPublication({ handoffId, dryRun: true, dryRunHandoffIds: dryRuns });
	assert.doesNotThrow(() => authorizeHandoffPublication({ handoffId, dryRun: false, dryRunHandoffIds: dryRuns }));
	assert.doesNotThrow(() => authorizeHandoffPublication({ handoffId, dryRun: false, dryRunHandoffIds: dryRuns }));
	assert.throws(
		() => authorizeHandoffPublication({ handoffId: "wrong", dryRun: true, dryRunHandoffIds: dryRuns }),
		/ID is invalid/,
	);
});

test("publication operation preserves exact bytes across dry-run, failure, and idempotent retry", async () => {
	const exactComment = "<!-- exact -->\nUnicode ✓ and trailing newline\n";
	const record = createAloopHandoffSpoolRecord(69, exactComment);
	const dryRuns = new Set<string>();
	const calls: Array<{ issue: number; comment: string; apply: boolean }> = [];
	let failFirstApply = true;
	const publish = async (issueNumber: number, body: string, apply: boolean) => {
		calls.push({ issue: issueNumber, comment: body, apply });
		if (apply && failFirstApply) {
			failFirstApply = false;
			throw new Error("injected interruption");
		}
		return apply ? { published: true, existing: calls.filter((call) => call.apply).length > 2 } : { published: false, existing: false };
	};
	await publishPreparedAloopHandoff({ record, handoffId: record.id, dryRun: true, dryRunHandoffIds: dryRuns, publish });
	assert.deepEqual(calls, [{ issue: 69, comment: exactComment, apply: false }]);
	await assert.rejects(() => publishPreparedAloopHandoff({ record, handoffId: record.id, dryRun: false, dryRunHandoffIds: dryRuns, publish }), /injected interruption/);
	const retry = await publishPreparedAloopHandoff({ record, handoffId: record.id, dryRun: false, dryRunHandoffIds: dryRuns, publish });
	const repeated = await publishPreparedAloopHandoff({ record, handoffId: record.id, dryRun: false, dryRunHandoffIds: dryRuns, publish });
	assert.equal(retry.published, true);
	assert.equal(repeated.existing, true);
	assert.ok(calls.every((call) => call.comment === exactComment), "every attempt must use the exact prepared bytes");
});

test("registered aloop tools wire claim refresh, exact publication retry, and idempotent verified closure", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "aloop-extension-"));
	try {
		const verificationPolicy = JSON.parse(readFileSync(".aloop.json", "utf8")) as { canonicalCommand: string; productionIntegrationCommand: string };
		writeFileSync(join(cwd, ".aloop.json"), JSON.stringify(verificationPolicy));
		const tools = new Map<string, { execute: (...args: unknown[]) => Promise<{ details?: Record<string, unknown> }> }>();
		const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
		const priorFailure = formatAloopHandoff(handoff({ nextAction: "Use the exact remediation fixture." }));
		let graph = context([issue({ number: 2, title: "Leaf", body: "## Acceptance criteria\n\n- Done", recentHandoffs: [comment(1, priorFailure, "2026-09-01T00:00:00Z")] })]);
		let claims = 0;
		let workerIssues: number[] = [];
		const workerDirections: string[] = [];
		const workerPriorContexts: unknown[] = [];
		let publicationApplyCalls = 0;
		let closeCalls = 0;
		const shellCommands: string[] = [];
		let worktreeStatus = "";
		let fakeHead = "a".repeat(40);
		const pi = {
			registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<{ details?: Record<string, unknown> }> }) => tools.set(tool.name, tool),
			registerCommand: (name: string, command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => commands.set(name, command),
			on: () => undefined,
			getActiveTools: () => [],
			setActiveTools: () => undefined,
			setSessionName: () => undefined,
			sendUserMessage: () => undefined,
			exec: async (_command: string, args: string[]) => {
				if (_command === "bash") shellCommands.push(args[1]!);
				if (args[0] === "log") return { code: 0, stdout: "history\n", stderr: "" };
				if (args[0] === "rev-parse") return { code: 0, stdout: `${fakeHead}\n`, stderr: "" };
				if (args[0] === "status") return { code: 0, stdout: worktreeStatus, stderr: "" };
				return { code: 0, stdout: "", stderr: "" };
			},
		} as unknown as ExtensionAPI;
		registerAloopExtension(pi, {
			retrieveEpicContext: async () => graph,
			currentLogin: async () => "operator",
			claimIssue: async (_cwd, number) => {
				claims += 1;
				graph = context([issue({ number, title: "Leaf", body: "## Acceptance criteria\n\n- Done", assignee: "operator", recentHandoffs: [comment(1, priorFailure, "2026-09-01T00:00:00Z")] })]);
			},
			runWorker: async (input) => {
				workerIssues.push(input.issue.number);
				workerDirections.push(input.supervisorApproach);
				workerPriorContexts.push(input.priorHandoffs);
				return {
					status: "completed",
					summary: "attempt",
					commit: fakeHead,
					workerResult: null,
					contract: { valid: true, commit: fakeHead, violations: [] },
					process: { exitCode: 0, signal: null, timedOut: false, cancelled: false, durationMs: 1 },
					artifacts: { directory: ".pi/tmp/aloop/issue-2-1-abcdef", prompt: "prompt", stdout: "stdout", stderr: "stderr", result: "result" },
				};
			},
			publishComment: async (_cwd, _issue, _body, apply) => {
				if (apply) {
					publicationApplyCalls += 1;
					if (publicationApplyCalls === 1) throw new Error("injected network interruption");
				}
				return { apply };
			},
			closeIssue: async () => { closeCalls += 1; return { closed: true }; },
		});
		const ctx = { cwd, isIdle: () => true, hasUI: false, signal: new AbortController().signal, abort: () => undefined } as unknown as ExtensionContext;
		await commands.get("aloop")!.handler("#1 --max-minutes 5 --max-worker-launches 2", ctx);
		await assert.rejects(() => tools.get("aloop_supervisor_verify")!.execute("too-early", { commit: fakeHead, command: verificationPolicy.canonicalCommand, production_integration_command: verificationPolicy.productionIntegrationCommand }, ctx.signal, undefined, ctx), /pending worker attempt/);
		await tools.get("aloop_launch_worker")!.execute("launch", { issue: 2, attempt_type: "remediation", approach: "test wiring", materially_new_approach: true }, ctx.signal, undefined, ctx);
		assert.equal(claims, 1);
		assert.deepEqual(workerIssues, [2]);
		assert.deepEqual(workerDirections, ["test wiring"]);
		assert.deepEqual(workerPriorContexts, [[parseAloopHandoffs([comment(1, priorFailure, "2026-09-01T00:00:00Z")])[0]]]);
		worktreeStatus = "?? eventual-source.ts\n";
		await assert.rejects(() => tools.get("aloop_supervisor_verify")!.execute("untracked", { commit: fakeHead, command: verificationPolicy.canonicalCommand, production_integration_command: verificationPolicy.productionIntegrationCommand }, ctx.signal, undefined, ctx), /clean worktree/);
		worktreeStatus = "";
		await assert.rejects(() => tools.get("aloop_supervisor_verify")!.execute("bypass", { commit: fakeHead, command: "true", production_integration_command: "true" }, ctx.signal, undefined, ctx), /must exactly match/);
		const verified = await tools.get("aloop_supervisor_verify")!.execute("verify", { commit: fakeHead, command: verificationPolicy.canonicalCommand, production_integration_command: verificationPolicy.productionIntegrationCommand }, ctx.signal, undefined, ctx);
		assert.deepEqual(shellCommands, [verificationPolicy.canonicalCommand, verificationPolicy.productionIntegrationCommand]);
		assert.equal((verified.details?.receipt as { productionIntegrationExitStatus?: number }).productionIntegrationExitStatus, 0);

		const receiptId = verified.details?.receiptId as string;
		assert.match(receiptId, /^verify-/);
		const successfulComment = formatAloopHandoff(handoff({ issue: 2, commit: fakeHead, verificationReceiptId: receiptId, successful: true, verification: ["canonical and production checks passed"], acceptanceCriteriaAssessment: ["PASS — Done — registered tool evidence"] }));
		const spool = createAloopHandoffSpoolRecord(2, successfulComment);
		mkdirSync(join(cwd, ".pi/tmp/aloop/handoffs"), { recursive: true });
		writeFileSync(join(cwd, `.pi/tmp/aloop/handoffs/${spool.id}.json`), `${JSON.stringify(spool)}\n`);
		await tools.get("aloop_publish_handoff")!.execute("publish-dry", { handoff_id: spool.id, dry_run: true }, ctx.signal, undefined, ctx);
		await assert.rejects(() => tools.get("aloop_publish_handoff")!.execute("publish-fail", { handoff_id: spool.id, dry_run: false }, ctx.signal, undefined, ctx), /network interruption/);
		await tools.get("aloop_publish_handoff")!.execute("publish-retry", { handoff_id: spool.id, dry_run: false }, ctx.signal, undefined, ctx);
		graph = context([issue({ number: 2, title: "Leaf", body: "## Acceptance criteria\n\n- Done", assignee: "operator", recentHandoffs: [comment(1, successfulComment, "2026-09-01T00:00:00Z")] })]);
		const receiptPath = join(cwd, `.pi/tmp/aloop/receipts/${receiptId}.json`);
		const originalReceipt = readFileSync(receiptPath, "utf8");
		writeFileSync(receiptPath, originalReceipt.replace('"exitStatus": 0', '"exitStatus": 1'));
		await assert.rejects(() => tools.get("aloop_close_accepted_issue")!.execute("close-tampered", { issue: 2, handoff_id: spool.id, verification_receipt_id: receiptId, dry_run: true }, ctx.signal, undefined, ctx), /changed after it was issued/);
		writeFileSync(receiptPath, originalReceipt);
		await tools.get("aloop_close_accepted_issue")!.execute("close-dry", { issue: 2, handoff_id: spool.id, verification_receipt_id: receiptId, dry_run: true }, ctx.signal, undefined, ctx);
		await tools.get("aloop_close_accepted_issue")!.execute("close", { issue: 2, handoff_id: spool.id, verification_receipt_id: receiptId, dry_run: false }, ctx.signal, undefined, ctx);
		assert.equal(closeCalls, 1);
		graph = context([issue({ number: 2, title: "Leaf", body: "## Acceptance criteria\n\n- Done", state: "closed", assignee: "operator", recentHandoffs: [comment(1, successfulComment, "2026-09-01T00:00:00Z")] })]);
		rmSync(join(cwd, ".pi/tmp/aloop/handoffs"), { recursive: true, force: true });
		rmSync(join(cwd, ".pi/tmp/aloop/receipts"), { recursive: true, force: true });
		fakeHead = "b".repeat(40);
		await tools.get("aloop_close_accepted_issue")!.execute("close-retry", { issue: 2, handoff_id: spool.id, verification_receipt_id: receiptId, dry_run: false }, ctx.signal, undefined, ctx);
		assert.equal(closeCalls, 1);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("handoff spool identity is deterministic, exact-byte preserving, and tamper evident", () => {
	const commentBytes = "<!-- marker -->\n\nConcise handoff with unicode: ✓\n";
	const first = createAloopHandoffSpoolRecord(69, commentBytes);
	const retry = createAloopHandoffSpoolRecord(69, commentBytes);
	assert.deepEqual(retry, first, "repeated preparation must produce the same publication ID and bytes");
	assert.equal(first.id.length, 24, "spool creation and the public tool schema have always used 24-character IDs");
	assert.throws(() => authorizeHandoffPublication({ handoffId: first.id.slice(0, 16), dryRun: true, dryRunHandoffIds: new Set() }), /ID is invalid/);
	assert.equal(validateAloopHandoffSpoolRecord(JSON.parse(JSON.stringify(first)), first.id).comment, commentBytes);
	assert.notEqual(createAloopHandoffSpoolRecord(70, commentBytes).id, first.id, "IDs bind the target issue");
	assert.notEqual(createAloopHandoffSpoolRecord(69, `${commentBytes}changed`).id, first.id, "IDs bind exact bytes");
	assert.throws(() => validateAloopHandoffSpoolRecord({ ...first, comment: `${commentBytes}tampered` }, first.id), /integrity validation/);
	assert.throws(() => validateAloopHandoffSpoolRecord(first, "0".repeat(24)), /malformed/);
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

test("accepted child closure rejects invalid evidence and is dry-run-first and idempotent", async () => {
	const commitId = "a".repeat(40);
	const handoffComment = formatAloopHandoff(handoff({
		issue: 2,
		commit: commitId,
		verificationReceiptId: "verify-aaaaaaaaaaaa-1-12345678",
		successful: true,
		verification: ["canonical verification passed"],
		acceptanceCriteriaAssessment: ["PASS — Done — evidence"],
	}));
	const spool = createAloopHandoffSpoolRecord(2, handoffComment);
	const published = comment(1, handoffComment, "2026-09-01T01:00:00Z");
	const child = issue({ number: 2, title: "Child", body: "## Acceptance criteria\n\n- Done", assignee: "operator", recentHandoffs: [published] });
	const receipt = {
		commit: commitId,
		command: "nix run .#verify",
		exitStatus: 0,
		timestamp: "2026-09-01T00:00:00Z",
		sourceIdentity: "tree:verified",
		postVerificationHead: commitId,
		postVerificationClean: true,
		productionIntegration: "nix build --no-link .#pi-harness-resources",
		productionIntegrationExitStatus: 0,
	};
	const closureIds = new Set<string>();
	let closes = 0;
	const close = async () => { closes += 1; return { closed: true }; };
	const base = {
		issue: child,
		epicNumber: 1,
		authenticatedLogin: "operator",
		handoffId: spool.id,
		spool,
		receiptId: "verify-aaaaaaaaaaaa-1-12345678",
		receipt,
		currentHead: commitId,
		worktreeStatus: "",
		dryRunClosureIds: closureIds,
		close,
	};

	await assert.rejects(() => closeAcceptedAloopIssue({ ...base, dryRun: false }), /dry run before apply/);
	await assert.rejects(() => closeAcceptedAloopIssue({ ...base, dryRun: true, receiptId: "verify-bbbbbbbbbbbb-2-87654321" }), /different supervisor verification receipt/);
	await assert.rejects(() => closeAcceptedAloopIssue({ ...base, dryRun: true, issue: { ...child, recentHandoffs: [] } }), /not durably published/);
	const unsuccessfulComment = formatAloopHandoff(handoff({ issue: 2, commit: commitId, successful: false }));
	const unsuccessfulSpool = createAloopHandoffSpoolRecord(2, unsuccessfulComment);
	await assert.rejects(() => closeAcceptedAloopIssue({ ...base, dryRun: true, issue: { ...child, recentHandoffs: [comment(2, unsuccessfulComment, "2026-09-01T01:00:00Z")] }, handoffId: unsuccessfulSpool.id, spool: unsuccessfulSpool }), /successful commit-bearing/);
	await assert.rejects(() => closeAcceptedAloopIssue({ ...base, dryRun: true, receipt: { ...receipt, exitStatus: 1 } }), /verification failed/i);
	await assert.rejects(() => closeAcceptedAloopIssue({ ...base, dryRun: true, receipt: { ...receipt, commit: "b".repeat(40) } }), /different commit/i);
	await assert.rejects(() => closeAcceptedAloopIssue({ ...base, dryRun: true, receipt: { ...receipt, timestamp: "invalid" } }), /incomplete/i);
	await assert.rejects(() => closeAcceptedAloopIssue({ ...base, dryRun: true, receipt: { ...receipt, productionIntegration: "" } }), /Production packaging/i);
	await assert.rejects(() => closeAcceptedAloopIssue({ ...base, dryRun: true, receipt: { ...receipt, productionIntegrationExitStatus: 1 } }), /Production packaging/i);
	await assert.rejects(() => closeAcceptedAloopIssue({ ...base, dryRun: true, currentHead: "b".repeat(40) }), /differs/i);
	await assert.rejects(() => closeAcceptedAloopIssue({ ...base, dryRun: true, worktreeStatus: " M source.ts" }), /changed after verification/i);
	await assert.rejects(() => closeAcceptedAloopIssue({ ...base, dryRun: true, issue: { ...child, assignee: "other" } }), /must be claimed/);
	assert.equal(closes, 0);

	const dryRun = await closeAcceptedAloopIssue({ ...base, dryRun: true });
	assert.equal(dryRun.applied, false);
	assert.equal(closes, 0);
	const applied = await closeAcceptedAloopIssue({ ...base, dryRun: false });
	assert.equal(applied.applied, true);
	assert.equal(closes, 1);
	const repeated = await closeAcceptedAloopIssue({ ...base, issue: { ...child, state: "closed" }, currentHead: "b".repeat(40), worktreeStatus: " M later-work.ts", dryRunClosureIds: new Set(), dryRun: false });
	assert.equal(repeated.alreadyClosed, true);
	assert.equal(closes, 1);
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
