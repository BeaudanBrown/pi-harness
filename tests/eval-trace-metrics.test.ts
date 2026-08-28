import assert from "node:assert/strict";
import { cp, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PiRpcEngine } from "../eval/rpc/engine.js";
import { captureEvalRunArtifacts, executeAndCaptureEvalRun, type EvalTraceCaptureInput } from "../eval/trace/capture.js";
import { materializeEvalRun } from "../eval/workspace/materialize.js";

async function settledFixture(): Promise<EvalTraceCaptureInput> {
	return JSON.parse(await readFile("tests/fixtures/eval-traces/settled.json", "utf8")) as EvalTraceCaptureInput;
}

test("real fake-RPC failure lifecycle writes artifacts in its finally path", async () => {
	const packRoot = await mkdtemp(path.join(os.tmpdir(), "pi-trace-pack-"));
	const runsRoot = await mkdtemp(path.join(os.tmpdir(), "pi-trace-runs-"));
	await cp("eval/contracts/fixtures/valid", packRoot, { recursive: true });
	const workspace = await materializeEvalRun({
		packRoot,
		packReference: "pack.json",
		scenarioId: "sensor-smoke",
		runsRoot,
	});
	const engine = new PiRpcEngine({
		command: process.execPath,
		args: [path.resolve("tests/fixtures/eval-rpc/fake-rpc.mjs")],
		env: { FAKE_RPC_MODE: "malformed" },
		commandTimeoutMs: 1_000,
		promptTimeoutMs: 2_000,
		runTimeoutMs: 5_000,
		shutdownGraceMs: 100,
	});
	await engine.start();
	const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "pi-trace-lifecycle-"));
	try {
		const lifecycle = await executeAndCaptureEvalRun({
			artifactRoot,
			startedAtMs: 1000,
			clock: () => 1200,
			engine,
			workspace,
			execute: async () => await engine.promptAndWait("Emit malformed fabricated RPC output."),
		});
		assert.equal(lifecycle.failure?.kind, "malformed");
		assert.equal(lifecycle.capture.status, "invalid");
		assert.equal(lifecycle.capture.artifacts.includes("records.jsonl"), true);
		assert.equal(lifecycle.capture.artifacts.includes("workspace-after.json"), true);
		assert.match(await readFile(path.join(artifactRoot, "diagnostics.json"), "utf8"), /Malformed RPC JSONL record/);
	} finally {
		await engine.stop();
		await workspace.cleanup();
	}
});

test("failed synthetic traces retain artifacts with null-safe deterministic metrics", async () => {
	const fixtures = JSON.parse(await readFile("tests/fixtures/eval-traces/failures.json", "utf8")) as Array<
		EvalTraceCaptureInput & { name: string }
	>;
	const captures = new Map<string, Awaited<ReturnType<typeof captureEvalRunArtifacts>>>();
	for (const fixture of fixtures) {
		const artifactRoot = await mkdtemp(path.join(os.tmpdir(), `pi-eval-${fixture.name}-`));
		const captured = await captureEvalRunArtifacts({ ...fixture, artifactRoot });
		captures.set(fixture.name, captured);
		assert.equal(captured.metrics.reliability.passed, false);
		assert.equal(captured.artifacts.includes("diagnostics.json"), true);
		assert.equal(captured.artifacts.includes("metrics.json"), true);
		assert.equal(captured.artifacts.includes("report.md"), true);
		assert.equal(captured.artifacts.includes("trace-result.json"), true);
	}
	assert.equal(captures.get("timeout")!.status, "timed-out");
	assert.equal(captures.get("crash")!.status, "crashed");
	assert.equal(captures.get("malformed")!.status, "invalid");

	const timeout = captures.get("timeout")!.metrics;
	assert.equal(timeout.reliability.timeoutCount, 1);
	assert.equal(timeout.reliability.agentSettled, false);
	assert.equal(timeout.efficiency.timeToFirstToolCallMs, 200);
	assert.equal(timeout.efficiency.inputTokens, null);
	assert.equal(timeout.efficiency.peakContextTokens, null);
	assert.deepEqual(timeout.toolBehavior.requiredToolsMissing, ["r_inspect"]);

	const crash = captures.get("crash")!.metrics;
	assert.deepEqual(crash.reliability, {
		passed: false,
		processExitStatus: 7,
		timeoutCount: 0,
		extensionErrorCount: 1,
		toolErrorCount: 2,
		nonRetryableErrorCount: 1,
		truncatedCompletionCount: 1,
		agentSettled: false,
	});
	assert.equal(crash.efficiency.repeatedIdenticalToolCalls, 1);
	assert.equal(crash.toolBehavior.repeatedFailedCalls, 1);
	assert.equal(crash.toolBehavior.blockedAttempts, 2);
	assert.deepEqual(crash.toolBehavior.forbiddenToolsUsed, ["evaluate_r"]);
	assert.deepEqual(crash.toolBehavior.staleToolNames, ["evaluate_r"]);
	assert.deepEqual(crash.toolBehavior.authorityChangingCommands, ["git commit -m fabricated"]);
	assert.equal(crash.toolBehavior.unexpectedUiRequests, 1);
	assert.deepEqual(crash.workspaceBehavior.changedPaths, ["locked/config.json"]);
	assert.deepEqual(crash.workspaceBehavior.protectedPathsChanged, ["locked/config.json"]);
	assert.equal(crash.workspaceBehavior.commitsCreated, 1);
	assert.equal(crash.workspaceBehavior.graderCommandFailures, 1);
});

