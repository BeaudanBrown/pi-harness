import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { FileSession } from '../config/agent/extensions/bridge-chat/file-tools.mjs';
import { stageFile, readStagedFile, sweepFiles } from '../config/agent/extensions/bridge-chat/file-store.js';
import { fileRefs } from '../config/agent/extensions/bridge-chat/file-types.js';
import { Store, OwnerMatrix, type ChatConfig } from '../config/agent/extensions/bridge-chat/transport.js';
import { createQuestionServer, modelAnswer } from '../config/agent/extensions/bridge-chat/socket.js';

function fixture(t: { after(fn: () => void): void }, body = "require('node:fs').writeFileSync(require('node:path').join(process.argv[2], 'payload'), 'downloaded text')") {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-chat-files-')), directory = path.join(root, 'spool'); fs.mkdirSync(directory);
	const downloader = path.join(root, 'download.cjs');
	fs.writeFileSync(downloader, `#!${process.execPath}\nprocess.stdin.resume(); process.stdin.on('end', () => { ${body} });\n`, { mode: 0o700 });
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	return { root, directory, downloader };
}
const cfg: ChatConfig = { homeserver: 'https://matrix.example', ownerUserId: '@owner:example', remoteOwnerUserIds: [], allJoinedRooms: false, roomIds: ['!self:example'], modelSocket: '/unused' };

test('private spool rejects unsafe content/paths, survives umask, detects mutation and expires abandoned bytes', async t => {
	const f = fixture(t), mask = process.umask(0o077);
	let ref;
	try { ref = await stageFile(f.directory, 'note.txt', Buffer.from('hello')); } finally { process.umask(mask); }
	assert.equal(fs.statSync(path.join(f.directory, ref.id)).mode & 0o777, 0o640);
	assert.equal(readStagedFile(f.directory, ref).toString(), 'hello');
	for (const [name, data] of [['../note.txt', 'text'], ['auth.json', '{}'], ['page.pdf', '<html>Error</html>'], ['run.sh', '#!/bin/sh'], ['page.html', '<html>'], ['image.svg', '<svg/>']]) await assert.rejects(stageFile(f.directory, name, Buffer.from(data)));
	assert.throws(() => fileRefs([{ ...ref, id: '../outside' }]));
	fs.writeFileSync(path.join(f.directory, ref.id), 'other'); assert.throws(() => readStagedFile(f.directory, ref), /changed/);
	const old = new Date(Date.now() - 25 * 3600000); fs.utimesSync(path.join(f.directory, ref.id), old, old);
	assert.equal(sweepFiles(f.directory), 0); assert.equal(fs.readdirSync(f.directory).length, 0);
});

test('chat-only tools download without environment credentials, queue only current-request handles, and never publish', async t => {
	const f = fixture(t, "require('node:fs').writeFileSync(require('node:path').join(process.argv[2], 'payload'), JSON.stringify(process.env))");
	process.env.CHAT_DOWNLOAD_CREDENTIAL_CANARY = 'must-not-be-inherited'; t.after(() => { delete process.env.CHAT_DOWNLOAD_CREDENTIAL_CANARY; });
	const session = new FileSession(f);
	const result = await session.download('https://example.org/data.json', 'data.json');
	assert.deepEqual(Object.keys(result).sort(), ['bytes', 'file', 'filename']);
	await assert.rejects(new FileSession(f).send(result.file), /this request/);
	await assert.rejects(session.send('/etc/passwd'), /approved workspace/);
	await assert.rejects(session.download('https://example.org/a', 'a.txt', 'inbox/a.txt'), /no approved project/);
	assert.equal((await session.send(result.file)).queued, true);
	const refs = session.finish(true); assert.equal(refs.length, 1);
	assert.deepEqual(JSON.parse(readStagedFile(f.directory, refs[0]!).toString()), {});
});

test('download cancellation kills the subprocess and removes partial staging', async t => {
	const f = fixture(t, "setTimeout(() => {}, 60000)");
	const session = new FileSession(f), controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 50);
	try { await assert.rejects(session.download('https://example.org/a', 'a.txt', undefined, controller.signal), /cancelled/); }
	finally { clearTimeout(timer); }
	assert.deepEqual(fs.readdirSync(f.directory), []);
});

