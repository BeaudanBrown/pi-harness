import assert from "node:assert/strict";
import test from "node:test";
import { validateRemoteCheckpoint, renderRemoteCheckpoint, renderRemoteCheckpointPollQuestion } from "../config/agent/extensions/managed-sessions/checkpoint.js";
import { renderMarkdownHtml } from "../config/agent/extensions/managed-sessions/relay/transcript-renderer.js";

const question = { kind: "question", decision: "Which approach should we use?" };
const completion = {
	kind: "issue_complete", issueOrObjective: "Done", implementationSummary: "Implemented",
	verificationEvidence: "Verified", caveats: "None", gitCommitState: "Committed", approvalRequest: "Approve completion?",
};
const ordinary = [
	"Recommended approach (safer)", "Option [recommended]", "Use read_only mode", "**Recommended approach**",
	"functionality stays unchanged", "classical approach", "type of deployment", "nix verification passed",
	"Keep x = y as the label", "Use A > B for the comparison", "Cost is $5;", "Choose A | B",
];

test("ordinary checkpoint choices are accepted and preserved as plain poll labels", () => {
	for (const choice of ordinary) {
		const checkpoint = validateRemoteCheckpoint({ ...question, options: [choice] });
		assert.equal(checkpoint.kind, "question");
		if (checkpoint.kind !== "question") throw new Error("Expected question");
		assert.deepEqual(checkpoint.options, [choice]);
		assert.equal(renderRemoteCheckpointPollQuestion(checkpoint), "❓ Which approach should we use?");
		assert.ok(renderRemoteCheckpoint(checkpoint).includes(choice));
	}
});

test("every question, blocked and completion text field uses structural rather than code guessing validation", () => {
	for (const value of ordinary) {
		assert.equal(validateRemoteCheckpoint({ ...question, decision: value }).kind, "question");
		assert.equal(validateRemoteCheckpoint({ ...question, context: value }).kind, "question");
		for (const field of ["blockerEvidence", "requiredIntervention"]) {
			assert.equal(validateRemoteCheckpoint({ kind: "blocked", blockerEvidence: "Observed", requiredIntervention: "Reply", [field]: value }).kind, "blocked");
		}
		for (const field of ["issueOrObjective", "implementationSummary", "verificationEvidence", "caveats", "gitCommitState", "approvalRequest"]) {
			assert.equal(validateRemoteCheckpoint({ ...completion, [field]: value }).kind, "issue_complete");
		}
	}
});

test("kind-specific fields, option counts, types, text lengths and controls still reject malformed checkpoints", () => {
	assert.throws(() => validateRemoteCheckpoint({ ...question, extra: "unknown" }), /Unexpected checkpoint field/);
	assert.throws(() => validateRemoteCheckpoint({ ...question, options: [] }), /1-8/);
	assert.throws(() => validateRemoteCheckpoint({ ...question, options: Array(9).fill("choice") }), /1-8/);
	for (const choice of [null, {}, 1, "", "  ", "x".repeat(301), "has\u0000control"]) {
		assert.throws(() => validateRemoteCheckpoint({ ...question, options: [choice] }));
	}
	assert.throws(() => validateRemoteCheckpoint({ ...question, decision: "x".repeat(1_201) }), /at most 1200/);
	assert.throws(() => validateRemoteCheckpoint({ kind: "blocked", blockerEvidence: "Observed" }), /requiredIntervention/);
	assert.throws(() => validateRemoteCheckpoint({ kind: "unknown" }), /kind must be/);
});

test("explicit requested-code fields retain paired declaration and byte-boundary checks", () => {
	assert.throws(() => validateRemoteCheckpoint({ ...question, requestedCodeOrDiff: "const x = 1;" }), /requires codeOrDiffRequested/);
	assert.throws(() => validateRemoteCheckpoint({ ...question, codeOrDiffRequested: true }), /requires codeOrDiffRequested/);
	assert.throws(() => validateRemoteCheckpoint({ ...question, codeOrDiffRequested: false, requestedCodeOrDiff: "code" }), /requires codeOrDiffRequested/);
	const explicit = validateRemoteCheckpoint({ ...question, codeOrDiffRequested: true, requestedCodeOrDiff: "const x = 1;" });
	assert.match(renderRemoteCheckpoint(explicit), /Requested code\/diff:\nconst x = 1;/);
	const oversized = validateRemoteCheckpoint({ ...question, decision: "🙂".repeat(600), context: "🙂".repeat(600), options: Array(8).fill("🙂".repeat(150)) });
	assert.throws(() => renderRemoteCheckpoint(oversized), /single Matrix event limit/);
	const oversizedPoll = validateRemoteCheckpoint({ ...question, decision: "&".repeat(1_200), options: Array(8).fill("&".repeat(300)) });
	assert.throws(() => renderRemoteCheckpointPollQuestion(oversizedPoll as Extract<typeof oversizedPoll, { kind: "question" }>), /single Matrix event limit/);
});

test("accepting literal markup in checkpoint text does not enable raw HTML execution", () => {
	const checkpoint = validateRemoteCheckpoint({ ...question, context: '<script>alert(1)</script> <img src="x" onerror="bad()">' });
	const html = renderMarkdownHtml(renderRemoteCheckpoint(checkpoint));
	assert.doesNotMatch(html, /<script|<img/);
	assert.match(html, /&lt;script&gt;/);
});
