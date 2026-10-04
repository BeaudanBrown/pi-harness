import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HostApprovals } from "../config/agent/extensions/managed-sessions/relay/host-approvals.js";
import { HostApprovalStore } from "../config/agent/extensions/managed-sessions/relay/host-approval-store.js";
import { prepareHostApproval, type HostApprovalRecord, type ModelHostRequest } from "../config/agent/extensions/managed-sessions/relay/host-approval-record.js";
import { HostPolicy } from "../config/agent/extensions/managed-sessions/relay/host-policy.js";
import { HostDispatcher } from "../config/agent/extensions/managed-sessions/relay/host-dispatcher.js";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
const protectedId = `conv_${"c".repeat(32)}`;
const request = (toolCallId = "tool-1"): ModelHostRequest => ({ version: "1.0.0", actor: { kind: "model", requestId: toolCallId,
	conversationId: `conv_${"a".repeat(32)}`, generationId: `generation_${"a".repeat(32)}`, runId: "run-1", toolCallId, presentation: "local_dialog" },
	action: { operation: "conversation.stop", conversationId: `conv_${"b".repeat(32)}` } });
const approve = (): NonNullable<HostApprovalRecord["decision"]> => ({ choice: "approve", at: 1000, voter: { kind: "local" } });

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
	const root = await mkdtemp(join(tmpdir(), "host-approvals-")); t.after(() => rm(root, { recursive: true, force: true }));
	const store = new HostApprovalStore(root, "host"); await store.load();
	const policy = new HostPolicy(JSON.parse(readFileSync("config/agent/managed-host-policy.json", "utf8")));
	const prompts: Array<{ record: HostApprovalRecord; vote: ReturnType<typeof deferred<NonNullable<HostApprovalRecord["decision"]>>> }> = [];
	let changed = deferred<void>(); let now = 1000; let live = true; let valid = true; let executions = 0;
	let effect: () => Promise<unknown> = async () => ({ conversationId: `conv_${"b".repeat(32)}`, runtimeState: "stopped" });
	const options = { hostId: "host", protectedConversationId: protectedId, store, policy, operatorUserIds: new Set(["@operator:example.com"]),
		now: () => now, isLive: async () => live, freeze: async (value: ModelHostRequest) => ({ effects: [value.action], preconditions: { instance: "frozen" } }),
		present: async (record: HostApprovalRecord) => {
			const vote = deferred<NonNullable<HostApprovalRecord["decision"]>>(); prompts.push({ record, vote }); changed.resolve(); changed = deferred<void>();
			return { receipt: { kind: record.request.actor.presentation, id: record.request.actor.presentation === "local_dialog" ? record.approvalId : "$poll" }, decision: vote.promise, close: async () => undefined };
		}, revalidate: async () => valid, execute: async () => { executions++; return effect(); } };
	const approvals = new HostApprovals(options);
	const dispatcher = new HostDispatcher({ hostId: "host", protectedConversationId: protectedId, policy, read: async () => { throw Error("Not a read"); }, approve: (value) => approvals.request(value) });
	t.after(async () => { await approvals.close(); await store.close(); });
	return { store, approvals, options, prompts, dispatch: (value = request()) => dispatcher.dispatch(value, value.actor), executions: () => executions,
		waitPrompt: async (count: number) => { while (prompts.length < count) await changed.promise; },
		setNow: (value: number) => { now = value; }, setLive: (value: boolean) => { live = value; }, setValid: (value: boolean) => { valid = value; }, setEffect: (value: typeof effect) => { effect = value; } };
}

