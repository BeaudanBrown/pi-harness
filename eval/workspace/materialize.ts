import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import {
	cp,
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	readlink,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import path from "node:path";
import { MAX_EVAL_TIMEOUT_MS } from "../contracts/limits.js";
import {
	assertModelVisibleTreeSeparated,
	assertPackRelativeReference,
	assertSyntheticProvenanceSchema,
	resolvePackReference,
	verifyGeneratedProvenance,
	verifyPackSemantics,
	verifyScenarioProvenance,
	verifyScenarioSemantics,
	type ScenarioSemanticContract,
} from "../contracts/path-policy.js";

export interface WorkspaceInventoryEntry {
	path: string;
	type: "directory" | "file" | "symlink" | "other";
	bytes?: number;
	sha256?: string;
	target?: string;
}

export interface WorkspaceEvidence {
	inventory: WorkspaceInventoryEntry[];
	gitStatus: string;
	gitDiff: string;
	errors?: Record<string, string>;
}

interface FixtureMaterialization {
	fixture: { workspacePath: string; oraclePath: string };
}

interface GeneratorMaterialization {
	generator: {
		path: string;
		args: string[];
		outputs: {
			workspacePath: string;
			questionPath: string;
			oraclePath: string;
			provenancePath: string;
		};
	};
}

export interface MaterializationScenario extends ScenarioSemanticContract {
	id: string;
	version: string;
	synthetic: true;
	fabricatedQuestion: string;
	prompts: Array<{ id: string; text: string; timeoutMs: number }>;
	materialization: FixtureMaterialization | GeneratorMaterialization;
	timeouts: { promptMs: number; runMs: number };
}

export interface EvalPack {
	schemaVersion: "1.0.0";
	id: string;
	version: string;
	syntheticOnly: true;
	scenarios: string[];
	suites: Array<{ id: string; scenarios: string[] }>;
	baselineSummaries?: string[];
}

export interface MaterializeEvalRunOptions {
	packRoot: string;
	packReference: string;
	scenarioId: string;
	runsRoot?: string;
}

export interface MaterializedEvalRun {
	runRoot: string;
	workspaceRoot: string;
	hiddenRoot: string;
	evidenceRoot: string;
	oraclePath: string;
	provenancePath: string;
	scenario: MaterializationScenario;
	before: WorkspaceEvidence;
	initialRevision: string;
	captureAfter(): Promise<WorkspaceEvidence>;
	withWorkspaceEvidence<T>(operation: (workspaceRoot: string) => Promise<T>): Promise<T>;
	cleanup(): Promise<void>;
}

const materializedOraclePaths = new WeakMap<MaterializedEvalRun, string>();

/** Return the immutable oracle identity recorded by the materializer for this run. */
export function oraclePathForMaterializedRun(run: MaterializedEvalRun): string {
	const oraclePath = materializedOraclePaths.get(run);
	if (oraclePath === undefined) throw new Error("Grading requires a materialization-owned evaluation run");
	return oraclePath;
}

export class EvalMaterializationError extends Error {
	constructor(
		message: string,
		readonly runRoot: string,
		readonly evidenceRoot: string,
		readonly workspaceRoot: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "EvalMaterializationError";
	}
}

function isContained(root: string, target: string): boolean {
	const relative = path.relative(root, target);
	return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function readJson<T>(file: string): Promise<T> {
	return JSON.parse(await readFile(file, "utf8")) as T;
}

function objectRecord(value: unknown, label: string): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} must be an object`);
	}
	return value as Record<string, unknown>;
}

function assertExactKeys(value: unknown, allowed: readonly string[], label: string): void {
	const record = objectRecord(value, label);
	for (const key of Object.keys(record)) {
		if (!allowed.includes(key)) throw new Error(`Unsupported ${label} field: ${key}`);
	}
}

const STABLE_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

function assertStableId(value: unknown, label: string): void {
	if (typeof value !== "string" || value.length > 96 || !STABLE_ID.test(value)) {
		throw new Error(`${label} must be a stable ID`);
	}
}

function assertPositiveTimeout(value: unknown, label: string): void {
	if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > MAX_EVAL_TIMEOUT_MS) {
		throw new Error(`${label} must be an integer from 1 through ${MAX_EVAL_TIMEOUT_MS}`);
	}
}

function assertUniqueItems(values: string[], label: string): void {
	if (new Set(values).size !== values.length) throw new Error(`Duplicate ${label}`);
}

function assertPackShape(pack: EvalPack): void {
	assertExactKeys(pack, ["schemaVersion", "id", "version", "syntheticOnly", "scenarios", "suites", "baselineSummaries"], "eval pack");
	assertStableId(pack.id, "Eval pack id");
	if (
		pack.schemaVersion !== "1.0.0"
		|| pack.syntheticOnly !== true
		|| typeof pack.version !== "string"
		|| pack.version.length < 1
		|| pack.version.length > 64
		|| !Array.isArray(pack.scenarios)
		|| pack.scenarios.length < 1
		|| !pack.scenarios.every((reference) => typeof reference === "string")
		|| !Array.isArray(pack.suites)
		|| pack.suites.length < 1
	) {
		throw new Error("Eval pack must be a supported synthetic-only v1 pack");
	}
	assertUniqueItems(pack.scenarios, "eval pack scenario reference");
	for (const reference of pack.scenarios) assertPackRelativeReference(reference);
	for (const suite of pack.suites) {
		assertExactKeys(suite, ["id", "scenarios"], "eval suite");
		assertStableId(suite.id, "Eval suite id");
		if (!Array.isArray(suite.scenarios) || suite.scenarios.length < 1) throw new Error("Eval suite scenarios must be non-empty");
		assertUniqueItems(suite.scenarios, `scenario in eval suite ${suite.id}`);
		for (const id of suite.scenarios) assertStableId(id, "Eval suite scenario id");
	}
	if (pack.baselineSummaries !== undefined && (
		!Array.isArray(pack.baselineSummaries)
		|| !pack.baselineSummaries.every((reference) => typeof reference === "string")
	)) {
		throw new Error("Eval pack baseline summaries must be pack-relative paths");
	}
	assertUniqueItems(pack.baselineSummaries ?? [], "eval pack baseline summary");
	for (const reference of pack.baselineSummaries ?? []) assertPackRelativeReference(reference);
}

function assertScenarioShape(scenario: MaterializationScenario): void {
	assertExactKeys(scenario, [
		"schemaVersion", "id", "version", "synthetic", "variant", "fabricatedQuestion",
		"materialization", "provenance", "prompts", "timeouts", "uiPolicy", "assertions",
	], "scenario");
	if (!["1.0.0", "2.0.0", "3.0.0"].includes(scenario.schemaVersion)) throw new Error("Unsupported scenario schemaVersion");
	assertStableId(scenario.id, "Scenario id");
	if (scenario.synthetic !== true) throw new Error("Scenario must declare synthetic: true");
	if (typeof scenario.version !== "string" || scenario.version.length < 1 || scenario.version.length > 64) throw new Error("Scenario version must be a string");
	if (typeof scenario.fabricatedQuestion !== "string" || scenario.fabricatedQuestion.length < 1 || scenario.fabricatedQuestion.length > 10_000) {
		throw new Error("Scenario fabricatedQuestion must be a non-empty string");
	}
	const variant = objectRecord(scenario.variant, "scenario variant");
	assertExactKeys(variant, ["id", "seed"], "scenario variant");
	assertStableId(variant.id, "Scenario variant id");
	if (!(typeof variant.seed === "string" || (typeof variant.seed === "number" && Number.isInteger(variant.seed)))) {
		throw new Error("Scenario variant seed must be a string or integer");
	}
	assertSyntheticProvenanceSchema(scenario.provenance);
	const timeouts = objectRecord(scenario.timeouts, "scenario timeouts");
	assertExactKeys(timeouts, ["promptMs", "runMs"], "scenario timeouts");
	assertPositiveTimeout(timeouts.promptMs, "Scenario promptMs");
	assertPositiveTimeout(timeouts.runMs, "Scenario runMs");
	if (!Array.isArray(scenario.prompts) || scenario.prompts.length < 1) throw new Error("Scenario prompts must be non-empty");
	for (const promptValue of scenario.prompts as unknown[]) {
		const prompt = objectRecord(promptValue, "scenario prompt");
		assertExactKeys(prompt, ["id", "text", "timeoutMs"], "scenario prompt");
		assertStableId(prompt.id, "Scenario prompt id");
		if (typeof prompt.text !== "string" || prompt.text.length < 1 || prompt.text.length > 100_000) throw new Error("Scenario prompt text is invalid");
		if (prompt.timeoutMs !== undefined) assertPositiveTimeout(prompt.timeoutMs, "Scenario prompt timeoutMs");
	}
	if (!Array.isArray(scenario.assertions) || scenario.assertions.length < 1) throw new Error("Scenario assertions must be non-empty");
	const assertionTypes = new Set(["tool-required", "tool-forbidden", "max-tool-calls", "max-errors", "max-turns", "final-text", "file", "protected-path", "git", "grader-command", "oracle", "ui-policy"]);
	if (scenario.schemaVersion === "3.0.0") {
		assertionTypes.add("stale-tool-forbidden");
		assertionTypes.add("max-blocked-attempts");
	}
	for (const assertionValue of scenario.assertions as unknown[]) {
		const assertion = objectRecord(assertionValue, "scenario assertion");
		assertExactKeys(assertion, ["id", "type", "tool", "maximum", "path", "operator", "expected", "format", "command"], "scenario assertion");
		assertStableId(assertion.id, "Scenario assertion id");
		if (typeof assertion.type !== "string" || !assertionTypes.has(assertion.type)) throw new Error("Scenario assertion type is invalid");
		if (["tool-required", "tool-forbidden", "stale-tool-forbidden"].includes(assertion.type) && (typeof assertion.tool !== "string" || assertion.tool.length < 1)) throw new Error("Tool assertion requires tool");
		if (["max-tool-calls", "max-blocked-attempts", "max-errors", "max-turns"].includes(assertion.type) && (!Number.isInteger(assertion.maximum) || (assertion.maximum as number) < 0)) throw new Error("Limit assertion requires non-negative maximum");
		if (["file", "protected-path", "oracle"].includes(assertion.type)) {
			if (typeof assertion.path !== "string") throw new Error("File assertion requires path");
			assertPackRelativeReference(assertion.path);
		}
		if (["file", "protected-path"].includes(assertion.type)) {
			if (!["exists", "absent", "unchanged", "equals", "contains", "matches"].includes(String(assertion.operator))) throw new Error("File assertion operator is invalid");
			if (["equals", "contains", "matches"].includes(String(assertion.operator)) && typeof assertion.expected !== "string") throw new Error("File assertion comparison requires string expected");
		}
		if (assertion.format !== undefined && !["bytes", "json", "text"].includes(String(assertion.format))) throw new Error("Assertion format is invalid");
		if (assertion.expected !== undefined && assertion.expected !== null && !["string", "number", "boolean"].includes(typeof assertion.expected)) throw new Error("Assertion expected value is invalid");
		if (assertion.type === "grader-command" && (!Array.isArray(assertion.command) || assertion.command.length < 1 || !assertion.command.every((part) => typeof part === "string" && part.length > 0))) throw new Error("Grader assertion requires command");
		if (assertion.type === "final-text" && (typeof assertion.expected !== "string" || !["equals", "contains", "matches"].includes(String(assertion.operator)))) throw new Error("Final-text assertion is invalid");
		if (assertion.type === "git" && !["clean", "dirty"].includes(String(assertion.operator))) throw new Error("Git assertion is invalid");
		if (assertion.type === "oracle" && (assertion.operator !== "equals" || !["bytes", "json", "text"].includes(String(assertion.format)))) throw new Error("Oracle assertion is invalid");
		if (assertion.type === "ui-policy" && (assertion.operator !== "equals" || !Number.isInteger(assertion.expected) || (assertion.expected as number) < 0)) throw new Error("UI assertion is invalid");
	}
	const uiPolicy = objectRecord(scenario.uiPolicy, "scenario UI policy");
	assertExactKeys(uiPolicy, ["defaultAction", "dialogs"], "scenario UI policy");
	if (uiPolicy.defaultAction !== "deny" || !Array.isArray(uiPolicy.dialogs)) throw new Error("Scenario UI policy must default to denial");
	for (const dialogValue of uiPolicy.dialogs) {
		const dialog = objectRecord(dialogValue, "scenario UI dialog");
		if (scenario.schemaVersion === "1.0.0") {
			assertExactKeys(dialog, ["extensionId", "requestType", "title", "response"], "scenario UI dialog");
			assertStableId(dialog.extensionId, "UI extension id");
			if (!["confirm", "select", "input", "editor"].includes(String(dialog.requestType)) || typeof dialog.title !== "string" || dialog.title.length < 1 || dialog.title.length > 500) throw new Error("v1 UI dialog request is invalid");
			const response = objectRecord(dialog.response, "scenario UI response");
			if (response.action === "deny") assertExactKeys(response, ["action"], "scenario UI response");
			else if (response.action === "approve" && ["string", "boolean"].includes(typeof response.value)) assertExactKeys(response, ["action", "value"], "scenario UI response");
			else throw new Error("v1 UI dialog response is invalid");
		} else {
			assertExactKeys(dialog, ["request", "response"], "scenario UI dialog");
			const request = objectRecord(dialog.request, "scenario UI request");
			const method = request.method;
			if (!["confirm", "select", "input", "editor"].includes(String(method)) || typeof request.title !== "string" || request.title.length < 1 || request.title.length > 500) throw new Error("v2 UI dialog request is invalid");
			const allowedRequestKeys = method === "select" ? ["method", "title", "options", "timeout"] : method === "confirm" ? ["method", "title", "message", "timeout"] : method === "input" ? ["method", "title", "placeholder", "timeout"] : ["method", "title", "prefill"];
			assertExactKeys(request, allowedRequestKeys, "scenario UI request");
			if (method === "select" && (!Array.isArray(request.options) || request.options.length < 1 || !request.options.every((option) => typeof option === "string"))) throw new Error("v2 select request requires options");
			if (method === "confirm" && typeof request.message !== "string") throw new Error("v2 confirm request requires message");
			if (request.timeout !== undefined) assertPositiveTimeout(request.timeout, "UI request timeout");
			const response = objectRecord(dialog.response, "scenario UI response");
			if (response.cancelled === true) assertExactKeys(response, ["cancelled"], "scenario UI response");
			else if (method === "confirm" && typeof response.confirmed === "boolean") assertExactKeys(response, ["confirmed"], "scenario UI response");
			else if (method !== "confirm" && typeof response.value === "string") assertExactKeys(response, ["value"], "scenario UI response");
			else throw new Error("v2 UI dialog response is incompatible with request");
		}
	}
	const materialization = objectRecord(scenario.materialization, "scenario materialization");
	assertExactKeys(materialization, ["fixture", "generator"], "scenario materialization");
	if (("fixture" in materialization) === ("generator" in materialization)) {
		throw new Error("Scenario materialization must declare exactly one fixture or generator");
	}
	if ("fixture" in materialization) {
		const fixture = objectRecord(materialization.fixture, "fixture materialization");
		assertExactKeys(fixture, ["workspacePath", "oraclePath"], "fixture materialization");
		if (typeof fixture.workspacePath !== "string" || typeof fixture.oraclePath !== "string") throw new Error("Fixture paths must be strings");
		assertPackRelativeReference(fixture.workspacePath);
		assertPackRelativeReference(fixture.oraclePath);
		return;
	}
	const generator = objectRecord(materialization.generator, "generator materialization");
	assertExactKeys(generator, ["path", "args", "outputs"], "generator materialization");
	if (typeof generator.path !== "string") throw new Error("Generator path must be a string");
	assertPackRelativeReference(generator.path);
	if (!Array.isArray(generator.args) || !generator.args.every((argument) => typeof argument === "string")) throw new Error("Generator args must be strings");
	for (const argument of generator.args) {
		const assignedValue = argument.includes("=") ? argument.slice(argument.indexOf("=") + 1) : argument;
		if (
			argument.includes("\0")
			|| argument.includes("/")
			|| argument.includes("\\")
			|| assignedValue === "."
			|| assignedValue === ".."
			|| /^[A-Za-z][A-Za-z0-9+.-]*:/.test(assignedValue)
		) {
			throw new Error("Generator args cannot contain filesystem paths or URIs");
		}
	}
	const outputs = objectRecord(generator.outputs, "generator outputs");
	assertExactKeys(outputs, ["workspacePath", "questionPath", "oraclePath", "provenancePath"], "generator outputs");
	for (const [channel, reference] of Object.entries(outputs)) {
		if (typeof reference !== "string") throw new Error(`Generator ${channel} must be a string`);
		assertPackRelativeReference(reference);
	}
}

async function runCommand(
	command: string,
	args: string[],
	cwd: string,
	env?: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string }> {
	return await new Promise((resolve, reject) => {
		const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
		child.once("error", reject);
		child.once("close", (code, signal) => {
			const result = {
				stdout: Buffer.concat(stdout).toString("utf8"),
				stderr: Buffer.concat(stderr).toString("utf8"),
			};
			if (code === 0) resolve(result);
			else reject(new Error(`${command} ${args.join(" ")} failed (${signal ?? code}): ${result.stderr.trim()}`));
		});
	});
}

class GeneratorExecutionError extends Error {
	constructor(message: string, readonly diagnostics: { stdout: string; stderr: string; exitCode: number | null; signal: NodeJS.Signals | null }) {
		super(message);
		this.name = "GeneratorExecutionError";
	}
}

function sandboxProfilePath(value: string): string {
	return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function trustedBubblewrapExecutable(): string {
	const candidates = [
		process.env.PI_EVAL_BWRAP,
		...(process.env.PATH ?? "").split(path.delimiter).map((directory) => path.join(directory, "bwrap")),
	].filter((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0);
	for (const candidate of candidates) {
		if (!existsSync(candidate)) continue;
		const canonical = realpathSync(candidate);
		if (/^\/nix\/store\/[a-z0-9]{32}-bubblewrap-[^/]+\/bin\/bwrap$/.test(canonical)) return canonical;
	}
	throw new Error("A trusted Nix-store Bubblewrap executable is required for synthetic generators");
}

export interface ConfinedWorkspaceCommandResult {
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

function confinedWorkspaceCommand(
	workspaceRoot: string,
	command: string[],
): { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv } {
	if (command.length === 0 || command.some((part) => typeof part !== "string" || part.length === 0)) {
		throw new Error("Confined workspace command must contain non-empty strings");
	}
	if (process.platform === "linux") {
		return {
			command: trustedBubblewrapExecutable(),
			// Bubblewrap builds a fresh tmpfs root; only these explicit binds are visible.
			args: [
				"--die-with-parent", "--unshare-all", "--new-session",
				"--ro-bind", "/nix/store", "/nix/store",
				"--dir", "/usr", "--dir", "/usr/bin", "--ro-bind", "/usr/bin/env", "/usr/bin/env",
				"--ro-bind", workspaceRoot, "/workspace",
				"--tmpfs", "/tmp", "--proc", "/proc", "--dev", "/dev",
				"--chdir", "/workspace",
				"--setenv", "PATH", process.env.PATH ?? "",
				"--", ...command,
			],
			cwd: workspaceRoot,
			env: { PATH: process.env.PATH ?? "" },
		};
	}
	if (process.platform === "darwin") {
		const profile = [
			"(version 1)",
			"(deny default)",
			"(allow process-exec)",
			`(allow file-read* (subpath \"${sandboxProfilePath(workspaceRoot)}\") (subpath \"/nix/store\") (subpath \"/System/Library\") (subpath \"/usr/lib\") (literal \"/usr/bin/env\"))`,
		].join(" ");
		return {
			command: "/usr/bin/sandbox-exec",
			args: ["-p", profile, ...command],
			cwd: workspaceRoot,
			env: { PATH: process.env.PATH ?? "" },
		};
	}
	throw new Error(`Confined workspace commands are unsupported on platform: ${process.platform}`);
}