test("settled synthetic trace produces deterministic metrics without mutating raw evidence", async () => {
	const input = await settledFixture();
	input.run!.state = { "ä": 1, z: 2 };
	input.diagnostics.stderrBytes = Uint8Array.from([0xff, 0x0a]);
	const original = structuredClone(input);
	const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "pi-eval-trace-"));
	const captured = await captureEvalRunArtifacts({ ...input, artifactRoot });

	assert.deepEqual(input, original);
	assert.equal(captured.status, "passed");
	assert.deepEqual(captured.metrics, {
		schemaVersion: "1.0.0",
		reliability: {
			passed: true,
			processExitStatus: 0,
			timeoutCount: 0,
			extensionErrorCount: 0,
			toolErrorCount: 0,
			nonRetryableErrorCount: 0,
			truncatedCompletionCount: 0,
			agentSettled: true,
		},
		efficiency: {
			wallClockMs: 1000,
			timeToFirstToolCallMs: 200,
			timeToFirstUsefulToolCallMs: 600,
			agentTurns: 2,
			totalToolCalls: 2,
			uniqueToolCalls: 2,
			repeatedIdenticalToolCalls: 0,
			toolCallsBeforeUsefulAction: 1,
			inputTokens: 100,
			outputTokens: 20,
			cacheTokens: 8,
			totalTokens: 128,
			peakContextTokens: 96,
			compactionCount: 0,
			finalResponseCharacters: 16,
		},
		toolBehavior: {
			requiredToolsMissing: [],
			forbiddenToolsUsed: [],
			blockedAttempts: 0,
			staleToolNames: [],
			repeatedFailedCalls: 0,
			authorityChangingCommands: [],
			unexpectedUiRequests: 0,
		},
		workspaceBehavior: {
			changedPaths: ["answer.json"],
			protectedPathsChanged: [],
			gitClean: false,
			commitsCreated: 0,
			graderCommandFailures: 0,
		},
	});
	const eventLines = (await readFile(path.join(artifactRoot, "events.jsonl"), "utf8"))
		.trimEnd().split("\n").map((line) => JSON.parse(line) as unknown);
	assert.deepEqual(eventLines, input.diagnostics.records.filter((record) => record.type !== "response"));
	assert.deepEqual(
		await readFile(path.join(artifactRoot, "stderr.txt")),
		Buffer.from([0xff, 0x0a]),
	);
	assert.equal(captured.artifacts.includes("final-state.json"), true);
	const finalState = await readFile(path.join(artifactRoot, "final-state.json"), "utf8");
	assert.equal(finalState.indexOf('"z"') < finalState.indexOf('"ä"'), true);
	assert.equal(captured.summary.length <= 4000, true);
	assert.match(captured.summary, /Reliability: passed/);
	const secondRoot = await mkdtemp(path.join(os.tmpdir(), "pi-eval-trace-repeat-"));
	await captureEvalRunArtifacts({ ...input, artifactRoot: secondRoot });
	for (const artifact of ["metrics.json", "report.md", "trace-result.json"]) {
		assert.equal(
			await readFile(path.join(artifactRoot, artifact), "utf8"),
			await readFile(path.join(secondRoot, artifact), "utf8"),
		);
	}
});
