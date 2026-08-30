import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { executeCaptureAndGradeScenario, type EvalAssertion } from "../grading/grade.js";
import { launchVerifiedEval, type EvalLauncherExpectedIdentity } from "../launcher/launch.js";
import type { RpcUiDialogPolicy } from "../rpc/engine.js";
import { loadEvalPack, materializeEvalRun, type MaterializationScenario } from "../workspace/materialize.js";

export interface EvalCliRuntimeConfig {
	identityManifestPath: string;
	expected: Omit<EvalLauncherExpectedIdentity, "activeModel" | "projectRevision" | "projectDirty">;
}

export interface EvalCliIo {
	stdout(value: string): void;
	stderr(value: string): void;
}

interface ParsedCommand {
	command: "list" | "run" | "suite" | "report" | "help";
	options: Map<string, string | true>;
}

interface EvalRunSummary {
	schemaVersion: "1.0.0";
	scenarioId: string;
	status: "passed" | "failed" | "infrastructure-error";
	evidenceRoot: string;
	workspaceRoot?: string;
	failure?: string;
}

const FLAG_OPTIONS = new Set(["live-model", "json"]);
const VALUE_OPTIONS = new Set(["pack", "scenario", "suite", "output", "model"]);

function stable(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stable);
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => Buffer.from(left).compare(Buffer.from(right)))
			.map(([key, child]) => [key, stable(child)]));
	}
	return value;
}

function stableJson(value: unknown): string {
	return `${JSON.stringify(stable(value), null, 2)}\n`;
}

