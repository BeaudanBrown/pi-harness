import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { Check } from "typebox/value";
import { deriveConversationId, deriveDeliveryId, deriveGenerationId, deriveTranscriptEntryId, parseHostRuntimeState, HostRuntimeStateSchema, type ConversationManifest } from "../config/agent/extensions/managed-sessions/contracts.js";
import { AtomicJsonFile } from "../config/agent/extensions/managed-sessions/relay/atomic-json.js";
import { ConversationManifestStore } from "../config/agent/extensions/managed-sessions/relay/manifest-store.js";
import { RelayRegistry } from "../config/agent/extensions/managed-sessions/relay/registry.js";

async function fleet(t: TestContext, count = 34, receipts = 64) {
	const root = await mkdtemp(join(tmpdir(), "registry-cost-")); t.after(() => rm(root, { recursive: true, force: true }));
	const store = new ConversationManifestStore(join(root, "manifests"));
	const values: ConversationManifest[] = Array.from({ length: count }, (_, i) => ({ schemaVersion: "1.0.0", kind: "project", ownerHostId: "cost-host",
		creationKey: `work-${i}`, concept: `work-${i}`, conversationId: deriveConversationId("cost-host", `work-${i}`), piSessionId: `session-${i}`,
		roomId: `!room-${i}:example.com`, bindingBoundaryEntryId: deriveTranscriptEntryId(`session-${i}`, "boundary"),
		placement: { rootKey: "projects", workspace: `work-${i}`, relativeCwd: "" }, createdAt: "2026-10-01T00:00:00.000Z" }));
	for (const value of values) await store.write(value);
	const path = join(root, "runtime", "registry.json"); const registry = new RelayRegistry("cost-host", join(root, "runtime"), store); await registry.load();
	const state = registry.snapshot();
	for (const row of state.conversations) {
		row.pendingInputs = Array.from({ length: receipts }, (_, i) => ({ deliveryId: deriveDeliveryId(row.conversationId, `$event-${i}`),
			matrixEventId: `$event-${i}`, kind: "prompt", body: "synthetic ".repeat(80), status: "completed", piEntryId: deriveTranscriptEntryId(row.conversationId, `entry-${i}`) }));
		row.projection = row.pendingInputs.map(input => ({ entryId: input.piEntryId!, kind: "matrix_user", status: "projected", chunks: [] }));
	}
	await new AtomicJsonFile(path, parseHostRuntimeState).write(state); await registry.load();
	return { root, path, registry, store, values, state };
}

function countWrites(t: TestContext, path: string) {
	let count = 0; const original = AtomicJsonFile.prototype.write;
	t.mock.method(AtomicJsonFile.prototype, "write", async function(this: AtomicJsonFile<unknown>, value: unknown) {
		if (this.path === path) count++; return original.call(this, value);
	});
	return () => count;
}

test("fleet receipt replay performs zero registry writes for identical committed acknowledgements", async t => {
	const f = await fleet(t); const writes = countWrites(t, f.path); const inode = (await stat(f.path)).ino;
	const first = f.state.conversations[0]!; const input = first.pendingInputs[0]!;
	await f.registry.acknowledgeInput(first.conversationId, input.deliveryId, "completed", input.piEntryId);
	assert.equal(writes(), 0, "one identical acknowledgement must already take the no-write path");
	const start = process.cpuUsage();
	await Promise.all(f.state.conversations.flatMap(row => row.pendingInputs.map(item => f.registry.acknowledgeInput(row.conversationId, item.deliveryId, "completed", item.piEntryId))));
	const cpu = process.cpuUsage(start);
	assert.equal(writes(), 0); assert.equal((await stat(f.path)).ino, inode); assert.deepEqual(f.registry.snapshot(), f.state);
	t.diagnostic(`34 conversations, 2176 identical receipts, ${JSON.stringify(f.state).length} compact JSON bytes: ${(cpu.user + cpu.system) / 1000} CPU ms, zero durable writes`);
});