/** Run a bounded read-only command with no host filesystem or network access. */
export async function runConfinedWorkspaceCommand(
	workspaceRoot: string,
	command: string[],
	timeoutMs = 30_000,
): Promise<ConfinedWorkspaceCommandResult> {
	const sandbox = confinedWorkspaceCommand(await realpath(workspaceRoot), command);
	return await new Promise((resolve, reject) => {
		const child = spawn(sandbox.command, sandbox.args, {
			cwd: sandbox.cwd,
			detached: true,
			env: sandbox.env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		child.stdout.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
		child.stderr.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
		let timedOut = false;
		let killTimer: NodeJS.Timeout | undefined;
		const timer = setTimeout(() => {
			timedOut = true;
			if (child.pid !== undefined) {
				try { process.kill(-child.pid, "SIGTERM"); } catch {}
				killTimer = setTimeout(() => {
					try { process.kill(-child.pid!, "SIGKILL"); } catch {}
				}, 250);
				killTimer.unref();
			}
		}, timeoutMs);
		child.once("error", (error) => {
			clearTimeout(timer);
			if (killTimer) clearTimeout(killTimer);
			reject(error);
		});
		child.once("close", (exitCode, signal) => {
			clearTimeout(timer);
			if (killTimer) clearTimeout(killTimer);
			resolve({
				exitCode,
				signal,
				stdout: Buffer.concat(stdout).toString("utf8"),
				stderr: Buffer.concat(stderr).toString("utf8"),
				timedOut,
			});
		});
	});
}

function generatorSandboxCommand(
	executable: string,
	args: string[],
	packRoot: string,
	outputRoot: string,
	seed: string | number,
): { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv } {
	const generatorRelativePath = path.relative(packRoot, executable).split(path.sep).join("/");
	if (process.platform === "linux") {
		return {
			command: trustedBubblewrapExecutable(),
			args: [
				"--die-with-parent", "--unshare-all", "--new-session",
				"--ro-bind", "/nix/store", "/nix/store",
				"--dir", "/usr", "--dir", "/usr/bin", "--ro-bind", "/usr/bin/env", "/usr/bin/env",
				"--ro-bind", packRoot, "/pack",
				"--bind", outputRoot, "/output",
				"--tmpfs", "/tmp", "--proc", "/proc", "--dev", "/dev",
				"--chdir", "/pack",
				"--setenv", "PATH", process.env.PATH ?? "",
				"--setenv", "PI_EVAL_OUTPUT_ROOT", "/output",
				"--setenv", "PI_EVAL_SEED", String(seed),
				"--", `/pack/${generatorRelativePath}`, ...args,
			],
			cwd: packRoot,
			env: { PATH: process.env.PATH ?? "" },
		};
	}
	if (process.platform === "darwin") {
		const profile = [
			"(version 1)",
			"(deny default)",
			"(allow process-exec)",
			"(allow process-fork)",
			`(allow file-read* (subpath \"${sandboxProfilePath(packRoot)}\") (subpath \"/nix/store\") (subpath \"/System/Library\") (subpath \"/usr/lib\") (literal \"/usr/bin/env\"))`,
			`(allow file-write* (subpath \"${sandboxProfilePath(outputRoot)}\"))`,
		].join(" ");
		return {
			command: "/usr/bin/sandbox-exec",
			args: ["-p", profile, executable, ...args],
			cwd: packRoot,
			env: {
				PATH: process.env.PATH ?? "",
				PI_EVAL_OUTPUT_ROOT: outputRoot,
				PI_EVAL_SEED: String(seed),
			},
		};
	}
	throw new Error(`Synthetic generators are unsupported on platform: ${process.platform}`);
}

async function runGenerator(
	executable: string,
	args: string[],
	packRoot: string,
	outputRoot: string,
	seed: string | number,
	timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
	return await new Promise((resolve, reject) => {
		const sandbox = generatorSandboxCommand(executable, args, packRoot, outputRoot, seed);
		const child = spawn(sandbox.command, sandbox.args, {
			cwd: sandbox.cwd,
			detached: true,
			env: sandbox.env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
		let settled = false;
		const terminate = () => {
			if (child.pid === undefined) return;
			try { process.kill(-child.pid, "SIGTERM"); } catch {}
			setTimeout(() => {
				try { process.kill(-child.pid!, "SIGKILL"); } catch {}
			}, 250).unref();
		};
		const diagnostics = (exitCode: number | null, signal: NodeJS.Signals | null) => ({
			stdout: Buffer.concat(stdout).toString("utf8"),
			stderr: Buffer.concat(stderr).toString("utf8"),
			exitCode,
			signal,
		});
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			terminate();
			reject(new GeneratorExecutionError(
				`Synthetic generator exceeded ${timeoutMs}ms deadline`,
				diagnostics(null, null),
			));
		}, timeoutMs);
		child.once("error", (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(new GeneratorExecutionError(error.message, diagnostics(null, null)));
		});
		child.once("close", (code, signal) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			const result = diagnostics(code, signal);
			if (code === 0) resolve({ stdout: result.stdout, stderr: result.stderr });
			else {
				terminate();
				reject(new GeneratorExecutionError(
					`Synthetic generator failed (${signal ?? code}): ${result.stderr.trim()}`,
					result,
				));
			}
		});
	});
}

async function inventoryWorkspace(root: string): Promise<WorkspaceInventoryEntry[]> {
	const entries: WorkspaceInventoryEntry[] = [];
	const visit = async (directory: string, prefix: string): Promise<void> => {
		const children = await readdir(directory, { withFileTypes: true });
		children.sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)));
		for (const child of children) {
			if (prefix === "" && child.name === ".git") continue;
			const relative = prefix === "" ? child.name : `${prefix}/${child.name}`;
			const absolute = path.join(directory, child.name);
			const stat = await lstat(absolute);
			if (stat.isSymbolicLink()) {
				entries.push({ path: relative, type: "symlink", target: await readlink(absolute) });
			} else if (stat.isDirectory()) {
				entries.push({ path: relative, type: "directory" });
				await visit(absolute, relative);
			} else if (stat.isFile()) {
				const content = await readFile(absolute);
				entries.push({
					path: relative,
					type: "file",
					bytes: content.byteLength,
					sha256: createHash("sha256").update(content).digest("hex"),
				});
			} else {
				entries.push({ path: relative, type: "other" });
			}
		}
	};
	await visit(root, "");
	return entries;
}

