import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { startManagedSessionRelay } from "../config/agent/extensions/managed-sessions/relay/main.js";
import { provisioningFixture } from "./fixtures/managed-matrix-provisioning.js";
import { BoundAdapterClient, CoordinatorAdapterClient, requestLocalBind } from "../config/agent/extensions/managed-sessions/adapter/client.js";
import { deriveTranscriptEntryId } from "../config/agent/extensions/managed-sessions/contracts.js";
import { requestHostControl } from "../config/agent/extensions/managed-sessions/relay/host-control-client.js";
import { HostLifecycle } from "../config/agent/extensions/managed-sessions/relay/host-lifecycle.js";
import { deriveGenerationId } from "../config/agent/extensions/managed-sessions/v2-contracts.js";

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
	await assert.rejects(stat(join(root, "runtime", "control.sock")), { code: "ENOENT" });
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

test("production IPC admits and restores a roomless source before authentication, then binds without launching", { timeout: 25_000 }, async (t) => {
	const peer = process.env.PI_MANAGED_SESSIONS_TEST_PEER_UID_HELPER; const lock = process.env.PI_MANAGED_SESSIONS_TEST_RELAY_LOCK_HELPER;
	if (!peer || !lock) return t.skip("packaged security helpers unavailable");
	const root = await mkdtemp(join(tmpdir(), "relay-local-enrollment-")); const cwd = join(root, "project"); await mkdir(cwd);
	const launcher = join(root, "metadata-launcher"); const operations = join(root, "operations.jsonl");
	const placement = { rootKey: "projects", workspace: "project", relativeCwd: "" };
	await writeFile(launcher, `#!${process.execPath}\nconst fs = require('node:fs');
const operation = process.argv[3]; fs.appendFileSync(${JSON.stringify(operations)}, JSON.stringify(operation) + '\\n');
if (!['workspace-identify','workspace-resolve'].includes(operation)) process.exit(99);
process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(JSON.stringify(operation === 'workspace-identify' ? ${JSON.stringify({ ...placement, cwd })} : ${JSON.stringify({ ...placement, cwd, workspacePath: cwd,
		projectKey: `project_${"a".repeat(32)}`, projectDisplayName: "Project", checkoutDisplayName: "main" })})));
`, { mode: 0o700 });
	const sessionId = "local-source"; const creationKey = "local-enrollment"; const concept = "Local work";
	const sourceSessionFile = join(root, "source.jsonl"); const bindingBoundaryEntryId = deriveTranscriptEntryId(sessionId, "boundary");
	const sourceBytes = [{ type: "session", version: 3, id: sessionId, cwd, timestamp: new Date().toISOString() },
		{ type: "custom", id: "boundary", parentId: null, customType: "managed-session.binding-boundary", data: { version: "1.0.0", creationKey, concept, sessionId } }]
		.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
	await writeFile(sourceSessionFile, sourceBytes, { mode: 0o600 });
	const policyPath = join(root, "host-policy.json");
	await writeFile(policyPath, await readFile(resolve("config/agent/managed-host-policy.json")));
	const environment = { PI_MANAGED_HOST_ACTION_POLICY: policyPath, PI_MANAGED_SESSIONS_RUNTIME_DIR: join(root, "runtime"), PI_MANAGED_SESSIONS_STATE_DIR: join(root, "state"),
		PI_MANAGED_SESSIONS_MANIFEST_DIR: join(root, "manifests"), PI_MANAGED_SESSIONS_HOST_ID: `test-${randomUUID()}`,
		PI_MANAGED_SESSIONS_PEER_UID_HELPER: peer, PI_MANAGED_SESSIONS_RELAY_LOCK_HELPER: lock,
		PI_MANAGED_COORDINATOR_WORKSPACE_DIR: join(root, "neutral"), PI_MANAGED_COORDINATOR_SESSION_FILE: join(root, "sessions", "coordinator.jsonl"),
		PI_MANAGED_COORDINATOR_LAUNCHER: launcher, PI_MATRIX_HOMESERVER: "https://matrix.example.com", PI_MATRIX_ACCESS_TOKEN: "test-token",
		PI_MATRIX_BOT_USER_ID: "@bot:example.com", PI_MATRIX_OPERATOR_USER_ID: "@operator:example.com" };
	await assert.rejects(startManagedSessionRelay({ ...environment, PI_MANAGED_SESSIONS_SOCKET: join(root, "runtime", "control.sock") }), /separate socket paths/);
	await assert.rejects(stat(join(root, "runtime")), { code: "ENOENT" });
	const originalFetch = globalThis.fetch;
	let signal = new AbortController(); let starting: ReturnType<typeof startManagedSessionRelay> | undefined;
	let relay: Awaited<ReturnType<typeof startManagedSessionRelay>> | undefined; let client: BoundAdapterClient | undefined;
	let began!: () => void; let release!: () => void; let blocked = true;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	let authenticating = new Promise<void>((resolve) => { began = resolve; });
	const state = { rooms: ["!host:example.com", "!coordinator:example.com", "!project:example.com", "!checkout:example.com", "!conversation:example.com"], createCalls: 0 };
	const provision = provisioningFixture("@bot:example.com", state);
	t.after(async () => { signal.abort(); release(); await client?.close("shutdown"); await starting?.catch(() => undefined); await relay?.stop(); globalThis.fetch = originalFetch; await rm(root, { recursive: true, force: true }); });
	globalThis.fetch = async (input, init) => {
		const url = new URL(String(input));
		if (url.pathname.endsWith("/whoami")) {
			began();
			if (blocked) await Promise.race([gate, new Promise<never>((_resolve, reject) => {
				if (init?.signal?.aborted) reject(init.signal.reason);
				else init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
			})]);
			return Response.json({ user_id: "@bot:example.com" });
		}
		const response = await provision(input, init); if (response) return response;
		if (url.pathname.endsWith("/sync")) {
			if (!url.searchParams.has("since")) return Response.json({ next_batch: "ready", rooms: { join: {} } });
			if (!init?.signal?.aborted) await new Promise<void>((resolve) => init?.signal?.addEventListener("abort", () => resolve(), { once: true }));
			throw Object.assign(Error("cancelled"), { name: "AbortError" });
		}
		return Response.json({});
	};
	starting = startManagedSessionRelay(environment, signal.signal); void starting.catch(() => undefined); await authenticating;
	const controlPath = join(root, "runtime", "control.sock");
	const hostStatus = await requestHostControl({ socketPath: controlPath, action: { operation: "host.status" }, requestId: "startup-status" });
	assert.equal(hostStatus.ok, true); if (!hostStatus.ok) assert.fail();
	assert.equal(hostStatus.data.relayState, "disconnected"); assert.equal(hostStatus.data.accountState, "unavailable");
	assert.ok(hostStatus.data.capabilities.includes("saved-session-import-v1"), "production lifecycle advertises its import admission fence");
	const socketPath = join(root, "runtime", "relay.sock"); const attachmentNonce = "abcdefghijklmnopqrstuvwxyzABCDEF";
	const result = await requestLocalBind({ socketPath, role: "ordinary_adapter", creationKey, concept, sessionId, attachmentNonce,
		bindingBoundaryEntryId, sourceCwd: cwd, sourceSessionFile });
	assert.equal(result.matrixBinding, "pending"); assert.equal(state.createCalls, 0);
	const options = { socketPath, role: "ordinary_adapter" as const, attachmentNonce, requestedCapabilities: ["local-enrollment-v1" as const],
		binding: { version: "1.0.0" as const, conversationId: result.conversationId, concept, sessionId, bindingBoundaryEntryId, role: "ordinary_adapter" as const }, onEnvelope: () => undefined };
	client = new BoundAdapterClient(options); await client.connect();
	assert.equal((await client.selfStatus()).payload.conversationState, "active"); assert.equal(client.matrixBindingPending, true);
	const inventory = await requestHostControl({ socketPath: controlPath, action: { operation: "conversation.list" }, requestId: "pending-inventory" });
	assert.equal(inventory.ok, true); if (!inventory.ok) assert.fail();
	assert.equal(inventory.data.items.length, 1); assert.equal(inventory.data.items[0].runtimeState, "running");
	assert.equal(inventory.data.items[0].setupState, "pending");
	// Exercise the real main.ts -> dispatcher -> lifecycle wiring. Direct
	// lifecycle tests alone cannot catch a fence dropped by the composition root.
	const opened: Array<{ id: string; generation?: string }> = [];
	const originalOpen = HostLifecycle.prototype.openConversation;
	const openSpy = t.mock.method(HostLifecycle.prototype, "openConversation", function (this: HostLifecycle, id: string, generation?: string) {
		opened.push({ id, generation });
		return originalOpen.call(this, id, generation);
	});
	const staleGeneration = deriveGenerationId(result.conversationId, 2);
	const staleOpen = await requestHostControl({ socketPath: controlPath, requestId: "stale-production-open", timeoutMs: 1000,
		action: { operation: "conversation.open", conversationId: result.conversationId, expectedGenerationId: staleGeneration } });
	assert.equal(staleOpen.ok, false);
	assert.deepEqual(opened, [{ id: result.conversationId, generation: staleGeneration }], "production composition preserves the generation fence");
	openSpy.mock.restore();
	for (const secret of [attachmentNonce, sessionId, cwd, sourceSessionFile, "test-token"]) assert.ok(!JSON.stringify(inventory).includes(secret));
	const cli = process.env.PI_MANAGED_SESSIONS_TEST_HOST_CLI;
	if (cli) {
		const { stdout, stderr } = await promisify(execFile)(cli, ["conversation", "list", "--json"], {
			env: { ...process.env, PI_MANAGED_SESSIONS_RUNTIME_DIR: environment.PI_MANAGED_SESSIONS_RUNTIME_DIR }, timeout: 5_000,
		});
		assert.equal(stderr, ""); assert.deepEqual(JSON.parse(stdout).data, inventory.data);
	}
	await assert.rejects(() => client!.promoteTerminalSession(), { code: "matrix_unavailable" });
	signal.abort(); await assert.rejects(starting); await client.close("shutdown");
	await assert.rejects(stat(controlPath), { code: "ENOENT" });
	signal = new AbortController(); authenticating = new Promise<void>((resolve) => { began = resolve; });
	starting = startManagedSessionRelay(environment, signal.signal); void starting.catch(() => undefined); await authenticating;
	client = new BoundAdapterClient(options); await client.connect();
	assert.equal(client.matrixBindingPending, true); assert.equal((await client.selfStatus()).payload.conversationState, "active");
	assert.equal(state.createCalls, 0, "restart restores local authority without Matrix access");
	const restored = await requestHostControl({ socketPath: controlPath, action: { operation: "conversation.status", conversationId: result.conversationId }, requestId: "restored-status" });
	assert.equal(restored.ok, true); if (!restored.ok) assert.fail();
	assert.equal(restored.data.runtimeState, "running"); assert.equal(restored.data.setupState, "pending");
	blocked = false; release(); relay = await starting;
	for (let attempt = 0; attempt < 300 && !client.matrixBound; attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(client.matrixBound, true); assert.equal((await client.selfStatus()).payload.conversationState, "active");
	await assert.rejects(client.selfDelete(), { code: "invalid_state" });
	assert.equal((await client.selfStatus()).payload.conversationState, "active", "legacy unbind consent cannot silently become retirement consent");
	const coordinator = relay.registry.listManifests().find((item) => item.kind === "coordinator")!;
	const coordinatorNonce = "c".repeat(32); await relay.registry.setAttachmentNonce(coordinator.conversationId, coordinatorNonce);
	const coordinatorClient = new CoordinatorAdapterClient({ socketPath, role: "coordinator_adapter", attachmentNonce: coordinatorNonce,
		binding: { version: "1.0.0", conversationId: coordinator.conversationId, concept: coordinator.concept, sessionId: coordinator.piSessionId,
			bindingBoundaryEntryId: coordinator.bindingBoundaryEntryId, role: "coordinator_adapter" }, onEnvelope: () => undefined });
	t.after(() => coordinatorClient.close("shutdown")); await coordinatorClient.connect();
	await assert.rejects(coordinatorClient.lifecycleRequest({ operation: "conversation.delete", targetConversationId: result.conversationId, confirmed: true }), { code: "invalid_state" });
	assert.equal((await coordinatorClient.lifecycleRequest({ operation: "conversation.list" })).type, "lifecycle.result");
	assert.ok(relay.registry.registeredConversation(result.conversationId));
	assert.equal(state.createCalls, 5); assert.equal(await readFile(sourceSessionFile, "utf8"), sourceBytes);
	assert.deepEqual(new Set((await readFile(operations, "utf8")).trim().split("\n").map((line) => JSON.parse(line))), new Set(["workspace-identify", "workspace-resolve"]));
});
