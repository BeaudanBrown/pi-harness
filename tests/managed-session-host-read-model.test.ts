import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readHostPolicy } from "../config/agent/extensions/managed-sessions/relay/host-policy.js";
import { HostReadModel } from "../config/agent/extensions/managed-sessions/relay/host-read-model.js";
import { parseHostResponse, savedSessionKey, HOST_CONTROL_VERSION, type HostReadAction } from "../config/agent/extensions/managed-sessions/live-workspace-contracts.js";
import type { RetirementRecord } from "../config/agent/extensions/managed-sessions/relay/retirement-store.js";
import type { RegistryConversationMetadata } from "../config/agent/extensions/managed-sessions/relay/registry.js";

test("startup policy reads reject symlinks, non-files, oversized data and malformed UTF-8", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "host-policy-read-")); t.after(() => rm(directory, { recursive: true, force: true }));
	const path = join(directory, "policy.json");
	await writeFile(path, JSON.stringify({ version: "1.0.0", actions: {} }));
	await assert.doesNotReject(readHostPolicy(path));
	await symlink(path, join(directory, "link")); await assert.rejects(readHostPolicy(join(directory, "link")));
	await assert.rejects(readHostPolicy(directory)); await assert.rejects(readHostPolicy("relative.json"));
	await writeFile(path, "x".repeat(65 * 1024)); await assert.rejects(readHostPolicy(path));
	await writeFile(path, Buffer.from([0xff])); await assert.rejects(readHostPolicy(path));
});

const id = (prefix: string, digit = "a") => `${prefix}_${digit.repeat(32)}`;
const placement = { rootKey: "projects", workspace: "repo", relativeCwd: "src" };
const base: RegistryConversationMetadata = { conversationId: id("conv"), kind: "project", title: "Work", activeGenerationId: id("generation"),
	attached: true, matrixBound: false, placement, projectKey: id("project"), checkoutId: id("checkout"), projectDisplayName: "Project", checkoutDisplayName: "Main" };
const request = (action: HostReadAction) => ({ version: HOST_CONTROL_VERSION, actor: { kind: "human_local" as const, requestId: "read-1" }, action });

async function read<O extends HostReadAction["operation"]>(model: HostReadModel, action: Extract<HostReadAction, { operation: O }>) {
	return parseHostResponse(action.operation, { version: HOST_CONTROL_VERSION, requestId: "read-1", ok: true, data: await model.read(request(action)) });
}

test("retired status reports cleanup without exposing receipts or returning a resumable conversation", async () => {
	const retired: RetirementRecord = { version: 1, hostId: "host", conversationId: base.conversationId, creationKey: "first", retirementId: id("retirement"), retiredAt: 1 };
	let inventoryReads = 0;
	const model = new HostReadModel({ hostId: "host", registry: { conversationMetadata: () => { inventoryReads++; return []; }, retirement: () => retired }, matrixReady: () => false });
	for (const phase of ["pending", "blocked", undefined] as const) {
		if (phase) retired.cleanup = [{ kind: "stop", generationId: base.activeGenerationId, effectId: id("cleanup"), phase }]; else delete retired.cleanup;
		await assert.rejects(model.read(request({ operation: "conversation.status", conversationId: base.conversationId })), {
			code: "retired", message: `Conversation is permanently retired; cleanup ${phase === "blocked" ? "pending (blocked)" : phase ?? "complete"}` });
	}
	assert.equal(inventoryReads, 0, "retirement lookup does not sweep ordinary inventories");
	const result = await read(model, { operation: "conversation.list" }); assert.ok(result.ok); assert.deepEqual(result.data.items, []);
});

test("saved-session discovery exposes opaque active identity and advertises guarded open explicitly", async () => {
	const registry = { conversationMetadata: () => [{ ...base, sessionId: "saved-native-id" }], retirement: () => undefined };
	const model = new HostReadModel({ hostId: "host", registry, matrixReady: () => false, windowFirstOpen: true, savedSessionOpen: true });
	const host = await read(model, { operation: "host.status" }); assert.ok(host.ok);
	assert.ok(host.data.capabilities.includes("saved-session-open-v1"));
	const rows = await read(model, { operation: "conversation.list" }); assert.ok(rows.ok);
	assert.equal(rows.data.items[0].sessionKey, savedSessionKey("host", "saved-native-id"));
	assert.equal(JSON.stringify(rows).includes("saved-native-id"), false);
	assert.notEqual(savedSessionKey("host", "saved-native-id"), savedSessionKey("other", "saved-native-id"));
	assert.notEqual(savedSessionKey("ab", "c"), savedSessionKey("a", "bc"));
	assert.equal(rows.data.items[0].activeGenerationId, base.activeGenerationId);
	assert.equal(rows.data.items[0].setupState, "pending");
	assert.equal("sessionFile" in rows.data.items[0], false);
	const unavailable = await read(new HostReadModel({ hostId: "host", registry, matrixReady: () => false }), { operation: "host.status" });
	assert.ok(unavailable.ok); assert.equal(unavailable.data.capabilities.includes("saved-session-open-v1"), false);
});