function isolatedGitEnvironment(): NodeJS.ProcessEnv {
	return {
		PATH: process.env.PATH ?? "",
		LC_ALL: "C",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_TERMINAL_PROMPT: "0",
	};
}

async function captureWorkspace(root: string): Promise<WorkspaceEvidence> {
	let inventory: WorkspaceInventoryEntry[] = [];
	let gitStatus = "";
	let gitDiff = "";
	const errors: Record<string, string> = {};
	try { inventory = await inventoryWorkspace(root); } catch (error) { errors.inventory = String(error); }
	try {
		gitStatus = (await runCommand("git", ["status", "--porcelain=v1", "--untracked-files=all"], root, isolatedGitEnvironment())).stdout.trimEnd();
	} catch (error) { errors.gitStatus = String(error); }
	try {
		gitDiff = (await runCommand("git", ["diff", "--binary", "HEAD", "--"], root, isolatedGitEnvironment())).stdout;
	} catch (error) { errors.gitDiff = String(error); }
	return {
		inventory,
		gitStatus,
		gitDiff,
		...(Object.keys(errors).length === 0 ? {} : { errors }),
	};
}

async function copyWorkspaceMaterial(source: string, workspaceRoot: string): Promise<void> {
	const stat = await lstat(source);
	if (stat.isFile()) {
		if (path.basename(source) === ".git") throw new Error("Workspace material cannot contain .git metadata");
		await cp(source, path.join(workspaceRoot, path.basename(source)), { errorOnExist: true });
		return;
	}
	if (!stat.isDirectory()) throw new Error("Workspace material must be a file or directory");
	for (const entry of await readdir(source)) {
		if (entry === ".git") throw new Error("Workspace material cannot contain .git metadata");
		await cp(path.join(source, entry), path.join(workspaceRoot, entry), {
			recursive: true,
			dereference: true,
			errorOnExist: true,
		});
	}
}