test("duplicate receipts still validate identity, repair missing provenance and persist real changes", async t => {
	const f = await fleet(t, 1, 1); const row = f.state.conversations[0]!; const input = row.pendingInputs[0]!; const id = row.conversationId;
	row.projection = []; await new AtomicJsonFile(f.path, parseHostRuntimeState).write(f.state); await f.registry.load();
	const writes = countWrites(t, f.path);
	await f.registry.acknowledgeInput(id, input.deliveryId, "completed", input.piEntryId);
	assert.equal(writes(), 1, "same receipt with missing provenance is not a no-op");
	await f.registry.acknowledgeInput(id, input.deliveryId, "completed", input.piEntryId); assert.equal(writes(), 1);
	await assert.rejects(f.registry.acknowledgeInput(id, input.deliveryId, "completed", deriveTranscriptEntryId(id, "wrong")), /changed.*identity/);
	await assert.rejects(f.registry.acknowledgeInput(id, input.deliveryId, "persisted", input.piEntryId), /regressed/);
	await assert.rejects(f.registry.acknowledgeInput(id, input.deliveryId, "completed", undefined, "extension_command"), /completion|identity/);
	assert.equal(writes(), 1);
	const nextId = deriveDeliveryId(id, "$next"); await f.registry.recordAcceptedInput(id, { deliveryId: nextId, matrixEventId: "$next", kind: "prompt", body: "next", status: "accepted" });
	await f.registry.markInputDelivered(id, nextId); const before = writes();
	await f.registry.acknowledgeInput(id, nextId, "accepted"); assert.equal(writes(), before, "receipt after socket delivery does not regress or rewrite state");
	await f.registry.acknowledgeInput(id, nextId, "persisted", deriveTranscriptEntryId(id, "next")); assert.equal(writes(), before + 1);
	const restarted = new RelayRegistry("cost-host", join(f.root, "runtime"), f.store); await restarted.load();
	assert.equal(restarted.pendingInputs(id).find(item => item.deliveryId === nextId)!.status, "persisted");
});

test("completed command identity cannot be replaced with an ordinary receipt or invented provenance", async t => {
	const f = await fleet(t, 1, 0); const id = f.state.conversations[0]!.conversationId; const deliveryId = deriveDeliveryId(id, "$command");
	await f.registry.recordAcceptedInput(id, { deliveryId, matrixEventId: "$command", kind: "prompt", body: "/host status", status: "accepted" });
	await f.registry.acknowledgeInput(id, deliveryId, "completed", undefined, "extension_command");
	const writes = countWrites(t, f.path); const before = f.registry.conversationSnapshot(id);
	await f.registry.acknowledgeInput(id, deliveryId, "completed", undefined, "extension_command"); assert.equal(writes(), 0);
	await assert.rejects(f.registry.acknowledgeInput(id, deliveryId, "completed", deriveTranscriptEntryId(id, "invented")), /changed.*command identity/);
	assert.equal(writes(), 0); assert.deepEqual(f.registry.conversationSnapshot(id), before);
});

test("queued cancellation and retirement cannot be bypassed by the no-op receipt path", async t => {
	const f = await fleet(t, 1, 1); const row = f.state.conversations[0]!; const input = row.pendingInputs[0]!;
	input.status = "persisted"; await new AtomicJsonFile(f.path, parseHostRuntimeState).write(f.state); await f.registry.load();
	const writes = countWrites(t, f.path);
	const cancelled = f.registry.cancelPendingInputs(row.conversationId);
	const rejected = assert.rejects(f.registry.acknowledgeInput(row.conversationId, input.deliveryId, "persisted", input.piEntryId), /regressed/);
	await Promise.all([cancelled, rejected]); assert.equal(writes(), 1);
	await f.registry.acknowledgeInput(row.conversationId, input.deliveryId, "cancelled", input.piEntryId); assert.equal(writes(), 1);
	const retired = f.registry.retireConversation(row.conversationId, [
		{ kind: "stop", generationId: deriveGenerationId(row.conversationId, 1) },
		{ kind: "operator_leave_forget", roomId: f.values[0]!.roomId, userId: "@operator:example.com" },
		{ kind: "bot_leave", roomId: f.values[0]!.roomId, userId: "@bot:example.com" },
	]);
	const retiredReceipt = assert.rejects(f.registry.acknowledgeInput(row.conversationId, input.deliveryId, "cancelled", input.piEntryId), /retired/);
	await Promise.all([retired, retiredReceipt]);
});

