import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { runDurableCommand } from "../worker-runner/command-execution.js";

const ARCH_CONFIG = ".pi/architecture.json";
const StringEnum = <T extends readonly string[]>(values: T) => Type.Unsafe<T[number]>({ type: "string", enum: [...values] });
const languages = ["mermaid", "d2", "dot", "plantuml", "structurizr"] as const;
type Language = typeof languages[number];
type Parameter = { type: "string" | "number" | "boolean" | "array" | "object"; required?: boolean; default?: unknown; enum?: unknown[] };
type Command = { command: string[]; parameters?: Record<string, Parameter> };
type Architecture = { metadata?: unknown; commands?: Record<string, Command>; queries?: Record<string, Command> };
const formats: Record<Language, string[]> = {
	d2: ["svg", "png", "pdf"], dot: ["svg", "png", "pdf", "dot"], plantuml: ["svg", "png", "pdf"],
	mermaid: ["svg", "png", "pdf"], structurizr: ["plantuml", "mermaid", "dot"],
};
const extensions = { mermaid: ".mmd", d2: ".d2", dot: ".dot", plantuml: ".puml", structurizr: ".dsl" };
const executables = { mermaid: ["PI_HARNESS_MERMAID_CLI", "mmdc"], d2: ["PI_HARNESS_D2", "d2"],
	dot: ["PI_HARNESS_DOT", "dot"], plantuml: ["PI_HARNESS_PLANTUML", "plantuml"], structurizr: ["PI_HARNESS_STRUCTURIZR", "structurizr"] };

function inside(cwd: string, input: string, artifact = false): string {
	const root = fs.realpathSync(cwd), resolved = path.resolve(root, input), relative = path.relative(root, resolved);
	if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`Path outside repository: ${input}`);
	if (artifact && !["docs", "diagrams", "output", "build", ".pi/tmp"].some(dir => relative === dir || relative.startsWith(`${dir}/`))) {
		throw new Error(`Artifacts must be under docs/, diagrams/, output/, build/, or .pi/tmp/: ${input}`);
	}
	// Check existing ancestors too: lexical containment alone permits symlink escapes.
	let ancestor = resolved;
	while (!fs.existsSync(ancestor)) {
		if (fs.lstatSync(ancestor, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`Dangling symlink: ${input}`);
		ancestor = path.dirname(ancestor);
	}
	const real = fs.realpathSync(ancestor);
	if (real !== root && !real.startsWith(`${root}${path.sep}`)) throw new Error(`Symlink outside repository: ${input}`);
	return resolved;
}

