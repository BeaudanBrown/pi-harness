import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_OUTPUT = 24_000;
const ARCH_CONFIG = ".pi/architecture.json";

const diagramLanguages = ["mermaid", "d2", "dot", "plantuml", "structurizr"] as const;
const showableExtensions = [".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf"];
type DiagramLanguage = (typeof diagramLanguages)[number];

type CommandSpec = {
	description?: string;
	command: string[];
};

type ArchitectureMetadata = {
	description?: string;
	capabilities?: string[];
	factModel?: string;
	generatedArtifacts?: string[];
};

type QueryParameterSpec = {
	type: "string" | "number" | "boolean" | "array" | "object";
	description?: string;
	required?: boolean;
	default?: unknown;
	enum?: unknown[];
};

type QuerySpec = {
	description?: string;
	intent?: string;
	capabilities?: string[];
	command: string[];
	parameters?: Record<string, QueryParameterSpec>;
};

type ArchitectureConfig = {
	metadata?: ArchitectureMetadata;
	commands?: Record<string, CommandSpec>;
	queries?: Record<string, QuerySpec>;
};

type QueryArtifact = { path: string; kind?: string; language?: string; description?: string };
type QueryTable = { title?: string; columns?: string[]; rows?: unknown[][] | Record<string, unknown>[] };
type QuerySection = { title: string; content?: string; metrics?: Record<string, unknown>; tables?: QueryTable[]; artifacts?: QueryArtifact[] };

type QueryResult = {
	summary?: string;
	warnings?: string[];
	metrics?: Record<string, unknown>;
	tables?: QueryTable[];
	sections?: QuerySection[];
	artifacts?: QueryArtifact[];
	provenance?: Record<string, unknown>;
};

function stringEnum(values: readonly string[]) {
	return Type.Union(values.map((value) => Type.Literal(value)) as any);
}

function text(content: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text: content }], details };
}

function truncate(value: string): string {
	if (value.length <= MAX_OUTPUT) return value;
	return `${value.slice(0, MAX_OUTPUT)}\n\n[truncated ${value.length - MAX_OUTPUT} bytes]`;
}

function repoRoot(): string {
	return process.cwd();
}

function resolveInsideRepo(input: string): string {
	const root = repoRoot();
	const resolved = path.resolve(root, input);
	if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
		throw new Error(`Refusing path outside repository: ${input}`);
	}
	return resolved;
}

function assertSafeArtifactPath(input: string, action: "read" | "write"): string {
	const root = repoRoot();
	const resolved = resolveInsideRepo(input);
	const relative = path.relative(root, resolved);
	const allowedRoots = ["docs", "diagrams", "output", "build", ".pi/tmp"];
	if (!allowedRoots.some((allowed) => relative === allowed || relative.startsWith(`${allowed}${path.sep}`))) {
		throw new Error(`Refusing to ${action} outside docs/, diagrams/, output/, build/, or .pi/tmp/: ${input}`);
	}
	return resolved;
}

function assertSafeWritePath(input: string): string {
	return assertSafeArtifactPath(input, "write");
}

function assertSafeShowPath(input: string): string {
	const resolved = assertSafeArtifactPath(input, "read");
	const ext = path.extname(resolved).toLowerCase();
	if (!showableExtensions.includes(ext)) {
		throw new Error(`Refusing to show unsupported file type ${ext || "<none>"}. Supported: ${showableExtensions.join(", ")}`);
	}
	if (!fs.existsSync(resolved)) throw new Error(`File does not exist: ${input}`);
	return resolved;
}

function executableFor(language: DiagramLanguage): string {
	if (language === "d2") return process.env.PI_HARNESS_D2 || "d2";
	if (language === "dot") return process.env.PI_HARNESS_DOT || "dot";
	if (language === "plantuml") return process.env.PI_HARNESS_PLANTUML || "plantuml";
	if (language === "mermaid") return process.env.PI_HARNESS_MERMAID_CLI || "mmdc";
	return process.env.PI_HARNESS_STRUCTURIZR || "structurizr";
}

