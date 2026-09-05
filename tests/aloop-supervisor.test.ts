import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";
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
import { ALOOP_LIFECYCLE_ENTRY_TYPE, cancelManagedAloop, createAloopLifecycleEvent, delegateManagedAloopCheckpoint, parseAloopLifecycleEvent, registerManagedAloopAbortDelegate, registerManagedAloopCheckpointDelegate, sanitizeAloopCheckpointText } from "../config/agent/extensions/managed-sessions/aloop-lifecycle.js";
import {
	acceptedOpenAloopIssues,
	assessAloopRunBudget,
	buildEpicReport,
	buildSupervisorKickoff,
	evaluateEpicClosure,
	evaluateSupervisorAttempt,
	findOutstandingAttempts,
	formatAloopHandoffV3,
	nextIssueRetryNumber,
	parseAloopHandoffs,
	parseAloopHandoffV3,
	parseAloopRunRequest,
	selectAloopLeaf,
	validatedAcceptedCurrentStateHandoff,
	validatedChildReviewEvidence,
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

function legacyComment(value: AloopAttemptHandoff, version: "v1" | "v2" = "v1"): string {
	const payload = version === "v1"
		? Buffer.from(JSON.stringify(value), "utf8")
		: deflateRawSync(Buffer.from(JSON.stringify({ v: 2, i: value.issue, y: value.attemptType, c: value.commit, u: value.verificationReceiptId, s: value.successful, a: value.approach, n: value.materiallyNewApproach, q: value.verification, r: value.acceptanceCriteriaAssessment, d: value.discoveredWork, x: value.nextAction, p: value.artifactDirectory, t: value.timestamp }), "utf8"));
	return `<!-- pi-aloop-handoff:${version}:${payload.toString("base64url")} -->`;
}

test("phone-safe aloop lifecycle summaries redact plumbing while preserving commands", () => {
	const event = createAloopLifecycleEvent("checkpoint", 53, "Inspect /home/operator/.pi/tmp/x and verify-aaaaaaaaaaaa-1-bbbbbbbb <!-- pi-aloop-handoff:v3:secret -->; reply /aloop-decision 66 approve.", 66);
	assert.match(event.body, /•/);
	assert.match(event.body, /\/aloop-decision 66 approve/);
	assert.doesNotMatch(event.body, /\/home|\.pi\/tmp|verify-|pi-aloop|secret/);
	assert.deepEqual(parseAloopLifecycleEvent(event), event);
	assert.equal(parseAloopLifecycleEvent({ ...event, body: "leak /tmp/secret" }), undefined);
	assert.equal(sanitizeAloopCheckpointText("Inspect src/private/incident.md before choosing."), "Inspect • before choosing.");
});

test("managed aloop delegates are isolated by Pi session identity", async () => {
	const calls: string[] = [];
	const removeAbortA = registerManagedAloopAbortDelegate("session-a", () => calls.push("abort-a"));
	const removeAbortB = registerManagedAloopAbortDelegate("session-b", () => calls.push("abort-b"));
	const removeCheckpointA = registerManagedAloopCheckpointDelegate("session-a", async () => { calls.push("checkpoint-a"); });
	const removeCheckpointB = registerManagedAloopCheckpointDelegate("session-b", async () => { calls.push("checkpoint-b"); });
	assert.equal(cancelManagedAloop("session-a"), true);
	assert.equal(await delegateManagedAloopCheckpoint("session-b", "call", { kind: "question" }), true);
	assert.deepEqual(calls, ["abort-a", "checkpoint-b"]);
	removeAbortA(); removeAbortB(); removeCheckpointA(); removeCheckpointB();
	assert.equal(cancelManagedAloop("session-a"), false);
});

test("aloop invocations separate worker-launch resource bounds from issue retries", () => {
	assert.deepEqual(parseAloopRunRequest("#48"), { epic: 48, maxMinutes: 60, maxWorkerLaunches: 20, settlementMinutes: 20 });
	assert.deepEqual(parseAloopRunRequest("48 --max-minutes=12 --max-worker-launches 12"), { epic: 48, maxMinutes: 12, maxWorkerLaunches: 12, settlementMinutes: 20 });
	assert.equal(parseAloopRunRequest("#48 --settlement-minutes=3").settlementMinutes, 3);
	assert.throws(() => parseAloopRunRequest("#48 --settlement-minutes 61"), /between 1 and 60/);
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

test("retry accounting derives remediation numbering from legacy read-only handoffs without a semantic gate", () => {
	const failures = [handoff(), handoff({ attemptType: "remediation", approach: "Same approach" })];
	assert.equal(nextIssueRetryNumber([], "implementation"), 0);
	assert.equal(nextIssueRetryNumber(failures.slice(0, 1), "remediation"), 1);
	assert.equal(nextIssueRetryNumber(failures, "remediation"), 2);
	assert.equal(nextIssueRetryNumber([...failures, handoff({ successful: true })], "remediation"), 1);
});

test("legacy v1/v2 handoffs remain read-only decoding compatibility", () => {
	const first = legacyComment(handoff());
	const second = legacyComment(handoff({ attemptType: "remediation", commit: "abcdef2", successful: true, nextAction: "Close child.", artifactDirectory: ".pi/tmp/aloop/remediation" }), "v2");
	const parsed = parseAloopHandoffs([
		comment(3, second, "2026-09-01T02:00:00Z"),
		comment(2, first, "2026-09-01T01:00:00Z"),
		comment(1, "ordinary comment", "2026-09-01T00:00:00Z"),
	]);
	assert.deepEqual(parsed.map((item) => item.commit), ["abcdef1", "abcdef2"]);
	assert.equal(parsed[1]?.successful, true);
	assert.deepEqual(parseAloopHandoffs([comment(4, "<!-- pi-aloop-handoff:v2:not-valid -->", "2026-09-01T03:00:00Z")]), []);
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

test("epic evidence accepts only validated accepted handoffs bound to review and verification", () => {
	const base = {
		version: 3 as const, issue: 2, issueBaseCommit: "a".repeat(40), commitRange: `${"a".repeat(40)}..${"b".repeat(40)}`,
		outcome: "accepted" as const, summary: "Done.", outstandingFindings: [], decisions: [],
		nextAction: "Close.", attemptKey: "c".repeat(24), timestamp: "2026-09-03T00:00:00Z",
	};
	const valid = formatAloopHandoffV3({ ...base, verification: [`Independent review completed at ${"b".repeat(40)}.`, `Canonical command passed at ${"b".repeat(40)}.`] });
	assert.match(validatedChildReviewEvidence(issue({ number: 2, title: "Closed", state: "closed", recentHandoffs: [comment(1, valid, "2026-09-03T00:00:00Z")] }), "supervisor") ?? "", /Accepted v3 handoff/);
	const malformed = `<!-- pi-aloop-handoff:v3:${Buffer.from("not-json").toString("base64url")} -->`;
	assert.equal(validatedChildReviewEvidence(issue({ number: 2, title: "Malformed", state: "closed", recentHandoffs: [comment(2, malformed, "2026-09-03T00:00:00Z")] }), "supervisor"), null);
	assert.equal(validatedChildReviewEvidence(issue({ number: 2, title: "Rejected", state: "closed", recentHandoffs: [comment(3, formatAloopHandoffV3({ ...base, outcome: "rejected", verification: [`Independent review completed at ${"b".repeat(40)}.`, `Canonical command passed at ${"b".repeat(40)}.`] }), "2026-09-03T00:00:00Z")] }), "supervisor"), null);
	const forged = { ...comment(4, valid, "2026-09-03T00:00:00Z"), author: "untrusted-user" };
	assert.equal(validatedChildReviewEvidence(issue({ number: 2, title: "Untrusted", state: "closed", recentHandoffs: [forged] }), "supervisor"), null);
	const supersedingRejected = formatAloopHandoffV3({ ...base, outcome: "rejected", verification: [], attemptKey: "d".repeat(24), timestamp: "2026-09-03T00:01:00Z" });
	const superseded = issue({ number: 2, title: "Superseded", state: "closed", recentHandoffs: [comment(1, valid, "2026-09-03T00:00:00Z"), comment(2, supersedingRejected, "2026-09-03T00:01:00Z")] });
	assert.equal(validatedChildReviewEvidence(superseded, "supervisor"), null, "epic evidence must not fall back to an older accepted state");
	assert.equal(validatedAcceptedCurrentStateHandoff(superseded, "b".repeat(40)), null, "recovery uses the same current-state validator");
	assert.throws(() => formatAloopHandoffV3({ ...base, outstandingFindings: ["Follow up"], verification: [`Independent review completed at ${"b".repeat(40)}.`, `Canonical command passed at ${"b".repeat(40)}.`] }), /Invalid fixed fields/, "accepted states cannot be emitted with outstanding findings");
	const missingCanonical = formatAloopHandoffV3({ ...base, verification: [`Independent review completed at ${"b".repeat(40)}.`] });
	assert.equal(validatedAcceptedCurrentStateHandoff(issue({ number: 2, title: "Unverified", recentHandoffs: [comment(4, missingCanonical, "2026-09-03T00:03:00Z")] }), "b".repeat(40)), null, "recovery requires canonical evidence at the recovered HEAD");
	const humanClaim = formatAloopHandoffV3({ ...base, verification: [`Human review decision recorded at ${"b".repeat(40)}.`, `Canonical command passed at ${"b".repeat(40)}.`] });
	assert.equal(validatedAcceptedCurrentStateHandoff(issue({ number: 2, title: "Asserted review", recentHandoffs: [comment(5, humanClaim, "2026-09-03T00:04:00Z")] }), "b".repeat(40)), null, "a handoff sentence alone is not a human review attestation");
	const marker = "e".repeat(20);
	const attested = issue({ number: 2, title: "Attested review", recentHandoffs: [
		comment(5, `<!-- pi-aloop-review-decision:${marker}:${"b".repeat(40)}:open -->`, "2026-09-03T00:04:00Z"),
		comment(6, `<!-- pi-aloop-review-decision:${marker}:${"b".repeat(40)}:resolved -->`, "2026-09-03T00:05:00Z"),
		comment(7, humanClaim, "2026-09-03T00:06:00Z"),
	] });
	assert.ok(validatedAcceptedCurrentStateHandoff(attested, "b".repeat(40), "supervisor"));
	assert.equal(validatedAcceptedCurrentStateHandoff(attested, "b".repeat(40), "different-user"), null);
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
	assert.throws(() => formatAloopHandoffV3({ ...handoff, issueBaseCommit: "e".repeat(40) }), /Invalid fixed fields/);
	assert.equal(parseAloopHandoffV3(`<!-- pi-aloop-handoff:v3:${Buffer.from(JSON.stringify({ ...handoff, extra: true })).toString("base64url")} -->`), null);
	const shadowMarker = formatAloopHandoffV3({ ...handoff, attemptKey: "e".repeat(24) }).match(/<!-- pi-aloop-handoff:v3:[^ ]+ -->/)![0];
	const shadowBody = formatAloopHandoffV3({ ...handoff, summary: "Do not emit <!-- fake-marker --> here" });
	assert.equal(parseAloopHandoffV3(`${shadowMarker}\n${shadowBody}`)?.attemptKey, handoff.attemptKey);
	assert.doesNotMatch(shadowBody.split("\n\n<!-- pi-aloop-handoff:v3:", 1)[0]!, /<!--/);
	assert.throws(() => formatAloopHandoffV3({ ...handoff, summary: "😀".repeat(100_000) }), /Invalid fixed fields/);
	const completeFindings = Array(4).fill(0).map((_, index) => `separate finding ${index}`);
	assert.deepEqual(parseAloopHandoffV3(formatAloopHandoffV3({ ...handoff, outstandingFindings: completeFindings }))?.outstandingFindings, completeFindings);
	assert.throws(() => formatAloopHandoffV3({ ...handoff, outstandingFindings: Array(7).fill("consolidate me") }), /Invalid fixed fields/);
	assert.throws(() => formatAloopHandoffV3({ ...handoff, timestamp: "x".repeat(100_000) }), /Invalid fixed fields/);
	assert.throws(() => formatAloopHandoffV3({ ...handoff, version: 2 } as any), /Invalid fixed fields/);
	assert.throws(() => formatAloopHandoffV3({ ...handoff, outcome: "invented" } as any), /Invalid fixed fields/);
	assert.equal(parseAloopHandoffV3(`${"x".repeat(20_001)}${formatAloopHandoffV3(handoff)}`), null);
	const head = "b".repeat(40);
	assert.throws(() => formatAloopHandoffV3({ ...handoff, outcome: "accepted" }), /Invalid fixed fields/);
	const receipts = parseAloopHandoffV3(formatAloopHandoffV3({ ...handoff, outcome: "accepted", outstandingFindings: [], verification: ["user 1", "user 2", "user 3", `Independent review completed at ${head}.`, `Canonical command passed at ${head}.`] }))!.verification;
	assert.deepEqual(receipts, ["user 1", "user 2", "user 3", `Independent review completed at ${head}.`, `Canonical command passed at ${head}.`]);
	const allRequired = parseAloopHandoffV3(formatAloopHandoffV3({ ...handoff, outcome: "accepted", outstandingFindings: [], verification: [`Canonical command passed at ${head}.`, `Production integration passed at ${head}.`, `Independent review completed at ${head}.`, `Human review decision recorded at ${head}.`] }))!.verification;
	assert.deepEqual(allRequired, [`Canonical command passed at ${head}.`, `Production integration passed at ${head}.`, `Independent review completed at ${head}.`, `Human review decision recorded at ${head}.`]);
	assert.match(formatAloopHandoffV3({ ...handoff, outcome: "accepted", outstandingFindings: [], verification: [`Independent review completed at ${head}.`, `Canonical command passed at ${head}.`] }), /Outstanding: none\./);
});

test("v3 handoffs redact caller-supplied recovery plumbing from every visible field", () => {
	const handoff = {
		version: 3 as const, issue: 73, issueBaseCommit: "a".repeat(40), commitRange: `${"a".repeat(40)}..${"b".repeat(40)}`,
		outcome: "rejected" as const,
		summary: "Paths: /home/x, label:/var/x, [/home/y], <code>/home/operator/project/.pi/tmp/aloop</code>, ~alice/p, C:/Users/x, file://localhost/home/x, ~\\x, \\Users\\x, \\\\server\\x",
		outstandingFindings: ["blob-transfer-opaque-id remains inaccessible"],
		decisions: ["Receipt verify-aaaaaaaaaaaa-42-bbbbbbbb is internal"],
		verification: [`Spool ID: ${"c".repeat(24)} and spool-opaque-id-123 were checked`],
		nextAction: "Do not publish <!-- pi-aloop-recovery-authorization:v1:abc_DEF-123 -->.",
		attemptKey: "d".repeat(24), timestamp: "2026-09-03T00:00:00Z",
	};
	const body = formatAloopHandoffV3(handoff);
	const visible = body.split("<!--", 1)[0]!;
	assert.doesNotMatch(visible, /\/home\/|\/var\/|~alice|C:\/Users|file:\/\/|\\Users|\\server|\.pi\/tmp|operator\/project|verify-aaaaaaaaaaaa-42-bbbbbbbb|c{24}|spool-opaque-id-123|abc_DEF-123/);
	assert.match(visible, /•/);
	const parsed = parseAloopHandoffV3(body)!;
	const expansionProbe = formatAloopHandoffV3({ ...handoff, summary: `${Array(60).fill("/a").join(" ")} tail` });
	assert.ok(parseAloopHandoffV3(expansionProbe), "redaction must not expand a schema-valid field beyond parser bounds");
	for (const value of [parsed.summary, ...parsed.outstandingFindings, ...parsed.decisions, ...parsed.verification, parsed.nextAction]) {
		assert.doesNotMatch(value, /\/home\/|\/var\/|~alice|C:\/Users|file:\/\/|\\Users|\\server|\.pi\/tmp|operator\/project|verify-aaaaaaaaaaaa-42-bbbbbbbb|c{24}|spool-opaque-id-123|abc_DEF-123/);
	}
});

test("attempt recovery uses the latest durable non-null patch commit", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "aloop-patch-recovery-"));
	try {
		const directory = join(cwd, ".pi/tmp/aloop/issue-2-100-abcdef");
		mkdirSync(directory, { recursive: true });
		writeFileSync(join(directory, "result.json"), JSON.stringify({
			status: "completed", commit: "a".repeat(40), artifacts: { directory: ".pi/tmp/aloop/issue-2-100-abcdef" },
		}));
		const patchArtifactDirectory = ".pi/tmp/aloop/issue-2-101-fedcba";
		const patchDirectory = join(cwd, patchArtifactDirectory);
		mkdirSync(patchDirectory, { recursive: true });
		writeFileSync(join(patchDirectory, "result.json"), JSON.stringify({ status: "completed", commit: "b".repeat(40), artifacts: { directory: patchArtifactDirectory } }));
		writeFileSync(join(directory, "patch-attempts.json"), JSON.stringify([
			{ status: "completed", commit: "b".repeat(40), artifactDirectory: patchArtifactDirectory },
			{ status: "timeout", commit: null },
		]));
		const records = await scanAttemptArtifacts(cwd);
		assert.equal(records.length, 1);
		assert.equal(records[0]?.commit, "b".repeat(40));
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("aloop recovery requires GitHub-recorded authorization and evidence bound to the clean current HEAD", async () => {
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
		const lifecycleEvents: unknown[] = [];
		const pi = {
			registerTool: (tool: { name: string }) => { activeTools.push(tool.name); tools.set(tool.name, tool); },
			registerCommand: (name: string, command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => commands.set(name, command),
			on: (event: string, handler: (...args: any[]) => any) => events.set(event, [...(events.get(event) ?? []), handler]),
			getActiveTools: () => activeTools,
			setActiveTools: (tools: string[]) => { activeTools = tools; },
			setSessionName: () => undefined,
			sendUserMessage: () => { kickoffCount += 1; },
			appendEntry: (customType: string, data: unknown) => { if (customType === ALOOP_LIFECYCLE_ENTRY_TYPE) lifecycleEvents.push(data); },
			exec: async (_command: string, args: string[]) => _command === "gh"
				? { code: 0, stdout: "supervisor\n", stderr: "" }
				: args[0] === "log"
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
			publishComment: async () => ({ user: { login: "supervisor" } }),
		});
		const ctx = { cwd, hasUI: false, isIdle: () => true, signal: new AbortController().signal, sessionManager: { getSessionId: () => "test-session" },
			abort: () => { aborts += 1; }, ui: { notify: () => undefined, setStatus: () => undefined } } as unknown as ExtensionContext;
		for (const handler of events.get("session_start") ?? []) handler({ reason: "startup" }, ctx);
		assert.deepEqual(activeTools, ["read"]);
		await commands.get("aloop")!.handler("#1", ctx);
		assert.equal(kickoffCount, 1);
		const startup = parseAloopLifecycleEvent(lifecycleEvents[0]);
		assert.equal(startup?.kind, "startup");
		assert.match(startup?.body ?? "", /epic #1.*Selected child: #2.*60 implementation minutes.*20 additional settlement minutes.*20 full-worker launches.*supervisor\/implementation:/);
		assert.doesNotMatch(startup?.body ?? "", /\.pi\/tmp|receipt|spool|verify-/i);
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
			outcome: "accepted", summary: "done", outstandingFindings: [], decisions: [], verification: [`Independent review completed at ${"a".repeat(40)}.`, `Canonical command passed at ${"a".repeat(40)}.`],
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
		const untrusted = await tools.get("aloop_finish_attempt").execute("untrusted", recoveryParams, ctx.signal, undefined, ctx);
		assert.equal(untrusted.terminate, true);
		assert.match(untrusted.content[0].text, /human closure-recovery decision/i);
		assert.doesNotMatch(JSON.stringify(untrusted), /aloop-authorize-recovery|attemptKey/);
		for (const handler of events.get("agent_settled") ?? []) handler({}, ctx);
		assert.ok(activeTools.includes("aloop_finish_attempt"), "human boundary must retain active aloop tools for slash-command continuation");
		await commands.get("aloop-authorize-recovery")!.handler(`2 ${attemptKey}`, ctx);
		assert.equal(require("node:fs").existsSync(join(cwd, ".pi/tmp/aloop/recovery-approvals", `${attemptKey}.json`)), false);
		assert.match(activeGraph.issues[1]!.recentHandoffs.at(-1)!.body, /pi-aloop-recovery-authorization:v1:/);
		await commands.get("aloop")!.handler("#1", ctx);
		fakeHead = "c".repeat(40);
		await assert.rejects(() => tools.get("aloop_finish_attempt").execute("changed-after-approval", recoveryParams, ctx.signal, undefined, ctx), /durable review and canonical verification evidence bound to the clean current HEAD/);
		fakeHead = "a".repeat(40);
		const recovered = await tools.get("aloop_finish_attempt").execute("recover", recoveryParams, ctx.signal, undefined, ctx);
		assert.equal(recovered.details.idempotent, true);
		assert.equal(closes, 1);
		for (const handler of events.get("agent_settled") ?? []) handler({}, ctx);
		assert.deepEqual(activeTools, ["read"], "successful authorized recovery clears its pending human boundary");
		assert.equal(cancelManagedAloop("test-session"), true, "managed !abort reaches aloop even after earlier human-boundary settlement");
		ctx.abort();
		assert.equal(aborts, 1);
		assert.ok(lifecycleEvents.map(parseAloopLifecycleEvent).some((event) => event?.kind === "cancelled"));
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
			exec: async (_command: string, args: string[]) => _command === "gh" ? { code: 0, stdout: "test-supervisor\n", stderr: "" }
				: args[0] === "show" ? { code: 0, stdout: policyDocument, stderr: "" }
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
			publishComment: async (_cwd, _issue, body, apply) => { published.push({ body, apply }); return apply ? { user: { login: "test-supervisor" } } : {}; },
			closeIssue: async () => { closes += 1; if (closes === 1) throw new Error("interrupted closure"); return {}; },
		});
		const ctx = { cwd, hasUI: false, isIdle: () => true, signal: new AbortController().signal, abort: () => undefined, sessionManager: { getSessionId: () => "finish-session" }, model: { provider: "p", id: "m" }, modelRegistry: { find: () => undefined, hasConfiguredAuth: () => false } } as unknown as ExtensionContext;
		await commands.get("aloop").handler("#1", ctx);
		await tools.get("aloop_launch_worker").execute("launch", { issue: 2 }, ctx.signal, undefined, ctx);
		const params = { issue: 2, outcome: "accepted", summary: "Complete.", outstanding_findings: [], decisions: [], verification: ["reviewed"], next_action: "Continue." };
		await assert.rejects(() => tools.get("aloop_finish_attempt").execute("findings", { ...params, outstanding_findings: ["still broken"] }, ctx.signal, undefined, ctx), /all outstanding findings to be resolved/);
		const checkpoint = await tools.get("aloop_checkpoint").execute("checkpoint", { issue: 2, decision: "Choose mode", options: ["A", "B"] }, ctx.signal, undefined, ctx);
		assert.equal(checkpoint.terminate, true);
		await assert.rejects(() => tools.get("aloop_finish_attempt").execute("unresolved", params, ctx.signal, undefined, ctx), /unresolved or unattested human checkpoint/);
		await commands.get("aloop-decision").handler("2 A", ctx);
		assert.match(published.at(-1)!.body, /human decision recorded: A/i);
		assert.equal(JSON.parse(readFileSync(join(cwd, ".pi/tmp/aloop/decisions", `${checkpoint.details.marker}.json`), "utf8")).approvedVia, "aloop-decision command");
		await assert.rejects(() => tools.get("aloop_finish_attempt").execute("generic-does-not-approve-review", params, ctx.signal, undefined, ctx), /fresh independent review.*review checkpoint/i);
		await tools.get("aloop_review_attempt").execute("review", { issue: 2 }, ctx.signal, undefined, ctx);
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
