import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { MANAGED_SESSION_STATE_VERSION, deriveGenerationId, type ConversationManifest, type WorkspaceIdentity } from "../config/agent/extensions/managed-sessions/contracts.js";
import { ConversationManifestStore } from "../config/agent/extensions/managed-sessions/relay/manifest-store.js";
import { ManagedMatrixClient } from "../config/agent/extensions/managed-sessions/relay/matrix-client.js";
import { ProjectReconciler } from "../config/agent/extensions/managed-sessions/relay/project-reconciliation.js";
import { RelayRegistry } from "../config/agent/extensions/managed-sessions/relay/registry.js";

const hostId = "reconciliation-host";
const config = { homeserver: "https://matrix.example.com", accessToken: "token", botUserId: "@bot:example.com", operatorUserId: "@operator:example.com" };
const entry = (digit: string) => `entry_${digit.repeat(32)}`;
const conversation = (digit: string) => `conv_${digit.repeat(32)}`;

function project(digit: string, workspace: string, roomId: string, projectSpace: string): ConversationManifest {
	const conversationId = conversation(digit); const createdAt = "2026-09-04T00:00:00.000Z"; const generationId = deriveGenerationId(conversationId, 1);
	return { schemaVersion: MANAGED_SESSION_STATE_VERSION, kind: "project", conversationId, ownerHostId: hostId, creationKey: `creation-${digit}`,
		concept: `work ${digit}`, piSessionId: `session-${digit}`, roomId, placement: { rootKey: "projects", workspace, relativeCwd: "" },
		projectSpace, bindingBoundaryEntryId: entry(digit), createdAt, activeGenerationId: generationId,
		generations: [{ generationId, ordinal: 1, piSessionId: `session-${digit}`, bindingBoundaryEntryId: entry(digit), createdAt }] };
}

async function fixture(fetcher: typeof fetch) {
	const root = await mkdtemp(join(tmpdir(), "managed-reconciliation-")); const manifestRoot = join(root, "manifests"); await mkdir(manifestRoot);
	const store = new ConversationManifestStore(manifestRoot);
	const coordinator: ConversationManifest = { schemaVersion: MANAGED_SESSION_STATE_VERSION, kind: "coordinator", conversationId: conversation("0"), ownerHostId: hostId,
		creationKey: "coordinator", concept: "host coordinator", piSessionId: "coordinator-session", roomId: "!coordinator:example.com", hostSpace: "!host:example.com",
		bindingBoundaryEntryId: entry("0"), createdAt: "2026-09-04T00:00:00.000Z" };
	const manifests = [coordinator, project("1", "main", "!root:example.com", "!old:example.com"), project("2", "linked", "!linked:example.com", "!old:example.com")];
	for (const manifest of manifests) await store.write(manifest);
	const registry = new RelayRegistry(hostId, join(root, "runtime"), store); await registry.load();
	const matrix = new ManagedMatrixClient(config, fetcher, ["!coordinator:example.com", "!host:example.com", "!root:example.com", "!linked:example.com", "!old:example.com"], { maxAttempts: 1 });
	const resolveWorkspace = async (placement: WorkspaceIdentity) => ({ ...placement, workspacePath: join(root, placement.workspace), cwd: join(root, placement.workspace),
		projectKey: `project_${"a".repeat(32)}`, projectDisplayName: "main", checkoutDisplayName: placement.workspace });
	const reconciler = new ProjectReconciler({ registry, matrix, intentDirectory: join(root, "sessions"), resolveWorkspace });
	return { root, store, registry, reconciler, manifests };
}

function authority(path: string): Response | undefined {
	if (path.includes("/state/m.room.member/")) return Response.json({ membership: "join" });
	if (path.includes("/state/m.room.power_levels/")) return Response.json({ users: { [config.botUserId]: 100 }, state_default: 50 });
	if (path.includes("/state/m.room.create/")) return Response.json({ creator: config.botUserId, ...(decodeURIComponent(path).includes("!root:") || decodeURIComponent(path).includes("!linked:") ? {} : { type: "m.space" }) });
	return undefined;
}

