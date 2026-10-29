import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { HostAccountClient } from "../config/agent/extensions/managed-sessions/relay/host-account-client.js";
import { HostAccountOwner } from "../config/agent/extensions/managed-sessions/relay/host-account-owner.js";
import { AccountStore } from "../config/agent/extensions/bridge-chat/account-store.js";
import { AccountWorker, type AccountMatrixPort } from "../config/agent/extensions/bridge-chat/account-worker.js";
import { retirementId, retirementEffectId, type RetirementRecord } from "../config/agent/extensions/managed-sessions/relay/retirement-store.js";
import type { AccountAction } from "../config/agent/extensions/managed-sessions/live-workspace-contracts.js";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HostLifecycle, type ResolvedWorkspace } from "../config/agent/extensions/managed-sessions/relay/host-lifecycle.js";
import { ProjectReconciler, type SpaceCleanupAccount } from "../config/agent/extensions/managed-sessions/relay/project-reconciliation.js";
import { RelayRegistry } from "../config/agent/extensions/managed-sessions/relay/registry.js";
import { ConversationManifestStore } from "../config/agent/extensions/managed-sessions/relay/manifest-store.js";
import { retirementTargets } from "../config/agent/extensions/managed-sessions/relay/retirement-targets.js";
import type { RetirementTarget } from "../config/agent/extensions/managed-sessions/relay/retirement-store.js";
import type { ManagedMatrixClient } from "../config/agent/extensions/managed-sessions/relay/matrix-client.js";
import type { ManagedSessionIpcServer } from "../config/agent/extensions/managed-sessions/relay/ipc-server.js";
import { migrateV1Manifest } from "../config/agent/extensions/managed-sessions/v2-contracts.js";
import { LiveHierarchy, type HierarchyPlacement } from "../config/agent/extensions/managed-sessions/relay/live-hierarchy.js";
import { managedRoomAlias, type ManagedProvenance } from "../config/agent/extensions/managed-sessions/managed-provenance.js";
import { deriveConversationId, deriveDeliveryId, deriveTranscriptEntryId, MANAGED_SESSION_PROTOCOL_VERSION, MANAGED_SESSION_STATE_VERSION, type ConversationManifest } from "../config/agent/extensions/managed-sessions/contracts.js";

const hostId = "hierarchy-host";
const coordinator: ConversationManifest = { schemaVersion: MANAGED_SESSION_STATE_VERSION, kind: "coordinator", ownerHostId: hostId,
	conversationId: deriveConversationId(hostId, "coordinator"), creationKey: "coordinator", concept: "Host", piSessionId: "coordinator",
	bindingBoundaryEntryId: deriveTranscriptEntryId("coordinator", "boundary"), roomId: "!coordinator:test", hostSpace: "!host:test", createdAt: "2026-10-01T00:00:00.000Z" };
const placement: HierarchyPlacement = { creationKey: "first", projectKey: `project_${"a".repeat(32)}`, canonicalCheckoutRoot: "/projects/repository",
	projectTitle: "Project", checkoutTitle: "Main", conversationTitle: "Conversation" };