function outputFormat(outputPath?: string, requested?: string): string {
	if (requested) return requested;
	const ext = outputPath ? path.extname(outputPath).replace(/^\./, "") : "svg";
	return ext || "svg";
}

function runCommand(
	command: string,
	args: string[],
	options: { signal?: AbortSignal; timeoutMs?: number; input?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: repoRoot(),
			env: options.env ?? process.env,
			stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
			signal: options.signal,
		});
		let stdout = "";
		let stderr = "";
		let settled = false;
		const appendStdout = (chunk: Buffer) => {
			stdout = truncate(stdout + chunk.toString());
		};
		const appendStderr = (chunk: Buffer) => {
			stderr = truncate(stderr + chunk.toString());
		};
		const timer = setTimeout(() => {
			if (settled) return;
			child.kill("SIGTERM");
		}, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
		child.stdout!.on("data", appendStdout);
		child.stderr!.on("data", appendStderr);
		if (options.input !== undefined) {
			child.stdin!.end(options.input);
		}
		child.on("error", (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(error);
		});
		child.on("close", (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ code, stdout, stderr });
		});
	});
}

function readArchitectureConfig(): ArchitectureConfig {
	const configPath = path.join(repoRoot(), ARCH_CONFIG);
	if (!fs.existsSync(configPath)) return {};
	const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as ArchitectureConfig;
	if (!parsed || typeof parsed !== "object") throw new Error(`${ARCH_CONFIG} must contain a JSON object.`);
	return parsed;
}

function normalizeQueryArgs(spec: QuerySpec, rawArgs: unknown): Record<string, unknown> {
	if (rawArgs !== undefined && (rawArgs === null || typeof rawArgs !== "object" || Array.isArray(rawArgs))) {
		throw new Error("architecture_query args must be a JSON object.");
	}
	const input = (rawArgs ?? {}) as Record<string, unknown>;
	const parameters = spec.parameters ?? {};
	const normalized: Record<string, unknown> = {};
	for (const [name, parameter] of Object.entries(parameters)) {
		let value = input[name];
		if (value === undefined && Object.prototype.hasOwnProperty.call(parameter, "default")) {
			value = parameter.default;
		}
		if (value === undefined) {
			if (parameter.required) throw new Error(`Missing required query parameter: ${name}`);
			continue;
		}
		if (parameter.type === "array") {
			if (!Array.isArray(value)) throw new Error(`Query parameter ${name} must be an array.`);
		} else if (parameter.type === "object") {
			if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`Query parameter ${name} must be an object.`);
		} else if (typeof value !== parameter.type) {
			throw new Error(`Query parameter ${name} must be a ${parameter.type}.`);
		}
		if (parameter.enum && !parameter.enum.includes(value)) {
			throw new Error(`Query parameter ${name} must be one of: ${parameter.enum.map(String).join(", ")}`);
		}
		normalized[name] = value;
	}
	for (const [name, value] of Object.entries(input)) {
		if (!Object.prototype.hasOwnProperty.call(parameters, name)) normalized[name] = value;
	}
	return normalized;
}

function describeQueryParameter(name: string, parameter: QueryParameterSpec): string {
	const parts = [name, parameter.type];
	if (parameter.required) parts.push("required");
	if (parameter.enum) parts.push(`enum=${parameter.enum.map(String).join("|")}`);
	if (Object.prototype.hasOwnProperty.call(parameter, "default")) parts.push(`default=${JSON.stringify(parameter.default)}`);
	return `    - ${parts.join("; ")}${parameter.description ? ` — ${parameter.description}` : ""}`;
}

function describeCapabilities(capabilities?: string[]): string[] {
	return capabilities && capabilities.length > 0 ? [`    capabilities: ${capabilities.join(", ")}`] : [];
}

function formatScalar(value: unknown): string {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean" || value === null) return String(value);
	return JSON.stringify(value);
}

