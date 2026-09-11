import { Buffer } from "node:buffer";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const DEFAULT_MODEL = "gpt-5.6-luna";
const SEARCH_TIMEOUT_MS = 60_000;
export const MAX_SEARCH_CONTEXT_BYTES = 48_000;

const WebSearchParams = Type.Object({
	query: Type.String({
		description: "The web search query or research question.",
	}),
	depth: Type.Optional(
		Type.Union(
			[
				Type.Literal("quick"),
				Type.Literal("standard"),
				Type.Literal("deep"),
			],
			{
				description: "Search depth. Use quick for lookups, standard for normal research, and deep for more careful synthesis.",
			},
		),
	),
	allowed_domains: Type.Optional(
		Type.Array(Type.String(), {
			description: "Optional list of domains to allow, without https:// prefixes.",
		}),
	),
	blocked_domains: Type.Optional(
		Type.Array(Type.String(), {
			description: "Optional list of domains to block, without https:// prefixes.",
		}),
	),
	live: Type.Optional(
		Type.Boolean({
			description: "Whether to allow live external web access. Defaults to true.",
		}),
	),
});

type Depth = "quick" | "standard" | "deep";

interface WebSearchParamsValue {
	query: string;
	depth?: Depth;
	allowed_domains?: string[];
	blocked_domains?: string[];
	live?: boolean;
}

interface Source {
	title: string;
	url: string;
}

interface WebSearchDetails {
	query: string;
	model: string;
	depth: Depth;
	sources: Source[];
}

function cleanDomain(domain: string): string {
	return domain.replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

function compactDomains(domains: string[] | undefined): string[] {
	return (domains ?? []).map(domain => cleanDomain(domain.trim())).filter(Boolean);
}

function accountIdFromToken(token: string): string {
	try {
		const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as {
			"https://api.openai.com/auth"?: { chatgpt_account_id?: unknown };
		};
		const accountId = payload["https://api.openai.com/auth"]?.chatgpt_account_id;
		if (typeof accountId === "string" && accountId) return accountId;
	} catch {
		// Fall through to the actionable error below.
	}
	throw new Error("Pi's OpenAI Codex credential is missing a ChatGPT account ID. Run /login and sign in to ChatGPT again.");
}

function searchInstructions(params: WebSearchParamsValue, depth: Depth): string {
	const allowedDomains = compactDomains(params.allowed_domains);
	const blockedDomains = compactDomains(params.blocked_domains);
	const domainRules = [
		allowedDomains.length > 0 ? `Only use these domains: ${allowedDomains.join(", ")}.` : "",
		blockedDomains.length > 0 ? `Do not use these domains: ${blockedDomains.join(", ")}.` : "",
	]
		.filter(Boolean)
		.join(" ");

	return [
		"Search the public web and answer the user's question accurately.",
		depth === "quick" ? "Be brief; use only the sources necessary to answer." : "Prefer primary sources and include source URLs for verification.",
		depth === "deep" ? "Investigate carefully and reconcile conflicting sources before answering." : "",
		params.live === false ? "Cached results are acceptable; prioritize accuracy over recency." : "Prioritize current information.",
		domainRules,
		"Answer concisely. Do not make claims unsupported by the sources.",
	]
		.filter(Boolean)
		.join(" ");
}

function contextText(text: string): string {
	const bytes = Buffer.from(text);
	if (bytes.length <= MAX_SEARCH_CONTEXT_BYTES) return text;
	const marker = "\n\n[Search result truncated to fit the context limit.]";
	let end = MAX_SEARCH_CONTEXT_BYTES - Buffer.byteLength(marker);
	while ((bytes[end] & 0xc0) === 0x80) end--;
	return bytes.subarray(0, end).toString("utf8") + marker;
}

function extractTextFromSse(text: string): string {
	let output = "";
	for (const event of text.split("\n\n")) {
		const data = event
			.split("\n")
			.filter(line => line.startsWith("data:"))
			.map(line => line.slice(5).trim())
			.join("\n");
		if (!data || data === "[DONE]") continue;
		try {
			const payload = JSON.parse(data) as { type?: string; delta?: unknown };
			if (payload.type === "response.output_text.delta" && typeof payload.delta === "string") output += payload.delta;
		} catch {
			// Ignore non-JSON SSE frames.
		}
	}
	return output.trim();
}

function extractSources(text: string): Source[] {
	const urls = text.match(/https?:\/\/[^\s)\]}>,]+/g) ?? [];
	return [...new Set(urls)].slice(0, 12).map(url => ({ title: "", url }));
}