class MatrixFixture {
	readonly admins = new Set<string>();
	async assertOperatorSpaceAdmin(roomId: string): Promise<void> { assert.ok(this.admins.has(roomId), "operator admin missing"); }
	readonly aliases = new Map<string, string>();
	readonly rooms = new Map<string, ManagedProvenance>();
	readonly legacy = new Set<string>();
	readonly links = new Set<string>();
	readonly botUserId = "@bot:test"; readonly operatorUserId = "@operator:test";
	readonly left = new Set<string>(); readonly extraMembers = new Map<string, string[]>();
	loseLeaveReply = false;
	async assertRoomAuthority(roomId: string): Promise<void> { assert.ok(this.rooms.has(roomId) || this.legacy.has(roomId)); }
	async resolvePrivateRoomAlias(): Promise<string | undefined> { return undefined; }
	async inspectLegacyRoom(roomId: string): Promise<ManagedProvenance | undefined> { await this.assertRoomAuthority(roomId); return this.rooms.get(roomId); }
	async inspectLegacyProvenance(roomId: string, proof: ManagedProvenance): Promise<boolean> {
		const existing = await this.inspectLegacyRoom(roomId); if (existing) assert.deepEqual(existing, proof); return Boolean(existing);
	}
	async ensureLegacyProvenance(roomId: string, proof: ManagedProvenance): Promise<void> {
		if (await this.inspectLegacyProvenance(roomId, proof)) return;
		this.effect(`stamp:${proof.kind}`, () => this.rooms.set(roomId, structuredClone(proof)));
	}
	async spaceChildren(roomId: string): Promise<string[]> { return [...this.links].filter((link) => link.startsWith(`${roomId}/`)).map((link) => link.slice(roomId.length + 1)); }
	async joinedMemberIds(roomId: string): Promise<Set<string>> { return new Set([this.botUserId, this.operatorUserId, ...this.extraMembers.get(roomId) ?? []]); }
	async accountJoined(roomId: string): Promise<boolean> { return !this.left.has(roomId); }
	async removeSpaceChild(parent: string, room: string): Promise<void> { this.effect("unlink", () => this.links.delete(`${parent}/${room}`)); }
	async leaveRoom(room: string): Promise<void> { this.calls++; this.left.add(room); if (this.loseLeaveReply) { this.loseLeaveReply = false; throw Error("lost leave reply"); } }
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
	async ensureManagedRoom(_title: string, proof: ManagedProvenance, _signal?: AbortSignal, migrationAdmin = false): Promise<string> {
		const alias = managedRoomAlias(proof);
		return this.effect(`create:${proof.kind}`, () => {
			const existing = this.aliases.get(alias); if (existing) { assert.deepEqual(this.rooms.get(existing), proof); return existing; }
			const id = `!room-${this.rooms.size}:test`; this.aliases.set(alias, id); this.rooms.set(id, structuredClone(proof)); if (migrationAdmin) this.admins.add(id); return id;
		});
	}
	async recoverManagedAlias(proof: ManagedProvenance): Promise<string | undefined> {
		const roomId = this.aliases.get(managedRoomAlias(proof));
		if (roomId) await this.recoverManagedRoom(roomId, proof);
		return roomId;
	}
	async recoverManagedRoom(roomId: string, proof: ManagedProvenance): Promise<void> { assert.deepEqual(this.rooms.get(roomId), proof); }
	async addSpaceChild(parent: string, room: string): Promise<void> {
		assert.ok(this.rooms.has(parent) || this.legacy.has(parent)); const kind = this.rooms.get(room)?.kind ?? "conversation";
		this.effect(`link:${kind}`, () => this.links.add(`${parent}/${room}`));
	}
}

