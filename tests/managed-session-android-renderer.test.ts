import assert from "node:assert/strict";
import test from "node:test";
import { renderMarkdownHtml, renderTranscript } from "../config/agent/extensions/managed-sessions/relay/transcript-renderer.js";

function assertBalanced(html: string): void {
	const stack: string[] = [];
	for (const match of html.matchAll(/<(\/?)([a-z0-9]+)(?:\s[^>]*)?>/g)) {
		if (match[2] === "br") continue;
		if (match[1]) assert.equal(stack.pop(), match[2], html.slice(0, 100));
		else stack.push(match[2]!);
	}
	assert.deepEqual(stack, []);
}
function checkChunks(source: string, kind: "assistant_final" | "local_user" = "assistant_final") {
	const chunks = renderTranscript(kind, source);
	assert.deepEqual(chunks, renderTranscript(kind, source));
	assert.ok(chunks.length > 0 && chunks.length <= 64);
	for (const chunk of chunks) {
		assert.ok(Buffer.byteLength(chunk.body) <= 8_000);
		assert.ok(Buffer.byteLength(chunk.formattedBody) <= 8_000);
		assertBalanced(chunk.formattedBody);
		assert.doesNotMatch(chunk.formattedBody, /<table|<img|<details|<input|<hr|style=|onclick=/);
	}
	return chunks;
}

test("Android blocks, nested inline formatting, references, and literal code", () => {
	const source = "# Heading\n\n3. **bold *nested***\n4. second\n   - nested\n\n> quote\n\n~~deleted~~ ``a`b`` [reference][r]\n\n[r]: https://example.com/a\n\n```python\ndef f():\n    return '<script>**literal**</script>'\n```\n\n    indented()\n";
	const html = renderMarkdownHtml(source);
	assert.match(html, /<h1>Heading<\/h1>/);
	assert.match(html, /<ol start="3">/);
	assert.match(html, /<strong>bold <em>nested<\/em><\/strong>/);
	assert.match(html, /<blockquote>/);
	assert.match(html, /<del>deleted<\/del>/);
	assert.match(html, /<code>a`b<\/code>/);
	assert.match(html, /href="https:\/\/example.com\/a"/);
	assert.match(html, /<pre><code>def f\(\):\n    return &#39;&lt;script&gt;\*\*literal\*\*&lt;\/script&gt;&#39;\n<\/code><\/pre>/);
	assert.match(html, /<pre><code>indented\(\)\n<\/code><\/pre>/);
	const chunks = checkChunks(source);
	assert.match(chunks.map(c => c.body).join(""), /reference \(https:\/\/example.com\/a\)/);
});

test("tables lower to labelled rows, preserving empty cells and duplicate/empty headings", () => {
	const source = "| Name | Name | |\n| --- | --- | --- |\n| **Fast** | | `a\\|b` |\n| Standard | *cheap* | value |";
	const html = renderMarkdownHtml(source);
	assert.doesNotMatch(html, /<table|<thead|<td|<tr/);
	assert.match(html, /<strong>Row 1<\/strong>/);
	assert.match(html, /<strong>Name:<\/strong> <strong>Fast<\/strong>/);
	assert.match(html, /<strong>Name:<\/strong> \(empty\)/);
	assert.match(html, /<strong>Column 3:<\/strong> <code>a\|b<\/code>/);
	assert.match(html, /<em>cheap<\/em>/);
	checkChunks(source);
	assert.match(renderMarkdownHtml("| Header |\n| --- |"), /Header/);
	const formattedHeaders = renderMarkdownHtml("| *Name* | `Cost` | [Info](https://example.com) |\n| --- | --- | --- |\n| Fast | Higher | More |");
	assert.match(formattedHeaders, /<strong><em>Name<\/em>:<\/strong>/);
	assert.match(formattedHeaders, /<strong><code>Cost<\/code>:<\/strong>/);
	assert.match(formattedHeaders, /<strong><a href="https:\/\/example.com\/">Info<\/a>:<\/strong>/);
});

test("tasks, separators, images and hostile HTML degrade to safe visible text", () => {
	const source = "- [x] done\n- [ ] pending\n\n---\n\n![diagram](https://example.com/a.png) ![bad](data:image/png;base64,abc)\n\n<script>alert(1)</script> [bad](javascript:alert(1)) [auth](https://u:p@example.com) [encoded](javascript&#58;alert(1))";
	const chunks = checkChunks(source);
	const html = chunks.map(c => c.formattedBody).join("");
	assert.match(html, /\[x\] done/);
	assert.match(html, /──────────/);
	assert.match(html, /\[Image: diagram\]/);
	assert.match(html, /\[Image: bad\]/);
	assert.match(html, /&lt;script&gt;/);
	assert.doesNotMatch(html, /href="(?:javascript|data|http:|https:\/\/u)/);
	assert.match(html, /bad \(unsafe URL omitted\)/);
});

test("oversized code retains indentation and Unicode and reopens literal code containers", () => {
	const code = "    🙂 <&> **literal**\n".repeat(2_000);
	const chunks = checkChunks("```\n" + code + "```", "local_user");
	assert.ok(chunks.length > 1);
	assert.ok(chunks.every(c => c.formattedBody.includes("<pre><code>")));
	assert.equal(chunks.map((c, index) => c.body.replace(index ? /^Local Pi user \(continued\):\n\n/ : /^Local Pi user:\n\n/, "")).join(""), code);
});

test("oversized ordered lists maintain numbering through continued messages", () => {
	const source = "7. " + "🙂 words ".repeat(2_000) + "\n8. last\n";
	const chunks = checkChunks(source);
	assert.ok(chunks.length > 1);
	assert.ok(chunks.slice(1).some(c => c.formattedBody.startsWith('<ol start="7"><li>')));
	assert.match(chunks.map(c => c.body).join(""), /8\. last/);
	const table = "| Key | Value |\n| --- | --- |\n| enormous | " + "<&> ".repeat(10_000) + " |";
	const tableChunks = checkChunks(table);
	assert.equal((tableChunks.map(c => c.body).join("").match(/<&>/g) ?? []).length, 10_000);
});

test("ordered-list boundaries reopen at the next ordinal after an item closes", () => {
	let observedBoundary = false;
	for (let size = 7_940; size <= 7_980; size += 1) {
		const chunks = checkChunks("7. " + "x".repeat(size) + "\n8. last");
		for (const chunk of chunks.slice(1)) {
			const first = /^<ol start="(\d+)"><li><p>last/.exec(chunk.formattedBody);
			if (first) { observedBoundary = true; assert.equal(first[1], "8"); }
		}
	}
	assert.ok(observedBoundary, "fixture must exercise a split between items");
});

test("capacity and nesting overflow are explicit rather than truncated", () => {
	assert.throws(() => renderTranscript("assistant_final", "```\n" + "&".repeat(120_000) + "\n```"), /too many Matrix chunks/);
	assert.throws(() => renderTranscript("assistant_final", "> ".repeat(32) + "must not disappear"), /nesting exceeds/);
	assert.throws(() => renderTranscript("assistant_final", "[label](https://example.com/" + "x".repeat(8_000) + ")"), /container exceeds/);
});
