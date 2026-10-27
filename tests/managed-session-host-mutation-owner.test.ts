import assert from "node:assert/strict";
import { HostAccountOwner } from "../config/agent/extensions/managed-sessions/relay/host-account-owner.js";
import { HostAccountClient } from "../config/agent/extensions/managed-sessions/relay/host-account-client.js";
import { deriveConversationId } from "../config/agent/extensions/managed-sessions/contracts.js";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ManagedMatrixClient } from "../config/agent/extensions/managed-sessions/relay/matrix-client.js";
import type { ManagedSessionIpcServer } from "../config/agent/extensions/managed-sessions/relay/ipc-server.js";
import { ManagedHostMutationOwner } from "../config/agent/extensions/managed-sessions/relay/host-mutation-owner.js";
import { prepareHostApproval, type ModelHostRequest } from "../config/agent/extensions/managed-sessions/relay/host-approval-record.js";
import { hostApprovalQuestion } from "../config/agent/extensions/managed-sessions/relay/host-approval-prompts.js";
import type { LiveSpacePreview } from "../config/agent/extensions/managed-sessions/relay/project-reconciliation.js";
import type { HierarchyLink } from "../config/agent/extensions/managed-sessions/relay/live-hierarchy.js";
import { HostLifecycle } from "../config/agent/extensions/managed-sessions/relay/host-lifecycle.js";
import type { RelayRegistry } from "../config/agent/extensions/managed-sessions/relay/registry.js";
import type { ConversationRetirement, RetirementPlan } from "../config/agent/extensions/managed-sessions/relay/conversation-retirement.js";

const conversationId = `conv_${"a".repeat(32)}`;
const branchAction = { operation: "worktree.branch.preview" as const, rootKey: "projects", workspace: "main", branch: "feature/test", mergeTarget: "main" };
const request = (previewId: string): ModelHostRequest => ({ version: "1.0.0", actor: { kind: "model", requestId: "request", conversationId,
	generationId: `generation_${"a".repeat(32)}`, runId: "run", toolCallId: "tool", presentation: "local_dialog" },
	action: { operation: "worktree.branch.delete", previewId, confirmed: true } });

test("split fork consent binds source origin, exact summary, generation and committed base", async () => {
	const action = { operation: "worktree.conversation.fork" as const, creationKey: "fork", rootKey: "projects", workspace: "main", title: "New room", sourceConversationId: conversationId, baseRef: "main", branch: "topic", summary: "Explicit inherited summary\nA quoted \"decision\" and a literal \\ path fragment." };
	let generation = `generation_${"a".repeat(32)}`; let executions = 0;
	const lifecycle = { freezeCreation: async () => ({ context: { version: 1, sourceConversationId: conversationId, sourceGenerationId: generation, baseCommit: "b".repeat(40), summary: action.summary } }), executeCreation: async () => { executions++; return {}; } } as unknown as HostLifecycle;
	const owner = new ManagedHostMutationOwner({ registry: {} as RelayRegistry, lifecycle, retirement: {} as ConversationRetirement, server: { attachment: () => undefined } });
	const input: ModelHostRequest = { ...request("unused"), action };
	await assert.rejects(owner.freeze({ action }), /originate/);
	await assert.rejects(owner.freeze({ ...input, actor: { ...input.actor, conversationId: `conv_${"f".repeat(32)}` } }), /originate/);
	const frozen = await owner.freeze(input); const record = prepareHostApproval("host", input, frozen, 1000);
	const question = hostApprovalQuestion(record); assert.ok(question.includes(action.summary)); assert.ok(question.includes("b".repeat(40))); assert.ok(question.includes(generation)); assert.match(question, /idle until next message/);
	assert.equal(question.split(action.summary).length - 1, 1, "summary is displayed literally once, not as JSON escapes");
	assert.ok(question.includes(`Inherited summary (context only):\n${action.summary}\n\nEnd inherited summary.`));
	assert.equal(await owner.revalidate(record), true); generation = `generation_${"c".repeat(32)}`;
	assert.equal(await owner.revalidate(record), false); assert.equal(executions, 0);
	await assert.rejects(owner.executeHuman(input), /independent consent/);
});

