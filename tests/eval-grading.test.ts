import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { executeCaptureAndGradeScenario, gradeScenario, type GradeScenarioInput } from "../eval/grading/grade.js";
import { PiRpcEngine } from "../eval/rpc/engine.js";
import type { EvalMetrics } from "../eval/trace/capture.js";
import { materializeEvalRun } from "../eval/workspace/materialize.js";

async function gradingFixture(): Promise<GradeScenarioInput> {
	const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "pi-grade-workspace-"));
	const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "pi-grade-artifacts-"));
	const hiddenRoot = await mkdtemp(path.join(os.tmpdir(), "pi-grade-hidden-"));
	await writeFile(path.join(workspaceRoot, "answer.json"), '{"sensor":"fictional-a","range":8}\n');
	await writeFile(path.join(workspaceRoot, "summary.txt"), "fabricated summary\n");
	await mkdir(path.join(workspaceRoot, "locked"));
	await writeFile(path.join(workspaceRoot, "locked", "config.json"), "locked synthetic content\n");
	const oraclePath = path.join(hiddenRoot, "expected.json");
	await writeFile(oraclePath, '{"sensor":"fictional-a","range":8}\n');
	const metrics = JSON.parse(await readFile("eval/contracts/fixtures/valid/metrics.json", "utf8")) as EvalMetrics;
	metrics.reliability.toolErrorCount = 2;
	metrics.toolBehavior.forbiddenToolsUsed = ["evaluate_r"];
	metrics.toolBehavior.blockedAttempts = 1;
	metrics.toolBehavior.unexpectedUiRequests = 1;
	metrics.workspaceBehavior.gitClean = false;
	metrics.workspaceBehavior.changedPaths = ["answer.json", "locked/config.json", "summary.txt"];
	metrics.workspaceBehavior.protectedPathsChanged = ["locked/config.json"];
	return {
		artifactRoot,
		workspaceRoot,
		oraclePath,
		finalAssistantText: "The largest fabricated range belongs to fictional-a.",
		metrics,
		records: [
			{ type: "tool_execution_start", toolCallId: "tool-1", toolName: "r_exec", args: {} },
			{ type: "tool_execution_start", toolCallId: "tool-2", toolName: "evaluate_r", args: {} },
			{ type: "tool_execution_end", toolCallId: "tool-2", toolName: "evaluate_r", isError: true, result: { blocked: true } },
			{ type: "extension_ui_request", id: "ui-1", method: "confirm", title: "Fabricated dialog" },
		],
		workspace: {
			before: {
				inventory: [{ path: "locked/config.json", type: "file", bytes: 2, sha256: "a".repeat(64) }],
				gitStatus: "",
				gitDiff: "",
			},
			after: {
				inventory: [
					{ path: "answer.json", type: "file", bytes: 37, sha256: "b".repeat(64) },
					{ path: "locked/config.json", type: "file", bytes: 3, sha256: "c".repeat(64) },
					{ path: "summary.txt", type: "file", bytes: 19, sha256: "d".repeat(64) },
				],
				gitStatus: " M locked/config.json\n?? answer.json\n?? summary.txt",
				gitDiff: "synthetic diff",
			},
		},
		assertions: [
			{ id: "exec-required", type: "tool-required", tool: "r_exec" },
			{ id: "legacy-forbidden", type: "tool-forbidden", tool: "evaluate_r" },
			{ id: "stale-forbidden", type: "stale-tool-forbidden", tool: "evaluate_r" },
			{ id: "no-blocked-attempts", type: "max-blocked-attempts", maximum: 0 },
			{ id: "no-tool-errors", type: "max-errors", maximum: 0 },
			{ id: "final-answer", type: "final-text", operator: "contains", expected: "fictional-a" },
			{ id: "answer-exists", type: "file", path: "answer.json", operator: "exists" },
			{ id: "summary-content", type: "file", path: "summary.txt", operator: "contains", expected: "independent oracle" },
			{ id: "locked-preserved", type: "protected-path", path: "locked/config.json", operator: "unchanged" },
			{ id: "locked-tree-preserved", type: "protected-path", path: "locked", operator: "unchanged" },
			{ id: "missing-protected-content", type: "protected-path", path: "missing-protected", operator: "equals", expected: "{}\n" },
			{ id: "git-clean", type: "git", operator: "clean" },
			{ id: "oracle-match", type: "oracle", path: "answer.json", format: "json", operator: "equals" },
			{ id: "ui-clean", type: "ui-policy", operator: "equals", expected: 0 },
		],
	};
}

