import type { parseArgs } from "@earendil-works/pi-coding-agent";

type NativeArguments = ReturnType<typeof parseArgs>;
export interface LaunchModeContext {
	configured: boolean;
	localOnly: boolean;
	stdinIsTTY: boolean;
	stdoutIsTTY: boolean;
	/** Supplied only by the intentional managed dispatcher, never inferred from RPC mode. */
	trustedDispatch: boolean;
	internalWorker: boolean;
	profile?: string;
	experimentsEnabled: boolean;
}
export type LaunchMode =
	| { kind: "candidate" }
	| { kind: "local-only" }
	| { kind: "dispatch" }
	| { kind: "native"; reason: "not-configured" | "command" | "diagnostic" | "headless" | "ephemeral" | "worker" | "experiment" };

const ADMIN_COMMANDS = new Set(["install", "remove", "uninstall", "update", "list", "config", "auth"]);

/**
 * Decide ambient launch eligibility from Pi's public parseArgs result, not shell
 * token heuristics. A candidate still needs host Git/root and session authority.
 * This is neither authentication nor permission to open a writable saved session.
 */
export function classifyLaunchMode(argv: readonly string[], parsed: NativeArguments, context: LaunchModeContext): LaunchMode {
	if (context.localOnly) return { kind: "local-only" };
	if (context.trustedDispatch) return { kind: "dispatch" };
	if (!context.configured) return { kind: "native", reason: "not-configured" };
	if (ADMIN_COMMANDS.has(argv[0] ?? "")) return { kind: "native", reason: "command" };
	if (parsed.help || parsed.version || parsed.export !== undefined || parsed.listModels !== undefined || parsed.diagnostics.some(item => item.type === "error")) {
		return { kind: "native", reason: "diagnostic" };
	}
	if (context.internalWorker || (context.profile && context.profile !== "engineering-full")) return { kind: "native", reason: "worker" };
	if (context.experimentsEnabled) return { kind: "native", reason: "experiment" };
	// Pi's --mode text is still interactive with both terminals unless --print is set.
	if (parsed.mode === "rpc" || parsed.mode === "json" || parsed.print || !context.stdinIsTTY || !context.stdoutIsTTY) {
		return { kind: "native", reason: "headless" };
	}
	if (parsed.noSession) return { kind: "native", reason: "ephemeral" };
	return { kind: "candidate" };
}
