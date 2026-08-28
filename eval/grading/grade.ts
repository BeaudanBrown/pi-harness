import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { assertPackRelativeReference } from "../contracts/path-policy.js";
import type { RpcRecord } from "../rpc/engine.js";
import {
	executeAndCaptureEvalRun,
	type CapturedEvalRunLifecycle,
	type EvalMetrics,
	type EvalRunLifecycleInput,
} from "../trace/capture.js";
import {
	oraclePathForMaterializedRun,
	runConfinedWorkspaceCommand,
	type MaterializedEvalRun,
	type WorkspaceEvidence,
	type WorkspaceInventoryEntry,
} from "../workspace/materialize.js";

interface AssertionBase { id: string; type: string }
interface ToolAssertion extends AssertionBase { type: "tool-required" | "tool-forbidden" | "stale-tool-forbidden"; tool: string }
interface MaximumAssertion extends AssertionBase { type: "max-tool-calls" | "max-blocked-attempts" | "max-errors" | "max-turns"; maximum: number }
interface FinalTextAssertion extends AssertionBase { type: "final-text"; operator: "contains" | "equals" | "matches"; expected: string }
interface FileAssertion extends AssertionBase {
	type: "file" | "protected-path";
	path: string;
	operator: "absent" | "contains" | "equals" | "exists" | "matches" | "unchanged";
	expected?: string;
}
interface GitAssertion extends AssertionBase { type: "git"; operator: "clean" | "dirty" }
interface GraderCommandAssertion extends AssertionBase { type: "grader-command"; command: string[] }
interface OracleAssertion extends AssertionBase { type: "oracle"; path: string; format: "bytes" | "json" | "text"; operator: "equals" }
interface UiAssertion extends AssertionBase { type: "ui-policy"; operator: "equals"; expected: number }
export type EvalAssertion = ToolAssertion | MaximumAssertion | FinalTextAssertion | FileAssertion | GitAssertion | GraderCommandAssertion | OracleAssertion | UiAssertion;

export interface GradeScenarioInput {
	artifactRoot: string;
	workspaceRoot: string;
	oraclePath: string;
	assertions: EvalAssertion[];
	metrics: EvalMetrics;
	records: RpcRecord[];
	finalAssistantText: string | null;
	workspace: { before: WorkspaceEvidence; after: WorkspaceEvidence };
	graderCommandTimeoutMs?: number;
}

export interface GradeFailure {
	assertionId: string;
	message: string;
	evidence: string;
}

export interface ScenarioGrade {
	passed: boolean;
	failures: GradeFailure[];
}

export interface ExecuteCaptureAndGradeInput extends EvalRunLifecycleInput {
	workspace: MaterializedEvalRun;
	graderCommandTimeoutMs?: number;
}

export interface CapturedAndGradedScenario {
	lifecycle: CapturedEvalRunLifecycle;
	grade: ScenarioGrade;
}

interface AssertionEvidence {
	assertionId: string;
	assertionType: string;
	message: string;
	expected: unknown;
	actual: unknown;
	eventIndexes: number[];
	workspacePaths: string[];
}