test("public dispatcher waits for independent consent without blocking unrelated approvals or duplicating active calls", async (t) => {
	const f = await fixture(t); const first = f.dispatch(); const duplicate = f.dispatch(); const other = f.dispatch(request("tool-2"));
	await f.waitPrompt(2); assert.equal(f.executions(), 0); assert.equal(f.store.list().length, 2);
	const firstPrompt = f.prompts.find((item) => item.record.request.actor.toolCallId === "tool-1")!;
	firstPrompt.vote.resolve(approve()); firstPrompt.vote.resolve({ ...approve(), choice: "deny" });
	assert.equal((await first).ok, true); assert.deepEqual(await duplicate, await first); assert.equal(f.executions(), 1);
	f.prompts.find((item) => item !== firstPrompt)!.vote.resolve({ ...approve(), choice: "deny" });
	const denied = await other; assert.ok(!denied.ok); assert.equal(denied.error.code, "denied"); assert.equal(f.store.list().length, 0);
	const again = f.dispatch(request("tool-3")); await f.waitPrompt(3); f.prompts[2].vote.resolve(approve());
	assert.equal((await again).ok, true); assert.equal(f.executions(), 2, "a new explicit call requires its own consent");
});

test("create, launch, refresh, reconciliation and destructive bundles all require independent consent", async (t) => {
	const f = await fixture(t); const conversationId = `conv_${"b".repeat(32)}`; const previewId = `preview_${"b".repeat(32)}`;
	const actions: ModelHostRequest["action"][] = [
		{ operation: "project.create", rootKey: "projects", workspace: "new", creationKey: "project", title: "Project" },
		{ operation: "conversation.create", creationKey: "conversation", title: "Conversation", placement: { rootKey: "projects", workspace: "main", relativeCwd: "" } },
		{ operation: "conversation.open", conversationId }, { operation: "conversation.resume", conversationId }, { operation: "conversation.refresh", conversationId, confirmed: true },
		{ operation: "conversation.delete", conversationId, confirmed: true }, { operation: "conversation.delete.apply", previewId, confirmed: true },
		{ operation: "worktree.create", rootKey: "projects", workspace: "main", creationKey: "worktree", baseRef: "main", branch: "feature" },
		{ operation: "worktree.conversation.create", rootKey: "projects", workspace: "main", creationKey: "bundle", baseRef: "main", branch: "feature", title: "Bundle" },
		{ operation: "worktree.remove.apply", previewId, confirmed: true }, { operation: "worktree.conversation.cleanup.apply", previewId, confirmed: true },
		{ operation: "worktree.branch.delete", previewId, confirmed: true }, { operation: "space.reconcile.apply", previewId, confirmed: true },
		{ operation: "space.cleanup.apply", previewId, confirmed: true }, { operation: "coordinator.membership.restore", confirmed: true },
	];
	for (const [index, action] of actions.entries()) {
		const pending = f.dispatch({ ...request(`tool-${index}`), action }); await f.waitPrompt(index + 1);
		assert.deepEqual(f.store.list()[0].frozen.effects, [action]); assert.equal(f.executions(), 0);
		f.prompts[index].vote.resolve({ ...approve(), choice: "deny" }); const response = await pending;
		assert.equal(response.ok, false); if (!response.ok) assert.equal(response.error.code, "denied");
	}
	assert.equal(f.executions(), 0); assert.equal(f.store.list().length, 0);
});

test("restart retains only live unconsumed consent within its original expiry", async (t) => {
	for (const state of ["live", "expired", "ended"] as const) {
		const f = await fixture(t); const value = request();
		const record = prepareHostApproval("host", value, { effects: [value.action], preconditions: {} }, 1000);
		await f.store.prepare(record);
		await f.store.transition(record.approvalId, { phase: "presented", presentation: { kind: "local_dialog", id: record.approvalId } });
		if (state === "expired") f.setNow(record.expiresAt); if (state === "ended") f.setLive(false);
		const replacement = new HostApprovals(f.options); await replacement.recover();
		assert.equal(f.executions(), 0); assert.equal(f.store.list().length, state === "live" ? 1 : 0);
		if (state === "live") {
			assert.equal(f.store.list()[0].expiresAt, record.expiresAt);
			const pending = replacement.request(value); await f.waitPrompt(1);
			f.prompts[0].vote.resolve({ ...approve(), choice: "deny" }); assert.equal((await pending).ok, false);
		}
		await replacement.close();
	}
});

