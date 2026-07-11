import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { bodyWithMarker, frontierIssueNumbers, issueMarker, migrationIssuePlan, validateIssuePlan, type MigrationRecord } from "../config/agent/extensions/github-issues/index.js";

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
});

test("migration fixtures produce an idempotent plan and omit approved stale records", async () => {
	const records = JSON.parse(await readFile("tests/fixtures/tk-migration/records.json", "utf8")) as MigrationRecord[];
	const plan = migrationIssuePlan("fixture-migration", records);

	assert.deepEqual(plan.issues.map((issue) => issue.key), ["tk-epic", "tk-first", "tk-later"]);
	assert.equal(plan.issues[2]?.state, "closed");
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

test("issue plans reject duplicate keys before mutation", () => {
	assert.throws(() => validateIssuePlan({
		key: "workflow",
		issues: [
			{ key: "duplicate", title: "First", body: "" },
			{ key: "duplicate", title: "Second", body: "" },
		],
	}), /Duplicate plan issue key/);
});
