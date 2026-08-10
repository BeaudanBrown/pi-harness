export const DEFAULT_WORKER_MODEL = "openai-codex/gpt-5.3-codex-spark";
export const LUNA_WORKER_MODEL = "openai-codex/gpt-5.6-luna";

export type WorkerMode = "spark" | "luna";
export type WorkerModelSelection =
	| { kind: "preset"; preset: WorkerMode }
	| { kind: "model"; modelRef: string };

export type WorkerModelCommand =
	| { type: "toggle" }
	| { type: "status" }
	| { type: "select" }
	| { type: "preset"; preset: WorkerMode }
	| { type: "model"; modelRef: string }
	| { type: "invalid"; input: string };

export const DEFAULT_WORKER_SELECTION: WorkerModelSelection = { kind: "preset", preset: "spark" };

export function isWorkerMode(value: unknown): value is WorkerMode {
	return value === "spark" || value === "luna";
}

export function workerModelForMode(mode: WorkerMode): string {
	return mode === "luna" ? LUNA_WORKER_MODEL : DEFAULT_WORKER_MODEL;
}

export function parseWorkerModelRef(value: string): { provider: string; id: string } | undefined {
	const slash = value.indexOf("/");
	if (slash <= 0 || slash === value.length - 1) return undefined;
	return { provider: value.slice(0, slash), id: value.slice(slash + 1) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isWorkerModelSelection(value: unknown): value is WorkerModelSelection {
	if (!isRecord(value)) return false;
	if (value.kind === "preset") return isWorkerMode(value.preset);
	return value.kind === "model" && typeof value.modelRef === "string" && parseWorkerModelRef(value.modelRef) !== undefined;
}

export function workerSelectionFromSettings(value: unknown): WorkerModelSelection {
	if (!isRecord(value)) return DEFAULT_WORKER_SELECTION;
	if (isWorkerModelSelection(value.selection)) return value.selection;
	if (isWorkerMode(value.mode)) return { kind: "preset", preset: value.mode };
	return DEFAULT_WORKER_SELECTION;
}

export function workerSelectionToSettings(selection: WorkerModelSelection): { selection: WorkerModelSelection } {
	return { selection };
}

export function nextWorkerPresetSelection(selection: WorkerModelSelection): WorkerModelSelection {
	if (selection.kind === "preset" && selection.preset === "spark") return { kind: "preset", preset: "luna" };
	return { kind: "preset", preset: "spark" };
}

export function workerSelectionModelRef(selection: WorkerModelSelection): string {
	return selection.kind === "preset" ? workerModelForMode(selection.preset) : selection.modelRef;
}

export function workerSelectionLabel(selection: WorkerModelSelection): string {
	return selection.kind === "preset" ? selection.preset : selection.modelRef;
}

export function parseWorkerModelCommand(args: string): WorkerModelCommand {
	const input = args.trim();
	if (!input) return { type: "toggle" };
	const keyword = input.toLowerCase();
	if (keyword === "status") return { type: "status" };
	if (keyword === "select") return { type: "select" };
	if (isWorkerMode(keyword)) return { type: "preset", preset: keyword };
	if (parseWorkerModelRef(input)) return { type: "model", modelRef: input };
	return { type: "invalid", input };
}

export function workerModelSearchText(model: { provider: string; id: string; name?: string }): string {
	const name = model.name ? ` ${model.name}` : "";
	return `${model.provider} ${model.provider}/${model.id} ${model.provider} ${model.id}${name}`;
}

/**
 * An environment override is intentional and must not be silently bypassed.
 * Luna and explicitly selected models deliberately have no parent-model
 * fallback: unavailable explicit choices must fail clearly.
 */
export function workerModelCandidates(options: {
	selection: WorkerModelSelection;
	environmentOverride?: string;
	parentModel?: string;
}): string[] {
	const environmentOverride = options.environmentOverride?.trim();
	if (environmentOverride) return [environmentOverride];

	const selected = workerSelectionModelRef(options.selection);
	if (options.selection.kind === "preset" && options.selection.preset === "spark") {
		return [selected, options.parentModel].filter((value): value is string => Boolean(value));
	}
	return [selected];
}
