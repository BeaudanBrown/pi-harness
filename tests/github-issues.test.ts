import assert from "node:assert/strict";
import test from "node:test";
import { chmod, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { bodyWithMarker, completeMigrationCleanup, executeMigration, frontierIssueNumbers, inspectGraph, issueMarker, migrationIssuePlan, retrieveCurrentRepositoryEpicContext, validateIssuePlan, type MigrationRecord, type MigrationReconciliation } from "../config/agent/extensions/github-issues/index.js";
import { retrieveGitHubEpicContext } from "../config/agent/extensions/github-issues/github-context.js";

test("issue plans receive stable provenance markers", () => {
	assert.equal(issueMarker("migration-2026", "closed-epic"), "<!-- pi-harness-plan:migration-2026/closed-epic -->");
	assert.equal(bodyWithMarker("migration-2026", {
		key: "closed-epic",
		title: "Closed epic",
		body: "Historical context",
	}), "Historical context\n\n<!-- pi-harness-plan:migration-2026/closed-epic -->");
});

test("issue plans validate dependency keys and cycles before publication", () => {
	assert.doesNotThrow(() => validateIssuePlan({
		key: "workflow",
		issues: [
			{ key: "first", title: "First", body: "" },
			{ key: "second", title: "Second", body: "", blockedBy: ["first"] },
		],
	}));

	assert.throws(() => validateIssuePlan({
		key: "workflow",
		issues: [{ key: "first", title: "First", body: "", blockedBy: ["missing"] }],
	}), /missing blocker key/);

	assert.throws(() => validateIssuePlan({
		key: "workflow",
		issues: [
			{ key: "first", title: "First", body: "", blockedBy: ["second"] },
			{ key: "second", title: "Second", body: "", blockedBy: ["first"] },
		],
	}), /dependency cycle/);

	assert.throws(() => validateIssuePlan({
		key: "workflow",
		issues: [
			{ key: "first", title: "First", body: "", parent: "second" },
			{ key: "second", title: "Second", body: "", parent: "first" },
		],
	}), /parent cycle/);

	assert.throws(() => validateIssuePlan({
		key: "workflow",
		issues: Array.from({ length: 9 }, (_, index) => ({ key: `level-${index}`, title: `Level ${index}`, body: "", parent: index > 0 ? `level-${index - 1}` : undefined })),
	}), /eight-level limit/);
});

test("migration fixtures produce an idempotent plan and omit approved stale records", async () => {
	const records = JSON.parse(await readFile("tests/fixtures/tk-migration/records.json", "utf8")) as MigrationRecord[];
	const plan = migrationIssuePlan("fixture-migration", records);

	assert.deepEqual(plan.issues.map((issue) => issue.key), ["tk-epic", "tk-first", "tk-later"]);
	assert.equal(plan.issues[2]?.state, "closed");
	assert.equal(plan.issues[1]?.parent, "tk-epic");
	assert.deepEqual(plan.issues[2]?.blockedBy, ["tk-first"]);
	assert.match(plan.issues[0]?.body ?? "", /Migrated from tk ticket `tk-epic`/);
	assert.equal(plan.issues.some((issue) => issue.key === "tk-stale"), false);
	assert.equal(issueMarker(plan.key, plan.issues[0]!.key), "<!-- pi-harness-plan:fixture-migration/tk-epic -->");
});

test("frontier selection requires an open, ready, unassigned issue without blockers", () => {
	assert.deepEqual(frontierIssueNumbers([
		{ number: 2, state: "open", labels: [{ name: "ready-for-agent" }], assignee: null, issue_dependencies_summary: { blocked_by: 0 } },
		{ number: 3, state: "open", labels: [{ name: "ready-for-agent" }], assignee: { login: "other" }, issue_dependencies_summary: { blocked_by: 0 } },
		{ number: 4, state: "open", labels: [{ name: "ready-for-agent" }], assignee: null, issue_dependencies_summary: { blocked_by: 1 } },
		{ number: 5, state: "closed", labels: [{ name: "ready-for-agent" }], assignee: null, issue_dependencies_summary: { blocked_by: 0 } },
	]), [2]);
});

test("recursive epic context normalizes nested issues and selects executable leaves", async () => {
	const issues = new Map([
		[1, { number: 1, title: "Epic", body: "Goal", state: "open", labels: [], assignee: null, comments: 0 }],
		[2, { number: 2, title: "Nested parent", body: "Parent", state: "open", labels: [{ name: "enhancement" }], assignee: { login: "agent" }, comments: 0 }],
		[3, { number: 3, title: "Closed leaf", body: "Done", state: "closed", labels: [], assignee: null, comments: 0 }],
		[4, { number: 4, title: "Blocked leaf", body: "Wait", state: "open", labels: [], assignee: null, comments: 0 }],
		[5, { number: 5, title: "Ready leaf", body: "Build", state: "open", labels: [{ name: "ready-for-agent" }], assignee: null, comments: 4 }],
	]);
	const children = new Map([[1, [issues.get(3), issues.get(2)]], [2, [issues.get(5), issues.get(4)]]]);
	const blockers = new Map([[4, [{ number: 9, title: "Open blocker", state: "open" }]]]);
	const comments = new Map([[5, [
		{ id: 1, body: "first", created_at: "2026-01-01", html_url: "comment/1", user: { login: "one" } },
		{ id: 2, body: "second", created_at: "2026-01-02", html_url: "comment/2", user: { login: "two" } },
		{ id: 3, body: "third-long", created_at: "2026-01-03", html_url: "comment/3", user: { login: "three" } },
		{ id: 4, body: "fourth", created_at: "2026-01-04", html_url: "comment/4", user: { login: "four" } },
	]]]);
	const client = async (endpoint: string): Promise<unknown> => {
		const number = Number(endpoint.match(/^issues\/(\d+)/)?.[1]);
		if (endpoint.includes("/sub_issues")) return children.get(number) ?? [];
		if (endpoint.includes("/dependencies/blocked_by")) return blockers.get(number) ?? [];
		if (endpoint.includes("/comments")) return comments.get(number) ?? [];
		return issues.get(number);
	};

	const context = await retrieveGitHubEpicContext(client, 1, { commentLimit: 2, commentBodyLimit: 8 });

	assert.deepEqual(context.issues.map((issue) => issue.number), [1, 2, 3, 4, 5]);
	assert.deepEqual(context.executableLeaves, [5]);
	assert.deepEqual(context.issues.find((issue) => issue.number === 5)?.parent, { number: 2, title: "Nested parent", state: "open" });
	assert.deepEqual(context.issues.find((issue) => issue.number === 4)?.blockers, [{ number: 9, title: "Open blocker", state: "open" }]);
	assert.deepEqual(context.issues.find((issue) => issue.number === 5)?.recentHandoffs.map((comment) => comment.id), [3, 4]);
	assert.equal(context.issues.find((issue) => issue.number === 5)?.recentHandoffs[0]?.body, "third-l…");
});

test("epic context paginates sub-issues and blockers before selecting leaves", async () => {
	const epic = { number: 100, title: "Large epic", state: "open", labels: [], comments: 0 };
	const descendants = Array.from({ length: 101 }, (_, index) => ({
		number: 101 + index,
		title: `Child ${101 + index}`,
		state: index === 100 ? "open" : "closed",
		labels: [],
		comments: 0,
	}));
	const blockers = Array.from({ length: 101 }, (_, index) => ({
		number: 300 + index,
		title: `Blocker ${300 + index}`,
		state: index === 100 ? "open" : "closed",
	}));
	const issues = new Map([[epic.number, epic], ...descendants.map((issue) => [issue.number, issue] as const)]);
	const client = async (endpoint: string): Promise<unknown> => {
		const number = Number(endpoint.match(/^issues\/(\d+)/)?.[1]);
		const page = Number(new URLSearchParams(endpoint.split("?")[1] ?? "").get("page") ?? 1);
		if (endpoint.includes("/sub_issues")) {
			const values = number === epic.number ? descendants : [];
			return values.slice((page - 1) * 100, page * 100);
		}
		if (endpoint.includes("/dependencies/blocked_by")) {
			const values = number === 201 ? blockers : [];
			return values.slice((page - 1) * 100, page * 100);
		}
		if (endpoint.includes("/comments")) return [];
		return issues.get(number);
	};

	const context = await retrieveGitHubEpicContext(client, epic.number);
	assert.equal(context.issues.length, 102);
	assert.equal(context.issues.find((issue) => issue.number === 201)?.blockers.length, 101);
	assert.deepEqual(context.executableLeaves, []);
});

test("epic context reports no executable leaf when descendants are closed or blocked", async () => {
	const issues = new Map([
		[10, { number: 10, title: "Epic", state: "open", labels: [], comments: 0 }],
		[11, { number: 11, title: "Closed", state: "closed", labels: [], comments: 0 }],
		[12, { number: 12, title: "Blocked", state: "open", labels: [], comments: 0 }],
	]);
	const client = async (endpoint: string): Promise<unknown> => {
		const number = Number(endpoint.match(/^issues\/(\d+)/)?.[1]);
		if (endpoint.includes("/sub_issues")) return number === 10 ? [issues.get(11), issues.get(12)] : [];
		if (endpoint.includes("/dependencies/blocked_by")) return number === 12 ? [{ number: 13, title: "Blocker", state: "open" }] : [];
		if (endpoint.includes("/comments")) return [];
		return issues.get(number);
	};

	const context = await retrieveGitHubEpicContext(client, 10);
	assert.deepEqual(context.executableLeaves, []);
});

test("migration executor retries issues, resumes relationships, and gates cleanup", async () => {
	const cwd = await mkdtemp(path.join(tmpdir(), "tk-migration-e2e-"));
	await mkdir(path.join(cwd, ".pi/tmp/tk-to-github"), { recursive: true });
	await mkdir(path.join(cwd, ".tickets"));
	await mkdir(path.join(cwd, "docs/agents"), { recursive: true });
	await writeFile(path.join(cwd, ".tickets/source.md"), "source");
	await writeFile(path.join(cwd, "docs/agents/issue-tracker.md"), "# Issue tracker: tk\n\ntk is authoritative\n\n## Conventions\n\n- Claim active work before changing code.\n");
	const records = JSON.parse(await readFile("tests/fixtures/tk-migration/records.json", "utf8")) as MigrationRecord[];
	assert.throws(() => migrationIssuePlan("unapproved", records.map((record) => record.disposition === "omit" ? { ...record, omissionApproved: false } : record)), /requires explicit approval/);
	const plan = migrationIssuePlan("e2e-fixture", records);
	await writeFile(path.join(cwd, ".pi/tmp/tk-to-github/migration.json"), JSON.stringify({ records }));
	await writeFile(path.join(cwd, ".pi/tmp/tk-to-github/github-issue-plan.json"), JSON.stringify(plan));
	const bin = path.join(cwd, "bin");
	await mkdir(bin);
	await cp("tests/fixtures/tk-migration/fake-gh.mjs", path.join(bin, "gh"));
	await chmod(path.join(bin, "gh"), 0o755);
	const statePath = path.join(cwd, "github-state.json");
	const oldPath = process.env.PATH;
	process.env.PATH = `${bin}:${oldPath}`;
	process.env.FAKE_GH_STATE = statePath;
	const params = { manifest_path: ".pi/tmp/tk-to-github/migration.json", issue_plan_path: ".pi/tmp/tk-to-github/github-issue-plan.json", write_delay_ms: 0, batch_size: 50, apply: true } as const;
	const cleanupOptions = { approved: true, repo: "fixture/repo", manifestPath: params.manifest_path, issuePlanPath: params.issue_plan_path } as const;
	try {
		await writeFile(path.join(cwd, params.issue_plan_path), JSON.stringify({ ...plan, issues: plan.issues.slice(0, -1) }));
		await assert.rejects(executeMigration(cwd, "fixture/repo", { ...params, operation: "dry_run" }), /does not exactly match manifest records.*missing: tk-later/);
		await writeFile(path.join(cwd, params.issue_plan_path), JSON.stringify(plan));
		const dryRun = await executeMigration(cwd, "fixture/repo", { ...params, operation: "dry_run" }) as any;
		assert.deepEqual({ issues: dryRun.issues, relationships: dryRun.relationships }, { issues: 3, relationships: 3 });
		await executeMigration(cwd, "fixture/repo", { ...params, operation: "apply_issues" });
		await executeMigration(cwd, "fixture/repo", { ...params, operation: "apply_issues" });
		let state = JSON.parse(await readFile(statePath, "utf8"));
		assert.equal(state.issues.length, 3, "issue retry must reuse outcomes/markers");

		process.env.FAKE_GH_FAIL_RELATIONSHIP_ONCE = "1";
		await assert.rejects(executeMigration(cwd, "fixture/repo", { ...params, operation: "apply_relationships" }), /injected relationship failure/);
		delete process.env.FAKE_GH_FAIL_RELATIONSHIP_ONCE;
		await executeMigration(cwd, "fixture/repo", { ...params, operation: "apply_relationships", batch_size: 1 });
		await executeMigration(cwd, "fixture/repo", { ...params, operation: "resume" });
		state = JSON.parse(await readFile(statePath, "utf8"));
		assert.equal(state.relationships.length, 3, "relationship checkpoints must resume without duplicates");

		process.env.FAKE_GH_HANG = "1";
		await assert.rejects(
			retrieveCurrentRepositoryEpicContext(cwd, 101, "fixture/repo", { timeoutMs: 50 }),
			/GitHub command timed out after 50ms/,
		);
		delete process.env.FAKE_GH_HANG;

		const childPidPath = path.join(cwd, "hanging-child.pid");
		process.env.FAKE_GH_HANG_CHILD = "1";
		process.env.FAKE_GH_CHILD_PID_PATH = childPidPath;
		await assert.rejects(
			retrieveCurrentRepositoryEpicContext(cwd, 101, "fixture/repo", { timeoutMs: 2_000 }),
			/GitHub command timed out after 2000ms/,
		);
		delete process.env.FAKE_GH_HANG_CHILD;
		delete process.env.FAKE_GH_CHILD_PID_PATH;
		const childPid = Number(await readFile(childPidPath, "utf8"));
		let childAlive = true;
		for (let attempt = 0; attempt < 50 && childAlive; attempt += 1) {
			try { process.kill(childPid, 0); await new Promise((resolve) => setTimeout(resolve, 10)); }
			catch { childAlive = false; }
		}
		assert.equal(childAlive, false, "timeout must kill the complete gh process group");

		state.issues.push({ ...state.issues[0], id: 77_777, number: 77_777, html_url: "https://fixture/77777" });
		await writeFile(statePath, JSON.stringify(state));
		process.env.FAKE_GH_SEARCH_NOISE = "1";
		await assert.rejects(executeMigration(cwd, "fixture/repo", { ...params, operation: "reconcile" }), /matches multiple GitHub issues/);
		delete process.env.FAKE_GH_SEARCH_NOISE;
		state.issues.pop();
		await writeFile(statePath, JSON.stringify(state));

		const migrationState = structuredClone(state);
		state.issues = Array.from({ length: 101 }, (_, index) => ({
			id: 20_000 + index,
			number: 2_000 + index,
			title: `Graph child ${index}`,
			body: "",
			state: "open",
			labels: [{ name: "ready-for-agent" }],
			assignee: null,
			issue_dependencies_summary: { blocked_by: 0 },
		}));
		state.relationships = state.issues.map((issue: any) => ({ kind: "subissue", owner: 900, target: issue.id }));
		await writeFile(statePath, JSON.stringify(state));
		const largeGraph = await inspectGraph(cwd, "fixture/repo", 900, "ready-for-agent") as any;
		assert.equal(largeGraph.issues.length, 101);
		assert.equal(largeGraph.frontier.length, 101);
		state = migrationState;
		await writeFile(statePath, JSON.stringify(state));

		const originalRelationships = structuredClone(state.relationships);
		const paginatedEdge = state.relationships[0];
		state.relationships = [
			...Array.from({ length: 100 }, (_, index) => ({ ...paginatedEdge, target: 50_000 + index })),
			...originalRelationships,
		];
		await writeFile(statePath, JSON.stringify(state));
		const paginatedRelationships = await executeMigration(cwd, "fixture/repo", { ...params, operation: "reconcile" }) as MigrationReconciliation;
		assert.equal(paginatedRelationships.passed, true, "relationship reconciliation must inspect pages after the first 100 edges");
		state.relationships = originalRelationships;

		const removedRelationship = state.relationships.pop();
		await writeFile(statePath, JSON.stringify(state));
		const missingRelationship = await executeMigration(cwd, "fixture/repo", { ...params, operation: "reconcile" }) as MigrationReconciliation;
		assert.equal(missingRelationship.passed, false);
		assert.equal(missingRelationship.mismatches.some((mismatch) => mismatch.kind === "relationship" && mismatch.actual === "missing on GitHub"), true);
		await assert.rejects(completeMigrationCleanup(cwd, cleanupOptions), /fresh successful reconciliation/);
		state.relationships.push(removedRelationship);

		const originalTitle = state.issues[1].title;
		state.issues[1].title = "Drifted title";
		await writeFile(statePath, JSON.stringify(state));
		const contentDrift = await executeMigration(cwd, "fixture/repo", { ...params, operation: "reconcile" }) as MigrationReconciliation;
		assert.equal(contentDrift.mismatches.some((mismatch) => mismatch.kind === "title"), true);
		state.issues[1].title = originalTitle;

		state.issues.push({ id: 9999, number: 999, state: "open", title: "Unexpected omitted issue", body: "<!-- pi-harness-plan:e2e-fixture/tk-stale -->", labels: [] });
		await writeFile(statePath, JSON.stringify(state));
		const omissionDrift = await executeMigration(cwd, "fixture/repo", { ...params, operation: "reconcile" }) as MigrationReconciliation;
		assert.equal(omissionDrift.mismatches.some((mismatch) => mismatch.kind === "omission" && mismatch.key === "tk-stale"), true);
		state.issues.pop();

		state.issues[0].state = "closed";
		await writeFile(statePath, JSON.stringify(state));
		const failed = await executeMigration(cwd, "fixture/repo", { ...params, operation: "reconcile" }) as MigrationReconciliation;
		assert.equal(failed.passed, false);
		assert.deepEqual(failed.mismatches[0], { key: "tk-epic", kind: "state", expected: "open", actual: "closed" });
		await assert.rejects(completeMigrationCleanup(cwd, cleanupOptions), /fresh successful reconciliation/);
		assert.equal(await readFile(path.join(cwd, ".tickets/source.md"), "utf8"), "source");

		state.issues[0].state = "open";
		await writeFile(statePath, JSON.stringify(state));
		const passed = await executeMigration(cwd, "fixture/repo", { ...params, operation: "reconcile" }) as MigrationReconciliation;
		assert.equal(passed.passed, true);
		state.issues[1].title = "Drift after reconciliation";
		await writeFile(statePath, JSON.stringify(state));
		await assert.rejects(completeMigrationCleanup(cwd, cleanupOptions), /fresh successful reconciliation/);
		state.issues[1].title = originalTitle;
		await writeFile(statePath, JSON.stringify(state));
		await completeMigrationCleanup(cwd, cleanupOptions);
		await assert.rejects(readFile(path.join(cwd, ".tickets/source.md")), /ENOENT/);
		const guidance = await readFile(path.join(cwd, "docs/agents/issue-tracker.md"), "utf8");
		assert.match(guidance, /GitHub Issues are the sole durable task source of truth/);
		assert.match(guidance, /Claim active work before changing code/);
		assert.doesNotMatch(guidance, /tk is authoritative/);
	} finally {
		process.env.PATH = oldPath;
		delete process.env.FAKE_GH_STATE;
		delete process.env.FAKE_GH_FAIL_RELATIONSHIP_ONCE;
		delete process.env.FAKE_GH_HANG;
		delete process.env.FAKE_GH_HANG_CHILD;
		delete process.env.FAKE_GH_CHILD_PID_PATH;
		delete process.env.FAKE_GH_SEARCH_NOISE;
	}
});

test("issue plans reject duplicate keys before mutation", () => {
	assert.throws(() => validateIssuePlan({
		key: "workflow",
		issues: [
			{ key: "duplicate", title: "First", body: "" },
			{ key: "duplicate", title: "Second", body: "" },
		],
	}), /Duplicate plan issue key/);
});
