import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HostLifecycle, type ResolvedWorkspace } from "../config/agent/extensions/managed-sessions/relay/host-lifecycle.js";
import { RelayRegistry } from "../config/agent/extensions/managed-sessions/relay/registry.js";
import { ConversationManifestStore } from "../config/agent/extensions/managed-sessions/relay/manifest-store.js";
import { retirementTargets } from "../config/agent/extensions/managed-sessions/relay/retirement-targets.js";
import type { RetirementTarget } from "../config/agent/extensions/managed-sessions/relay/retirement-store.js";
import type { ManagedMatrixClient } from "../config/agent/extensions/managed-sessions/relay/matrix-client.js";
import type { ManagedSessionIpcServer } from "../config/agent/extensions/managed-sessions/relay/ipc-server.js";
import { migrateV1Manifest } from "../config/agent/extensions/managed-sessions/v2-contracts.js";
import { LiveHierarchy, type HierarchyPlacement } from "../config/agent/extensions/managed-sessions/relay/live-hierarchy.js";
import { managedRoomAlias, type ManagedProvenance } from "../config/agent/extensions/managed-sessions/managed-provenance.js";
import { deriveConversationId, deriveTranscriptEntryId, MANAGED_SESSION_PROTOCOL_VERSION, MANAGED_SESSION_STATE_VERSION, type ConversationManifest } from "../config/agent/extensions/managed-sessions/contracts.js";

const hostId = "hierarchy-host";
const coordinator: ConversationManifest = { schemaVersion: MANAGED_SESSION_STATE_VERSION, kind: "coordinator", ownerHostId: hostId,
	conversationId: deriveConversationId(hostId, "coordinator"), creationKey: "coordinator", concept: "Host", piSessionId: "coordinator",
	bindingBoundaryEntryId: deriveTranscriptEntryId("coordinator", "boundary"), roomId: "!coordinator:test", hostSpace: "!host:test", createdAt: "2026-10-01T00:00:00.000Z" };
const placement: HierarchyPlacement = { creationKey: "first", projectKey: `project_${"a".repeat(32)}`, canonicalCheckoutRoot: "/projects/repository",
	projectTitle: "Project", checkoutTitle: "Main", conversationTitle: "Conversation" };
class MatrixFixture {
	readonly aliases = new Map<string, string>();
	readonly rooms = new Map<string, ManagedProvenance>();
	readonly links = new Set<string>();
	calls = 0;
	private failed = false;
	constructor(private readonly failure?: { point: string; timing: "before" | "after" }) {}
	private effect<T>(point: string, action: () => T): T {
		this.calls++;
		const fail = !this.failed && this.failure?.point === point;
		if (fail && this.failure!.timing === "before") { this.failed = true; throw Error("injected before effect"); }
		const value = action();
		if (fail && this.failure!.timing === "after") { this.failed = true; throw Error("injected after effect"); }
		return value;
	}
	async ensureLegacyHostProvenance(host: string, saved: ConversationManifest): Promise<string> {
		assert.equal(host, hostId); assert.equal(saved.hostSpace, "!host:test");
		return this.effect("host", () => {
			this.rooms.set("!host:test", { version: 1, hostId, creationKey: "host", kind: "host_space" }); return "!host:test";
		});
	}
	async ensureManagedRoom(_title: string, proof: ManagedProvenance): Promise<string> {
		const alias = managedRoomAlias(proof);
		return this.effect(`create:${proof.kind}`, () => {
			const existing = this.aliases.get(alias); if (existing) { assert.deepEqual(this.rooms.get(existing), proof); return existing; }
			const id = `!room-${this.rooms.size}:test`; this.aliases.set(alias, id); this.rooms.set(id, structuredClone(proof)); return id;
		});
	}
	async recoverManagedAlias(proof: ManagedProvenance): Promise<string | undefined> {
		const roomId = this.aliases.get(managedRoomAlias(proof));
		if (roomId) await this.recoverManagedRoom(roomId, proof);
		return roomId;
	}
	async recoverManagedRoom(roomId: string, proof: ManagedProvenance): Promise<void> { assert.deepEqual(this.rooms.get(roomId), proof); }
	async addSpaceChild(parent: string, room: string): Promise<void> {
		assert.ok(this.rooms.has(parent)); const kind = this.rooms.get(room)!.kind;
		this.effect(`link:${kind}`, () => this.links.add(`${parent}/${room}`));
	}
}