test("host hierarchy producer and NAS consumer roundtrip preserves existing rules, reports readiness, and completes exact retirement", async t => {
	const root = await mkdtemp(join(tmpdir(), "account-hierarchy-")); const matrix = new MatrixFixture(); const retired = new Set<string>();
	const hierarchy = new LiveHierarchy(join(root, "hierarchy"), hostId, matrix, () => coordinator, id => retired.has(id)); await hierarchy.load();
	const first = await hierarchy.prepare(placement); const old = await hierarchy.provision(first.conversationId);
	matrix.rooms.set(coordinator.roomId, { version: 1, hostId, kind: "coordinator", creationKey: "coordinator", conversationId: coordinator.conversationId, parentRoomId: coordinator.hostSpace! }); matrix.links.add(`${coordinator.hostSpace}/${coordinator.roomId}`);
	let pending: RetirementRecord[] = []; let active = [coordinator]; let now = 1000; let release = () => {};
	const registry = { hostId, listManifests: () => active, manifestByConversationId: (id: string) => active.find(m => m.conversationId === id), retirement: (id: string) => retired.has(id) ? {} : undefined, pendingRetirements: () => pending } as unknown as RelayRegistry;
	const nas = new AccountStore(join(root, "nas.sqlite"), matrix.operatorUserId); const joined = new Set<string>(); const forgotten: string[] = []; let rules = 0;
	let worker!: AccountWorker;
	const client = new HostAccountClient(join(root, "host"), hostId, matrix.operatorUserId, "NAS", { sendAccountRequest: async (recipient, device, _txn, action: AccountAction) => {
		assert.equal(recipient, matrix.operatorUserId); assert.equal(device, "NAS");
		worker.ingest({ to_device: { events: [{ type: "lol.bepis.pi.account.request.v1", sender: matrix.botUserId, content: action }] }, rooms: { invite: Object.fromEntries([...matrix.rooms.keys()].filter(id => !joined.has(id)).map(id => [id, { invite_state: { events: [{ type: "m.room.member", state_key: matrix.operatorUserId, sender: matrix.botUserId, content: { membership: "invite" } }] } }])) } });
	} }, () => now);
	const port: AccountMatrixPort = {
		joined: async id => joined.has(id), join: async id => { joined.add(id); }, leave: async id => { joined.delete(id); }, forget: async id => { forgotten.push(id); }, cleanupEligible: async () => true,
		state: async id => {
			const proof = matrix.rooms.get(id); assert.ok(proof);
			return [{ type: "m.room.create", sender: matrix.botUserId, state_key: "", content: { "m.federate": false, ...(proof.kind.endsWith("_space") ? { type: "m.space" } : {}) } },
				{ type: "m.room.join_rules", sender: matrix.botUserId, state_key: "", content: { join_rule: "invite" } },
				{ type: "lol.bepis.pi.managed.v1", sender: matrix.botUserId, state_key: "", content: proof },
				...[...matrix.links].filter(link => link.startsWith(`${id}/`)).map(link => ({ type: "m.space.child", sender: matrix.botUserId, state_key: link.slice(id.length + 1), content: { via: ["test"] } }))];
		},
		toDevice: async (type, recipient, device, _txn, content) => { assert.equal(recipient, matrix.botUserId); assert.equal(device, "HOST"); await client.ingest({ to_device: { events: [{ type, sender: matrix.operatorUserId, content }] } }); },
	};
	worker = new AccountWorker(nas, [{ hostId, botUserId: matrix.botUserId, deviceId: "HOST" }], matrix.operatorUserId, port, { read: async () => undefined, put: async () => { rules++; } });
	const account = new HostAccountOwner(client, registry, matrix as unknown as ManagedMatrixClient, hierarchy); await account.initialize();
	t.after(async () => { release(); await account.close(); nas.close(); await hierarchy.close(); await rm(root, { recursive: true, force: true }); });
	const second = await hierarchy.prepare({ ...placement, creationKey: "new-account-room" }); const fresh = await hierarchy.provision(second.conversationId);
	active = [coordinator, { ...coordinator, kind: "project", conversationId: second.conversationId, roomId: fresh.roomId, creationKey: "new-account-room" }];
	await account.provision();
	const pump = async () => { for (let i = 0; i < 30; i++) { now += 31000; await client.flush(new AbortController().signal); await worker.step(new AbortController().signal); await worker.flush(new AbortController().signal); } };
	await pump(); assert.equal(client.setupState(first.conversationId), "ready"); assert.equal(client.setupState(second.conversationId), "ready"); assert.equal(rules, 1, "only the new room initializes rules");
	joined.delete(fresh.roomId);
	worker.ingest({ rooms: { leave: { [fresh.roomId]: { timeline: { events: [{ type: "m.room.member", state_key: matrix.operatorUserId, sender: matrix.operatorUserId, event_id: "$departed", content: { membership: "leave" } }] } } } } });
	await worker.step(new AbortController().signal); await worker.flush(new AbortController().signal);
	let finish!: () => void; const departed = new Promise<void>(resolve => { finish = resolve; }); const hold = new Promise<void>(resolve => { release = resolve; });
	account.start(async id => { assert.equal(id, second.conversationId); retired.add(id); active = [coordinator]; finish(); await hold; }); await departed;
	const id = retirementId(hostId, second.conversationId), target = { kind: "operator_leave_forget" as const, roomId: fresh.roomId, userId: matrix.operatorUserId };
	const effect = { ...target, phase: "pending" as const, effectId: retirementEffectId(id, target) };
	pending = [{ version: 1, hostId, conversationId: second.conversationId, creationKey: "new-account-room", retirementId: id, retiredAt: now, cleanup: [effect] }];
	assert.equal(await account.leaveAndForget(effect, new AbortController().signal), false); await pump();
	assert.equal(await account.completed(effect, new AbortController().signal), true, await readFile(join(root, "host", "account.json"), "utf8")); assert.ok(forgotten.includes(fresh.roomId)); assert.ok(joined.has(old.roomId)); assert.equal(joined.has(fresh.roomId), false);
	await assert.rejects(account.leaveAndForget({ ...effect, userId: "@foreign:test" }, new AbortController().signal));
});

