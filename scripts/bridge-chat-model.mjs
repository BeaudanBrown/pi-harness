// Deliberately not a Pi agent/session: only a fixed hosted web-search capability.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const MAX_QUESTION = 8000;
export const MAX_ANSWER = 12000;
export const TIMEOUT = 90000;
const ENDPOINT = 'https://chatgpt.com/backend-api/codex/responses';
const INSTRUCTIONS = 'You are Pi, a concise general assistant. Answer the current question independently. Use web search when helpful, especially for current facts. Cite source URLs for searched claims. You have no access to local files, shell, chats, previous requests or other tools. Never claim you performed actions outside web search.';

export function payload(question, model) {
  if (typeof question !== 'string' || !question.trim() || Buffer.byteLength(question) > MAX_QUESTION) throw Error('question');
  if (typeof model !== 'string' || !/^[a-zA-Z0-9._-]{1,100}$/.test(model)) throw Error('model');
  return { model, instructions: INSTRUCTIONS, input: [{ role: 'user', content: question }],
    tools: [{ type: 'web_search' }], tool_choice: 'auto', text: { verbosity: 'low' }, store: false, stream: true };
}

export function answerFromSse(text) {
  let completed;
  for (const frame of text.replaceAll('\r\n', '\n').split('\n\n')) {
    const data = frame.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('\n');
    if (!data || data === '[DONE]') continue;
    const event = JSON.parse(data);
    if (['error', 'response.failed', 'response.incomplete'].includes(event.type)) throw Error('backend');
    if (event.type === 'response.completed') {
      if (completed) throw Error('duplicate completion');
      completed = event.response;
    }
  }
  if (completed?.status !== 'completed' || !Array.isArray(completed.output)) throw Error('incomplete');
  const parts = [], urls = new Set();
  for (const item of completed.output) {
    if (item.type === 'web_search_call' || item.type === 'reasoning') continue;
    if (item.type !== 'message' || item.role !== 'assistant' || !Array.isArray(item.content)) throw Error('unsupported output');
    for (const content of item.content) {
      if (content.type !== 'output_text' || typeof content.text !== 'string') throw Error('unsupported content');
      parts.push(content.text);
      for (const a of content.annotations ?? []) {
        if (a.type === 'url_citation' && typeof a.url === 'string' && /^https?:\/\//.test(a.url) && a.url.length <= 2048) urls.add(a.url);
      }
    }
  }
  let answer = parts.join('\n').trim();
  if (!answer) throw Error('empty');
  const citations = [...urls].slice(0, 8).filter(url => !answer.includes(url));
  if (citations.length) answer += '\n\nSources:\n' + citations.join('\n');
  if (Buffer.byteLength(answer) > MAX_ANSWER) throw Error('answer too large');
  return answer;
}

async function boundedBody(response, signal) {
  let size = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    signal.throwIfAborted();
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw Error('response too large');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function answer(question, model, getToken, signal, request = fetch) {
  const body = payload(question, model);
  const token = await getToken(signal);
  const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
  const account = claims['https://api.openai.com/auth']?.chatgpt_account_id;
  if (typeof account !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(account)) throw Error('account');
  const response = await request(ENDPOINT, {
    method: 'POST', redirect: 'error', signal,
    headers: { authorization: `Bearer ${token}`, 'chatgpt-account-id': account,
      'content-type': 'application/json', accept: 'text/event-stream', originator: 'pi-harness' },
    body: JSON.stringify(body),
  });
  if (!response.ok) { await response.body?.cancel(); throw Error('backend'); }
  return answerFromSse(await boundedBody(response, signal));
}

function atomicJson(filename, value) {
  const tmp = filename + '.tmp';
  const fd = fs.openSync(tmp, fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, filename);
  const dir = fs.openSync(path.dirname(filename), 'r');
  try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
}

function privateJson(filename) {
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > 16384 || (st.mode & 0o077)) throw Error('credential file');
    return JSON.parse(fs.readFileSync(fd, 'utf8'));
  } finally { fs.closeSync(fd); }
}

function validateCredential(c) {
  if (!c || c.type !== 'oauth' || typeof c.access !== 'string' || typeof c.refresh !== 'string' || !Number.isFinite(c.expires) || !c.access || !c.refresh) throw Error('credential');
  return c;
}

export function credentials(seedFile, stateFile, refresh) {
  const seed = privateJson(seedFile);
  if (Object.keys(seed).length !== 1 || !seed['openai-codex']) throw Error('dedicated credential required');
  const initial = validateCredential(seed['openai-codex']);
  const digest = createHash('sha256').update(JSON.stringify(seed)).digest('hex');
  let saved;
  try { saved = privateJson(stateFile); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (!saved || saved.seed !== digest) {
    saved = { seed: digest, credential: initial };
    atomicJson(stateFile, saved);
  }
  validateCredential(saved.credential);
  // The HTTP server admits exactly one request, so refresh cannot race.
  return async signal => {
    if (saved.credential.expires <= Date.now() + 60000) {
      const next = validateCredential(await refresh(saved.credential, signal));
      atomicJson(stateFile, { seed: digest, credential: next });
      saved = { seed: digest, credential: next };
    }
    return saved.credential.access;
  };
}

export function createServer(execute) {
  let busy = false;
  const server = http.createServer(async (req, res) => {
    const reject = status => { res.writeHead(status, { 'content-type': 'application/json', connection: 'close' }); res.end('{"error":"unavailable"}'); };
    if (req.method !== 'POST' || req.url !== '/answer') return reject(404);
    if (busy) return reject(503);
    busy = true;
    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(); reject(504); req.destroy(); }, TIMEOUT);
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    try {
      const chunks = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_QUESTION * 6 + 100) throw Error('request size');
        chunks.push(chunk);
      }
      const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!value || Object.keys(value).length !== 1 || typeof value.question !== 'string') throw Error('request shape');
      payload(value.question, 'validation');
      const result = await execute(value.question, controller.signal);
      if (typeof result !== 'string' || !result || Buffer.byteLength(result) > MAX_ANSWER) throw Error('answer');
      if (!res.destroyed && !res.writableEnded) {
        res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
        res.end(JSON.stringify({ answer: result }));
      }
    } catch {
      console.error('{"event":"model_request_failed"}');
      if (!res.destroyed && !res.writableEnded) reject(502);
    }
    finally { clearTimeout(timer); busy = false; }
  });
  server.headersTimeout = 10000;
  server.requestTimeout = TIMEOUT;
  server.maxConnections = 4;
  return server;
}

async function main() {
  const [socketPath, stateFile, seedFile, oauthModule, model] = process.argv.slice(2);
  payload('configuration check', model);
  const { openaiCodexOAuth } = await import(pathToFileURL(oauthModule).href);
  const getToken = credentials(seedFile, stateFile, (c, signal) => openaiCodexOAuth.refresh(c, signal));
  const server = createServer((q, signal) => answer(q, model, getToken, signal));
  // RuntimeDirectory is worker-owned; only this service may replace its socket.
  try { fs.unlinkSync(socketPath); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  server.listen(socketPath, () => {
    fs.chmodSync(socketPath, 0o660);
    console.log('{"event":"model_socket_ready","backendVerified":false}');
  });
  server.on('error', () => process.exit(1));
  process.on('SIGTERM', () => { server.close(); setTimeout(() => process.exit(0), 1000).unref(); });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.umask(0o077);
  main().catch(() => { console.error('pi-chat-model: startup failed (details redacted)'); process.exitCode = 1; });
}
