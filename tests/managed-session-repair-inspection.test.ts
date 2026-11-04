import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ConversationRepairInspection } from "../config/agent/extensions/managed-sessions/relay/conversation-repair-inspection.js";
import { RelayRegistry } from "../config/agent/extensions/managed-sessions/relay/registry.js";
import { ConversationManifestStore } from "../config/agent/extensions/managed-sessions/relay/manifest-store.js";
import { HostReadModel } from "../config/agent/extensions/managed-sessions/relay/host-read-model.js";
import { managedHostAction, managedHostHelp } from "../config/agent/extensions/managed-sessions/host-tool.js";
import { roomHostCommand } from "../config/agent/extensions/managed-sessions/host-command.js";
import { hostActionPolicy, parseHostResponse, HOST_CONTROL_VERSION } from "../config/agent/extensions/managed-sessions/live-workspace-contracts.js";
import { deriveConversationId, deriveDeliveryId, deriveTranscriptEntryId, type ConversationManifest } from "../config/agent/extensions/managed-sessions/contracts.js";

async function fixture(t: { after(fn: () => Promise<void>): void }, kind: "project" | "coordinator" = "project") {
	const root = await mkdtemp(join(tmpdir(), "repair-inspect-")); t.after(() => rm(root, { recursive: true, force: true }));
	const manifests = new ConversationManifestStore(join(root, "manifests"));
	const id = deriveConversationId("host", kind);
	const manifest: ConversationManifest = { schemaVersion: "1.0.0", ownerHostId: "host", kind, conversationId: id,
		creationKey: kind, concept: kind, piSessionId: "PRIVATE-SAVED-SESSION", roomId: "!original:example.com",
		...(kind === "project" ? { placement: { rootKey: "projects", workspace: "example", relativeCwd: "" } } : {}),
		bindingBoundaryEntryId: deriveTranscriptEntryId("PRIVATE-SAVED-SESSION", "boundary"), createdAt: "2026-10-01T00:00:00.000Z" };
	await manifests.write(manifest);
	const registry = new RelayRegistry("host", join(root, "runtime"), manifests); await registry.load();
	const options: ConstructorParameters<typeof ConversationRepairInspection>[0] = { registry, matrixReady: () => true,
		accountSetup: () => "ready", membership: async roomId => { assert.equal(roomId, manifest.roomId); return "join"; } };
	const inspect = async () => {
		const data = await new ConversationRepairInspection(options).inspect(id);
		const response = parseHostResponse("conversation.repair.inspect", { version: HOST_CONTROL_VERSION, requestId: "inspection", ok: true, data });
		assert.ok(response.ok); assert.equal(data.readiness, "not_verified");
		assert.ok(!JSON.stringify(data).includes("PRIVATE")); return data;
	};
	return { id, root, registry, options, inspect, manifests, manifest };
}

test("unobserved project launches retain their reservations, session and input; inspection performs no writes", async t => {
	const f = await fixture(t);
	await f.registry.recordAcceptedInput(f.id, { deliveryId: deriveDeliveryId(f.id, "$input"), matrixEventId: "$input", kind: "prompt", body: "PRIVATE PROMPT", status: "accepted" });
	await f.registry.prepareProjectLaunch(f.id, "n".repeat(64)); await f.registry.failLaunch(f.id);
	const facts = f.registry.repairRuntimeFacts(f.id)!;
	assert.deepEqual(Object.keys(facts).sort(), ["attached", "legacyWindow", "lifecycleObligations", "queues", "repairHeld", "state", "unobservedLaunch"]);
	assert.deepEqual(facts.queues, { inputs: 1, controls: 0, outputs: 0 });
	assert.ok(!JSON.stringify(facts).includes("PRIVATE"));
	facts.queues.inputs = 999;
	assert.equal(f.registry.repairRuntimeFacts(f.id)!.queues.inputs, 1, "projection is detached from registry state");
	f.registry.conversationSnapshot = () => assert.fail("inspection must not read full payload-bearing runtime snapshots");
	const before = await readFile(join(f.root, "runtime", "registry.json"));
	for (let i = 0; i < 2; i++) {
		const data = await f.inspect(); assert.equal(data.authority, "live"); if (data.authority !== "live") return;
		assert.equal(data.runtime, "unobserved_launch"); assert.deepEqual(data.queues, { inputs: 1, controls: 0, outputs: 0 });
		assert.ok(data.findings.some(f => f.code === "unobserved_launch")); assert.ok(data.findings.some(f => f.code === "queued_work"));
	}
	assert.deepEqual(await readFile(join(f.root, "runtime", "registry.json")), before);
	assert.deepEqual(await f.manifests.list(), [f.manifest]);
});

test("coordinator legacy ownership is inspectable without granting destructive authority", async t => {
	const f = await fixture(t, "coordinator");
	await f.registry.setManagedWindow(f.id, { sessionName: "default", windowId: "@19", paneId: "%23" });
	const data = await f.inspect(); assert.equal(data.authority, "live"); if (data.authority !== "live") return;
	assert.equal(data.kind, "coordinator"); assert.equal(data.runtime, "legacy_ownership");
	assert.ok(!JSON.stringify(data).includes("@19"));
	const actor = { kind: "human_local" as const, requestId: "operator" };
	assert.equal(hostActionPolicy({ operation: "conversation.repair.inspect", conversationId: f.id }, actor, f.id), "direct");
	assert.equal(hostActionPolicy({ operation: "conversation.stop", conversationId: f.id }, actor, f.id), "forbidden");
	assert.equal(hostActionPolicy({ operation: "conversation.delete", conversationId: f.id, confirmed: true }, actor, f.id), "forbidden");
});

