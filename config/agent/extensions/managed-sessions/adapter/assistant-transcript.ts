/** Persisted assistant text only. Never call this on streaming deltas. */
export interface AssistantTranscriptPart {
	kind: "assistant_commentary" | "assistant_final";
	/** Index of the first text block in the original persisted content array. */
	contentIndex: number;
	body: string;
}

type Phase = "commentary" | "final_answer";
function textPhase(signature: unknown): Phase | "unknown" | undefined {
	if (signature === undefined) return undefined;
	if (typeof signature !== "string") return "unknown";
	// Older providers use opaque string IDs; only the versioned Pi signature
	// contains phase metadata. Do not guess from text, signatures or tool names.
	if (!signature.startsWith("{")) return undefined;
	try {
		const parsed = JSON.parse(signature) as Record<string, unknown>;
		if (parsed.v !== 1 || typeof parsed.id !== "string" || !parsed.id) return "unknown";
		if (parsed.phase === undefined) return undefined;
		return parsed.phase === "commentary" || parsed.phase === "final_answer" ? parsed.phase : "unknown";
	} catch { return "unknown"; }
}

export function assistantTranscriptParts(value: unknown): AssistantTranscriptPart[] {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
	const message = value as Record<string, unknown>;
	// Error/abort/length/pending can contain unfinished text. Only completed
	// response messages (including the text preceding tool calls) are projected.
	if (message.role !== "assistant" || (message.stopReason !== "stop" && message.stopReason !== "toolUse")) return [];
	const content = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
	if (!Array.isArray(content)) return [];
	const parts: AssistantTranscriptPart[] = [];
	for (let index = 0; index < content.length; index += 1) {
		const item: unknown = content[index];
		if (typeof item !== "object" || item === null || Array.isArray(item)) return [];
		const block = item as Record<string, unknown>;
		if (block.type === "thinking" || block.type === "toolCall") continue;
		if (block.type !== "text" || typeof block.text !== "string") return [];
		const phase = textPhase(block.textSignature);
		if (phase === "unknown") return []; // A future phase needs an explicit contract.
		if (!block.text) continue;
		const kind = phase === "commentary" || (phase === undefined && message.stopReason === "toolUse") ? "assistant_commentary" : "assistant_final";
		const previous = parts.at(-1);
		if (previous?.kind === kind) previous.body += block.text;
		else parts.push({ kind, contentIndex: index, body: block.text });
	}
	return parts;
}

/** Preserve historical unsplit-final identity; split messages get stable keys. */
export function assistantTranscriptSourceKey(piEntryKey: string, part: AssistantTranscriptPart, parts: readonly AssistantTranscriptPart[]): string {
	return parts.length === 1 && part.kind === "assistant_final" ? piEntryKey : `${piEntryKey}:text:${part.contentIndex}`;
}
