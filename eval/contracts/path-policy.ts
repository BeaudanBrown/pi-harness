import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

const URI_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/;
const TREE_HASH_DOMAIN = "pi-harness-eval-tree-sha256-v1\0";

function isContained(root: string, target: string): boolean {
	const relativeTarget = path.relative(root, target);
	return relativeTarget === "" || (
		relativeTarget !== ".."
		&& !relativeTarget.startsWith(`..${path.sep}`)
		&& !path.isAbsolute(relativeTarget)
	);
}

/**
 * Resolve an existing pack reference beneath the canonical pack root.
 *
 * Pack references are portable POSIX-relative paths. Canonical filesystem
 * resolution is mandatory: lexical prefix checks alone do not catch symlink
 * escapes.
 */
export async function resolvePackReference(packRoot: string, reference: string): Promise<string> {
	if (
		reference.length === 0
		|| reference.includes("\0")
		|| reference.includes("\\")
		|| path.posix.isAbsolute(reference)
		|| WINDOWS_ABSOLUTE.test(reference)
		|| URI_SCHEME.test(reference)
		|| path.posix.normalize(reference) !== reference
		|| reference.split("/").some((segment) => segment === "." || segment === ".." || segment === "")
	) {
		throw new Error(`Invalid pack-relative path: ${JSON.stringify(reference)}`);
	}

	const canonicalRoot = await realpath(packRoot);
	const canonicalTarget = await realpath(path.join(canonicalRoot, ...reference.split("/")));
	if (!isContained(canonicalRoot, canonicalTarget)) {
		throw new Error(`Pack reference escapes canonical root: ${JSON.stringify(reference)}`);
	}
	return canonicalTarget;
}

/** Ensure the evaluator-only oracle cannot alias or overlap model-visible data. */
export async function assertHiddenOracleSeparated(
	packRoot: string,
	workspaceReference: string,
	oracleReference: string,
): Promise<void> {
	const [workspacePath, oraclePath] = await Promise.all([
		resolvePackReference(packRoot, workspaceReference),
		resolvePackReference(packRoot, oracleReference),
	]);
	if (isContained(workspacePath, oraclePath) || isContained(oraclePath, workspacePath)) {
		throw new Error("Hidden oracle aliases or overlaps model-visible workspace content");
	}
}

/**
 * Hash a confined file as its raw bytes, or a directory as a stable sorted tree.
 * Tree entries are domain-separated and length-delimited so path/content
 * boundaries cannot collide. Internal symlinks are followed only after proving
 * their canonical targets remain under the pack root; cycles are rejected.
 */
export async function hashPackReference(packRoot: string, reference: string): Promise<string> {
	const canonicalRoot = await realpath(packRoot);
	const target = await resolvePackReference(canonicalRoot, reference);
	const targetStat = await lstat(target);
	const hash = createHash("sha256");
	if (targetStat.isFile()) {
		hash.update(await readFile(target));
		return `sha256:${hash.digest("hex")}`;
	}
	if (!targetStat.isDirectory()) {
		throw new Error(`Pack reference is not a file or directory: ${JSON.stringify(reference)}`);
	}

	hash.update(TREE_HASH_DOMAIN);
	const activeDirectories = new Set<string>();
	const visit = async (directory: string, logicalPrefix: string): Promise<void> => {
		const canonicalDirectory = await realpath(directory);
		if (!isContained(canonicalRoot, canonicalDirectory)) {
			throw new Error(`Pack tree entry escapes canonical root: ${logicalPrefix}`);
		}
		if (activeDirectories.has(canonicalDirectory)) {
			throw new Error(`Pack tree contains a symlink cycle: ${logicalPrefix}`);
		}
		activeDirectories.add(canonicalDirectory);
		const entries = await readdir(directory, { withFileTypes: true });
		entries.sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)));
		for (const entry of entries) {
			const logicalPath = logicalPrefix === "" ? entry.name : `${logicalPrefix}/${entry.name}`;
			const entryPath = path.join(directory, entry.name);
			const canonicalEntry = await realpath(entryPath);
			if (!isContained(canonicalRoot, canonicalEntry)) {
				throw new Error(`Pack tree entry escapes canonical root: ${logicalPath}`);
			}
			const entryStat = await lstat(canonicalEntry);
			if (entryStat.isDirectory()) {
				hash.update(`d\0${logicalPath}\0`);
				await visit(canonicalEntry, logicalPath);
			} else if (entryStat.isFile()) {
				const content = await readFile(canonicalEntry);
				hash.update(`f\0${logicalPath}\0${content.byteLength}\0`);
				hash.update(content);
				hash.update("\0");
			} else {
				throw new Error(`Pack tree entry is not a file or directory: ${logicalPath}`);
			}
		}
		activeDirectories.delete(canonicalDirectory);
	};
	await visit(target, "");
	return `sha256:${hash.digest("hex")}`;
}

