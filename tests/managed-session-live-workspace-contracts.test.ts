import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { HostPolicy } from "../config/agent/extensions/managed-sessions/relay/host-policy.js";
import {
	APPROVAL_LIFETIME_MS, HOST_ERROR_EXITS, HostActionSchema, HostResultSchemas,
	parseHostAction, parseHostRequest, parseAccountAction, parseAccountAck,
	requiresModelApproval, recoverNotificationSetup, accountActionIdentity, parseHostResponse, hostActionPolicy,
} from "../config/agent/extensions/managed-sessions/live-workspace-contracts.js";

const id = (prefix: string) => `${prefix}_${"a".repeat(32)}`;
const conversationId = id("conv");
const placement = { rootKey: "projects", workspace: "harness", relativeCwd: "" };
const preview = { previewId: id("preview"), confirmed: true };
const creation = { creationKey: "create-1", title: "Repeated title is not identity" };
const workspace = { rootKey: "projects", workspace: "harness" };
const fixtures: Array<[unknown, boolean]> = [
	[{ operation: "host.status" }, false],
	[{ operation: "workspace.list", limit: 100 }, false],
	[{ operation: "project.create", ...workspace, ...creation }, true],
	[{ operation: "worktree.list", ...workspace }, false],
	[{ operation: "worktree.create", ...workspace, creationKey: "worktree-1", baseRef: "main", branch: "topic" }, true],
	[{ operation: "worktree.conversation.create", ...workspace, ...creation, baseRef: "main", branch: "topic" }, true],
	[{ operation: "worktree.conversation.fork", ...workspace, ...creation, sourceConversationId: conversationId, baseRef: "main", branch: "topic", summary: "Inherited context only" }, true],
	[{ operation: "worktree.remove.preview", ...workspace, mergeTarget: "main" }, false],
	[{ operation: "worktree.remove.apply", ...preview }, true],
	[{ operation: "worktree.conversation.cleanup.preview", conversationId }, false],
	[{ operation: "worktree.conversation.cleanup.apply", ...preview }, true],
	[{ operation: "worktree.branch.preview", ...workspace, branch: "feature/test", mergeTarget: "main" }, false],
	[{ operation: "worktree.branch.delete", ...preview }, true],
	[{ operation: "conversation.list", cursor: "opaque" }, false],
	[{ operation: "conversation.status", conversationId }, false],
	[{ operation: "conversation.create", ...creation, placement }, true],
	...["open", "resume", "stop"].map((name): [unknown, boolean] => [{ operation: `conversation.${name}`, conversationId }, true]),
	[{ operation: "conversation.admin.preview", conversationIds: [conversationId], includeSpaces: true }, false],
	[{ operation: "conversation.admin.apply", previewId: `preview_${"1".repeat(32)}`, confirmed: true }, true],
	[{ operation: "conversation.recover.preview", conversationId }, false],
	[{ operation: "conversation.recover.apply", previewId: `preview_${"1".repeat(32)}`, confirmed: true, operatorClosed: true, acceptIncompleteInspection: true }, true],
	...["refresh", "delete", "migrate"].map((name): [unknown, boolean] => [{ operation: `conversation.${name}`, conversationId, confirmed: true }, true]),
	[{ operation: "conversation.delete.preview", conversationIds: [conversationId] }, false],
	[{ operation: "conversation.delete.apply", ...preview }, true],
	...["reconcile", "cleanup"].flatMap((name): Array<[unknown, boolean]> => [
		[{ operation: `space.${name}.preview` }, false], [{ operation: `space.${name}.apply`, ...preview }, true],
	]),
	[{ operation: "coordinator.membership.restore", confirmed: true }, true],
];

test("every specified operation has an exact fixture and model mutation classification", () => {
	assert.equal(fixtures.length, HostActionSchema.anyOf.length);
	assert.equal(new Set(fixtures.map(([value]) => (value as { operation: string }).operation)).size, fixtures.length);
	for (const [fixture, approval] of fixtures) {
		const action = parseHostAction(fixture);
		assert.equal(requiresModelApproval(action), approval, action.operation);
		assert.throws(() => parseHostAction({ ...action, shell: "echo unsafe" }));
	}
	assert.equal(APPROVAL_LIFETIME_MS, 900_000);
	assert.equal(HOST_ERROR_EXITS.upgrade_required, 7);
});