async function initializeGit(workspaceRoot: string, templateRoot: string): Promise<string> {
	await mkdir(templateRoot);
	const env = isolatedGitEnvironment();
	await runCommand("git", ["init", "--quiet", `--template=${templateRoot}`], workspaceRoot, env);
	await runCommand("git", ["config", "user.name", "Pi Synthetic Eval"], workspaceRoot, env);
	await runCommand("git", ["config", "user.email", "synthetic-eval@example.invalid"], workspaceRoot, env);
	await runCommand("git", ["add", "--all"], workspaceRoot, env);
	await runCommand("git", [
		"-c", "core.hooksPath=/dev/null", "commit", "--quiet", "--no-verify", "--allow-empty",
		"-m", "Initial synthetic workspace",
	], workspaceRoot, env);
	return (await runCommand("git", ["rev-parse", "HEAD"], workspaceRoot, env)).stdout.trim();
}

async function retainFailure(evidenceRoot: string, error: unknown): Promise<void> {
	await mkdir(evidenceRoot, { recursive: true });
	await writeFile(path.join(evidenceRoot, "materialization-error.json"), `${JSON.stringify({
		message: error instanceof Error ? error.message : String(error),
	}, null, 2)}\n`);
}

export interface LoadedEvalPack {
	canonicalPackRoot: string;
	pack: EvalPack;
	scenarios: MaterializationScenario[];
}

