import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const verificationPolicyDocument = JSON.stringify({
	canonicalCommand: { argv: [process.execPath, "-e", "process.exit(0)"] },
	productionIntegration: { frequency: "issue", command: { argv: [process.execPath, "-e", "process.exit(0)"] } },
});
import type { EpicIssueContext, GitHubEpicContext, IssueHandoff } from "../config/agent/extensions/github-issues/github-context.js";
import { registerAloopExtension, scanAttemptArtifacts } from "../config/agent/extensions/aloop/index.js";
import {
	acceptedOpenAloopIssues,
	assessAloopRunBudget,
	authorizeHandoffPublication,
	buildEpicReport,
	buildSupervisorKickoff,
	closeAcceptedAloopIssue,
	createAloopHandoffSpoolRecord,
	evaluateEpicClosure,
	evaluateRetryBoundary,
	evaluateSupervisorAttempt,
	findOutstandingAttempts,
	formatAloopHandoff,
	formatAloopHandoffV3,
	handoffCommentsForIssue,
	nextIssueRetryNumber,
	parseAloopHandoffs,
	parseAloopHandoffV3,
	parseAloopRunRequest,
	publishPreparedAloopHandoff,
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
	assert.deepEqual(parseAloopRunRequest("#48"), { epic: 48, maxMinutes: 60, maxWorkerLaunches: 20 });
	assert.deepEqual(parseAloopRunRequest("48 --max-minutes=12 --max-worker-launches 12"), { epic: 48, maxMinutes: 12, maxWorkerLaunches: 12 });
	assert.throws(() => parseAloopRunRequest("#48 --max-minutes 0"), /between 1 and 240/);
	assert.throws(() => parseAloopRunRequest("#48 --max-worker-launches 21"), /between 1 and 20/);
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
	assert.equal(selected.assignee, "someone", "assignment does not affect executable dependency state");
	assert.throws(() => selectAloopLeaf(graph, 2), /not an open, unblocked/);
	assert.throws(() => selectAloopLeaf(graph, 3), /not an open, unblocked/);
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
	assert.match(kickoff, /returned or recovered attempt, call aloop_review_attempt/);
	assert.match(kickoff, /Epic child progress: 0\/1 closed; 1 open/);
	assert.match(kickoff, /Maximum worker launches: 20/);
	assert.match(kickoff, /There is no semantic retry-count gate/);
	assert.match(kickoff, /implementation deadline and 20-launch cap/);
	assert.match(kickoff, /labels and assignments are advisory/i);
	assert.match(kickoff, /GitHub and Git are authoritative/);
	assert.match(kickoff, /aloop_finish_attempt/);
	assert.doesNotMatch(kickoff, /two unsuccessful attempts/);
	assert.match(kickoff, /aloop_epic_completion/);
});