interface AssertionOutcome {
	passed: boolean;
	message: string;
	expected?: unknown;
	actual?: unknown;
	eventIndexes?: number[];
	workspacePaths?: string[];
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

function inventoryEntry(evidence: WorkspaceEvidence, target: string): WorkspaceInventoryEntry | undefined {
	return evidence.inventory.find((entry) => entry.path === target);
}

function inventorySubtree(evidence: WorkspaceEvidence, target: string): WorkspaceInventoryEntry[] {
	return evidence.inventory.filter((entry) => entry.path === target || entry.path.startsWith(`${target}/`));
}

function eventIndexes(records: RpcRecord[], predicate: (record: RpcRecord) => boolean): number[] {
	const indexes: number[] = [];
	records.forEach((record, index) => {
		if (predicate(record)) indexes.push(index);
	});
	return indexes;
}

function matches(operator: "contains" | "equals" | "matches", actual: string, expected: string): boolean {
	if (operator === "equals") return actual === expected;
	if (operator === "contains") return actual.includes(expected);
	return new RegExp(expected, "u").test(actual);
}

function isContained(root: string, target: string): boolean {
	const relative = path.relative(root, target);
	return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function confinedWorkspacePath(workspaceRoot: string, reference: string, mustExist: boolean): Promise<string> {
	assertPackRelativeReference(reference);
	const canonicalRoot = await realpath(workspaceRoot);
	const lexicalTarget = path.join(canonicalRoot, ...reference.split("/"));
	if (!isContained(canonicalRoot, lexicalTarget)) throw new Error(`Assertion path escapes workspace: ${reference}`);
	if (!mustExist) return lexicalTarget;
	const canonicalTarget = await realpath(lexicalTarget);
	if (!isContained(canonicalRoot, canonicalTarget)) throw new Error(`Assertion path escapes workspace through symlink: ${reference}`);
	return canonicalTarget;
}

async function protectedContent(
	workspaceRoot: string,
	reference: string,
	entries: WorkspaceInventoryEntry[],
): Promise<string> {
	const exact = entries.find((entry) => entry.path === reference);
	if (exact?.type === "file") return await readFile(await confinedWorkspacePath(workspaceRoot, reference, true), "utf8");
	const contents: Record<string, string> = {};
	for (const entry of entries.filter((candidate) => candidate.type === "file").sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)))) {
		const relative = entry.path === reference ? path.basename(entry.path) : entry.path.slice(reference.length + 1);
		contents[relative] = await readFile(await confinedWorkspacePath(workspaceRoot, entry.path, true), "utf8");
	}
	return `${JSON.stringify(stableValue(contents), null, 2)}\n`;
}

