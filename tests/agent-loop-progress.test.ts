import assert from "node:assert/strict";
import test from "node:test";
import {
	childActivityFromJsonEvent,
	createLoopProgress,
	formatChildActivity,
	parseChildProgressLine,
	parseDiffNumstat,
	pushLoopProgress,
	shortTicketSummary,
	titleFromTkShow,
} from "../config/agent/extensions/agent-loop/index.js";

test("progress widget keeps a rolling ten-line window", () => {
	const widgetCalls: Array<string[] | undefined> = [];
	const ctx = {
		ui: {
			setWidget: (_id: string, lines: string[] | undefined) => widgetCalls.push(lines),
			setStatus: () => undefined,
		},
	};
	const progress = createLoopProgress(10);

	for (let i = 1; i <= 12; i++) pushLoopProgress(ctx, progress, `> step ${i}`);

	const lastWidget = widgetCalls.at(-1) ?? [];
	assert.match(lastWidget[0] ?? "", /^aloop 0:00/);
	assert.deepEqual(lastWidget.slice(1), [
		"> step 3",
		"> step 4",
		"> step 5",
		"> step 6",
		"> step 7",
		"> step 8",
		"> step 9",
		"> step 10",
		"> step 11",
		"> step 12",
	]);
});

test("progress lines are one-line, truncated, redacted, and deduplicated", () => {
	const widgetCalls: Array<string[] | undefined> = [];
	const ctx = {
		ui: {
			setWidget: (_id: string, lines: string[] | undefined) => widgetCalls.push(lines),
			setStatus: () => undefined,
		},
	};
	const progress = createLoopProgress();

	pushLoopProgress(ctx, progress, `> bash: echo token=super-secret ${"x".repeat(160)}\nsecond line`);
	pushLoopProgress(ctx, progress, `> bash: echo token=super-secret ${"x".repeat(160)}\nsecond line`);

	const line = widgetCalls.at(-1)?.[1] ?? "";
	assert.match(line, /token=\[redacted\]/);
	assert.equal(line.includes("\n"), false);
	assert.ok(line.length <= 110);
	assert.equal(widgetCalls.length, 1);
});

test("ticket titles are extracted from tk show output", () => {
	const show = `---
id: tmp-jn7d
status: open
---
# Add provenance detail mode to context output

Body`;
	assert.equal(titleFromTkShow(show), "Add provenance detail mode to context output");
	assert.equal(shortTicketSummary(titleFromTkShow(show)), "Add provenance detail mode");
});

test("child model and assistant usage events are extracted", () => {
	assert.deepEqual(childActivityFromJsonEvent({
		type: "model_select",
		model: { id: "sub-gpt-5.5", contextWindow: 272000 },
	}), { kind: "model", model: "sub-gpt-5.5", contextWindow: 272000 });

	assert.deepEqual(childActivityFromJsonEvent({
		type: "message_end",
		message: {
			role: "assistant",
			usage: {
				input: 1000,
				output: 200,
				cacheRead: 50,
				cacheWrite: 0,
				totalTokens: 1250,
				cost: { total: 0.0123 },
			},
		},
	}), {
		kind: "assistant",
		text: "final response received",
		usage: { input: 1000, output: 200, cacheRead: 50, cacheWrite: 0, totalTokens: 1250 },
	});
});

test("child JSON tool events are summarized into brief actions", () => {
	assert.deepEqual(parseChildProgressLine(JSON.stringify({
		type: "tool_execution_start",
		toolName: "bash",
		args: { command: "tk show abc123" },
	})), { kind: "bash", command: "tk show abc123" });

	assert.deepEqual(childActivityFromJsonEvent({
		type: "tool_call",
		toolName: "edit",
		input: { path: "src/Auth.hs", oldText: "long", newText: "long" },
	}), { kind: "file", action: "edit", path: "src/Auth.hs" });

	assert.equal(formatChildActivity({ kind: "file", action: "edit", path: "src/Auth.hs" }), "> edit: src/Auth.hs");
});

test("diff numstat is summarized as additions, deletions, and binary files", () => {
	assert.deepEqual(parseDiffNumstat("10\t2\tsrc/a.ts\n-\t-\timage.png\n3\t0\tREADME.md\n"), {
		additions: 13,
		deletions: 2,
		binary: 1,
	});
	assert.equal(parseDiffNumstat(""), undefined);
});

test("unknown, duplicate lifecycle, and empty child output are ignored", () => {
	assert.equal(parseChildProgressLine("not json"), undefined);
	assert.equal(childActivityFromJsonEvent({ type: "usage", inputTokens: 1 }), undefined);
	assert.equal(childActivityFromJsonEvent({ type: "tool_call_result", toolName: "bash", input: { command: "tk show abc123" } }), undefined);
	assert.equal(childActivityFromJsonEvent({ type: "tool_call_delta", toolName: "bash", input: { command: "tk show abc123" } }), undefined);
	assert.equal(childActivityFromJsonEvent({ type: "tool_call", toolName: "bash", input: {} }), undefined);
});