test("healthy subsets continue old broad journals without touching missing siblings, including pre-checkout plans", async t => {
	for (const legacy of [false, true]) for (const excludedRetired of [false, true]) {
		const root = await mkdtemp(join(tmpdir(), "broad-subset-")); t.after(() => rm(root, { recursive: true, force: true }));
		const matrix = new MatrixFixture({ point: "link:conversation", timing: "after" });
		const store = new ConversationManifestStore(join(root, "manifests")); await store.write(coordinator);
		const { hostSpace: _host, ...base } = coordinator;
		const ids = ["healthy", "removed"].map(key => deriveConversationId(hostId, key));
		for (const [index, key] of ["healthy", "removed"].entries()) {
			await store.write({ ...base, kind: "project", conversationId: ids[index]!, creationKey: key, concept: key, roomId: `!${key}:test`, piSessionId: key,
				bindingBoundaryEntryId: deriveTranscriptEntryId(key, "boundary"), projectSpace: "!old:test", placement: { rootKey: "projects", workspace: key, relativeCwd: "" } });
			matrix.legacy.add(`!${key}:test`); matrix.links.add(`!old:test/!${key}:test`);
		}
		matrix.legacy.add("!host:test"); matrix.legacy.add("!old:test");
		const registry = new RelayRegistry(hostId, join(root, "runtime"), store); await registry.load();
		let hierarchy = new LiveHierarchy(join(root, "hierarchy"), hostId, matrix, () => coordinator); await hierarchy.load();
		let missing = false;
		const make = () => new ProjectReconciler({ registry, matrix: matrix as unknown as ManagedMatrixClient, hierarchy, intentDirectory: join(root, "intents"),
			resolveWorkspace: async p => { if (missing && p.workspace === "removed") throw Error("workspace removed");
				return { ...p, workspacePath: `/projects/${p.workspace}`, cwd: `/projects/${p.workspace}`, projectKey: placement.projectKey, projectDisplayName: "Project", checkoutDisplayName: p.workspace }; } });
		let reconciler = make(); let broad = (await reconciler.previewLive(false)).migration!;
		if (legacy) {
			const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
			const plans = broad.items.map(item => ({ conversationId: item.conversationId, concept: item.concept, workspace: item.workspace, roomId: item.roomId,
				oldProjectSpace: item.oldProjectSpace, projectKey: item.projectKey, projectDisplayName: item.projectDisplayName, checkoutDisplayName: item.checkoutDisplayName,
				sourceManifestHash: digest(registry.manifestByConversationId(item.conversationId)), plannedProjectSpace: "!old:test" }));
			broad = { version: 1, reconciliationKey: `reconcile_${digest(plans).slice(0, 32)}`, items: plans.map(item => ({ ...item, targetProjectSpace: "!old:test",
				targetManifestHash: digest({ ...registry.manifestByConversationId(item.conversationId), projectKey: item.projectKey, projectDisplayName: item.projectDisplayName, checkoutDisplayName: item.checkoutDisplayName, projectSpace: "!old:test" }),
				hostLinked: false, roomLinked: false, manifestUpdated: false, oldUnlinked: false })) };
			matrix.resolvePrivateRoomAlias = async () => "!old:test";
		}
		await mkdir(join(root, "intents"), { mode: 0o700 }); const journal = join(root, "intents", "project-reconciliation.json");
		await writeFile(journal, JSON.stringify(broad), { mode: 0o600 }); missing = true;
		if (excludedRetired) {
			const candidate = registry.retirementCandidate(ids[1]!);
			await registry.retireConversation(ids[1]!, retirementTargets({ hostId, manifest: candidate.manifest, operatorUserId: matrix.operatorUserId, botUserId: matrix.botUserId,
				stop: { kind: "stop", generationId: candidate.generationId } }));
		}
		const excluded = broad.items.find(item => item.conversationId === ids[1]); const original = registry.manifestByConversationId(ids[1]!);
		for (let attempt = 0; attempt < 4 && !registry.manifestByConversationId(ids[0]!)?.checkoutSpace; attempt++) {
			const selected = await reconciler.previewLive(false, [ids[0]!]); assert.equal(selected.blockers, undefined);
			try { await reconciler.applyLive(selected, false); } catch (error) { assert.match(String(error), /injected/); }
			await hierarchy.close(); hierarchy = new LiveHierarchy(join(root, "hierarchy"), hostId, matrix, () => coordinator); await hierarchy.load(); reconciler = make();
		}
		const current = registry.manifestByConversationId(ids[0]!)!; assert.ok(current.checkoutSpace); assert.equal(current.roomId, "!healthy:test");
		const saved = JSON.parse(await readFile(journal, "utf8")); assert.equal(saved.reconciliationKey, broad.reconciliationKey); assert.equal(saved.selection, undefined);
		assert.deepEqual(saved.items.find((item: any) => item.conversationId === ids[1]), excluded); assert.deepEqual(registry.manifestByConversationId(ids[1]!), original);
		assert.ok(matrix.links.has("!old:test/!removed:test")); assert.ok(!matrix.links.has("!old:test/!healthy:test"));
		assert.equal([...matrix.rooms.values()].filter(proof => proof.kind === "worktree_space").length, 1, "one selected checkout Space across retries");
		await hierarchy.close();
	}
});

