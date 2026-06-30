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

type ArchitectureConfig = {
	commands?: Record<string, CommandSpec>;
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
	options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: repoRoot(),
			env: process.env,
			stdio: ["ignore", "pipe", "pipe"],
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
		child.stdout.on("data", appendStdout);
		child.stderr.on("data", appendStderr);
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
