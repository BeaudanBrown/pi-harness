import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArchiveHierarchy, historicalCheckoutId } from "../config/agent/extensions/managed-sessions/relay/archive-hierarchy.js";
import { RelayRegistry } from "../config/agent/extensions/managed-sessions/relay/registry.js";
import { ConversationManifestStore } from "../config/agent/extensions/managed-sessions/relay/manifest-store.js";
import { LiveHierarchy } from "../config/agent/extensions/managed-sessions/relay/live-hierarchy.js";
import { AtomicJsonFile } from "../config/agent/extensions/managed-sessions/relay/atomic-json.js";
import type { ManagedMatrixClient } from "../config/agent/extensions/managed-sessions/relay/matrix-client.js";
import { deriveConversationId, deriveTranscriptEntryId, type ConversationManifest } from "../config/agent/extensions/managed-sessions/contracts.js";
import { deriveCheckoutId, managedRoomAlias, MANAGED_PROVENANCE_EVENT, type ManagedProvenance } from "../config/agent/extensions/managed-sessions/managed-provenance.js";
import { accountActionIdentity, parseAccountAction } from "../config/agent/extensions/managed-sessions/live-workspace-contracts.js";
import { accountRoomProofs, verifyManagedHierarchy } from "../config/agent/extensions/bridge-chat/account-proof.js";