test("packaged host policy classifies all actions without weakening model approval or coordinator protection", () => {
	const document = JSON.parse(readFileSync("config/agent/managed-host-policy.json", "utf8"));
	assert.deepEqual(Object.keys(document.actions).sort(), Object.keys(HostResultSchemas).sort());
	const policy = new HostPolicy(document); const protectedId = `conv_${"b".repeat(32)}`;
	for (const [action, approval] of fixtures) {
		assert.equal(policy.decide({ version: "1.0.0", action, actor: { kind: "human_local", requestId: "human-1" } }, protectedId), "direct");
		assert.equal(policy.decide({ version: "1.0.0", action, actor: { kind: "model", requestId: "model-1", conversationId,
			generationId: id("generation"), runId: "run-1", toolCallId: "call-1", presentation: "local_dialog" } }, protectedId), approval ? "approval" : "direct");
	}
	const stop = { version: "1.0.0", action: { operation: "conversation.stop", conversationId }, actor: { kind: "human_local", requestId: "stop" } };
	assert.equal(policy.decide(stop, conversationId), "forbidden");
	document.actions["conversation.stop"].human = "deny";
	assert.equal(policy.decide(stop, protectedId), "direct", "policy is immutable after construction");
	assert.equal(new HostPolicy(document).decide(stop, protectedId), "forbidden");
	delete document.actions["conversation.stop"];
	assert.equal(new HostPolicy(document).decide(stop, protectedId), "approval", "missing classification cannot grant a valid mutation");
	assert.throws(() => policy.decide({ ...stop, action: { operation: "conversation.arbitrary" } }, protectedId));
});

test("deployment policy rejects unknown fields/actions and model mutation bypasses", () => {
	for (const value of [
		{ version: "2.0.0", actions: {} },
		{ version: "1.0.0", actions: {}, runtimeEditor: true },
		{ version: "1.0.0", actions: { arbitrary: { human: "direct", model: "direct" } } },
		{ version: "1.0.0", actions: { "conversation.open": { human: "direct", model: "direct" } } },
		{ version: "1.0.0", actions: { "host.status": { human: "confirmed", model: "direct" } } },
		{ version: "1.0.0", actions: { "host.status": { human: "direct", model: "direct", argv: [] } } },
	]) assert.throws(() => new HostPolicy(value));
	for (const action of fixtures.map(([value]) => parseHostAction(value))) if ("confirmed" in action) {
		assert.throws(() => new HostPolicy({ version: "1.0.0", actions: { [action.operation]: { human: "direct", model: "approval" } } }), /confirmation policy/);
		assert.doesNotThrow(() => new HostPolicy({ version: "1.0.0", actions: { [action.operation]: { human: "deny", model: "approval" } } }));
	}
});

test("unknown operations, ambiguous IDs, forged actor fields, bounds and paths fail closed", () => {
	for (const value of [
		{ operation: "conversation.open", conversationId: "title" },
		{ operation: "conversation.open", conversationId: "conv_aaaa" },
		{ operation: "conversation.open", conversationId, actor: "operator" },
		{ operation: "conversation.open", conversationId, windowId: "@1" },
		{ operation: "conversation.restart", conversationId },
		{ operation: "conversation.delete", conversationId },
		{ operation: "conversation.delete", conversationId, confirmed: false },
		{ operation: "conversation.list", limit: 101 },
		{ operation: "conversation.list", limit: 0 },
		{ operation: "conversation.delete.preview", conversationIds: [conversationId, conversationId] },
		{ operation: "conversation.create", ...creation, placement: { ...placement, workspace: "../foreign" } },
		... ["../other", "a/../other", "/absolute", "a\\b", "a//b"].map((relativeCwd) => ({ operation: "conversation.create", ...creation, placement: { ...placement, relativeCwd } })),
	]) assert.throws(() => parseHostAction(value), JSON.stringify(value));
	assert.throws(() => parseHostRequest({ version: "2.0.0", actor: { kind: "human_local", requestId: "1" }, action: { operation: "host.status" } }));
	assert.doesNotThrow(() => parseHostRequest({ version: "1.0.0", actor: { kind: "model", requestId: "1", conversationId, generationId: id("generation"), runId: "run-1", toolCallId: "call-1", presentation: "matrix_poll", origin: { roomId: "!origin:example.org", eventId: "$event", senderUserId: "@operator:example.org" } }, action: { operation: "conversation.open", conversationId } }));
});

const account = { version: "1.0.0", hostId: "host" };
const sign = <T extends Record<string, unknown>>(body: T) => ({ ...body, ...accountActionIdentity(body) });
const ensure = sign({
	...account, operation: "room.ensure", roomId: "!conversation:example.org", kind: "conversation",
	hostSpaceId: "!host:example.org", project: { projectKey: id("project"), spaceId: "!project:example.org" },
	checkout: { checkoutId: id("checkout"), spaceId: "!checkout:example.org" },
	conversationId, creationKey: "created-1", notificationSetup: "new_room",
});

