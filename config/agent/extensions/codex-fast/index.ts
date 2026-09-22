import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "codex-fast";
const STATE_ENTRY_TYPE = "codex-fast.state";

interface CodexFastState {
	version: 1;
	sessionId: string;
	enabled: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asState(value: unknown): CodexFastState | undefined {
	if (!isRecord(value) || value.version !== 1 || typeof value.sessionId !== "string" || typeof value.enabled !== "boolean") return undefined;
	return { version: 1, sessionId: value.sessionId, enabled: value.enabled };
}

function supportsPriorityServiceTier(ctx: ExtensionContext): boolean {
	return ctx.model?.provider === "openai" || ctx.model?.provider === "openai-codex";
}

export default function codexFastExtension(pi: ExtensionAPI): void {
	let fastModeEnabled = false;

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
			ctx.ui.notify("Fast mode enabled for this session. OpenAI/OpenAI Codex requests will send service_tier=priority.", "info");
			return;
		}

		const modelLabel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "no active model";
		ctx.ui.notify(
			`Fast mode enabled for this session. It will apply once you switch to an OpenAI or OpenAI Codex model (current: ${modelLabel}).`,
			"info",
		);
	}

	function setFastMode(enabled: boolean, ctx: ExtensionContext, options?: { persist?: boolean; notify?: boolean }): void {
		fastModeEnabled = enabled;
		if (options?.persist !== false) {
			pi.appendEntry(STATE_ENTRY_TYPE, {
				version: 1,
				sessionId: ctx.sessionManager.getSessionId(),
				enabled,
			} satisfies CodexFastState);
		}
		updateStatus(ctx);
		if (options?.notify !== false) notifyState(ctx);
	}

	function restoreFastMode(ctx: ExtensionContext, includeStartupFlag: boolean): void {
		fastModeEnabled = false;
		const sessionId = ctx.sessionManager.getSessionId();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== STATE_ENTRY_TYPE) continue;
			const state = asState(entry.data);
			if (state?.sessionId === sessionId) fastModeEnabled = state.enabled;
		}

		if (includeStartupFlag && pi.getFlag("fast") === true && !fastModeEnabled) {
			setFastMode(true, ctx, { notify: false });
			return;
		}
		updateStatus(ctx);
	}

	pi.registerFlag("fast", {
		description: "Start this session with fast mode enabled (adds service_tier=priority to OpenAI/OpenAI Codex requests)",
		type: "boolean",
		default: false,
	});

	pi.registerCommand("codex-fast", {
		description: "Toggle OpenAI/OpenAI Codex priority service tier for this session",
		handler: async (_args, ctx) => {
			setFastMode(!fastModeEnabled, ctx);
		},
	});

	pi.on("session_start", (event, ctx) => {
		restoreFastMode(ctx, event.reason === "startup");
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