function parse(argv: string[]): ParsedCommand {
	if (argv.length === 0 || argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h") return { command: "help", options: new Map() };
	const command = argv[0];
	if (!["list", "run", "suite", "report"].includes(command)) throw new Error(`Unknown eval command: ${command}`);
	const options = new Map<string, string | true>();
	for (let index = 1; index < argv.length; index += 1) {
		const argument = argv[index]!;
		if (!argument.startsWith("--")) throw new Error(`Unexpected positional argument: ${argument}`);
		const key = argument.slice(2);
		if (options.has(key)) throw new Error(`Duplicate option: --${key}`);
		if (FLAG_OPTIONS.has(key)) options.set(key, true);
		else if (VALUE_OPTIONS.has(key)) {
			const value = argv[++index];
			if (value === undefined || value.startsWith("--")) throw new Error(`Option --${key} requires a value`);
			options.set(key, value);
		} else throw new Error(`Unknown option: --${key}`);
	}
	return { command: command as ParsedCommand["command"], options };
}

function required(options: Map<string, string | true>, key: string): string {
	const value = options.get(key);
	if (typeof value !== "string" || value.length === 0) throw new Error(`Option --${key} is required`);
	return value;
}

function packLocation(packFile: string): { packRoot: string; packReference: string; packPath: string } {
	const packPath = path.resolve(packFile);
	return { packRoot: path.dirname(packPath), packReference: path.basename(packPath), packPath };
}

function compare(left: string, right: string): number {
	return Buffer.from(left).compare(Buffer.from(right));
}

function pathsOverlap(left: string, right: string): boolean {
	const relative = path.relative(left, right);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function assertOutputSeparated(packFile: string, output: string): Promise<void> {
	const packRoot = path.dirname(path.resolve(packFile));
	const resolvedOutput = path.resolve(output);
	if (pathsOverlap(packRoot, resolvedOutput) || pathsOverlap(resolvedOutput, packRoot)) {
		throw new Error("Evaluation output must be separate from the pack root");
	}
	await mkdir(path.dirname(resolvedOutput), { recursive: true });
	const [canonicalPackRoot, canonicalOutputParent] = await Promise.all([realpath(packRoot), realpath(path.dirname(resolvedOutput))]);
	let canonicalOutput = path.join(canonicalOutputParent, path.basename(resolvedOutput));
	try {
		const outputEntry = await lstat(resolvedOutput);
		if (outputEntry.isSymbolicLink()) throw new Error("Evaluation output must not be a symbolic link");
		if (!outputEntry.isDirectory()) throw new Error("Evaluation output must be a directory");
		canonicalOutput = await realpath(resolvedOutput);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	if (pathsOverlap(canonicalPackRoot, canonicalOutput) || pathsOverlap(canonicalOutput, canonicalPackRoot)) {
		throw new Error("Evaluation output must be canonically separate from the pack root");
	}
}

function parseModel(value: string): { provider: string; id: string } {
	const slash = value.indexOf("/");
	if (slash <= 0 || slash === value.length - 1) throw new Error("Option --model must be provider/model-id");
	return { provider: value.slice(0, slash), id: value.slice(slash + 1) };
}

function tracePolicy(scenario: MaterializationScenario) {
	const assertions = scenario.assertions as unknown as EvalAssertion[];
	return {
		requiredTools: assertions.filter((item) => item.type === "tool-required").map((item) => (item as { tool: string }).tool),
		forbiddenTools: assertions.filter((item) => item.type === "tool-forbidden").map((item) => (item as { tool: string }).tool),
		staleToolNames: assertions.filter((item) => item.type === "stale-tool-forbidden").map((item) => (item as { tool: string }).tool),
		protectedPaths: assertions.filter((item) => item.type === "protected-path").map((item) => (item as { path: string }).path),
		declaredUiRequests: scenario.uiPolicy.dialogs.flatMap((dialog) => "request" in dialog ? [dialog.request] : []),
	};
}

function rpcUiPolicy(scenario: MaterializationScenario) {
	if (scenario.schemaVersion === "1.0.0") throw new Error("Live evaluation requires scenario schema v2 or v3 observable UI policy");
	return {
		schemaVersion: scenario.schemaVersion as "2.0.0" | "3.0.0",
		dialogs: scenario.uiPolicy.dialogs as unknown as RpcUiDialogPolicy[],
	};
}

async function writeCliFailure(output: string, command: string, failure: string): Promise<void> {
	await mkdir(output, { recursive: true });
	await writeFile(path.join(output, "cli-error.json"), stableJson({
		schemaVersion: "1.0.0",
		status: "infrastructure-error",
		command,
		message: "Evaluation CLI failed; inspect retained run evidence",
		failure,
	}), { mode: 0o600 });
}

export function redactEvalCliMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message
		.replace(/(authorization|proxy-authorization|x-api-key|cookie|set-cookie)(\s*[:=]\s*)[^,;\n]+/gi, "$1$2<redacted>")
		.replace(/(bearer|basic)\s+[^\s,;]+/gi, "$1 <redacted>")
		.replace(/(api[-_]?key|token|password|secret|credential)(\s*[:=]\s*)[^\s,;]+/gi, "$1$2<redacted>");
}

async function assertReportOutput(output: string): Promise<void> {
	const entry = await lstat(output);
	if (entry.isSymbolicLink()) throw new Error("Report output must not be a symbolic link");
	if (!entry.isDirectory()) throw new Error("Report output must be a directory");
}

async function runScenario(
	packFile: string,
	scenarioId: string,
	output: string,
	model: { provider: string; id: string },
	runtime: EvalCliRuntimeConfig,
): Promise<EvalRunSummary> {
	await assertOutputSeparated(packFile, output);
	await mkdir(output, { recursive: true });
	let evidenceRoot = output;
	try {
		const location = packLocation(packFile);
		const workspace = await materializeEvalRun({
			packRoot: location.packRoot,
			packReference: location.packReference,
			scenarioId,
			runsRoot: path.join(output, "materialized"),
		});
		evidenceRoot = workspace.evidenceRoot;
		const launched = await launchVerifiedEval({
			identityManifestPath: runtime.identityManifestPath,
			projectRoot: workspace.workspaceRoot,
			artifactRoot: evidenceRoot,
			expected: {
				...runtime.expected,
				activeModel: model,
				projectRevision: workspace.initialRevision,
				projectDirty: false,
			},
			args: ["--model", `${model.provider}/${model.id}`],
			concurrency: 1,
			rpc: {
				promptTimeoutMs: workspace.scenario.timeouts.promptMs,
				runTimeoutMs: workspace.scenario.timeouts.runMs,
				uiPolicy: rpcUiPolicy(workspace.scenario),
			},
		});
		try {
			const result = await executeCaptureAndGradeScenario({
				artifactRoot: evidenceRoot,
				startedAtMs: Date.now(),
				engine: launched.engine,
				workspace,
				policy: tracePolicy(workspace.scenario),
				execute: async () => {
					let finalResult;
					for (const prompt of workspace.scenario.prompts) finalResult = await launched.engine.promptAndWait(prompt.text, undefined, prompt.timeoutMs);
					if (!finalResult) throw new Error("Scenario has no executable prompts");
					return finalResult;
				},
			});
			const summary: EvalRunSummary = {
				schemaVersion: "1.0.0",
				scenarioId,
				status: result.grade.passed ? "passed" : "failed",
				evidenceRoot,
				workspaceRoot: workspace.workspaceRoot,
			};
			await writeFile(path.join(output, "eval-run.json"), stableJson(summary));
			return summary;
		} finally {
			await launched.stop();
		}
	} catch (error) {
		const summary: EvalRunSummary = {
			schemaVersion: "1.0.0",
			scenarioId,
			status: "infrastructure-error",
			evidenceRoot,
			failure: redactEvalCliMessage(error),
		};
		await writeFile(path.join(output, "eval-run.json"), stableJson(summary));
		await writeCliFailure(output, "run", summary.failure ?? "Unknown infrastructure failure");
		return summary;
	}
}

function parseRunSummary(value: unknown, source: string): EvalRunSummary {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid run summary: ${source}`);
	const run = value as Record<string, unknown>;
	if (run.schemaVersion !== "1.0.0"
		|| typeof run.scenarioId !== "string" || run.scenarioId.length === 0
		|| !["passed", "failed", "infrastructure-error"].includes(String(run.status))
		|| typeof run.evidenceRoot !== "string" || run.evidenceRoot.length === 0) {
		throw new Error(`Invalid run summary: ${source}`);
	}
	return run as unknown as EvalRunSummary;
}

async function findRunSummaries(root: string): Promise<EvalRunSummary[]> {
	const summaries: EvalRunSummary[] = [];
	const visit = async (directory: string): Promise<void> => {
		const entries = await readdir(directory, { withFileTypes: true });
		entries.sort((left, right) => compare(left.name, right.name));
		const summaryEntry = entries.find((entry) => entry.name === "eval-run.json");
		if (summaryEntry) {
			if (!summaryEntry.isFile() || summaryEntry.isSymbolicLink()) throw new Error(`Invalid run summary entry: ${path.join(directory, summaryEntry.name)}`);
			const target = path.join(directory, summaryEntry.name);
			const stat = await lstat(target);
			if (stat.size > 1_000_000) throw new Error(`Run summary exceeds size limit: ${target}`);
			summaries.push(parseRunSummary(JSON.parse(await readFile(target, "utf8")), target));
			return;
		}
		for (const entry of entries) {
			const target = path.join(directory, entry.name);
			if (entry.isSymbolicLink()) throw new Error(`Report input contains symbolic link: ${target}`);
			if (entry.isDirectory()) await visit(target);
		}
	};
	await visit(root);
	return summaries.sort((left, right) => compare(left.scenarioId, right.scenarioId) || compare(left.evidenceRoot, right.evidenceRoot));
}

async function writeReport(output: string) {
	const runs = await findRunSummaries(output);
	const totals = {
		runs: runs.length,
		passed: runs.filter((run) => run.status === "passed").length,
		failed: runs.filter((run) => run.status === "failed").length,
		infrastructureErrors: runs.filter((run) => run.status === "infrastructure-error").length,
	};
	const report = { schemaVersion: "1.0.0", totals, runs };
	await writeFile(path.join(output, "report.json"), stableJson(report));
	const markdownCell = (value: string) => value.replaceAll("|", "\\|").replaceAll("\r", " ").replaceAll("\n", " ");
	const rows = runs.map((run) => `| ${markdownCell(run.scenarioId)} | ${run.status} | ${markdownCell(run.evidenceRoot)} |`);
	await writeFile(path.join(output, "report.md"), [
		"# Synthetic evaluation report", "", `Runs: ${totals.runs}; passed: ${totals.passed}; failed: ${totals.failed}; infrastructure errors: ${totals.infrastructureErrors}.`, "",
		"| Scenario | Status | Evidence |", "| --- | --- | --- |", ...rows, "",
	].join("\n"));
	return report;
}

const HELP = `Usage: pi-eval <command> [options]\n\nCommands:\n  list   --pack PACK [--json]\n  run    --live-model --pack PACK --scenario ID --output DIR --model PROVIDER/ID\n  suite  --live-model --pack PACK --suite ID --output DIR --model PROVIDER/ID\n  report --output DIR\n`;

export async function runEvalCli(argv: string[], runtime: EvalCliRuntimeConfig, io: EvalCliIo): Promise<number> {
	let parsed: ParsedCommand | undefined;
	let failureOutput: string | undefined;
	try {
		parsed = parse(argv);
		if (parsed.command === "help") {
			io.stdout(HELP);
			return 0;
		}
		if (parsed.command === "list") {
			const location = packLocation(required(parsed.options, "pack"));
			const loaded = await loadEvalPack(location.packRoot, location.packReference);
			const result = {
				pack: { id: loaded.pack.id, version: loaded.pack.version, syntheticOnly: loaded.pack.syntheticOnly },
				scenarios: loaded.scenarios.map((scenario) => ({ id: scenario.id, version: scenario.version })).sort((a, b) => compare(a.id, b.id)),
				suites: loaded.pack.suites.map((suite) => ({ id: suite.id, scenarios: [...suite.scenarios] })).sort((a, b) => compare(a.id, b.id)),
			};
			if (parsed.options.has("json")) io.stdout(stableJson(result));
			else io.stdout([`Pack: ${result.pack.id} (${result.pack.version})`, ...result.scenarios.map((scenario) => `Scenario: ${scenario.id} (${scenario.version})`), ...result.suites.map((suite) => `Suite: ${suite.id} [${suite.scenarios.join(", ")}]`), ""].join("\n"));
			return 0;
		}
		if (parsed.command === "report") {
			const reportOutput = path.resolve(required(parsed.options, "output"));
			await assertReportOutput(reportOutput);
			failureOutput = reportOutput;
			const report = await writeReport(reportOutput);
			io.stdout(stableJson(report.totals));
			return report.totals.infrastructureErrors > 0 ? 1 : report.totals.failed > 0 ? 2 : 0;
		}
		if (!parsed.options.has("live-model")) throw new Error(`${parsed.command} requires explicit --live-model opt-in`);
		const packFile = required(parsed.options, "pack");
		const output = path.resolve(required(parsed.options, "output"));
		await assertOutputSeparated(packFile, output);
		failureOutput = output;
		const model = parseModel(required(parsed.options, "model"));
		if (parsed.command === "run") {
			const summary = await runScenario(packFile, required(parsed.options, "scenario"), output, model, runtime);
			io.stdout(stableJson(summary));
			return summary.status === "passed" ? 0 : summary.status === "failed" ? 2 : 1;
		}
		const suiteId = required(parsed.options, "suite");
		const location = packLocation(packFile);
		const loaded = await loadEvalPack(location.packRoot, location.packReference);
		const suite = loaded.pack.suites.find((candidate) => candidate.id === suiteId);
		if (!suite) throw new Error(`Unknown suite ID: ${suiteId}`);
		const summaries: EvalRunSummary[] = [];
		for (const scenarioId of suite.scenarios) summaries.push(await runScenario(packFile, scenarioId, path.join(output, scenarioId), model, runtime));
		await writeReport(output);
		io.stdout(stableJson({ suiteId, concurrency: 1, runs: summaries }));
		return summaries.some((summary) => summary.status === "infrastructure-error") ? 1 : summaries.some((summary) => summary.status === "failed") ? 2 : 0;
	} catch (error) {
		const failure = redactEvalCliMessage(error);
		if (failureOutput && parsed) await writeCliFailure(failureOutput, parsed.command, failure);
		io.stderr(`pi-eval: ${failure}\n`);
		return 1;
	}
}
