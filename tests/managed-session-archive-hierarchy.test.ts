import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArchiveHostControls } from "../config/agent/extensions/managed-sessions/relay/archive-host-controls.js";
import { ArchiveRuntimeChecks } from "../config/agent/extensions/managed-sessions/relay/archive-runtime.js";
import { ManagedHostMutationOwner } from "../config/agent/extensions/managed-sessions/relay/host-mutation-owner.js";
import { prepareHostApproval, type ModelHostRequest } from "../config/agent/extensions/managed-sessions/relay/host-approval-record.js";
import { hostApprovalQuestion } from "../config/agent/extensions/managed-sessions/relay/host-approval-prompts.js";
import type { HostLifecycle } from "../config/agent/extensions/managed-sessions/relay/host-lifecycle.js";
import type { ConversationRetirement } from "../config/agent/extensions/managed-sessions/relay/conversation-retirement.js";
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
	const owner = async (runtime?: ArchiveRuntimeChecks) => {
		const value = new ArchiveHierarchy({ directory: join(directory, "archive"), registry, hierarchy, matrix: matrix as unknown as ManagedMatrixClient,
			assertRuntimeAbsent: async (source, signal, legacy) => { closureChecks++; if (closureError) throw Error("No fresh process-absence proof"); if (runtime) return runtime.inspect(source, legacy, signal); return { window: null, receipt: { basis: "operator_attested", windowDigest: "0".repeat(64), checkedAt: new Date().toISOString() } }; },
			account: { leaveAndForget: async target => { if (!accountReady) return false; matrix.members.get(target.roomId)!.delete(matrix.operatorUserId); return true; }, completed: async () => accountReady } });
		await value.load(); owners.push(value); return value;
	};
	t.after(async () => { for (const value of owners) await value.close(); await hierarchy.close(); await rm(directory, { recursive: true, force: true }); });
	matrix.effects = []; return { directory, registry, hierarchy, matrix, first, second, owner, closureChecks: () => closureChecks, setClosureError: (value = true) => { closureError = value; }, setAccountReady: (value: boolean) => { accountReady = value; } };
}

test("deleted checkout archives original room with admin Spaces; leaves live sibling and history intact", async t => {
	const f = await fixture(t, true); const owner = await f.owner(); const plan = await owner.preview(f.first.conversationId);
	assert.equal(f.matrix.effects.length, 0); assert.equal(f.registry.archiveRecord(f.first.conversationId), undefined);
	const result = await owner.apply((plan), true, `operation_${"a".repeat(32)}`); assert.equal(result?.phase, "archived"); assert.equal(f.closureChecks(), 2);
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
	f.matrix.fault = fault; await assert.rejects(owner.apply((plan), true, `operation_${"a".repeat(32)}`), /Injected/);
	assert.ok(f.registry.archiveRecord(f.first.conversationId)); await owner.close(); owner = await f.owner();
	assert.equal((await owner.apply((await owner.preview(f.first.conversationId)), true, `operation_${"a".repeat(32)}`))?.phase, "archived");
	assert.equal(f.matrix.effects.filter(e => e.startsWith("create:")).length, 3); assert.equal(f.closureChecks(), 3);
});

test("uncertain creation with no alias never allocates a replacement Space", async t => {
	const f = await fixture(t); let owner = await f.owner(); const plan = await owner.preview(f.first.conversationId);
	f.matrix.fault = "create"; await assert.rejects(owner.apply((plan), true, `operation_${"a".repeat(32)}`)); await owner.close(); owner = await f.owner(); f.matrix.absentAlias = true;
	await assert.rejects(owner.apply((plan), true, `operation_${"a".repeat(32)}`), /Uncertain archive creation/); assert.equal(f.matrix.effects.filter(e => e.startsWith("create:")).length, 1);
});