test('finishing a request removes all unselected downloads even beyond attachment-count limit', async t => {
	const f = fixture(t), session = new FileSession(f);
	for (let i = 0; i < 6; i++) await session.download('https://example.org/a', 'a.txt');
	assert.equal(fs.readdirSync(f.directory).length, 6);
	assert.deepEqual(session.finish(true), []); assert.deepEqual(fs.readdirSync(f.directory), []);
});

test('owner-account media uploads use original room, bounded bytes and no retry on uncertain POST', async t => {
	const f = fixture(t), ref = await stageFile(f.directory, 'note.txt', Buffer.from('hello'));
	const calls: { url: string; init: RequestInit }[] = [];
	const fetcher = (async (url: unknown, init: RequestInit) => {
		calls.push({ url: String(url), init });
		return new Response(JSON.stringify(init.method === 'POST' ? { content_uri: 'mxc://matrix.example/media' } : { event_id: '$sent' }));
	}) as typeof fetch;
	const matrix = new OwnerMatrix({ homeserver: cfg.homeserver, accessToken: 'owner-token', filesDirectory: f.directory }, fetcher);
	await matrix.sendFile('!self:example', 'fixed-file-0', ref);
	assert.equal(calls.length, 2); assert.equal(calls[0]!.init.method, 'POST');
	assert.equal(Buffer.from(calls[0]!.init.body as Uint8Array).toString(), 'hello');
	assert.equal((calls[0]!.init.headers as Record<string, string>).Authorization, 'Bearer owner-token');
	assert.ok(calls[1]!.url.includes('/rooms/!self%3Aexample/send/m.room.message/fixed-file-0'));
	assert.equal(JSON.parse(calls[1]!.init.body as string).msgtype, 'm.file');
	let failures = 0;
	const broken = new OwnerMatrix({ homeserver: cfg.homeserver, accessToken: 'owner-token', filesDirectory: f.directory }, (async () => { failures++; throw Error('unknown outcome'); }) as typeof fetch);
	await assert.rejects(broken.sendFile('!self:example', 'fixed', ref)); assert.equal(failures, 1);
});

test('existing durable reply state recovers ready attachments but never retries an uncertain send', async t => {
	const f = fixture(t), ref = await stageFile(f.directory, 'note.txt', Buffer.from('hello'));
	const filename = path.join(f.root, 'state.sqlite'); let store = new Store(filename);
	t.after(() => store.close());
	store.db.prepare("INSERT INTO requests(id,room,created,phase,answer,files) VALUES (?,?,?,'ready',?,?)").run('one', '!self:example', Date.now(), 'queued reply', JSON.stringify([ref]));
	store.close(); store = new Store(filename);
	let attempts = 0;
	const matrix = { usable: async () => true, send: async () => assert.fail('no success text after uncertain attachment'), sendFile: async (room: string, txn: string) => {
		assert.equal(room, '!self:example'); assert.equal(txn, 'pi-one-file-0');
		assert.equal(store.db.prepare('SELECT phase FROM requests').get()!.phase, 'sending');
		attempts++; throw Error('lost acknowledgement');
	} };
	await store.step(matrix, async () => assert.fail('ready answer must not rerun model'), { ...cfg, filesDirectory: f.directory });
	assert.equal(attempts, 1); assert.deepEqual(fs.readdirSync(f.directory), []);
	store.close(); store = new Store(filename);
	await store.step(matrix, async () => assert.fail('no rerun'), { ...cfg, filesDirectory: f.directory });
	assert.equal(attempts, 1); assert.equal(store.db.prepare('SELECT files FROM requests').get()!.files, '[]');
});

test('attachment descriptors cross the question socket but cannot contain destinations or bytes', async t => {
	const f = fixture(t), ref = await stageFile(f.directory, 'note.txt', Buffer.from('hello'));
	const server = createQuestionServer(async () => ({ text: 'Attached.', files: [ref] }));
	const socket = path.join(f.root, 'model.sock'); server.listen(socket); await once(server, 'listening');
	t.after(() => server.close());
	assert.deepEqual(await modelAnswer(socket, 'send file'), { text: 'Attached.', files: [ref] });
	assert.throws(() => fileRefs([{ ...ref, room: '!elsewhere:example' }]));
	assert.throws(() => fileRefs([{ ...ref, data: 'private contents' }]));
});
