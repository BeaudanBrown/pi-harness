import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startManagedSessionRelay } from "../config/agent/extensions/managed-sessions/relay/main.js";
import { provisioningFixture } from "./fixtures/managed-matrix-provisioning.js";

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

test("production relay keeps IPC alive while fresh coordinator provisioning is pending", { timeout: 10_000 }, async (t) => {
	const peer = process.env.PI_MANAGED_SESSIONS_TEST_PEER_UID_HELPER;
	const lock = process.env.PI_MANAGED_SESSIONS_TEST_RELAY_LOCK_HELPER;
	if (!peer || !lock) return t.skip("packaged security helpers unavailable");
	const root = await mkdtemp(join(tmpdir(), "relay-provisioning-ipc-"));
	const originalFetch = globalThis.fetch; const controller = new AbortController();
	const state = { rooms: ["!host:example.com", "!coordinator:example.com"], createCalls: 0 };
	const provision = provisioningFixture("@bot:example.com", state);
	let blocked = true; let failed!: () => void; const waiting = new Promise<void>((resolve) => { failed = resolve; });
	let starting: ReturnType<typeof startManagedSessionRelay> | undefined;
	let relay: Awaited<ReturnType<typeof startManagedSessionRelay>> | undefined;
	t.after(async () => { controller.abort(); await starting?.catch(() => undefined); await relay?.stop(); globalThis.fetch = originalFetch; await rm(root, { recursive: true, force: true }); });
	globalThis.fetch = async (input, init) => {
		const url = new URL(String(input));
		if (url.pathname.endsWith("/whoami")) return Response.json({ user_id: "@bot:example.com" });
		if (url.pathname.endsWith("/state") && blocked) { failed(); return Response.json({ errcode: "M_UNKNOWN" }, { status: 503 }); }
		const response = await provision(input, init); if (response) return response;
		if (url.pathname.endsWith("/sync")) {
			if (!url.searchParams.has("since")) return Response.json({ next_batch: "ready", rooms: { join: {} } });
			if (!init?.signal?.aborted) await new Promise<void>((resolve) => init?.signal?.addEventListener("abort", () => resolve(), { once: true }));
			throw Object.assign(Error("cancelled"), { name: "AbortError" });
		}
		return Response.json({});
	};
	starting = startManagedSessionRelay({
		PI_MANAGED_SESSIONS_RUNTIME_DIR: join(root, "runtime"), PI_MANAGED_SESSIONS_STATE_DIR: join(root, "state"),
		PI_MANAGED_SESSIONS_MANIFEST_DIR: join(root, "manifests"), PI_MANAGED_SESSIONS_HOST_ID: `test-${randomUUID()}`,
		PI_MANAGED_SESSIONS_PEER_UID_HELPER: peer, PI_MANAGED_SESSIONS_RELAY_LOCK_HELPER: lock,
		PI_MANAGED_COORDINATOR_WORKSPACE_DIR: join(root, "workspace"), PI_MANAGED_COORDINATOR_SESSION_FILE: join(root, "sessions", "coordinator.jsonl"),
		PI_MANAGED_COORDINATOR_LAUNCHER: "/never-invoked", PI_MATRIX_HOMESERVER: "https://matrix.example.com",
		PI_MATRIX_ACCESS_TOKEN: "test-token", PI_MATRIX_BOT_USER_ID: "@bot:example.com", PI_MATRIX_OPERATOR_USER_ID: "@operator:example.com",
	}, controller.signal);
	void starting.catch(() => undefined);
	await waiting;
	assert.ok((await stat(join(root, "runtime", "relay.sock"))).isSocket());
	let health: string | undefined;
	for (let attempt = 0; attempt < 200 && health !== "blocked"; attempt++) {
		health = JSON.parse(await readFile(join(root, "runtime", "sync-health.json"), "utf8")).status;
		if (health !== "blocked") await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.equal(health, "blocked", "pending bootstrap does not claim remote readiness");
	blocked = false; relay = await starting;
	assert.equal(state.createCalls, 2, "uncertain host create is recovered instead of duplicated");
});
