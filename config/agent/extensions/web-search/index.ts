import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

const execAsync = promisify(exec);

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-5-mini";
const DEFAULT_MAX_OUTPUT_TOKENS = 1200;

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

interface WebSearchDetails {
	query: string;
	model: string;
	baseUrl: string;
	depth: "quick" | "standard" | "deep";
	sources: Array<{ title?: string; url: string }>;
}

interface ResponseAnnotation {
	type?: string;
	url?: string;
	title?: string;
}

interface ResponseContent {
	type?: string;
	text?: string;
	annotations?: ResponseAnnotation[];
}

interface ResponseOutputItem {
	type?: string;
	content?: ResponseContent[];
	action?: {
		sources?: Array<{ title?: string; url?: string }>;
	};
}

function cleanDomain(domain: string): string {
	return domain.replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

function compactList(values: string[] | undefined): string[] | undefined {
	const cleaned = (values ?? []).map((value) => cleanDomain(value.trim())).filter(Boolean);
	return cleaned.length > 0 ? cleaned : undefined;
}

async function resolveApiKey(): Promise<string> {
	if (process.env.PI_WEB_SEARCH_API_KEY) return process.env.PI_WEB_SEARCH_API_KEY;
	if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;

	const command = process.env.PI_WEB_SEARCH_API_KEY_COMMAND;
	if (!command) {
		throw new Error(
			"Set PI_WEB_SEARCH_API_KEY, OPENAI_API_KEY, or PI_WEB_SEARCH_API_KEY_COMMAND for the web_search Pi extension.",
		);
	}

	const { stdout } = await execAsync(command, {
		timeout: 5000,
		maxBuffer: 64 * 1024,
	});
	return stdout.trim();
}

function reasoningForDepth(depth: "quick" | "standard" | "deep"): "low" | "medium" | "high" {
	if (depth === "deep") return "high";
	if (depth === "standard") return "medium";
	return "low";
}

function extractText(output: ResponseOutputItem[]): string {
	const parts: string[] = [];
	for (const item of output) {
		if (item.type !== "message") continue;
		for (const content of item.content ?? []) {
			if (content.type === "output_text" && content.text) {
				parts.push(content.text);
			}
		}
	}
	return parts.join("\n\n").trim();
}

function extractSources(output: ResponseOutputItem[]): Array<{ title?: string; url: string }> {
	const sources = new Map<string, { title?: string; url: string }>();

	for (const item of output) {
		for (const source of item.action?.sources ?? []) {
			if (source.url) sources.set(source.url, { title: source.title, url: source.url });
		}

		for (const content of item.content ?? []) {
			for (const annotation of content.annotations ?? []) {
				if (annotation.type === "url_citation" && annotation.url) {
					sources.set(annotation.url, { title: annotation.title, url: annotation.url });
				}
			}
		}
	}

	return [...sources.values()];
}

function formatResult(answer: string, sources: Array<{ title?: string; url: string }>): string {
	const lines = [answer || "No answer returned."];

	if (sources.length > 0) {
		lines.push("", "Sources:");
		for (const source of sources.slice(0, 12)) {
			const label = source.title ? `${source.title}: ` : "";
			lines.push(`- ${label}${source.url}`);
		}
	}

	return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the live web for current information and return a compact answer with source URLs. Use for recent facts, external documentation, prices, schedules, laws, and other time-sensitive information.",
		parameters: WebSearchParams,

		async execute(_toolCallId, params, signal, onUpdate) {
			const depth = params.depth ?? "quick";
			const model = process.env.PI_WEB_SEARCH_MODEL || DEFAULT_MODEL;
			const baseUrl = (process.env.PI_WEB_SEARCH_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
			const apiKey = await resolveApiKey();
			const allowedDomains = compactList(params.allowed_domains);
			const blockedDomains = compactList(params.blocked_domains);

			onUpdate?.({
				content: [{ type: "text", text: `Searching the web for: ${params.query}` }],
				details: {},
			});

			const filters =
				allowedDomains || blockedDomains
					? {
							...(allowedDomains ? { allowed_domains: allowedDomains } : {}),
							...(blockedDomains ? { blocked_domains: blockedDomains } : {}),
						}
					: undefined;

			const response = await fetch(`${baseUrl}/responses`, {
				method: "POST",
				signal,
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${apiKey}`,
				},
				body: JSON.stringify({
					model,
					reasoning: { effort: reasoningForDepth(depth) },
					tools: [
						{
							type: "web_search",
							external_web_access: params.live ?? true,
							...(filters ? { filters } : {}),
						},
					],
					tool_choice: "auto",
					include: ["web_search_call.action.sources"],
					max_output_tokens: DEFAULT_MAX_OUTPUT_TOKENS,
					instructions:
						"Answer concisely. Prefer primary sources. Include enough source URLs for verification. Do not include unsupported claims.",
					input: params.query,
				}),
			});

			if (!response.ok) {
				const body = await response.text();
				throw new Error(`web_search request failed (${response.status}): ${body.slice(0, 1000)}`);
			}

			const payload = (await response.json()) as { output?: ResponseOutputItem[]; output_text?: string };
			const output = payload.output ?? [];
			const sources = extractSources(output);
			const answer = payload.output_text?.trim() || extractText(output);

			return {
				content: [{ type: "text", text: formatResult(answer, sources) }],
				details: {
					query: params.query,
					model,
					baseUrl,
					depth,
					sources,
				} as WebSearchDetails,
			};
		},
	});
}
