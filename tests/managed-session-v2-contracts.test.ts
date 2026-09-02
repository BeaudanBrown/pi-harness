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
test("generation manifest rejects old fields and impossible active generations", () => { const value = migrateV1Manifest(old); assert.throws(() => parseConversationManifestV2({ ...value, piSessionId: "legacy" })); assert.throws(() => parseConversationManifestV2({ ...value, activeGenerationId: deriveGenerationId(conversationId, 2) }), /newest/); });
test("v2 operations are role-strict and reject extra fields", () => { const value = { protocolVersion: MANAGED_SESSION_V2_VERSION, messageId: "m1", conversationId, role: "relay", type: "control.deliver", payload: { controlId: `control_${"a".repeat(32)}`, name: "status" } }; assert.deepEqual(parseManagedSessionV2Envelope(value), value); assert.throws(() => parseManagedSessionV2Envelope({ ...value, role: "ordinary_adapter" })); assert.throws(() => parseManagedSessionV2Envelope({ ...value, payload: { ...value.payload, command: "pwd" } })); });
test("bundle migration fails closed when registry is partial", () => { const runtime = { schemaVersion: MANAGED_SESSION_STATE_VERSION, hostId: "host", conversations: [] }; assert.throws(() => migrateV1Bundle([old], runtime), /exact manifest\/registry match/); });

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