test("selected reconciliation isolates missing workspaces, freezes retry scope, and verifies new Space admin after restart", async t => {
	const root = await mkdtemp(join(tmpdir(), "scoped-hierarchy-")); t.after(() => rm(root, { recursive: true, force: true }));
	const matrix = new MatrixFixture({ point: "link:conversation", timing: "after" });
	const store = new ConversationManifestStore(join(root, "manifests")); await store.write(coordinator);
	const { hostSpace: _host, ...base } = coordinator;
	const ids = ["chosen", "missing"].map(key => deriveConversationId(hostId, key));
	for (const [index, key] of ["chosen", "missing"].entries()) {
		await store.write({ ...base, kind: "project", conversationId: ids[index]!, creationKey: key, concept: key, roomId: `!${key}:test`, piSessionId: key, bindingBoundaryEntryId: deriveTranscriptEntryId(key, "boundary"),
			projectSpace: "!old:test", placement: { rootKey: "projects", workspace: key, relativeCwd: "" } });
		matrix.legacy.add(`!${key}:test`); matrix.links.add(`!old:test/!${key}:test`);
	}
	matrix.legacy.add("!host:test"); matrix.legacy.add("!old:test");
	const registry = new RelayRegistry(hostId, join(root, "runtime"), store); await registry.load();
	let hierarchy = new LiveHierarchy(join(root, "hierarchy"), hostId, matrix, () => coordinator); await hierarchy.load();
	const resolved: string[] = [];
	const make = () => new ProjectReconciler({ registry, matrix: matrix as unknown as ManagedMatrixClient, hierarchy, intentDirectory: join(root, "intents"),
		resolveWorkspace: async p => { resolved.push(p.workspace); if (p.workspace === "missing") throw Error("missing checkout");
			return { ...p, workspacePath: "/projects/chosen", cwd: "/projects/chosen", projectKey: placement.projectKey, projectDisplayName: "Project", checkoutDisplayName: "Chosen" }; } });
	let reconciler = make();
	const blocked = await reconciler.previewLive(false, ids);
	assert.equal(blocked.blockers?.length, 1); assert.match(blocked.blockers![0]!, /missing.*cannot resolve workspace projects\/missing/);
	assert.equal(matrix.calls, 0); await assert.rejects(reconciler.applyLive(blocked, false));
	resolved.length = 0;
	const selected = await reconciler.previewLive(false, [ids[0]!]);
	assert.deepEqual(selected.selection, [ids[0]]); assert.ok(!resolved.includes("missing"));
	assert.equal(selected.migration?.items.length, 1);
	const runtime = registry.snapshot(); const absent = registry.manifestByConversationId(ids[1]!);
	await assert.rejects(reconciler.applyLive(selected, false), /injected/);
	await assert.rejects(reconciler.previewLive(false), /original selection/);
	assert.ok(matrix.links.has("!old:test/!chosen:test"), "old link retained until verification and commit");
	await hierarchy.close(); hierarchy = new LiveHierarchy(join(root, "hierarchy"), hostId, matrix, () => coordinator); await hierarchy.load(); reconciler = make();
	const roomCount = matrix.rooms.size;
	await reconciler.applyLive(await reconciler.previewLive(false, [ids[0]!]), false);
	assert.equal(matrix.rooms.size, roomCount, "restart does not duplicate Spaces");
	const manifest = registry.manifestByConversationId(ids[0]!)!;
	assert.equal(manifest.roomId, "!chosen:test"); assert.ok(matrix.admins.has(manifest.projectSpace!)); assert.ok(matrix.admins.has(manifest.checkoutSpace!));
	assert.ok(matrix.links.has(`${manifest.checkoutSpace}/!chosen:test`)); assert.ok(!matrix.links.has("!old:test/!chosen:test"));
	assert.deepEqual(registry.manifestByConversationId(ids[1]!), absent); assert.ok(matrix.links.has("!old:test/!missing:test"));
	assert.deepEqual(registry.snapshot(), runtime);
	const modern = await reconciler.previewLive(false, [ids[0]!]);
	assert.equal(modern.links.length, 3); assert.ok(!modern.links.some(link => link.child.roomId === "!missing:test"));
	await hierarchy.close();
});