test("dormant output backlog is explicit, not silently replayed or counted as readiness", async t => {
	const f = await fixture(t);
	await f.registry.recordProjection(f.id, { entryId: deriveTranscriptEntryId(f.manifest.piSessionId, "PRIVATE-OUTPUT"), kind: "notice", status: "projecting", chunks: [] });
	const data = await f.inspect(); if (data.authority !== "live") assert.fail();
	assert.equal(data.runtime, "dormant"); assert.equal(data.queues?.outputs, 1);
	assert.ok(data.findings.some(f => f.code === "queued_work"));
	assert.equal(f.registry.conversationSnapshot(f.id)!.projection[0].status, "projecting");
});

test("membership observations distinguish both inaccessible rooms, invitation, ban and unknown despite cached ready setup", async t => {
	const f = await fixture(t);
	for (const [membership, code] of [["leave", "membership_restore_required"], ["invite", "membership_invitation_pending"], ["knock", "membership_invitation_pending"], ["ban", "membership_banned"], ["unknown", "membership_unknown"]] as const) {
		f.options.membership = async () => membership;
		const data = await f.inspect(); if (data.authority !== "live") assert.fail();
		assert.equal(data.membership, membership); assert.equal(data.setupState, "ready");
		assert.ok(data.findings.some(f => f.code === code));
	}
	f.options.membership = async () => { throw Error("PRIVATE SERVER RESPONSE"); };
	const failed = await f.inspect(); if (failed.authority !== "live") assert.fail(); assert.equal(failed.membership, "unknown");
	f.options.matrixReady = () => false;
	f.options.membership = async () => assert.fail("offline inspection must not perform network I/O");
	const offline = await f.inspect(); if (offline.authority !== "live") assert.fail();
	assert.equal(offline.setupState, "disconnected"); assert.ok(offline.findings.some(f => f.code === "matrix_disconnected"));
});

test("missing runtime is unknown with unknown queue counts; a live attachment is not verified readiness or idle", async t => {
	const f = await fixture(t); const facts = f.registry.repairRuntimeFacts(f.id)!;
	f.options.registry = { retirement: () => undefined, archiveRecord: () => undefined,
		registeredConversation: () => f.manifest, activeGeneration: m => f.registry.activeGeneration(m),
		repairRuntimeFacts: () => undefined };
	let data = await f.inspect(); if (data.authority !== "live") assert.fail();
	assert.equal(data.runtime, "unknown"); assert.equal(data.queues, null);
	f.options.registry.repairRuntimeFacts = () => ({ ...facts, attached: true });
	data = await f.inspect(); if (data.authority !== "live") assert.fail();
	assert.equal(data.runtime, "attached"); assert.equal(data.readiness, "not_verified");
	f.options.registry.repairRuntimeFacts = () => ({ ...facts, attached: true, lifecycleObligations: true });
	assert.ok((await f.inspect()).findings.some(f => f.code === "lifecycle_obligations"));
});

test("terminal authority short-circuits all other reads and wins after awaited membership I/O", async t => {
	for (const authority of ["retired", "archived"] as const) {
		const f = await fixture(t);
		let terminal = false;
		// Only presence is consumed at this read-only seam; no receipts escape it.
		const guarded = new Proxy(f.registry, { get(target, key) {
			if (key === "retirement" || key === "archiveRecord") return () => terminal && (key === "retirement") === (authority === "retired") ? {} : undefined;
			const value = Reflect.get(target, key);
			return typeof value === "function" ? (...args: unknown[]) => { assert.equal(terminal, false, "terminal state forbids ordinary reads"); return value.apply(target, args); } : value;
		} });
		f.options.registry = guarded;
		f.options.membership = async () => { terminal = true; return "join"; };
		assert.equal((await f.inspect()).authority, authority);
		f.options.membership = async () => assert.fail("terminal inspection must not contact Matrix");
		assert.equal((await f.inspect()).authority, authority);
	}
});

test("read model, tool and command use the same inspect contract; capability needs a wired reader", async t => {
	const f = await fixture(t); const repairInspection = new ConversationRepairInspection(f.options);
	const model = new HostReadModel({ hostId: "host", registry: f.registry, repairInspection, matrixReady: () => true });
	const action = { operation: "conversation.repair.inspect" as const, conversationId: f.id };
	assert.deepEqual(managedHostAction(action), action); assert.ok(managedHostHelp().includes(action.operation));
	assert.deepEqual(roomHostCommand(`!host conversation repair inspect ${f.id}`, f.id), action);
	const request = { version: HOST_CONTROL_VERSION, actor: { kind: "human_local" as const, requestId: "read" }, action };
	assert.deepEqual(await model.read(request), await f.inspect());
	const status = await model.read({ ...request, action: { operation: "host.status" } }) as { capabilities: string[] };
	assert.ok(status.capabilities.includes("repair-inspection-v1"));
	const unavailable = new HostReadModel({ hostId: "host", registry: f.registry, matrixReady: () => true });
	await assert.rejects(unavailable.read(request), { code: "upgrade_required" });
	const result = await unavailable.read({ ...request, action: { operation: "host.status" } }) as { capabilities: string[] };
	assert.ok(!result.capabilities.includes("repair-inspection-v1"));
	assert.throws(() => managedHostAction({ ...action, confirmed: true }));
});