test("retired Space fences survive restart and only explicit new reservations create fresh ancestor identities", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "hierarchy-retired-spaces-")); const matrix = new MatrixFixture(); const retired = new Set<string>();
	const make = () => new LiveHierarchy(root, hostId, matrix, () => coordinator, (id) => retired.has(id));
	let hierarchy = make(); await hierarchy.load(); t.after(async () => { await hierarchy.close(); await rm(root, { recursive: true, force: true }); });
	const first = await hierarchy.prepare(placement); const binding = await hierarchy.provision(first.conversationId);
	const target = (roomId: string, childRoomId: string, spaceKind: "checkout_space" | "project_space"): Extract<RetirementTarget, { kind: "ancestor" }> => {
		const proof = matrix.rooms.get(roomId)!;
		return { kind: "ancestor", roomId, childRoomId, spaceKind, creationKey: proof.creationKey, provenance: proof,
			operatorUserId: "@operator:test", botUserId: "@bot:test" };
	};
	const checkout = target(binding.checkoutSpace, binding.roomId, "checkout_space");
	const project = target(binding.projectSpace, binding.checkoutSpace, "project_space");
	await assert.rejects(hierarchy.fenceSpace(checkout), /still referenced/);
	retired.add(first.conversationId);
	await hierarchy.withProjectCleanup(placement.projectKey, async () => { await hierarchy.fenceSpace(checkout); await hierarchy.fenceSpace(project); });
	// Pending old account cleanup must not block a fresh local identity/reservation.
	await assert.rejects(hierarchy.provision(first.conversationId), /permanently retired/);
	assert.equal(hierarchy.status(first.conversationId), undefined); assert.deepEqual(hierarchy.listConversations(), []);
	await hierarchy.close(); const calls = matrix.calls; hierarchy = make(); await hierarchy.load(); assert.equal(matrix.calls, calls);
	assert.equal(hierarchy.spaceRetirement(checkout), "pending");
	assert.throws(() => hierarchy.spaceRetirement({ ...checkout, botUserId: "@other:test" }), /identity changed/);
	// Old room aliases still exist and their cleanup is pending; neither permits re-adoption.
	const second = await hierarchy.prepare({ ...placement, creationKey: "second" }); const fresh = await hierarchy.provision(second.conversationId);
	assert.equal(hierarchy.spaceRetirement(checkout), "pending");
	await hierarchy.completeSpace(checkout); await hierarchy.completeSpace(project);
	assert.notEqual(fresh.projectSpace, binding.projectSpace); assert.notEqual(fresh.checkoutSpace, binding.checkoutSpace); assert.notEqual(fresh.roomId, binding.roomId);
	assert.equal(fresh.hostSpace, binding.hostSpace); assert.equal(fresh.checkoutId, binding.checkoutId);
	const planned = retirementTargets({ hostId, operatorUserId: "@operator:test", botUserId: "@bot:test", hostSpace: fresh.hostSpace,
		manifest: { ...coordinator, ...fresh, kind: "project", creationKey: "second", projectKey: placement.projectKey },
		stop: { kind: "stop", generationId: `gen_${"a".repeat(32)}` }, ancestorProvenance: (id) => hierarchy.ancestorProvenance(id) });
	for (const effect of planned) if (effect.kind === "ancestor") {
		assert.deepEqual(effect.provenance, matrix.rooms.get(effect.roomId)); assert.match(effect.creationKey, /\.r\./);
	}
	assert.equal(hierarchy.spaceRetirement(checkout), "done"); await assert.rejects(hierarchy.prepare(placement), /permanently retired/);
	await hierarchy.close(); hierarchy = make(); await hierarchy.load();
	assert.deepEqual(await hierarchy.provision(second.conversationId), fresh);
	assert.deepEqual(await hierarchy.prepare({ ...placement, creationKey: "second" }), second);
});

