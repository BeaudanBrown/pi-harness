import test from "node:test";
import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createWebSearchTool, MAX_SEARCH_CONTEXT_BYTES } from "../config/agent/extensions/web-search/index.js";

const token = 'x.' + Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture' } })).toString('base64url') + '.x';
test('shared search limits context output, not arguments or HTTP response bytes', async t => {
	const original = globalThis.fetch;
	t.after(() => { globalThis.fetch = original; });
	const query = 'q'.repeat(5000), domains = Array.from({ length: 33 }, () => 'd'.repeat(254));
	let answer = 'unchanged short answer';
	globalThis.fetch = async (_url, init) => {
		const payload = JSON.parse(String(init?.body));
		assert.equal(payload.input[0].content, query);
		assert.equal(init?.redirect, undefined);
		return new Response('data: ' + JSON.stringify({ type: 'response.output_text.delta', delta: answer, padding: 'x'.repeat(2 * 1024 * 1024) }) + '\n\n');
	};
	const tool = createWebSearchTool(undefined, async () => token);
	assert.equal(Object.hasOwn(tool.parameters.properties.query, 'maxLength'), false);
	assert.equal(Object.hasOwn(tool.parameters.properties.allowed_domains, 'maxItems'), false);
	assert.equal(Object.hasOwn(tool.parameters.properties.blocked_domains, 'maxItems'), false);
	for (const value of ['unchanged short answer', 'x'.repeat(MAX_SEARCH_CONTEXT_BYTES), '😀'.repeat(MAX_SEARCH_CONTEXT_BYTES)]) {
		answer = value;
		const result = await tool.execute('fixture', { query, allowed_domains: domains, blocked_domains: domains }, undefined, undefined, {} as ExtensionContext);
		const text = result.content.filter(p => p.type === 'text').map(p => p.text).join('');
		assert.ok(Buffer.byteLength(text) <= MAX_SEARCH_CONTEXT_BYTES);
		assert.ok(!text.includes('\ufffd'));
		if (Buffer.byteLength(value) <= MAX_SEARCH_CONTEXT_BYTES) assert.equal(text, value);
		else assert.match(text, /truncated to fit the context limit/);
	}
});
