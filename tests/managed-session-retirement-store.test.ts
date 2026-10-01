import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deriveConversationId, deriveGenerationId } from "../config/agent/extensions/managed-sessions/contracts.js";
import { RetirementStore, parseRetirementRecord, retirementEffectId, retirementId, type RetirementRecord, type RetirementTarget } from "../config/agent/extensions/managed-sessions/relay/retirement-store.js";

function record(key = "project-1"): RetirementRecord {
	const conversationId = deriveConversationId("host", key); const id = retirementId("host", conversationId);
	const targets: RetirementTarget[] = [
		{ kind: "stop", generationId: deriveGenerationId(conversationId, 1), window: { sessionName: "managed", windowId: "@1", paneId: "%1", serverId: "server-instance-1" } },
		{ kind: "operator_leave_forget", roomId: "!room:example.com", userId: "@operator:example.com" }, { kind: "bot_leave", roomId: "!room:example.com", userId: "@bot:example.com" },
	];
	return { version: 1, hostId: "host", conversationId, creationKey: key, retirementId: id, retiredAt: 1000,
		cleanup: targets.map((target) => ({ ...target, effectId: retirementEffectId(id, target), phase: "pending" })) };
}
async function fixture(t: { after(fn: () => Promise<void>): void }) {
	const path = await mkdtemp(join(tmpdir(), "retirement-")); const store = new RetirementStore(path, "host"); await store.load();
	t.after(async () => { await store.close(); await rm(path, { recursive: true, force: true }); }); return { path, store };
}

test("retirement freezes exact independent cleanup and compacts only to a permanent tombstone", async (t) => {
	const { path, store } = await fixture(t); const original = record(); const frozen = await store.retire(original);
	original.cleanup![0].phase = "done"; assert.equal(store.pending()[0].cleanup![0].phase, "pending");
	await store.progress(frozen.conversationId, frozen.cleanup![1].effectId, "blocked");
	const recovered = new RetirementStore(path, "host"); await recovered.load(); t.after(() => recovered.close());
	assert.equal(recovered.get(frozen.conversationId)?.cleanup![1].phase, "blocked"); assert.equal(recovered.hasCreationKey(frozen.creationKey), true);
	for (const effect of frozen.cleanup!) await store.progress(frozen.conversationId, effect.effectId, "done");
	const tombstone = store.get(frozen.conversationId)!; assert.equal(tombstone.cleanup, undefined); assert.deepEqual(store.pending(), []);
	assert.equal(JSON.parse(await readFile(join(path, `${frozen.conversationId}.json`), "utf8")).retirementId, frozen.retirementId);
	assert.deepEqual(await store.retire(record()), tombstone, "an old active backup cannot resurrect completed cleanup or change retirement");
});

test("retry never replaces frozen targets, completion cannot regress and coordinator retirement is forbidden", async (t) => {
	const { store } = await fixture(t); const original = record(); await store.retire(original);
	const replacement = record(); const target: RetirementTarget = { kind: "bot_leave", roomId: "!unrelated:example.com", userId: "@bot:example.com" };
	replacement.cleanup![2] = { ...target, phase: "pending", effectId: retirementEffectId(replacement.retirementId, target) };
	const operatorTarget: RetirementTarget = { kind: "operator_leave_forget", roomId: target.roomId, userId: "@operator:example.com" };
	replacement.cleanup![1] = { ...operatorTarget, phase: "pending", effectId: retirementEffectId(replacement.retirementId, operatorTarget) };
	assert.deepEqual(await store.retire(replacement), original);
	await store.progress(original.conversationId, original.cleanup![0].effectId, "done");
	await assert.rejects(store.progress(original.conversationId, original.cleanup![0].effectId, "blocked"), /cannot regress/);
	await assert.rejects(store.retire(record("coordinator")), /Coordinator/);
	const account = record(); const priorId = account.cleanup![1].effectId;
	if (account.cleanup![1].kind === "operator_leave_forget") account.cleanup![1].userId = "@different:example.com";
	assert.throws(() => parseRetirementRecord(account), /identity changed/);
	assert.equal(store.get(original.conversationId)?.cleanup![1].effectId, priorId);
	const tampered = record(); tampered.cleanup![0].effectId = `cleanup_${"0".repeat(32)}`;
	assert.throws(() => parseRetirementRecord(tampered), /identity changed/);
});

test("write interruption poisons authority rather than allowing resumability from stale memory", async (t) => {
	const { path, store } = await fixture(t); const value = record();
	await mkdir(join(path, `${value.conversationId}.json`));
	await assert.rejects(store.retire(value));
	assert.throws(() => store.get(value.conversationId), /fail closed/); assert.throws(() => store.hasCreationKey(value.creationKey), /fail closed/);
	await assert.rejects(store.retire(record("second")), /fail closed/);
});

test("private durable retirement load rejects symlinks, permissive files and foreign host identity", async (t) => {
	for (const failure of ["symlink", "permissions", "host"] as const) {
		const { path, store } = await fixture(t); const value = record(); await store.retire(value);
		const file = join(path, `${value.conversationId}.json`);
		if (failure === "symlink") { await rm(file); await symlink("missing", file); }
		if (failure === "permissions") await chmod(file, 0o644);
		if (failure === "host") { const foreign = { ...value, hostId: "other", retirementId: retirementId("other", value.conversationId), cleanup: undefined }; await writeFile(file, JSON.stringify(foreign)); }
		const reload = new RetirementStore(path, "host"); await assert.rejects(reload.load()); assert.throws(() => reload.pending(), /fail closed/); await reload.close();
	}
});
