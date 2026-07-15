import assert from "node:assert/strict";
import test from "node:test";
import {
	buildReviewPrompt,
	DEFAULT_REVIEW_MODEL,
	parseReviewModelRef,
	REVIEW_THINKING_LEVEL,
	runReviewTasks,
	validateReviewRequest,
	type ReviewTask,
} from "../config/agent/extensions/review-agents/core.js";

const tasks: ReviewTask[] = [
	{ axis: "standards", instructions: "Check the repository standards." },
	{ axis: "spec", instructions: "Check the implementation against issue #14." },
];

test("review agents default to Terra with low thinking", () => {
	assert.equal(DEFAULT_REVIEW_MODEL, "openai-codex/gpt-5.6-terra");
	assert.equal(REVIEW_THINKING_LEVEL, "low");
});

test("review model references preserve provider-qualified model IDs", () => {
	assert.deepEqual(parseReviewModelRef(DEFAULT_REVIEW_MODEL), {
		provider: "openai-codex",
		id: "gpt-5.6-terra",
	});
	assert.equal(parseReviewModelRef("gpt-5.6-terra"), undefined);
	assert.equal(parseReviewModelRef("openai-codex/"), undefined);
});

test("review requests allow one or two distinct axes", () => {
	assert.doesNotThrow(() => validateReviewRequest("main", tasks));
	assert.doesNotThrow(() => validateReviewRequest("main", [tasks[0]!]));
	assert.throws(() => validateReviewRequest("-invalid", tasks), /fixed point/);
	assert.throws(() => validateReviewRequest("main", []), /one or two/);
	assert.throws(() => validateReviewRequest("main", [tasks[0]!, tasks[0]!]), /only once/);
});

test("review prompts share pinned git context while keeping axis instructions separate", () => {
	const prompt = buildReviewPrompt(tasks[0]!, {
		fixedPoint: "main",
		resolvedFixedPoint: "abc123",
		diffPath: ".pi/tmp/reviews/example/diff.patch",
		commitsPath: ".pi/tmp/reviews/example/commits.txt",
		changedFiles: ["src/example.ts"],
	});

	assert.match(prompt, /Review axis: standards/);
	assert.match(prompt, /main/);
	assert.match(prompt, /abc123/);
	assert.match(prompt, /diff\.patch/);
	assert.match(prompt, /src\/example\.ts/);
	assert.match(prompt, /Check the repository standards/);
});

test("review tasks start concurrently and preserve input order", async () => {
	const started: string[] = [];
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});

	const resultPromise = runReviewTasks(tasks, async (task) => {
		started.push(task.axis);
		await gate;
		return `${task.axis} result`;
	});

	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(started, ["standards", "spec"]);
	release();
	assert.deepEqual(await resultPromise, ["standards result", "spec result"]);
});
