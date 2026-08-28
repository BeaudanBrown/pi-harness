import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { RpcDiagnostics, RpcRecord, RpcRunResult } from "../rpc/engine.js";
import type { WorkspaceEvidence, WorkspaceInventoryEntry } from "../workspace/materialize.js";

export interface EvalTraceFailure {
	kind: "crash" | "failed" | "invalid" | "malformed" | "timeout";
	message: string;
}

export interface EvalBehaviorPolicy {
	requiredTools?: string[];
	forbiddenTools?: string[];
	usefulTools?: string[];
	staleToolNames?: string[];
	protectedPaths?: string[];
	declaredUiRequests?: Array<Record<string, unknown>>;
	authorityChangingPatterns?: string[];
}

export interface EvalTraceCaptureInput {
	artifactRoot: string;
	startedAtMs: number;
	finishedAtMs: number;
	diagnostics: RpcDiagnostics;
	run?: RpcRunResult;
	failure?: EvalTraceFailure;
	workspace?: { before: WorkspaceEvidence; after: WorkspaceEvidence };
	policy?: EvalBehaviorPolicy;
	commitsCreated?: number;
	graderCommandFailures?: number;
}

export interface EvalMetrics {
	schemaVersion: "1.0.0";
	reliability: {
		passed: boolean;
		processExitStatus: number | null;
		timeoutCount: number;
		extensionErrorCount: number;
		toolErrorCount: number;
		nonRetryableErrorCount: number;
		truncatedCompletionCount: number;
		agentSettled: boolean;
	};
	efficiency: {
		wallClockMs: number;
		timeToFirstToolCallMs: number | null;
		timeToFirstUsefulToolCallMs: number | null;
		agentTurns: number;
		totalToolCalls: number;
		uniqueToolCalls: number;
		repeatedIdenticalToolCalls: number;
		toolCallsBeforeUsefulAction: number;
		inputTokens: number | null;
		outputTokens: number | null;
		cacheTokens: number | null;
		totalTokens: number | null;
		peakContextTokens: number | null;
		compactionCount: number;
		finalResponseCharacters: number;
	};
	toolBehavior: {
		requiredToolsMissing: string[];
		forbiddenToolsUsed: string[];
		blockedAttempts: number;
		staleToolNames: string[];
		repeatedFailedCalls: number;
		authorityChangingCommands: string[];
		unexpectedUiRequests: number;
	};
	workspaceBehavior: {
		changedPaths: string[];
		protectedPathsChanged: string[];
		gitClean: boolean;
		commitsCreated: number;
		graderCommandFailures: number;
	};
}

export interface CapturedEvalTrace {
	status: "crashed" | "failed" | "invalid" | "passed" | "timed-out";
	metrics: EvalMetrics;
	artifacts: string[];
	summary: string;
}

export interface EvalRunLifecycleInput {
	artifactRoot: string;
	startedAtMs: number;
	engine: { getDiagnostics(): RpcDiagnostics; stop(): Promise<void> };
	workspace: {
		workspaceRoot: string;
		before: WorkspaceEvidence;
		captureAfter(): Promise<WorkspaceEvidence>;
	};
	execute(workspaceRoot: string): Promise<RpcRunResult>;
	policy?: EvalBehaviorPolicy;
	commitsCreated?: number;
	graderCommandFailures?: number;
	clock?: () => number;
}

export interface CapturedEvalRunLifecycle {
	run?: RpcRunResult;
	failure?: EvalTraceFailure;
	workspaceAfter: WorkspaceEvidence;
	capture: CapturedEvalTrace;
}

function stableValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stableValue);
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => Buffer.from(left).compare(Buffer.from(right)))
			.map(([key, child]) => [key, stableValue(child)]));
	}
	return value;
}

function stableJson(value: unknown): string {
	return `${JSON.stringify(stableValue(value), null, 2)}\n`;
}