function formatResult(answer: string, sources: Source[]): string {
	const lines = [answer || "No answer returned."];
	if (sources.length > 0) {
		lines.push("", "Sources:");
		for (const source of sources) lines.push(`- ${source.url}`);
	}
	return lines.join("\n");
}

export function createWebSearchTool(modelOverride?: string, resolveToken?: (ctx: ExtensionContext, signal?: AbortSignal) => Promise<string | undefined>): ToolDefinition<typeof WebSearchParams> {
	return {
		name: "web_search",
		label: "Web Search",
		description:
			"Search the live web with the user's ChatGPT/Codex subscription and return a compact answer with source URLs. Use for recent facts, external documentation, prices, schedules, laws, and other time-sensitive information.",
		parameters: WebSearchParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const input = params as WebSearchParamsValue;
			const depth = input.depth ?? "quick";
			const model = modelOverride ?? (process.env.PI_CODEX_WEB_SEARCH_MODEL?.trim() || DEFAULT_MODEL);
			signal?.throwIfAborted();
			const accessToken = resolveToken ? await resolveToken(ctx, signal) : await ctx.modelRegistry.getApiKeyForProvider("openai-codex");
			signal?.throwIfAborted();
			if (!accessToken) {
				throw new Error("Web search requires Pi's ChatGPT/Codex login. Run /login and select ChatGPT Plus/Pro (Codex).");
			}
			const accountId = accountIdFromToken(accessToken);

			onUpdate?.({
				content: [{ type: "text", text: `Searching the web for: ${input.query}` }],
				details: {},
			});

			const timeout = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
			const abortController = new AbortController();
			const abort = () => abortController.abort(signal?.reason ?? timeout.reason);
			signal?.addEventListener("abort", abort, { once: true });
			timeout.addEventListener("abort", abort, { once: true });

			try {
				const response = await fetch(CODEX_RESPONSES_URL, {
					method: "POST",
					signal: abortController.signal,
					headers: {
						accept: "text/event-stream",
						"content-type": "application/json",
						authorization: `Bearer ${accessToken}`,
						"chatgpt-account-id": accountId,
						originator: "pi-harness",
					},
					body: JSON.stringify({
						model,
						instructions: searchInstructions(input, depth),
						input: [{ role: "user", content: input.query }],
						tools: [{ type: "web_search" }],
						tool_choice: { type: "web_search" },
						text: { verbosity: "low" },
						store: false,
						stream: true,
					}),
				});

				const body = await response.text();
				if (!response.ok) {
					if (response.status === 401) {
						throw new Error("Pi's ChatGPT/Codex login was rejected. Run /login and sign in again.");
					}
					throw new Error(`Codex web search request failed (${response.status}): ${body.slice(0, 1000)}`);
				}

				const answer = extractTextFromSse(body);
				const sources = extractSources(answer);
				return {
					content: [{ type: "text", text: contextText(formatResult(answer, sources)) }],
					details: { query: input.query, model, depth, sources } satisfies WebSearchDetails,
				};
			} finally {
				signal?.removeEventListener("abort", abort);
				timeout.removeEventListener("abort", abort);
			}
		},
	};
}

export default function (pi: ExtensionAPI) {
	pi.registerTool(createWebSearchTool());
}
