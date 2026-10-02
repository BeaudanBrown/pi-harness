import assert from "node:assert/strict";
import test from "node:test";
import { ManagedHostMutationOwner } from "../config/agent/extensions/managed-sessions/relay/host-mutation-owner.js";
import { prepareHostApproval, type ModelHostRequest } from "../config/agent/extensions/managed-sessions/relay/host-approval-record.js";
import { hostApprovalQuestion } from "../config/agent/extensions/managed-sessions/relay/host-approval-prompts.js";
import type { HostLifecycle } from "../config/agent/extensions/managed-sessions/relay/host-lifecycle.js";
import type { RelayRegistry } from "../config/agent/extensions/managed-sessions/relay/registry.js";
import type { ConversationRetirement, RetirementPlan } from "../config/agent/extensions/managed-sessions/relay/conversation-retirement.js";

const conversationId = `conv_${"a".repeat(32)}`;
const branchAction = { operation: "worktree.branch.preview" as const, rootKey: "projects", workspace: "main", branch: "feature/test", mergeTarget: "main" };
const request = (previewId: string): ModelHostRequest => ({ version: "1.0.0", actor: { kind: "model", requestId: "request", conversationId,
	generationId: `generation_${"a".repeat(32)}`, runId: "run", toolCallId: "tool", presentation: "local_dialog" },
	action: { operation: "worktree.branch.delete", previewId, confirmed: true } });

test("branch consent uses a separate expiring preview, displays public targets and rejects changed tips", async () => {
	let now = 1000; let head = "a".repeat(40); let executed = 0;
	const options: ConstructorParameters<typeof ManagedHostMutationOwner>[0] = {
		registry: { hostId: "host" } as RelayRegistry, server: { attachment: () => undefined }, now: () => now,
		retirement: { prepare: (id: string) => ({ conversationId: id, targets: [] }) } as unknown as ConversationRetirement,
		lifecycle: { branchApprovalPreview: async () => ({ checkoutId: `checkout_${"b".repeat(32)}`, plan: {
			rootKey: "projects", projectWorkspace: "main", commonDir: "/private/repo/.git", mainPath: "/private/repo",
			branch: "feature/test", head, mergeTarget: "refs/heads/main", mergeCommit: "c".repeat(40),
		} }), executeBranchApproval: async () => { executed++; return { deleted: true }; } } as unknown as HostLifecycle,
	};
	const owner = new ManagedHostMutationOwner(options);
	await assert.rejects(owner.preview({ operation: "space.cleanup.preview" }), /owners are unavailable/, "never route modern cleanup to legacy operator kicking");
	await assert.rejects(owner.preview({ operation: "space.reconcile.preview" }), /owners are unavailable/, "never silently substitute the legacy two-level hierarchy");
	const unrelated = await owner.preview({ operation: "conversation.delete.preview", conversationIds: [conversationId] });
	await assert.rejects(owner.freeze(request(unrelated.previewId)), /Frozen targets/);
	const preview = await owner.preview(branchAction); const input = request(preview.previewId);
	const frozen = await owner.freeze(input); const record = prepareHostApproval("host", input, frozen, now);
	const question = hostApprovalQuestion(record);
	assert.ok(question.includes("feature/test")); assert.ok(question.includes(head)); assert.ok(question.includes("Expires:"));
	assert.ok(!question.includes("/private/repo")); assert.equal(await owner.revalidate(record), true);
	head = "d".repeat(40); assert.equal(await owner.revalidate(record), false);
	await assert.rejects(owner.execute(record), /Frozen targets/); assert.equal(executed, 0);
	head = "a".repeat(40); await owner.execute(record); assert.equal(executed, 1);
	await assert.rejects(new ManagedHostMutationOwner(options).freeze(input), /Frozen targets/, "preview cache is not a durable execution receipt");
	now += 900_001; assert.equal(await owner.revalidate(record), false); await assert.rejects(owner.freeze(input), /Frozen targets/);
	const fresh = await owner.preview(branchAction); assert.notEqual(fresh.previewId, preview.previewId);
	assert.ok(await owner.freeze(request(fresh.previewId)), "fresh preview is independent of the removed checkout and old consent");
});

test("bulk retirement revalidates the entire frozen set before any commit and never discovers extra targets", async () => {
	const ids = [conversationId, `conv_${"b".repeat(32)}`]; let generation = "a"; const applied: RetirementPlan[] = [];
	const owner = new ManagedHostMutationOwner({ registry: { hostId: "host" } as RelayRegistry, lifecycle: {} as HostLifecycle,
		server: { attachment: () => undefined }, now: () => 1000,
		retirement: { prepare: (id: string) => ({ conversationId: id, targets: [{ kind: "stop", generationId: `generation_${(id === ids[1] ? generation : "a").repeat(32)}` }] }),
			retirePrepared: async (plan: RetirementPlan) => { applied.push(structuredClone(plan)); } } as unknown as ConversationRetirement });
	const preview = await owner.preview({ operation: "conversation.delete.preview", conversationIds: ids });
	const input = { ...request(preview.previewId), action: { operation: "conversation.delete.apply" as const, previewId: preview.previewId, confirmed: true as const } };
	const record = prepareHostApproval("host", input, await owner.freeze(input), 1000);
	generation = "c"; assert.equal(await owner.revalidate(record), false); await assert.rejects(owner.execute(record), /Frozen targets/);
	assert.equal(applied.length, 0, "stale last target cannot partially commit the first");
	generation = "a"; await owner.execute(record); assert.deepEqual(applied.map((plan) => plan.conversationId), ids);
	assert.deepEqual(applied, ids.map((id) => ({ conversationId: id, targets: [{ kind: "stop", generationId: `generation_${"a".repeat(32)}` }] })));
});