test("current runtime parsing avoids migration clones and compiled validation retains strict rejection", async t => {
	const f = await fleet(t, 2, 2); const original = structuredClone; let clones = 0;
	const spy = t.mock.method(globalThis, "structuredClone", (...args: Parameters<typeof structuredClone>) => { clones++; return original(...args); });
	assert.equal(parseHostRuntimeState(f.state), f.state); assert.equal(clones, 0, "current shape must not be cloned to inspect legacy defaults");
	spy.mock.restore();
	for (const mutate of [
		(value: any) => { value.extraCredential = "forbidden"; },
		(value: any) => { value.conversations[0].pendingInputs[0].status = "invalid"; },
		(value: any) => { value.conversations[0].pendingInputs[0].deliveryId = "invalid"; },
		(value: any) => { value.conversations[0].projection[0].kind = "invalid"; },
		(value: any) => { value.conversations[0].pendingControls = null; },
		(value: any) => { value.conversations[0] = null; },
	]) {
		const invalid = structuredClone(f.state); mutate(invalid);
		assert.equal(Check(HostRuntimeStateSchema, invalid), false); assert.throws(() => parseHostRuntimeState(invalid));
	}
	const legacy = structuredClone(f.state) as any; delete legacy.conversations[0].pendingControls;
	const normalized = parseHostRuntimeState(legacy);
	assert.deepEqual(normalized.conversations[0]!.pendingControls, []); assert.equal("pendingControls" in legacy.conversations[0], false);
});

test("single-conversation snapshots isolate callers without cloning other histories", async t => {
	const f = await fleet(t, 2, 2); const first = f.state.conversations[0]!.conversationId;
	const observed = f.registry.conversationSnapshot(first)!;
	assert.deepEqual(observed, f.registry.snapshot().conversations[0]); observed.pendingInputs.length = 0;
	assert.equal(f.registry.pendingInputs(first).length, 2); assert.equal(f.registry.conversationSnapshot("missing"), undefined);
	const clone = structuredClone; const cloned: unknown[] = [];
	t.mock.method(globalThis, "structuredClone", (...args: Parameters<typeof structuredClone>) => { cloned.push(args[0]); return clone(...args); });
	f.registry.conversationSnapshot(first);
	assert.equal(cloned.length, 1); assert.equal((cloned[0] as { conversationId: string }).conversationId, first);
});

test("duplicate acknowledgement waits for the preceding write and retries after its failure", async t => {
	const f = await fleet(t, 1, 0); const id = f.state.conversations[0]!.conversationId; const deliveryId = deriveDeliveryId(id, "$next");
	await f.registry.recordAcceptedInput(id, { deliveryId, matrixEventId: "$next", kind: "prompt", body: "next", status: "accepted" });
	let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
	let entered!: () => void; const writing = new Promise<void>(resolve => { entered = resolve; });
	let attempts = 0; const original = AtomicJsonFile.prototype.write;
	t.mock.method(AtomicJsonFile.prototype, "write", async function(this: AtomicJsonFile<unknown>, value: unknown) {
		if (this.path === f.path && ++attempts === 1) { entered(); await held; throw Error("injected write failure"); }
		return original.call(this, value);
	});
	const entryId = deriveTranscriptEntryId(id, "next");
	const first = f.registry.acknowledgeInput(id, deliveryId, "persisted", entryId).then(() => false, () => true);
	await writing; let settled = false;
	const second = f.registry.acknowledgeInput(id, deliveryId, "persisted", entryId).then(() => { settled = true; });
	await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false); release();
	assert.equal(await first, true); await second; assert.equal(attempts, 2);
	const restarted = new RelayRegistry("cost-host", join(f.root, "runtime"), f.store); await restarted.load();
	assert.equal(restarted.pendingInputs(id)[0]!.status, "persisted");
});
