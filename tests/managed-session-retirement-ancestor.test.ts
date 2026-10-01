import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deriveConversationId, deriveGenerationId, deriveTranscriptEntryId, type ConversationManifest } from "../config/agent/extensions/managed-sessions/contracts.js";
import { retirementTargets } from "../config/agent/extensions/managed-sessions/relay/retirement-targets.js";
import { RetirementStore, retirementId, retirementEffectId, type RetirementRecord } from "../config/agent/extensions/managed-sessions/relay/retirement-store.js";
import { verifyRetirementAncestor } from "../config/agent/extensions/managed-sessions/relay/retirement-ancestor.js";

const hostId = "host"; const hostSpace = "!host:example.com"; const operatorUserId = "@operator:example.com"; const botUserId = "@bot:example.com";
function fixture() {
	const conversationId = deriveConversationId(hostId, "conversation");
	const manifest: ConversationManifest = { schemaVersion: "1.0.0", ownerHostId: hostId, kind: "project", conversationId, creationKey: "conversation", concept: "Title",
		piSessionId: "session", bindingBoundaryEntryId: deriveTranscriptEntryId("session", "boundary"), createdAt: "2026-10-01T00:00:00.000Z",
		roomId: "!conversation:example.com", projectSpace: "!project:example.com", checkoutSpace: "!checkout:example.com", projectKey: `project_${"a".repeat(32)}`, checkoutId: `checkout_${"b".repeat(32)}` };
	const targets = retirementTargets({ hostId, manifest, operatorUserId, botUserId, hostSpace, stop: { kind: "stop", generationId: deriveGenerationId(conversationId, 1) } });
	const id = retirementId(hostId, conversationId);
	const record: RetirementRecord = { version: 1, hostId, conversationId, creationKey: "conversation", retirementId: id, retiredAt: 1000,
		cleanup: targets.map((target) => ({ ...target, effectId: retirementEffectId(id, target), phase: "pending" })) };
	const checkout = record.cleanup!.find((effect) => effect.kind === "ancestor" && effect.spaceKind === "checkout_space")!;
	const project = record.cleanup!.find((effect) => effect.kind === "ancestor" && effect.spaceKind === "project_space")!;
	return { manifest, targets, record, checkout, project };
}

test("offline retirement persists only original ancestor targets across reconnect and changed discovery", async (t) => {
	const path = await mkdtemp(join(tmpdir(), "retirement-ancestor-")); t.after(() => rm(path, { recursive: true, force: true }));
	const f = fixture(); assert.equal(f.targets.length, 5);
	const store = new RetirementStore(path, hostId); await store.load(); await store.retire(f.record); await store.close();
	f.manifest.checkoutSpace = "!replacement:example.com"; f.manifest.projectSpace = "!other:example.com";
	const restored = new RetirementStore(path, hostId); await restored.load(); t.after(() => restored.close());
	assert.deepEqual(restored.get(f.record.conversationId), f.record);
	const rooms = restored.get(f.record.conversationId)!.cleanup!.flatMap((effect) => effect.kind === "ancestor" ? [effect.roomId] : []);
	assert.deepEqual(rooms, ["!checkout:example.com", "!project:example.com"]); assert.ok(!rooms.includes(hostSpace));
});

test("each ancestor attempt freshly checks exact provenance, authority, children, members and references", async () => {
	const f = fixture(); const calls: string[] = []; let children: string[] = []; let referenced = false; let foreignMember = false; let ownership = true;
	const input = { record: f.record, effectId: f.checkout.effectId, hostId, hostSpace,
		matrix: { botUserId, operatorUserId,
			assertManagedProvenance: async (roomId: string, proof: unknown) => { calls.push(`proof:${roomId}`); assert.deepEqual(proof, f.checkout.kind === "ancestor" ? f.checkout.provenance : undefined); if (!ownership) throw Error("Ownership changed"); },
			assertRoomAuthority: async () => { calls.push("authority"); }, spaceChildren: async () => { calls.push("children"); return children; },
			joinedMemberIds: async () => { calls.push("members"); return new Set([botUserId, operatorUserId, ...(foreignMember ? ["@guest:example.com"] : [])]); },
		}, hasReferences: async () => { calls.push("references"); return referenced; },
	};
	assert.ok(await verifyRetirementAncestor(input)); const first = [...calls]; calls.length = 0;
	referenced = true; assert.equal(await verifyRetirementAncestor(input), undefined); assert.deepEqual(calls, first); referenced = false;
	children = ["!foreign:example.com"]; assert.equal(await verifyRetirementAncestor(input), undefined);
	children = [f.manifest.roomId]; assert.equal(await verifyRetirementAncestor(input), undefined); assert.ok(await verifyRetirementAncestor({ ...input, allowRetiredChild: true }));
	children = []; foreignMember = true; assert.equal(await verifyRetirementAncestor(input), undefined); foreignMember = false;
	ownership = false; await assert.rejects(verifyRetirementAncestor(input), /Ownership changed/);
});

test("host Space, account changes, unknown effects and uncleared child Space cannot authorize ancestor cleanup", async () => {
	const f = fixture(); let checks = 0;
	const input = { record: f.record, effectId: f.checkout.effectId, hostId, hostSpace,
		matrix: { botUserId, operatorUserId, assertManagedProvenance: async () => { checks++; }, assertRoomAuthority: async () => undefined,
			spaceChildren: async () => [], joinedMemberIds: async () => new Set([botUserId, operatorUserId]) }, hasReferences: async () => false };
	assert.equal(await verifyRetirementAncestor({ ...input, hostSpace: f.manifest.checkoutSpace! }), undefined);
	assert.equal(await verifyRetirementAncestor({ ...input, effectId: "unknown" }), undefined);
	assert.equal(await verifyRetirementAncestor({ ...input, matrix: { ...input.matrix, operatorUserId: "@replacement:example.com" } }), undefined);
	assert.equal(await verifyRetirementAncestor({ ...input, effectId: f.project.effectId }), undefined); assert.equal(checks, 0);
	f.checkout.phase = "done"; assert.ok(await verifyRetirementAncestor({ ...input, effectId: f.project.effectId })); assert.equal(checks, 1);
});

test("legacy/unresolved ancestors are not discovered by name and conflicting IDs fail closed", () => {
	const f = fixture(); delete f.manifest.checkoutId;
	assert.equal(retirementTargets({ hostId, manifest: f.manifest, operatorUserId, botUserId, hostSpace,
		stop: { kind: "stop", generationId: deriveGenerationId(f.manifest.conversationId, 1) } }).length, 3);
	f.manifest.projectSpace = hostSpace;
	assert.throws(() => retirementTargets({ hostId, manifest: f.manifest, operatorUserId, botUserId, hostSpace,
		stop: { kind: "stop", generationId: deriveGenerationId(f.manifest.conversationId, 1) } }), /conflict/);
});
