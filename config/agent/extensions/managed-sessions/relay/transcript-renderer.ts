import { createHash } from "node:crypto";

export const MAX_MATRIX_TRANSCRIPT_CHUNK_BYTES = 8_000;
export const MAX_MATRIX_TRANSCRIPT_CHUNKS = 64;

export interface RenderedTranscriptChunk {
	body: string;
	formattedBody: string;
}

function escapeHtml(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function safeUrl(value: string): string | undefined {
	try {
		const parsed = new URL(value);
		return parsed.protocol === "https:" && !parsed.username && !parsed.password ? parsed.toString() : undefined;
	} catch {
		return undefined;
	}
}

function renderInline(value: string): string {
	const token = /(`[^`\n]+`|\[[^\]\n]{1,200}\]\([^\s)]+\)|\*\*[^*\n]+\*\*|\*[^*\n]+\*)/g;
	let result = "";
	let offset = 0;
	for (const match of value.matchAll(token)) {
		result += escapeHtml(value.slice(offset, match.index));
		const source = match[0];
		if (source.startsWith("`")) result += `<code>${escapeHtml(source.slice(1, -1))}</code>`;
		else if (source.startsWith("**")) result += `<strong>${escapeHtml(source.slice(2, -2))}</strong>`;
		else if (source.startsWith("*")) result += `<em>${escapeHtml(source.slice(1, -1))}</em>`;
		else {
			const parts = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(source)!;
			const url = safeUrl(parts[2]!);
			result += url ? `<a href="${escapeHtml(url)}">${escapeHtml(parts[1]!)}</a>` : `${escapeHtml(parts[1]!)} (unsafe URL omitted)`;
		}
		offset = match.index! + source.length;
	}
	return result + escapeHtml(value.slice(offset));
}

export function renderMarkdownHtml(markdown: string): string {
	return markdown.split(/\n{2,}/).map((paragraph) => `<p>${paragraph.split("\n").map(renderInline).join("<br>")}</p>`).join("");
}

function chunkForRenderedPayload(kind: "local_user" | "assistant_final", value: string): string[] {
	if (!value) return [];
	const characters = Array.from(value);
	const chunks: string[] = [];
	let offset = 0;
	while (offset < characters.length) {
		const index = chunks.length;
		const plainPrefix = kind === "local_user" ? `${index === 0 ? "Local Pi user" : "Local Pi user (continued)"}:\n\n` : "";
		const htmlPrefix = kind === "local_user" ? `<p><strong>${index === 0 ? "Local Pi user" : "Local Pi user (continued)"}:</strong></p>` : "";
		const fits = (end: number): boolean => {
			const source = characters.slice(offset, end).join("");
			return Buffer.byteLength(`${plainPrefix}${source}`, "utf8") <= MAX_MATRIX_TRANSCRIPT_CHUNK_BYTES &&
				Buffer.byteLength(`${htmlPrefix}${renderMarkdownHtml(source)}`, "utf8") <= MAX_MATRIX_TRANSCRIPT_CHUNK_BYTES;
		};
		let low = offset + 1;
		let high = characters.length;
		let end = offset;
		while (low <= high) {
			const middle = Math.floor((low + high) / 2);
			if (fits(middle)) { end = middle; low = middle + 1; } else high = middle - 1;
		}
		if (end === offset) throw new Error("Transcript chunking made no progress");
		if (end < characters.length) {
			for (let candidate = end - 1; candidate > offset + Math.floor((end - offset) / 2); candidate -= 1) {
				if (characters[candidate - 1] === " " || characters[candidate - 1] === "\n") { end = candidate; break; }
			}
		}
		chunks.push(characters.slice(offset, end).join(""));
		offset = end;
		if (chunks.length > MAX_MATRIX_TRANSCRIPT_CHUNKS) throw new Error("Transcript requires too many Matrix chunks");
	}
	return chunks;
}

export function chunkTranscript(value: string): string[] {
	return chunkForRenderedPayload("assistant_final", value);
}

export function transcriptContentHash(kind: "local_user" | "assistant_final", body: string): string {
	return createHash("sha256").update(`pi-managed-sessions:projection-content:v1\0${kind}\0${body}`, "utf8").digest("hex");
}

export function renderTranscript(kind: "local_user" | "assistant_final", body: string): RenderedTranscriptChunk[] {
	return chunkForRenderedPayload(kind, body).map((chunk, index) => {
		const prefix = kind === "local_user" ? `${index === 0 ? "Local Pi user" : "Local Pi user (continued)"}:\n\n` : "";
		const htmlPrefix = kind === "local_user" ? `<p><strong>${index === 0 ? "Local Pi user" : "Local Pi user (continued)"}:</strong></p>` : "";
		return { body: `${prefix}${chunk}`, formattedBody: `${htmlPrefix}${renderMarkdownHtml(chunk)}` };
	});
}
