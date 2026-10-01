import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RetirementCleanup } from "../config/agent/extensions/managed-sessions/relay/retirement-cleanup.js";
import { RetirementStore, retirementEffectId, retirementId, type RetirementTarget } from "../config/agent/extensions/managed-sessions/relay/retirement-store.js";
import { deriveConversationId, deriveGenerationId } from "../config/agent/extensions/managed-sessions/contracts.js";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function fixture(t: { after(fn: () => Promise<void>): void }) {
	const path = await mkdtemp(join(tmpdir(), "retirement-cleanup-")); const store = new RetirementStore(path, "host"); await store.load();
	t.after(async () => { await store.close(); await rm(path, { recursive: true, force: true }); });
	const conversationId = deriveConversationId("host", "project"); const id = retirementId("host", conversationId);
	const targets: RetirementTarget[] = [{ kind: "stop", generationId: deriveGenerationId(conversationId, 1) },
		{ kind: "operator_leave_forget", roomId: "!room:example.com", userId: "@operator:example.com" }, { kind: "bot_leave", roomId: "!room:example.com", userId: "@bot:example.com" }];
	await store.retire({ version: 1, hostId: "host", conversationId, creationKey: "project", retirementId: id, retiredAt: 1000,
		cleanup: targets.map((target) => ({ ...target, effectId: retirementEffectId(id, target), phase: "pending" })) });
	const authority = { pendingRetirements: () => store.pending(), retirement: (key: string) => store.get(key),
		markRetirementCleanup: (key: string, effect: string, phase: "done" | "blocked") => store.progress(key, effect, phase) };
	return { path, store, conversationId, authority };
}

test("stalled account cleanup does not block stop/bot effects and repeated sweeps never duplicate in-flight work", async (t) => {
	const f = await fixture(t); const calls: string[] = []; let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const cleanup = new RetirementCleanup({ authority: f.authority, execute: async (_record, effect) => { calls.push(effect.kind); if (effect.kind === "operator_leave_forget") await gate; return "done"; } });
	t.after(async () => { release(); await cleanup.close(); });
	cleanup.kick(); await tick();
	for (let i = 0; i < 100 && f.store.get(f.conversationId)?.cleanup?.filter((item) => item.phase === "done").length !== 2; i++) await new Promise((resolve) => setTimeout(resolve, 5));
	assert.equal(f.store.get(f.conversationId)?.cleanup?.filter((item) => item.phase === "done").length, 2);
	cleanup.kick(); cleanup.kick(); assert.equal(calls.filter((kind) => kind === "operator_leave_forget").length, 1);
	release(); await cleanup.drain(); assert.equal(f.store.get(f.conversationId)?.cleanup, undefined); cleanup.kick(); assert.equal(calls.length, 3);
});

test("failure retains exact blocked effect and restart retries only unfinished work", async (t) => {
	const f = await fixture(t); const cleanup = new RetirementCleanup({ authority: f.authority, execute: async (_record, effect) => { if (effect.kind === "bot_leave") throw Error("Private network details"); return "done"; } });
	cleanup.kick(); await cleanup.drain(); await cleanup.close();
	const pending = f.store.get(f.conversationId)!; assert.equal(pending.cleanup?.find((item) => item.kind === "bot_leave")?.phase, "blocked"); assert.ok(!JSON.stringify(pending).includes("Private network"));
	const replacement = new RetirementStore(f.path, "host"); await replacement.load(); t.after(() => replacement.close()); const attempted: string[] = [];
	const retry = new RetirementCleanup({ authority: { pendingRetirements: () => replacement.pending(), retirement: (id) => replacement.get(id), markRetirementCleanup: (id, effect, phase) => replacement.progress(id, effect, phase) },
		execute: async (_record, effect) => { attempted.push(effect.effectId); return "done"; } });
	retry.kick(); await retry.drain(); await retry.close();
	assert.deepEqual(attempted, [pending.cleanup!.find((item) => item.kind === "bot_leave")!.effectId]); assert.equal(replacement.get(f.conversationId)?.cleanup, undefined);
});

test("shutdown cancels and drains bounded admitted cleanup without erasing terminal authority", async (t) => {
	const f = await fixture(t); let entered!: () => void; const started = new Promise<void>((resolve) => { entered = resolve; }); let attempts = 0;
	const cleanup = new RetirementCleanup({ authority: f.authority, concurrency: 1, execute: async (_record, _effect, signal) => {
		attempts++; entered(); await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true })); return "pending";
	} });
	cleanup.kick(); await started; await cleanup.close(); cleanup.kick(); assert.equal(attempts, 1); assert.equal(f.store.get(f.conversationId)?.cleanup?.length, 3);
});
