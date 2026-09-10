import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MANAGED_SESSION_STATE_VERSION, deriveConversationId, deriveDeliveryId, type ConversationManifest } from "../config/agent/extensions/managed-sessions/contracts.js";
import { ConversationManifestStore } from "../config/agent/extensions/managed-sessions/relay/manifest-store.js";
import { RelayRegistry } from "../config/agent/extensions/managed-sessions/relay/registry.js";
import { prepareRelayStateDirectory } from "../config/agent/extensions/managed-sessions/relay/state-directory.js";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
	const root = await mkdtemp(join(tmpdir(), "managed-state-directory-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const runtime = join(root, "runtime"); const state = join(root, "persistent", "relay");
	const store = new ConversationManifestStore(join(root, "manifests")); const host = "reboot-host";
	const registry = new RelayRegistry(host, runtime, store); await registry.load();
	const manifest: ConversationManifest = { schemaVersion: MANAGED_SESSION_STATE_VERSION, kind: "coordinator", conversationId: deriveConversationId(host, "coordinator"),
		ownerHostId: host, creationKey: "coordinator", concept: "reboot test", piSessionId: "preserved-session", roomId: "!preserved:example.com",
		bindingBoundaryEntryId: `entry_${"1".repeat(32)}`, createdAt: "2026-09-10T00:00:00.000Z" };
	await registry.createCoordinatorConversation(manifest);
	return { root, runtime, state, store, host, registry, manifest };
}

test("relocation preserves the registry, activities and referenced media across runtime deletion", async (t) => {
	const f = await fixture(t);
	await f.registry.setMatrixCursor(f.manifest.conversationId, "before-reboot");
	await f.registry.recordAcceptedInput(f.manifest.conversationId, { deliveryId: deriveDeliveryId(f.manifest.conversationId, "$pending"), matrixEventId: "$pending",
		senderUserId: "@operator:example.com", kind: "prompt", body: "synthetic pending input", status: "accepted" });
	const before = f.registry.snapshot();
	await writeFile(join(f.runtime, "activities.json"), '{"schemaVersion":"2.0.0","activities":[]}\n', { mode: 0o600 });
	await mkdir(join(f.runtime, "media-spool"), { mode: 0o700 });
	await writeFile(join(f.runtime, "media-spool", "synthetic-blob"), "synthetic bytes", { mode: 0o600 });
	await writeFile(join(f.runtime, "sync-health.json"), "transient", { mode: 0o600 });
	await prepareRelayStateDirectory(f.host, f.state, f.runtime, f.store);
	const migrated = new RelayRegistry(f.host, f.state, f.store); await migrated.load();
	assert.deepEqual(migrated.snapshot(), before);
	assert.equal((await stat(f.state)).mode & 0o777, 0o700);
	assert.equal((await stat(join(f.state, "registry.json"))).mode & 0o777, 0o600);
	assert.equal((await readdir(f.state)).includes("sync-health.json"), false);
	assert.equal(await readFile(join(f.state, "media-spool", "synthetic-blob"), "utf8"), "synthetic bytes");
	assert.deepEqual(JSON.parse(await readFile(join(f.runtime, "registry.json"), "utf8")), before, "source remains a backup");

	await rm(f.runtime, { recursive: true }); // Model the actual reboot boundary, not just a process restart.
	await prepareRelayStateDirectory(f.host, f.state, f.runtime, f.store);
	const rebooted = new RelayRegistry(f.host, f.state, f.store); await rebooted.load();
	assert.deepEqual(rebooted.snapshot(), before);
	assert.equal(rebooted.manifestByCreationKey("coordinator")?.piSessionId, f.manifest.piSessionId);
	assert.equal(await readFile(join(f.state, "activities.json"), "utf8"), '{"schemaVersion":"2.0.0","activities":[]}\n');
});

test("committed destination wins over a stale legacy copy; no merge or cursor rollback", async (t) => {
	const f = await fixture(t);
	await prepareRelayStateDirectory(f.host, f.state, f.runtime, f.store);
	const migrated = new RelayRegistry(f.host, f.state, f.store); await migrated.load();
	await migrated.setMatrixCursor(f.manifest.conversationId, "newer-cursor");
	await prepareRelayStateDirectory(f.host, f.state, f.runtime, f.store);
	const restarted = new RelayRegistry(f.host, f.state, f.store); await restarted.load();
	assert.deepEqual(restarted.snapshot().conversations[0]?.matrixCursor, { status: "established", since: "newer-cursor" });
});

test("absent legacy runtime initializes persistent bootstrap from the surviving manifests", async (t) => {
	const f = await fixture(t);
	await rm(f.runtime, { recursive: true });
	await prepareRelayStateDirectory(f.host, f.state, f.runtime, f.store);
	const registry = new RelayRegistry(f.host, f.state, f.store); await registry.load();
	assert.equal(registry.snapshot().conversations[0]?.matrixCursor.status, "bootstrap");
	assert.equal(registry.manifestByCreationKey("coordinator")?.roomId, f.manifest.roomId);
});

for (const fault of ["malformed", "symlink", "permissions", "partial", "foreign-host"] as const) {
	test(`unsafe legacy state (${fault}) never publishes a partial destination`, async (t) => {
		const f = await fixture(t);
		if (fault === "malformed") await writeFile(join(f.runtime, "registry.json"), "{");
		if (fault === "symlink") await symlink(join(f.runtime, "registry.json"), join(f.runtime, "activities.json"));
		if (fault === "permissions") await writeFile(join(f.runtime, "activities.json"), "{}", { mode: 0o644 });
		if (fault === "partial") { await rm(join(f.runtime, "registry.json")); await mkdir(join(f.runtime, "media-spool"), { mode: 0o700 }); }
		await assert.rejects(() => prepareRelayStateDirectory(fault === "foreign-host" ? "wrong-host" : f.host, f.state, f.runtime, f.store));
		await assert.rejects(() => stat(f.state), { code: "ENOENT" });
		assert.deepEqual(await readdir(join(f.root, "persistent")), [], "caught copy failures clean only their own staging directory");
	});
}

test("an interrupted staging tree is never adopted as authoritative state", async (t) => {
	const f = await fixture(t);
	await mkdir(`${f.state}.relocating-interrupted`, { recursive: true, mode: 0o700 });
	await writeFile(join(`${f.state}.relocating-interrupted`, "registry.json"), "{partial", { mode: 0o600 });
	await prepareRelayStateDirectory(f.host, f.state, f.runtime, f.store);
	const migrated = new RelayRegistry(f.host, f.state, f.store); await migrated.load();
	assert.deepEqual(migrated.snapshot(), f.registry.snapshot());
	assert.equal(await readFile(join(`${f.state}.relocating-interrupted`, "registry.json"), "utf8"), "{partial");
});

test("incomplete destination and overlapping directories refuse rather than reset or consume temporary state", async (t) => {
	const f = await fixture(t);
	await mkdir(f.state, { recursive: true, mode: 0o700 });
	await writeFile(join(f.state, "registry.json.interrupted.tmp"), "{}", { mode: 0o600 });
	await assert.rejects(() => prepareRelayStateDirectory(f.host, f.state, f.runtime, f.store), /incomplete/);
	for (const state of [f.runtime, join(f.runtime, "state"), f.root]) {
		await assert.rejects(() => prepareRelayStateDirectory(f.host, state, f.runtime, f.store), /non-nested/);
	}
});