class Matrix {
	operatorUserId = "@operator:example.com"; botUserId = "@bot:example.com";
	proofs = new Map<string, ManagedProvenance>(); aliases = new Map<string, string>();
	children = new Map<string, Map<string, Record<string, unknown>>>(); members = new Map<string, Set<string>>();
	effects: string[] = []; fault?: string; autoJoin = true; absentAlias = false;
	room(proof: ManagedProvenance) { return `!${proof.kind}-${proof.creationKey}:example.com`; }
	fail(label: string) { if (this.fault === label) { this.fault = undefined; throw Error(`Injected ${label} after acceptance`); } }
	async ensureManagedRoom(_title: string, proof: ManagedProvenance, _signal?: AbortSignal, admin?: boolean) {
		if (proof.kind.startsWith("archive_")) assert.equal(admin, true);
		const id = this.room(proof); this.proofs.set(id, structuredClone(proof)); this.aliases.set(managedRoomAlias(proof), id);
		this.members.set(id, new Set([this.botUserId, ...(!proof.kind.startsWith("archive_") || this.autoJoin ? [this.operatorUserId] : [])]));
		this.children.set(id, new Map()); this.effects.push(`create:${id}`); if (proof.kind.startsWith("archive_")) this.fail("create"); return id;
	}
	async recoverManagedRoom(id: string, proof: ManagedProvenance) { assert.deepEqual(this.proofs.get(id), proof); }
	async recoverManagedAlias(proof: ManagedProvenance) { const id = this.absentAlias ? undefined : this.aliases.get(managedRoomAlias(proof)); if (id) await this.recoverManagedRoom(id, proof); return id; }
	async inspectLegacyRoom(id: string, _space: boolean) { assert.ok(this.proofs.has(id)); return structuredClone(this.proofs.get(id)); }
	async ensureLegacyHostProvenance() { return "!host:example.com"; }
	async assertOperatorSpaceAdmin() {}
	async assertRoomAuthority(id: string) { assert.ok(this.members.get(id)?.has(this.botUserId)); }
	async memberJoined(id: string, user: string) { return this.members.get(id)?.has(user) ?? false; }
	async joinedMemberIds(id: string) { return new Set(this.members.get(id)); }
	async accountJoined(id: string) { return this.memberJoined(id, this.botUserId); }
	async leaveRoom(id: string) { this.members.get(id)!.delete(this.botUserId); this.effects.push(`leave:${id}`); }
	async spaceChildContent(parent: string, child: string) { return structuredClone(this.children.get(parent)?.get(child) ?? null); }
	async spaceChildren(id: string) { return [...this.children.get(id) ?? []].filter(([, c]) => Array.isArray(c.via) && c.via.length > 0).map(([id]) => id); }
	async addSpaceChild(parent: string, child: string) {
		if (!this.children.has(parent)) this.children.set(parent, new Map()); this.children.get(parent)!.set(child, { via: ["example.com"], suggested: true });
		this.effects.push(`link:${parent}:${child}`); this.fail("link");
	}
	async removeSpaceChild(parent: string, child: string) { this.children.get(parent)!.set(child, {}); this.effects.push(`unlink:${parent}:${child}`); this.fail("unlink"); }
}
async function fixture(t: { after(fn: () => Promise<void>): void }, sibling = false) {
	const directory = await mkdtemp(join(tmpdir(), "archive-hierarchy-")); const matrix = new Matrix();
	const store = new ConversationManifestStore(join(directory, "manifests")); const projectKey = `project_${"a".repeat(32)}`;
	const root = "/never/existed/deleted-worktree"; const checkoutId = deriveCheckoutId("host", projectKey, root);
	const host = "!host:example.com"; matrix.proofs.set(host, { version: 1, hostId: "host", kind: "host_space", creationKey: "host" }); matrix.members.set(host, new Set([matrix.operatorUserId, matrix.botUserId])); matrix.children.set(host, new Map());
	const make = (key: string, coordinator = false): ConversationManifest => ({ schemaVersion: "1.0.0", ownerHostId: "host", kind: coordinator ? "coordinator" : "project", creationKey: key,
		conversationId: deriveConversationId("host", key), concept: key, piSessionId: `session-${key}`, roomId: `!conversation-${key}:example.com`, ...(coordinator ? { hostSpace: host } : {}),
		bindingBoundaryEntryId: deriveTranscriptEntryId(`session-${key}`, "boundary"), createdAt: "2026-10-01T00:00:00.000Z",
		...(!coordinator ? { placement: { rootKey: "projects", workspace: "deleted-worktree", relativeCwd: "" }, projectKey, projectDisplayName: "historical-project", checkoutDisplayName: "deleted-worktree",
			checkoutId, projectSpace: `!project_space-${projectKey}:example.com`, checkoutSpace: `!worktree_space-${checkoutId}:example.com` } : {}) });
	const coordinator = make("coordinator", true); const first = make("first"); const second = make("second");
	for (const m of [coordinator, first, ...(sibling ? [second] : [])]) await store.write(m);
	const registry = new RelayRegistry("host", join(directory, "runtime"), store); await registry.load();
	const hierarchy = new LiveHierarchy(join(directory, "live"), "host", matrix as unknown as ManagedMatrixClient, () => coordinator, id => Boolean(registry.retirement(id) || registry.archiveRecord(id))); await hierarchy.load();
	for (const m of [first, ...(sibling ? [second] : [])]) {
		await hierarchy.prepare({ creationKey: m.creationKey, projectKey, canonicalCheckoutRoot: root, projectTitle: "historical-project", checkoutTitle: "deleted-worktree", conversationTitle: m.concept });
		await hierarchy.provision(m.conversationId);
	}
	let closureError = false; let closureChecks = 0; let accountReady = true;
	const owners: ArchiveHierarchy[] = [];
	const owner = async () => {
		const value = new ArchiveHierarchy({ directory: join(directory, "archive"), registry, hierarchy, matrix: matrix as unknown as ManagedMatrixClient,
			assertRuntimeAbsent: async () => { closureChecks++; if (closureError) throw Error("No fresh process-absence proof"); },
			account: { leaveAndForget: async target => { if (!accountReady) return false; matrix.members.get(target.roomId)!.delete(matrix.operatorUserId); return true; }, completed: async () => accountReady } });
		await value.load(); owners.push(value); return value;
	};
	t.after(async () => { for (const value of owners) await value.close(); await hierarchy.close(); await rm(directory, { recursive: true, force: true }); });
	matrix.effects = []; return { directory, registry, hierarchy, matrix, first, second, owner, closureChecks: () => closureChecks, setClosureError: () => { closureError = true; }, setAccountReady: (value: boolean) => { accountReady = value; } };
}

