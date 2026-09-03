import assert from "node:assert/strict";
import { chmod, cp, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { redactEvalCliMessage, runEvalCli, type EvalCliRuntimeConfig } from "../eval/cli/cli.js";

const unavailableRuntime: EvalCliRuntimeConfig = {
	identityManifestPath: "/synthetic/unavailable/launcher-identity.json",
	expected: {
		piVersion: "synthetic-pi",
		harnessRevision: "synthetic-harness",
		launcherId: "pi-r-local",
		launcherPath: "/synthetic/unavailable/pi-r-local",
		piRRevision: "synthetic-pi-r",
		resourceRoot: "/synthetic/unavailable/resources",
		extensionPath: "/synthetic/unavailable/resources/extension.ts",
		skillPath: "/synthetic/unavailable/resources/SKILL.md",
	},
};

function captureIo() {
	const stdout: string[] = [];
	const stderr: string[] = [];
	return { io: { stdout: (value: string) => stdout.push(value), stderr: (value: string) => stderr.push(value) }, stdout, stderr };
}

async function syntheticPack() {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-eval-cli-pack-"));
	await cp("eval/contracts/fixtures/valid", root, { recursive: true });
	return { root, pack: path.join(root, "pack.json") };
}

async function fakeLiveRuntime() {
	const value = await syntheticPack();
	const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "pi-eval-cli-runtime-"));
	const resourceRoot = path.join(runtimeRoot, "pi-r");
	const extensionPath = path.join(resourceRoot, "extension.ts");
	const skillPath = path.join(resourceRoot, "SKILL.md");
	await mkdir(resourceRoot);
	await writeFile(extensionPath, "export const synthetic = true;\n");
	await writeFile(skillPath, "# Synthetic skill\n");
	const launcherPath = path.join(runtimeRoot, "pi-r-local");
	await writeFile(launcherPath, `#!${process.env.PI_TEST_SHELL ?? "/bin/sh"}\nprintf '{"launcherId":"pi-r-local","resourceRoot":"%s","extensionPath":"%s","skillPath":"%s"}\\n' ${JSON.stringify(resourceRoot)} ${JSON.stringify(extensionPath)} ${JSON.stringify(skillPath)} > "$PI_EVAL_ATTESTATION_PATH"\nexec ${JSON.stringify(process.execPath)} "$@"\n`);
	await chmod(launcherPath, 0o755);
	const identityManifestPath = path.join(runtimeRoot, "launcher-identity.json");
	await writeFile(identityManifestPath, JSON.stringify({
		schemaVersion: "1.0.0",
		launcher: {
			id: "pi-r-local",
			path: launcherPath,
			defaultArgs: [path.resolve("tests/fixtures/eval-rpc/fake-rpc.mjs")],
			requiredResourceBindings: [resourceRoot, extensionPath, skillPath],
		},
		pi: { version: "synthetic-pi" },
		harness: { revision: "synthetic-harness" },
		piR: { revision: "synthetic-pi-r", resourceRoot, extensionPath, skillPath },
	}));
	const scenarioPath = path.join(value.root, "scenarios", "cli-v3.json");
	const scenario = JSON.parse(await readFile(path.join(value.root, "scenarios", "sensor-smoke-v3.json"), "utf8")) as Record<string, unknown>;
	scenario.assertions = [{ id: "final", type: "final-text", operator: "contains", expected: "synthetic answer" }];
	await writeFile(scenarioPath, JSON.stringify(scenario));
	const pack = JSON.parse(await readFile(value.pack, "utf8")) as Record<string, unknown>;
	pack.scenarios = ["scenarios/cli-v3.json"];
	pack.suites = [{ id: "smoke", scenarios: ["sensor-smoke"] }];
	await writeFile(value.pack, JSON.stringify(pack));
	return {
		...value,
		runtime: {
			identityManifestPath,
			expected: {
				piVersion: "synthetic-pi",
				harnessRevision: "synthetic-harness",
				launcherId: "pi-r-local",
				launcherPath,
				piRRevision: "synthetic-pi-r",
				resourceRoot,
				extensionPath,
				skillPath,
			},
		} satisfies EvalCliRuntimeConfig,
	};
}

test("list validates a synthetic pack and emits stable scenario and suite JSON", async () => {
	const value = await syntheticPack();
	const capture = captureIo();
	const code = await runEvalCli(["list", "--pack", value.pack, "--json"], unavailableRuntime, capture.io);
	assert.equal(code, 0);
	const listed = JSON.parse(capture.stdout.join("")) as { pack: { id: string }; scenarios: Array<{ id: string }>; suites: Array<{ id: string }> };
	assert.equal(listed.pack.id, "fictional-sensor-pack");
	assert.deepEqual(listed.scenarios.map((scenario) => scenario.id), ["sensor-smoke"]);
	assert.deepEqual(listed.suites.map((suite) => suite.id), ["smoke"]);
	assert.deepEqual(capture.stderr, []);
});

