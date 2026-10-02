import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HostApprovalRuntime } from "../config/agent/extensions/managed-sessions/relay/host-approval-runtime.js";
import { NativeHostRun } from "../config/agent/extensions/managed-sessions/adapter/host-run.js";
import type { BoundAdapterClient } from "../config/agent/extensions/managed-sessions/adapter/client.js";
import { HostApprovalStore } from "../config/agent/extensions/managed-sessions/relay/host-approval-store.js";
import { HostPolicy } from "../config/agent/extensions/managed-sessions/relay/host-policy.js";
import type { ManagedSessionEnvelope } from "../config/agent/extensions/managed-sessions/contracts.js";
import type { AcceptedAttachment } from "../config/agent/extensions/managed-sessions/relay/registry.js";
import { deriveGenerationId } from "../config/agent/extensions/managed-sessions/v2-contracts.js";

const conversationId = `conv_${"a".repeat(32)}`; const target = `conv_${"b".repeat(32)}`;
const attachment: AcceptedAttachment = { conversationId, attachmentId: "peer-1", generation: 1, role: "ordinary_adapter", state: "active" };
const packet = (type: string, payload: Record<string, unknown>): ManagedSessionEnvelope => ({ protocolVersion: "1.0.0", role: "ordinary_adapter", conversationId, messageId: "call", type, payload });

test("native run, authenticated frontend and public dispatcher require exact live consent through execution", { timeout: 10000 }, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "host-native-front-")); const store = new HostApprovalStore(root, "host"); await store.load();
	const policy = new HostPolicy(JSON.parse(readFileSync("config/agent/managed-host-policy.json", "utf8")));
	let controls!: HostApprovalRuntime; let effects = 0; let prompts = 0; let approve!: (answer: boolean) => void;
	let shown!: () => void; let ready = new Promise<void>((resolve) => { shown = resolve; });
	const client = { supports: () => true,
		confirmHostRun: async (checkId: string, witness: unknown) => { await controls.handle(packet("host.run.confirm", { checkId, witness }), attachment); },
		observeHostRun: async (witness: unknown) => { await controls.handle(packet("host.run.observe", { witness }), attachment); },
		answerHostApproval: async (answer: Record<string, unknown>) => { await controls.handle(packet("host.approval.answer", answer), attachment); },
	} as unknown as BoundAdapterClient;
	const native = new NativeHostRun({ client: () => client, sources: () => [{ kind: "local" }], confirm: async (_question, signal) => {
		prompts++; shown(); return new Promise<boolean>((resolve) => { approve = resolve; signal.addEventListener("abort", () => resolve(false), { once: true }); });
	} });
	controls = new HostApprovalRuntime({ hostId: "host", protectedConversationId: `conv_${"c".repeat(32)}`, policy, store, operatorUserIds: new Set(),
		matrix: { startPoll: async () => { throw Error("Wrong presentation route"); }, endPoll: async () => "$closed",
			memberJoined: async () => false, checkpointPollAnswer: async () => undefined },
		owner: { freeze: async (request) => ({ effects: [request.action], preconditions: {} }), revalidate: async () => true,
			execute: async () => { effects++; return { conversationId: target, runtimeState: "stopped" }; } },
		read: async () => { throw Error("Not a read"); },
		attachment: () => attachment, capable: () => true, room: () => undefined, acceptedInput: () => undefined,
		send: (envelope) => { void native.receive(envelope); return true; } });
	t.after(async () => { native.reset(); await controls.close(); await rm(root, { recursive: true, force: true }); });
	native.begin(deriveGenerationId(conversationId, 1)); native.userMessage(); native.toolStart("tool-1");
	const request = () => controls.handle(packet("host.request", { ...native.identity("tool-1")!, requestId: `request-${prompts}`, action: { operation: "conversation.stop", conversationId: target } }), attachment);
	const first = request(); await ready; assert.equal(effects, 0); approve(false);
	const denied = await first; assert.equal((denied?.payload.response as { error: { code: string } }).error.code, "denied"); assert.equal(effects, 0);
	// A new native tool call—not automatic retry—gets fresh consent.
	native.toolEnd("tool-1"); native.toolStart("tool-1"); ready = new Promise<void>((resolve) => { shown = resolve; });
	const second = request(); await ready; approve(true); assert.equal((await second)?.payload.operation, "conversation.stop"); assert.equal(effects, 1);
	ready = new Promise<void>((resolve) => { shown = resolve; }); native.toolEnd("tool-1"); native.toolStart("tool-1");
	const third = request(); await ready; native.end(); approve(true);
	assert.equal(((await third)?.payload.response as { ok: boolean }).ok, false); assert.equal(effects, 1); assert.equal(store.list().length, 0);
});
