import assert from "node:assert/strict";
import test from "node:test";
import { NativeHostRun } from "../config/agent/extensions/managed-sessions/adapter/host-run.js";
import type { BoundAdapterClient } from "../config/agent/extensions/managed-sessions/adapter/client.js";
import type { HostRunWitness } from "../config/agent/extensions/managed-sessions/host-run-contracts.js";
import type { ManagedSessionEnvelope } from "../config/agent/extensions/managed-sessions/contracts.js";

const generationId = `generation_${"a".repeat(32)}`;
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function fixture(confirm: (question: string, signal: AbortSignal, timeout: number) => Promise<boolean>) {
	const proofs: Array<HostRunWitness | null> = []; const answers: unknown[] = []; const observations: HostRunWitness[] = [];
	let sources: HostRunWitness["sources"] = [{ kind: "local" }];
	const client = { supports: () => true, confirmHostRun: async (_id: string, witness: HostRunWitness | null) => { proofs.push(witness); },
		answerHostApproval: async (answer: unknown) => { answers.push(answer); }, observeHostRun: async (witness: HostRunWitness) => { observations.push(witness); } } as unknown as BoundAdapterClient;
	const run = new NativeHostRun({ client: () => client, sources: () => sources, confirm });
	run.begin(generationId); run.userMessage(); run.toolStart("native-tool-id");
	const show = (id = "a"): ManagedSessionEnvelope => ({ protocolVersion: "1.0.0", messageId: "show", role: "relay", conversationId: `conv_${"a".repeat(32)}`, type: "host.approval.show",
		payload: { ...run.identity("native-tool-id")!, approvalId: `approval_${id.repeat(32)}`, question: "Exact operation?", expiresAt: Date.now() + 10000 } });
	return { run, proofs, answers, observations, show, setSources: (value: HostRunWitness["sources"]) => { sources = value; } };
}

test("native dialog does not block fresh proofs; normal denial answers only the live exact tool", async () => {
	let finish!: (value: boolean) => void;
	const f = fixture(async () => new Promise<boolean>((resolve) => { finish = resolve; }));
	await f.run.receive(f.show()); await tick();
	await f.run.receive({ ...f.show(), type: "host.run.check", payload: { checkId: "fresh" } });
	assert.equal(f.proofs.length, 1); assert.equal(f.proofs[0]?.toolCallIds.length, 1); assert.notEqual(f.proofs[0]?.toolCallIds[0], "native-tool-id");
	finish(false); await tick(); assert.equal((f.answers[0] as { choice: string }).choice, "deny");
	f.run.toolEnd("native-tool-id"); assert.equal(f.run.identity("native-tool-id"), undefined); f.run.reset();
});

test("native run/tool end aborts only its pending dialogs and cannot send a late approval", async () => {
	let signal!: AbortSignal; let finish!: (value: boolean) => void;
	const f = fixture(async (_question, value) => { signal = value; return new Promise<boolean>((resolve) => { finish = resolve; }); });
	await f.run.receive(f.show()); await tick(); f.run.toolEnd("native-tool-id");
	assert.equal(signal.aborted, true); finish(true); await tick(); assert.deepEqual(f.answers, []);
	f.run.end(); assert.equal(f.run.snapshot(), null); await tick(); assert.equal(f.observations.at(-1)?.phase, "ended");
});

test("native abort revokes liveness before a waiting tool has returned", async () => {
	let signal!: AbortSignal; let finish!: (value: boolean) => void;
	const f = fixture(async (_question, value) => { signal = value; return new Promise<boolean>((resolve) => { finish = resolve; }); });
	const abort = new AbortController(); f.run.begin(generationId, abort.signal); f.run.userMessage(); f.run.toolStart("native-tool-id");
	await f.run.receive(f.show()); await tick(); abort.abort();
	assert.equal(f.run.snapshot(), null); assert.equal(signal.aborted, true); finish(true); await tick(); assert.deepEqual(f.answers, []); f.run.reset();
});

test("Matrix/mixed origin cannot display a local approval and run identity never survives reset", async () => {
	let dialogs = 0; const f = fixture(async () => { dialogs++; return true; });
	const previous = f.run.identity("native-tool-id");
	f.setSources([{ kind: "local" }, { kind: "matrix", deliveryId: `delivery_${"b".repeat(32)}` }]);
	await f.run.receive(f.show()); await tick(); assert.equal(dialogs, 0); assert.deepEqual(f.answers, []);
	f.run.reset(); f.run.begin(generationId); f.run.toolStart("native-tool-id");
	assert.notEqual(f.run.identity("native-tool-id")?.runId, previous?.runId); assert.deepEqual(f.run.snapshot()?.sources, []); f.run.reset();
});

test("simultaneous dialogs serialize without holding up wire intake; overflow fails closed", async () => {
	const finish: Array<(value: boolean) => void> = []; let shown = 0;
	const f = fixture(async () => { shown++; return new Promise<boolean>((resolve) => { finish.push(resolve); }); });
	await f.run.receive(f.show("a")); await f.run.receive(f.show("b")); await tick(); assert.equal(shown, 1);
	finish[0](true); await tick(); assert.equal(shown, 2); finish[1](false); await tick(); assert.equal(f.answers.length, 2);
	for (let i = 0; i < 65; i++) f.run.toolStart(`tool-${i}`);
	assert.equal(f.run.snapshot(), null); f.run.reset();
});
