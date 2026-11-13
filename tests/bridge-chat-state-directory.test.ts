import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assistantPolicyFingerprint, OwnerMatrix, Store } from "../config/agent/extensions/bridge-chat/transport.js";
import { TrustedInvitations } from "../config/agent/extensions/bridge-chat/trusted-invites.js";

const OWNER = "@owner:example.test", BOT = "@bot:example.test", TOKEN = "synthetic-state-directory-token";

test("transport starts invitations through its declared state alias and reuses both existing cursors", async t => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-service-state-"));
	const target = path.join(root, "private", "state"), alias = path.join(root, "state");
	fs.mkdirSync(target, { recursive: true, mode: 0o700 });
	fs.symlinkSync("private/state", alias);
	const credentials = path.join(root, "credentials"); fs.mkdirSync(credentials, { mode: 0o700 });
	fs.writeFileSync(path.join(credentials, "matrix"), TOKEN, { mode: 0o600 });
	const config = { homeserver: "https://example.test", ownerUserId: OWNER, remoteOwnerUserIds: [], roomIds: ["!chat:example.test"], allJoinedRooms: false, modelSocket: "/unused", trustedBridgeBots: { fixture: BOT } };
	const configPath = path.join(root, "config.json"), trace = path.join(root, "sync.jsonl");
	fs.writeFileSync(configPath, JSON.stringify(config));
	const store = new Store(path.join(target, "requests.sqlite"));
	store.put("identity", assistantPolicyFingerprint(config, TOKEN)); store.put("cursor", "kept-assistant-cursor"); store.close();
	const http = new OwnerMatrix({ homeserver: config.homeserver, accessToken: TOKEN }, async () => { throw Error("No parent HTTP allowed"); }).http;
	const invitations = new TrustedInvitations(path.join(target, "bridge-invites.sqlite"), http, OWNER, config.trustedBridgeBots);
	invitations.ingest({ next_batch: "kept-invitation-cursor", rooms: {} }); invitations.close();
	const inodes = ["requests.sqlite", "bridge-invites.sqlite"].map(name => fs.statSync(path.join(target, name)).ino);
	const preload = path.join(root, "matrix.cjs");
	fs.writeFileSync(preload, `global.fetch = async (raw, init = {}) => {
		const url = new URL(raw);
		if (url.pathname.endsWith('/account/whoami')) return new Response(JSON.stringify({ user_id: ${JSON.stringify(OWNER)}, device_id: 'fixture' }));
		if (!url.pathname.endsWith('/sync')) throw Error('Unexpected synthetic HTTP request');
		const invitation = JSON.parse(url.searchParams.get('filter')).room.timeline.types[0] === 'm.room.member';
		require('node:fs').appendFileSync(${JSON.stringify(trace)}, JSON.stringify({ kind: invitation ? 'invitation' : 'assistant', since: url.searchParams.get('since') }) + '\\n');
		await new Promise((resolve, reject) => {
			const abort = () => { clearTimeout(timer); reject(new DOMException('Fixture stopped', 'AbortError')); };
			const timer = setTimeout(() => { init.signal?.removeEventListener('abort', abort); resolve(); }, 20);
			if (init.signal?.aborted) abort(); else init.signal?.addEventListener('abort', abort, { once: true });
		});
		return new Response(JSON.stringify({ next_batch: invitation ? 'invitation-next' : 'assistant-next', rooms: {} }));
	};`);
	const child = spawn(process.execPath, ["--require", preload, require.resolve("../config/agent/extensions/bridge-chat/main.js"), configPath], {
		env: { ...process.env, NODE_OPTIONS: "", CREDENTIALS_DIRECTORY: credentials, STATE_DIRECTORY: alias }, stdio: ["ignore", "pipe", "pipe"],
	});
	const closed = once(child, "close");
	t.after(async () => {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
		let timer: NodeJS.Timeout | undefined;
		await Promise.race([closed, new Promise<void>(resolve => { timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 2000); })]);
		clearTimeout(timer); await closed; fs.rmSync(root, { recursive: true, force: true });
	});
	let output = "", errors = "", finish: (event: { event?: string; unavailable?: boolean }) => void;
	const observed = new Promise<{ event?: string; unavailable?: boolean }>(resolve => { finish = resolve; });
	child.stderr.on("data", chunk => { errors += chunk; });
	child.stdout.on("data", chunk => {
		output += chunk;
		for (const line of output.split("\n")) {
			try { const event = JSON.parse(line); if (["bridge_invitations", "bridge_invitations_unavailable"].includes(event.event)) finish(event); } catch { /* Incomplete stdout line. */ }
		}
	});
	let deadline: NodeJS.Timeout | undefined;
	const outcome = await Promise.race([observed, closed.then(() => ({ event: "exited" })), new Promise<{ event: string }>(resolve => { deadline = setTimeout(() => resolve({ event: "timeout" }), 5000); })]);
	clearTimeout(deadline);
	assert.equal(outcome.event, "bridge_invitations", output + errors);
	assert.equal((outcome as { unavailable?: boolean }).unavailable, false);
	assert.ok(!(output + errors).includes(TOKEN));
	assert.deepEqual(["requests.sqlite", "bridge-invites.sqlite"].map(name => fs.statSync(path.join(target, name)).ino), inodes);
	const requests = fs.readFileSync(trace, "utf8").trim().split("\n").map(line => JSON.parse(line));
	assert.deepEqual(requests.find(row => row.kind === "assistant"), { kind: "assistant", since: "kept-assistant-cursor" });
	assert.deepEqual(requests.find(row => row.kind === "invitation"), { kind: "invitation", since: "kept-invitation-cursor" });
});