test("explicit reconciliation preserves rooms, sessions, runtime, and workspaces while recovering every Matrix phase", async (t) => {
	let createdSpaces = 0; let mutation = 0; let failAt = 1; let left = false; let operatorRemoved = false; let uncertainLeave = true; const calls: string[] = [];
	const fetcher: typeof fetch = async (input, init) => {
		const path = new URL(String(input)).pathname; calls.push(`${init?.method ?? "GET"} ${decodeURIComponent(path)}`);
		if (left && path.includes(encodeURIComponent("!old:example.com")) && path.includes("/state/m.room.member/") && decodeURIComponent(path).includes(config.botUserId)) return new Response("left", { status: 403 });
		if (operatorRemoved && path.includes(encodeURIComponent("!old:example.com")) && path.includes("/state/m.room.member/") && decodeURIComponent(path).includes(config.operatorUserId)) return new Response("removed", { status: 403 });
		const owned = authority(path); if (owned) return owned;
		if (path.includes("/directory/room/")) return createdSpaces > 0 ? Response.json({ room_id: "!stable:example.com" }) : new Response("missing", { status: 404 });
		if (path.endsWith("/createRoom")) { createdSpaces += 1; return Response.json({ room_id: "!stable:example.com" }); }
		if (path.includes("/state/m.space.child/")) { mutation += 1; if (mutation === failAt) return new Response("injected", { status: 503 }); return Response.json({ event_id: `$state-${mutation}` }); }
		if (path.endsWith("/state")) return Response.json([]);
		if (path.endsWith("/kick")) { operatorRemoved = true; return Response.json({}); }
		if (path.endsWith("/leave")) { left = true; if (uncertainLeave) { uncertainLeave = false; throw new TypeError("response lost"); } return Response.json({}); }
		throw new Error(`unexpected Matrix request ${init?.method} ${path}`);
	};
	const value = await fixture(fetcher); t.after(() => rm(value.root, { recursive: true, force: true }));
	for (const workspace of ["main", "linked"]) { await mkdir(join(value.root, workspace)); await writeFile(join(value.root, workspace, "keep"), workspace); }
	const runtimeBefore = value.registry.snapshot(); const preview = await value.reconciler.preview();
	assert.equal(preview.pending, 2); assert.equal(preview.completed, 0); assert.equal(createdSpaces, 0, "preview performs no Matrix mutation or room creation");
	for (const boundary of [1, 2, 3]) {
		failAt = boundary; mutation = 0;
		await assert.rejects(() => value.reconciler.apply(preview.reconciliationKey), /Matrix PUT/);
	}
	failAt = -1; mutation = 0;
	const applied = await value.reconciler.apply(preview.reconciliationKey);
	assert.deepEqual(applied, { operation: "project.reconcile.apply", reconciliationKey: preview.reconciliationKey, reconciled: 2, obsoleteSpaces: 1 });
	assert.equal(createdSpaces, 1, "retries create one project Space and never create replacement conversation rooms");
	for (const digit of ["1", "2"]) {
		const manifest = value.registry.manifestByConversationId(conversation(digit))!;
		assert.equal(manifest.roomId, digit === "1" ? "!root:example.com" : "!linked:example.com"); assert.equal(manifest.projectSpace, "!stable:example.com");
		assert.equal(manifest.projectKey, `project_${"a".repeat(32)}`); assert.equal(manifest.piSessionId, `session-${digit}`); assert.equal(manifest.bindingBoundaryEntryId, entry(digit));
	}
	assert.deepEqual(value.registry.snapshot(), runtimeBefore, "manifest reconciliation leaves dormant/active state and every durable runtime queue unchanged");
	assert.equal(await readFile(join(value.root, "main", "keep"), "utf8"), "main"); assert.equal(await readFile(join(value.root, "linked", "keep"), "utf8"), "linked");
	const intentPath = join(value.root, "sessions", "project-reconciliation.json"); const interrupted = JSON.parse(await readFile(intentPath, "utf8"));
	interrupted.items[0].manifestUpdated = false; interrupted.items[0].oldUnlinked = false; await writeFile(intentPath, `${JSON.stringify(interrupted)}\n`, { mode: 0o600 });
	await value.reconciler.apply(preview.reconciliationKey);
	await assert.rejects(() => value.reconciler.cleanup("reconcile_ffffffffffffffffffffffffffffffff"), /key|required/);
	await assert.rejects(() => value.reconciler.cleanup(preview.reconciliationKey), /Matrix POST .*leave.*failed/, "an uncertain leave stops after its durable pre-leave phase");
	const cleaned = await value.reconciler.cleanup(preview.reconciliationKey);
	assert.equal((cleaned as Record<string, unknown>).remaining, 0); assert.equal(left, true);
	assert.ok(calls.some((call) => call.includes("PUT /_matrix/client/v3/rooms/!stable:example.com/state/m.space.child/!root:example.com")));
});

