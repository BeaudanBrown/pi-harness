import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type Model, type Api } from "@earendil-works/pi-ai";
import { createChatSession, runQuestion, CHAT_SYSTEM_PROMPT } from "../config/agent/extensions/bridge-chat/model.mjs";
import { createQuestionServer, modelAnswer } from "../config/agent/extensions/bridge-chat/socket.js";

const token = 'x.' + Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'account-test' } })).toString('base64url') + '.x';
const credential = { type: 'oauth', access: token, refresh: 'fixture-only', expires: Date.now() + 3600000, accountId: 'account-test' };
function fixture(t: { after(fn: () => void): void }) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-sdk-chat-'));
	const agent = path.join(dir, 'existing-pi'); fs.mkdirSync(agent);
	const auth = path.join(agent, 'auth.json'); fs.writeFileSync(auth, JSON.stringify({ 'openai-codex': credential }), { mode: 0o600 });
	fs.writeFileSync(path.join(agent, 'models.json'), 'INVALID AMBIENT MODEL CONFIG');
	fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'AMBIENT_CONTEXT_SENTINEL');
	fs.mkdirSync(path.join(dir, '.pi', 'extensions'), { recursive: true });
	fs.writeFileSync(path.join(dir, '.pi', 'extensions', 'evil.ts'), 'throw new Error("AMBIENT_EXTENSION_LOADED")');
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	return { dir, auth };
}
async function runtime(authPath: string) { return ModelRuntime.create({ authPath, modelsPath: null, refreshOnCreate: false, allowModelNetwork: false }); }
function message(model: Model<Api>, text: string, tool?: string): AssistantMessage {
	return { role: 'assistant', content: tool ? [{ type: 'toolCall', id: 'call-1', name: tool, arguments: tool === 'web_search' ? { query: 'current fixture question' } : { command: 'forbidden', path: '/etc/passwd' } }] : [{ type: 'text', text }],
		api: model.api, provider: model.provider, model: model.id, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: tool ? 'toolUse' : 'stop', timestamp: Date.now() };
}
function fakeStream(captured: Context[], firstTool?: string) {
	return (model: Model<Api>, context: Context) => {
		captured.push(JSON.parse(JSON.stringify(context)));
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			const reply = message(model, 'fixture answer', captured.length === 1 ? firstTool : undefined);
			stream.push({ type: 'start', partial: { ...reply, content: [] } });
			stream.push({ type: 'done', reason: reply.stopReason as 'stop' | 'toolUse', message: reply }); stream.end();
		}); return stream;
	};
}
test('real Pi SDK creates a fresh unsaved web-search-only session without ambient resources', async t => {
	const f = fixture(t), r = await runtime(f.auth);
	for (const q of ['first question', '/skill:private second question']) {
		const session = await createChatSession(r, 'gpt-5.4', f.dir);
		try {
			assert.deepEqual(session.getActiveToolNames(), ['web_search']);
			assert.deepEqual(session.getAllTools().map(tool => tool.name), ['web_search']);
			assert.equal(session.sessionFile, undefined);
			const captured: Context[] = []; session.agent.streamFunction = fakeStream(captured);
			assert.equal(await runQuestion(session, q, AbortSignal.timeout(5000)), 'fixture answer');
			assert.equal(captured[0].messages.length, 1);
			assert.deepEqual(captured[0].messages[0].content, [{ type: 'text', text: q }]);
			assert.ok(captured[0].systemPrompt?.includes(CHAT_SYSTEM_PROMPT));
			assert.equal(JSON.stringify(captured).includes('AMBIENT_'), false);
			assert.equal(JSON.stringify(captured).includes('fixture-only'), false);
			assert.deepEqual(captured[0].tools?.map(tool => tool.name), ['web_search']);
		} finally { session.dispose(); }
	}
	assert.equal(fs.existsSync(path.join(f.dir, 'sessions')), false);
});
for (const tool of ['bash', 'read', 'write', 'run_worker']) test(`real SDK refuses model-requested ${tool}`, async t => {
	const f = fixture(t), session = await createChatSession(await runtime(f.auth), 'gpt-5.4', f.dir);
	try {
		const captured: Context[] = []; session.agent.streamFunction = fakeStream(captured, tool);
		assert.equal(await runQuestion(session, 'try forbidden tool', AbortSignal.timeout(5000)), 'fixture answer');
		const result = session.messages.find(m => m.role === 'toolResult');
		assert.ok(result && result.role === 'toolResult' && result.isError);
		assert.equal(fs.existsSync(path.join(f.dir, 'forbidden')), false);
	} finally { session.dispose(); }
});
test('SDK web search reuses the existing shared extension tool and Pi-managed authentication', async t => {
	const f = fixture(t), session = await createChatSession(await runtime(f.auth), 'gpt-5.4', f.dir);
	const original = globalThis.fetch; let searches = 0;
	globalThis.fetch = async (url, init) => {
		searches++; assert.equal(String(url), 'https://chatgpt.com/backend-api/codex/responses');
		const body = JSON.parse(String(init?.body)); assert.equal(body.model, 'gpt-5.6-luna'); assert.deepEqual(body.tools, [{ type: 'web_search' }]);
		return new Response('data: ' + JSON.stringify({ type: 'response.output_text.delta', delta: '😀'.repeat(20000) }) + '\n\n');
	};
	try {
		const captured: Context[] = []; session.agent.streamFunction = fakeStream(captured, 'web_search');
		assert.equal(await runQuestion(session, 'current question', AbortSignal.timeout(5000)), 'fixture answer');
		assert.equal(searches, 1);
		const result = session.messages.find(m => m.role === 'toolResult'); assert.ok(result && result.role === 'toolResult' && !result.isError);
		const contextResult = captured.at(-1)!.messages.find(m => m.role === 'toolResult');
		assert.ok(contextResult && contextResult.role === 'toolResult');
		const text = contextResult.content.filter(p => p.type === 'text').map(p => p.text).join('');
		assert.ok(Buffer.byteLength(text) <= 48000); assert.match(text, /truncated/); assert.ok(!text.includes('\ufffd'));
	} finally { globalThis.fetch = original; session.dispose(); }
});
test('Pi credential updates share the original cross-process lock and preserve other logins', async t => {
	const f = fixture(t);
	fs.writeFileSync(f.auth, JSON.stringify({ 'openai-codex': credential, 'other-provider': { type: 'api_key', key: 'unrelated-fixture' } }));
	const modulePath = path.join(path.dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))), 'core/auth-storage.js');
	const script = `import {AuthStorage} from ${JSON.stringify(pathToFileURL(modulePath).href)};
		const store=AuthStorage.create(process.argv[1]);
		await store.modify('openai-codex', async c => { await new Promise(r=>setTimeout(r,100)); return {...c, fixtureCounter:(c.fixtureCounter??0)+1}; });`;
	const children = [0, 1].map(() => spawn(process.execPath, ['--input-type=module', '-e', script, f.auth], { env: { PATH: process.env.PATH }, stdio: 'pipe' }));
	const codes = await Promise.all(children.map(async child => (await once(child, 'exit'))[0]));
	assert.deepEqual(codes, [0, 0]);
	const saved = JSON.parse(fs.readFileSync(f.auth, 'utf8'));
	assert.equal(saved['openai-codex'].fixtureCounter, 2);
	assert.equal(saved['other-provider'].key, 'unrelated-fixture');
	assert.equal(fs.existsSync(f.auth + '.lock'), false);
	assert.equal((await (await runtime(f.auth)).getAuth('openai-codex'))?.auth.apiKey, token);
});
test('request cancellation and session reuse fail closed', async t => {
	const f = fixture(t), session = await createChatSession(await runtime(f.auth), 'gpt-5.4', f.dir);
	try {
		const stop = new AbortController(); stop.abort();
		await assert.rejects(runQuestion(session, 'question', stop.signal));
		session.agent.streamFunction = fakeStream([]); await runQuestion(session, 'first', AbortSignal.timeout(5000));
		await assert.rejects(runQuestion(session, 'second', AbortSignal.timeout(5000)), /fresh/);
	} finally { session.dispose(); }
});
test('SDK turn and final-output budgets fail closed', async t => {
	const f = fixture(t), rt = await runtime(f.auth);
	for (const mode of ['turns', 'output']) {
		const s = await createChatSession(rt, 'gpt-5.4', f.dir);
		let turns = 0;
		s.agent.streamFunction = (model, _context, options) => {
			turns++;
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				if (options?.signal?.aborted) {
					stream.push({ type: 'error', reason: 'aborted', error: { ...message(model, ''), stopReason: 'aborted' } }); stream.end(); return;
				}
				const content: AssistantMessage['content'] = mode === 'turns'
					? [{ type: 'toolCall', id: 'missing-' + turns, name: 'bash', arguments: { command: 'false' } }]
					: [{ type: 'text', text: 'x'.repeat(12001) }];
				const result: AssistantMessage = { ...message(model, ''), content, stopReason: mode === 'turns' ? 'toolUse' : 'stop' };
				stream.push({ type: 'start', partial: result }); stream.push({ type: 'done', reason: result.stopReason as 'stop' | 'toolUse', message: result }); stream.end();
			});
			return stream;
		};
		try { await assert.rejects(runQuestion(s, 'budget test', new AbortController().signal), /budget|incomplete|answer size/i); assert.ok(turns <= 5); }
		finally { s.dispose(); }
	}
});
test('mid-stream cancellation terminates the SDK request without a partial answer', async t => {
	const f = fixture(t), s = await createChatSession(await runtime(f.auth), 'gpt-5.4', f.dir), stop = new AbortController();
	s.agent.streamFunction = (model, _context, options) => {
		const stream = createAssistantMessageEventStream();
		const result: AssistantMessage = { ...message(model, 'partial private answer'), stopReason: 'aborted' };
		const abort = () => stream.push({ type: 'error', reason: 'aborted', error: result });
		if (options?.signal?.aborted) abort(); else options?.signal?.addEventListener('abort', abort, { once: true });
		return stream;
	};
	const timer = setTimeout(() => stop.abort(), 20);
	try { await assert.rejects(runQuestion(s, 'cancel while streaming', stop.signal)); assert.equal(s.isStreaming, false); }
	finally { clearTimeout(timer); s.dispose(); }
});
test('private socket admits only one question field and one in-flight request', async t => {
	const f = fixture(t), sock = path.join(f.dir, 'worker.sock'); let release: (() => void) | undefined;
	const server = createQuestionServer(async q => { if (q === 'hold') await new Promise<void>(r => release = r); return 'answer'; });
	server.listen(sock); await once(server, 'listening');
	try {
		const rejected = await new Promise<number>(resolve => { const req = http.request({ socketPath: sock, path: '/answer', method: 'POST' }, res => { res.resume(); res.on('end', () => resolve(res.statusCode!)); }); req.end(JSON.stringify({ question: 'q', room: 'private' })); });
		assert.equal(rejected, 502);
		const first = modelAnswer(sock, 'hold'); while (!release) await new Promise(r => setTimeout(r, 5));
		await assert.rejects(modelAnswer(sock, 'another')); release(); assert.equal(await first, 'answer');
	} finally { await new Promise<void>(r => server.close(() => r())); }
});
test('packaged SDK worker reuses existing auth without a Codex credential copy', { skip: !process.env.BRIDGE_CHAT_PACKAGE, timeout: 15000 }, async t => {
	const f = fixture(t), socket = path.join(f.dir, 'packaged.sock');
	const child = spawn(process.env.BRIDGE_CHAT_PACKAGE + '/bin/pi-chat-model', [socket, f.auth, 'gpt-5.4'], { cwd: f.dir, env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] });
	let logs = ''; child.stdout.on('data', c => logs += c); child.stderr.on('data', c => logs += c); const exited = once(child, 'exit');
	try {
		for (let i = 0; i < 200 && !fs.existsSync(socket) && child.exitCode === null; i++) await new Promise(r => setTimeout(r, 30));
		assert.equal(child.exitCode, null, logs); assert.ok(fs.existsSync(socket), logs);
		assert.equal(fs.existsSync(path.join(f.dir, 'auth.json')), false);
		assert.equal(logs.includes('fixture-only'), false);
	} finally { child.kill('SIGTERM'); await exited; }
});