test("NAS messages pin hierarchy and narrow capabilities, never endpoints or credentials", () => {
	assert.deepEqual(parseAccountAction(ensure), ensure);
	for (const value of [
		{ ...ensure, token: "secret" }, { ...ensure, endpoint: "/arbitrary" },
		{ ...ensure, operation: "room.send" }, { ...ensure, checkout: undefined },
		{ ...ensure, conversationId: undefined }, { ...ensure, kind: "host_space" },
		{ ...account, operation: "space.retire", roomId: "!host:example.org", hostSpaceId: "!host:example.org", cleanupId: id("cleanup") },
	]) assert.throws(() => parseAccountAction(sign(value)));
	assert.doesNotThrow(() => parseAccountAction(sign({ ...account, operation: "room.retire", roomId: ensure.roomId, conversationId, retirementId: id("retirement") })));
	assert.doesNotThrow(() => parseAccountAction(sign({ ...account, operation: "coordinator.membership.restore", roomId: "!coordinator:example.org", hostSpaceId: ensure.hostSpaceId, conversationId, departureEventId: "$departure" })));
	const ack = { ...account, requestId: ensure.requestId, payloadDigest: ensure.payloadDigest, revision: 1, status: "notification_setup_uncertain" };
	assert.doesNotThrow(() => parseAccountAck(ack));
	assert.throws(() => parseAccountAck({ ...ack, token: "secret" }));
	for (const changed of [{ roomId: "!altered:example.org" }, { hostId: "other-host" }, { payloadDigest: "b".repeat(64) }, { requestId: id("account") }]) {
		assert.throws(() => parseAccountAction({ ...ensure, ...changed }));
	}
	assert.throws(() => parseAccountAck({ ...ack, hostId: "other-host" }));
	assert.deepEqual(accountActionIdentity(Object.fromEntries(Object.entries(ensure).reverse())), accountActionIdentity(ensure));
});

test("coordinator stop/delete are forbidden before approval for every actor", () => {
	const coordinator = id("conv");
	const project = `conv_${"b".repeat(32)}`;
	const actors = [
		{ kind: "human_local", requestId: "1" },
		{ kind: "human_matrix", requestId: "2", conversationId, roomId: "!origin:example.org", eventId: "$event", senderUserId: "@operator:example.org" },
		{ kind: "model", requestId: "3", conversationId, generationId: id("generation"), runId: "run", toolCallId: "call", presentation: "local_dialog" },
	];
	for (const actorValue of actors) {
		for (const action of [parseHostAction({ operation: "conversation.delete.preview", conversationIds: [coordinator] }), parseHostAction({ operation: "worktree.conversation.cleanup.preview", conversationId: coordinator })]) {
			const { actor } = parseHostRequest({ version: "1.0.0", actor: actorValue, action });
			assert.equal(hostActionPolicy(action, actor, coordinator), "direct", "read-only protected previews remain free and expose blockers");
		}
		for (const operation of ["conversation.stop", "conversation.delete", "conversation.migrate"]) {
			const action = parseHostAction({ operation, conversationId: coordinator, ...(operation !== "conversation.stop" ? { confirmed: true } : {}) });
			const { actor } = parseHostRequest({ version: "1.0.0", actor: actorValue, action });
			assert.equal(hostActionPolicy(action, actor, coordinator), "forbidden");
			assert.equal(hostActionPolicy({ ...action, conversationId: project } as typeof action, actor, coordinator), actor.kind === "model" ? "approval" : "direct");
		}
	}
});

test("Matrix provenance requires a room and valid sender, including model routing", () => {
	const origin = { roomId: "!origin:example.org", senderUserId: "@operator:example.org", eventId: "$event" };
	const model = { kind: "model", requestId: "1", conversationId, generationId: id("generation"), runId: "run", toolCallId: "call", presentation: "matrix_poll" };
	for (const invalid of [undefined, { ...origin, roomId: undefined }, { ...origin, roomId: "a title" }, { ...origin, senderUserId: "operator" }]) {
		assert.throws(() => parseHostRequest({ version: "1.0.0", actor: { ...model, origin: invalid }, action: { operation: "host.status" } }));
	}
});

