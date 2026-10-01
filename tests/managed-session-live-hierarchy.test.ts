import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LiveHierarchy, type HierarchyPlacement } from "../config/agent/extensions/managed-sessions/relay/live-hierarchy.js";
import { managedRoomAlias, type ManagedProvenance } from "../config/agent/extensions/managed-sessions/managed-provenance.js";
import { deriveConversationId, deriveTranscriptEntryId, MANAGED_SESSION_STATE_VERSION, type ConversationManifest } from "../config/agent/extensions/managed-sessions/contracts.js";

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