test("deleted checkout archives original room with admin Spaces; leaves live sibling and history intact", async t => {
	const f = await fixture(t, true); const owner = await f.owner(); const plan = await owner.preview(f.first.conversationId);
	assert.equal(f.matrix.effects.length, 0); assert.equal(f.registry.archiveRecord(f.first.conversationId), undefined);
	const result = await owner.apply(plan); assert.equal(result?.phase, "archived"); assert.equal(f.closureChecks(), 1);
	assert.equal(f.matrix.effects.filter(e => e.startsWith("create:")).length, 3);
	assert.ok(await f.matrix.memberJoined(f.first.roomId, f.matrix.operatorUserId));
	assert.deepEqual(await f.matrix.spaceChildren(f.first.checkoutSpace!), [f.second.roomId]);
	assert.deepEqual(await f.matrix.spaceChildren(result!.archiveSpaces[2]!), [f.first.roomId]);
	assert.ok(f.registry.manifestByConversationId(f.second.conversationId));
	assert.equal((await owner.cleanup(f.first.conversationId))?.preservedSpaces.length, 2);
	assert.equal(f.matrix.effects.filter(e => e.startsWith("leave:")).length, 0);
	const entries = owner.accountInventory(); assert.equal(entries.length, 3);
	for (const node of entries) {
		const { provenance, ...placement } = node; const { preserveNotificationPolicy: _, ...fields } = placement;
		const body = { version: "1.0.0", hostId: "host", operation: "room.ensure", ...fields, kind: provenance.kind, creationKey: provenance.creationKey, notificationSetup: "preserve" };
		const action = parseAccountAction({ ...body, ...accountActionIdentity(body) }); assert.equal(action.operation, "room.ensure");
		if (action.operation === "room.ensure") assert.deepEqual(accountRoomProofs(action).map(r => r.expected.kind), ["host_space", "archive_root_space", ...(provenance.kind === "archive_root_space" ? [] : ["archive_project_space"]), ...(provenance.kind === "archive_worktree_space" ? ["archive_worktree_space"] : [])]);
	}
});

for (const fault of ["create", "link", "unlink"] as const) test(`restart recovers ${fault} accepted before acknowledgement without new identities`, async t => {
	const f = await fixture(t); let owner = await f.owner(); const plan = await owner.preview(f.first.conversationId);
	f.matrix.fault = fault; await assert.rejects(owner.apply(plan), /Injected/);
	assert.ok(f.registry.archiveRecord(f.first.conversationId)); await owner.close(); owner = await f.owner();
	assert.equal((await owner.apply(await owner.preview(f.first.conversationId)))?.phase, "archived");
	assert.equal(f.matrix.effects.filter(e => e.startsWith("create:")).length, 3); assert.equal(f.closureChecks(), 1);
});

test("uncertain creation with no alias never allocates a replacement Space", async t => {
	const f = await fixture(t); let owner = await f.owner(); const plan = await owner.preview(f.first.conversationId);
	f.matrix.fault = "create"; await assert.rejects(owner.apply(plan)); await owner.close(); owner = await f.owner(); f.matrix.absentAlias = true;
	await assert.rejects(owner.apply(plan), /Uncertain archive creation/); assert.equal(f.matrix.effects.filter(e => e.startsWith("create:")).length, 1);
});

test("no process-absence proof or changed original link prevents admission and Matrix effects", async t => {
	const f = await fixture(t); const owner = await f.owner(); const plan = await owner.preview(f.first.conversationId); f.setClosureError();
	await assert.rejects(owner.apply(plan), /process-absence/); assert.equal(f.registry.archiveRecord(f.first.conversationId), undefined); assert.deepEqual(f.matrix.effects, []);
	f.matrix.children.get(f.first.checkoutSpace!)!.set(f.first.roomId, { via: ["example.com"], order: "operator-change" });
	await assert.rejects(owner.apply(plan), /source link changed/); assert.equal(f.registry.archiveRecord(f.first.conversationId), undefined);
});

test("existing missing operator membership is a blocker, not permission to restore it", async t => {
	const f = await fixture(t); const owner = await f.owner(); f.matrix.members.get(f.first.roomId)!.delete(f.matrix.operatorUserId);
	await assert.rejects(owner.preview(f.first.conversationId), /existing operator membership/); assert.deepEqual(f.matrix.effects, []);
});

test("pending joins to new archive Spaces preserve original links until readable", async t => {
	const f = await fixture(t); const owner = await f.owner(); const plan = await owner.preview(f.first.conversationId); f.matrix.autoJoin = false;
	assert.equal((await owner.apply(plan))?.phase, "archiving"); assert.deepEqual(await f.matrix.spaceChildren(f.first.checkoutSpace!), [f.first.roomId]);
	for (const room of owner.status(f.first.conversationId)!.archiveSpaces) f.matrix.members.get(room)!.add(f.matrix.operatorUserId);
	assert.equal((await owner.apply(plan))?.phase, "archived"); assert.equal(f.matrix.effects.filter(e => e.startsWith("create:")).length, 3);
});