for (const scenario of ["group-readable", "world-readable", "foreign-owner", "not-directory"] as const) {
	test(`transport refuses ${scenario} canonical state before creating either journal`, t => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-unsafe-state-"));
		t.after(() => fs.rmSync(root, { recursive: true, force: true }));
		const target = path.join(root, "target"), alias = path.join(root, "state");
		if (scenario === "not-directory") fs.writeFileSync(target, "not a directory");
		else { fs.mkdirSync(target, { mode: 0o700 }); fs.chmodSync(target, scenario === "group-readable" ? 0o750 : scenario === "world-readable" ? 0o704 : 0o700); }
		fs.symlinkSync(target, alias);
		fs.writeFileSync(path.join(root, "matrix"), TOKEN, { mode: 0o600 });
		const config = path.join(root, "config.json"), preload = path.join(root, "matrix.cjs");
		fs.writeFileSync(config, JSON.stringify({ homeserver: "https://example.test", ownerUserId: OWNER, remoteOwnerUserIds: [], roomIds: ["!chat:example.test"], allJoinedRooms: false, modelSocket: "/unused", trustedBridgeBots: { fixture: BOT } }));
		fs.writeFileSync(preload, `global.fetch = async url => {
			if (new URL(url).pathname.endsWith('/sync')) process.exit(0);
			return new Response(JSON.stringify({ user_id: ${JSON.stringify(OWNER)}, device_id: 'fixture' }));
		};
		${scenario === "foreign-owner" ? `const fs = require('node:fs'), lstat = fs.lstatSync;
		fs.lstatSync = (...args) => { const st = lstat(...args); return String(args[0]) === ${JSON.stringify(target)} ? Object.assign(st, { uid: process.getuid() + 1 }) : st; };` : ""}`);
		const result = spawnSync(process.execPath, ["--require", preload, require.resolve("../config/agent/extensions/bridge-chat/main.js"), config], {
			encoding: "utf8", timeout: 5000, env: { ...process.env, NODE_OPTIONS: "", CREDENTIALS_DIRECTORY: root, STATE_DIRECTORY: alias },
		});
		assert.equal(result.error, undefined); assert.equal(result.status, 1, result.stdout + result.stderr);
		const failure = result.stderr.split("\n").find(line => line.startsWith('{"event":"transport_failed"'));
		assert.ok(failure, result.stderr); assert.equal(JSON.parse(failure).stage, "database_open");
		assert.equal(fs.existsSync(path.join(target, "requests.sqlite")), false);
		assert.equal(fs.existsSync(path.join(target, "bridge-invites.sqlite")), false);
		assert.ok(!(result.stdout + result.stderr).includes(TOKEN));
	});
}

test("invitation filenames still reject arbitrary directory aliases and unsafe journal inodes", t => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-strict-journal-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const http = new OwnerMatrix({ homeserver: "https://example.test", accessToken: TOKEN }, async () => { throw Error("No HTTP allowed"); }).http;
	const target = path.join(root, "private"); fs.mkdirSync(target, { mode: 0o700 });
	const alias = path.join(root, "alias"); fs.symlinkSync(target, alias);
	assert.throws(() => new TrustedInvitations(path.join(alias, "journal.sqlite"), http, OWNER, { fixture: BOT }), /Invitation state must be private/);
	assert.equal(fs.existsSync(path.join(target, "journal.sqlite")), false);
	for (const variant of ["symlink", "hardlink", "group-readable"] as const) {
		const original = path.join(target, variant + "-original"), journal = path.join(target, variant + ".sqlite");
		fs.writeFileSync(original, "unchanged journal evidence", { mode: 0o600 });
		if (variant === "symlink") fs.symlinkSync(original, journal);
		else if (variant === "hardlink") fs.linkSync(original, journal);
		else { fs.renameSync(original, journal); fs.chmodSync(journal, 0o640); }
		assert.throws(() => new TrustedInvitations(journal, http, OWNER, { fixture: BOT }), /Unsafe invitation journal/);
		assert.equal(fs.readFileSync(variant === "group-readable" ? journal : original, "utf8"), "unchanged journal evidence");
	}
});
