import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadPreference, readJsonObject, savePreference } from "../shared/preferences.js";

const STATUS_KEY = "codex-fast";
const SETTINGS_KEY = "pi-codex-fast";

interface CodexFastSettings {
	enabled?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asSettings(value: unknown): CodexFastSettings | undefined {
	if (!isRecord(value)) return undefined;
	return typeof value.enabled === "boolean" ? { enabled: value.enabled } : undefined;
}

function supportsPriorityServiceTier(ctx: ExtensionContext): boolean {
	return ctx.model?.provider === "openai" || ctx.model?.provider === "openai-codex";
}

async function loadFastMode(cwd: string): Promise<boolean | undefined> {
	const globalFast = asSettings(await loadPreference(SETTINGS_KEY, getAgentDir()));
	const projectSettings = await readJsonObject(join(cwd, ".pi", "settings.json"));
	return asSettings(projectSettings[SETTINGS_KEY])?.enabled ?? globalFast?.enabled;
}

export default function codexFastExtension(pi: ExtensionAPI): void {
	let fastModeEnabled = false;
	let settingsWriteQueue: Promise<void> = Promise.resolve();

	function updateStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		if (!fastModeEnabled) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}

		const label = supportsPriorityServiceTier(ctx) ? "fast" : "fast (inactive)";
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("accent", label));
	}

	function notifyState(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		if (!fastModeEnabled) {
			ctx.ui.notify("Fast mode disabled. OpenAI/OpenAI Codex requests will use the default service tier.", "info");
			return;
		}

		if (supportsPriorityServiceTier(ctx)) {
			ctx.ui.notify("Fast mode enabled. OpenAI/OpenAI Codex requests will send service_tier=priority.", "info");
			return;
		}

		const modelLabel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "no active model";
		ctx.ui.notify(
			`Fast mode enabled. It will apply once you switch to an OpenAI or OpenAI Codex model (current: ${modelLabel}).`,
			"info",
		);
	}

	function persistState(enabled: boolean, ctx: ExtensionContext): void {
		settingsWriteQueue = settingsWriteQueue
			.catch(() => undefined)
			.then(() => savePreference(SETTINGS_KEY, { enabled }, getAgentDir()));

		void settingsWriteQueue.catch((error: unknown) => {
			if (!ctx.hasUI) return;
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`codex-fast: failed to write settings: ${message}`, "warning");
		});
	}

	function setFastMode(enabled: boolean, ctx: ExtensionContext, options?: { persist?: boolean; notify?: boolean }): void {
		fastModeEnabled = enabled;
		if (options?.persist !== false) persistState(enabled, ctx);
		updateStatus(ctx);
		if (options?.notify !== false) notifyState(ctx);
	}

	async function reloadFastModeState(ctx: ExtensionContext, options?: { includeStartupFlag?: boolean }): Promise<void> {
		await settingsWriteQueue.catch(() => undefined);
		fastModeEnabled = false;

		try {
			const persistedEnabled = await loadFastMode(ctx.cwd);
			if (typeof persistedEnabled === "boolean") fastModeEnabled = persistedEnabled;
		} catch (error) {
			if (ctx.hasUI) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`codex-fast: failed to load settings: ${message}`, "warning");
			}
		}

		if (options?.includeStartupFlag && pi.getFlag("fast") === true) {
			fastModeEnabled = true;
		}

		updateStatus(ctx);
	}

	pi.registerFlag("fast", {
		description: "Start with fast mode enabled (adds service_tier=priority to OpenAI/OpenAI Codex requests)",
		type: "boolean",
		default: false,
	});

	pi.registerCommand("codex-fast", {
		description: "Toggle OpenAI/OpenAI Codex priority service tier",
		handler: async (_args, ctx) => {
			setFastMode(!fastModeEnabled, ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		await reloadFastModeState(ctx, { includeStartupFlag: true });
	});

	pi.on("model_select", async (_event, ctx) => {
		updateStatus(ctx);
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (!fastModeEnabled || !supportsPriorityServiceTier(ctx) || !isRecord(event.payload)) {
			return;
		}

		if (Object.prototype.hasOwnProperty.call(event.payload, "service_tier")) {
			return;
		}

		return {
			...event.payload,
			service_tier: "priority",
		};
	});
}