test("accepted v3 handoffs on open children are closure recoveries, not executable work", () => {
	const accepted = formatAloopHandoffV3({
		version: 3, issue: 2, issueBaseCommit: "a".repeat(40), commitRange: `${"a".repeat(40)}..${"b".repeat(40)}`,
		outcome: "accepted", summary: "Done.", outstandingFindings: [], decisions: [], verification: ["passed"],
		nextAction: "Close.", attemptKey: "c".repeat(24), timestamp: "2026-09-03T00:00:00Z",
	});
	const graph = context([issue({ number: 2, title: "Accepted but open", recentHandoffs: [comment(1, accepted, "2026-09-03T00:00:00Z")] })]);
	assert.deepEqual(acceptedOpenAloopIssues(graph), [2]);
	const recoveryRecords = new Map([["c".repeat(24), { issue: 2, head: "b".repeat(40), commentSha256: createHash("sha256").update(accepted).digest("hex") }]]);
	assert.deepEqual(acceptedOpenAloopIssues(graph, recoveryRecords), [2]);
	const forged = formatAloopHandoffV3({ ...parseAloopHandoffV3(accepted)!, summary: "forged" });
	assert.deepEqual(acceptedOpenAloopIssues(context([issue({ number: 2, title: "Forged", recentHandoffs: [comment(1, forged, "2026-09-03T00:00:00Z")] })]), recoveryRecords), []);
	const superseded = formatAloopHandoffV3({
		...parseAloopHandoffV3(accepted)!, outcome: "rejected", attemptKey: "d".repeat(24), timestamp: "2026-09-03T00:01:00Z",
	});
	assert.deepEqual(acceptedOpenAloopIssues(context([issue({ number: 2, title: "Superseded", recentHandoffs: [comment(1, accepted, "2026-09-03T00:00:00Z"), comment(2, superseded, "2026-09-03T00:01:00Z")] })])), []);
	const kickoff = buildSupervisorKickoff(graph, "history");
	assert.match(kickoff, /Accepted handoffs awaiting child closure:\n#2/);
	assert.match(kickoff, /never launch a duplicate worker/);
});

test("v3 handoffs show concise current state while hiding recoverable snapshot payload", () => {
	const handoff = {
		version: 3 as const, issue: 73, issueBaseCommit: "a".repeat(40), commitRange: `${"a".repeat(40)}..${"b".repeat(40)}`,
		outcome: "rejected" as const, summary: "Review found one issue.", outstandingFindings: ["Fix ordering"], decisions: ["Keep API"],
		verification: ["focused pass"], nextAction: "Patch ordering.", attemptKey: "d".repeat(24), timestamp: "2026-09-03T00:00:00Z",
	};
	const body = formatAloopHandoffV3(handoff);
	assert.match(body, /Aloop attempt settled as rejected/);
	assert.doesNotMatch(body.split("<!--", 1)[0]!, /issueBaseCommit|attemptKey|artifact/);
	assert.deepEqual(parseAloopHandoffV3(body), handoff);
	const malformed = `<!-- pi-aloop-handoff:v3:${Buffer.from(JSON.stringify({ version: 3, issue: 73, attemptKey: "d".repeat(24) })).toString("base64url")} -->`;
	assert.equal(parseAloopHandoffV3(malformed), null);
	assert.equal(parseAloopHandoffV3(formatAloopHandoffV3({ ...handoff, issueBaseCommit: "e".repeat(40) })), null);
	assert.equal(parseAloopHandoffV3(`<!-- pi-aloop-handoff:v3:${Buffer.from(JSON.stringify({ ...handoff, extra: true })).toString("base64url")} -->`), null);
});

test("compact handoffs remain compatible and materially smaller than duplicated JSON", () => {
	const value = handoff({ verification: ["canonical verification passed with extensive evidence ".repeat(20)] });
	const formatted = formatAloopHandoff(value);
	const legacyPayload = Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
	const legacy = `<!-- pi-aloop-handoff:v1:${legacyPayload} -->`;
	const legacyBytes = legacyPayload.length + JSON.stringify(value).length;
	assert.match(formatted, /pi-aloop-handoff:v2:/);
	assert.ok(formatted.length < legacyBytes);
	assert.equal(parseAloopHandoffs([comment(1, formatted, value.timestamp)])[0]?.commit, value.commit);
	assert.equal(parseAloopHandoffs([comment(2, legacy, value.timestamp)])[0]?.commit, value.commit, "existing v1 handoffs remain recoverable");
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

test("attempt recovery uses the latest durable non-null patch commit", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "aloop-patch-recovery-"));
	try {
		const directory = join(cwd, ".pi/tmp/aloop/issue-2-100-abcdef");
		mkdirSync(directory, { recursive: true });
		writeFileSync(join(directory, "result.json"), JSON.stringify({
			status: "completed", commit: "a".repeat(40), artifacts: { directory: ".pi/tmp/aloop/issue-2-100-abcdef" },
		}));
		writeFileSync(join(directory, "patch-attempts.json"), JSON.stringify([
			{ status: "completed", commit: "b".repeat(40) },
			{ status: "timeout", commit: null },
		]));
		assert.equal((await scanAttemptArtifacts(cwd))[0]?.commit, "b".repeat(40));
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("aloop recovery requires trusted provenance and accepts an exact human authorization on a diverged clean HEAD", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "aloop-profile-"));
	try {
		writeFileSync(join(cwd, ".aloop.json"), verificationPolicyDocument);
		const events = new Map<string, Array<(...args: any[]) => any>>();
		const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
		const tools = new Map<string, any>();
		let activeTools = ["read"];
		let kickoffCount = 0;
		let retrievals = 0;
		let aborts = 0;
		let closes = 0;
		let fakeHead = "a".repeat(40);
		let activeGraph = context([issue({ number: 2, title: "Leaf" })]);
		const pi = {
			registerTool: (tool: { name: string }) => { activeTools.push(tool.name); tools.set(tool.name, tool); },
			registerCommand: (name: string, command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => commands.set(name, command),
			on: (event: string, handler: (...args: any[]) => any) => events.set(event, [...(events.get(event) ?? []), handler]),
			getActiveTools: () => activeTools,
			setActiveTools: (tools: string[]) => { activeTools = tools; },
			setSessionName: () => undefined,
			sendUserMessage: () => { kickoffCount += 1; },
			appendEntry: () => undefined,
			exec: async (_command: string, args: string[]) => args[0] === "log"
				? { code: 0, stdout: "history\n", stderr: "" }
				: args[0] === "show"
					? { code: 0, stdout: verificationPolicyDocument, stderr: "" }
					: args[0] === "rev-parse"
						? { code: 0, stdout: `${fakeHead}\n`, stderr: "" }
						: { code: 0, stdout: "", stderr: "" },
		} as unknown as ExtensionAPI;
		registerAloopExtension(pi, {
			retrieveEpicContext: async () => { retrievals += 1; return activeGraph; },
			closeIssue: async () => { closes += 1; return {}; },
		});
		const ctx = { cwd, hasUI: false, isIdle: () => true, signal: new AbortController().signal,
			abort: () => { aborts += 1; }, ui: { notify: () => undefined, setStatus: () => undefined } } as unknown as ExtensionContext;
		for (const handler of events.get("session_start") ?? []) handler({ reason: "startup" }, ctx);
		assert.deepEqual(activeTools, ["read"]);
		await commands.get("aloop")!.handler("#1", ctx);
		assert.equal(kickoffCount, 1);
		assert.ok(activeTools.includes("aloop_launch_worker"));
		assert.ok(activeTools.includes("aloop_context"));
		assert.ok(activeTools.includes("aloop_finish_attempt"));
		assert.equal(activeTools.includes("aloop_supervisor_verify"), false);
		await tools.get("aloop_context").execute("context", {}, ctx.signal, undefined, ctx);
		assert.equal(retrievals, 1);
		await tools.get("aloop_context").execute("refresh", { refresh: true }, ctx.signal, undefined, ctx);
		assert.equal(retrievals, 2);
		for (const handler of events.get("agent_settled") ?? []) handler({}, ctx);
		assert.deepEqual(activeTools, ["read"]);
		const artifactDirectory = ".pi/tmp/aloop/issue-2-100-abcdef";
		const attemptKey = createHash("sha256").update(`2:${artifactDirectory}`).digest("hex").slice(0, 24);
		const artifactPath = join(cwd, artifactDirectory);
		mkdirSync(artifactPath, { recursive: true });
		writeFileSync(join(artifactPath, "result.json"), JSON.stringify({ status: "completed", commit: "a".repeat(40), artifacts: { directory: artifactDirectory } }));
		const accepted = formatAloopHandoffV3({
			version: 3, issue: 2, issueBaseCommit: "a".repeat(40), commitRange: `${"a".repeat(40)}..${"a".repeat(40)}`,
			outcome: "accepted", summary: "done", outstandingFindings: [], decisions: [], verification: ["passed"],
			nextAction: "close", attemptKey, timestamp: "2026-09-03T00:00:00Z",
		});
		mkdirSync(join(cwd, ".pi/tmp/aloop/finalizations"), { recursive: true });
		writeFileSync(join(cwd, `.pi/tmp/aloop/finalizations/${attemptKey}.json`), JSON.stringify({
			version: 1, attemptKey, issue: 999, head: "f".repeat(40), commentSha256: "0".repeat(64),
		}));
		activeGraph = context([issue({ number: 2, title: "Leaf", recentHandoffs: [{ ...comment(1, accepted, "2026-09-03T00:00:00Z"), author: "untrusted-user" }] })]);
		await commands.get("aloop")!.handler("#1", ctx);
		assert.ok(activeTools.includes("aloop_launch_worker"));
		const recoveryContext = await tools.get("aloop_context").execute("context", {}, ctx.signal, undefined, ctx);
		assert.deepEqual(recoveryContext.details.closureRecoveries, [2]);
		assert.deepEqual(recoveryContext.details.unverifiedAccepted, []);
		assert.deepEqual(recoveryContext.details.frontier, []);
		await assert.rejects(() => tools.get("aloop_launch_worker").execute("duplicate", { issue: 2 }, ctx.signal, undefined, ctx), /Accepted handoffs await child closure/);
		const recoveryParams = { issue: 2, outcome: "accepted", summary: "ignored", outstanding_findings: [], decisions: [], verification: [], next_action: "ignored" };
		await assert.rejects(() => tools.get("aloop_finish_attempt").execute("untrusted", recoveryParams, ctx.signal, undefined, ctx), /authenticated supervisor or verified local publication provenance/);
		fakeHead = "b".repeat(40);
		await commands.get("aloop-authorize-recovery")!.handler(`2 ${attemptKey}`, ctx);
		const authorization = JSON.parse(readFileSync(join(cwd, ".pi/tmp/aloop/recovery-approvals", `${attemptKey}.json`), "utf8"));
		assert.deepEqual({ issue: authorization.issue, attemptKey: authorization.attemptKey, reviewedHead: authorization.reviewedHead, closureHead: authorization.closureHead, commentSha256: authorization.commentSha256, approvedVia: authorization.approvedVia }, {
			issue: 2, attemptKey, reviewedHead: "a".repeat(40), closureHead: "b".repeat(40), commentSha256: createHash("sha256").update(accepted).digest("hex"), approvedVia: "aloop-authorize-recovery command",
		});
		fakeHead = "c".repeat(40);
		await assert.rejects(() => tools.get("aloop_finish_attempt").execute("changed-after-approval", recoveryParams, ctx.signal, undefined, ctx), /human authorization is required/);
		fakeHead = "b".repeat(40);
		const recovered = await tools.get("aloop_finish_attempt").execute("recover", recoveryParams, ctx.signal, undefined, ctx);
		assert.equal(recovered.details.idempotent, true);
		assert.equal(closes, 1);
		await commands.get("aloop-abort")!.handler("", ctx);
		assert.equal(aborts, 1);
		assert.deepEqual(activeTools, ["read"]);
		for (const handler of events.get("session_shutdown") ?? []) handler({ reason: "reload" }, ctx);
		assert.deepEqual(activeTools, ["read"]);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("high-level review and finish publish one v3 handoff, close, and retry idempotently", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "aloop-v3-finish-"));
	try {
		const policyDocument = JSON.stringify({ canonicalCommand: { argv: [process.execPath, "-e", "const fs=require('fs'); if (!fs.existsSync('.v3-pass')) process.exit(2); if (!fs.existsSync('.v3-clean')) fs.writeFileSync('.verification-mutation','dirty')"] } });
		writeFileSync(join(cwd, ".aloop.json"), policyDocument);
		const tools = new Map<string, any>();
		const commands = new Map<string, any>();
		const head = "c".repeat(40);
		const graph = context([issue({ number: 2, title: "Leaf", body: "## Acceptance criteria\n- Done" })]);
		const published: Array<{ body: string; apply: boolean }> = [];
		let closes = 0;
		const pi = {
			registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand: (name: string, command: any) => commands.set(name, command),
			on: () => undefined, getActiveTools: () => [], setActiveTools: () => undefined, setSessionName: () => undefined, sendUserMessage: () => undefined,
			exec: async (_command: string, args: string[]) => args[0] === "show" ? { code: 0, stdout: policyDocument, stderr: "" }
				: args[0] === "log" ? { code: 0, stdout: "history", stderr: "" }
					: args[0] === "status" ? { code: 0, stdout: require("node:fs").existsSync(join(cwd, ".verification-mutation")) ? "?? .verification-mutation\n" : "", stderr: "" }
						: { code: 0, stdout: `${head}\n`, stderr: "" },
			appendEntry: () => undefined,
		} as unknown as ExtensionAPI;
		registerAloopExtension(pi, {
			retrieveEpicContext: async () => graph,
			runReview: async () => ({ content: [{ type: "text", text: "No findings." }], details: { reports: 2 } }),
			diagnoseCommand: async () => ({ summary: "canonical failed" }),
			runWorker: async () => ({ status: "completed", summary: "done", commit: head, workerResult: null, contract: { valid: true, commit: head, violations: [] }, process: { exitCode: 0, signal: null, timedOut: false, cancelled: false, durationMs: 1 }, artifacts: { directory: ".pi/tmp/aloop/issue-2-1-abcdef", prompt: "p", stdout: "o", stderr: "e", result: "r" } }),
			publishComment: async (_cwd, _issue, body, apply) => { published.push({ body, apply }); return {}; },
			closeIssue: async () => { closes += 1; if (closes === 1) throw new Error("interrupted closure"); return {}; },
		});
		const ctx = { cwd, hasUI: false, isIdle: () => true, signal: new AbortController().signal, abort: () => undefined, model: { provider: "p", id: "m" }, modelRegistry: { find: () => undefined, hasConfiguredAuth: () => false } } as unknown as ExtensionContext;
		await commands.get("aloop").handler("#1", ctx);
		await tools.get("aloop_launch_worker").execute("launch", { issue: 2 }, ctx.signal, undefined, ctx);
		await tools.get("aloop_review_attempt").execute("review", { issue: 2 }, ctx.signal, undefined, ctx);
		const params = { issue: 2, outcome: "accepted", summary: "Complete.", outstanding_findings: [], decisions: [], verification: ["reviewed"], next_action: "Continue." };
		const checkpoint = await tools.get("aloop_checkpoint").execute("checkpoint", { issue: 2, decision: "Choose mode", options: ["A", "B"] }, ctx.signal, undefined, ctx);
		assert.equal(checkpoint.terminate, true);
		await assert.rejects(() => tools.get("aloop_finish_attempt").execute("unresolved", params, ctx.signal, undefined, ctx), /unresolved or unattested human checkpoint/);
		await commands.get("aloop-decision").handler("2 A", ctx);
		assert.match(published.at(-1)!.body, /human decision recorded: A/i);
		assert.equal(JSON.parse(readFileSync(join(cwd, ".pi/tmp/aloop/decisions", `${checkpoint.details.marker}.json`), "utf8")).approvedVia, "aloop-decision command");
		const failed = await tools.get("aloop_finish_attempt").execute("failed", params, ctx.signal, undefined, ctx);
		assert.equal(failed.details.settled, false);
		assert.equal(closes, 0);
		assert.equal(published.filter((item) => item.body.includes("pi-aloop-handoff:v3")).length, 0);
		writeFileSync(join(cwd, ".v3-pass"), "pass\n");
		await assert.rejects(() => tools.get("aloop_finish_attempt").execute("mutated", params, ctx.signal, undefined, ctx), /Verification changed/);
		assert.equal(closes, 0);
		rmSync(join(cwd, ".verification-mutation"));
		writeFileSync(join(cwd, ".v3-clean"), "clean\n");
		await assert.rejects(() => tools.get("aloop_finish_attempt").execute("publish-then-crash", params, ctx.signal, undefined, ctx), /interrupted closure/);
		const v3Publications = published.filter((item) => item.body.includes("pi-aloop-handoff:v3"));
		const originalBody = v3Publications[1]!.body;
		assert.deepEqual(v3Publications.map((item) => item.apply), [false, true]);
		assert.doesNotMatch(originalBody.split("<!--", 1)[0]!, /artifact|receipt|spool/);
		const finished = await tools.get("aloop_finish_attempt").execute("retry", { ...params, summary: "Do not replace the published snapshot." }, ctx.signal, undefined, ctx);
		assert.equal(finished.details.closed, true);
		assert.equal(finished.details.handoff.summary, "Complete.");
		assert.equal(closes, 2);
		assert.deepEqual(published.filter((item) => item.body.includes("pi-aloop-handoff:v3")).map((item) => item.body), [originalBody, originalBody]);
		const repeated = await tools.get("aloop_finish_attempt").execute("repeated", params, ctx.signal, undefined, ctx);
		assert.equal(repeated.details.closed, true);
		assert.equal(closes, 2);
		await assert.rejects(() => tools.get("aloop_epic_completion").execute("missing-evidence", { phase: "prepare" }, ctx.signal, undefined, ctx), /requires acceptance_criteria evidence/);
		const prepared = await tools.get("aloop_epic_completion").execute("prepare", {
			phase: "prepare",
			acceptance_criteria: [
				{ criterion: "All children complete", satisfied: true, evidence: "#2 closed" },
				{ criterion: "Verification passes", satisfied: true, evidence: "canonical passed" },
			],
		}, ctx.signal, undefined, ctx);
		assert.equal(prepared.terminate, true);
		const preparedRecord = JSON.parse(readFileSync(join(cwd, ".pi/tmp/aloop/epic-approval.json"), "utf8"));
		assert.equal(preparedRecord.version, 2);
		assert.equal(preparedRecord.head, head);
		assert.equal(preparedRecord.evidence.verification[0].check, "canonical");
		await assert.rejects(() => tools.get("aloop_epic_completion").execute("unapproved", { phase: "apply" }, ctx.signal, undefined, ctx), /human \/aloop-approve-epic command/);
		await commands.get("aloop-approve-epic").handler(head, ctx);
		assert.equal(JSON.parse(readFileSync(join(cwd, ".pi/tmp/aloop/epic-approval.json"), "utf8")).approved, true);
		await tools.get("aloop_epic_completion").execute("approved", { phase: "apply" }, ctx.signal, undefined, ctx);
		assert.equal(closes, 3);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("registered aloop tools load verification policy, preserve exact publication, and close idempotently", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "aloop-extension-"));
	try {
		const policyDocument = JSON.stringify({
			canonicalCommand: { argv: [process.execPath, "-e", "if (!require('fs').existsSync('.verification-pass')) { console.error('expected failure'); process.exit(2); }"] },
			productionIntegration: { frequency: "issue", command: { argv: [process.execPath, "-e", "process.exit(0)"] } },
		});
		const verificationPolicy = JSON.parse(policyDocument) as { canonicalCommand: { argv: string[] }; productionIntegration: { frequency: "issue"; command: { argv: string[] } } };
		writeFileSync(join(cwd, ".aloop.json"), policyDocument);
		const tools = new Map<string, { execute: (...args: unknown[]) => Promise<{ details?: Record<string, unknown> }> }>();
		const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
		const priorFailure = formatAloopHandoff(handoff({ nextAction: "Use the exact remediation fixture." }));
		let graph = context([issue({ number: 2, title: "Leaf", body: "## Acceptance criteria\n\n- Done", recentHandoffs: [comment(1, priorFailure, "2026-09-01T00:00:00Z")] })]);
		let workerIssues: number[] = [];
		const workerDirections: string[] = [];
		const workerPriorContexts: unknown[] = [];
		let publicationApplyCalls = 0;
		let closeCalls = 0;
		let diagnosisCalls = 0;
		let patchCalls = 0;
		const patchTimeouts: number[] = [];
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
				if (args[0] === "log") return { code: 0, stdout: "history\n", stderr: "" };
				if (args[0] === "show") return { code: 0, stdout: policyDocument, stderr: "" };
				if (args[0] === "rev-parse") return { code: 0, stdout: `${fakeHead}\n`, stderr: "" };
				if (args[0] === "status") return { code: 0, stdout: worktreeStatus, stderr: "" };
				return { code: 0, stdout: "", stderr: "" };
			},
		} as unknown as ExtensionAPI;
		registerAloopExtension(pi, {
			retrieveEpicContext: async () => graph,
			runReview: async () => ({ content: [{ type: "text", text: "No findings." }], details: { reports: ["standards", "spec"] } }),
			diagnoseCommand: async (_ctx, _params, result) => { diagnosisCalls += 1; return { summary: `diagnosed exit ${result.code}` }; },
			runPatchWorker: async (input) => {
				patchCalls += 1;
				patchTimeouts.push(input.timeoutMs!);
				assert.match(input.correction, /assertion/);
				assert.equal(input.modelRef, "active/model");
				if (patchCalls === 1) fakeHead = "b".repeat(40);
				const commit = patchCalls === 1 ? fakeHead : null;
				return {
					status: patchCalls === 1 ? "completed" : "timeout", summary: "patch", commit, workerResult: null,
					contract: { valid: true, commit, violations: [] },
					process: { exitCode: 0, signal: null, timedOut: false, cancelled: false, durationMs: 1 },
					artifacts: { directory: ".pi/tmp/aloop/patch", prompt: "prompt", stdout: "stdout", stderr: "stderr", result: "result" },
				};
			},
			runWorker: async (input) => {
				workerIssues.push(input.issue.number);
				workerDirections.push(input.supervisorApproach);
				workerPriorContexts.push(input.priorHandoffs);
				mkdirSync(join(cwd, ".pi/tmp/aloop/issue-2-1-abcdef"), { recursive: true });
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
		const ctx = {
			cwd, isIdle: () => true, hasUI: false, signal: new AbortController().signal, abort: () => undefined,
			model: { provider: "active", id: "model" },
			modelRegistry: { find: () => undefined, hasConfiguredAuth: () => false },
		} as unknown as ExtensionContext;
		await commands.get("aloop")!.handler("#1 --max-minutes 5 --max-worker-launches 2", ctx);
		await assert.rejects(() => tools.get("aloop_supervisor_verify")!.execute("too-early", { commit: fakeHead }, ctx.signal, undefined, ctx), /pending worker attempt/);
		await tools.get("aloop_launch_worker")!.execute("launch", { issue: 2, attempt_type: "remediation", approach: "test wiring", materially_new_approach: true }, ctx.signal, undefined, ctx);
		assert.deepEqual(workerIssues, [2]);
		assert.deepEqual(workerDirections, ["Derive the issue and implement it within the selected child boundary."]);
		assert.deepEqual(workerPriorContexts, [[parseAloopHandoffs([comment(1, priorFailure, "2026-09-01T00:00:00Z")])[0]]]);
		const patched = await tools.get("aloop_apply_patch")!.execute("patch", { issue: 2, correction: "fix one assertion", timeout_ms: 14_400_000 }, ctx.signal, undefined, ctx);
		assert.equal(patchCalls, 1);
		assert.equal(patched.details?.fullWorkerLaunchesStarted, 1);
		await tools.get("aloop_apply_patch")!.execute("patch-failed", { issue: 2, correction: "fix another assertion" }, ctx.signal, undefined, ctx);
		assert.equal(patchCalls, 2);
		assert.deepEqual(patchTimeouts, [20 * 60_000, 20 * 60_000]);
		const review = await tools.get("aloop_review_attempt")!.execute("review", { issue: 2 }, ctx.signal, undefined, ctx);
		assert.deepEqual(review.details?.reports, ["standards", "spec"]);
		assert.deepEqual(JSON.parse(readFileSync(join(cwd, ".pi/tmp/aloop/issue-2-1-abcdef/patch-attempts.json"), "utf8")), [
			{ commit: "b".repeat(40), artifactDirectory: ".pi/tmp/aloop/patch", status: "completed" },
			{ commit: null, artifactDirectory: ".pi/tmp/aloop/patch", status: "timeout" },
		]);
		worktreeStatus = "?? eventual-source.ts\n";
		await assert.rejects(() => tools.get("aloop_supervisor_verify")!.execute("untracked", { commit: fakeHead }, ctx.signal, undefined, ctx), /clean worktree/);
		worktreeStatus = "";
		const failedVerification = await tools.get("aloop_supervisor_verify")!.execute("verify-failure", { commit: fakeHead }, ctx.signal, undefined, ctx);
		assert.equal(failedVerification.details?.valid, false);
		assert.equal(diagnosisCalls, 1);
		const failedCanonical = failedVerification.details?.canonical as any;
		assert.match(readFileSync(join(cwd, failedCanonical.logPath), "utf8"), /expected failure/);
		assert.equal(JSON.parse(readFileSync(join(cwd, failedCanonical.resultPath), "utf8")).diagnosis.summary, "diagnosed exit 2");
		writeFileSync(join(cwd, ".verification-pass"), "pass\n");
		const verified = await tools.get("aloop_supervisor_verify")!.execute("verify", { commit: fakeHead }, ctx.signal, undefined, ctx);
		assert.deepEqual((verified.details?.receipt as { command: string[] }).command, verificationPolicy.canonicalCommand.argv);
		assert.deepEqual((verified.details?.receipt as { productionIntegration: string[] }).productionIntegration, verificationPolicy.productionIntegration.command.argv);
		assert.equal((verified.details?.receipt as { productionIntegrationExitStatus?: number }).productionIntegrationExitStatus, 0);
		const reused = await tools.get("aloop_supervisor_verify")!.execute("verify-reuse", { commit: fakeHead }, ctx.signal, undefined, ctx);
		assert.equal(reused.details?.reused, true);

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
	const receipt = { commit: "abcdef1", command: ["nix", "run", ".#verify"], exitStatus: 0, timestamp: "2026-09-01T00:00:00Z", sourceIdentity: "tree:123" };
	assert.deepEqual(evaluateSupervisorAttempt({ returnedCommit: "abcdef1", currentHead: "abcdef1", worktreeStatus: "", receipt, acceptanceCriteria: [{ satisfied: true, evidence: "test" }]}), { allowed: true, reasons: [] });
	const changed = evaluateSupervisorAttempt({ returnedCommit: "abcdef1", currentHead: "abcdef2", worktreeStatus: " M source.ts", receipt, acceptanceCriteria: [{ satisfied: false, evidence: "" }], productionIntegrationRequired: true });
	assert.equal(changed.allowed, false);
	assert.match(changed.reasons.join(" "), /differs.*changed after verification.*acceptance criterion.*Production packaging/i);
});

test("successful handoffs require passing verification and a non-brittle supervisor assessment", () => {
	const issueBody = "## Acceptance criteria\n\n- Exact bytes are published\n- Retry is idempotent";
	assert.deepEqual(validateSuccessfulHandoffEvidence({
		issueBody,
		verification: ["canonical verification passed"],
		acceptanceCriteriaAssessment: [
			"PASS — Exact bytes are published — byte equality assertion passed",
			"PASS — Retry is idempotent — duplicate publication returned the existing comment",
		],
	}), []);
	assert.deepEqual(validateSuccessfulHandoffEvidence({
		issueBody,
		verification: ["canonical verification passed"],
		acceptanceCriteriaAssessment: ["Supervisor reviewed both criteria with specific test and commit evidence"],
	}), [], "assessment wording is supervisor judgment, not a formatting protocol");
	assert.deepEqual(validateSuccessfulHandoffEvidence({
		issueBody,
		verification: ["The first check failed; remediation and the bound receipt establish the final result"],
		acceptanceCriteriaAssessment: ["Partial wording may be discussed; the supervisor's explicit successful decision is authoritative"],
	}), [], "free-form evidence is not interpreted as a status protocol");
	assert.match(validateSuccessfulHandoffEvidence({ issueBody, verification: [""], acceptanceCriteriaAssessment: ["reviewed"] }).join(" "), /bound receipt determines mechanical pass\/fail/i);
	assert.match(validateSuccessfulHandoffEvidence({ issueBody, verification: ["passed"], acceptanceCriteriaAssessment: [] }).join(" "), /supervisor's acceptance assessment/i);
	assert.deepEqual(validateSuccessfulHandoffEvidence({ issueBody: "No criteria", verification: ["passed"], acceptanceCriteriaAssessment: [] }), []);
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
		command: ["nix", "run", ".#verify"],
		exitStatus: 0,
		timestamp: "2026-09-01T00:00:00Z",
		sourceIdentity: "tree:verified",
		postVerificationHead: commitId,
		postVerificationClean: true,
		productionIntegration: ["nix", "build", "--no-link", ".#pi-harness-resources"],
		productionIntegrationExitStatus: 0,
	};
	const closureIds = new Set<string>();
	let closes = 0;
	const close = async () => { closes += 1; return { closed: true }; };
	const base = {
		issue: child,
		epicNumber: 1,
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
	await assert.rejects(() => closeAcceptedAloopIssue({ ...base, dryRun: true, receipt: { ...receipt, productionIntegration: [] } }), /Production packaging/i);
	await assert.rejects(() => closeAcceptedAloopIssue({ ...base, dryRun: true, receipt: { ...receipt, productionIntegrationExitStatus: 1 } }), /Production packaging/i);
	await assert.rejects(() => closeAcceptedAloopIssue({ ...base, dryRun: true, currentHead: "b".repeat(40) }), /differs/i);
	await assert.rejects(() => closeAcceptedAloopIssue({ ...base, dryRun: true, worktreeStatus: " M source.ts" }), /changed after verification/i);
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