test("no process-absence proof or changed original link prevents admission and Matrix effects", async t => {
	const f = await fixture(t); const owner = await f.owner(); const plan = await owner.preview(f.first.conversationId); f.setClosureError();
	await assert.rejects(owner.apply((plan), true, `operation_${"a".repeat(32)}`), /process-absence/); assert.equal(f.registry.archiveRecord(f.first.conversationId), undefined); assert.deepEqual(f.matrix.effects, []);
	f.setClosureError(false); f.matrix.children.get(f.first.checkoutSpace!)!.set(f.first.roomId, { via: ["example.com"], order: "operator-change" });
	await assert.rejects(owner.apply((plan), true, `operation_${"a".repeat(32)}`), /changed/); assert.equal(f.registry.archiveRecord(f.first.conversationId), undefined);
});

test("existing missing operator membership is a blocker, not permission to restore it", async t => {
	const f = await fixture(t); const owner = await f.owner(); f.matrix.members.get(f.first.roomId)!.delete(f.matrix.operatorUserId);
	await assert.rejects(owner.preview(f.first.conversationId), /existing operator membership/); assert.deepEqual(f.matrix.effects, []);
});

test("pending joins to new archive Spaces preserve original links until readable", async t => {
	const f = await fixture(t); const owner = await f.owner(); const plan = await owner.preview(f.first.conversationId); f.matrix.autoJoin = false;
	assert.equal((await owner.apply((plan), true, `operation_${"a".repeat(32)}`))?.phase, "archiving"); assert.deepEqual(await f.matrix.spaceChildren(f.first.checkoutSpace!), [f.first.roomId]);
	for (const room of owner.status(f.first.conversationId)!.archiveSpaces) f.matrix.members.get(room)!.add(f.matrix.operatorUserId);
	assert.equal((await owner.apply((plan), true, `operation_${"a".repeat(32)}`))?.phase, "archived"); assert.equal(f.matrix.effects.filter(e => e.startsWith("create:")).length, 3);
});

test("archive survives account cleanup outage; exact empty ancestors can be retried separately", async t => {
	const f = await fixture(t); const owner = await f.owner(); await owner.apply((await owner.preview(f.first.conversationId)), true, `operation_${"a".repeat(32)}`);
	f.setAccountReady(false); const pending = await owner.cleanup(f.first.conversationId); assert.equal(pending?.phase, "archived"); assert.ok(pending!.cleanupPending > 0);
	assert.ok(await f.matrix.memberJoined(f.first.roomId, f.matrix.operatorUserId));
	f.setAccountReady(true); const done = await owner.cleanup(f.first.conversationId); assert.equal(done?.cleanupPending, 0);
	assert.deepEqual(f.matrix.effects.filter(e => e.startsWith("leave:")).sort(), [`leave:${f.first.checkoutSpace}`, `leave:${f.first.projectSpace}`].sort());
	assert.ok(await f.matrix.memberJoined(f.first.roomId, f.matrix.botUserId));
});

test("lost cleanup departure cannot infer fresh emptiness after an external change", async t => {
	const f = await fixture(t); const owner = await f.owner(); await owner.apply((await owner.preview(f.first.conversationId)), true, `operation_${"a".repeat(32)}`);
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
	await owner.apply((plan), true, `operation_${"a".repeat(32)}`); f.matrix.children.get(f.first.checkoutSpace!)!.set("!unrelated:example.com", { via: ["example.com"] });
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
	await assert.rejects(owner.apply((plan), true, `operation_${"a".repeat(32)}`), /path is no longer readable/);
	assert.deepEqual(await f.matrix.spaceChildren(f.first.checkoutSpace!), [f.first.roomId]); assert.ok(!f.matrix.effects.some(e => e.startsWith("unlink:")));
});

test("shared checkout archives reuse the same Spaces and clean ancestors exactly once", async t => {
	const f = await fixture(t, true); const owner = await f.owner(); const a = await owner.preview(f.first.conversationId), b = await owner.preview(f.second.conversationId);
	await Promise.all([owner.apply((a), true, `operation_${"a".repeat(32)}`), owner.apply((b), true, `operation_${"a".repeat(32)}`)]);
	assert.equal(f.matrix.effects.filter(e => e.startsWith("create:")).length, 3);
	assert.deepEqual(owner.status(f.first.conversationId)?.archiveSpaces, owner.status(f.second.conversationId)?.archiveSpaces);
	await owner.cleanup(f.first.conversationId); await owner.cleanup(f.second.conversationId);
	assert.equal(f.matrix.effects.filter(e => e.startsWith("leave:")).length, 2);
});