test("coordinator recovery freezes the exact fresh self-departure behind independent consent", async t => {
	const root = await mkdtemp(join(tmpdir(), "account-membership-")); let departure = "$first"; let invitations = 0;
	const coordinatorId = deriveConversationId("host", "coordinator");
	const manifest = { kind: "coordinator", conversationId: coordinatorId, creationKey: "coordinator", roomId: "!coordinator:test", hostSpace: "!host:test" };
	const registry = { hostId: "host", listManifests: () => [manifest], manifestByConversationId: (id: string) => id === coordinatorId ? manifest : undefined } as unknown as RelayRegistry;
	const matrix = { botUserId: "@bot:test", operatorUserId: "@owner:test", assertManagedProvenance: async (room: string, proof: unknown) => { assert.equal(room, manifest.roomId); assert.deepEqual(proof, { version: 1, hostId: "host", kind: "coordinator", creationKey: "coordinator", conversationId: coordinatorId, parentRoomId: "!host:test" }); }, operatorMembershipEvent: async () => ({ eventId: departure, sender: "@owner:test", membership: "leave" }), inviteOperator: async (room: string) => { assert.equal(room, manifest.roomId); invitations++; } } as unknown as ManagedMatrixClient;
	const client = new HostAccountClient(root, "host", "@owner:test", "NAS", { sendAccountRequest: async () => {} }); const account = new HostAccountOwner(client, registry, matrix); await account.initialize();
	t.after(async () => { await account.close(); await rm(root, { recursive: true, force: true }); });
	const owner = new ManagedHostMutationOwner({ registry, lifecycle: {} as HostLifecycle, retirement: {} as ConversationRetirement, server: { attachment: () => undefined }, account });
	const input: ModelHostRequest = { ...request("unused"), action: { operation: "coordinator.membership.restore", confirmed: true } };
	const record = prepareHostApproval("host", input, await owner.freeze(input), 1000); assert.equal(invitations, 0);
	assert.equal(await owner.revalidate(record), true); departure = "$second";
	assert.equal(await owner.revalidate(record), false); await assert.rejects(owner.execute(record), /scope changed/); assert.equal(invitations, 0);
	const fresh = prepareHostApproval("host", input, await owner.freeze(input), 1001);
	assert.deepEqual(await owner.execute(fresh), { conversationId: coordinatorId, setupState: "pending" }); assert.equal(invitations, 1);
	const saved = JSON.parse(await readFile(join(root, "account.json"), "utf8")); assert.equal(saved.records[0].action.departureEventId, "$second");
});

test("coordinator destructive previews are readable blocked scopes, never executable subsets", async () => {
	const coordinatorId = deriveConversationId("host", "coordinator"); let effects = 0;
	const owner = new ManagedHostMutationOwner({ registry: { hostId: "host" } as RelayRegistry, server: { attachment: () => undefined }, lifecycle: {} as HostLifecycle,
		retirement: { prepare: (id: string) => { assert.notEqual(id, coordinatorId); return { conversationId: id }; }, retirePrepared: async () => { effects++; } } as unknown as ConversationRetirement });
	for (const [source, apply] of [
		[{ operation: "conversation.delete.preview", conversationIds: [coordinatorId, conversationId] }, "conversation.delete.apply"],
		[{ operation: "worktree.conversation.cleanup.preview", conversationId: coordinatorId }, "worktree.conversation.cleanup.apply"],
	] as const) {
		const preview = await owner.preview(source as Parameters<typeof owner.preview>[0]); assert.ok(preview.blockers.some(b => b.includes("coordinator")));
		assert.ok(preview.targets.some(target => target.kind === "conversation" && target.conversationId === coordinatorId));
		await assert.rejects(owner.freeze({ action: { operation: apply, previewId: preview.previewId, confirmed: true } }), /Frozen targets/);
		await assert.rejects(owner.executeHuman({ version: "1.0.0", actor: { kind: "human_local", requestId: "blocked" }, action: { operation: apply, previewId: preview.previewId, confirmed: true } }), /Frozen targets/);
	}
	assert.equal(effects, 0);
});

