import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
	assertHiddenOracleSeparated,
	assertSyntheticProvenanceSchema,
	hashPackReference,
	resolvePackReference,
	verifyGeneratedProvenance,
	verifyPackSemantics,
	verifyProvenanceIdentity,
	verifyScenarioProvenance,
	verifyScenarioSemantics,
	type PackSemanticContract,
	type ScenarioSemanticContract,
	type SyntheticProvenance,
} from "../eval/contracts/path-policy.js";

async function contractFixture(): Promise<{ outside: string; root: string }> {
	const temporaryRoot = await mkdtemp(path.join(tmpdir(), "pi-harness-eval-contracts-"));
	const root = path.join(temporaryRoot, "pack");
	const outside = path.join(temporaryRoot, "outside");
	await Promise.all([
		mkdir(path.join(root, "fixtures"), { recursive: true }),
		mkdir(path.join(root, "oracles"), { recursive: true }),
		mkdir(outside, { recursive: true }),
	]);
	await Promise.all([
		writeFile(path.join(root, "fixtures", "data.csv"), "id,value\na,1\n"),
		writeFile(path.join(root, "oracles", "expected.json"), "{\"value\":1}\n"),
		writeFile(path.join(outside, "real.csv"), "private\n"),
	]);
	return { outside, root };
}

test("pack references resolve only beneath the canonical pack root", async () => {
	const { root } = await contractFixture();
	assert.equal(
		await resolvePackReference(root, "fixtures/data.csv"),
		path.join(await realpath(root), "fixtures", "data.csv"),
	);

	for (const invalid of ["", "/srv/data.csv", "C:\\data\\file.csv", "file:///srv/data.csv", "../data.csv", "fixtures/../oracles/expected.json", "fixtures\\data.csv", "./fixtures/data.csv"]) {
		await assert.rejects(resolvePackReference(root, invalid), /Invalid pack-relative path/);
	}
});

test("canonical resolution rejects a symlink that escapes the pack", async () => {
	const { outside, root } = await contractFixture();
	await symlink(outside, path.join(root, "fixtures", "attached-real-data"));
	await assert.rejects(
		resolvePackReference(root, "fixtures/attached-real-data/real.csv"),
		/escapes canonical root/,
	);
});

test("fixture and generated output channels match linked scenario provenance", async () => {
	const packRoot = "eval/contracts/fixtures/valid";
	const scenario = JSON.parse(await readFile(path.join(packRoot, "scenarios", "sensor-smoke.json"), "utf8")) as {
		variant: { id: string; seed: string | number };
		materialization: { fixture: { workspacePath: string; oraclePath: string } };
		provenance: SyntheticProvenance;
	};
	const { workspacePath, oraclePath } = scenario.materialization.fixture;
	await verifyScenarioProvenance(packRoot, workspacePath, oraclePath, scenario.variant, scenario.provenance);
	await assert.rejects(
		verifyScenarioProvenance(packRoot, workspacePath, oraclePath, scenario.variant, {
			...scenario.provenance,
			dataContentHash: `sha256:${"0".repeat(64)}`,
		}),
		/Synthetic data hash mismatch/,
	);
});

test("generated output channels include the exact fabricated question and provenance", async () => {
	const { root } = await contractFixture();
	const question = "Which fictional machine has the highest fabricated reading?\n";
	await writeFile(path.join(root, "question.txt"), question);
	const provenance: SyntheticProvenance = {
		synthetic: true,
		generatorId: "fictional-machine-generator",
		generatorVersion: "1.0.0",
		seed: 7,
		scenarioVariantId: "seed-7",
		rowCount: 1,
		dataContentHash: await hashPackReference(root, "fixtures/data.csv"),
		expectedOracleHash: await hashPackReference(root, "oracles/expected.json"),
	};
	await writeFile(path.join(root, "provenance.json"), `${JSON.stringify(provenance)}\n`);
	await verifyGeneratedProvenance(
		root,
		"fixtures/data.csv",
		"question.txt",
		"oracles/expected.json",
		"provenance.json",
		{ id: "seed-7", seed: 7 },
		question,
		provenance,
	);
	await assert.rejects(
		verifyGeneratedProvenance(
			root,
			"fixtures/data.csv",
			"question.txt",
			"oracles/expected.json",
			"provenance.json",
			{ id: "seed-7", seed: 7 },
			"A different fabricated question\n",
			provenance,
		),
		/fabricated question does not match/,
	);
	await assert.rejects(
		verifyGeneratedProvenance(
			root,
			"fixtures/data.csv",
			"question.txt",
			"fixtures/data.csv",
			"provenance.json",
			{ id: "seed-7", seed: 7 },
			question,
			provenance,
		),
		/aliases or overlaps model-visible workspace content/,
	);
});

test("generated provenance rejects properties forbidden by its JSON Schema", async () => {
	const provenance: unknown = JSON.parse(await readFile(
		"eval/contracts/fixtures/invalid/provenance-extra-property.json",
		"utf8",
	));
	assert.throws(
		() => assertSyntheticProvenanceSchema(provenance),
		/does not match synthetic-provenance.schema.json/,
	);
});

test("pack suite identities and loaded scenario membership are unambiguous", async () => {
	for (const [fixture, expected] of [
		["pack-duplicate-suite-id.json", /Duplicate suite ID/],
		["pack-unknown-scenario.json", /references unknown scenario ID/],
	] as const) {
		const pack = JSON.parse(await readFile(
			path.join("eval/contracts/fixtures/invalid", fixture),
			"utf8",
		)) as PackSemanticContract;
		assert.throws(() => verifyPackSemantics(pack, ["sensor-smoke"]), expected);
	}
});

test("scenario prompt, assertion, and UI match identities are unique", async () => {
	for (const [fixture, expected] of [
		["scenario-duplicate-prompt-id.json", /Duplicate prompt ID/],
		["scenario-duplicate-assertion-id.json", /Duplicate assertion ID/],
		["scenario-duplicate-ui-dialog.json", /Duplicate extension UI dialog match/],
	] as const) {
		const scenario = JSON.parse(await readFile(
			path.join("eval/contracts/fixtures/invalid", fixture),
			"utf8",
		)) as ScenarioSemanticContract;
		assert.throws(() => verifyScenarioSemantics(scenario), expected);
	}
});

test("scenario variant and provenance identity must match", async () => {
	const scenario = JSON.parse(await readFile(
		"eval/contracts/fixtures/invalid/scenario-provenance-mismatch.json",
		"utf8",
	)) as { variant: { id: string; seed: string | number }; provenance: SyntheticProvenance };
	assert.throws(
		() => verifyProvenanceIdentity(scenario.variant, scenario.provenance),
		/provenance seed or scenario variant does not match/,
	);
});

test("hidden oracle cannot alias model-visible workspace content", async () => {
	const { root } = await contractFixture();
	await Promise.all([
		symlink(path.join(root, "fixtures", "data.csv"), path.join(root, "oracles", "alias.csv")),
		writeFile(path.join(root, "fixtures", "nested-oracle.json"), "{\"value\":1}\n"),
	]);
	await assertHiddenOracleSeparated(root, "fixtures/data.csv", "oracles/expected.json");
	await assert.rejects(
		assertHiddenOracleSeparated(root, "fixtures/data.csv", "oracles/alias.csv"),
		/aliases or overlaps model-visible workspace content/,
	);
	await assert.rejects(
		assertHiddenOracleSeparated(root, "fixtures", "fixtures/nested-oracle.json"),
		/aliases or overlaps model-visible workspace content/,
	);
});