test("legacy migration preserves old attachments, pending input and history across proof/link/store/unlink interruptions", async () => {
	for (const point of ["admin-readback", "link-readback", "host", "create:project_space", "create:worktree_space", "stamp:conversation", "link:conversation", "unlink", "manifest", "placement", "foreign", "retirement", "retire-mid", "legacy-receipt", "legacy-pending"]) {
		const root = await mkdtemp(join(tmpdir(), "legacy-hierarchy-")); const matrix = new MatrixFixture(point === "manifest" ? undefined : { point, timing: "after" });
		const store = new ConversationManifestStore(join(root, "manifests"));
		if (point === "admin-readback") {
			const verify = matrix.assertOperatorSpaceAdmin.bind(matrix); let fail = true;
			matrix.assertOperatorSpaceAdmin = async room => { if (fail) { fail = false; throw Error("injected admin readback failure"); } await verify(room); };
		}
		if (point === "link-readback") {
			const children = matrix.spaceChildren.bind(matrix); let fail = true;
			matrix.spaceChildren = async room => { if (fail) { fail = false; return []; } return children(room); };
		}
		const { hostSpace: _host, ...base } = coordinator;
		const id = deriveConversationId(hostId, "legacy");
		const original: ConversationManifest = { ...base, kind: "project", conversationId: id, creationKey: "legacy", roomId: "!legacy:test",
			piSessionId: "saved", bindingBoundaryEntryId: deriveTranscriptEntryId("saved", "boundary"), projectSpace: "!old:test",
			placement: { rootKey: "projects", workspace: "repository", relativeCwd: "subdir" },
			...(point === "legacy-receipt" ? { projectKey: placement.projectKey, projectDisplayName: "Project", checkoutDisplayName: "Main" } : {}) };
		await store.write(coordinator); await store.write(original);
		const registry = new RelayRegistry(hostId, join(root, "runtime"), store); await registry.load();
		await registry.setAttachmentNonce(id, "abcdefghijklmnopqrstuvwxyzABCDEF");
		await registry.attach({ protocolVersion: "1.0.0", role: "ordinary_adapter", type: "attachment.attach", messageId: "old-attach", conversationId: id,
			payload: { sessionId: "saved", bindingBoundaryEntryId: original.bindingBoundaryEntryId, attachmentNonce: "abcdefghijklmnopqrstuvwxyzABCDEF" } }, "old-socket");
		await registry.recordAcceptedInput(id, { deliveryId: deriveDeliveryId(id, "$pending"), matrixEventId: "$pending", kind: "prompt", body: "retained work", status: "accepted" });
		await writeFile(join(root, "saved.jsonl"), "unchanged native history\n");
		for (const room of ["!host:test", "!old:test", "!legacy:test"]) matrix.legacy.add(room);
		matrix.links.add("!old:test/!legacy:test");
		let priorKey: string | undefined;
		if (point === "legacy-receipt" || point === "legacy-pending") {
			const pending = point === "legacy-pending";
			if (pending) matrix.resolvePrivateRoomAlias = async () => "!old:test";
			const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
			const item = { conversationId: id, concept: original.concept, workspace: "repository", roomId: original.roomId, oldProjectSpace: pending ? "!old:test" : "!before:test",
				projectKey: placement.projectKey, projectDisplayName: "Project", checkoutDisplayName: "Main", sourceManifestHash: pending ? digest(original) : "a".repeat(64), plannedProjectSpace: "!old:test" };
			priorKey = `reconcile_${digest([item]).slice(0, 32)}`;
			await mkdir(join(root, "intents"), { mode: 0o700 });
			await writeFile(join(root, "intents", "project-reconciliation.json"), JSON.stringify({ version: 1, reconciliationKey: priorKey,
				items: [{ ...item, targetProjectSpace: "!old:test", targetManifestHash: digest({ ...original, projectKey: placement.projectKey, projectDisplayName: "Project", checkoutDisplayName: "Main" }), hostLinked: !pending, roomLinked: !pending, manifestUpdated: !pending, oldUnlinked: !pending }],
				...(pending ? {} : { cleanupSpaces: [{ spaceId: "!before:test", hostUnlinked: false, operatorRemoved: false, left: false }] }) }), { mode: 0o600 });
		}
		const state = registry.snapshot();
		const makeHierarchy = () => new LiveHierarchy(join(root, "hierarchy"), hostId, matrix, () => coordinator, cid => Boolean(registry.retirement(cid)));
		let hierarchy = makeHierarchy(); await hierarchy.load();
		let canonicalRoot = "/projects/repository";
		const make = () => new ProjectReconciler({ registry, matrix: matrix as unknown as ManagedMatrixClient, hierarchy, intentDirectory: join(root, "intents"),
			resolveWorkspace: async p => ({ ...p, workspacePath: canonicalRoot, cwd: `${canonicalRoot}/subdir`, projectKey: placement.projectKey, projectDisplayName: "Project", checkoutDisplayName: "Main" }) });
		const retire = async () => {
			const candidate = registry.retirementCandidate(id);
			return registry.retireConversation(id, retirementTargets({ hostId, manifest: candidate.manifest, operatorUserId: matrix.operatorUserId, botUserId: matrix.botUserId,
				stop: { kind: "stop", generationId: candidate.generationId, attachmentId: candidate.attachmentId, ...(candidate.unresolvedLaunch ? { unresolvedLaunch: true as const } : {}),
					...(candidate.window ? { window: candidate.window } : {}) } }));
		};
		const update = registry.reconcileProjectManifest.bind(registry); let fail = point === "manifest";
		registry.reconcileProjectManifest = async (...args) => { if (point === "retire-mid") await retire(); const result = await update(...args); if (fail) { fail = false; throw Error("injected after manifest"); } return result; };
		try {
			let reconciler = make(); const preview = await reconciler.previewLive(false); assert.equal(matrix.calls, 0); assert.equal(preview.migration?.items.length, 1);
			if (point === "placement") {
				canonicalRoot = "/projects/replaced";
				await assert.rejects(reconciler.applyLive(preview, false), /preview changed/); assert.equal(matrix.calls, 0);
				canonicalRoot = "/projects/repository";
			} else if (point === "foreign") {
				matrix.rooms.set(original.roomId, { version: 1, hostId: "foreign", kind: "host_space", creationKey: "host" });
				await assert.rejects(reconciler.applyLive(preview, false), /ownership proof/); assert.equal(matrix.calls, 0);
				matrix.rooms.delete(original.roomId);
			} else if (point === "retirement") {
				await retire();
				await assert.rejects(reconciler.applyLive(preview, false), /preview changed/); assert.equal(matrix.calls, 0);
				assert.equal(registry.manifestByConversationId(id), undefined); continue;
			} else if (point === "legacy-pending") {
				assert.equal(preview.legacyPlacements?.[0].hostSpace, coordinator.hostSpace);
				canonicalRoot = "/projects/replaced";
				await assert.rejects(reconciler.applyLive(preview, false), /preview changed/); assert.equal(matrix.calls, 0);
				canonicalRoot = "/projects/repository";
				await reconciler.applyLive(preview, false);
				assert.equal(registry.manifestByConversationId(id)?.checkoutSpace, undefined, "first consent finishes only the original #68 scope");
			} else if (point === "retire-mid") await assert.rejects(reconciler.applyLive(preview, false));
			else if (point !== "legacy-receipt") await assert.rejects(reconciler.applyLive(preview, false), point === "link-readback" ? /readback failed/ : /injected/);
			await hierarchy.close(); hierarchy = makeHierarchy(); await hierarchy.load(); reconciler = make();
			await reconciler.applyLive(await reconciler.previewLive(false), false);
			if (point === "retire-mid") {
				assert.ok(registry.retirement(id)); assert.equal(registry.manifestByConversationId(id), undefined);
				const intent = JSON.parse(await readFile(join(root, "intents", "project-reconciliation.json"), "utf8"));
				assert.equal(intent.items[0].retired, true, "restart preserves a terminal skip, not resurrection or expanded cleanup");
				assert.ok(matrix.links.has("!old:test/!legacy:test"), "migration does not unlink after retirement wins"); continue;
			}
			const current = registry.manifestByConversationId(id)!; assert.ok(current.checkoutSpace); assert.equal(current.roomId, original.roomId);
			assert.equal(current.piSessionId, original.piSessionId); assert.equal(current.bindingBoundaryEntryId, original.bindingBoundaryEntryId);
			assert.deepEqual(registry.snapshot(), state, "no input, attachment, nonce, launch or runtime projection changes");
			assert.equal(await readFile(join(root, "saved.jsonl"), "utf8"), "unchanged native history\n");
			assert.ok(matrix.links.has(`${current.checkoutSpace}/${current.roomId}`)); assert.ok(!matrix.links.has("!old:test/!legacy:test"));
			assert.equal(matrix.aliases.size, priorKey ? 1 : 2, "saved project IDs are reused; the conversation room is never replaced");
			const completedIntent = JSON.parse(await readFile(join(root, "intents", "project-reconciliation.json"), "utf8"));
			assert.deepEqual(completedIntent.cleanupSpaces, [], "migration retains old IDs without manufacturing destructive cleanup authority");
			assert.equal(completedIntent.items[0].oldProjectSpace, "!old:test");
			const beforeCleanup = matrix.calls;
			await assert.rejects(reconciler.cleanup(completedIntent.reconciliationKey), /modern ownership preview/);
			assert.equal(matrix.calls, beforeCleanup, "even direct legacy cleanup callers cannot kick or leave");
			if (priorKey) {
				assert.equal(current.projectSpace, "!old:test");
				const receipt = JSON.parse(await readFile(join(root, "intents", `project-reconciliation-${priorKey}.json`), "utf8"));
				if (point === "legacy-receipt") assert.equal(receipt.cleanupSpaces[0].spaceId, "!before:test", "old cleanup identities remain in the backup boundary, never silently discarded or kicked");
				assert.equal(receipt.items[0].oldUnlinked, true);
				receipt.items[0].retired = true;
				await writeFile(join(root, "intents", "project-reconciliation.json"), JSON.stringify(receipt), { mode: 0o600 });
				await assert.rejects(reconciler.previewLive(false), /retirement authority is missing/, "a completed legacy receipt cannot hide a partial restore that lost tombstones");
			}
			assert.equal(hierarchy.accountInventory().find(node => node.roomId === current.roomId)?.preserveNotificationPolicy, true);
			const actions: Array<Record<string, unknown>> = [];
			const client = { notificationSetup: () => "initial", cancelRetired: async () => {}, requestMany: async (values: Array<Record<string, unknown>>) => { actions.push(...values); } } as unknown as HostAccountClient;
			await new HostAccountOwner(client, registry, matrix as unknown as ManagedMatrixClient, hierarchy).provision();
			assert.equal(actions.find(action => action.roomId === current.roomId)?.notificationSetup, "preserve", "migration never initializes policies on an existing room, even without an account baseline");
		} finally { await hierarchy.close(); await rm(root, { recursive: true, force: true }); }
	}
});