test("operation-specific response fixtures reject extras, malformed errors and oversized frames", () => {
	assert.deepEqual(Object.keys(HostResultSchemas).sort(), fixtures.map(([value]) => (value as { operation: string }).operation).sort());
	const base = { version: "1.0.0", requestId: "request-1" };
	const positive = { ...base, ok: true, data: { hostId: "host", relayState: "ready", capabilities: [], accountState: "ready" } };
	assert.doesNotThrow(() => parseHostResponse("host.status", positive));
	const created = { conversationId, launchId: id("launch"), setupState: "pending" };
	const launched = { conversationId, launchId: id("launch"), launchState: "attached" };
	const cleanup = { operationId: id("operation"), cleanupState: "complete" };
	const previewData = { previewId: id("preview"), expiresAt: "2026-10-01T00:15:00.000Z", targets: [], activeRuns: [], blockers: [] };
	const resultFixtures = {
		"host.status": positive.data,
		"workspace.list": { items: [], nextCursor: null },
		"project.create": created,
		"worktree.list": { items: [], nextCursor: null },
		"worktree.create": { ...workspace, checkoutId: id("checkout") },
		"worktree.conversation.create": created,
		"worktree.conversation.fork": { ...created, roomLink: "https://matrix.to/#/!new:example.org" },
		"worktree.remove.preview": previewData, "worktree.remove.apply": cleanup,
		"worktree.conversation.cleanup.preview": previewData, "worktree.conversation.cleanup.apply": cleanup,
		"worktree.branch.preview": previewData, "worktree.branch.delete": cleanup,
		"conversation.list": { items: [], nextCursor: null },
		"conversation.status": { conversationId, kind: "coordinator", title: "Coordinator", runtimeState: "running", launchState: "attached", setupState: "ready", activeGenerationId: id("generation"), capabilities: [] },
		"conversation.create": created,
		"conversation.open": { ...launched, window: { sessionName: "default", windowId: "@1", paneId: "%1", conversationId } },
		"conversation.resume": launched, "conversation.stop": { conversationId, runtimeState: "stopped" },
		"conversation.refresh": launched,
		"conversation.migrate": { conversationId, migrationState: "awaiting_exit", message: "Close the old window manually, then repeat migration" },
		"conversation.delete": { conversationId, retirementId: id("retirement"), cleanupState: "pending" },
		"conversation.admin.preview": { previewId: `preview_${"1".repeat(32)}`, expiresAt: "2026-10-01T00:00:00.000Z", targets: [], activeRuns: [], blockers: [], warnings: ["Matrix has no conditional writes"] },
		"conversation.admin.apply": { operationId: `operation_${"1".repeat(32)}`, cleanupState: "complete" },
		"conversation.recover.preview": { previewId: `preview_${"1".repeat(32)}`, expiresAt: "2026-10-01T00:00:00.000Z", targets: [], activeRuns: [], blockers: [], warnings: ["Operator confirmation, not verified exit"] },
		"conversation.recover.apply": { operationId: `operation_${"1".repeat(32)}`, cleanupState: "complete" },
		"conversation.delete.preview": previewData, "conversation.delete.apply": cleanup,
		"space.reconcile.preview": previewData, "space.reconcile.apply": cleanup,
		"space.cleanup.preview": previewData, "space.cleanup.apply": cleanup,
		"coordinator.membership.restore": { conversationId, setupState: "ready" },
	} satisfies Record<keyof typeof HostResultSchemas, unknown>;
	for (const operation of Object.keys(resultFixtures) as Array<keyof typeof HostResultSchemas>) {
		const data = resultFixtures[operation];
		assert.doesNotThrow(() => parseHostResponse(operation, { ...base, ok: true, data }), operation);
		assert.throws(() => parseHostResponse(operation, { ...base, ok: true, data: { ...data, unexpected: true } }), operation);
	}
	assert.throws(() => parseHostResponse("host.status", { ...positive, data: { ...positive.data, token: "secret" } }));
	assert.throws(() => parseHostResponse("conversation.status", positive));
	for (const code of Object.keys(HOST_ERROR_EXITS)) {
		assert.doesNotThrow(() => parseHostResponse("host.status", { ...base, ok: false, error: { code, message: "bounded diagnostic", retryable: false } }));
	}
	for (const error of [{ code: "unknown", message: "error", retryable: false }, { code: "failed", message: "x".repeat(513), retryable: false }, { code: "failed", message: "error", retryable: false, stack: "private" }]) {
		assert.throws(() => parseHostResponse("host.status", { ...base, ok: false, error }));
	}
	assert.doesNotThrow(() => parseHostResponse("conversation.list", { ...base, ok: true, data: { items: [], nextCursor: null } }));
	assert.throws(() => parseHostResponse("conversation.list", { ...base, ok: true, data: { items: [], nextCursor: "x".repeat(257) } }));
	const summary = { conversationId, title: "日".repeat(128), kind: "project", checkoutId: id("checkout"), projectKey: id("project"), runtimeState: "running", launchState: "attached", setupState: "ready", activeGenerationId: id("generation"), capabilities: [] };
	assert.throws(() => parseHostResponse("conversation.list", { ...base, ok: true, data: { items: Array(100).fill(summary), nextCursor: null } }), /64 KiB/);
});

test("notification initialization recovery never converts an uncertain attempt to a retry", () => {
	assert.equal(recoverNotificationSetup("attempted"), "uncertain");
	for (const state of ["unattempted", "confirmed", "uncertain", "preserved"] as const) assert.equal(recoverNotificationSetup(state), state);
});