test("branch consent uses a separate expiring preview, displays public targets and rejects changed tips", async () => {
	let now = 1000; let head = "a".repeat(40); let executed = 0;
	const options: ConstructorParameters<typeof ManagedHostMutationOwner>[0] = {
		registry: { hostId: "host" } as RelayRegistry, server: { attachment: () => undefined }, now: () => now,
		retirement: { prepare: (id: string) => ({ conversationId: id, targets: [] }) } as unknown as ConversationRetirement,
		lifecycle: { spaceApprovalPreview: async () => { throw Error("Live Space owners are unavailable"); }, branchApprovalPreview: async () => ({ checkoutId: `checkout_${"b".repeat(32)}`, plan: {
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
	assert.ok(question.includes("feature/test")); assert.ok(question.includes(head));
	assert.ok(!question.includes("Expires:"), "prose omits bookkeeping fields");
	assert.equal(record.expiresAt, now + 900_000, "expiry remains enforced internally");
	assert.ok(!question.includes("/private/repo")); assert.equal(await owner.revalidate(record), true);
	head = "d".repeat(40); assert.equal(await owner.revalidate(record), false);
	await assert.rejects(owner.execute(record), /Frozen targets/); assert.equal(executed, 0);
	head = "a".repeat(40); await owner.execute(record); assert.equal(executed, 1);
	await assert.rejects(new ManagedHostMutationOwner(options).freeze(input), /Frozen targets/, "preview cache is not a durable execution receipt");
	now += 900_001; assert.equal(await owner.revalidate(record), false); await assert.rejects(owner.freeze(input), /Frozen targets/);
	const fresh = await owner.preview(branchAction); assert.notEqual(fresh.previewId, preview.previewId);
	assert.ok(await owner.freeze(request(fresh.previewId)), "fresh preview is independent of the removed checkout and old consent");
});

test("public Space preview freezes exact live links and cannot expand approved scope", async () => {
	const link: HierarchyLink = { projectKey: `project_${"a".repeat(32)}`,
		parent: { roomId: "!host:test", provenance: { version: 1, kind: "host_space", hostId: "host", creationKey: "host" } },
		child: { roomId: "!project:test", provenance: { version: 1, kind: "project_space", hostId: "host", creationKey: `project_${"a".repeat(32)}`, projectKey: `project_${"a".repeat(32)}`, parentRoomId: "!host:test" } } };
	let links = [link]; let executions = 0; let operatorUserId = "@operator:test";
	const owner = new ManagedHostMutationOwner({ registry: { hostId: "host" } as RelayRegistry, server: { attachment: () => undefined }, now: () => 1000,
		retirement: {} as ConversationRetirement, lifecycle: {
			spaceApprovalPreview: async () => ({ links: structuredClone(links), operatorUserId, botUserId: "@bot:test" }),
			executeSpaceApproval: async (frozen: LiveSpacePreview, cleanup: boolean) => { assert.equal(cleanup, false); assert.deepEqual(frozen.links, [link]); executions++; return { remaining: 0 }; },
		} as unknown as HostLifecycle });
	const preview = await owner.preview({ operation: "space.reconcile.preview" });
	assert.deepEqual(preview.targets, [{ kind: "space", roomId: "!project:test" }, { kind: "space", roomId: "!host:test" }]);
	const input: ModelHostRequest = { ...request(preview.previewId), action: { operation: "space.reconcile.apply", previewId: preview.previewId, confirmed: true } };
	const record = prepareHostApproval("host", input, await owner.freeze(input), 1000);
	assert.ok(hostApprovalQuestion(record).includes("!project:test")); assert.ok(!hostApprovalQuestion(record).includes("creationKey"));
	links = []; assert.equal(await owner.revalidate(record), false); await assert.rejects(owner.execute(record), /Frozen targets/); assert.equal(executions, 0);
	links = [link]; operatorUserId = "@replacement:test"; assert.equal(await owner.revalidate(record), false, "account targets cannot change under old consent");
	operatorUserId = "@operator:test"; assert.equal(await owner.revalidate(record), true); await owner.execute(record); assert.equal(executions, 1);
});

test("worktree creation rechecks the frozen base inside lifecycle admission before applying anything", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "frozen-worktree-admission-")); t.after(() => rm(root, { recursive: true, force: true }));
	const calls = join(root, "calls"); const launcher = join(root, "launcher");
	const plan = { rootKey: "projects", sourceWorkspace: "main", projectWorkspace: "main", targetWorkspace: "main-feature",
		commonDir: join(root, "main", ".git"), mainPath: join(root, "main"), targetPath: join(root, "main-feature"),
		baseRef: "refs/heads/main", baseCommit: "a".repeat(40), branch: "feature/test" };
	await writeFile(launcher, `#!${process.execPath}\nconst fs = require('node:fs'); const file = ${JSON.stringify(calls)}; let count = 0; try { count = Number(fs.readFileSync(file, 'utf8')); } catch {} fs.writeFileSync(file, String(++count)); if (process.argv[3] !== 'worktree-create-preview') process.exit(99); const plan = ${JSON.stringify(plan)}; if (count >= 3) plan.baseCommit = 'b'.repeat(40); console.log(JSON.stringify(plan));\n`, { mode: 0o700 });
	const lifecycle = new HostLifecycle({ hostId: "host", launcher, projectSessionDirectory: join(root, "sessions"), socketPath: join(root, "socket"),
		registry: { manifestByCreationKey: () => undefined } as unknown as RelayRegistry, matrix: {} as ManagedMatrixClient, server: {} as ManagedSessionIpcServer });
	const action = { operation: "worktree.create" as const, creationKey: "create-feature", rootKey: "projects", workspace: "main", baseRef: "main", branch: "feature/test" };
	const frozen = await lifecycle.freezeCreation(action);
	await assert.rejects(lifecycle.executeCreation(action, frozen), /base or placement changed before admission/);
	assert.equal(await readFile(calls, "utf8"), "3", "only read-only previews run, even when the base moves after outer revalidation");
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
