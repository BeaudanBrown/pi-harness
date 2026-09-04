import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MANAGED_SESSION_STATE_VERSION, deriveConversationId, deriveTranscriptEntryId } from "../config/agent/extensions/managed-sessions/contracts.js";
import { MANAGED_SESSION_V2_VERSION, deriveGenerationId, migrateV1Bundle, migrateV1Manifest, parseConversationManifestV2, parseManagedSessionV2Envelope } from "../config/agent/extensions/managed-sessions/v2-contracts.js";
import { migrateManagedSessionStoresV1ToV2 } from "../config/agent/extensions/managed-sessions/relay/v2-migration.js";
const conversationId = deriveConversationId("host", "work");
const old = { schemaVersion: MANAGED_SESSION_STATE_VERSION, kind: "project", conversationId, ownerHostId: "host", creationKey: "work", concept: "work", piSessionId: "session-1", roomId: "!room:example", placement: { rootKey: "projects", workspace: "repo", relativeCwd: "" }, bindingBoundaryEntryId: deriveTranscriptEntryId("session-1", "boundary"), createdAt: "2026-01-01T00:00:00.000Z" };
test("v1 manifest migrates deterministically to generation one", () => { const a = migrateV1Manifest(old); const b = migrateV1Manifest(old); assert.deepEqual(a, b); assert.equal(a.roomId, old.roomId); assert.equal(a.generations[0]?.piSessionId, old.piSessionId); assert.equal(a.activeGenerationId, deriveGenerationId(conversationId, 1)); });
test("migration preserves complete host-resolved project grouping identity without inferring legacy rooms", () => {
	const grouped = { ...old, projectKey: `project_${"a".repeat(32)}`, projectDisplayName: "repo", checkoutDisplayName: "repo-feature", projectSpace: "!space:example" };
	const migrated = migrateV1Manifest(grouped); assert.deepEqual({ key: migrated.projectKey, project: migrated.projectDisplayName, checkout: migrated.checkoutDisplayName, space: migrated.projectSpace },
		{ key: grouped.projectKey, project: grouped.projectDisplayName, checkout: grouped.checkoutDisplayName, space: grouped.projectSpace });
	assert.equal(migrateV1Manifest(old).projectKey, undefined, "legacy rooms remain ungrouped until explicit #68 reconciliation");
});
test("generation manifest rejects old fields and impossible active generations", () => { const value = migrateV1Manifest(old); assert.throws(() => parseConversationManifestV2({ ...value, piSessionId: "legacy" })); assert.throws(() => parseConversationManifestV2({ ...value, activeGenerationId: deriveGenerationId(conversationId, 2) }), /newest/); assert.throws(() => parseConversationManifestV2({ ...value, generations: [{ ...value.generations[0]!, generationId: deriveGenerationId(conversationId, 2) }] }), /generation/); assert.throws(() => parseConversationManifestV2({ ...value, activeGenerationId: deriveGenerationId(conversationId, 2), generations: [value.generations[0]!, { ...value.generations[0]!, ordinal: 2, generationId: deriveGenerationId(conversationId, 2) }] }), /generation/); });
test("migration preserves append-only compatibility generations and selected runtime metadata", () => {
	const secondSession = "session-2"; const activeGenerationId = deriveGenerationId(conversationId, 2);
	const compatibility = { ...old, piSessionId: secondSession, bindingBoundaryEntryId: deriveTranscriptEntryId(secondSession, "boundary-2"), selectedModel: "local-llm/current", activeGenerationId,
		generations: [{ generationId: deriveGenerationId(conversationId, 1), ordinal: 1, piSessionId: old.piSessionId, bindingBoundaryEntryId: old.bindingBoundaryEntryId, createdAt: old.createdAt },
			{ generationId: activeGenerationId, ordinal: 2, piSessionId: secondSession, bindingBoundaryEntryId: deriveTranscriptEntryId(secondSession, "boundary-2"), createdAt: old.createdAt, model: "scoped/model", thinking: "high" }] };
	const migrated = migrateV1Manifest(compatibility);
	assert.deepEqual(migrated.generations, compatibility.generations); assert.equal(migrated.activeGenerationId, activeGenerationId);
	assert.equal(migrated.selectedModel, "local-llm/current", "migration preserves the current preference without rewriting generation history");
});
test("v2 operations are role-strict and reject extra fields", () => { const value = { protocolVersion: MANAGED_SESSION_V2_VERSION, messageId: "m1", conversationId, role: "relay", type: "control.deliver", payload: { controlId: `control_${"a".repeat(32)}`, name: "status" } }; assert.deepEqual(parseManagedSessionV2Envelope(value), value); assert.throws(() => parseManagedSessionV2Envelope({ ...value, role: "ordinary_adapter" })); assert.throws(() => parseManagedSessionV2Envelope({ ...value, payload: { ...value.payload, command: "pwd" } })); });
test("v2 ordinary generation authorization metadata remains role-strict", () => {
	const value = { protocolVersion: MANAGED_SESSION_V2_VERSION, messageId: "generation-control", conversationId, role: "ordinary_adapter", type: "control.result",
		payload: { controlId: `control_${"c".repeat(32)}`, status: "ok", message: "authorized", generation: { model: "scoped/model", thinking: "high" } } };
	assert.deepEqual(parseManagedSessionV2Envelope(value), value);
	assert.throws(() => parseManagedSessionV2Envelope({ ...value, role: "coordinator_adapter" }));
	assert.throws(() => parseManagedSessionV2Envelope({ ...value, payload: { ...value.payload, status: "rejected" } }), /accepted ordinary/);
	assert.throws(() => parseManagedSessionV2Envelope({ ...value, payload: { ...value.payload, options: ["one"] } }), /without options/);
});

