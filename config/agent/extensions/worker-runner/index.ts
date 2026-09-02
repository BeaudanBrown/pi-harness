import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import * as path from "node:path";
import {
	createAgentSession,
	createExtensionRuntime,
	getAgentDir,
	SessionManager,
	SettingsManager,
	type ExtensionAPI,
	type ExtensionContext,
	type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { resolveAgentProfile } from "../agent-profiles/core.js";
import {
	nextWorkerPresetSelection,
	parseWorkerModelCommand,
	parseWorkerModelRef,
	workerModelCandidates,
	workerSelectionFromSettings,
	workerSelectionLabel,
	workerSelectionModelRef,
	workerSelectionToSettings,
	type WorkerModelSelection as WorkerSelection,
} from "./core.js";
import { selectWorkerModel } from "./model-selector.js";
import { balancedLogExcerpt, deterministicCommandSummary, runDurableCommand, shellDisplay, writeDurableResult, type DurableCommandResult } from "./command-execution.js";

const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_MAX_LOG_BYTES_FOR_WORKER = 80_000;
const WORKER_ROOT = ".pi/tmp/workers";
const DIAGNOSIS_TIMEOUT_MS = 2 * 60_000;

const RunWorkerParams = Type.Object({
	name: Type.String({ description: "Short human-readable name for this delegated command/check." }),
	command: Type.Array(Type.String(), {
		description: "Command argv to run in the current repository, for example [\"bash\", \"./bin/in-env\", \"test\"].",
		minItems: 1,
	}),
	task: Type.String({
		description: "Instruction for the delegated worker: what to extract, diagnose, or summarize from the command result.",
	}),
	timeout_ms: Type.Optional(Type.Number({ description: "Command timeout in milliseconds. Defaults to 20 minutes." })),
	max_log_bytes_for_worker: Type.Optional(
		Type.Number({ description: "Maximum bytes of captured log excerpt sent to the worker. Defaults to 80000." }),
	),
});

type RunWorkerParamsType = {
	name: string;
	command: string[];
	task: string;
	timeout_ms?: number;
	max_log_bytes_for_worker?: number;
};

type CommandResult = DurableCommandResult;

function slugify(value: string): string {
	return (
		value
			.toLowerCase()
			.replace(/[^a-z0-9._-]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 48) || "worker"
	);
}

function repoRelative(fromCwd: string, absolutePath: string): string {
	return path.relative(fromCwd, absolutePath) || ".";
}


const STATUS_KEY = "worker-model";
const SETTINGS_KEY = "pi-worker-runner";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

async function readJsonObject(filePath: string): Promise<Record<string, unknown>> {
	try {
		const text = await readFile(filePath, "utf8");
		const parsed: unknown = JSON.parse(text);
		return isRecord(parsed) ? parsed : {};
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return {};
		throw error;
	}
}

function workerSettingsPath(): string {
	return path.join(getAgentDir(), "settings.json");
}

async function loadWorkerSelection(): Promise<WorkerSelection> {
	const settings = await readJsonObject(workerSettingsPath());
	return workerSelectionFromSettings(settings[SETTINGS_KEY]);
}

async function persistWorkerSelection(selection: WorkerSelection): Promise<void> {
	const settingsPath = workerSettingsPath();
	const settings = await readJsonObject(settingsPath);
	const existing = isRecord(settings[SETTINGS_KEY]) ? settings[SETTINGS_KEY] : {};
	const next: Record<string, unknown> = { ...existing, ...workerSelectionToSettings(selection) };
	delete next.mode;
	settings[SETTINGS_KEY] = next;

	await mkdir(path.dirname(settingsPath), { recursive: true });
	const tempPath = `${settingsPath}.tmp-${process.pid}-${Date.now()}`;
	await writeFile(tempPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
	await rename(tempPath, settingsPath);
}

type ResolvedWorkerModel =
	| { model: NonNullable<ExtensionContext["model"]>; modelRef: string }
	| { error: string };

function selectedWorkerModel(ctx: ExtensionContext, selection: WorkerSelection): ResolvedWorkerModel {
	const candidates = workerModelCandidates({
		selection,
		environmentOverride: process.env.PI_HARNESS_WORKER_MODEL,
		parentModel: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
	});
	const first = candidates[0];
	if (!first) return { error: "No worker model is configured." };

	for (const candidate of candidates) {
		const parsed = parseWorkerModelRef(candidate);
		const model = parsed ? ctx.modelRegistry.find(parsed.provider, parsed.id) : undefined;
		if (model && ctx.modelRegistry.hasConfiguredAuth(model)) return { model, modelRef: candidate };
	}

	const override = process.env.PI_HARNESS_WORKER_MODEL?.trim();
	const label = override ? `PI_HARNESS_WORKER_MODEL (${override})` : `worker model (${first})`;
	return { error: `${label} is not registered or has no configured authentication.` };
}

function createWorkerResourceLoader(): ResourceLoader {
	const profile = resolveAgentProfile("diagnostic-worker");
	return {
		getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => profile.systemPrompt,
		getSystemPromptSource: () => undefined,
		getAppendSystemPrompt: () => [],
		getAppendSystemPromptSources: () => [],
		extendResources: () => {},
		reload: async () => {},
	};
}

function extractAssistantText(session: { messages: unknown[] }): string {
	for (let i = session.messages.length - 1; i >= 0; i--) {
		const message = session.messages[i] as any;
		if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
		const parts = message.content
			.map((part: any) => {
				if (typeof part === "string") return part;
				if (part?.type === "text" && typeof part.text === "string") return part.text;
				return undefined;
			})
			.filter(Boolean);
		if (parts.length > 0) return parts.join("\n").trim();
	}
	return "";
}

async function askWorker(
	ctx: ExtensionContext,
	selection: WorkerSelection,
	params: RunWorkerParamsType,
	result: CommandResult,
	logExcerpt: string,
	signal: AbortSignal | undefined = ctx.signal,
): Promise<{ summary: string; modelRef: string }> {
	const selected = selectedWorkerModel(ctx, selection);
	if (!("model" in selected)) throw new Error(selected.error);
	const { model, modelRef } = selected;

	const { session } = await createAgentSession({
		cwd: ctx.cwd,
		model,
		thinkingLevel: "low",
		tools: resolveAgentProfile("diagnostic-worker").tools,
		sessionManager: SessionManager.inMemory(ctx.cwd),
		settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
		resourceLoader: createWorkerResourceLoader(),
	});

	let streamed = "";
	const unsubscribe = session.subscribe((event) => {
		if (event.type === "message_update" && (event as any).assistantMessageEvent?.type === "text_delta") {
			streamed += (event as any).assistantMessageEvent.delta ?? "";
		}
	});
	const abortWorker = () => void session.abort();
	signal?.addEventListener("abort", abortWorker, { once: true });
	let diagnosisTimer: ReturnType<typeof setTimeout> | undefined;
	try {
		const prompt = session.prompt(`Parent task:\n${params.task}\n\nCommand name:\n${params.name}\n\nCommand:\n${shellDisplay(params.command)}\n\nExit code: ${result.code ?? "null"}\nTimed out: ${result.timedOut ? "yes" : "no"}\nDuration: ${Math.round(result.durationMs / 1000)}s\nLog path: ${repoRelative(ctx.cwd, result.logPath)}\n\nLog excerpt:\n\`\`\`text\n${logExcerpt}\n\`\`\`\n\nReturn only the concise answer requested by the parent task. Do not mention the wrapper, worker, model, tool internals, or whether summarization occurred.`);
		const deadline = new Promise<never>((_resolve, reject) => {
			diagnosisTimer = setTimeout(() => {
				void session.abort();
				reject(new Error(`Diagnostic summarization exceeded ${DIAGNOSIS_TIMEOUT_MS}ms.`));
			}, DIAGNOSIS_TIMEOUT_MS);
			diagnosisTimer.unref?.();
		});
		await Promise.race([prompt, deadline]);
		return { summary: (streamed.trim() || extractAssistantText(session)).trim(), modelRef };
	} finally {
		if (diagnosisTimer) clearTimeout(diagnosisTimer);
		signal?.removeEventListener("abort", abortWorker);
		unsubscribe();
		session.dispose();
	}
}

export async function diagnoseCommandResult(
	ctx: ExtensionContext,
	params: { name: string; command: string[]; task: string },
	result: CommandResult,
	logExcerpt: string,
	signal?: AbortSignal,
): Promise<{ summary: string; modelRef?: string; error?: string }> {
	try {
		const diagnosed = await askWorker(ctx, { kind: "preset", preset: "spark" }, params, result, logExcerpt, signal);
		return diagnosed.summary ? diagnosed : { summary: fallbackSummary(params, result), modelRef: diagnosed.modelRef };
	} catch (error) {
		return { summary: fallbackSummary(params, result), error: error instanceof Error ? error.message : String(error) };
	}
}

function fallbackSummary(params: RunWorkerParamsType, result: CommandResult): string {
	return deterministicCommandSummary(params.name, result);
}

export default function workerRunnerExtension(pi: ExtensionAPI): void {
	let workerSelection: WorkerSelection = { kind: "preset", preset: "spark" };
	let settingsWriteQueue: Promise<void> = Promise.resolve();

	function updateStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		const override = process.env.PI_HARNESS_WORKER_MODEL?.trim();
		if (override) {
			ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("warning", "worker: env override"));
			return;
		}

		const selected = selectedWorkerModel(ctx, workerSelection);
		const label = `worker: ${workerSelectionLabel(workerSelection)}`;
		ctx.ui.setStatus(
			STATUS_KEY,
			"model" in selected ? ctx.ui.theme.fg("accent", label) : ctx.ui.theme.fg("warning", `${label} (inactive)`),
		);
	}

	function persistSelection(selection: WorkerSelection, ctx: ExtensionContext): void {
		settingsWriteQueue = settingsWriteQueue.catch(() => undefined).then(() => persistWorkerSelection(selection));
		void settingsWriteQueue.catch((error: unknown) => {
			if (!ctx.hasUI) return;
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`worker-model: failed to write settings: ${message}`, "warning");
		});
	}

	function setWorkerSelection(
		selection: WorkerSelection,
		ctx: ExtensionContext,
		options?: { persist?: boolean; notify?: boolean },
	): boolean {
		const selected = selectedWorkerModel(ctx, selection);
		if (!process.env.PI_HARNESS_WORKER_MODEL?.trim() && "error" in selected) {
			if (ctx.hasUI) ctx.ui.notify(`worker-model: ${selected.error}`, "error");
			return false;
		}

		workerSelection = selection;
		if (options?.persist !== false) persistSelection(selection, ctx);
		updateStatus(ctx);
		if (options?.notify !== false && ctx.hasUI) {
			const override = process.env.PI_HARNESS_WORKER_MODEL?.trim();
			const preference = workerSelectionLabel(selection);
			ctx.ui.notify(
				override
					? `Worker preference saved as ${preference}, but PI_HARNESS_WORKER_MODEL (${override}) is active.`
					: `Worker model set to ${preference} (${workerSelectionModelRef(selection)}).`,
				"info",
			);
		}
		return true;
	}

	pi.registerCommand("worker-model", {
		description: "Toggle, search, inspect, or directly set the delegated worker model",
		getArgumentCompletions: (prefix) => {
			const options = ["spark", "luna", "select", "status"];
			const matches = options.filter((option) => option.startsWith(prefix.toLowerCase()));
			return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			const command = parseWorkerModelCommand(args);
			if (command.type === "status") {
				const override = process.env.PI_HARNESS_WORKER_MODEL?.trim();
				const selected = selectedWorkerModel(ctx, workerSelection);
				const detail = override
					? `PI_HARNESS_WORKER_MODEL=${override}`
					: workerSelectionModelRef(workerSelection);
				ctx.ui.notify(
					`Worker preference: ${workerSelectionLabel(workerSelection)}; effective model: ${detail}.${"error" in selected ? ` ${selected.error}` : ""}`,
					"info",
				);
				return;
			}
			if (command.type === "select") {
				const mode = (ctx as typeof ctx & { mode?: string }).mode;
				if (mode !== "tui") {
					ctx.ui.notify("/worker-model select requires TUI mode; use /worker-model provider/model instead", "warning");
					return;
				}
				const modelRef = await selectWorkerModel(ctx, workerSelectionModelRef(workerSelection));
				if (modelRef) setWorkerSelection({ kind: "model", modelRef }, ctx);
				return;
			}
			if (command.type === "invalid") {
				ctx.ui.notify("Usage: /worker-model [spark|luna|select|status|provider/model]", "warning");
				return;
			}
			if (command.type === "model") ctx.modelRegistry.refresh();
			const next =
				command.type === "toggle"
					? nextWorkerPresetSelection(workerSelection)
					: command.type === "preset"
						? { kind: "preset" as const, preset: command.preset }
						: { kind: "model" as const, modelRef: command.modelRef };
			setWorkerSelection(next, ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		await settingsWriteQueue.catch(() => undefined);
		try {
			workerSelection = await loadWorkerSelection();
		} catch (error) {
			if (ctx.hasUI) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`worker-model: failed to load settings: ${message}`, "warning");
			}
		}
		updateStatus(ctx);
	});

	pi.registerTool({
		name: "run_worker",
		label: "Run Worker",
		description:
			"Run a potentially noisy command, save the full log, and delegate concise pass/fail diagnosis to a bounded read-only worker agent.",
		promptSnippet: "Run noisy checks through run_worker: execute a command, preserve the full log, and get a concise delegated diagnosis.",
		promptGuidelines: [
			"Prefer run_worker over bash for tests, typechecks, builds, integration checks, or commands expected to produce large/noisy output.",
			"Give run_worker a clear task describing what to extract or diagnose from the command result.",
			"Do not use run_worker for subjective code review; use review_agents so review tasks use the dedicated review model and shared pinned diff.",
			"Use bash directly for small commands where raw output is useful; use the saved run_worker log for drill-down when needed.",
		],
		parameters: RunWorkerParams,
		executionMode: "parallel",
		async execute(_toolCallId, params: RunWorkerParamsType, signal, onUpdate, ctx) {
			if (process.env.PI_AGENTGRAPH_MODE === "1") {
				throw new Error("run_worker is disabled in AgentGraph restricted mode because it can execute arbitrary commands.");
			}
			if (params.command.length === 0 || params.command.some((part) => part.length === 0)) {
				throw new Error("run_worker command must be a non-empty argv array.");
			}

			const timeoutMs = Math.max(1, Math.min(params.timeout_ms ?? DEFAULT_TIMEOUT_MS, 4 * 60 * 60 * 1000));
			const maxLogBytes = Math.max(1_000, Math.min(params.max_log_bytes_for_worker ?? DEFAULT_MAX_LOG_BYTES_FOR_WORKER, 500_000));
			const workerRoot = path.resolve(ctx.cwd, WORKER_ROOT);
			await mkdir(workerRoot, { recursive: true, mode: 0o700 });
			let runDir = "";
			for (let attempt = 0; attempt < 5; attempt += 1) {
				const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${slugify(params.name)}-${randomBytes(6).toString("hex")}`;
				const candidate = path.join(workerRoot, id);
				try { await mkdir(candidate, { mode: 0o700 }); runDir = candidate; break; } catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				}
			}
			if (!runDir) throw new Error("Could not allocate a unique worker artifact directory.");
			const logPath = path.join(runDir, "command.log");
			const resultPath = path.join(runDir, "result.json");
			await writeFile(path.join(runDir, "task.txt"), `${params.task}\n`, { encoding: "utf8", mode: 0o600 });

			onUpdate?.({ content: [{ type: "text", text: `Running worker command: ${params.name}` }], details: { command: params.command } });
			const result = await runDurableCommand({ cwd: ctx.cwd, command: params.command, logPath, resultPath, signal, timeoutMs });
			const fullLog = await readFile(logPath, "utf8");
			const logExcerpt = balancedLogExcerpt(fullLog, maxLogBytes);

			let workerSummary: string;
			let workerModel: string | undefined;
			let workerError: string | undefined;
			try {
				onUpdate?.({ content: [{ type: "text", text: `Delegating log summary: ${params.name}` }], details: { log: repoRelative(ctx.cwd, logPath) } });
				const worker = await askWorker(ctx, workerSelection, params, result, logExcerpt, signal);
				workerSummary = worker.summary;
				workerModel = worker.modelRef;
				if (!workerSummary) workerSummary = fallbackSummary(params, result);
			} catch (error) {
				workerError = error instanceof Error ? error.message : String(error);
				workerSummary = fallbackSummary(params, result);
			}

			const status = result.cancelled ? "cancelled" : result.timedOut ? "timeout" : result.code === 0 ? "pass" : "fail";
			await writeDurableResult(resultPath, {
				...result,
				status,
				diagnosis: { summary: workerSummary, model: workerModel, error: workerError },
			});
			const text = [
				`status: ${status}`,
				`exit_code: ${result.code ?? "null"}`,
				`duration_ms: ${result.durationMs}`,
				`log: ${repoRelative(ctx.cwd, logPath)}`,
				`result: ${repoRelative(ctx.cwd, resultPath)}`,
				workerModel ? `worker_model: ${workerModel}` : undefined,
				workerError ? `worker_warning: ${workerError}` : undefined,
				"",
				"worker_summary:",
				workerSummary,
			]
				.filter((line) => line !== undefined)
				.join("\n");

			return {
				content: [{ type: "text", text }],
				details: {
					status,
					exit_code: result.code,
					duration_ms: result.durationMs,
					log: repoRelative(ctx.cwd, logPath),
					result: repoRelative(ctx.cwd, resultPath),
					worker_model: workerModel,
					worker_error: workerError,
				},
			};
		},
	});
}