test("uncertain Space fence and completion writes poison admission and recover only durable authority", async (t) => {
	for (const boundary of ["fence", "complete"] as const) for (const timing of ["before", "after"] as const) {
		const root = await mkdtemp(join(tmpdir(), "hierarchy-space-write-")); t.after(() => rm(root, { recursive: true, force: true }));
		const matrix = new MatrixFixture(); let retired = false;
		const make = () => new LiveHierarchy(root, hostId, matrix, () => coordinator, () => retired);
		const hierarchy = make(); await hierarchy.load(); const conversation = await hierarchy.prepare(placement); const binding = await hierarchy.provision(conversation.conversationId);
		retired = true; const proof = matrix.rooms.get(binding.checkoutSpace)!;
		const target: Extract<RetirementTarget, { kind: "ancestor" }> = { kind: "ancestor", roomId: binding.checkoutSpace, childRoomId: binding.roomId,
			spaceKind: "checkout_space", creationKey: proof.creationKey, provenance: proof, operatorUserId: "@operator:test", botUserId: "@bot:test" };
		if (boundary === "complete") await hierarchy.fenceSpace(target);
		const file = (hierarchy as unknown as { file: { write: (state: unknown) => Promise<void> } }).file; const save = file.write.bind(file);
		file.write = async (state) => { if (timing === "after") await save(state); throw Error("interrupted Space write"); };
		await assert.rejects(boundary === "fence" ? hierarchy.fenceSpace(target) : hierarchy.completeSpace(target), /interrupted/);
		await assert.rejects(hierarchy.prepare({ ...placement, creationKey: "new" }), /authority is unavailable/);
		assert.throws(() => hierarchy.spaceRetirement(target), /authority is unavailable/); await hierarchy.close();
		const calls = matrix.calls; const recovered = make(); await recovered.load();
		assert.equal(recovered.spaceRetirement(target), boundary === "complete" ? timing === "after" ? "done" : "pending" : timing === "after" ? "pending" : undefined);
		assert.equal(matrix.calls, calls); await recovered.close();
	}
});

test("ancestor cleanup excludes same-project provisioning and reservations without blocking other projects", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "hierarchy-cleanup-gate-")); const matrix = new MatrixFixture();
	const hierarchy = new LiveHierarchy(root, hostId, matrix, () => coordinator); await hierarchy.load();
	let releaseProvision!: () => void; const provisionGate = new Promise<void>((resolve) => { releaseProvision = resolve; });
	let provisionEntered!: () => void; const provisioning = new Promise<void>((resolve) => { provisionEntered = resolve; });
	let releaseCleanup!: () => void; const cleanupGate = new Promise<void>((resolve) => { releaseCleanup = resolve; });
	t.after(async () => { releaseProvision(); releaseCleanup(); await hierarchy.close(); await rm(root, { recursive: true, force: true }); });
	const create = matrix.ensureManagedRoom.bind(matrix);
	matrix.ensureManagedRoom = async (title, proof) => { if (proof.kind === "conversation" && proof.creationKey === "first") { provisionEntered(); await provisionGate; } return create(title, proof); };
	const first = await hierarchy.prepare(placement); const active = hierarchy.provision(first.conversationId); await provisioning;
	let cleanupEntered = false; const cleanup = hierarchy.withProjectCleanup(placement.projectKey, async () => { cleanupEntered = true; await cleanupGate; });
	let reserved = false; const reservation = hierarchy.prepare({ ...placement, creationKey: "queued" }).then(() => { reserved = true; });
	const other = await hierarchy.prepare({ ...placement, projectKey: `project_${"b".repeat(32)}`, creationKey: "other", canonicalCheckoutRoot: "/projects/other" });
	await hierarchy.provision(other.conversationId); assert.equal(cleanupEntered, false); assert.equal(reserved, false);
	releaseProvision(); const bound = await active;
	for (let i = 0; i < 100 && !cleanupEntered; i++) await new Promise((resolve) => setImmediate(resolve));
	assert.equal(cleanupEntered, true); assert.equal(reserved, false);
	assert.equal(hierarchy.hasReferences(bound.checkoutSpace, (id) => id === first.conversationId), false);
	releaseCleanup(); await cleanup; await reservation; assert.equal(reserved, true);
	assert.equal(hierarchy.hasReferences(bound.checkoutSpace, (id) => id === first.conversationId), true, "unpublished reservation blocks cleanup");
	assert.equal(hierarchy.hasReferences(bound.projectSpace, (id) => id === first.conversationId), true);
	assert.equal(hierarchy.hasReferences("!unrelated:test", () => false), false);
});