function formatMetrics(metrics: Record<string, unknown> | undefined, indent = ""): string[] {
	if (!metrics || Object.keys(metrics).length === 0) return [];
	return Object.entries(metrics).map(([key, value]) => `${indent}- ${key}: ${formatScalar(value)}`);
}

function formatTables(tables: QueryTable[] | undefined): string[] {
	if (!tables || tables.length === 0) return [];
	return tables.flatMap((table, index) => {
		const title = table.title ?? `table ${index + 1}`;
		const rows = table.rows ?? [];
		const preview = rows.slice(0, 8).map((row) => `  - ${formatScalar(row)}`);
		return [title, ...preview, ...(rows.length > preview.length ? [`  ... ${rows.length - preview.length} more rows`] : [])];
	});
}

function validateQueryResult(result: QueryResult | undefined): void {
	if (!result) return;
	if (result.warnings !== undefined && (!Array.isArray(result.warnings) || result.warnings.some((item) => typeof item !== "string"))) {
		throw new Error("query result warnings must be an array of strings");
	}
	for (const artifact of result.artifacts ?? []) validateQueryResultArtifactPath(artifact.path);
	for (const section of result.sections ?? []) {
		for (const artifact of section.artifacts ?? []) validateQueryResultArtifactPath(artifact.path);
	}
}

function validateQueryResultArtifactPath(artifactPath: string): void {
	assertSafeArtifactPath(artifactPath, "read");
}

function parseQueryResult(stdout: string): QueryResult | undefined {
	const trimmed = stdout.trim();
	if (!trimmed) return undefined;
	try {
		const parsed = JSON.parse(trimmed) as QueryResult;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("query output must be a JSON object");
		return parsed;
	} catch (error) {
		throw new Error(`architecture_query command must write a structured JSON object to stdout. ${error instanceof Error ? error.message : String(error)}`);
	}
}

function commandArgs(language: DiagramLanguage, inputPath: string, outputPath: string | undefined, format: string, mode: string): string[] {
	if (language === "d2") {
		return mode === "validate" ? ["--check", inputPath] : [inputPath, outputPath ?? "-"];
	}
	if (language === "dot") {
		return outputPath ? [`-T${format}`, inputPath, "-o", outputPath] : [`-T${format}`, inputPath];
	}
	if (language === "plantuml") {
		return mode === "validate" ? ["-checkonly", inputPath] : [`-t${format}`, inputPath];
	}
	if (language === "mermaid") {
		const args = ["-i", inputPath];
		if (outputPath) args.push("-o", outputPath);
		return args;
	}
	return mode === "validate" ? ["validate", "-workspace", inputPath] : ["export", "-workspace", inputPath, "-format", format];
}

function extensionFor(language: DiagramLanguage): string {
	if (language === "d2") return ".d2";
	if (language === "dot") return ".dot";
	if (language === "plantuml") return ".puml";
	if (language === "structurizr") return ".dsl";
	return ".mmd";
}

function imageViewer(override?: string): string {
	if (override?.trim()) return override.trim();
	if (process.env.PI_HARNESS_IMAGE_VIEWER) return process.env.PI_HARNESS_IMAGE_VIEWER;
	return process.platform === "darwin" ? "open" : "xdg-open";
}

function showFile(filePath: string, viewer: string): Promise<{ pid?: number }> {
	return new Promise((resolve, reject) => {
		const child = spawn(viewer, [filePath], {
			cwd: repoRoot(),
			detached: true,
			env: process.env,
			stdio: "ignore",
		});
		child.on("error", reject);
		child.on("spawn", () => {
			child.unref();
			resolve({ pid: child.pid });
		});
	});
}