/** Load and semantically validate a wholly synthetic pack without materializing a run. */
export async function loadEvalPack(packRoot: string, packReference: string): Promise<LoadedEvalPack> {
	const canonicalPackRoot = await realpath(packRoot);
	const packPath = await resolvePackReference(canonicalPackRoot, packReference);
	const pack = await readJson<EvalPack>(packPath);
	assertPackShape(pack);
	for (const baseline of pack.baselineSummaries ?? []) await resolvePackReference(canonicalPackRoot, baseline);
	const scenarios = await Promise.all(pack.scenarios.map(async (reference) => {
		const scenarioPath = await resolvePackReference(canonicalPackRoot, reference);
		return await readJson<MaterializationScenario>(scenarioPath);
	}));
	verifyPackSemantics(pack, scenarios.map((scenario) => scenario.id));
	for (const scenario of scenarios) {
		assertScenarioShape(scenario);
		verifyScenarioSemantics(scenario);
		if ("fixture" in scenario.materialization) {
			await assertModelVisibleTreeSeparated(
				canonicalPackRoot,
				scenario.materialization.fixture.workspacePath,
				[scenario.materialization.fixture.oraclePath],
			);
		} else {
			await resolvePackReference(canonicalPackRoot, scenario.materialization.generator.path);
			for (const reference of Object.values(scenario.materialization.generator.outputs)) assertPackRelativeReference(reference);
		}
	}
	return { canonicalPackRoot, pack, scenarios };
}