test("file existence assertions reject escaping and dangling symlinks", async () => {
	const input = await gradingFixture();
	const externalRoot = await mkdtemp(path.join(os.tmpdir(), "pi-grade-link-external-"));
	const externalPath = path.join(externalRoot, "fabricated.txt");
	await writeFile(externalPath, "synthetic external\n");
	await symlink(externalPath, path.join(input.workspaceRoot, "external-link.txt"));
	await symlink(externalRoot, path.join(input.workspaceRoot, "external-dir-link"));
	await symlink("missing-target.txt", path.join(input.workspaceRoot, "dangling-link.txt"));
	await symlink("missing-directory", path.join(input.workspaceRoot, "dangling-dir-link"));
	input.assertions = [
		{ id: "external-link-exists", type: "file", path: "external-link.txt", operator: "exists" },
		{ id: "external-intermediate-exists", type: "file", path: "external-dir-link/fabricated.txt", operator: "exists" },
		{ id: "dangling-link-absent", type: "file", path: "dangling-link.txt", operator: "absent" },
		{ id: "dangling-intermediate-absent", type: "file", path: "dangling-dir-link/child.txt", operator: "absent" },
	];
	const grade = await gradeScenario(input);
	assert.deepEqual(grade.failures.map((failure) => failure.assertionId), [
		"external-link-exists",
		"external-intermediate-exists",
		"dangling-link-absent",
		"dangling-intermediate-absent",
	]);
	assert.match(grade.failures[0]!.message, /escapes workspace through symlink/);
	assert.match(grade.failures[1]!.message, /escapes workspace through symlink/);
	assert.match(grade.failures[2]!.message, /dangling symbolic link/);
	assert.match(grade.failures[3]!.message, /dangling symbolic link/);
});

test("hidden oracle cannot alias the model-visible workspace", async () => {
	const input = await gradingFixture();
	input.oraclePath = path.join(input.workspaceRoot, "answer.json");
	input.assertions = [{ id: "oracle-self", type: "oracle", path: "answer.json", format: "json", operator: "equals" }];
	await assert.rejects(gradeScenario(input), /Hidden oracle must be separate from the model-visible workspace/);
});

test("production lifecycle executes, captures, and grades a fake RPC run", async () => {
	const packRoot = await mkdtemp(path.join(os.tmpdir(), "pi-grade-pack-"));
	const runsRoot = await mkdtemp(path.join(os.tmpdir(), "pi-grade-runs-"));
	await cp("eval/contracts/fixtures/valid", packRoot, { recursive: true });
	const lifecycleScenario = JSON.parse(await readFile(path.join(packRoot, "scenarios", "sensor-smoke-v3.json"), "utf8")) as Record<string, unknown>;
	lifecycleScenario.assertions = [
		{ id: "final-synthetic", type: "final-text", operator: "contains", expected: "synthetic answer" },
		{ id: "materialized-oracle", type: "oracle", path: "answer.json", format: "json", operator: "equals" },
		{ id: "failing-grader", type: "grader-command", command: ["node", "-e", "process.exit(3)"] },
	];
	await writeFile(path.join(packRoot, "scenarios", "lifecycle-v3.json"), `${JSON.stringify(lifecycleScenario, null, 2)}\n`);
	const lifecyclePack = JSON.parse(await readFile(path.join(packRoot, "pack.json"), "utf8")) as Record<string, unknown>;
	lifecyclePack.scenarios = ["scenarios/lifecycle-v3.json"];
	await writeFile(path.join(packRoot, "pack.json"), `${JSON.stringify(lifecyclePack, null, 2)}\n`);
	const workspace = await materializeEvalRun({ packRoot, packReference: "pack.json", scenarioId: "sensor-smoke", runsRoot });
	await writeFile(path.join(workspace.workspaceRoot, "answer.json"), '{\n  "sensorId": "fictional-a",\n  "range": 8\n}\n');
	await writeFile(path.join(workspace.workspaceRoot, "bogus-oracle.json"), '{"bogus":true}\n');
	workspace.oraclePath = path.join(workspace.workspaceRoot, "bogus-oracle.json");
	const engine = new PiRpcEngine({
		command: process.execPath,
		args: [path.resolve("tests/fixtures/eval-rpc/fake-rpc.mjs")],
		commandTimeoutMs: 1_000,
		promptTimeoutMs: 2_000,
		runTimeoutMs: 5_000,
		shutdownGraceMs: 100,
	});
	await engine.start();
	try {
		const result = await executeCaptureAndGradeScenario({
			artifactRoot: workspace.evidenceRoot,
			startedAtMs: 1000,
			clock: () => 1200,
			engine,
			workspace,
			execute: async () => await engine.promptAndWait("Complete the fabricated grading lifecycle."),
		});
		assert.equal(result.lifecycle.capture.status, "passed");
		assert.deepEqual(result.grade.failures.map((failure) => failure.assertionId), ["failing-grader"]);
		assert.equal(result.lifecycle.capture.metrics.workspaceBehavior.graderCommandFailures, 1);
		assert.equal(
			(JSON.parse(await readFile(path.join(workspace.evidenceRoot, "metrics.json"), "utf8")) as EvalMetrics)
				.workspaceBehavior.graderCommandFailures,
			1,
		);
		assert.deepEqual(JSON.parse(await readFile(path.join(workspace.evidenceRoot, "grade.json"), "utf8")), result.grade);
	} finally {
		await engine.stop();
		await workspace.cleanup();
	}
});