test("unpublished reservations and legacy saved identity remain independent of checkout existence", async t => {
	const f = await fixture(t); const owner = await f.owner(); const plan = await owner.preview(f.first.conversationId);
	const legacy = structuredClone(plan.source); delete legacy.checkoutId;
	assert.equal(historicalCheckoutId("host", legacy), historicalCheckoutId("host", { ...legacy, title: "renamed", placement: { ...legacy.placement, relativeCwd: "subdir" } }));
	await owner.apply((plan), true, `operation_${"a".repeat(32)}`);
	await f.hierarchy.prepare({ creationKey: "new-reservation", projectKey: plan.source.projectKey, canonicalCheckoutRoot: "/never/existed/deleted-worktree", projectTitle: "historical-project", checkoutTitle: "deleted-worktree", conversationTitle: "new" });
	assert.ok((await owner.cleanup(f.first.conversationId))!.preservedSpaces.includes(f.first.checkoutSpace!)); assert.equal(f.matrix.effects.filter(e => e.startsWith("leave:")).length, 0);
});

test("missing archive hierarchy journal cannot reallocate after durable admission", async t => {
	const f = await fixture(t); const owner = await f.owner(); await owner.apply((await owner.preview(f.first.conversationId)), true, `operation_${"a".repeat(32)}`); await owner.close();
	await rm(join(f.directory, "archive", "archive-hierarchy.json")); await assert.rejects(f.owner(), /journal is missing/);
	assert.ok(f.registry.archiveRecord(f.first.conversationId));
});