test("hierarchy shutdown aborts cleanup and drains queued reservations without starting their effects", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "hierarchy-cleanup-close-")); const matrix = new MatrixFixture();
	const hierarchy = new LiveHierarchy(root, hostId, matrix, () => coordinator); await hierarchy.load(); t.after(() => rm(root, { recursive: true, force: true }));
	let entered!: () => void; const started = new Promise<void>((resolve) => { entered = resolve; });
	const cleanup = hierarchy.withProjectCleanup(placement.projectKey, async (signal) => { entered(); await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true })); });
	await started; const queued = assert.rejects(hierarchy.prepare(placement), /abort/i);
	await hierarchy.close(); await cleanup; await queued; assert.equal(matrix.calls, 0); assert.deepEqual(hierarchy.listConversations(), []);
});

test("HostLifecycle uses canonical checkout roots, persists checkout bindings and permits duplicate display names", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "live-hierarchy-lifecycle-")); t.after(() => rm(root, { recursive: true, force: true }));
	const store = new ConversationManifestStore(join(root, "manifests")); await store.write(coordinator);
	const registry = new RelayRegistry(hostId, root, store); await registry.load();
	const matrix = new MatrixFixture(); const hierarchy = new LiveHierarchy(join(root, "hierarchy"), hostId, matrix, () => coordinator); await hierarchy.load();
	const lifecycle = new HostLifecycle({ hostId, launcher: "/never-invoked", projectSessionDirectory: join(root, "sessions"), socketPath: "/unused",
		registry, matrix: matrix as unknown as ManagedMatrixClient, hierarchy, server: {} as ManagedSessionIpcServer });
	const resolved: ResolvedWorkspace = { rootKey: "projects", workspace: "repository", relativeCwd: "src", cwd: "/projects/repository/src",
		workspacePath: placement.canonicalCheckoutRoot, projectKey: placement.projectKey, projectDisplayName: "Project", checkoutDisplayName: "Main" };
	const firstId = deriveConversationId(hostId, "one");
	const first = lifecycle.provisionConversationMatrix(firstId, "Same title", resolved, "one");
	await assert.rejects(() => lifecycle.provisionConversationMatrix(firstId, "Same title", { ...resolved, relativeCwd: "other" }, "one"), /Concurrent provisioning/);
	const [a, b] = await Promise.all([first, lifecycle.provisionConversationMatrix(deriveConversationId(hostId, "two"), "Same title", { ...resolved, relativeCwd: "", cwd: resolved.workspacePath }, "two")]);
	assert.equal(a.checkoutId, b.checkoutId); assert.equal(a.checkoutSpace, b.checkoutSpace); assert.notEqual(a.roomId, b.roomId);
	for (const [key, grouped] of [["one", a], ["two", b]] as const) {
		const session = `session-${key}`;
		const manifest: ConversationManifest = { schemaVersion: MANAGED_SESSION_STATE_VERSION, kind: "project", ownerHostId: hostId,
			conversationId: deriveConversationId(hostId, key), creationKey: key, concept: "Same title", piSessionId: session,
			bindingBoundaryEntryId: deriveTranscriptEntryId(session, "boundary"), createdAt: "2026-10-01T00:00:00.000Z",
			placement: { rootKey: resolved.rootKey, workspace: resolved.workspace, relativeCwd: "" }, projectKey: resolved.projectKey,
			projectDisplayName: "Project", checkoutDisplayName: "Main", ...grouped };
		await registry.createProjectConversation(manifest, "a".repeat(32));
		const migrated = migrateV1Manifest(manifest); assert.equal(migrated.checkoutId, grouped.checkoutId); assert.equal(migrated.checkoutSpace, grouped.checkoutSpace);
		await assert.rejects(() => registry.createProjectConversation({ ...manifest, checkoutSpace: "!foreign:test" }, "a".repeat(32)), /identity already exists/);
	}
	assert.equal(registry.listManifests().filter((item) => item.concept === "Same title").length, 2);
	assert.ok(registry.managedRoomIds().includes(a.checkoutSpace!));
	const loaded = new RelayRegistry(hostId, root, store); await loaded.load(); assert.equal(loaded.manifestByConversationId(firstId)?.checkoutSpace, a.checkoutSpace);
});

