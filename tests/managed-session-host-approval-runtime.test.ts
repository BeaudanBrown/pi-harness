import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostApprovalRuntime } from "../config/agent/extensions/managed-sessions/relay/host-approval-runtime.js";
import { HostApprovalStore } from "../config/agent/extensions/managed-sessions/relay/host-approval-store.js";
import { HostPolicy } from "../config/agent/extensions/managed-sessions/relay/host-policy.js";
import { NativeHostRun } from "../config/agent/extensions/managed-sessions/adapter/host-run.js";
import type { BoundAdapterClient } from "../config/agent/extensions/managed-sessions/adapter/client.js";
import type { ManagedSessionEnvelope } from "../config/agent/extensions/managed-sessions/contracts.js";
import type { AcceptedAttachment } from "../config/agent/extensions/managed-sessions/relay/registry.js";
import { deriveGenerationId } from "../config/agent/extensions/managed-sessions/v2-contracts.js";

const id = (prefix: string, letter = "a") => `${prefix}_${letter.repeat(32)}`;
const conversationId = id("conv"); const target = id("conv", "b"); const roomId = "!origin:example.com";
const operator = "@operator:example.com"; const participant = "@participant:example.com";
const attachment: AcceptedAttachment = { conversationId, attachmentId: "peer", generation: 1, role: "ordinary_adapter", state: "active" };
const packet = (type: string, payload: Record<string, unknown>): ManagedSessionEnvelope => ({ protocolVersion: "1.0.0", role: "ordinary_adapter", conversationId, messageId: "call", type, payload });
async function until(predicate: () => boolean) {
	for (let attempt = 0; attempt < 200; attempt++) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 5)); }
	assert.fail("approval did not reach its expected phase");
}

test("composed Matrix approval routes the original participant request but only an operator can consume frozen consent", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "host-approval-runtime-")); const store = new HostApprovalStore(root, "host"); await store.load();
	let runtime!: HostApprovalRuntime; let effects = 0; let valid = true; let polls = 0; const questions: string[] = [];
	const client = { supports: () => true,
		confirmHostRun: async (checkId: string, witness: unknown) => { await runtime.handle(packet("host.run.confirm", { checkId, witness }), attachment); },
		observeHostRun: async (witness: unknown) => { await runtime.handle(packet("host.run.observe", { witness }), attachment); },
	} as unknown as BoundAdapterClient;
	const native = new NativeHostRun({ client: () => client, sources: () => [{ kind: "matrix", deliveryId: id("delivery") }],
		confirm: async () => { throw Error("Matrix-origin call must not use a local dialog"); } });
	runtime = new HostApprovalRuntime({ hostId: "host", protectedConversationId: id("conv", "c"), store,
		policy: new HostPolicy(JSON.parse(readFileSync("config/agent/managed-host-policy.json", "utf8"))), operatorUserIds: new Set([operator]),
		matrix: { startPoll: async (room, _transaction, question) => { assert.equal(room, roomId); questions.push(question); return `$poll-${++polls}`; },
			endPoll: async () => "$closed", memberJoined: async () => true,
			checkpointPollAnswer: async (_room, _poll, answer) => answer === "approve" ? "Approve" : "Deny" },
		owner: { freeze: async (request) => ({ effects: [request.action], preconditions: { privateNonce: "not-for-display" } }),
			revalidate: async () => valid, execute: async () => { effects++; return { conversationId: target, runtimeState: "stopped" }; } },
		read: async () => { throw Error("Not a read"); }, attachment: () => attachment, capable: () => true, room: () => roomId,
		acceptedInput: () => ({ deliveryId: id("delivery"), roomId, eventId: "$original", senderUserId: participant, status: "persisted" }),
		send: (envelope) => { void native.receive(envelope); return true; } });
	t.after(async () => { native.reset(); await runtime.close(); await rm(root, { recursive: true, force: true }); });
	native.begin(deriveGenerationId(conversationId, 1)); native.userMessage(); native.toolStart("tool");
	const request = () => runtime.handle(packet("host.request", { ...native.identity("tool")!, requestId: `request-${polls}`,
		action: { operation: "conversation.stop", conversationId: target } }), attachment);
	const vote = (senderUserId: string, poll = polls) => runtime.vote({ conversationId, roomId, pollEventId: `$poll-${poll}`, answerId: "approve", senderUserId, eventId: "$vote" });
	const first = request(); await until(() => store.list()[0]?.phase === "presented");
	assert.equal(effects, 0); assert.equal(await vote(participant), false);
	assert.ok(!questions[0]!.includes("not-for-display"));
	assert.equal((await Promise.all([vote(operator), vote(operator)])).filter(Boolean).length, 1);
	assert.equal(((await first)?.payload.response as { ok: boolean }).ok, true); assert.equal(effects, 1); assert.equal(store.list().length, 0);
	assert.equal(await vote(operator), false, "late consent cannot replay execution");

	native.toolEnd("tool"); native.toolStart("tool"); valid = false;
	const stale = request(); await until(() => store.list()[0]?.phase === "presented"); await vote(operator);
	assert.equal(((await stale)?.payload.response as { error: { code: string } }).error.code, "stale_preview"); assert.equal(effects, 1);

	native.toolEnd("tool"); native.toolStart("tool"); valid = true;
	const cancelled = request(); await until(() => store.list()[0]?.phase === "presented"); runtime.cancelRun(conversationId);
	assert.equal(((await cancelled)?.payload.response as { error: { code: string } }).error.code, "cancelled");
	assert.equal(await vote(operator), false); assert.equal(effects, 1); assert.equal(store.list().length, 0);
});
