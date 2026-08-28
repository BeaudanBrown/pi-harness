import assert from "node:assert/strict";
import { chmod, cp, link, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { hashPackReference } from "../eval/contracts/path-policy.js";
import { EvalMaterializationError, materializeEvalRun } from "../eval/workspace/materialize.js";

async function syntheticPackCopy(): Promise<{ root: string; runsRoot: string }> {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-eval-pack-"));
	const runsRoot = await mkdtemp(path.join(os.tmpdir(), "pi-eval-runs-"));
	await cp("eval/contracts/fixtures/valid", root, { recursive: true });
	return { root, runsRoot };
}

test("attached external roots are rejected and failure evidence is retained", async () => {
	const { root, runsRoot } = await syntheticPackCopy();
	const packPath = path.join(root, "pack.json");
	const pack = JSON.parse(await readFile(packPath, "utf8")) as Record<string, unknown>;
	pack.attachedDataRoot = "/fabricated-but-external";
	await writeFile(packPath, `${JSON.stringify(pack, null, 2)}\n`);

	let failure: unknown;
	try {
		await materializeEvalRun({ packRoot: root, packReference: "pack.json", scenarioId: "sensor-smoke", runsRoot });
	} catch (error) {
		failure = error;
	}
	assert.equal(failure instanceof EvalMaterializationError, true);
	const materializationError = failure as EvalMaterializationError;
	assert.match(String(materializationError.cause), /Unsupported eval pack field: attachedDataRoot/);
	assert.equal(
		(await readFile(path.join(materializationError.evidenceRoot, "materialization-error.json"), "utf8"))
			.includes("attachedDataRoot"),
		true,
	);
});

test("generator arguments cannot attach external or traversal paths", async () => {
	const { root, runsRoot } = await syntheticPackCopy();
	const scenario = JSON.parse(await readFile(path.join(root, "scenarios", "sensor-smoke-v2.json"), "utf8")) as Record<string, unknown>;
	scenario.materialization = {
		generator: {
			path: "fixtures/sensors.csv",
			args: ["--input=/external/fabricated.csv"],
			outputs: { workspacePath: "workspace", questionPath: "question.txt", oraclePath: "oracle.json", provenancePath: "provenance.json" },
		},
	};
	await writeFile(path.join(root, "scenarios", "external-arg.json"), `${JSON.stringify(scenario, null, 2)}\n`);
	const pack = JSON.parse(await readFile(path.join(root, "pack.json"), "utf8")) as Record<string, unknown>;
	pack.scenarios = ["scenarios/external-arg.json"];
	await writeFile(path.join(root, "pack.json"), `${JSON.stringify(pack, null, 2)}\n`);
	await assert.rejects(
		materializeEvalRun({ packRoot: root, packReference: "pack.json", scenarioId: "sensor-smoke", runsRoot }),
		(error: unknown) => error instanceof EvalMaterializationError
			&& String(error.cause).includes("Generator args cannot contain filesystem paths or URIs"),
	);
});

test("runtime schema guards reject duplicate pack references", async () => {
	const { root, runsRoot } = await syntheticPackCopy();
	const packPath = path.join(root, "pack.json");
	const pack = JSON.parse(await readFile(packPath, "utf8")) as { baselineSummaries: string[] };
	pack.baselineSummaries.push(pack.baselineSummaries[0]!);
	await writeFile(packPath, `${JSON.stringify(pack, null, 2)}\n`);
	await assert.rejects(
		materializeEvalRun({ packRoot: root, packReference: "pack.json", scenarioId: "sensor-smoke", runsRoot }),
		(error: unknown) => error instanceof EvalMaterializationError
			&& String(error.cause).includes("Duplicate eval pack baseline summary"),
	);
});

test("runtime schema guards reject non-positive scenario deadlines before materialization", async () => {
	const { root, runsRoot } = await syntheticPackCopy();
	const scenarioPath = path.join(root, "scenarios", "sensor-smoke.json");
	const scenario = JSON.parse(await readFile(scenarioPath, "utf8")) as { timeouts: { runMs: number } };
	scenario.timeouts.runMs = 0;
	await writeFile(scenarioPath, `${JSON.stringify(scenario, null, 2)}\n`);
	await assert.rejects(
		materializeEvalRun({ packRoot: root, packReference: "pack.json", scenarioId: "sensor-smoke", runsRoot }),
		(error: unknown) => error instanceof EvalMaterializationError
			&& String(error.cause).includes("Scenario runMs must be an integer from 1 through 86400000"),
	);
});

test("copied hidden oracle content cannot enter a workspace tree", async () => {
	const { root, runsRoot } = await syntheticPackCopy();
	await mkdir(path.join(root, "fixtures", "workspace"));
	await cp(path.join(root, "fixtures", "sensors.csv"), path.join(root, "fixtures", "workspace", "sensors.csv"));
	await cp(path.join(root, "oracles", "sensor-smoke.json"), path.join(root, "fixtures", "workspace", "copied-oracle.json"));
	const scenarioPath = path.join(root, "scenarios", "sensor-smoke.json");
	const scenario = JSON.parse(await readFile(scenarioPath, "utf8")) as {
		materialization: { fixture: { workspacePath: string } };
		provenance: { dataContentHash: string };
	};
	scenario.materialization.fixture.workspacePath = "fixtures/workspace";
	scenario.provenance.dataContentHash = await hashPackReference(root, "fixtures/workspace");
	await writeFile(scenarioPath, `${JSON.stringify(scenario, null, 2)}\n`);
	await assert.rejects(
		materializeEvalRun({ packRoot: root, packReference: "pack.json", scenarioId: "sensor-smoke", runsRoot }),
		(error: unknown) => error instanceof EvalMaterializationError
			&& String(error.cause).includes("copied into model-visible workspace content"),
	);
});

test("hard-linked hidden oracle files cannot enter a workspace tree", async () => {
	const { root, runsRoot } = await syntheticPackCopy();
	await mkdir(path.join(root, "fixtures", "workspace"));
	await cp(path.join(root, "fixtures", "sensors.csv"), path.join(root, "fixtures", "workspace", "sensors.csv"));
	await link(path.join(root, "oracles", "sensor-smoke.json"), path.join(root, "fixtures", "workspace", "leaked-oracle.json"));
	const scenarioPath = path.join(root, "scenarios", "sensor-smoke.json");
	const scenario = JSON.parse(await readFile(scenarioPath, "utf8")) as {
		materialization: { fixture: { workspacePath: string } };
		provenance: { dataContentHash: string };
	};
	scenario.materialization.fixture.workspacePath = "fixtures/workspace";
	scenario.provenance.dataContentHash = await hashPackReference(root, "fixtures/workspace");
	await writeFile(scenarioPath, `${JSON.stringify(scenario, null, 2)}\n`);
	await assert.rejects(
		materializeEvalRun({ packRoot: root, packReference: "pack.json", scenarioId: "sensor-smoke", runsRoot }),
		(error: unknown) => error instanceof EvalMaterializationError
			&& String(error.cause).includes("aliases or overlaps model-visible workspace content"),
	);
});

test("fixture Git metadata is rejected before initializing the isolated repository", async () => {
	const { root, runsRoot } = await syntheticPackCopy();
	await mkdir(path.join(root, "fixtures", "repository", ".git"), { recursive: true });
	await cp(path.join(root, "fixtures", "sensors.csv"), path.join(root, "fixtures", "repository", "sensors.csv"));
	await writeFile(path.join(root, "fixtures", "repository", ".git", "config"), "[core]\n\trepositoryformatversion = 0\n");
	const scenarioPath = path.join(root, "scenarios", "sensor-smoke.json");
	const scenario = JSON.parse(await readFile(scenarioPath, "utf8")) as {
		materialization: { fixture: { workspacePath: string } };
		provenance: { dataContentHash: string };
	};
	scenario.materialization.fixture.workspacePath = "fixtures/repository";
	scenario.provenance.dataContentHash = await hashPackReference(root, "fixtures/repository");
	await writeFile(scenarioPath, `${JSON.stringify(scenario, null, 2)}\n`);

	await assert.rejects(
		materializeEvalRun({ packRoot: root, packReference: "pack.json", scenarioId: "sensor-smoke", runsRoot }),
		(error: unknown) => error instanceof EvalMaterializationError
			&& String(error.cause).includes("Workspace material cannot contain .git metadata"),
	);
});

test("workspace trees cannot alias a hidden oracle through an internal symlink", async () => {
	const { root, runsRoot } = await syntheticPackCopy();
	await mkdir(path.join(root, "fixtures", "workspace"));
	await cp(path.join(root, "fixtures", "sensors.csv"), path.join(root, "fixtures", "workspace", "sensors.csv"));
	await symlink("../../oracles/sensor-smoke.json", path.join(root, "fixtures", "workspace", "leaked-oracle.json"));
	const scenarioPath = path.join(root, "scenarios", "sensor-smoke.json");
	const scenario = JSON.parse(await readFile(scenarioPath, "utf8")) as {
		materialization: { fixture: { workspacePath: string } };
		provenance: { dataContentHash: string };
	};
	scenario.materialization.fixture.workspacePath = "fixtures/workspace";
	scenario.provenance.dataContentHash = await hashPackReference(root, "fixtures/workspace");
	await writeFile(scenarioPath, `${JSON.stringify(scenario, null, 2)}\n`);

	await assert.rejects(
		materializeEvalRun({ packRoot: root, packReference: "pack.json", scenarioId: "sensor-smoke", runsRoot }),
		(error: unknown) => error instanceof EvalMaterializationError
			&& String(error.cause).includes("aliases or overlaps model-visible workspace content"),
	);
});

test("generated workspace trees cannot alias their hidden oracle", async () => {
	const { root, runsRoot } = await syntheticPackCopy();
	const previewRoot = path.join(root, "preview");
	await mkdir(path.join(previewRoot, "workspace"), { recursive: true });
	await cp(path.join(root, "oracles", "sensor-smoke.json"), path.join(previewRoot, "oracle.json"));
	await symlink("../oracle.json", path.join(previewRoot, "workspace", "leaked-oracle.json"));
	const declaredHash = await hashPackReference(previewRoot, "workspace");
	await mkdir(path.join(root, "generators"), { recursive: true });
	const generatorPath = path.join(root, "generators", "alias-oracle.mjs");
	await writeFile(generatorPath, `#!/usr/bin/env node
import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
const out = process.env.PI_EVAL_OUTPUT_ROOT;
await mkdir(path.join(out, "workspace"), { recursive: true });
await writeFile(path.join(out, "question.txt"), "Which fictional greenhouse sensor has the largest fabricated temperature range?");
await writeFile(path.join(out, "oracle.json"), "{\\n  \\\"sensorId\\\": \\\"fictional-a\\\",\\n  \\\"range\\\": 8\\n}\\n");
await symlink("../oracle.json", path.join(out, "workspace", "leaked-oracle.json"));
await writeFile(path.join(out, "provenance.json"), JSON.stringify({ synthetic: true, generatorId: "fictional-sensor-generator", generatorVersion: "1.2.0", seed: 17, scenarioVariantId: "seed-17", rowCount: 3, dataContentHash: "${declaredHash}", expectedOracleHash: "sha256:5c26bd3c782897c836069858a70179174062a6d7b2ef8f89538f79c8be6a890e" }, null, 2) + "\\n");
`);
	await chmod(generatorPath, 0o755);
	const scenario = JSON.parse(await readFile(path.join(root, "scenarios", "sensor-smoke-v2.json"), "utf8")) as Record<string, unknown>;
	(scenario.provenance as Record<string, unknown>).dataContentHash = declaredHash;
	scenario.materialization = { generator: { path: "generators/alias-oracle.mjs", args: [], outputs: { workspacePath: "workspace", questionPath: "question.txt", oraclePath: "oracle.json", provenancePath: "provenance.json" } } };
	await writeFile(path.join(root, "scenarios", "generated-alias.json"), `${JSON.stringify(scenario, null, 2)}\n`);
	const pack = JSON.parse(await readFile(path.join(root, "pack.json"), "utf8")) as Record<string, unknown>;
	pack.scenarios = ["scenarios/generated-alias.json"];
	await writeFile(path.join(root, "pack.json"), `${JSON.stringify(pack, null, 2)}\n`);

	await assert.rejects(
		materializeEvalRun({ packRoot: root, packReference: "pack.json", scenarioId: "sensor-smoke", runsRoot }),
		(error: unknown) => error instanceof EvalMaterializationError
			&& String(error.cause).includes("aliases or overlaps model-visible workspace content"),
	);
});

test("generator failure retains stdout, stderr, and partial output evidence", async () => {
	const { root, runsRoot } = await syntheticPackCopy();
	await mkdir(path.join(root, "generators"), { recursive: true });
	const generatorPath = path.join(root, "generators", "fail.mjs");
	await writeFile(generatorPath, `#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
await mkdir(process.env.PI_EVAL_OUTPUT_ROOT, { recursive: true });
await writeFile(path.join(process.env.PI_EVAL_OUTPUT_ROOT, "partial.txt"), "synthetic partial\\n");
console.log("synthetic generator stdout");
console.error("synthetic generator stderr");
process.exit(7);
`);
	await chmod(generatorPath, 0o755);
	const scenario = JSON.parse(await readFile(path.join(root, "scenarios", "sensor-smoke-v2.json"), "utf8")) as Record<string, unknown>;
	scenario.materialization = {
		generator: {
			path: "generators/fail.mjs",
			args: [],
			outputs: { workspacePath: "workspace", questionPath: "question.txt", oraclePath: "oracle.json", provenancePath: "provenance.json" },
		},
	};
	await writeFile(path.join(root, "scenarios", "failure.json"), `${JSON.stringify(scenario, null, 2)}\n`);
	const pack = JSON.parse(await readFile(path.join(root, "pack.json"), "utf8")) as Record<string, unknown>;
	pack.scenarios = ["scenarios/failure.json"];
	await writeFile(path.join(root, "pack.json"), `${JSON.stringify(pack, null, 2)}\n`);

	let failure: unknown;
	try {
		await materializeEvalRun({ packRoot: root, packReference: "pack.json", scenarioId: "sensor-smoke", runsRoot });
	} catch (error) {
		failure = error;
	}
	assert.equal(failure instanceof EvalMaterializationError, true);
	const materializationError = failure as EvalMaterializationError;
	const generatorEvidence = await readFile(path.join(materializationError.evidenceRoot, "generator.json"), "utf8");
	assert.match(generatorEvidence, /synthetic generator stdout/);
	assert.match(generatorEvidence, /synthetic generator stderr/);
	assert.equal(await readFile(path.join(materializationError.runRoot, "generated", "partial.txt"), "utf8"), "synthetic partial\n");
});

test("every scenario reference is confined even when that scenario is not selected", async () => {
	const { root, runsRoot } = await syntheticPackCopy();
	const externalRoot = await mkdtemp(path.join(os.tmpdir(), "pi-external-data-"));
	await writeFile(path.join(externalRoot, "outside.csv"), "external,content\n");
	await symlink(path.join(externalRoot, "outside.csv"), path.join(root, "fixtures", "external.csv"));
	const escapedScenario = JSON.parse(await readFile(path.join(root, "scenarios", "sensor-smoke.json"), "utf8")) as {
		id: string;
		materialization: { fixture: { workspacePath: string } };
	};
	escapedScenario.id = "unselected-escape";
	escapedScenario.materialization.fixture.workspacePath = "fixtures/external.csv";
	await writeFile(path.join(root, "scenarios", "unselected-escape.json"), `${JSON.stringify(escapedScenario, null, 2)}\n`);
	const pack = JSON.parse(await readFile(path.join(root, "pack.json"), "utf8")) as { scenarios: string[] };
	pack.scenarios.push("scenarios/unselected-escape.json");
	await writeFile(path.join(root, "pack.json"), `${JSON.stringify(pack, null, 2)}\n`);

	await assert.rejects(
		materializeEvalRun({ packRoot: root, packReference: "pack.json", scenarioId: "sensor-smoke", runsRoot }),
		(error: unknown) => error instanceof EvalMaterializationError
			&& String(error.cause).includes("Pack reference escapes canonical root"),
	);
});

test("a deterministic generator reproduces workspace and hidden oracle hashes", async () => {
	const { root, runsRoot } = await syntheticPackCopy();
	const externalRoot = await mkdtemp(path.join(os.tmpdir(), "pi-generator-external-"));
	const externalPath = path.join(externalRoot, "fabricated-external.csv");
	await writeFile(externalPath, "synthetic but undeclared external content\n");
	await mkdir(path.join(root, "generators"), { recursive: true });
	const generatorPath = path.join(root, "generators", "fabricate.mjs");
	await writeFile(generatorPath, `#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
const out = process.env.PI_EVAL_OUTPUT_ROOT;
try {
  await readFile(${JSON.stringify(externalPath)});
  process.exit(91);
} catch {}
await mkdir(path.join(out, "workspace"), { recursive: true });
await writeFile(path.join(out, "workspace", "sensors.csv"), "sensor_id,temperature\\nfictional-a,20\\nfictional-b,24\\nfictional-a,28\\n");
await writeFile(path.join(out, "question.txt"), "Which fictional greenhouse sensor has the largest fabricated temperature range?");
await writeFile(path.join(out, "oracle.json"), "{\\n  \\\"sensorId\\\": \\\"fictional-a\\\",\\n  \\\"range\\\": 8\\n}\\n");
await writeFile(path.join(out, "provenance.json"), JSON.stringify({ synthetic: true, generatorId: "fictional-sensor-generator", generatorVersion: "1.2.0", seed: 17, scenarioVariantId: "seed-17", rowCount: 3, dataContentHash: "sha256:e9ddb8bda58cbf5c7d3ed295a11ec04832f17015b8076706c7fd70cb4b0b04f0", expectedOracleHash: "sha256:5c26bd3c782897c836069858a70179174062a6d7b2ef8f89538f79c8be6a890e" }, null, 2) + "\\n");
`);
	await chmod(generatorPath, 0o755);
	const scenario = JSON.parse(await readFile(path.join(root, "scenarios", "sensor-smoke-v2.json"), "utf8")) as Record<string, unknown>;
	scenario.materialization = {
		generator: {
			path: "generators/fabricate.mjs",
			args: [],
			outputs: {
				workspacePath: "workspace/sensors.csv",
				questionPath: "question.txt",
				oraclePath: "oracle.json",
				provenancePath: "provenance.json",
			},
		},
	};
	await writeFile(path.join(root, "scenarios", "generated.json"), `${JSON.stringify(scenario, null, 2)}\n`);
	const pack = JSON.parse(await readFile(path.join(root, "pack.json"), "utf8")) as Record<string, unknown>;
	pack.scenarios = ["scenarios/generated.json"];
	await writeFile(path.join(root, "pack.json"), `${JSON.stringify(pack, null, 2)}\n`);

	const previousBubblewrap = process.env.PI_EVAL_BWRAP;
	process.env.PI_EVAL_BWRAP = "/bin/true";
	let first: Awaited<ReturnType<typeof materializeEvalRun>>;
	let second: Awaited<ReturnType<typeof materializeEvalRun>>;
	try {
		first = await materializeEvalRun({ packRoot: root, packReference: "pack.json", scenarioId: "sensor-smoke", runsRoot });
		second = await materializeEvalRun({ packRoot: root, packReference: "pack.json", scenarioId: "sensor-smoke", runsRoot });
	} finally {
		if (previousBubblewrap === undefined) delete process.env.PI_EVAL_BWRAP;
		else process.env.PI_EVAL_BWRAP = previousBubblewrap;
	}
	assert.deepEqual(first.before.inventory, second.before.inventory);
	assert.equal(first.scenario.provenance.dataContentHash, second.scenario.provenance.dataContentHash);
	assert.equal(first.scenario.provenance.expectedOracleHash, second.scenario.provenance.expectedOracleHash);
	assert.equal(first.oraclePath.startsWith(first.workspaceRoot), false);
	await assert.rejects(readFile(path.join(first.workspaceRoot, "oracle.json")), /ENOENT/);
	assert.equal(JSON.parse(await readFile(first.provenancePath, "utf8")).synthetic, true);
	await Promise.all([first.cleanup(), second.cleanup()]);
});

test("workspace execution failures still capture after-state evidence", async () => {
	const { root, runsRoot } = await syntheticPackCopy();
	const run = await materializeEvalRun({ packRoot: root, packReference: "pack.json", scenarioId: "sensor-smoke", runsRoot });
	await assert.rejects(
		run.withWorkspaceEvidence(async (workspaceRoot) => {
			await writeFile(path.join(workspaceRoot, "partial-answer.json"), "{\"synthetic\":true}\n");
			await symlink("partial-answer.json", path.join(workspaceRoot, "latest-answer.json"));
			throw new Error("synthetic execution failure");
		}),
		/synthetic execution failure/,
	);
	const after = JSON.parse(await readFile(path.join(run.evidenceRoot, "after.json"), "utf8")) as {
		gitStatus: string;
		inventory: Array<{ path: string; type: string }>;
	};
	assert.match(after.gitStatus, /partial-answer\.json/);
	assert.deepEqual(
		after.inventory.find((entry) => entry.path === "latest-answer.json"),
		{ path: "latest-answer.json", type: "symlink", target: "partial-answer.json" },
	);
	await run.cleanup();
});

test("isolated Git ignores ambient repository-routing configuration", async () => {
	const { root, runsRoot } = await syntheticPackCopy();
	const ambientRoot = await mkdtemp(path.join(os.tmpdir(), "pi-ambient-git-"));
	const previousGitDir = process.env.GIT_DIR;
	const previousGitWorkTree = process.env.GIT_WORK_TREE;
	process.env.GIT_DIR = path.join(ambientRoot, ".git");
	process.env.GIT_WORK_TREE = ambientRoot;
	try {
		const run = await materializeEvalRun({ packRoot: root, packReference: "pack.json", scenarioId: "sensor-smoke", runsRoot });
		assert.match(await readFile(path.join(run.workspaceRoot, ".git", "HEAD"), "utf8"), /^ref: refs\/heads\//);
		await run.cleanup();
	} finally {
		if (previousGitDir === undefined) delete process.env.GIT_DIR;
		else process.env.GIT_DIR = previousGitDir;
		if (previousGitWorkTree === undefined) delete process.env.GIT_WORK_TREE;
		else process.env.GIT_WORK_TREE = previousGitWorkTree;
	}
});

test("fixture materialization creates an isolated Git workspace and retained evidence", async () => {
	const { root, runsRoot } = await syntheticPackCopy();
	const run = await materializeEvalRun({
		packRoot: root,
		packReference: "pack.json",
		scenarioId: "sensor-smoke",
		runsRoot,
	});

	assert.equal(run.scenario.id, "sensor-smoke");
	assert.equal(
		await readFile(path.join(run.workspaceRoot, "sensors.csv"), "utf8"),
		"sensor_id,temperature\nfictional-a,20\nfictional-b,24\nfictional-a,28\n",
	);
	assert.deepEqual(run.before.inventory, [{
		path: "sensors.csv",
		type: "file",
		bytes: 67,
		sha256: "e9ddb8bda58cbf5c7d3ed295a11ec04832f17015b8076706c7fd70cb4b0b04f0",
	}]);
	assert.equal(run.before.gitStatus, "");
	assert.equal(run.oraclePath.startsWith(run.workspaceRoot), false);
	assert.equal(path.relative(run.workspaceRoot, run.oraclePath).startsWith(`..${path.sep}`), true);
	await assert.rejects(readFile(path.join(run.workspaceRoot, "..", "hidden", path.basename(run.oraclePath))), /ENOENT/);
	assert.equal(await readFile(run.oraclePath, "utf8"), '{\n  "sensorId": "fictional-a",\n  "range": 8\n}\n');
	assert.equal((await readFile(run.provenancePath, "utf8")).includes('"synthetic": true'), true);

	await writeFile(path.join(run.workspaceRoot, "answer.json"), '{"sensor_id":"fictional-a","range":8}\n');
	await writeFile(path.join(run.workspaceRoot, "sensors.csv"), "sensor_id,temperature\nfictional-a,21\n");
	const after = await run.captureAfter();
	assert.match(after.gitStatus, /^ M sensors\.csv$/m);
	assert.match(after.gitStatus, /^\?\? answer\.json$/m);
	assert.match(after.gitDiff, /-fictional-b,24/);
	assert.equal(after.inventory.some((entry) => entry.path === "answer.json"), true);
	assert.equal((await readFile(path.join(run.evidenceRoot, "after.json"), "utf8")).includes("answer.json"), true);

	await run.cleanup();
	await assert.rejects(readFile(path.join(run.runRoot, "evidence", "before.json")), /ENOENT/);
	await assert.rejects(readFile(path.join(run.workspaceRoot, "sensors.csv")), /ENOENT/);
});