test("archive survives account cleanup outage; exact empty ancestors can be retried separately", async t => {
	const f = await fixture(t); const owner = await f.owner(); await owner.apply(await owner.preview(f.first.conversationId));
	f.setAccountReady(false); const pending = await owner.cleanup(f.first.conversationId); assert.equal(pending?.phase, "archived"); assert.ok(pending!.cleanupPending > 0);
	assert.ok(await f.matrix.memberJoined(f.first.roomId, f.matrix.operatorUserId));
	f.setAccountReady(true); const done = await owner.cleanup(f.first.conversationId); assert.equal(done?.cleanupPending, 0);
	assert.deepEqual(f.matrix.effects.filter(e => e.startsWith("leave:")).sort(), [`leave:${f.first.checkoutSpace}`, `leave:${f.first.projectSpace}`].sort());
	assert.ok(await f.matrix.memberJoined(f.first.roomId, f.matrix.botUserId));
});

test("lost cleanup departure cannot infer fresh emptiness after an external change", async t => {
	const f = await fixture(t); const owner = await f.owner(); await owner.apply(await owner.preview(f.first.conversationId));
	const leave = f.matrix.leaveRoom.bind(f.matrix); let lost = false;
	f.matrix.leaveRoom = async roomId => { await leave(roomId); if (!lost) { lost = true; throw Error("lost leave reply"); } };
	assert.ok((await owner.cleanup(f.first.conversationId))!.cleanupPending > 0);
	f.matrix.children.get(f.first.checkoutSpace!)!.set("!external:example.com", { via: ["example.com"] });
	f.matrix.members.get(f.first.checkoutSpace!)!.add("@external:example.com");
	const effects = [...f.matrix.effects]; assert.ok((await owner.cleanup(f.first.conversationId))!.cleanupPending > 0);
	assert.deepEqual(f.matrix.effects, effects); assert.equal(owner.status(f.first.conversationId)?.phase, "archived");
});

test("unrelated children or members preserve empty-looking shared ancestors", async t => {
	const f = await fixture(t); const owner = await f.owner(); const plan = await owner.preview(f.first.conversationId);
	await owner.apply(plan); f.matrix.children.get(f.first.checkoutSpace!)!.set("!unrelated:example.com", { via: ["example.com"] });
	assert.ok((await owner.cleanup(f.first.conversationId))!.preservedSpaces.includes(f.first.checkoutSpace!));
	f.matrix.children.get(f.first.checkoutSpace!)!.delete("!unrelated:example.com"); f.matrix.members.get(f.first.checkoutSpace!)!.add("@other:example.com");
	assert.ok((await owner.cleanup(f.first.conversationId))!.preservedSpaces.includes(f.first.checkoutSpace!)); assert.equal(f.matrix.effects.filter(e => e.startsWith("leave:")).length, 0);
});

test("loss of an archive ancestor link before unlink preserves the old conversation link", async t => {
	const f = await fixture(t); const owner = await f.owner(); const plan = await owner.preview(f.first.conversationId);
	const read = f.matrix.spaceChildContent.bind(f.matrix); let changed = false;
	f.matrix.spaceChildContent = async (parent, child) => {
		if (!changed && parent.startsWith("!archive_worktree_space-") && child === f.first.roomId && f.matrix.children.get(parent)?.has(child)) {
			changed = true; f.matrix.children.get(plan.host.roomId)!.delete("!archive_root_space-archive-root:example.com");
		}
		return read(parent, child);
	};
	await assert.rejects(owner.apply(plan), /path is no longer readable/);
	assert.deepEqual(await f.matrix.spaceChildren(f.first.checkoutSpace!), [f.first.roomId]); assert.ok(!f.matrix.effects.some(e => e.startsWith("unlink:")));
});

test("shared checkout archives reuse the same Spaces and clean ancestors exactly once", async t => {
	const f = await fixture(t, true); const owner = await f.owner(); const a = await owner.preview(f.first.conversationId), b = await owner.preview(f.second.conversationId);
	await Promise.all([owner.apply(a), owner.apply(b)]);
	assert.equal(f.matrix.effects.filter(e => e.startsWith("create:")).length, 3);
	assert.deepEqual(owner.status(f.first.conversationId)?.archiveSpaces, owner.status(f.second.conversationId)?.archiveSpaces);
	await owner.cleanup(f.first.conversationId); await owner.cleanup(f.second.conversationId);
	assert.equal(f.matrix.effects.filter(e => e.startsWith("leave:")).length, 2);
});