test("assertion IDs cannot escape evidence paths or collide", async () => {
	const input = await gradingFixture();
	input.assertions = [{ id: "../../outside", type: "tool-required", tool: "r_exec" }];
	await assert.rejects(gradeScenario(input), /Invalid assertion ID/);
	await assert.rejects(readFile(path.join(input.artifactRoot, "outside.json")), /ENOENT/);
	input.assertions = [
		{ id: "duplicate", type: "tool-required", tool: "r_exec" },
		{ id: "duplicate", type: "tool-forbidden", tool: "evaluate_r" },
	];
	await assert.rejects(gradeScenario(input), /Duplicate assertion ID: duplicate/);
});

test("all declarative assertion families can pass deterministically", async () => {
	const input = await gradingFixture();
	await writeFile(path.join(input.workspaceRoot, "stable.txt"), "fixed synthetic signature\n");
	const stableEntry = { path: "stable.txt", type: "file" as const, bytes: 26, sha256: "e".repeat(64) };
	input.workspace.before.inventory.push(stableEntry);
	input.workspace.after.inventory.push(stableEntry);
	input.assertions = [
		{ id: "required", type: "tool-required", tool: "r_exec" },
		{ id: "forbidden", type: "tool-forbidden", tool: "r_object_inspect" },
		{ id: "stale", type: "stale-tool-forbidden", tool: "r_object_inspect" },
		{ id: "blocked", type: "max-blocked-attempts", maximum: 1 },
		{ id: "calls", type: "max-tool-calls", maximum: 2 },
		{ id: "errors", type: "max-errors", maximum: 2 },
		{ id: "turns", type: "max-turns", maximum: 2 },
		{ id: "final", type: "final-text", operator: "matches", expected: "fictional-a\\.$" },
		{ id: "exists", type: "file", path: "answer.json", operator: "exists" },
		{ id: "absent", type: "file", path: "missing.txt", operator: "absent" },
		{ id: "equals", type: "file", path: "summary.txt", operator: "equals", expected: "fabricated summary\n" },
		{ id: "matches", type: "file", path: "summary.txt", operator: "matches", expected: "^fabricated" },
		{ id: "signature", type: "protected-path", path: "stable.txt", operator: "unchanged" },
		{ id: "protected-exists", type: "protected-path", path: "stable.txt", operator: "exists" },
		{ id: "protected-absent", type: "protected-path", path: "not-created.txt", operator: "absent" },
		{ id: "protected-equals", type: "protected-path", path: "stable.txt", operator: "equals", expected: "fixed synthetic signature\n" },
		{ id: "protected-contains", type: "protected-path", path: "stable.txt", operator: "contains", expected: "synthetic" },
		{ id: "protected-matches", type: "protected-path", path: "stable.txt", operator: "matches", expected: "signature\\n$" },
		{ id: "protected-tree-equals", type: "protected-path", path: "locked", operator: "equals", expected: '{\n  "config.json": "locked synthetic content\\n"\n}\n' },
		{ id: "protected-tree-contains", type: "protected-path", path: "locked", operator: "contains", expected: "locked synthetic content" },
		{ id: "protected-tree-matches", type: "protected-path", path: "locked", operator: "matches", expected: "config\\.json" },
		{ id: "dirty", type: "git", operator: "dirty" },
		{ id: "oracle-json", type: "oracle", path: "answer.json", format: "json", operator: "equals" },
		{ id: "oracle-text", type: "oracle", path: "answer.json", format: "text", operator: "equals" },
		{ id: "oracle-bytes", type: "oracle", path: "answer.json", format: "bytes", operator: "equals" },
		{ id: "ui", type: "ui-policy", operator: "equals", expected: 1 },
	];
	const grade = await gradeScenario(input);
	assert.deepEqual(grade, { passed: true, failures: [] });
	assert.deepEqual(JSON.parse(await readFile(path.join(input.artifactRoot, "grade.json"), "utf8")), grade);
});