async function workspaceEntryExists(workspaceRoot: string, reference: string): Promise<boolean> {
	const lexicalPath = await confinedWorkspacePath(workspaceRoot, reference, false);
	const canonicalRoot = await realpath(workspaceRoot);
	let finalEntryExists = false;
	try {
		await lstat(lexicalPath);
		finalEntryExists = true;
		const canonicalTarget = await realpath(lexicalPath);
		if (!isContained(canonicalRoot, canonicalTarget)) throw new Error(`Assertion path escapes workspace through symlink: ${reference}`);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		if (finalEntryExists) throw new Error(`Assertion path is a dangling symbolic link: ${reference}`);
		let ancestor = path.dirname(lexicalPath);
		while (isContained(canonicalRoot, ancestor)) {
			try {
				await lstat(ancestor);
				let canonicalAncestor: string;
				try {
					canonicalAncestor = await realpath(ancestor);
				} catch (ancestorError) {
					if ((ancestorError as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`Assertion path contains a dangling symbolic link: ${reference}`);
					throw ancestorError;
				}
				if (!isContained(canonicalRoot, canonicalAncestor)) throw new Error(`Assertion path escapes workspace through symlink: ${reference}`);
				return false;
			} catch (ancestorError) {
				if ((ancestorError as NodeJS.ErrnoException).code !== "ENOENT") throw ancestorError;
			}
			if (ancestor === canonicalRoot) break;
			ancestor = path.dirname(ancestor);
		}
		return false;
	}
}

async function oracleExpectedPath(oraclePath: string, targetReference: string): Promise<string> {
	const canonicalOracle = await realpath(oraclePath);
	const oracleStat = await stat(canonicalOracle);
	if (!oracleStat.isDirectory()) return canonicalOracle;
	assertPackRelativeReference(targetReference);
	const expectedPath = await realpath(path.join(canonicalOracle, ...targetReference.split("/")));
	if (!isContained(canonicalOracle, expectedPath)) throw new Error("Hidden oracle entry escapes oracle root");
	return expectedPath;
}

async function compareOracle(targetPath: string, expectedPath: string, format: OracleAssertion["format"]): Promise<boolean> {
	const [actual, expected] = await Promise.all([readFile(targetPath), readFile(expectedPath)]);
	if (format === "bytes") return actual.equals(expected);
	if (format === "text") return actual.toString("utf8") === expected.toString("utf8");
	return isDeepStrictEqual(JSON.parse(actual.toString("utf8")), JSON.parse(expected.toString("utf8")));
}

function failed(message: string, expected?: unknown, actual?: unknown, indexes: number[] = [], paths: string[] = []): AssertionOutcome {
	return { passed: false, message, expected, actual, eventIndexes: indexes, workspacePaths: paths };
}

async function evaluateAssertion(input: GradeScenarioInput, assertion: EvalAssertion): Promise<AssertionOutcome> {
	const { metrics, records } = input;
	switch (assertion.type) {
		case "tool-required": {
			const indexes = eventIndexes(records, (record) => record.type === "tool_execution_start" && record.toolName === assertion.tool);
			return indexes.length > 0 ? { passed: true, message: "Required tool was used" } : failed(`Required tool was not used: ${assertion.tool}`, assertion.tool, null, indexes);
		}
		case "tool-forbidden": {
			const indexes = eventIndexes(records, (record) => record.type === "tool_execution_start" && record.toolName === assertion.tool);
			return indexes.length === 0 ? { passed: true, message: "Forbidden tool was not used" } : failed(`Forbidden tool was used: ${assertion.tool}`, 0, indexes.length, indexes);
		}
		case "stale-tool-forbidden": {
			const indexes = eventIndexes(records, (record) => record.type === "tool_execution_start" && record.toolName === assertion.tool);
			return indexes.length === 0 ? { passed: true, message: "Stale tool name was not used" } : failed(`Stale tool name was used: ${assertion.tool}`, 0, indexes.length, indexes);
		}
		case "max-tool-calls": {
			const indexes = eventIndexes(records, (record) => record.type === "tool_execution_start");
			return metrics.efficiency.totalToolCalls <= assertion.maximum ? { passed: true, message: "Tool-call limit passed" } : failed("Maximum tool calls exceeded", assertion.maximum, metrics.efficiency.totalToolCalls, indexes);
		}
		case "max-blocked-attempts": {
			const actual = metrics.toolBehavior.blockedAttempts;
			const indexes = eventIndexes(records, (record) => {
				if (record.type !== "tool_execution_end") return false;
				const result = record.result;
				return result !== null && typeof result === "object" && ((result as Record<string, unknown>).blocked === true || (result as Record<string, unknown>).code === "BLOCKED");
			});
			return actual <= assertion.maximum ? { passed: true, message: "Blocked-attempt limit passed" } : failed("Maximum blocked attempts exceeded", assertion.maximum, actual, indexes);
		}
		case "max-errors": {
			const actual = metrics.reliability.extensionErrorCount + metrics.reliability.toolErrorCount + metrics.reliability.nonRetryableErrorCount;
			const indexes = eventIndexes(records, (record) => record.type === "extension_error" || (record.type === "error" && record.retryable === false) || (record.type === "tool_execution_end" && record.isError === true));
			return actual <= assertion.maximum ? { passed: true, message: "Error limit passed" } : failed("Maximum errors exceeded", assertion.maximum, actual, indexes);
		}
		case "max-turns": {
			const indexes = eventIndexes(records, (record) => record.type === "turn_start");
			return metrics.efficiency.agentTurns <= assertion.maximum ? { passed: true, message: "Turn limit passed" } : failed("Maximum turns exceeded", assertion.maximum, metrics.efficiency.agentTurns, indexes);
		}
		case "final-text": {
			const actual = input.finalAssistantText ?? "";
			return matches(assertion.operator, actual, assertion.expected) ? { passed: true, message: "Final text passed" } : failed(`Final text did not ${assertion.operator} expected value`, assertion.expected, actual);
		}
		case "file": {
			const exists = await workspaceEntryExists(input.workspaceRoot, assertion.path);
			if (assertion.operator === "exists") return exists ? { passed: true, message: "File exists" } : failed("Expected file does not exist", true, false, [], [assertion.path]);
			if (assertion.operator === "absent") return !exists ? { passed: true, message: "File is absent" } : failed("Expected file to be absent", false, true, [], [assertion.path]);
			if (assertion.operator === "unchanged") {
				const before = inventoryEntry(input.workspace.before, assertion.path);
				const after = inventoryEntry(input.workspace.after, assertion.path);
				return isDeepStrictEqual(before, after) ? { passed: true, message: "File is unchanged" } : failed("File changed", before ?? null, after ?? null, [], [assertion.path]);
			}
			if (!exists) return failed("File comparison target does not exist", assertion.expected, null, [], [assertion.path]);
			const content = await readFile(await confinedWorkspacePath(input.workspaceRoot, assertion.path, true), "utf8");
			return matches(assertion.operator, content, assertion.expected ?? "") ? { passed: true, message: "File content passed" } : failed(`File content did not ${assertion.operator} expected value`, assertion.expected, content, [], [assertion.path]);
		}
		case "protected-path": {
			const beforeTree = inventorySubtree(input.workspace.before, assertion.path);
			const afterTree = inventorySubtree(input.workspace.after, assertion.path);
			if (assertion.operator === "exists") return afterTree.length > 0 ? { passed: true, message: "Protected path exists" } : failed("Protected path does not exist", true, false, [], [assertion.path]);
			if (assertion.operator === "absent") return afterTree.length === 0 ? { passed: true, message: "Protected path is absent" } : failed("Protected path exists", false, true, [], afterTree.map((entry) => entry.path));
			if (assertion.operator === "unchanged") {
				const changedPaths = [...new Set([...beforeTree, ...afterTree].map((entry) => entry.path))]
					.filter((candidate) => !isDeepStrictEqual(
						beforeTree.find((entry) => entry.path === candidate),
						afterTree.find((entry) => entry.path === candidate),
					));
				return changedPaths.length === 0 ? { passed: true, message: "Protected path is unchanged" } : failed("Protected path changed", beforeTree, afterTree, [], changedPaths);
			}
			if (afterTree.length === 0) return failed("Protected path comparison target does not exist", assertion.expected, null, [], [assertion.path]);
			const content = await protectedContent(input.workspaceRoot, assertion.path, afterTree);
			return matches(assertion.operator, content, assertion.expected ?? "")
				? { passed: true, message: "Protected path content passed" }
				: failed(`Protected path content did not ${assertion.operator} expected value`, assertion.expected, content, [], [assertion.path]);
		}
		case "git": {
			const actual = metrics.workspaceBehavior.gitClean ? "clean" : "dirty";
			return actual === assertion.operator ? { passed: true, message: "Git state passed" } : failed("Git state did not match", assertion.operator, actual, [], metrics.workspaceBehavior.changedPaths);
		}
		case "grader-command": {
			const timeoutMs = input.graderCommandTimeoutMs ?? 30_000;
			if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 86_400_000) throw new Error("Grader command timeout is invalid");
			const result = await runConfinedWorkspaceCommand(input.workspaceRoot, assertion.command, timeoutMs);
			return !result.timedOut && result.exitCode === 0
				? { passed: true, message: "Grader command passed" }
				: failed("Grader command failed", { exitCode: 0, timedOut: false }, result);
		}
		case "oracle": {
			const target = await confinedWorkspacePath(input.workspaceRoot, assertion.path, true);
			const expectedPath = await oracleExpectedPath(input.oraclePath, assertion.path);
			const [targetStat, expectedStat] = await Promise.all([stat(target), stat(expectedPath)]);
			if (targetStat.dev === expectedStat.dev && targetStat.ino === expectedStat.ino) throw new Error("Hidden oracle aliases the observable workspace result");
			const equal = await compareOracle(target, expectedPath, assertion.format);
			return equal ? { passed: true, message: "Hidden oracle comparison passed" } : failed(
				"Observable result does not equal hidden oracle",
				createHash("sha256").update(await readFile(expectedPath)).digest("hex"),
				createHash("sha256").update(await readFile(target)).digest("hex"),
				[],
				[assertion.path],
			);
		}
		case "ui-policy": {
			const actual = metrics.toolBehavior.unexpectedUiRequests;
			const indexes = eventIndexes(records, (record) => record.type === "extension_ui_request");
			return actual === assertion.expected ? { passed: true, message: "UI-policy count passed" } : failed("Unexpected UI request count did not match", assertion.expected, actual, indexes);
		}
	}
}

