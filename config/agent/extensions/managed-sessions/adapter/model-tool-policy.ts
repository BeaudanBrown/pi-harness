import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const MANAGED_LOCAL_MODEL_TOOLS_ENV = "PI_MANAGED_LOCAL_MODEL_TOOLS";
export const RESTRICTED_MODEL_PROVIDER = "local-llm";
export const MANAGED_TRANSPORT_TOOLS = ["remote_checkpoint", "remote_artifact_export"] as const;

const MAX_POLICY_TOOLS = 64;
const TOOL_NAME = /^[a-z][a-z0-9_]{0,127}$/;

export function parseManagedLocalModelTools(value: string | undefined): string[] {
	if (!value) throw new Error(`${MANAGED_LOCAL_MODEL_TOOLS_ENV} is required`);
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new Error(`${MANAGED_LOCAL_MODEL_TOOLS_ENV} must be a JSON string array`);
	}
	if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > MAX_POLICY_TOOLS
		|| parsed.some((tool) => typeof tool !== "string" || !TOOL_NAME.test(tool))) {
		throw new Error(`${MANAGED_LOCAL_MODEL_TOOLS_ENV} must contain 1-${MAX_POLICY_TOOLS} valid tool names`);
	}
	if (new Set(parsed).size !== parsed.length) throw new Error(`${MANAGED_LOCAL_MODEL_TOOLS_ENV} must not contain duplicate tool names`);
	return parsed;
}

function unique(values: readonly string[]): string[] {
	return [...new Set(values)];
}

function usesRestrictedProvider(ctx: Pick<ExtensionContext, "model">): boolean {
	return ctx.model?.provider === RESTRICTED_MODEL_PROVIDER;
}

export function registerManagedModelToolPolicy(
	pi: ExtensionAPI,
	configuredTools = parseManagedLocalModelTools(process.env[MANAGED_LOCAL_MODEL_TOOLS_ENV]),
): void {
	const transportTools = new Set<string>(MANAGED_TRANSPORT_TOOLS);
	const permittedTools = new Set([...configuredTools, ...MANAGED_TRANSPORT_TOOLS]);
	let unrestrictedSnapshot: string[] | undefined;

	const restore = (): void => {
		if (!unrestrictedSnapshot) return;
		const activeTransport = pi.getActiveTools().filter((tool) => transportTools.has(tool));
		pi.setActiveTools(unique([...unrestrictedSnapshot, ...activeTransport]));
		unrestrictedSnapshot = undefined;
	};

	const apply = (restricted: boolean): void => {
		if (!restricted) {
			restore();
			return;
		}
		const active = pi.getActiveTools();
		if (!unrestrictedSnapshot) unrestrictedSnapshot = active.filter((tool) => !transportTools.has(tool));
		pi.setActiveTools(active.filter((tool) => permittedTools.has(tool)));
	};

	pi.on("session_start", (_event, ctx) => {
		// Active tools are process-global. Restore the prior session before deriving
		// policy for a native session switch, /new, or resumed local-model session.
		restore();
		apply(usesRestrictedProvider(ctx));
	});
	pi.on("model_select", (event) => apply(event.model.provider === RESTRICTED_MODEL_PROVIDER));
	pi.on("tool_call", (event, ctx) => {
		if (!usesRestrictedProvider(ctx)) return;
		const active = new Set(pi.getActiveTools());
		if (permittedTools.has(event.toolName) && active.has(event.toolName)) return;
		return {
			block: true,
			terminate: true,
			reason: `Tool ${event.toolName} is unavailable while using ${RESTRICTED_MODEL_PROVIDER}.`,
		};
	});
}

export default registerManagedModelToolPolicy;
