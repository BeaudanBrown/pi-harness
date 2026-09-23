import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startManagedSessionRelay } from "../config/agent/extensions/managed-sessions/relay/main.js";

test("production relay opens local IPC before remote authentication finishes", { timeout: 10_000 }, async (t) => {
	const peer = process.env.PI_MANAGED_SESSIONS_TEST_PEER_UID_HELPER;
	const lock = process.env.PI_MANAGED_SESSIONS_TEST_RELAY_LOCK_HELPER;
	if (!peer || !lock) return t.skip("packaged security helpers unavailable");
	const root = await mkdtemp(join(tmpdir(), "relay-startup-ipc-"));
	await mkdir(join(root, "manifests"), { mode: 0o700 });
	let release!: () => void;
	const gate = new Promise<void>(resolve => { release = resolve; });
	let authenticating!: () => void;
	const began = new Promise<void>(resolve => { authenticating = resolve; });
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => { authenticating(); await gate; return Response.json({ user_id: "@bot:example.com" }); };
	let relay: Awaited<ReturnType<typeof startManagedSessionRelay>> | undefined;
	t.after(async () => { release(); await relay?.stop(); globalThis.fetch = originalFetch; await rm(root, { recursive: true, force: true }); });
	const starting = startManagedSessionRelay({
		PI_MANAGED_SESSIONS_RUNTIME_DIR: join(root, "runtime"), PI_MANAGED_SESSIONS_STATE_DIR: join(root, "state"),
		PI_MANAGED_SESSIONS_MANIFEST_DIR: join(root, "manifests"), PI_MANAGED_SESSIONS_HOST_ID: `test-${randomUUID()}`,
		PI_MANAGED_SESSIONS_PEER_UID_HELPER: peer, PI_MANAGED_SESSIONS_RELAY_LOCK_HELPER: lock,
		PI_MATRIX_HOMESERVER: "https://matrix.example.com", PI_MATRIX_ACCESS_TOKEN: "test-token", PI_MATRIX_BOT_USER_ID: "@bot:example.com",
		PI_MATRIX_OPERATOR_USER_ID: "@operator:example.com",
	});
	await began;
	assert.ok((await stat(join(root, "runtime", "relay.sock"))).isSocket());
	release(); relay = await starting;
});
