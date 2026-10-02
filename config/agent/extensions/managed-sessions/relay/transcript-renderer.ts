import { createHash } from "node:crypto";
import MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";

export const MAX_MATRIX_TRANSCRIPT_CHUNK_BYTES = 8_000;
export const MAX_MATRIX_TRANSCRIPT_CHUNKS = 64;
export interface RenderedTranscriptChunk { body: string; formattedBody: string }

interface Node { tag?: string; text?: string; href?: string; start?: number; children: Node[] }
const parser = new MarkdownIt({ html: false, linkify: false, typographer: false, breaks: true });
Object.assign(parser.options, { maxNesting: 32 });
// Parse all destinations, then apply the bridge's stricter policy ourselves.
parser.validateLink = () => true;
const allowed = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "blockquote", "strong", "em", "s", "a", "code"]);
const text = (value: string): Node => ({ text: value, children: [] });
function parse(source: string): Node[] {
	const tokens = parser.parse(source, {});
	// markdown-it can discard block contents at maxNesting. Fail before that boundary.
	if (tokens.some((token) => token.level >= 30)) throw new Error("Markdown nesting exceeds rendering budget");
	return nodes(tokens);
}
function escapeHtml(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
function safeUrl(value: string): string | undefined {
	try {
		const url = new URL(value);
		return url.protocol === "https:" && !url.username && !url.password ? url.toString() : undefined;
	} catch { return undefined; }
}
function nodes(tokens: Token[]): Node[] {
	const root: Node = { children: [] };
	const stack = [root];
	for (const token of tokens) {
		const parent = stack.at(-1)!;
		if (token.nesting === -1) { stack.pop(); continue; }
		if (token.type === "inline") { parent.children.push(...nodes(token.children ?? [])); continue; }
		if (token.type === "fence" || token.type === "code_block") {
			parent.children.push({ tag: "pre", children: [{ tag: "code", children: [text(token.content)] }] });
		} else if (token.type === "code_inline") {
			parent.children.push({ tag: "code", children: [text(token.content)] });
		} else if (token.type === "softbreak" || token.type === "hardbreak") {
			parent.children.push({ tag: "br", children: [] });
		} else if (token.type === "hr") {
			parent.children.push({ tag: "p", children: [text("──────────")] });
		} else if (token.type === "image") {
			const label = token.content || "image";
			const href = safeUrl(token.attrGet("src") ?? "");
			parent.children.push(text(`[Image: ${label}]`));
			if (href) parent.children.push(text(" "), { tag: "a", href, children: [text(href)] });
			else parent.children.push(text(" (unsafe URL omitted)"));
		} else if (token.nesting === 1) {
			const node: Node = { tag: token.tag, children: [] };
			if (node.tag === "a") node.href = safeUrl(token.attrGet("href") ?? "");
			if (node.tag === "ol") node.start = Number(token.attrGet("start") ?? 1);
			parent.children.push(node); stack.push(node);
		} else parent.children.push(text(token.content));
	}
	return lower(root.children);
}
function plainContent(node: Node): string { return node.text ?? node.children.map(plainContent).join(""); }
function lower(items: Node[]): Node[] {
	return items.flatMap((node): Node[] => {
		if (node.tag === "table") {
			const rows = node.children.flatMap((section) => section.children);
			const headers = rows[0]?.children.map((cell, i) => plainContent(cell).trim() ? lower(cell.children) : [text(`Column ${i + 1}`)]) ?? [];
			const result: Node[] = [];
			for (const [index, row] of rows.slice(1).entries()) {
				result.push({ tag: "p", children: [{ tag: "strong", children: [text(`Row ${index + 1}`)] }] });
				result.push({ tag: "ul", children: row.children.map((cell, i) => ({ tag: "li", children: [
					{ tag: "strong", children: [...structuredClone(headers[i] ?? [text(`Column ${i + 1}`)]), text(":")] }, text(" "),
					...(plainContent(cell).trim() ? lower(cell.children) : [text("(empty)")]),
				] })) });
			}
			// A header-only table still contains meaningful information.
			return result.length ? result : [{ tag: "p", children: headers.flatMap((header, i) => [...(i ? [text(" | ")] : []), ...header]) }];
		}
		node.children = lower(node.children);
		if (node.tag === "s") node.tag = "del";
		if (node.tag === "a" && !node.href) return [...node.children, text(" (unsafe URL omitted)")];
		return [node];
	});
}
interface Event { node: Node; kind: "open" | "close" | "text" | "break"; plain: string }
function events(items: Node[], output: Event[] = [], list?: { start: number; ordered: boolean }): Event[] {
	for (const node of items) {
		if (node.text !== undefined) { output.push({ node, kind: "text", plain: node.text }); continue; }
		if (node.tag === "br") { output.push({ node, kind: "break", plain: "\n" }); continue; }
		let before = "", after = "";
		if (node.tag === "li") before = list?.ordered ? `${list.start++}. ` : "- ";
		if (node.tag === "li" || node.tag === "pre" || node.tag === "blockquote" || /^h[1-6]$/.test(node.tag ?? "") || node.tag === "p") after = "\n\n";
		if (node.tag === "a" && plainContent(node) !== node.href) after = ` (${node.href})`;
		output.push({ node, kind: "open", plain: before });
		events(node.children, output, node.tag === "ol" || node.tag === "ul" ? { start: node.start ?? 1, ordered: node.tag === "ol" } : list);
		output.push({ node, kind: "close", plain: after });
	}
	return output;
}
function opening(node: Node, start = node.start): string {
	if (!node.tag) return "";
	if (!allowed.has(node.tag) && node.tag !== "pre" && node.tag !== "del") throw new Error(`Unsupported Markdown tag: ${node.tag}`);
	return `<${node.tag}${node.tag === "a" ? ` href="${escapeHtml(node.href!)}"` : node.tag === "ol" ? ` start="${start ?? 1}"` : ""}>`;
}
const closing = (node: Node): string => node.tag ? `</${node.tag}>` : "";
function serialize(input: Event[]): RenderedTranscriptChunk {
	return { body: input.map((event) => event.plain).join(""), formattedBody: input.map((event) =>
		event.kind === "text" ? escapeHtml(event.plain) : event.kind === "break" ? "<br>" : event.kind === "open" ? opening(event.node) : closing(event.node)).join("") };
}
export function renderMarkdownHtml(markdown: string): string { return serialize(events(parse(markdown))).formattedBody; }

export function renderTranscript(kind: "local_user" | "assistant_final", source: string): RenderedTranscriptChunk[] {
	if (!source) return [];
	const blocks = parse(source);
	const chunks: RenderedTranscriptChunk[] = [];
	const stack: Array<{ node: Node; index: number }> = [];
	let body = "", html = "", plainBytes = 0, htmlBytes = 0;
	const prefix = (): RenderedTranscriptChunk => kind === "local_user" ? {
		body: `Local Pi user${chunks.length ? " (continued)" : ""}:\n\n`,
		formattedBody: `<p><strong>Local Pi user${chunks.length ? " (continued)" : ""}:</strong></p>`,
	} : { body: "", formattedBody: "" };
	const reset = () => {
		const p = prefix(); body = p.body; html = p.formattedBody + stack.map((frame) => opening(frame.node, frame.index)).join("");
		plainBytes = Buffer.byteLength(body); htmlBytes = Buffer.byteLength(html);
	};
	const suffix = () => [...stack].reverse().map((frame) => closing(frame.node)).join("");
	const fits = (plain: string, formatted: string, ending = suffix()): boolean => plainBytes + Buffer.byteLength(plain) <= MAX_MATRIX_TRANSCRIPT_CHUNK_BYTES &&
		htmlBytes + Buffer.byteLength(formatted) + Buffer.byteLength(ending) <= MAX_MATRIX_TRANSCRIPT_CHUNK_BYTES;
	const append = (plain: string, formatted: string) => { body += plain; html += formatted; plainBytes += Buffer.byteLength(plain); htmlBytes += Buffer.byteLength(formatted); };
	const flush = () => {
		chunks.push({ body, formattedBody: html + suffix() });
		if (chunks.length > MAX_MATRIX_TRANSCRIPT_CHUNKS) throw new Error("Transcript requires too many Matrix chunks");
		reset();
	};
	reset();
	let content = false;
	for (const [blockIndex, block] of blocks.entries()) {
		const blockEvents = events([block]);
		if (blockIndex === blocks.length - 1) {
			// Drop renderer-added terminal separators, never trailing whitespace inside code/text.
			for (let i = blockEvents.length - 1; i >= 0 && blockEvents[i]!.kind === "close"; i -= 1) {
				if (blockEvents[i]!.plain === "\n\n") blockEvents[i]!.plain = "";
			}
		}
		const whole = serialize(blockEvents);
		if (content && !fits(whole.body, whole.formattedBody)) { flush(); content = false; }
		if (fits(whole.body, whole.formattedBody)) { append(whole.body, whole.formattedBody); content = true; continue; }
		for (const event of blockEvents) {
			if (event.kind === "open") {
				const list = stack.at(-1);
				if (event.node.tag === "li" && list?.node.tag === "ol") list.index = Number(/^([0-9]+)\./.exec(event.plain)?.[1] ?? list.index);
				const open = opening(event.node);
				const end = closing(event.node) + suffix();
				if (!fits(event.plain, open, end)) { flush(); content = false; }
				if (!fits(event.plain, open, end)) throw new Error("Markdown container exceeds Matrix chunk budget");
				append(event.plain, open); stack.push({ node: event.node, index: event.node.start ?? 1 });
			} else if (event.kind === "close") {
				// Closing HTML is already reserved by fits(). Plain block separators may need another chunk.
				stack.pop();
				const parent = stack.at(-1);
				if (event.node.tag === "li" && parent?.node.tag === "ol") parent.index += 1;
				append("", closing(event.node));
				for (const character of event.plain) {
					if (!fits(character, "")) { flush(); content = false; }
					append(character, "");
				}
			} else {
				for (const character of event.plain) {
					const encoded = event.kind === "break" ? "<br>" : escapeHtml(character);
					if (!fits(character, encoded)) { flush(); content = false; }
					if (!fits(character, encoded)) throw new Error("Markdown content exceeds Matrix chunk budget");
					append(character, encoded); content = true;
				}
			}
		}
	}
	if (body !== prefix().body || html !== prefix().formattedBody) flush();
	return chunks;
}
export function chunkTranscript(value: string): string[] { return renderTranscript("assistant_final", value).map((chunk) => chunk.body); }
export function transcriptContentHash(kind: "local_user" | "assistant_final", body: string): string {
	return createHash("sha256").update(`pi-managed-sessions:projection-content:v1\0${kind}\0${body}`, "utf8").digest("hex");
}