test("live run and suite fail before materialization unless explicitly enabled", async () => {
	const value = await syntheticPack();
	for (const command of [
		["run", "--pack", value.pack, "--scenario", "sensor-smoke", "--output", path.join(value.root, "run"), "--model", "synthetic/model"],
		["suite", "--pack", value.pack, "--suite", "smoke", "--output", path.join(value.root, "suite"), "--model", "synthetic/model"],
	]) {
		const capture = captureIo();
		assert.equal(await runEvalCli(command, unavailableRuntime, capture.io), 1);
		assert.match(capture.stderr.join(""), /requires explicit --live-model opt-in/);
	}
});

test("live output cannot overlap or mutate the synthetic pack root", async () => {
	const value = await syntheticPack();
	const output = path.join(value.root, "forbidden-output");
	const capture = captureIo();
	assert.equal(await runEvalCli([
		"run", "--live-model", "--pack", value.pack, "--scenario", "sensor-smoke", "--output", output,
		"--model", "local-synthetic/fabricated-model",
	], unavailableRuntime, capture.io), 1);
	assert.match(capture.stderr.join(""), /output must be separate from the pack root/);
	await assert.rejects(readFile(output), /ENOENT/);

	const external = await mkdtemp(path.join(os.tmpdir(), "pi-eval-cli-link-"));
	const linkedOutput = path.join(external, "output-link");
	await symlink(path.join(value.root, "fixtures"), linkedOutput);
	const linkedCapture = captureIo();
	assert.equal(await runEvalCli([
		"run", "--live-model", "--pack", value.pack, "--scenario", "sensor-smoke", "--output", linkedOutput,
		"--model", "local-synthetic/fabricated-model",
	], unavailableRuntime, linkedCapture.io), 1);
	assert.match(linkedCapture.stderr.join(""), /output must not be a symbolic link/);

	const suiteOutput = await mkdtemp(path.join(os.tmpdir(), "pi-eval-cli-suite-link-"));
	await symlink(path.join(value.root, "fixtures"), path.join(suiteOutput, "sensor-smoke"));
	const suiteCapture = captureIo();
	assert.equal(await runEvalCli([
		"suite", "--live-model", "--pack", value.pack, "--suite", "smoke", "--output", suiteOutput,
		"--model", "local-synthetic/fabricated-model",
	], unavailableRuntime, suiteCapture.io), 1);
	assert.match(suiteCapture.stderr.join(""), /output must not be a symbolic link/);
});

test("opted-in run executes the complete fake-RPC lifecycle and retains artifacts", async () => {
	const value = await fakeLiveRuntime();
	const output = await mkdtemp(path.join(os.tmpdir(), "pi-eval-cli-output-"));
	const previousProvider = process.env.FAKE_RPC_MODEL_PROVIDER;
	const previousModel = process.env.FAKE_RPC_MODEL_ID;
	process.env.FAKE_RPC_MODEL_PROVIDER = "local-synthetic";
	process.env.FAKE_RPC_MODEL_ID = "fabricated-model";
	try {
		const capture = captureIo();
		const code = await runEvalCli([
			"run", "--live-model", "--pack", value.pack, "--scenario", "sensor-smoke", "--output", output,
			"--model", "local-synthetic/fabricated-model",
		], value.runtime, capture.io);
		assert.equal(code, 0);
		const run = JSON.parse(await readFile(path.join(output, "eval-run.json"), "utf8")) as { status: string; evidenceRoot: string };
		assert.equal(run.status, "passed");
		assert.deepEqual(JSON.parse(await readFile(path.join(run.evidenceRoot, "grade.json"), "utf8")), { failures: [], passed: true });
		assert.equal(JSON.parse(await readFile(path.join(run.evidenceRoot, "launcher-provenance.json"), "utf8")).concurrency, 1);
		await readFile(path.join(run.evidenceRoot, "trace-result.json"), "utf8");
	} finally {
		if (previousProvider === undefined) delete process.env.FAKE_RPC_MODEL_PROVIDER;
		else process.env.FAKE_RPC_MODEL_PROVIDER = previousProvider;
		if (previousModel === undefined) delete process.env.FAKE_RPC_MODEL_ID;
		else process.env.FAKE_RPC_MODEL_ID = previousModel;
	}
});