export interface ExpectedProvenanceHashes {
	dataContentHash: string;
	expectedOracleHash: string;
}

export interface ScenarioVariant {
	id: string;
	seed: string | number;
}

export interface SyntheticProvenance extends ExpectedProvenanceHashes {
	synthetic: true;
	generatorId: string;
	generatorVersion: string;
	seed: string | number;
	scenarioVariantId: string;
	rowCount: number;
}

const PROVENANCE_KEYS = [
	"synthetic",
	"generatorId",
	"generatorVersion",
	"seed",
	"scenarioVariantId",
	"rowCount",
	"dataContentHash",
	"expectedOracleHash",
] as const;
const STABLE_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;

/** Runtime equivalent of synthetic-provenance.schema.json for generated output. */
export function assertSyntheticProvenanceSchema(value: unknown): asserts value is SyntheticProvenance {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Generated provenance does not match synthetic-provenance.schema.json");
	}
	const provenance = value as Record<string, unknown>;
	const keys = Object.keys(provenance).sort();
	const expectedKeys = [...PROVENANCE_KEYS].sort();
	if (
		keys.length !== expectedKeys.length
		|| keys.some((key, index) => key !== expectedKeys[index])
		|| provenance.synthetic !== true
		|| typeof provenance.generatorId !== "string"
		|| !STABLE_ID.test(provenance.generatorId)
		|| provenance.generatorId.length > 96
		|| typeof provenance.generatorVersion !== "string"
		|| provenance.generatorVersion.length < 1
		|| provenance.generatorVersion.length > 64
		|| !(
			typeof provenance.seed === "string"
			|| (typeof provenance.seed === "number" && Number.isInteger(provenance.seed))
		)
		|| typeof provenance.scenarioVariantId !== "string"
		|| !STABLE_ID.test(provenance.scenarioVariantId)
		|| provenance.scenarioVariantId.length > 96
		|| typeof provenance.rowCount !== "number"
		|| !Number.isInteger(provenance.rowCount)
		|| provenance.rowCount < 0
		|| typeof provenance.dataContentHash !== "string"
		|| !SHA256.test(provenance.dataContentHash)
		|| typeof provenance.expectedOracleHash !== "string"
		|| !SHA256.test(provenance.expectedOracleHash)
	) {
		throw new Error("Generated provenance does not match synthetic-provenance.schema.json");
	}
}

/** Cross-field checks that JSON Schema cannot express. */
export function verifyProvenanceIdentity(variant: ScenarioVariant, provenance: SyntheticProvenance): void {
	if (variant.id !== provenance.scenarioVariantId || variant.seed !== provenance.seed) {
		throw new Error("Synthetic provenance seed or scenario variant does not match the scenario");
	}
}

export interface PackSemanticContract {
	suites: Array<{ id: string; scenarios: string[] }>;
}

/** Enforce unambiguous suite names and membership after scenarios are loaded. */
export function verifyPackSemantics(pack: PackSemanticContract, loadedScenarioIds: string[]): void {
	assertUnique(loadedScenarioIds, "loaded scenario ID");
	assertUnique(pack.suites.map((suite) => suite.id), "suite ID");
	const knownScenarios = new Set(loadedScenarioIds);
	for (const suite of pack.suites) {
		for (const scenarioId of suite.scenarios) {
			if (!knownScenarios.has(scenarioId)) {
				throw new Error(`Suite ${suite.id} references unknown scenario ID: ${scenarioId}`);
			}
		}
	}
}

export interface ScenarioSemanticContract {
	schemaVersion: string;
	variant: ScenarioVariant;
	provenance: SyntheticProvenance;
	prompts: Array<{ id: string }>;
	assertions: Array<{ id: string }>;
	uiPolicy: {
		dialogs: Array<
			| { request: Record<string, unknown> }
			| { extensionId: string; requestType: string; title: string }
		>;
	};
}

function assertUnique(values: string[], label: string): void {
	const seen = new Set<string>();
	for (const value of values) {
		if (seen.has(value)) {
			throw new Error(`Duplicate ${label}: ${value}`);
		}
		seen.add(value);
	}
}

