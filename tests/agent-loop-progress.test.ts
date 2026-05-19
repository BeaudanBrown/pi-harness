import assert from "node:assert/strict";
import test from "node:test";
import {
	actionableTickets,
	childActivityFromJsonEvent,
	createLoopProgress,
	descendantTickets,
	formatChildActivity,
	formatLoopStatus,
	isLoopContainer,
	parseChildProgressLine,
	parseDiffNumstat,
	pickReadyTicket,
	pushLoopProgress,
	shortTicketSummary,
	titleFromTkShow,
	type TicketMeta,
} from "../config/agent/extensions/agent-loop/index.js";

test("progress widget keeps header plus a rolling nine-line window", () => {
	const widgetCalls: Array<string[] | undefined> = [];
	const ctx = {
		ui: {
			setWidget: (_id: string, lines: string[] | undefined) => widgetCalls.push(lines),
			setStatus: () => undefined,
		},
	};
	const progress = createLoopProgress();

	for (let i = 1; i <= 12; i++) pushLoopProgress(ctx, progress, `> step ${i}`);

	const lastWidget = widgetCalls.at(-1) ?? [];
	assert.equal(lastWidget.length, 10);
	assert.match(lastWidget[0] ?? "", /^aloop 0:00/);
	assert.deepEqual(lastWidget.slice(1), [
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

test("loop selection treats tickets with children as containers", () => {
	const tickets: TicketMeta[] = [
		{ id: "root", type: "feature", status: "open" },
		{ id: "blocked", parent: "root", type: "task", status: "open", deps: ["ready"] },
		{ id: "ready", parent: "root", type: "task", status: "open", priority: 2, created: "2026-01-02" },
	];

	assert.equal(isLoopContainer(tickets[0]!, tickets), true);
	assert.deepEqual(actionableTickets(tickets[0]!, tickets).map((ticket) => ticket.id), ["blocked", "ready"]);
	assert.equal(pickReadyTicket(tickets[0]!, tickets)?.id, "ready");
});

test("loop selection walks nested descendants and skips container tickets", () => {
	const tickets: TicketMeta[] = [
		{ id: "epic", type: "epic", status: "open" },
		{ id: "sub", parent: "epic", type: "feature", status: "open" },
		{ id: "later", parent: "sub", type: "task", status: "open", priority: 3, created: "2026-01-03" },
		{ id: "first", parent: "sub", type: "task", status: "open", priority: 1, created: "2026-01-04" },
	];

	assert.deepEqual(descendantTickets(tickets[0]!, tickets).map((ticket) => ticket.id), ["sub", "later", "first"]);
	assert.deepEqual(actionableTickets(tickets[0]!, tickets).map((ticket) => ticket.id), ["later", "first"]);
	assert.equal(pickReadyTicket(tickets[0]!, tickets)?.id, "first");
});

test("leaf tickets remain directly actionable when dependencies are resolved", () => {
	const tickets: TicketMeta[] = [
		{ id: "leaf", type: "feature", status: "open", deps: ["dep"] },
		{ id: "dep", type: "task", status: "closed" },
	];

	assert.equal(isLoopContainer(tickets[0]!, tickets), false);
	assert.equal(pickReadyTicket(tickets[0]!, tickets)?.id, "leaf");
});

test("loop status summarizes subtree readiness", () => {
	const tickets: TicketMeta[] = [
		{ id: "root", type: "feature", status: "open", title: "Container" },
		{ id: "ready", parent: "root", type: "task", status: "open", title: "Ready task" },
		{ id: "blocked", parent: "root", type: "task", status: "open", deps: ["ready"], title: "Blocked task" },
	];

	const status = formatLoopStatus(tickets[0]!, tickets);
	assert.match(status, /Mode: container/);
	assert.match(status, /- ready Ready task/);
	assert.match(status, /- blocked Blocked task <- ready/);
});
