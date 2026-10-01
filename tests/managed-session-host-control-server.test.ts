import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { HostControlServer } from "../config/agent/extensions/managed-sessions/relay/host-control-server.js";
import { HostDispatcher } from "../config/agent/extensions/managed-sessions/relay/host-dispatcher.js";
import { HostPolicy } from "../config/agent/extensions/managed-sessions/relay/host-policy.js";
import { peerUidFromHelper } from "../config/agent/extensions/managed-sessions/relay/peer-uid.js";
import type { PeerUidResolver } from "../config/agent/extensions/managed-sessions/relay/ipc-server.js";

const uid = process.getuid!();
const status = { hostId: "host", relayState: "ready", capabilities: ["host-control-v1"], accountState: "unavailable" };
const request = { version: "1.0.0", actor: { kind: "human_local", requestId: "status-1" }, action: { operation: "host.status" } };
const frame = (value: unknown) => `${JSON.stringify(value)}\n`;
function probe(path: string, data: string | Buffer, end = false): Promise<string> {
	return new Promise((done, reject) => {
		const socket = createConnection(path); const chunks: Buffer[] = [];
		const deadline = setTimeout(() => { socket.destroy(); reject(Error("Control probe timed out")); }, 2_000);
		socket.on("error", () => undefined);
		socket.on("data", (chunk) => chunks.push(chunk));
		socket.on("close", () => { clearTimeout(deadline); done(Buffer.concat(chunks).toString("utf8")); });
		socket.once("connect", () => { if (end) socket.end(data); else socket.write(data); });
	});
}
async function setup(t: TestContext, options: { peerUid?: PeerUidResolver; read?: () => Promise<unknown>; start?: boolean } = {}) {
	const directory = await mkdtemp(join(tmpdir(), "pi-host-control-")); let reads = 0;
	const dispatcher = new HostDispatcher({ hostId: "host", protectedConversationId: `conv_${"b".repeat(32)}`,
		policy: new HostPolicy(JSON.parse(readFileSync("config/agent/managed-host-policy.json", "utf8"))),
		read: async () => { reads++; return options.read ? options.read() : status; } });
	const server = new HostControlServer({ runtimeDirectory: directory, expectedUid: uid, peerUid: options.peerUid ?? (() => uid), dispatcher });
	t.after(async () => { await server.close(); await rm(directory, { recursive: true, force: true }); });
	if (options.start !== false) await server.start();
	return { server, directory, reads: () => reads };
}

test("private host socket accepts one strict local-human request without adapter attachment", async (t) => {
	const { server, directory, reads } = await setup(t);
	assert.equal((await lstat(directory)).mode & 0o777, 0o700);
	assert.equal((await lstat(server.socketPath)).mode & 0o777, 0o600);
	const response = JSON.parse(await probe(server.socketPath, frame(request)));
	assert.equal(response.ok, true); assert.deepEqual(response.data, status); assert.equal(reads(), 1);
	const forged = { ...request, actor: { kind: "model", requestId: "model-1", conversationId: `conv_${"a".repeat(32)}`,
		generationId: `generation_${"a".repeat(32)}`, runId: "run", toolCallId: "call", presentation: "local_dialog" } };
	assert.equal(JSON.parse(await probe(server.socketPath, frame(forged))).error.code, "forbidden");
	assert.equal(JSON.parse(await probe(server.socketPath, frame({ ...request, version: "9.0.0" }))).error.code, "upgrade_required");
	assert.equal(reads(), 1);
});

test("host socket fails closed on foreign, unknown or failed peer verification", async (t) => {
	for (const peerUid of [() => uid + 1, () => undefined, () => { throw Error("peer failure"); }]) {
		const { server, reads } = await setup(t, { peerUid });
		assert.equal(await probe(server.socketPath, frame(request)), ""); assert.equal(reads(), 0);
	}
});

test("host socket rejects invalid UTF-8, oversized, multiple and incomplete frames before dispatch", async (t) => {
	const { server, reads } = await setup(t);
	for (const data of [Buffer.from([0xff, 10]), "x".repeat(64 * 1024) + "\n", frame(request) + frame(request), "{bad-json}\n"]) {
		assert.equal(JSON.parse(await probe(server.socketPath, data)).error.code, "invalid_request");
	}
	assert.equal(JSON.parse(await probe(server.socketPath, "{", true)).error.code, "invalid_request");
	assert.equal(reads(), 0);
});

test("shutdown drains admitted work before returning even after the client disconnects", async (t) => {
	let release!: () => void; const gate = new Promise<void>((done) => { release = done; });
	let entered!: () => void; const admitted = new Promise<void>((done) => { entered = done; });
	const { server } = await setup(t, { read: async () => { entered(); await gate; return status; } });
	const response = probe(server.socketPath, frame(request));
	let closing: Promise<void> | undefined;
	try {
		await admitted; let closed = false;
		closing = server.close().then(() => { closed = true; });
		await new Promise<void>((done) => setImmediate(done));
		assert.equal(closed, false); assert.equal(await response, "");
	} finally { release(); }
	await closing;
	await assert.rejects(lstat(server.socketPath), { code: "ENOENT" });
});

test("shutdown drains in-flight authentication and cannot admit it afterward", async (t) => {
	let release!: (uid: number) => void; const gate = new Promise<number>((done) => { release = done; });
	let entered!: () => void; const authenticating = new Promise<void>((done) => { entered = done; });
	const { server, reads } = await setup(t, { peerUid: () => { entered(); return gate; } });
	const response = probe(server.socketPath, frame(request)); let closing: Promise<void> | undefined;
	try {
		await authenticating; let closed = false;
		closing = server.close().then(() => { closed = true; });
		await new Promise<void>((done) => setImmediate(done)); assert.equal(closed, false);
	} finally { release(uid); }
	await closing; await response; assert.equal(reads(), 0);
});

test("startup ownership rejects non-sockets and close racing startup leaves no listener", async (t) => {
	const first = await setup(t, { start: false });
	await writeFile(first.server.socketPath, "unrelated file");
	await assert.rejects(first.server.start(), /unowned/);
	assert.equal(await readFile(first.server.socketPath, "utf8"), "unrelated file");
	const second = await setup(t, { start: false });
	const starting = second.server.start(); const closing = second.server.close();
	await Promise.all([starting, closing]);
	await assert.rejects(lstat(second.server.socketPath), { code: "ENOENT" });
	await assert.rejects(second.server.start(), /twice/);
});

test("packaged OS peer helper authenticates the real control connection", { skip: !process.env.PI_MANAGED_SESSIONS_TEST_PEER_UID_HELPER }, async (t) => {
	const helper = process.env.PI_MANAGED_SESSIONS_TEST_PEER_UID_HELPER!;
	const { server, reads } = await setup(t, { peerUid: (socket) => peerUidFromHelper(helper, socket) });
	assert.equal(JSON.parse(await probe(server.socketPath, frame(request))).ok, true); assert.equal(reads(), 1);
});