function config(cwd: string): Architecture {
	const file = inside(cwd, ARCH_CONFIG);
	if (!fs.existsSync(file)) return {};
	const value = JSON.parse(fs.readFileSync(file, "utf8"));
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${ARCH_CONFIG} must be a JSON object.`);
	return value;
}

function result(value: unknown, fullPath?: string) {
	const json = JSON.stringify(value, null, 2);
	const bytes = Buffer.from(json);
	return { content: [{ type: "text" as const, text: bytes.subarray(0, 24_000).toString("utf8") +
		(bytes.length > 24_000 ? `\n[Truncated. Full result: ${fullPath ?? ARCH_CONFIG}]` : "") }], details: { fullPath } };
}

function normalizeArgs(spec: Command, args: unknown): Record<string, unknown> {
	if (args !== undefined && (!args || typeof args !== "object" || Array.isArray(args))) throw new Error("Query args must be a JSON object.");
	const normalized = { ...args as Record<string, unknown> };
	for (const [name, parameter] of Object.entries(spec.parameters ?? {})) {
		const value = normalized[name] === undefined ? parameter.default : normalized[name];
		if (value === undefined) {
			if (parameter.required) throw new Error(`Missing required query parameter: ${name}`);
			continue;
		}
		const type = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
		if (type !== parameter.type || (parameter.enum && !parameter.enum.includes(value))) throw new Error(`Invalid query parameter: ${name}`);
		normalized[name] = value;
	}
	return normalized;
}

function workDirectory(cwd: string): string {
	const root = inside(cwd, ".pi/tmp/architecture-tools", true);
	fs.mkdirSync(root, { recursive: true, mode: 0o700 });
	return fs.mkdtempSync(path.join(root, "run-"));
}

async function execute(cwd: string, dir: string, command: string[], signal?: AbortSignal, timeoutMs = 120_000,
	options: { input?: string; env?: NodeJS.ProcessEnv; stdoutFile?: string } = {}) {
	if (!Array.isArray(command) || !command.length || command.some(arg => typeof arg !== "string" || !arg)) throw new Error("Command must be a non-empty argv array.");
	const outcome = await runDurableCommand({ cwd, command, signal, timeoutMs, ...options,
		logPath: path.join(dir, "command.log"), resultPath: path.join(dir, "result.json") });
	if (outcome.cancelled || outcome.timedOut || outcome.code !== 0) {
		throw new Error(`${outcome.cancelled ? "Cancelled" : outcome.timedOut ? "Timed out" : outcome.spawnError ?? `Exit ${outcome.code}`}\n${outcome.stderr.slice(-4000)}\nLog: ${path.relative(cwd, outcome.logPath)}`);
	}
	return outcome;
}

function inventory(cwd: string, includeGenerated: boolean): Array<{ path: string; language: Language }> {
	const ignored = new Set([".git", "node_modules", ".direnv", "dist", "result"]);
	const matches: Array<{ path: string; language: Language }> = [];
	const aliases: Record<string, Language> = { ".mmd": "mermaid", ".mermaid": "mermaid", ".d2": "d2", ".dot": "dot", ".gv": "dot", ".puml": "plantuml", ".plantuml": "plantuml", ".dsl": "structurizr" };
	const walk = (dir: string) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name), relative = path.relative(cwd, full);
			if (ignored.has(entry.name) || (!includeGenerated && relative === ".pi/tmp")) continue;
			if (entry.isDirectory()) walk(full);
			else if (entry.isFile() && aliases[path.extname(entry.name)]) matches.push({ path: relative, language: aliases[path.extname(entry.name)] });
		}
	};
	walk(cwd);
	return matches.sort((a, b) => a.path.localeCompare(b.path));
}

export default function diagramTools(pi: ExtensionAPI) {
	pi.registerTool({ name: "diagram_inventory", label: "Diagram Inventory", description: "List diagram sources; excludes .pi/tmp unless includeGenerated is true.",
		parameters: Type.Object({ includeGenerated: Type.Optional(Type.Boolean()) }),
		async execute(_id, params, _signal, _update, ctx) {
			const diagrams = inventory(ctx.cwd, params.includeGenerated ?? false);
			const dir = workDirectory(ctx.cwd), file = path.join(dir, "inventory.json");
			fs.writeFileSync(file, JSON.stringify(diagrams));
			return result(diagrams, path.relative(ctx.cwd, file));
		} });

	pi.registerTool({ name: "diagram_render", label: "Render Diagram",
		description: "Validate or render diagrams with local CLIs. Render outputs default to .pi/tmp/architecture-tools/. Structurizr exports a directory of source files, not an image. Unsupported formats fail before execution.",
		parameters: Type.Object({ language: StringEnum(languages), inputPath: Type.Optional(Type.String()), source: Type.Optional(Type.String()),
			outputPath: Type.Optional(Type.String({ description: "Artifact file, or export directory for Structurizr." })),
			format: Type.Optional(StringEnum(["svg", "png", "pdf", "dot", "plantuml", "mermaid"])), mode: Type.Optional(StringEnum(["validate", "render"])) }),
		async execute(_id, params, signal, _update, ctx) {
			const language = params.language, validate = params.mode === "validate";
			const format = params.format ?? (language === "structurizr" ? "plantuml" : path.extname(params.outputPath ?? "").slice(1) || "svg");
			if (!formats[language].includes(format)) throw new Error(`${language} supports: ${formats[language].join(", ")}`);
			if (!params.inputPath && !params.source) throw new Error("Provide inputPath or source.");
			const dir = workDirectory(ctx.cwd), inline = path.join(dir, `input${extensions[language]}`);
			const input = params.inputPath ? inside(ctx.cwd, params.inputPath) : inline;
			const output = path.join(dir, language === "structurizr" ? "export" : `${language === "plantuml" ? path.parse(input).name : "output"}.${format}`);
			const destination = params.outputPath ? inside(ctx.cwd, params.outputPath, true) : output;
			const [variable, fallback] = executables[language];
			try {
				if (!params.inputPath) fs.writeFileSync(inline, params.source!);
				let args: string[];
				switch (language) {
					case "d2": args = validate ? ["validate", input] : [input, output]; break;
					case "dot": args = validate ? ["-Tdot", input, "-o", path.join(dir, "validated.dot")] : [`-T${format}`, input, "-o", output]; break;
					case "mermaid": args = ["-i", input, "-o", output]; break; // Rendering is Mermaid's validation interface.
					case "plantuml":
						args = validate ? ["-checkonly", input] : [`-t${format}`, "-o", dir, input];
						break;
					case "structurizr": args = validate ? ["validate", "-workspace", input] : ["export", "-workspace", input, "-format", format, "-output", output]; break;
				}
				await execute(ctx.cwd, dir, [process.env[variable] || fallback, ...args], signal, 60_000);
				if (!validate) {
					const stat = fs.statSync(output);
					if (language === "structurizr" ? !stat.isDirectory() || !fs.readdirSync(output).length : !stat.isFile() || !stat.size) throw new Error("Renderer produced no artifact.");
					if (destination !== output) {
						fs.mkdirSync(path.dirname(destination), { recursive: true });
						fs.cpSync(output, destination, { recursive: language === "structurizr" });
					}
				}
				return result({ status: validate ? "validated" : "rendered", ...(!validate ? { outputPath: path.relative(ctx.cwd, destination) } : {}), logPath: path.relative(ctx.cwd, path.join(dir, "command.log")) });
			} finally {
				if (!params.inputPath) fs.rmSync(inline, { force: true });
				if (validate) for (const name of [output, path.join(dir, "validated.dot")]) fs.rmSync(name, { recursive: true, force: true });
			}
		} });

	pi.registerTool({ name: "diagram_show", label: "Show Diagram", description: "Open a rendered artifact in a detached local viewer only when requested or useful for visual inspection.",
		parameters: Type.Object({ path: Type.String(), viewer: Type.Optional(Type.String()) }),
		async execute(_id, params, _signal, _update, ctx) {
			const file = inside(ctx.cwd, params.path, true);
			if (![".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf"].includes(path.extname(file).toLowerCase()) || !fs.statSync(file).isFile()) throw new Error("Not a supported image/PDF artifact.");
			const viewer = params.viewer?.trim() || process.env.PI_HARNESS_IMAGE_VIEWER || (process.platform === "darwin" ? "open" : "xdg-open");
			await new Promise<void>((resolve, reject) => {
				const child = spawn(viewer, [file], { cwd: ctx.cwd, detached: true, stdio: "ignore" });
				child.once("error", reject); child.once("spawn", () => { child.unref(); resolve(); });
			});
			return result({ opened: params.path, viewer });
		} });

	pi.registerTool({ name: "architecture_discover", label: "Discover Architecture Tools",
		description: `List project architecture metadata, commands, queries and parameters from ${ARCH_CONFIG} in one call.`, parameters: Type.Object({}),
		async execute(_id, _params, _signal, _update, ctx) { return result(config(ctx.cwd)); } });

	for (const query of [false, true]) pi.registerTool({ name: query ? "architecture_query" : "architecture_command", label: query ? "Run Architecture Query" : "Run Architecture Command",
		description: `Run a named project ${query ? "parameterized JSON query" : "command"} from ${ARCH_CONFIG}. Results are bounded previews with complete local artifacts.`,
		parameters: Type.Object({ name: Type.String(), ...(query ? { args: Type.Optional(Type.Any()) } : {}), timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 2_147_483_647 })) }),
		async execute(_id, params, signal, _update, ctx) {
			const spec = config(ctx.cwd)[query ? "queries" : "commands"]?.[params.name];
			if (!spec) throw new Error(`Unknown architecture ${query ? "query" : "command"}: ${params.name}`);
			const dir = workDirectory(ctx.cwd), stdoutFile = path.join(dir, "stdout.json");
			const payload = { name: params.name, args: normalizeArgs(spec, params.args) };
			const outcome = await execute(ctx.cwd, dir, spec.command, signal, params.timeoutMs, query ? {
				stdoutFile, input: `${JSON.stringify(payload)}\n`, env: { ...process.env, PI_ARCHITECTURE_QUERY_NAME: params.name,
					PI_ARCHITECTURE_QUERY_ARGS_JSON: JSON.stringify(payload.args), PI_ARCHITECTURE_QUERY_PAYLOAD_JSON: JSON.stringify(payload) },
			} : {});
			if (!query) return result(outcome, path.relative(ctx.cwd, path.join(dir, "result.json")));
			const value = JSON.parse(fs.readFileSync(stdoutFile, "utf8"));
			if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Query must emit a JSON object. Output: ${path.relative(ctx.cwd, stdoutFile)}`);
			for (const group of [value, ...(value.sections ?? [])]) for (const artifact of group.artifacts ?? []) inside(ctx.cwd, artifact.path, true);
			return result(value, path.relative(ctx.cwd, stdoutFile));
		} });
}