test("a removed worktree fails preview without deleting its durable conversation or room", async (t) => {
	let matrixMutations = 0; const value = await fixture(async () => { throw new Error("unused Matrix client"); });
	t.after(() => rm(value.root, { recursive: true, force: true }));
	const reconciler = new ProjectReconciler({ registry: value.registry,
		matrix: new ManagedMatrixClient(config, async (input, init) => { if ((init?.method ?? "GET") !== "GET") matrixMutations += 1;
			const response = authority(new URL(String(input)).pathname); return response ?? Response.json({}); }, ["!coordinator:example.com", "!host:example.com", "!root:example.com", "!linked:example.com", "!old:example.com"]),
		intentDirectory: join(value.root, "missing-worktree-intent"), resolveWorkspace: async (placement) => {
			if (placement.workspace === "main") throw new Error("checkout no longer exists");
			throw new Error("worktree no longer exists");
		} });
	await assert.rejects(() => reconciler.preview(), /no longer exists/);
	assert.equal(matrixMutations, 0); assert.equal(value.registry.listManifests().length, 3);
	assert.equal(value.registry.manifestByConversationId(conversation("2"))?.roomId, "!linked:example.com");
});

test("preview refuses a host Space without child-state authority before any mutation", async (t) => {
	let mutations = 0; const value = await fixture(async (input, init) => {
		const path = new URL(String(input)).pathname; const decoded = decodeURIComponent(path);
		if (path.includes("/state/m.room.member/")) return Response.json({ membership: "join" });
		if (path.includes("/state/m.room.create/")) return Response.json({ creator: config.botUserId, ...(decoded.includes("!root:") || decoded.includes("!linked:") ? {} : { type: "m.space" }) });
		if (path.includes("/state/m.room.power_levels/")) return Response.json({ users: { [config.botUserId]: 50 }, state_default: 50,
			events: decoded.includes("!host:") ? { "m.space.child": 100 } : {} });
		if (path.includes("/state/m.space.child/")) { mutations += 1; return Response.json({}); }
		throw new Error(`unexpected ${init?.method} ${path}`);
	});
	t.after(() => rm(value.root, { recursive: true, force: true }));
	await assert.rejects(() => value.reconciler.preview(), /authority/); assert.equal(mutations, 0);
});

test("cleanup refuses a non-empty managed Space and operation-specific foreign authority", async (t) => {
	let nonEmpty = true; let foreign = false; let kickDenied = false; let hostChildDenied = false; let mutations = 0;
	const fetcher: typeof fetch = async (input) => {
		const path = new URL(String(input)).pathname;
		if (path.includes("/state/m.room.member/")) return Response.json({ membership: "join" });
		if (path.includes("/state/m.room.power_levels/")) { const decoded = decodeURIComponent(path); return Response.json({
			users: { [config.botUserId]: foreign && decoded.includes("!old:") ? 0 : 100 }, state_default: 50,
			events: hostChildDenied && decoded.includes("!host:") ? { "m.space.child": 101 } : {}, kick: kickDenied && decoded.includes("!old:") ? 101 : 50,
		}); }
		if (path.includes("/state/m.room.create/")) return Response.json({ creator: config.botUserId, ...(decodeURIComponent(path).includes("!root:") || decodeURIComponent(path).includes("!linked:") ? {} : { type: "m.space" }) });
		if (path.includes("/directory/room/")) return Response.json({ room_id: "!stable:example.com" });
		if (path.includes("/state/m.space.child/")) { mutations += 1; return Response.json({ event_id: "$ok" }); }
		if (path.endsWith("/state")) return Response.json(nonEmpty ? [{ type: "m.space.child", state_key: "!foreign-child:example.com", content: { via: ["example.com"] } }] : []);
		if (path.endsWith("/leave")) return Response.json({});
		throw new Error(`unexpected ${path}`);
	};
	const value = await fixture(fetcher); t.after(() => rm(value.root, { recursive: true, force: true }));
	const preview = await value.reconciler.preview(); await value.reconciler.apply(preview.reconciliationKey);
	await assert.rejects(() => value.reconciler.cleanup(preview.reconciliationKey), /not empty/);
	nonEmpty = false; const beforeCleanupMutation = mutations; kickDenied = true;
	await assert.rejects(() => value.reconciler.cleanup(preview.reconciliationKey), /authority/); assert.equal(mutations, beforeCleanupMutation, "kick authority fails before host unlink");
	kickDenied = false; hostChildDenied = true;
	await assert.rejects(() => value.reconciler.cleanup(preview.reconciliationKey), /authority/); assert.equal(mutations, beforeCleanupMutation, "host child authority fails before host unlink");
	hostChildDenied = false; foreign = true;
	await assert.rejects(() => value.reconciler.cleanup(preview.reconciliationKey), /authority/);
	assert.ok(value.registry.manifestByConversationId(conversation("1")), "cleanup failure never removes a conversation");
});