test("host reads share one observation snapshot and never override exact stopped or unknown evidence", async () => {
	let snapshots = 0;
	const model = new HostReadModel({ hostId: "host", registry: { conversationMetadata: () => [base], retirement: () => undefined }, matrixReady: () => true,
		runtimeObservations: () => { snapshots++; return new Map([[base.conversationId, { runtimeState: "stopped", launchState: "failed" }]]); } });
	const result = await read(model, { operation: "conversation.list" }); assert.ok(result.ok);
	assert.equal(result.data.items[0].runtimeState, "stopped"); assert.equal(result.data.items[0].launchState, "failed"); assert.equal(snapshots, 1);
});

test("host read model includes roomless and unresolved rows without inventing runtime or account readiness", async () => {
	let rows: RegistryConversationMetadata[] = [base, { ...base, conversationId: id("conv", "b"), attached: false, matrixBound: true, checkoutId: undefined }];
	const model = new HostReadModel({ hostId: "host", registry: { conversationMetadata: () => structuredClone(rows), retirement: () => undefined }, matrixReady: () => false });
	const result = await read(model, { operation: "conversation.list" }); assert.ok(result.ok);
	assert.equal(result.data.items[0].runtimeState, "unknown", "an attachment alone is not an exact managed-window observation"); assert.equal(result.data.items[0].setupState, "pending");
	assert.equal(result.data.items[1].runtimeState, "unknown"); assert.equal(result.data.items[1].setupState, "disconnected");
	assert.ok("reconciliationRequired" in result.data.items[1]); assert.ok(!("checkoutId" in result.data.items[1]));
	assert.equal(result.data.items[0].kind, "project");
	const host = await read(model, { operation: "host.status" }); assert.ok(host.ok); assert.equal(host.data.accountState, "unavailable");
	rows = [];
	await assert.rejects(model.read(request({ operation: "conversation.status", conversationId: base.conversationId })), { code: "not_found" });
});

test("workspace joins preserve unknown/conflicting identities and avoid per-row discovery", async () => {
	let calls = 0; let now = 0;
	let metadata = [base];
	const model = new HostReadModel({ hostId: "host", registry: { conversationMetadata: () => structuredClone(metadata), retirement: () => undefined }, matrixReady: () => false, now: () => now,
		lifecycle: { workspaceList: async () => { calls++; return [{ rootKey: "projects", workspace: "repo" }, { rootKey: "projects", workspace: "unmanaged" }]; }, worktreeInventory: async () => [] } });
	const first = await read(model, { operation: "workspace.list" }); assert.ok(first.ok);
	assert.ok(first.data.items.some((row) => row.workspace === "repo" && "checkoutId" in row && row.checkoutId === base.checkoutId));
	assert.ok(first.data.items.some((row) => row.workspace === "unmanaged" && "reconciliationRequired" in row));
	await read(model, { operation: "workspace.list" }); assert.equal(calls, 1);
	metadata = [base, { ...base, conversationId: id("conv", "b"), checkoutId: undefined, projectKey: id("project", "b") }];
	const conflict = await read(model, { operation: "workspace.list" }); assert.ok(conflict.ok);
	assert.ok(conflict.data.items.some((row) => row.workspace === "repo" && "reconciliationRequired" in row));
	assert.equal(calls, 1, "registry identity changes do not trigger per-row filesystem/Git calls");
	now = 30_000; await read(model, { operation: "workspace.list" }); assert.equal(calls, 2);
});

test("worktree metadata discovery is shared while in flight and cached; detached branches remain absent", async () => {
	let release!: () => void; const gate = new Promise<void>((done) => { release = done; }); let calls = 0;
	const model = new HostReadModel({ hostId: "host", registry: { conversationMetadata: () => [], retirement: () => undefined }, matrixReady: () => false,
		lifecycle: { workspaceList: async () => [], worktreeInventory: async () => { calls++; await gate; return [{ rootKey: "projects", workspace: "repo", checkoutId: id("checkout"), locked: false, availability: "available" }]; } } });
	const action = { operation: "worktree.list" as const, rootKey: "projects", workspace: "repo" };
	const first = read(model, action); const second = read(model, action); assert.equal(calls, 1); release();
	const values = await Promise.all([first, second]); assert.deepEqual(values[0], values[1]);
	assert.ok(values[0].ok); assert.ok(!("branch" in values[0].data.items[0]));
	await read(model, action); assert.equal(calls, 1);
});

test("preview implementations remain staged and invalid public placement cannot escape validation", async () => {
	const model = new HostReadModel({ hostId: "host", registry: { conversationMetadata: () => [base], retirement: () => undefined }, matrixReady: () => false });
	await assert.rejects(model.read(request({ operation: "conversation.delete.preview", conversationIds: [base.conversationId] })), { code: "upgrade_required" });
	await assert.rejects(model.read(request({ operation: "workspace.list" })), { code: "unavailable" });
	for (const operation of ["workspace.list", "worktree.list"] as const) assert.throws(() => parseHostResponse(operation, {
		version: HOST_CONTROL_VERSION, requestId: "bad-response", ok: true, data: { items: [{ rootKey: "projects", workspace: "/private/path", checkoutId: id("checkout"),
			...(operation === "workspace.list" ? { projectKey: id("project") } : { locked: false }), availability: "available" }], nextCursor: null },
	}));
});
