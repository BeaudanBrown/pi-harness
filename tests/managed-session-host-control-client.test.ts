import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { requestHostControl } from "../config/agent/extensions/managed-sessions/relay/host-control-client.js";

const requestId = "client-1";
const valid = { version: "1.0.0", requestId, ok: true, data: { hostId: "host", relayState: "ready", capabilities: ["host-control-v1"], accountState: "unavailable" } };

test("client bounds and validates response framing, version, identity and private fields", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pi-host-client-")); const socketPath = join(directory, "control.sock");
	let reply: string | Buffer = `${JSON.stringify(valid)}\n`;
	const server = createServer((socket) => { socket.on("error", () => undefined); socket.once("data", () => socket.end(reply)); });
	await new Promise<void>((done) => server.listen(socketPath, done)); await chmod(socketPath, 0o600);
	t.after(async () => { await new Promise<void>((done) => server.close(() => done())); await rm(directory, { recursive: true, force: true }); });
	const call = () => requestHostControl({ socketPath, action: { operation: "host.status" }, requestId });
	assert.equal((await call()).ok, true);
	for (const [body, expected] of [
		[`${JSON.stringify({ ...valid, requestId: "other" })}\n`, "failed"],
		[`${JSON.stringify({ ...valid, version: "2.0.0" })}\n`, "upgrade_required"],
		[`${JSON.stringify({ ...valid, data: { ...valid.data, nonce: "private-secret" } })}\n`, "failed"],
		[`${JSON.stringify(valid)}\n${JSON.stringify(valid)}\n`, "failed"],
		[`${JSON.stringify(valid)}`, "failed"],
		["x".repeat(64 * 1024) + "\n", "failed"],
		[Buffer.from([0xff, 10]), "failed"],
		["", "unavailable"],
	] as const) {
		reply = body; const result = await call();
		assert.equal(result.ok, false); if (result.ok) assert.fail();
		assert.equal(result.error.code, expected); assert.ok(!JSON.stringify(result).includes("private-secret"));
	}
	await chmod(socketPath, 0o660);
	const unsafe = await call(); assert.equal(unsafe.ok, false); if (unsafe.ok) assert.fail();
	assert.equal(unsafe.error.code, "forbidden");
});

test("client rejects absent and non-socket endpoints without leaking paths", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pi-host-client-missing-")); const socketPath = join(directory, "control.sock");
	t.after(() => rm(directory, { recursive: true, force: true }));
	const call = () => requestHostControl({ socketPath, action: { operation: "host.status" }, requestId });
	const missing = await call(); assert.equal(missing.ok, false); if (missing.ok) assert.fail();
	assert.equal(missing.error.code, "unavailable"); assert.ok(!JSON.stringify(missing).includes(directory));
	await writeFile(socketPath, "not a socket", { mode: 0o600 });
	const regular = await call(); assert.equal(regular.ok, false); if (regular.ok) assert.fail();
	assert.equal(regular.error.code, "forbidden");
});