/** Enforce deterministic identities that JSON Schema cannot express. */
export function verifyScenarioSemantics(scenario: ScenarioSemanticContract): void {
	if (scenario.schemaVersion !== "1.0.0" && scenario.schemaVersion !== "2.0.0") {
		throw new Error(`Unsupported scenario schemaVersion: ${scenario.schemaVersion}`);
	}
	verifyProvenanceIdentity(scenario.variant, scenario.provenance);
	assertUnique(scenario.prompts.map((prompt) => prompt.id), "prompt ID");
	assertUnique(scenario.assertions.map((assertion) => assertion.id), "assertion ID");
	for (let left = 0; left < scenario.uiPolicy.dialogs.length; left++) {
		for (let right = left + 1; right < scenario.uiPolicy.dialogs.length; right++) {
			const leftDialog = scenario.uiPolicy.dialogs[left];
			const rightDialog = scenario.uiPolicy.dialogs[right];
			const duplicate = scenario.schemaVersion === "1.0.0"
				? leftDialog !== undefined
					&& rightDialog !== undefined
					&& "extensionId" in leftDialog
					&& "extensionId" in rightDialog
					&& leftDialog.extensionId === rightDialog.extensionId
					&& leftDialog.requestType === rightDialog.requestType
					&& leftDialog.title === rightDialog.title
				: leftDialog !== undefined
					&& rightDialog !== undefined
					&& "request" in leftDialog
					&& "request" in rightDialog
					&& isDeepStrictEqual(leftDialog.request, rightDialog.request);
			if (duplicate) throw new Error("Duplicate extension UI dialog match");
		}
	}
}

/** Verify materialized model data and hidden oracle against scenario provenance. */
export async function verifyProvenanceHashes(
	packRoot: string,
	workspaceReference: string,
	oracleReference: string,
	expected: ExpectedProvenanceHashes,
): Promise<void> {
	await assertHiddenOracleSeparated(packRoot, workspaceReference, oracleReference);
	const [dataContentHash, expectedOracleHash] = await Promise.all([
		hashPackReference(packRoot, workspaceReference),
		hashPackReference(packRoot, oracleReference),
	]);
	if (dataContentHash !== expected.dataContentHash) {
		throw new Error(`Synthetic data hash mismatch: expected ${expected.dataContentHash}, got ${dataContentHash}`);
	}
	if (expectedOracleHash !== expected.expectedOracleHash) {
		throw new Error(`Expected oracle hash mismatch: expected ${expected.expectedOracleHash}, got ${expectedOracleHash}`);
	}
}

/** Verify fixture materialization, including scenario/provenance cross-field identity. */
export async function verifyScenarioProvenance(
	packRoot: string,
	workspaceReference: string,
	oracleReference: string,
	variant: ScenarioVariant,
	provenance: SyntheticProvenance,
): Promise<void> {
	verifyProvenanceIdentity(variant, provenance);
	await verifyProvenanceHashes(packRoot, workspaceReference, oracleReference, provenance);
}

/**
 * Verify generator-emitted provenance and output channels before prompting.
 * The generated provenance must exactly match the scenario's expected metadata.
 */
export async function verifyGeneratedProvenance(
	outputRoot: string,
	workspaceReference: string,
	questionReference: string,
	oracleReference: string,
	provenanceReference: string,
	variant: ScenarioVariant,
	expectedQuestion: string,
	expected: SyntheticProvenance,
): Promise<void> {
	await Promise.all([
		assertHiddenOracleSeparated(outputRoot, workspaceReference, oracleReference),
		assertHiddenOracleSeparated(outputRoot, workspaceReference, provenanceReference),
		assertHiddenOracleSeparated(outputRoot, oracleReference, provenanceReference),
		assertHiddenOracleSeparated(outputRoot, questionReference, oracleReference),
		assertHiddenOracleSeparated(outputRoot, questionReference, provenanceReference),
	]);
	const [questionPath, provenancePath] = await Promise.all([
		resolvePackReference(outputRoot, questionReference),
		resolvePackReference(outputRoot, provenanceReference),
	]);
	const generatedQuestion = await readFile(questionPath, "utf8");
	if (generatedQuestion !== expectedQuestion) {
		throw new Error("Generated fabricated question does not match the scenario");
	}
	const generated: unknown = JSON.parse(await readFile(provenancePath, "utf8"));
	assertSyntheticProvenanceSchema(generated);
	verifyProvenanceIdentity(variant, expected);
	verifyProvenanceIdentity(variant, generated);
	for (const key of [
		"synthetic",
		"generatorId",
		"generatorVersion",
		"seed",
		"scenarioVariantId",
		"rowCount",
		"dataContentHash",
		"expectedOracleHash",
	] as const) {
		if (generated[key] !== expected[key]) {
			throw new Error(`Generated provenance field does not match scenario: ${key}`);
		}
	}
	await verifyProvenanceHashes(outputRoot, workspaceReference, oracleReference, generated);
}
