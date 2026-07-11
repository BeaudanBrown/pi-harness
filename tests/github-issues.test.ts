import assert from "node:assert/strict";
import test from "node:test";
import { bodyWithMarker, issueMarker, validateIssuePlan } from "../config/agent/extensions/github-issues/index.js";

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

test("issue plans reject duplicate keys before mutation", () => {
	assert.throws(() => validateIssuePlan({
		key: "workflow",
		issues: [
			{ key: "duplicate", title: "First", body: "" },
			{ key: "duplicate", title: "Second", body: "" },
		],
	}), /Duplicate plan issue key/);
});