test("unpublished reservations and legacy saved identity remain independent of checkout existence", async t => {
	const f = await fixture(t); const owner = await f.owner(); const plan = await owner.preview(f.first.conversationId);
	const legacy = structuredClone(plan.source); delete legacy.checkoutId;
	assert.equal(historicalCheckoutId("host", legacy), historicalCheckoutId("host", { ...legacy, title: "renamed", placement: { ...legacy.placement, relativeCwd: "subdir" } }));
	await owner.apply(plan);
	await f.hierarchy.prepare({ creationKey: "new-reservation", projectKey: plan.source.projectKey, canonicalCheckoutRoot: "/never/existed/deleted-worktree", projectTitle: "historical-project", checkoutTitle: "deleted-worktree", conversationTitle: "new" });
	assert.ok((await owner.cleanup(f.first.conversationId))!.preservedSpaces.includes(f.first.checkoutSpace!)); assert.equal(f.matrix.effects.filter(e => e.startsWith("leave:")).length, 0);
});

test("missing archive hierarchy journal cannot reallocate after durable admission", async t => {
	const f = await fixture(t); const owner = await f.owner(); await owner.apply(await owner.preview(f.first.conversationId)); await owner.close();
	await rm(join(f.directory, "archive", "archive-hierarchy.json")); await assert.rejects(f.owner(), /journal is missing/);
	assert.ok(f.registry.archiveRecord(f.first.conversationId));
});

test("NAS validates the archive parent chain and rejects cross-kind or substituted roots", async t => {
	const f = await fixture(t); const owner = await f.owner(); await owner.apply(await owner.preview(f.first.conversationId));
	const node = owner.accountInventory().at(-1)!;
	const body = { version: "1.0.0", hostId: "host", operation: "room.ensure", kind: node.provenance.kind, creationKey: node.provenance.creationKey, roomId: node.roomId,
		hostSpaceId: node.hostSpaceId, archiveRootSpaceId: node.archiveRootSpaceId, project: node.project, checkout: node.checkout, notificationSetup: "preserve" };
	const action = parseAccountAction({ ...body, ...accountActionIdentity(body) }); assert.equal(action.operation, "room.ensure"); if (action.operation !== "room.ensure") return;
	const snapshots = new Map(accountRoomProofs(action).map(({ roomId }) => [roomId, [
		{ type: "m.room.create", state_key: "", sender: f.matrix.botUserId, content: { creator: f.matrix.botUserId, room_version: "10", type: "m.space", "m.federate": false } },
		{ type: "m.room.join_rules", state_key: "", sender: f.matrix.botUserId, content: { join_rule: "invite" } },
		{ type: MANAGED_PROVENANCE_EVENT, state_key: "", sender: f.matrix.botUserId, content: structuredClone(f.matrix.proofs.get(roomId)) },
		...[...f.matrix.children.get(roomId) ?? []].map(([child, content]) => ({ type: "m.space.child", state_key: child, sender: f.matrix.botUserId, content })),
	]]));
	verifyManagedHierarchy(action, f.matrix.botUserId, snapshots);
	const ordinary = { ...body, kind: "worktree_space" }; assert.throws(() => parseAccountAction({ ...ordinary, ...accountActionIdentity(ordinary) }), /Archive hierarchy/);
	const changed = { ...body, archiveRootSpaceId: "!substituted:example.com" };
	const forged = parseAccountAction({ ...changed, ...accountActionIdentity(changed) });
	if (forged.operation === "room.ensure") assert.throws(() => verifyManagedHierarchy(forged, f.matrix.botUserId, snapshots));
});

test("uncertain local journal writes poison the owner and never roll back an accepted create", async t => {
	const f = await fixture(t); let owner = await f.owner(); const plan = await owner.preview(f.first.conversationId); const original = AtomicJsonFile.prototype.write;
	AtomicJsonFile.prototype.write = async function (value: unknown) {
		await original.call(this, value);
		if (this.path.endsWith("archive-hierarchy.json") && f.matrix.effects.some(e => e.startsWith("create:"))) throw Error("Injected post-rename");
	};
	try { await assert.rejects(owner.apply(plan), /Injected/); } finally { AtomicJsonFile.prototype.write = original; }
	assert.throws(() => owner.status(f.first.conversationId), /unavailable/); await owner.close(); owner = await f.owner();
	assert.equal((await owner.apply(plan))?.phase, "archived"); assert.equal(f.matrix.effects.filter(e => e.startsWith("create:")).length, 3);
	assert.ok((await readFile(join(f.directory, "archive", "archive-hierarchy.json"), "utf8")).includes(f.first.roomId));
});