test("opted-in suite runs sequentially and emits its report", async () => {
	const value = await fakeLiveRuntime();
	const output = await mkdtemp(path.join(os.tmpdir(), "pi-eval-cli-suite-"));
	const previousProvider = process.env.FAKE_RPC_MODEL_PROVIDER;
	const previousModel = process.env.FAKE_RPC_MODEL_ID;
	process.env.FAKE_RPC_MODEL_PROVIDER = "local-synthetic";
	process.env.FAKE_RPC_MODEL_ID = "fabricated-model";
	try {
		const capture = captureIo();
		assert.equal(await runEvalCli([
			"suite", "--live-model", "--pack", value.pack, "--suite", "smoke", "--output", output,
			"--model", "local-synthetic/fabricated-model",
		], value.runtime, capture.io), 0);
		assert.equal(JSON.parse(capture.stdout.join("")).concurrency, 1);
		assert.equal(JSON.parse(await readFile(path.join(output, "report.json"), "utf8")).totals.passed, 1);
		await readFile(path.join(output, "sensor-smoke", "eval-run.json"), "utf8");
	} finally {
		if (previousProvider === undefined) delete process.env.FAKE_RPC_MODEL_PROVIDER;
		else process.env.FAKE_RPC_MODEL_PROVIDER = previousProvider;
		if (previousModel === undefined) delete process.env.FAKE_RPC_MODEL_ID;
		else process.env.FAKE_RPC_MODEL_ID = previousModel;
	}
});

test("report deterministically summarizes retained run artifacts", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-eval-cli-report-"));
	await Promise.all([mkdir(path.join(root, "b")), mkdir(path.join(root, "a"))]);
	await writeFile(path.join(root, "b", "eval-run.json"), JSON.stringify({ schemaVersion: "1.0.0", scenarioId: "scenario-b", status: "failed", evidenceRoot: "b/evidence" }));
	await writeFile(path.join(root, "a", "eval-run.json"), JSON.stringify({ schemaVersion: "1.0.0", scenarioId: "scenario-a", status: "passed", evidenceRoot: "a/evidence" }));
	const capture = captureIo();
	assert.equal(await runEvalCli(["report", "--output", root], unavailableRuntime, capture.io), 2);
	const report = JSON.parse(await readFile(path.join(root, "report.json"), "utf8")) as { totals: { runs: number; passed: number; failed: number }; runs: Array<{ scenarioId: string }> };
	assert.deepEqual(report.totals, { failed: 1, infrastructureErrors: 0, passed: 1, runs: 2 });
	assert.deepEqual(report.runs.map((run) => run.scenarioId), ["scenario-a", "scenario-b"]);
	assert.match(await readFile(path.join(root, "report.md"), "utf8"), /scenario-a.*passed[\s\S]*scenario-b.*failed/);

	const parent = await mkdtemp(path.join(os.tmpdir(), "pi-eval-cli-report-link-"));
	const linkedRoot = path.join(parent, "linked-output");
	await symlink(root, linkedRoot);
	const linkedCapture = captureIo();
	assert.equal(await runEvalCli(["report", "--output", linkedRoot], unavailableRuntime, linkedCapture.io), 1);
	assert.match(linkedCapture.stderr.join(""), /Report output must not be a symbolic link/);
});

test("failure summaries redact complete authorization values", () => {
	const redacted = redactEvalCliMessage(new Error("Authorization: Bearer child-emitted-secret"));
	assert.doesNotMatch(redacted, /child-emitted-secret/);
	assert.match(redacted, /Authorization: <redacted>/);
});

test("post-materialization launcher failures retain workspace and partial artifacts", async () => {
	const value = await syntheticPack();
	const output = await mkdtemp(path.join(os.tmpdir(), "pi-eval-cli-launch-failure-"));
	const capture = captureIo();
	assert.equal(await runEvalCli([
		"run", "--live-model", "--pack", value.pack, "--scenario", "sensor-smoke", "--output", output,
		"--model", "local-synthetic/fabricated-model",
	], unavailableRuntime, capture.io), 1);
	const run = JSON.parse(await readFile(path.join(output, "eval-run.json"), "utf8")) as { status: string; evidenceRoot: string };
	assert.equal(run.status, "infrastructure-error");
	await readFile(path.join(run.evidenceRoot, "before.json"), "utf8");
	await readFile(path.join(output, "cli-error.json"), "utf8");
});

test("live infrastructure failures retain bounded CLI evidence under the requested output", async () => {
	const value = await syntheticPack();
	const malformed = path.join(value.root, "malformed.json");
	await writeFile(malformed, "{not-json}\n");
	const output = await mkdtemp(path.join(os.tmpdir(), "pi-eval-cli-failed-output-"));
	const capture = captureIo();
	const code = await runEvalCli([
		"run", "--live-model", "--pack", malformed, "--scenario", "sensor-smoke", "--output", output, "--model", "synthetic/model",
	], unavailableRuntime, capture.io);
	assert.equal(code, 1);
	const failure = await readFile(path.join(output, "cli-error.json"), "utf8");
	assert.match(failure, /Evaluation CLI failed/);
	assert.equal(typeof JSON.parse(failure).failure, "string");
	assert.doesNotMatch(failure, /environment|token|secret/i);
});
