import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { payload, answerFromSse, answer, credentials, createServer, MAX_QUESTION, MAX_ANSWER } from '../scripts/bridge-chat-model.mjs';

const response = (text = 'answer', extra = []) => 'data: ' + JSON.stringify({ type: 'response.completed', response: {
  status: 'completed', output: [...extra, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }],
} }) + '\n\n';
const token = 'x.' + Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'account-test' } })).toString('base64url') + '.x';
const credential = { type: 'oauth', access: token, refresh: 'fixture-refresh', expires: Date.now() + 3600000 };

function request(socketPath, value) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, method: 'POST', path: '/answer' }, res => {
      let body = ''; res.on('data', c => body += c); res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(value));
  });
}

test('exact fresh hosted-search-only body; no agent resources or conversation state', () => {
  const a = payload('first question', 'gpt-5.4');
  assert.deepEqual(a.tools, [{ type: 'web_search' }]);
  assert.equal(a.tool_choice, 'auto');
  assert.equal(a.store, false);
  assert.deepEqual(Object.keys(a).sort(), ['input', 'instructions', 'model', 'store', 'stream', 'text', 'tool_choice', 'tools']);
  assert.deepEqual(payload('second question', 'gpt-5.4').input, [{ role: 'user', content: 'second question' }]);
  a.tools.push({ type: 'shell' });
  assert.deepEqual(payload('third', 'gpt-5.4').tools, [{ type: 'web_search' }]);
  for (const q of ['', null, {}, 'x'.repeat(MAX_QUESTION + 1), 'é'.repeat(MAX_QUESTION / 2 + 1)]) assert.throws(() => payload(q, 'gpt-5.4'));
});

test('requires completed response; never exposes reasoning or executes foreign tools', () => {
  assert.equal(answerFromSse(response('answer', [{ type: 'reasoning', summary: 'private' }, { type: 'web_search_call' }])), 'answer');
  for (const type of ['function_call', 'computer_call', 'local_shell_call', 'file_search_call']) assert.throws(() => answerFromSse(response('answer', [{ type }])));
  for (const s of ['data: {"type":"response.output_text.delta","delta":"partial"}\n\n', 'data: {"type":"response.failed"}\n\n', 'data: broken\n\n', response('')]) assert.throws(() => answerFromSse(s));
  assert.throws(() => answerFromSse(response('x'.repeat(MAX_ANSWER + 1))));
  assert.throws(() => answerFromSse(response() + response()));
});

test('preserves hosted web citation URLs', () => {
  const r = JSON.parse(response().slice(6));
  r.response.output[0].content[0].annotations = [{ type: 'url_citation', url: 'https://example.com/source' }];
  assert.match(answerFromSse('data: ' + JSON.stringify(r) + '\n\n'), /https:\/\/example.com\/source/);
});

test('backend request receives only question and fixed instructions; redirects rejected', async () => {
  const requests = [];
  const fake = async (url, init) => { requests.push({ url, init }); return new Response(response()); };
  assert.equal(await answer('question', 'gpt-5.4', async () => token, AbortSignal.timeout(1000), fake), 'answer');
  const { url, init } = requests[0];
  assert.equal(url, 'https://chatgpt.com/backend-api/codex/responses');
  assert.equal(init.redirect, 'error');
  assert.deepEqual(JSON.parse(init.body).input, [{ role: 'user', content: 'question' }]);
  assert.equal(init.headers['chatgpt-account-id'], 'account-test');
  await assert.rejects(answer('q', 'gpt-5.4', async () => token, AbortSignal.timeout(1000), async () => new Response('credential leak sentinel', { status: 401 })), /backend/);
});

test('dedicated credential validation, durable rotation and restart seed handling', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-chat-auth-'));
  try {
    const seed = path.join(dir, 'seed'), state = path.join(dir, 'state');
    fs.writeFileSync(seed, JSON.stringify({ 'openai-codex': { ...credential, expires: 0 } }), { mode: 0o600 });
    let refreshed = 0;
    const get = credentials(seed, state, async () => { refreshed++; return credential; });
    assert.equal(await get(AbortSignal.timeout(1000)), token);
    assert.equal(refreshed, 1);
    const restarted = credentials(seed, state, async () => assert.fail('must preserve rotated credential'));
    assert.equal(await restarted(AbortSignal.timeout(1000)), token);
    assert.equal(fs.statSync(state).mode & 0o777, 0o600);
    fs.writeFileSync(seed, JSON.stringify({ 'openai-codex': credential, other: { secret: 'sentinel' } }));
    assert.throws(() => credentials(seed, state, async () => credential), /dedicated/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('private socket rejects additional context, bounds concurrency, no cross-request history', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-chat-http-'));
  const socket = path.join(dir, 'worker.sock');
  const questions = [];
  let release;
  const server = createServer(async q => { questions.push(q); if (q === 'hold') await new Promise(r => release = r); return 'answer'; });
  server.listen(socket); await once(server, 'listening');
  try {
    assert.equal((await request(socket, { question: 'q', room: '!secret' })).status, 502);
    assert.equal((await request(socket, { question: '' })).status, 502);
    assert.deepEqual(questions, []);
    const held = request(socket, { question: 'hold' });
    while (!release) await new Promise(r => setTimeout(r, 5));
    assert.equal((await request(socket, { question: 'another' })).status, 503);
    release(); assert.equal((await held).status, 200);
    assert.equal((await request(socket, { question: 'fresh' })).status, 200);
    assert.deepEqual(questions, ['hold', 'fresh']);
  } finally { await new Promise(r => server.close(r)); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('packaged worker starts with isolated OAuth module and rejects extra context without network', { skip: !process.env.BRIDGE_CHAT_PACKAGE, timeout: 10000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-chat-packaged-'));
  const socket = path.join(dir, 'worker.sock'), seed = path.join(dir, 'seed');
  fs.writeFileSync(seed, JSON.stringify({ 'openai-codex': credential }), { mode: 0o600 });
  const child = spawn(process.env.BRIDGE_CHAT_PACKAGE + '/bin/pi-chat-model', [socket, path.join(dir, 'state'), seed, 'gpt-5.4'], { env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = ''; child.stdout.on('data', c => logs += c); child.stderr.on('data', c => logs += c);
  const exited = once(child, 'exit');
  try {
    for (let i = 0; i < 100 && !fs.existsSync(socket) && child.exitCode === null; i++) await new Promise(r => setTimeout(r, 30));
    assert.equal(child.exitCode, null, logs);
    assert.ok(fs.existsSync(socket), logs);
    assert.equal((await request(socket, { question: 'no backend request', room: 'forbidden' })).status, 502);
    assert.ok(!logs.includes('fixture-refresh'));
  } finally { child.kill('SIGTERM'); await exited; fs.rmSync(dir, { recursive: true, force: true }); }
});