test("live reconciliation repairs only frozen proven links, rejects new scope, and never adopts foreign ownership", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "hierarchy-reconcile-")); const matrix = new MatrixFixture();
	const hierarchy = new LiveHierarchy(root, hostId, matrix, () => coordinator); await hierarchy.load();
	t.after(async () => { await hierarchy.close(); await rm(root, { recursive: true, force: true }); });
	const first = await hierarchy.prepare(placement); const bound = await hierarchy.provision(first.conversationId);
	const registry = { listManifests: () => [], localConversations: () => [], retirement: () => undefined } as unknown as RelayRegistry;
	const reconciler = new ProjectReconciler({ registry, matrix: matrix as unknown as ManagedMatrixClient, hierarchy, intentDirectory: root,
		resolveWorkspace: async () => { throw Error("Live reconciliation must not run legacy discovery"); } });
	matrix.links.delete(`${bound.checkoutSpace}/${bound.roomId}`);
	const frozen = await reconciler.previewLive(false); assert.equal(frozen.links.length, 3); const before = matrix.calls;
	assert.deepEqual(await reconciler.applyLive(frozen, false), { remaining: 0 }); assert.equal(matrix.calls, before + 1);
	assert.ok(matrix.links.has(`${bound.checkoutSpace}/${bound.roomId}`));
	await reconciler.applyLive(frozen, false); assert.equal(matrix.calls, before + 1, "already-correct links cause no state writes");
	const second = await hierarchy.prepare({ ...placement, creationKey: "second" }); await hierarchy.provision(second.conversationId);
	const changed = matrix.calls; await assert.rejects(reconciler.applyLive(frozen, false), /preview changed/); assert.equal(matrix.calls, changed);
	matrix.rooms.set(bound.roomId, { ...matrix.rooms.get(bound.roomId)!, hostId: "another-host" });
	await assert.rejects(reconciler.previewLive(false)); assert.equal(matrix.calls, changed, "foreign proof is never repaired or stamped");
});