test("NAS validates the archive parent chain and rejects cross-kind or substituted roots", async t => {
	const f = await fixture(t); const owner = await f.owner(); await owner.apply((await owner.preview(f.first.conversationId)), true, `operation_${"a".repeat(32)}`);
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

test("archive host controls require independent disclosed legacy consent, revalidate, and retain the receipt", async t => {
	const f = await fixture(t); let observation = { conflicts: false, bootId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", unreadableProcesses: [] as string[] }; let now = 1000;
	const runtime = new ArchiveRuntimeChecks({ registry: f.registry, attached: () => false, exact: { check: async () => "gone", inspect: async () => undefined }, observeLegacy: async () => observation });
	const hierarchy = await f.owner(runtime); const controls = new ArchiveHostControls({ registry: f.registry, hierarchy, runtime });
	const owner = new ManagedHostMutationOwner({ registry: f.registry, lifecycle: {} as HostLifecycle, retirement: {} as ConversationRetirement, server: { attachment: () => undefined }, archives: controls, now: () => now });
	const strict = await owner.preview({ operation: "conversation.archive.preview", conversationIds: [f.first.conversationId] }); assert.match(strict.blockers.join(), /No exact exit evidence/);
	const preview = await owner.preview({ operation: "conversation.archive.preview", conversationIds: [f.first.conversationId], legacyClosure: true }); assert.deepEqual(preview.blockers, []);
	assert.match(preview.warnings!.join(), /NOT verified process exit/); assert.deepEqual(f.matrix.effects, []);
	const input: ModelHostRequest = { version: "1.0.0", actor: { kind: "model", conversationId: f.second.conversationId, generationId: `generation_${"a".repeat(32)}`, requestId: "archive-request", runId: "run", toolCallId: "tool", presentation: "local_dialog" }, action: { operation: "conversation.archive.apply", previewId: preview.previewId, confirmed: true } };
	const record = prepareHostApproval("host", input, await owner.freeze(input), now);
	assert.match(hostApprovalQuestion(record), /LEGACY ATTESTATION/); await assert.rejects(owner.executeHuman(input), /independent consent/);
	observation.unreadableProcesses = ["123"]; assert.equal(await owner.revalidate(record), false); await assert.rejects(owner.execute(record), /changed or expired/); assert.equal(f.registry.archiveRecords().length, 0);
	observation.unreadableProcesses = []; now = Date.parse(preview.expiresAt) + 1; assert.equal(await owner.revalidate(record), false);
	const fresh = await owner.preview({ operation: "conversation.archive.preview", conversationIds: [f.first.conversationId], legacyClosure: true });
	const next = { ...input, action: { ...input.action, previewId: fresh.previewId } } as ModelHostRequest;
	const approved = prepareHostApproval("host", next, await owner.freeze(next), now); await owner.execute(approved);
	assert.equal(controls.list({ operation: "conversation.archive.list" }).items[0]!.closureBasis, "operator_attested");
	assert.ok(!f.registry.listConversations().some(c => c.conversationId === f.first.conversationId));
	const journal = JSON.parse(await readFile(join(f.directory, "archive", "archive-hierarchy.json"), "utf8"));
	assert.equal(journal.entries[0].closure.operationId, `operation_${approved.approvalId.slice("approval_".length)}`);
	const cleanup = await owner.preview({ operation: "conversation.archive.cleanup.preview", conversationIds: [f.first.conversationId] });
	await assert.rejects(owner.freeze({ action: { operation: "conversation.archive.apply", previewId: cleanup.previewId, confirmed: true } }), /changed or expired/);
});

test("archive runtime distinguishes exact exit from live, changed, replacement or incomplete legacy evidence", async t => {
	const f = await fixture(t); const id = f.first.conversationId; const source = f.registry.archiveCandidate(id).source;
	let attached = false; let state: "gone" | "match" | "changed" = "gone"; let replacement = false; let observed = 0;
	const proof = { conversationId: id, launchId: `launch_${"a".repeat(32)}`, serverId: `123:456:${"a".repeat(32)}`, sessionName: "project", windowId: "@1", paneId: "%1", panePid: "789", processBootId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", processStartTicks: "123" };
	await f.registry.setManagedWindow(id, { sessionName: "project", windowId: "@1", paneId: "%1", ownership: proof });
	const runtime = new ArchiveRuntimeChecks({ registry: f.registry, attached: () => attached, exact: { check: async () => state, inspect: async () => replacement ? proof : undefined }, observeLegacy: async () => { observed++; return {}; } });
	assert.equal((await runtime.inspect(source)).receipt.basis, "exact_exit"); assert.equal(observed, 0);
	for (const value of ["match", "changed"] as const) { state = value; await assert.rejects(runtime.inspect(source, true), /conflicting or unverified/); }
	state = "gone"; replacement = true; await assert.rejects(runtime.inspect(source), /conflicting or unverified/);
	replacement = false; attached = true; await assert.rejects(runtime.inspect(source), /running conversation/); attached = false;
	const hierarchy = await f.owner(runtime); const plan = await hierarchy.preview(id, (await runtime.inspect(source)).window);
	assert.equal((await hierarchy.apply(plan))?.phase, "archived"); assert.equal(hierarchy.status(id)?.closureBasis, "exact_exit");
});

test("legacy controls never waive unfinished work or archive the protected coordinator", async t => {
	const f = await fixture(t); const runtime = new ArchiveRuntimeChecks({ registry: f.registry, attached: () => false, exact: { check: async () => "gone", inspect: async () => undefined },
		observeLegacy: async () => ({ conflicts: false, unreadableProcesses: [], bootId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" }) });
	const hierarchy = await f.owner(runtime); const controls = new ArchiveHostControls({ registry: f.registry, hierarchy, runtime });
	const blocked = await controls.snapshot({ operation: "conversation.archive.preview", conversationIds: [deriveConversationId("host", "coordinator")], legacyClosure: true }); assert.match(blocked.blockers.join(), /protected coordinator/);
	await f.registry.beginLaunch(f.first.conversationId);
	const pending = await controls.snapshot({ operation: "conversation.archive.preview", conversationIds: [f.first.conversationId], legacyClosure: true });
	assert.ok(pending.blockers.length); assert.equal(await controls.valid(pending), false); assert.equal(f.registry.archiveRecords().length, 0); assert.deepEqual(f.matrix.effects, []);
});

test("effect-free unadmitted drafts require fresh consent but can replan changed source links", async t => {
	const f = await fixture(t); let checks = 0;
	const runtime = new ArchiveRuntimeChecks({ registry: f.registry, attached: () => false, exact: { check: async () => "gone", inspect: async () => undefined },
		observeLegacy: async () => { checks++; if (checks === 2) throw Error("temporary inspection failure"); return { conflicts: false, unreadableProcesses: [], bootId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" }; } });
	const owner = await f.owner(runtime); const before = await owner.preview(f.first.conversationId);
	await assert.rejects(owner.apply(before, true, `operation_${"b".repeat(32)}`), /inspection unavailable/);
	assert.equal(owner.status(f.first.conversationId)?.phase, "reserved"); assert.equal(f.registry.archiveRecords().length, 0); assert.deepEqual(f.matrix.effects, []);
	f.matrix.children.get(f.first.checkoutSpace!)!.set(f.first.roomId, { via: ["example.com"], order: "new order" });
	const after = await owner.preview(f.first.conversationId); assert.notDeepEqual(before, after);
	await assert.rejects(owner.apply(before, true, `operation_${"c".repeat(32)}`), /changed/);
	assert.equal((await owner.apply(after, true, `operation_${"d".repeat(32)}`))?.phase, "archived");
});

test("admitted legacy retries require fresh complete inspection and retain original audit evidence", async t => {
	const f = await fixture(t); let observation = { conflicts: false, unreadableProcesses: [] as string[], bootId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" };
	const runtime = new ArchiveRuntimeChecks({ registry: f.registry, attached: () => false, exact: { check: async () => "gone", inspect: async () => undefined }, observeLegacy: async () => observation });
	let owner = await f.owner(runtime); const plan = await owner.preview(f.first.conversationId); f.matrix.autoJoin = false;
	const original = `operation_${"a".repeat(32)}`, retry = `operation_${"b".repeat(32)}`;
	assert.equal((await owner.apply(plan, true, original))?.phase, "archiving"); await owner.close(); owner = await f.owner(runtime);
	const controls = new ArchiveHostControls({ registry: f.registry, hierarchy: owner, runtime }); const effects = [...f.matrix.effects];
	for (const problem of [{ conflicts: true, unreadableProcesses: [] }, { conflicts: false, unreadableProcesses: ["123"] }]) {
		observation = { ...observation, ...problem };
		assert.ok((await controls.snapshot({ operation: "conversation.archive.preview", conversationIds: [f.first.conversationId], legacyClosure: true })).blockers.length);
		await assert.rejects(owner.apply(plan, true, retry), /conflicting or incomplete/); assert.deepEqual(f.matrix.effects, effects);
	}
	observation = { ...observation, conflicts: false, unreadableProcesses: [] };
	assert.ok((await controls.snapshot({ operation: "conversation.archive.preview", conversationIds: [f.first.conversationId] })).blockers.length);
	for (const room of owner.status(f.first.conversationId)!.archiveSpaces) f.matrix.members.get(room)!.add(f.matrix.operatorUserId);
	assert.equal((await owner.apply(plan, true, retry))?.phase, "archived");
	const saved = JSON.parse(await readFile(join(f.directory, "archive", "archive-hierarchy.json"), "utf8"));
	assert.equal(saved.entries[0].closure.operationId, original); assert.equal(saved.entries[0].lastInspection.operationId, retry);
});

test("uncertain local journal writes poison the owner and never roll back an accepted create", async t => {
	const f = await fixture(t); let owner = await f.owner(); const plan = await owner.preview(f.first.conversationId); const original = AtomicJsonFile.prototype.write;
	AtomicJsonFile.prototype.write = async function (value: unknown) {
		await original.call(this, value);
		if (this.path.endsWith("archive-hierarchy.json") && f.matrix.effects.some(e => e.startsWith("create:"))) throw Error("Injected post-rename");
	};
	try { await assert.rejects(owner.apply((plan), true, `operation_${"a".repeat(32)}`), /Injected/); } finally { AtomicJsonFile.prototype.write = original; }
	assert.throws(() => owner.status(f.first.conversationId), /unavailable/); await owner.close(); owner = await f.owner();
	assert.equal((await owner.apply((plan), true, `operation_${"a".repeat(32)}`))?.phase, "archived"); assert.equal(f.matrix.effects.filter(e => e.startsWith("create:")).length, 3);
	assert.ok((await readFile(join(f.directory, "archive", "archive-hierarchy.json"), "utf8")).includes(f.first.roomId));
});