test("new project-creation retries retain the hierarchy route and frozen display values", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "live-project-create-")); t.after(() => rm(root, { recursive: true, force: true }));
	const store = new ConversationManifestStore(join(root, "manifests")); await store.write(coordinator);
	const registry = new RelayRegistry(hostId, root, store); await registry.load();
	const matrix = new MatrixFixture({ point: "link:worktree_space", timing: "after" });
	const hierarchy = new LiveHierarchy(join(root, "hierarchy"), hostId, matrix, () => coordinator); await hierarchy.load();
	const sessions = join(root, "sessions");
	const lifecycle = new HostLifecycle({ hostId, launcher: "/never-invoked", projectSessionDirectory: sessions, socketPath: "/unused",
		registry, matrix: matrix as unknown as ManagedMatrixClient, hierarchy, server: {} as ManagedSessionIpcServer });
	let attempts = 0; let launches = 0;
	const resolved: ResolvedWorkspace = { rootKey: "projects", workspace: "new-project", relativeCwd: "", workspacePath: join(root, "project"),
		cwd: join(root, "project"), projectKey: placement.projectKey, projectDisplayName: "Project", checkoutDisplayName: "Main" };
	await mkdir(resolved.cwd);
	(lifecycle as unknown as { invoke: (operation: string, args: Record<string, unknown>) => Promise<Record<string, unknown>> }).invoke = async (operation, args) => {
		if (operation === "project-create") { assert.equal(args.resumeExisting, attempts > 0); attempts++; }
		else assert.ok(["workspace-resolve", "root-ensure"].includes(operation), operation);
		return { ...resolved, checkoutDisplayName: attempts > 1 ? "Renamed display" : "Main" };
	};
	(lifecycle as unknown as { launchProject: () => Promise<void> }).launchProject = async () => { launches++; };
	const request = { protocolVersion: MANAGED_SESSION_PROTOCOL_VERSION, role: "coordinator_adapter" as const, type: "lifecycle.request" as const,
		conversationId: coordinator.conversationId, messageId: "create-project", payload: { request: { operation: "project.create", creationKey: "new-project",
			rootKey: resolved.rootKey, workspace: resolved.workspace, concept: "Project conversation" } } };
	await assert.rejects(() => lifecycle.request(request), /injected/);
	const id = deriveConversationId(hostId, "new-project");
	assert.equal(JSON.parse(await readFile(join(sessions, id, "project-creation.json"), "utf8")).liveHierarchy, true);
	await lifecycle.request(request);
	const manifest = registry.manifestByConversationId(id)!;
	assert.ok(manifest.checkoutId); assert.ok(manifest.checkoutSpace); assert.equal(manifest.checkoutDisplayName, "Main");
	assert.equal(matrix.rooms.size, 4); assert.equal(launches, 1); assert.equal(attempts, 2);
});

test("local reservation survives outage and root/linked checkouts share project but not checkout Spaces", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "live-hierarchy-")); t.after(() => rm(root, { recursive: true, force: true }));
	const matrix = new MatrixFixture(); let available = false;
	const hierarchy = new LiveHierarchy(root, hostId, matrix, () => available ? coordinator : undefined); await hierarchy.load();
	const first = await hierarchy.prepare(placement);
	assert.equal(matrix.calls, 0); assert.equal(hierarchy.status(first.conversationId), "pending");
	await assert.rejects(() => hierarchy.provision(first.conversationId), /pending/); assert.equal(matrix.calls, 0);
	available = true;
	const second = await hierarchy.prepare({ ...placement, creationKey: "second", conversationTitle: "Same checkout" });
	const linked = await hierarchy.prepare({ ...placement, creationKey: "third", canonicalCheckoutRoot: "/projects/repository-feature" });
	const [a, b, c] = await Promise.all([hierarchy.provision(first.conversationId), hierarchy.provision(second.conversationId), hierarchy.provision(linked.conversationId)]);
	assert.equal(a.projectSpace, b.projectSpace); assert.equal(a.projectSpace, c.projectSpace);
	assert.equal(a.checkoutSpace, b.checkoutSpace); assert.notEqual(a.checkoutSpace, c.checkoutSpace);
	assert.notEqual(a.roomId, b.roomId); assert.equal(hierarchy.status(a.conversationId), "hierarchy_ready");
	assert.equal(matrix.rooms.size, 7); assert.equal(matrix.links.size, 6);
	const calls = matrix.calls;
	await hierarchy.prepare({ ...placement, projectTitle: "Renamed", conversationTitle: "Changed" }); await hierarchy.provision(a.conversationId);
	assert.equal(matrix.calls, calls, "a completed reservation does not mutate existing hierarchy on retry");
	await assert.rejects(() => hierarchy.prepare({ ...placement, canonicalCheckoutRoot: "/other" }), /immutable identity/);
	const loaded = new LiveHierarchy(root, hostId, matrix, () => coordinator); await loaded.load(); assert.equal(matrix.calls, calls, "loading has no Matrix effects");
});

