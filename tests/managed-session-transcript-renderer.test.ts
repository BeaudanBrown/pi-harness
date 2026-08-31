import assert from "node:assert/strict";
import test from "node:test";
import {
	MAX_MATRIX_TRANSCRIPT_CHUNK_BYTES,
	chunkTranscript,
	renderMarkdownHtml,
	renderTranscript,
	transcriptContentHash,
} from "../config/agent/extensions/managed-sessions/relay/transcript-renderer.js";

test("Markdown rendering escapes HTML, rejects unsafe links, and always retains plain fallback", () => {
	const source = "**bold** <script>alert(1)</script> [safe](https://example.com/a) [http](http://example.com) [bad](javascript:alert(1)) `code`";
	const html = renderMarkdownHtml(source);
	assert.match(html, /<strong>bold<\/strong>/);
	assert.match(html, /&lt;script&gt;/);
	assert.doesNotMatch(html, /<script|href="javascript:/);
	assert.match(html, /href="https:\/\/example\.com\/a"/);
	assert.match(html, /bad \(unsafe URL omitted\)/);
	const [local] = renderTranscript("local_user", source);
	assert.ok(local?.body.startsWith("Local Pi user:\n\n"));
	assert.ok(local?.body.includes(source));
	assert.match(local?.formattedBody ?? "", /<strong>Local Pi user:<\/strong>/);
});

test("transcript chunking is deterministic, UTF-8 bounded, ordered, and content-addressed", () => {
	const source = `${"🙂 unicode words ".repeat(1_200)}\n${"tail ".repeat(1_200)}`;
	const first = chunkTranscript(source);
	const second = chunkTranscript(source);
	assert.deepEqual(first, second);
	assert.equal(first.join(""), source);
	assert.ok(first.length > 1 && first.length <= 64);
	assert.ok(first.every((chunk) => Buffer.byteLength(chunk, "utf8") <= MAX_MATRIX_TRANSCRIPT_CHUNK_BYTES));
	assert.equal(transcriptContentHash("assistant_final", source), transcriptContentHash("assistant_final", source));
	assert.notEqual(transcriptContentHash("local_user", source), transcriptContentHash("assistant_final", source));
	const escapeHeavy = renderTranscript("local_user", "&<>\"' ".repeat(8_000));
	assert.ok(escapeHeavy.length > 1 && escapeHeavy.length <= 64);
	assert.ok(escapeHeavy.every((chunk, index) =>
		chunk.body.startsWith(index === 0 ? "Local Pi user:\n\n" : "Local Pi user (continued):\n\n") &&
		Buffer.byteLength(chunk.body, "utf8") <= MAX_MATRIX_TRANSCRIPT_CHUNK_BYTES &&
		Buffer.byteLength(chunk.formattedBody, "utf8") <= MAX_MATRIX_TRANSCRIPT_CHUNK_BYTES));
});
