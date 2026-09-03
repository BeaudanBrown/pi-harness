import { appendFile, readFile } from "node:fs/promises";

export type NestedModelUsage = {
	source: string;
	provider?: string;
	model?: string;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	cost: number;
};

function number(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

export function collectSessionUsage(messages: unknown[], source: string): NestedModelUsage[] {
	return messages.flatMap((message: any) => {
		if (message?.role !== "assistant" || !message.usage || typeof message.usage !== "object") return [];
		return [{
			source,
			...(typeof message.provider === "string" ? { provider: message.provider } : {}),
			...(typeof message.model === "string" ? { model: message.model } : {}),
			inputTokens: number(message.usage.input ?? message.usage.inputTokens),
			outputTokens: number(message.usage.output ?? message.usage.outputTokens),
			cacheReadTokens: number(message.usage.cacheRead ?? message.usage.cacheReadTokens),
			cacheWriteTokens: number(message.usage.cacheWrite ?? message.usage.cacheWriteTokens),
			cost: number(message.usage.cost?.total ?? message.usage.cost),
		}];
	});
}

export async function recordNestedModelUsage(messages: unknown[], source: string): Promise<void> {
	const pathname = process.env.PI_ALOOP_USAGE_LEDGER?.trim();
	if (!pathname) return;
	for (const usage of collectSessionUsage(messages, source)) await appendFile(pathname, `${JSON.stringify(usage)}\n`, { encoding: "utf8", mode: 0o600 });
}

export async function readNestedModelUsage(pathname: string): Promise<NestedModelUsage[]> {
	try {
		return (await readFile(pathname, "utf8")).split("\n").filter(Boolean).flatMap((line) => {
			try { return [JSON.parse(line) as NestedModelUsage]; } catch { return []; }
		});
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}