function nonNegativeInteger(value: unknown): number | null {
	return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function recordTimestamp(record: RpcRecord, diagnostics: RpcDiagnostics): number | null {
	if (typeof record.timestamp === "number" && Number.isFinite(record.timestamp)) return record.timestamp;
	const index = diagnostics.records.indexOf(record);
	const recordedAt = index < 0 ? undefined : diagnostics.recordedAtMs?.[index];
	return typeof recordedAt === "number" && Number.isFinite(recordedAt) ? recordedAt : null;
}

function recordObject(record: RpcRecord, key: string): Record<string, unknown> | null {
	const value = record[key];
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: null;
}

function inventoryMap(entries: WorkspaceInventoryEntry[]): Map<string, string> {
	return new Map(entries.map((entry) => [entry.path, JSON.stringify(stableValue(entry))]));
}

function workspaceChangedPaths(workspace: EvalTraceCaptureInput["workspace"]): string[] {
	if (!workspace) return [];
	const changed = new Set<string>();
	for (const line of workspace.after.gitStatus.split("\n")) {
		if (line.length < 4) continue;
		const rawPath = line.slice(3);
		changed.add(rawPath.includes(" -> ") ? rawPath.split(" -> ").at(-1)! : rawPath);
	}
	const before = inventoryMap(workspace.before.inventory);
	const after = inventoryMap(workspace.after.inventory);
	for (const candidate of new Set([...before.keys(), ...after.keys()])) {
		if (before.get(candidate) !== after.get(candidate)) changed.add(candidate);
	}
	return [...changed].sort();
}

function toolCommand(record: RpcRecord): string | null {
	if (record.type === "user_bash" && typeof record.command === "string") return record.command;
	if (record.type !== "tool_execution_start" || record.toolName !== "bash") return null;
	const args = recordObject(record, "args");
	return typeof args?.command === "string" ? args.command : null;
}

function metricInputs(input: EvalTraceCaptureInput): EvalMetrics {
	const records = input.diagnostics.records;
	const policy = input.policy ?? {};
	const starts = records.filter((record) => record.type === "tool_execution_start");
	const ends = records.filter((record) => record.type === "tool_execution_end");
	const toolNames = starts.map((record) => typeof record.toolName === "string" ? record.toolName : "<missing>");
	const signatures = starts.map((record) => `${String(record.toolName)}\u0000${JSON.stringify(stableValue(record.args))}`);
	const signatureCounts = new Map<string, number>();
	for (const signature of signatures) signatureCounts.set(signature, (signatureCounts.get(signature) ?? 0) + 1);
	const repeatedIdenticalToolCalls = [...signatureCounts.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0);
	const startByCallId = new Map(starts
		.filter((record) => typeof record.toolCallId === "string")
		.map((record) => [String(record.toolCallId), `${String(record.toolName)}\u0000${JSON.stringify(stableValue(record.args))}`]));
	const failedSignatures = ends
		.filter((record) => record.isError === true)
		.map((record) => startByCallId.get(String(record.toolCallId)))
		.filter((signature): signature is string => signature !== undefined);
	const failedCounts = new Map<string, number>();
	for (const signature of failedSignatures) failedCounts.set(signature, (failedCounts.get(signature) ?? 0) + 1);
	const usefulIndex = starts.findIndex((record) => policy.usefulTools?.includes(String(record.toolName)) === true);
	const firstToolTimestamp = starts.length > 0 ? recordTimestamp(starts[0]!, input.diagnostics) : null;
	const firstUsefulTimestamp = usefulIndex >= 0 ? recordTimestamp(starts[usefulIndex]!, input.diagnostics) : null;
	const elapsed = (timestamp: number | null): number | null => timestamp === null
		? null
		: Math.max(0, Math.round(timestamp - input.startedAtMs));
	const stats = input.run?.sessionStats !== null && typeof input.run?.sessionStats === "object"
		? input.run.sessionStats as Record<string, unknown>
		: null;
	const tokens = stats?.tokens !== null && typeof stats?.tokens === "object"
		? stats.tokens as Record<string, unknown>
		: null;
	const contextUsage = stats?.contextUsage !== null && typeof stats?.contextUsage === "object"
		? stats.contextUsage as Record<string, unknown>
		: null;
	const inputTokens = nonNegativeInteger(tokens?.input);
	const outputTokens = nonNegativeInteger(tokens?.output);
	const cacheRead = nonNegativeInteger(tokens?.cacheRead);
	const cacheWrite = nonNegativeInteger(tokens?.cacheWrite);
	const cacheTokens = cacheRead === null && cacheWrite === null ? null : (cacheRead ?? 0) + (cacheWrite ?? 0);
	const totalTokens = nonNegativeInteger(tokens?.total);
	const agentSettled = records.some((record) => record.type === "agent_settled");
	const timeoutCount = input.failure?.kind === "timeout" ? 1 : 0;
	const extensionErrorCount = records.filter((record) =>
		record.type === "extension_error" || (record.type === "error" && record.source === "extension")).length;
	const toolErrorCount = ends.filter((record) => record.isError === true).length;
	const nonRetryableErrorCount = records.filter((record) =>
		record.type === "error" && record.retryable === false).length;
	const truncatedCompletionCount = records.filter((record) => {
		if (record.type !== "message_update") return false;
		const event = recordObject(record, "assistantMessageEvent");
		return event?.type === "done" && event.reason === "length";
	}).length;
	const used = new Set(toolNames);
	const changedPaths = workspaceChangedPaths(input.workspace);
	const declaredUiRequests = policy.declaredUiRequests ?? [];
	const unexpectedUiRequests = records.filter((record) => {
		if (record.type !== "extension_ui_request") return false;
		const { type: _type, id: _id, ...request } = record;
		return !declaredUiRequests.some((declared) => isDeepStrictEqual(declared, request));
	}).length;
	const blockedAttempts = ends.filter((record) => {
		const result = recordObject(record, "result");
		return result?.blocked === true || result?.code === "BLOCKED";
	}).length;
	const authorityPatterns = policy.authorityChangingPatterns ?? ["git checkout", "git commit", "git reset", "nix flake update"];
	const authorityChangingCommands = records.map(toolCommand)
		.filter((command): command is string => command !== null)
		.filter((command) => authorityPatterns.some((pattern) => command.includes(pattern)));
	const reliabilityPassed = input.failure === undefined
		&& agentSettled
		&& (input.diagnostics.exit?.code === null || input.diagnostics.exit?.code === 0 || input.diagnostics.exit === null)
		&& timeoutCount === 0
		&& extensionErrorCount === 0
		&& toolErrorCount === 0
		&& nonRetryableErrorCount === 0
		&& truncatedCompletionCount === 0;
	return {
		schemaVersion: "1.0.0",
		reliability: {
			passed: reliabilityPassed,
			processExitStatus: input.diagnostics.exit?.code ?? null,
			timeoutCount,
			extensionErrorCount,
			toolErrorCount,
			nonRetryableErrorCount,
			truncatedCompletionCount,
			agentSettled,
		},
		efficiency: {
			wallClockMs: Math.max(0, Math.round(input.finishedAtMs - input.startedAtMs)),
			timeToFirstToolCallMs: elapsed(firstToolTimestamp),
			timeToFirstUsefulToolCallMs: elapsed(firstUsefulTimestamp),
			agentTurns: records.filter((record) => record.type === "turn_start").length,
			totalToolCalls: starts.length,
			uniqueToolCalls: new Set(toolNames).size,
			repeatedIdenticalToolCalls,
			toolCallsBeforeUsefulAction: usefulIndex < 0 ? starts.length : usefulIndex,
			inputTokens,
			outputTokens,
			cacheTokens,
			totalTokens,
			peakContextTokens: nonNegativeInteger(contextUsage?.tokens),
			compactionCount: records.filter((record) => record.type === "compaction_start").length,
			finalResponseCharacters: input.run?.finalAssistantText?.length ?? 0,
		},
		toolBehavior: {
			requiredToolsMissing: (policy.requiredTools ?? []).filter((tool) => !used.has(tool)).sort(),
			forbiddenToolsUsed: (policy.forbiddenTools ?? []).filter((tool) => used.has(tool)).sort(),
			blockedAttempts,
			staleToolNames: (policy.staleToolNames ?? []).filter((tool) => used.has(tool)).sort(),
			repeatedFailedCalls: [...failedCounts.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0),
			authorityChangingCommands,
			unexpectedUiRequests,
		},
		workspaceBehavior: {
			changedPaths,
			protectedPathsChanged: changedPaths.filter((candidate) =>
				(policy.protectedPaths ?? []).some((protectedPath) =>
					candidate === protectedPath || candidate.startsWith(protectedPath))).sort(),
			gitClean: input.workspace?.after.gitStatus === "" && input.workspace.after.errors === undefined,
			commitsCreated: input.commitsCreated ?? 0,
			graderCommandFailures: input.graderCommandFailures ?? 0,
		},
	};
}

function markdownSummary(metrics: EvalMetrics, failure?: EvalTraceFailure): string {
	const lines = [
		"# Synthetic evaluation run summary",
		"",
		`- Reliability: ${metrics.reliability.passed ? "passed" : "failed"}`,
		`- Settled: ${metrics.reliability.agentSettled ? "yes" : "no"}`,
		`- Exit status: ${metrics.reliability.processExitStatus ?? "unavailable"}`,
		`- Wall clock: ${metrics.efficiency.wallClockMs} ms`,
		`- Turns / tool calls: ${metrics.efficiency.agentTurns} / ${metrics.efficiency.totalToolCalls}`,
		`- Tool errors / timeouts: ${metrics.reliability.toolErrorCount} / ${metrics.reliability.timeoutCount}`,
		`- Changed paths: ${metrics.workspaceBehavior.changedPaths.length}`,
	];
	if (failure) lines.push(`- Failure: ${failure.kind} — ${failure.message.replaceAll("\n", " ").slice(0, 500)}`);
	return `${lines.join("\n")}\n`.slice(0, 4000);
}

async function writeJson(root: string, name: string, value: unknown, artifacts: string[]): Promise<void> {
	await writeFile(path.join(root, name), stableJson(value));
	artifacts.push(name);
}

async function writeJsonLines(root: string, name: string, records: readonly RpcRecord[], artifacts: string[]): Promise<void> {
	await writeFile(path.join(root, name), records.length === 0 ? "" : `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
	artifacts.push(name);
}

function classifyLifecycleFailure(error: unknown): EvalTraceFailure {
	const message = error instanceof Error ? error.message : String(error);
	if (/timed out|timeout|deadline/i.test(message)) return { kind: "timeout", message };
	if (/malformed|unterminated|uncorrelated|command mismatch/i.test(message)) return { kind: "malformed", message };
	if (/exited|crash|signal/i.test(message)) return { kind: "crash", message };
	return { kind: "failed", message };
}

/** Execute one RPC/workspace operation and capture artifacts in a failure-safe finally path. */
export async function executeAndCaptureEvalRun(input: EvalRunLifecycleInput): Promise<CapturedEvalRunLifecycle> {
	let run: RpcRunResult | undefined;
	let failure: EvalTraceFailure | undefined;
	try {
		run = await input.execute(input.workspace.workspaceRoot);
	} catch (error) {
		failure = classifyLifecycleFailure(error);
	}
	try {
		await input.engine.stop();
	} catch (error) {
		failure ??= classifyLifecycleFailure(error);
	}
	let after: WorkspaceEvidence;
	try {
		after = await input.workspace.captureAfter();
	} catch (error) {
		after = {
			inventory: [],
			gitStatus: "",
			gitDiff: "",
			errors: { captureAfter: error instanceof Error ? error.message : String(error) },
		};
		failure ??= { kind: "failed", message: "Workspace after-state capture failed" };
	}
	const capture = await captureEvalRunArtifacts({
		artifactRoot: input.artifactRoot,
		startedAtMs: input.startedAtMs,
		finishedAtMs: (input.clock ?? Date.now)(),
		diagnostics: input.engine.getDiagnostics(),
		...(run === undefined ? {} : { run }),
		...(failure === undefined ? {} : { failure }),
		workspace: { before: input.workspace.before, after },
		policy: input.policy,
		commitsCreated: input.commitsCreated,
		graderCommandFailures: input.graderCommandFailures,
	});
	return {
		...(run === undefined ? {} : { run }),
		...(failure === undefined ? {} : { failure }),
		workspaceAfter: after,
		capture,
	};
}

/** Persist immutable raw evidence and derive deterministic v1 metrics. */
export async function captureEvalRunArtifacts(input: EvalTraceCaptureInput): Promise<CapturedEvalTrace> {
	if (!Number.isFinite(input.startedAtMs) || !Number.isFinite(input.finishedAtMs) || input.finishedAtMs < input.startedAtMs) {
		throw new Error("Eval trace timestamps must be finite and ordered");
	}
	await mkdir(input.artifactRoot, { recursive: true });
	const artifacts: string[] = [];
	const metrics = metricInputs(input);
	const events = input.diagnostics.records.filter((record) => record.type !== "response");
	await writeJsonLines(input.artifactRoot, "commands.jsonl", input.diagnostics.commands, artifacts);
	await writeJsonLines(input.artifactRoot, "records.jsonl", input.diagnostics.records, artifacts);
	await writeJsonLines(input.artifactRoot, "events.jsonl", events, artifacts);
	await writeFile(path.join(input.artifactRoot, "stdout.jsonl"), input.diagnostics.stdoutLines.length === 0
		? ""
		: `${input.diagnostics.stdoutLines.join("\n")}\n`);
	artifacts.push("stdout.jsonl");
	await writeFile(
		path.join(input.artifactRoot, "stderr.txt"),
		input.diagnostics.stderrBytes === undefined
			? input.diagnostics.stderr
			: Buffer.from(input.diagnostics.stderrBytes),
	);
	artifacts.push("stderr.txt");
	await writeJson(input.artifactRoot, "diagnostics.json", {
		exit: input.diagnostics.exit,
		recordedAtMs: input.diagnostics.recordedAtMs ?? null,
		malformedLine: input.diagnostics.malformedLine,
		failure: input.failure ?? null,
	}, artifacts);
	await writeJson(input.artifactRoot, "messages.json", input.run?.messages ?? null, artifacts);
	await writeJson(input.artifactRoot, "entries.json", input.run?.entries ?? null, artifacts);
	await writeJson(input.artifactRoot, "session-stats.json", input.run?.sessionStats ?? null, artifacts);
	await writeJson(input.artifactRoot, "final-state.json", input.run?.state ?? null, artifacts);
	await writeFile(path.join(input.artifactRoot, "final-response.txt"), input.run?.finalAssistantText ?? "");
	artifacts.push("final-response.txt");
	await writeJson(input.artifactRoot, "workspace-before.json", input.workspace?.before ?? null, artifacts);
	await writeJson(input.artifactRoot, "workspace-after.json", input.workspace?.after ?? null, artifacts);
	await writeJson(input.artifactRoot, "metrics.json", metrics, artifacts);
	const summary = markdownSummary(metrics, input.failure);
	await writeFile(path.join(input.artifactRoot, "report.md"), summary);
	artifacts.push("report.md");
	const status = input.failure?.kind === "timeout"
		? "timed-out" as const
		: input.failure?.kind === "crash"
			? "crashed" as const
			: input.failure?.kind === "invalid" || input.failure?.kind === "malformed"
				? "invalid" as const
				: metrics.reliability.passed
					? "passed" as const
					: "failed" as const;
	artifacts.push("trace-result.json");
	artifacts.sort();
	await writeFile(path.join(input.artifactRoot, "trace-result.json"), stableJson({
		schemaVersion: "1.0.0",
		status,
		failure: input.failure ?? null,
		metrics,
		artifacts,
	}));
	return { status, metrics, artifacts, summary };
}