test("v2 ordinary model selection metadata remains role-strict", () => {
	const value = { protocolVersion: MANAGED_SESSION_V2_VERSION, messageId: "model-control", conversationId, role: "ordinary_adapter", type: "control.result",
		payload: { controlId: `control_${"d".repeat(32)}`, status: "ok", message: "selected", selection: { model: "local-llm/qwen" } } };
	assert.deepEqual(parseManagedSessionV2Envelope(value), value);
	assert.deepEqual(parseManagedSessionV2Envelope({ ...value, role: "coordinator_adapter" }), { ...value, role: "coordinator_adapter" });
	assert.throws(() => parseManagedSessionV2Envelope({ ...value, role: "relay" }));
	assert.throws(() => parseManagedSessionV2Envelope({ ...value, payload: { ...value.payload, status: "rejected" } }), /selection metadata/);
	assert.throws(() => parseManagedSessionV2Envelope({ ...value, payload: { ...value.payload, options: ["one"] } }), /selection metadata/);
	assert.throws(() => parseManagedSessionV2Envelope({ ...value, payload: { ...value.payload, generation: { model: "other/model" } } }), /selection metadata/);
});

test("activity snapshots require collapsed names and balanced measured totals", () => {
	const base = { protocolVersion: MANAGED_SESSION_V2_VERSION, messageId: "activity", conversationId, role: "ordinary_adapter", type: "activity.finalize" };
	const payload = { activityId: `activity_${"a".repeat(32)}`, revision: 2, outcome: "completed", context: { usedTokens: 60, remainingTokens: 40, limitTokens: 100, deltaTokens: 10 }, run: { inputTokens: 10, outputTokens: 5, modelTurns: 1 }, tools: { total: 2, errors: 1, counts: [{ name: "read", count: 2 }] } };
	assert.deepEqual(parseManagedSessionV2Envelope({ ...base, payload }), { ...base, payload });
	assert.throws(() => parseManagedSessionV2Envelope({ ...base, payload: { ...payload, context: { ...payload.context, remainingTokens: 41 } } }), /balanced/);
	assert.throws(() => parseManagedSessionV2Envelope({ ...base, payload: { ...payload, tools: { ...payload.tools, total: 3 } } }), /balanced/);
	const update = { ...base, type: "activity.update", payload: { activityId: payload.activityId, revision: 1, state: "tool", tools: [{ name: "bash", state: "running", count: 1 }, { name: "bash", state: "completed", count: 1 }] } };
	assert.throws(() => parseManagedSessionV2Envelope(update), /unique collapsed/);
});
test("bundle migration fails closed when registry is partial", () => { const runtime = { schemaVersion: MANAGED_SESSION_STATE_VERSION, hostId: "host", conversations: [] }; assert.throws(() => migrateV1Bundle([old], runtime), /runtime conversations and synchronized manifests do not match exactly/); });

test("store migration atomically commits deterministic v2 destinations and forbids downgrade", async () => {
	const root = await mkdtemp(join(tmpdir(), "managed-v2-migration-"));
	const manifests = join(root, "manifests");
	const runtimeFile = join(root, "runtime", "registry.json");
	await mkdir(manifests, { recursive: true }); await mkdir(join(root, "runtime"), { recursive: true });
	await writeFile(join(manifests, `${conversationId}.json`), JSON.stringify(old));
	const conversation = { conversationId, state: "dormant", attachment: null, matrixCursor: { status: "bootstrap" }, pendingInputs: [], projection: [], managedWindow: null };
	await writeFile(runtimeFile, JSON.stringify({ schemaVersion: MANAGED_SESSION_STATE_VERSION, hostId: "host", conversations: [conversation] }));
	await migrateManagedSessionStoresV1ToV2(runtimeFile, manifests);
	const manifest = JSON.parse(await readFile(join(manifests, `${conversationId}.json`), "utf8"));
	const runtime = JSON.parse(await readFile(runtimeFile, "utf8"));
	assert.equal(manifest.schemaVersion, MANAGED_SESSION_V2_VERSION); assert.equal(runtime.schemaVersion, MANAGED_SESSION_V2_VERSION);
	assert.equal(manifest.generations[0].piSessionId, old.piSessionId); assert.equal(manifest.roomId, old.roomId);
	await assert.rejects(() => migrateManagedSessionStoresV1ToV2(runtimeFile, manifests), /already v2/);
});

test("store migration fails closed on an interrupted marker", async () => {
	const root = await mkdtemp(join(tmpdir(), "managed-v2-interrupted-"));
	const manifests = join(root, "manifests"); const runtime = join(root, "runtime");
	await mkdir(manifests); await mkdir(runtime); await writeFile(join(runtime, "v1-to-v2-migration.json"), "{}");
	await assert.rejects(() => migrateManagedSessionStoresV1ToV2(join(runtime, "registry.json"), manifests), /Interrupted.*restore the complete v1 backup or the complete v2 destination/);
});