test("expiry, stopped runs and stale targets never execute; late decisions do not revive them", async (t) => {
	for (const cause of ["expired", "cancelled", "stale_preview"] as const) {
		const f = await fixture(t); const pending = f.dispatch(); await f.waitPrompt(1);
		if (cause === "expired") f.setNow(f.prompts[0].record.expiresAt);
		if (cause === "cancelled") f.approvals.cancelRun(request().actor.conversationId, "run-1");
		if (cause === "stale_preview") f.setValid(false);
		f.prompts[0].vote.resolve(approve()); const result = await pending;
		assert.ok(!result.ok); assert.equal(result.error.code, cause); assert.equal(f.executions(), 0); assert.equal(f.store.list().length, 0);
	}
});

test("fresh liveness is rechecked after consent and Matrix participants cannot approve", async (t) => {
	const f = await fixture(t); const waiting = f.dispatch(); await f.waitPrompt(1); f.setLive(false); f.prompts[0].vote.resolve(approve());
	const stale = await waiting; assert.ok(!stale.ok); assert.equal(stale.error.code, "cancelled"); assert.equal(f.executions(), 0);
	f.setLive(true);
	const matrix: ModelHostRequest = { ...request("matrix-tool"), actor: { ...request("matrix-tool").actor, presentation: "matrix_poll",
		origin: { roomId: "!room:example.com", eventId: "$input", senderUserId: "@participant:example.com" } } };
	const pending = f.dispatch(matrix); await f.waitPrompt(2);
	f.prompts[1].vote.resolve({ choice: "approve", at: 1000, voter: { kind: "matrix", userId: "@participant:example.com", eventId: "$vote" } });
	const forbidden = await pending; assert.ok(!forbidden.ok); assert.equal(forbidden.error.code, "forbidden"); assert.equal(f.executions(), 0);
});

test("execution response loss is uncertain, never automatically retried or retained as a completed receipt", async (t) => {
	const f = await fixture(t); f.setEffect(async () => { throw Error("Connection lost after effect; private details"); });
	const pending = f.dispatch(); await f.waitPrompt(1); f.prompts[0].vote.resolve(approve());
	const result = await pending; assert.ok(!result.ok); assert.equal(result.error.retryable, false); assert.match(result.error.message, /outcome is unknown/);
	assert.ok(!JSON.stringify(result).includes("private details")); assert.equal(f.executions(), 1); assert.equal(f.store.list().length, 0);
	await f.approvals.recover(); assert.equal(f.executions(), 1);
});

test("restart discards consumed consent without resuming an uncertain mutation", async (t) => {
	const f = await fixture(t); const value = request(); const record = prepareHostApproval("host", value, { effects: [value.action], preconditions: {} }, 1000);
	await f.store.prepare(record);
	await f.store.transition(record.approvalId, { phase: "presented", presentation: { kind: "local_dialog", id: "dialog" } });
	await f.store.transition(record.approvalId, { phase: "approved", decision: approve() });
	await f.store.transition(record.approvalId, { phase: "accepted", acceptedAt: 1000 });
	const replacement = new HostApprovals(f.options);
	assert.deepEqual(await replacement.recover(), [{ conversationId: value.actor.conversationId, approvalId: record.approvalId }]);
	assert.equal(f.executions(), 0); assert.equal(f.store.list().length, 0); await replacement.close();
});

test("an admitted self-stop attempt can finish after caller cancellation; shutdown drains rather than replays", async (t) => {
	const f = await fixture(t); const started = deferred<void>(); const finish = deferred<void>();
	f.setEffect(async () => { started.resolve(); await finish.promise; return { conversationId: `conv_${"b".repeat(32)}`, runtimeState: "stopped" }; });
	const pending = f.dispatch(); await f.waitPrompt(1); f.prompts[0].vote.resolve(approve()); await started.promise;
	f.approvals.cancelRun(request().actor.conversationId); const closing = f.approvals.close();
	assert.equal(f.store.list()[0].phase, "accepted"); finish.resolve(); assert.equal((await pending).ok, true); await closing;
	assert.equal(f.executions(), 1); assert.equal(f.store.list().length, 0);
});