test("standalone cleanup fences exact empty Spaces, waits for account ownership and preserves replacement branches", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "hierarchy-standalone-cleanup-")); const matrix = new MatrixFixture(); const retired = new Set<string>();
	const make = () => new LiveHierarchy(root, hostId, matrix, () => coordinator, (id) => retired.has(id));
	let hierarchy = make(); await hierarchy.load(); t.after(async () => { await hierarchy.close(); await rm(root, { recursive: true, force: true }); });
	const registry = { listManifests: () => [], localConversations: () => [], retirement: (id: string) => retired.has(id) ? {} : undefined } as unknown as RelayRegistry;
	const reconciler = (account?: SpaceCleanupAccount) => new ProjectReconciler({ registry, matrix: matrix as unknown as ManagedMatrixClient,
		hierarchy, account, intentDirectory: root, resolveWorkspace: async () => { throw Error("No legacy lookup"); } });
	const first = await hierarchy.prepare(placement); const old = await hierarchy.provision(first.conversationId);
	assert.deepEqual((await reconciler().previewLive(true)).links, [], "live and unpublished conversation references prohibit cleanup");
	retired.add(first.conversationId); matrix.links.delete(`${old.checkoutSpace}/${old.roomId}`);
	const frozen = await reconciler().previewLive(true); assert.equal(frozen.links.length, 1); assert.equal(frozen.links[0].child.roomId, old.checkoutSpace);
	matrix.extraMembers.set(old.checkoutSpace, ["@other:test"]);
	await assert.rejects(reconciler().applyLive(frozen, true), /preview changed/); assert.equal(matrix.left.size, 0);
	matrix.extraMembers.clear(); const before = matrix.calls;
	assert.deepEqual(await reconciler().applyLive(frozen, true), { remaining: 1 }); assert.equal(matrix.calls, before, "no account port means no unlink, kick or leave");
	await hierarchy.close(); hierarchy = make(); await hierarchy.load();
	assert.deepEqual(await reconciler().previewLive(true), frozen, "pending exact authority survives restart");
	const second = await hierarchy.prepare({ ...placement, creationKey: "replacement" }); const fresh = await hierarchy.provision(second.conversationId);
	assert.notEqual(fresh.checkoutSpace, old.checkoutSpace);
	const accountCalls: string[] = []; const account: SpaceCleanupAccount = {
		leaveAndForget: async (target) => { accountCalls.push(target.roomId); return true; }, completed: async (target) => accountCalls.includes(target.roomId),
	};
	matrix.loseLeaveReply = true;
	await assert.rejects(reconciler(account).applyLive(frozen, true), /lost leave reply/);
	const afterLostLeave = matrix.calls;
	await hierarchy.close(); hierarchy = make(); await hierarchy.load();
	assert.deepEqual(await reconciler(account).applyLive(frozen, true), { remaining: 0 });
	assert.equal(matrix.calls, afterLostLeave, "verified prior bot/account departure completes only local bookkeeping after restart");
	assert.deepEqual(accountCalls, [old.checkoutSpace]); assert.deepEqual([...matrix.left], [old.checkoutSpace]);
	assert.ok(matrix.links.has(`${fresh.projectSpace}/${fresh.checkoutSpace}`)); assert.ok(matrix.links.has(`${fresh.checkoutSpace}/${fresh.roomId}`));
	assert.deepEqual((await reconciler(account).previewLive(true)).links, []);
});

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
