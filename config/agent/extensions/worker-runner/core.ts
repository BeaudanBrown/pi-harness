export const DEFAULT_WORKER_MODEL = "openai-codex/gpt-5.3-codex-spark";
export const LUNA_WORKER_MODEL = "openai-codex/gpt-5.6-luna";

export type WorkerMode = "spark" | "luna";

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

/**
 * An environment override is intentional and must not be silently bypassed.
 * Luna also deliberately has no parent-model fallback: selecting it must not
 * consume Spark usage because Luna is unavailable.
 */
export function workerModelCandidates(options: {
	mode: WorkerMode;
	environmentOverride?: string;
	parentModel?: string;
}): string[] {
	const environmentOverride = options.environmentOverride?.trim();
	if (environmentOverride) return [environmentOverride];

	const selected = workerModelForMode(options.mode);
	if (options.mode === "luna") return [selected];
	return [selected, options.parentModel].filter((value): value is string => Boolean(value));
}