test("grader command deadlines are bounded and retained as failures", async () => {
	const input = await gradingFixture();
	input.graderCommandTimeoutMs = 100;
	input.assertions = [{
		id: "hanging-command",
		type: "grader-command",
		command: ["node", "-e", "setInterval(() => {}, 1000)"],
	}];
	const started = Date.now();
	const grade = await gradeScenario(input);
	assert.equal(Date.now() - started < 2_000, true);
	assert.deepEqual(grade.failures.map((failure) => failure.assertionId), ["hanging-command"]);
	assert.match(await readFile(path.join(input.artifactRoot, grade.failures[0]!.evidence), "utf8"), /"timedOut": true/);
});

test("grader commands run read-only inside the synthetic workspace sandbox", async () => {
	const input = await gradingFixture();
	const externalRoot = await mkdtemp(path.join(os.tmpdir(), "pi-grade-external-"));
	const externalPath = path.join(externalRoot, "fabricated-secret.txt");
	await writeFile(externalPath, "synthetic but undeclared\n");
	input.assertions = [
		{
			id: "workspace-command",
			type: "grader-command",
			command: ["node", "-e", "const fs=require('fs');if(!fs.readFileSync('answer.json','utf8').includes('fictional-a'))process.exit(2)"],
		},
		{
			id: "escape-command",
			type: "grader-command",
			command: ["node", "-e", `require('fs').readFileSync(${JSON.stringify(externalPath)})`],
		},
	];
	const grade = await gradeScenario(input);
	assert.deepEqual(grade.failures.map((failure) => failure.assertionId), ["escape-command"]);
	const evidence = await readFile(path.join(input.artifactRoot, grade.failures[0]!.evidence), "utf8");
	assert.match(evidence, /exitCode/);
	assert.match(evidence, /escape-command/);
});

test("deterministic grading reports every independent failure with exact evidence", async () => {
	const input = await gradingFixture();
	const original = structuredClone(input);
	const grade = await gradeScenario(input);
	assert.deepEqual(input, original);
	assert.equal(grade.passed, false);
	assert.deepEqual(grade.failures.map((failure) => failure.assertionId), [
		"legacy-forbidden",
		"stale-forbidden",
		"no-blocked-attempts",
		"no-tool-errors",
		"summary-content",
		"locked-preserved",
		"locked-tree-preserved",
		"missing-protected-content",
		"git-clean",
		"ui-clean",
	]);
	const evidenceByAssertion = new Map<string, { eventIndexes: number[]; workspacePaths: string[] }>();
	for (const failure of grade.failures) {
		const evidence = JSON.parse(await readFile(path.join(input.artifactRoot, failure.evidence), "utf8")) as {
			assertionId: string;
			eventIndexes: number[];
			workspacePaths: string[];
		};
		assert.equal(evidence.assertionId, failure.assertionId);
		assert.equal(Array.isArray(evidence.eventIndexes), true);
		assert.equal(Array.isArray(evidence.workspacePaths), true);
		evidenceByAssertion.set(failure.assertionId, evidence);
	}
	assert.deepEqual(evidenceByAssertion.get("stale-forbidden")!.eventIndexes, [1]);
	assert.deepEqual(evidenceByAssertion.get("no-blocked-attempts")!.eventIndexes, [2]);
	assert.deepEqual(evidenceByAssertion.get("locked-preserved")!.workspacePaths, ["locked/config.json"]);
	assert.deepEqual(evidenceByAssertion.get("locked-tree-preserved")!.workspacePaths, ["locked/config.json"]);
});