test("create/link interruptions recover verified effects and hold unprovable creates without duplicates", async (t) => {
	for (const point of ["host", "create:project_space", "link:project_space", "create:worktree_space", "link:worktree_space", "create:conversation", "link:conversation"]) {
		for (const timing of ["before", "after"] as const) {
			const root = await mkdtemp(join(tmpdir(), "live-hierarchy-fault-")); t.after(() => rm(root, { recursive: true, force: true }));
			const matrix = new MatrixFixture({ point, timing });
			const first = new LiveHierarchy(root, hostId, matrix, () => coordinator); await first.load(); const target = await first.prepare(placement);
			await assert.rejects(() => first.provision(target.conversationId), /injected/);
			assert.equal(first.status(target.conversationId), "pending");
			const restarted = new LiveHierarchy(root, hostId, matrix, () => coordinator); await restarted.load();
			if (timing === "before" && point.startsWith("create:")) {
				const count = matrix.rooms.size;
				await assert.rejects(() => restarted.provision(target.conversationId), /Uncertain room creation/);
				assert.equal(matrix.rooms.size, count, "an absent alias cannot authorize repeating an uncertain create");
				continue;
			}
			const result = await restarted.provision(target.conversationId);
			assert.equal(result.conversationId, target.conversationId); assert.equal(matrix.rooms.size, 4, `${point}/${timing}`);
			assert.equal(matrix.links.size, 3); assert.equal(restarted.status(target.conversationId), "hierarchy_ready");
		}
	}
});

test("every local hierarchy write boundary either recovers or holds an unprovable create safely", async (t) => {
	for (let failure = 1; failure <= 14; failure++) for (const timing of ["before", "after"] as const) {
		const root = await mkdtemp(join(tmpdir(), "live-hierarchy-write-")); t.after(() => rm(root, { recursive: true, force: true }));
		const matrix = new MatrixFixture(); const first = new LiveHierarchy(root, hostId, matrix, () => coordinator); await first.load();
		// Fault only this instance's durability seam, not global filesystem behavior.
		const file = (first as unknown as { file: { write: (state: unknown) => Promise<void> } }).file;
		const save = file.write.bind(file); let writes = 0; let injected = false;
		file.write = async (state) => {
			const fail = ++writes === failure;
			if (fail && timing === "before") { injected = true; throw Error("local-write interruption"); }
			await save(state);
			if (fail && timing === "after") { injected = true; throw Error("local-write interruption"); }
		};
		await assert.rejects(async () => { const target = await first.prepare(placement); await first.provision(target.conversationId); }, /local-write/);
		assert.equal(injected, true, `${failure}/${timing}`);
		const recovered = new LiveHierarchy(root, hostId, matrix, () => coordinator); await recovered.load(); const target = await recovered.prepare(placement);
		if (timing === "after" && [4, 8, 12].includes(failure)) {
			const rooms = matrix.rooms.size;
			await assert.rejects(() => recovered.provision(target.conversationId), /Uncertain room creation/);
			assert.equal(matrix.rooms.size, rooms); assert.equal(recovered.status(target.conversationId), "pending");
		} else {
			await recovered.provision(target.conversationId); assert.equal(matrix.rooms.size, 4); assert.equal(matrix.links.size, 3);
		}
	}
});