function findDiagramFiles(): Array<{ path: string; language: string }> {
	const root = repoRoot();
	const ignored = new Set([".git", "node_modules", ".direnv", "dist", "result"]);
	const matches: Array<{ path: string; language: string }> = [];
	const classify = (file: string): string | undefined => {
		const base = path.basename(file);
		const ext = path.extname(file).toLowerCase();
		if (ext === ".mmd" || ext === ".mermaid") return "mermaid";
		if (ext === ".d2") return "d2";
		if (ext === ".dot" || ext === ".gv") return "dot";
		if (ext === ".puml" || ext === ".plantuml") return "plantuml";
		if (base === "workspace.dsl" || ext === ".dsl") return "structurizr";
		return undefined;
	};
	const walk = (dir: string) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			if (ignored.has(entry.name)) continue;
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.isFile()) {
				const language = classify(full);
				if (language) matches.push({ path: path.relative(root, full), language });
			}
		}
	};
	walk(root);
	return matches.sort((a, b) => a.path.localeCompare(b.path));
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "diagram_inventory",
		label: "Diagram Inventory",
		description: "List diagram-as-code and architecture model files in the current repository.",
		parameters: Type.Object({}),
		async execute() {
			const diagrams = findDiagramFiles();
			const lines = diagrams.length > 0
				? diagrams.map((item) => `- ${item.path} (${item.language})`)
				: ["No diagram source files found."];
			return text(lines.join("\n"), { diagrams });
		},
	});

	pi.registerTool({
		name: "diagram_render",
		label: "Render Diagram",
		description: "Validate or render Mermaid, D2, Graphviz DOT, PlantUML, or Structurizr diagram sources with local CLI tools.",
		parameters: Type.Object({
			language: stringEnum(diagramLanguages),
			inputPath: Type.Optional(Type.String({ description: "Repository-relative diagram source path." })),
			source: Type.Optional(Type.String({ description: "Inline diagram source. Used only when inputPath is omitted." })),
			outputPath: Type.Optional(Type.String({ description: "Repository-relative output path for generated artifact." })),
			format: Type.Optional(stringEnum(["svg", "png", "pdf", "dot", "plantuml", "mermaid"] as const)),
			mode: Type.Optional(stringEnum(["validate", "render"] as const)),
		}),
		async execute(_toolCallId, params, signal) {
			const language = params.language as DiagramLanguage;
			const mode = params.mode ?? "render";
			let inputPath: string;
			let tempDir: string | undefined;
			if (params.inputPath) {
				inputPath = resolveInsideRepo(params.inputPath);
				if (!fs.existsSync(inputPath)) throw new Error(`Input path does not exist: ${params.inputPath}`);
			} else if (params.source) {
				tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-diagram-"));
				inputPath = path.join(tempDir, `input${extensionFor(language)}`);
				fs.writeFileSync(inputPath, params.source);
			} else {
				throw new Error("Provide inputPath or source.");
			}

			const outputPath = params.outputPath ? assertSafeWritePath(params.outputPath) : undefined;
			if (outputPath) fs.mkdirSync(path.dirname(outputPath), { recursive: true });
			const format = outputFormat(outputPath, params.format);
			const command = executableFor(language);
			const args = commandArgs(language, inputPath, outputPath, format, mode);
			const result = await runCommand(command, args, { signal, timeoutMs: DEFAULT_TIMEOUT_MS });
			if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });

			const outputRel = outputPath ? path.relative(repoRoot(), outputPath) : undefined;
			const summary = [
				`Command: ${command} ${args.join(" ")}`,
				`Exit code: ${result.code}`,
				...(outputRel ? [`Output: ${outputRel}`] : []),
				...(result.stdout.trim() ? ["", "stdout:", result.stdout.trim()] : []),
				...(result.stderr.trim() ? ["", "stderr:", result.stderr.trim()] : []),
			].join("\n");
			return text(summary, { command, args, exitCode: result.code, outputPath: outputRel });
		},
	});

	pi.registerTool({
		name: "diagram_show",
		label: "Show Diagram",
		description: "Open a rendered diagram/image/PDF artifact in a detached local viewer. Use only when the user asks to view a diagram or when visual inspection is helpful after rendering.",
		parameters: Type.Object({
			path: Type.String({ description: "Repository-relative artifact path under docs/, diagrams/, output/, build/, or .pi/tmp/." }),
			viewer: Type.Optional(Type.String({ description: "Optional viewer executable override. Defaults to PI_HARNESS_IMAGE_VIEWER, xdg-open, or macOS open." })),
		}),
		async execute(_toolCallId, params) {
			const fullPath = assertSafeShowPath(params.path);
			const viewer = imageViewer(params.viewer);
			const result = await showFile(fullPath, viewer);
			const relative = path.relative(repoRoot(), fullPath);
			return text(`Opened ${relative} with ${viewer}${result.pid ? ` (pid ${result.pid})` : ""}.`, {
				path: relative,
				viewer,
				pid: result.pid,
			});
		},
	});

	pi.registerTool({
		name: "architecture_commands",
		label: "Architecture Commands",
		description: `List project-defined deterministic architecture commands from ${ARCH_CONFIG} if present.`,
		parameters: Type.Object({}),
		async execute() {
			const config = readArchitectureConfig();
			const commands = config.commands ?? {};
			const entries = Object.entries(commands);
			const lines = entries.length > 0
				? entries.map(([name, spec]) => `- ${name}: ${spec.description ?? spec.command.join(" ")}`)
				: [`No ${ARCH_CONFIG} commands found.`];
			return text(lines.join("\n"), { commands });
		},
	});

	pi.registerTool({
		name: "architecture_queries",
		label: "Architecture Queries",
		description: `List project-defined parameterized architecture queries from ${ARCH_CONFIG} if present.`,
		parameters: Type.Object({}),
		async execute() {
			const config = readArchitectureConfig();
			const queries = config.queries ?? {};
			const entries = Object.entries(queries);
			const header = [
				...(config.metadata?.description ? [config.metadata.description] : []),
				...(config.metadata?.capabilities?.length ? [`Project capabilities: ${config.metadata.capabilities.join(", ")}`] : []),
				...(config.metadata?.factModel ? [`Fact model: ${config.metadata.factModel}`] : []),
			];
			const lines = entries.length > 0
				? entries.flatMap(([name, spec]) => {
					const parameters = Object.entries(spec.parameters ?? {});
					return [
						`- ${name}: ${spec.description ?? spec.command.join(" ")}`,
						...(spec.intent ? [`    intent: ${spec.intent}`] : []),
						...describeCapabilities(spec.capabilities),
						...(parameters.length > 0 ? parameters.map(([parameterName, parameter]) => describeQueryParameter(parameterName, parameter)) : []),
					];
				})
				: [`No ${ARCH_CONFIG} queries found.`];
			return text([...header, ...(header.length ? [""] : []), ...lines].join("\n"), { metadata: config.metadata, queries });
		},
	});

	pi.registerTool({
		name: "architecture_query",
		label: "Run Architecture Query",
		description: `Run a project-defined parameterized architecture query from ${ARCH_CONFIG}.`,
		parameters: Type.Object({
			name: Type.String({ description: "Query name from .pi/architecture.json." }),
			args: Type.Optional(Type.Any({ description: "JSON object containing query arguments." })),
			timeoutMs: Type.Optional(Type.Number({ description: "Timeout in milliseconds. Defaults to 120000." })),
		}),
		async execute(_toolCallId, params, signal) {
			const config = readArchitectureConfig();
			const spec = config.queries?.[params.name];
			if (!spec) throw new Error(`Unknown architecture query: ${params.name}`);
			if (!Array.isArray(spec.command) || spec.command.length === 0) {
				throw new Error(`Architecture query ${params.name} must be a non-empty argv array.`);
			}
			const normalizedArgs = normalizeQueryArgs(spec, params.args);
			const payload = { name: params.name, args: normalizedArgs };
			const payloadJson = JSON.stringify(payload);
			const [command, ...args] = spec.command;
			const result = await runCommand(command, args, {
				signal,
				timeoutMs: params.timeoutMs ?? 120_000,
				input: `${JSON.stringify(payload, null, 2)}\n`,
				env: {
					...process.env,
					PI_ARCHITECTURE_QUERY_NAME: params.name,
					PI_ARCHITECTURE_QUERY_ARGS_JSON: JSON.stringify(normalizedArgs),
					PI_ARCHITECTURE_QUERY_PAYLOAD_JSON: payloadJson,
				},
			});
			const parsed = parseQueryResult(result.stdout);
			validateQueryResult(parsed);
			const artifactLines = (parsed?.artifacts ?? []).map((artifact) => `- ${artifact.path}${artifact.kind ? ` (${artifact.kind}${artifact.language ? `/${artifact.language}` : ""})` : ""}${artifact.description ? ` — ${artifact.description}` : ""}`);
			const sectionLines = (parsed?.sections ?? []).flatMap((section) => {
				const sectionArtifacts = (section.artifacts ?? []).map((artifact) => `  - ${artifact.path}${artifact.kind ? ` (${artifact.kind}${artifact.language ? `/${artifact.language}` : ""})` : ""}${artifact.description ? ` — ${artifact.description}` : ""}`);
				return [
					`## ${section.title}`,
					...(section.content ? [section.content] : []),
					...(formatMetrics(section.metrics, "  ").length > 0 ? ["metrics:", ...formatMetrics(section.metrics, "  ")] : []),
					...(formatTables(section.tables).length > 0 ? ["tables:", ...formatTables(section.tables)] : []),
					...(sectionArtifacts.length > 0 ? ["artifacts:", ...sectionArtifacts] : []),
				];
			});
			const body = [
				`Command: ${spec.command.join(" ")}`,
				`Exit code: ${result.code}`,
				...(parsed?.summary ? ["", parsed.summary] : []),
				...(parsed?.warnings?.length ? ["", "warnings:", ...parsed.warnings.map((warning) => `- ${warning}`)] : []),
				...(formatMetrics(parsed?.metrics).length > 0 ? ["", "metrics:", ...formatMetrics(parsed?.metrics)] : []),
				...(formatTables(parsed?.tables).length > 0 ? ["", "tables:", ...formatTables(parsed?.tables)] : []),
				...(sectionLines.length > 0 ? ["", "sections:", ...sectionLines] : []),
				...(artifactLines.length > 0 ? ["", "artifacts:", ...artifactLines] : []),
				...(result.stderr.trim() ? ["", "stderr:", result.stderr.trim()] : []),
				...(parsed ? [] : result.stdout.trim() ? ["", "stdout:", result.stdout.trim()] : []),
			].join("\n");
			return text(body, {
				name: params.name,
				args: normalizedArgs,
				command: spec.command,
				exitCode: result.code,
				result: parsed,
			});
		},
	});

	pi.registerTool({
		name: "architecture_command",
		label: "Run Architecture Command",
		description: `Run a project-defined deterministic architecture command from ${ARCH_CONFIG}.`,
		parameters: Type.Object({
			name: Type.String({ description: "Command name from .pi/architecture.json." }),
			timeoutMs: Type.Optional(Type.Number({ description: "Timeout in milliseconds. Defaults to 120000." })),
		}),
		async execute(_toolCallId, params, signal) {
			const config = readArchitectureConfig();
			const spec = config.commands?.[params.name];
			if (!spec) throw new Error(`Unknown architecture command: ${params.name}`);
			if (!Array.isArray(spec.command) || spec.command.length === 0) {
				throw new Error(`Architecture command ${params.name} must be a non-empty argv array.`);
			}
			const [command, ...args] = spec.command;
			const result = await runCommand(command, args, { signal, timeoutMs: params.timeoutMs ?? 120_000 });
			const body = [
				`Command: ${spec.command.join(" ")}`,
				`Exit code: ${result.code}`,
				...(result.stdout.trim() ? ["", "stdout:", result.stdout.trim()] : []),
				...(result.stderr.trim() ? ["", "stderr:", result.stderr.trim()] : []),
			].join("\n");
			return text(body, { name: params.name, command: spec.command, exitCode: result.code });
		},
	});
}