const STABLE_ASSERTION_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** Evaluate every declared assertion and retain one evidence file per failure. */
export async function gradeScenario(input: GradeScenarioInput): Promise<ScenarioGrade> {
	const [canonicalWorkspaceRoot, canonicalOracleRoot] = await Promise.all([
		realpath(input.workspaceRoot),
		realpath(input.oraclePath),
	]);
	if (isContained(canonicalWorkspaceRoot, canonicalOracleRoot) || isContained(canonicalOracleRoot, canonicalWorkspaceRoot)) {
		throw new Error("Hidden oracle must be separate from the model-visible workspace");
	}
	const assertionIds = new Set<string>();
	for (const assertion of input.assertions) {
		if (!STABLE_ASSERTION_ID.test(assertion.id) || assertion.id.length > 96) {
			throw new Error(`Invalid assertion ID: ${JSON.stringify(assertion.id)}`);
		}
		if (assertionIds.has(assertion.id)) throw new Error(`Duplicate assertion ID: ${assertion.id}`);
		assertionIds.add(assertion.id);
	}
	await mkdir(path.join(input.artifactRoot, "grade-evidence"), { recursive: true });
	const failures: GradeFailure[] = [];
	for (const assertion of input.assertions) {
		let outcome: AssertionOutcome;
		try {
			outcome = await evaluateAssertion(input, assertion);
		} catch (error) {
			outcome = failed(`Assertion evaluation failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (outcome.passed) continue;
		const evidencePath = `grade-evidence/${assertion.id}.json`;
		const evidence: AssertionEvidence = {
			assertionId: assertion.id,
			assertionType: assertion.type,
			message: outcome.message,
			expected: outcome.expected ?? null,
			actual: outcome.actual ?? null,
			eventIndexes: outcome.eventIndexes ?? [],
			workspacePaths: outcome.workspacePaths ?? [],
		};
		await writeFile(path.join(input.artifactRoot, evidencePath), `${JSON.stringify(stableValue(evidence), null, 2)}\n`);
		failures.push({ assertionId: assertion.id, message: outcome.message, evidence: evidencePath });
	}
	const grade = { passed: failures.length === 0, failures };
	await writeFile(path.join(input.artifactRoot, "grade.json"), `${JSON.stringify(stableValue(grade), null, 2)}\n`);
	return grade;
}

/** Production lifecycle seam: execute RPC, capture complete evidence, then grade it. */
export async function executeCaptureAndGradeScenario(
	input: ExecuteCaptureAndGradeInput,
): Promise<CapturedAndGradedScenario> {
	const lifecycle = await executeAndCaptureEvalRun(input);
	const assertions = input.workspace.scenario.assertions as unknown as EvalAssertion[];
	const grade = await gradeScenario({
		artifactRoot: input.artifactRoot,
		workspaceRoot: input.workspace.workspaceRoot,
		oraclePath: oraclePathForMaterializedRun(input.workspace),
		assertions,
		metrics: lifecycle.capture.metrics,
		records: input.engine.getDiagnostics().records,
		finalAssistantText: lifecycle.run?.finalAssistantText ?? null,
		workspace: { before: input.workspace.before, after: lifecycle.workspaceAfter },
		graderCommandTimeoutMs: input.graderCommandTimeoutMs,
	});
	const graderAssertionIds = new Set(assertions
		.filter((assertion) => assertion.type === "grader-command")
		.map((assertion) => assertion.id));
	const graderCommandFailures = grade.failures.filter((failure) => graderAssertionIds.has(failure.assertionId)).length;
	const metrics = structuredClone(lifecycle.capture.metrics);
	metrics.workspaceBehavior.graderCommandFailures = graderCommandFailures;
	lifecycle.capture.metrics = metrics;
	await writeFile(path.join(input.artifactRoot, "metrics.json"), `${JSON.stringify(stableValue(metrics), null, 2)}\n`);
	const traceResultPath = path.join(input.artifactRoot, "trace-result.json");
	const traceResult = JSON.parse(await readFile(traceResultPath, "utf8")) as Record<string, unknown>;
	traceResult.metrics = metrics;
	await writeFile(traceResultPath, `${JSON.stringify(stableValue(traceResult), null, 2)}\n`);
	return { lifecycle, grade };
}