test("lost create response followed by alias removal stays pending rather than duplicating the accepted room", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "live-hierarchy-uncertain-")); t.after(() => rm(root, { recursive: true, force: true }));
	const matrix = new MatrixFixture({ point: "create:project_space", timing: "after" });
	const first = new LiveHierarchy(root, hostId, matrix, () => coordinator); await first.load(); const target = await first.prepare(placement);
	await assert.rejects(() => first.provision(target.conversationId), /injected/); matrix.aliases.clear();
	const restarted = new LiveHierarchy(root, hostId, matrix, () => coordinator); await restarted.load();
	await assert.rejects(() => restarted.provision(target.conversationId), /explicit reconciliation/);
	assert.equal(matrix.rooms.size, 2, "accepted project Space is not duplicated under a now-free alias");
	assert.equal(restarted.status(target.conversationId), "pending");
});

test("fallback allocation is serialized with concurrent local reservations", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "live-hierarchy-titles-")); t.after(() => rm(root, { recursive: true, force: true }));
	const hierarchy = new LiveHierarchy(root, hostId, new MatrixFixture(), () => coordinator); await hierarchy.load();
	const unnamed = { ...placement, creationKey: "unnamed", conversationTitle: "" };
	const suffix = deriveConversationId(hostId, unnamed.creationKey).slice(-32);
	await Promise.all([
		hierarchy.prepare({ ...placement, creationKey: "named", conversationTitle: `conversation-${suffix.slice(0, 8)}` }),
		hierarchy.prepare(unnamed),
	]);
	assert.equal(hierarchy.listConversations().find((item) => item.conversationId === deriveConversationId(hostId, "unnamed"))?.title, `conversation-${suffix.slice(0, 12)}`);
});

test("hierarchy shutdown cancels remote work before releasing ownership", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "live-hierarchy-stop-")); t.after(() => rm(root, { recursive: true, force: true }));
	let began!: () => void; const blocked = new Promise<void>((resolve) => { began = resolve; });
	const matrix: ConstructorParameters<typeof LiveHierarchy>[2] = {
		ensureLegacyHostProvenance: async (_host, _coordinator, signal) => {
			began(); return new Promise<string>((_resolve, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }));
		},
		ensureManagedRoom: async () => assert.fail("no child creation after shutdown"),
		recoverManagedAlias: async () => assert.fail("no recovery after shutdown"),
		recoverManagedRoom: async () => assert.fail("no recovery after shutdown"),
		addSpaceChild: async () => assert.fail("no links after shutdown"),
	};
	const hierarchy = new LiveHierarchy(root, hostId, matrix, () => coordinator); await hierarchy.load(); const target = await hierarchy.prepare(placement);
	const stopped = assert.rejects(() => hierarchy.provision(target.conversationId), { name: "AbortError" });
	await blocked; await hierarchy.close(); await stopped;
	assert.equal(hierarchy.status(target.conversationId), "pending");
	await assert.rejects(() => hierarchy.prepare(placement), { name: "AbortError" });
});

test("saved Space IDs survive alias removal and cannot be moved to a replacement host root", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "live-hierarchy-saved-")); t.after(() => rm(root, { recursive: true, force: true }));
	const matrix = new MatrixFixture({ point: "link:worktree_space", timing: "before" });
	const first = new LiveHierarchy(root, hostId, matrix, () => coordinator); await first.load(); const target = await first.prepare(placement);
	await assert.rejects(() => first.provision(target.conversationId), /injected/); matrix.aliases.clear();
	const wrongRoot = new LiveHierarchy(root, hostId, matrix, () => ({ ...coordinator, hostSpace: "!replacement:test" })); await wrongRoot.load();
	await assert.rejects(() => wrongRoot.provision(target.conversationId), /explicit migration/);
	const restarted = new LiveHierarchy(root, hostId, matrix, () => coordinator); await restarted.load(); await restarted.provision(target.conversationId);
	assert.equal(matrix.rooms.size, 4, "saved project ID is used even after its alias is removed");
	const otherHost = new LiveHierarchy(root, "other-host", matrix, () => coordinator);
	await assert.rejects(() => otherHost.load(), /another host/);
});