/** Materialize one declared synthetic scenario into an evaluator-owned Git run. */
export async function materializeEvalRun(options: MaterializeEvalRunOptions): Promise<MaterializedEvalRun> {
	const runsRoot = path.resolve(options.runsRoot ?? path.join(".pi", "tmp", "evals"));
	await mkdir(runsRoot, { recursive: true });
	const runRoot = await mkdtemp(path.join(runsRoot, "run-"));
	const workspaceRoot = await mkdtemp(path.join(runsRoot, "workspace-"));
	const hiddenRoot = path.join(runRoot, "hidden");
	const evidenceRoot = path.join(runRoot, "evidence");
	await Promise.all([mkdir(hiddenRoot), mkdir(evidenceRoot)]);

	try {
		const [{ canonicalPackRoot, scenarios }, canonicalRunsRoot] = await Promise.all([
			loadEvalPack(options.packRoot, options.packReference),
			realpath(runsRoot),
		]);
		if (isContained(canonicalPackRoot, canonicalRunsRoot) || isContained(canonicalRunsRoot, canonicalPackRoot)) {
			throw new Error("Evaluator run root must be separate from the synthetic pack root");
		}
		const scenario = scenarios.find((candidate) => candidate.id === options.scenarioId);
		if (!scenario) throw new Error(`Unknown scenario ID: ${options.scenarioId}`);
		assertScenarioShape(scenario);
		verifyScenarioSemantics(scenario);

		let workspaceSource: string;
		let oracleSource: string;
		let generatedProvenanceSource: string | undefined;
		if ("fixture" in scenario.materialization) {
			const { workspacePath, oraclePath } = scenario.materialization.fixture;
			await verifyScenarioProvenance(canonicalPackRoot, workspacePath, oraclePath, scenario.variant, scenario.provenance);
			[workspaceSource, oracleSource] = await Promise.all([
				resolvePackReference(canonicalPackRoot, workspacePath),
				resolvePackReference(canonicalPackRoot, oraclePath),
			]);
		} else {
			const declaration = scenario.materialization.generator;
			const executable = await resolvePackReference(canonicalPackRoot, declaration.path);
			const outputRoot = path.join(runRoot, "generated");
			await mkdir(outputRoot);
			let generatorLog: { stdout: string; stderr: string };
			try {
				generatorLog = await runGenerator(
					executable,
					declaration.args,
					canonicalPackRoot,
					outputRoot,
					scenario.variant.seed,
					scenario.timeouts.runMs,
				);
			} catch (error) {
				if (error instanceof GeneratorExecutionError) {
					await writeFile(path.join(evidenceRoot, "generator.json"), `${JSON.stringify({
						...error.diagnostics,
						error: error.message,
					}, null, 2)}\n`);
				}
				throw error;
			}
			await writeFile(path.join(evidenceRoot, "generator.json"), `${JSON.stringify(generatorLog, null, 2)}\n`);
			await verifyGeneratedProvenance(
				outputRoot,
				declaration.outputs.workspacePath,
				declaration.outputs.questionPath,
				declaration.outputs.oraclePath,
				declaration.outputs.provenancePath,
				scenario.variant,
				scenario.fabricatedQuestion,
				scenario.provenance,
			);
			[workspaceSource, oracleSource, generatedProvenanceSource] = await Promise.all([
				resolvePackReference(outputRoot, declaration.outputs.workspacePath),
				resolvePackReference(outputRoot, declaration.outputs.oraclePath),
				resolvePackReference(outputRoot, declaration.outputs.provenancePath),
			]);
		}
		await copyWorkspaceMaterial(workspaceSource, workspaceRoot);
		const oracleChannelRoot = path.join(hiddenRoot, "oracle");
		const provenanceChannelRoot = path.join(hiddenRoot, "provenance");
		await Promise.all([mkdir(oracleChannelRoot), mkdir(provenanceChannelRoot)]);
		const oracleDestination = path.join(oracleChannelRoot, path.basename(oracleSource));
		await cp(oracleSource, oracleDestination, { recursive: true, dereference: true, errorOnExist: true });
		const provenancePath = path.join(provenanceChannelRoot, "manifest.json");
		if (generatedProvenanceSource) {
			await cp(generatedProvenanceSource, provenancePath, { errorOnExist: true });
		} else {
			await writeFile(provenancePath, `${JSON.stringify(scenario.provenance, null, 2)}\n`);
		}
		const initialRevision = await initializeGit(workspaceRoot, path.join(hiddenRoot, "git-template"));
		const before = await captureWorkspace(workspaceRoot);
		await writeFile(path.join(evidenceRoot, "before.json"), `${JSON.stringify(before, null, 2)}\n`);

		const captureAfter = async (): Promise<WorkspaceEvidence> => {
			try {
				const after = await captureWorkspace(workspaceRoot);
				await writeFile(path.join(evidenceRoot, "after.json"), `${JSON.stringify(after, null, 2)}\n`);
				return after;
			} catch (error) {
				await retainFailure(evidenceRoot, error);
				throw new EvalMaterializationError("Failed to capture workspace after-state", runRoot, evidenceRoot, workspaceRoot, { cause: error });
			}
		};
		const materializedRun: MaterializedEvalRun = {
			runRoot,
			workspaceRoot,
			hiddenRoot,
			evidenceRoot,
			oraclePath: oracleDestination,
			provenancePath,
			scenario,
			before,
			initialRevision,
			captureAfter,
			async withWorkspaceEvidence<T>(operation: (root: string) => Promise<T>): Promise<T> {
				let operationFailure: unknown;
				try {
					return await operation(workspaceRoot);
				} catch (error) {
					operationFailure = error;
					throw error;
				} finally {
					try {
						await captureAfter();
					} catch (captureError) {
						if (operationFailure !== undefined) {
							throw new AggregateError(
								[operationFailure, captureError],
								"Workspace execution and after-state capture both failed",
							);
						}
						throw captureError;
					}
				}
			},
			async cleanup() {
				await Promise.all([
					rm(runRoot, { recursive: true, force: true }),
					rm(workspaceRoot, { recursive: true, force: true }),
				]);
			},
		};
		materializedOraclePaths.set(materializedRun, oracleDestination);
		return materializedRun;
	} catch (error) {
		await retainFailure(evidenceRoot, error);
		throw new EvalMaterializationError("Synthetic workspace materialization failed", runRoot, evidenceRoot, workspaceRoot, { cause: error });
	}
}
