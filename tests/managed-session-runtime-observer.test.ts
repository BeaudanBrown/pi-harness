import assert from "node:assert/strict";
import test from "node:test";
import { HostRuntimeObserver, type RuntimeObservationSource } from "../config/agent/extensions/managed-sessions/relay/runtime-observer.js";
import { deriveConversationId } from "../config/agent/extensions/managed-sessions/contracts.js";

const source = (i = 0): RuntimeObservationSource => {
	const conversationId = deriveConversationId("host", `runtime-${i}`); const generationId = `generation_${"a".repeat(32)}`; const launchId = `launch_${i.toString(16).padStart(32, "0")}`;
	return { hostId: "host", conversationId, generationId, piSessionId: `session-${i}`, attached: true, attachmentId: `attachment-${i}`, state: "active", failed: false, transitioning: false, managedWindow: true,
		launch: { launchId, generationId }, window: { conversationId, launchId, serverId: `123:456:${"b".repeat(32)}`, sessionName: "workspace", windowId: `@${i}`, paneId: `%${i}`, panePid: "789", processBootId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", processStartTicks: "1234" } };
};
const observed = (proofs: NonNullable<RuntimeObservationSource["window"]>[], state: "running" | "stopped" | "unknown" = "running") => proofs.map(p => ({ conversationId: p.conversationId, launchId: p.launchId, state }));

test("host observer coalesces event/timer triggers, reuses snapshots and drains shutdown", async () => {
	let now = 0, calls = 0, unsubscribe = false, cleared = false; let tick!: () => void; let changed!: () => void; let release!: () => void;
	const blocked = new Promise<void>(resolve => { release = resolve; }); const row = source();
	const observer = new HostRuntimeObserver({ hostId: "host", sources: () => [structuredClone(row)], now: () => now,
		every: (ms, cb) => { assert.equal(ms, 10_000); tick = cb; return () => { cleared = true; }; },
		subscribe: cb => { changed = cb; return () => { unsubscribe = true; }; },
		windows: { observe: async proofs => { if (++calls === 1) await blocked; return observed([...proofs]); } } });
	observer.start(); observer.start(); await Promise.resolve(); assert.equal(calls, 1);
	for (let i = 0; i < 20; i++) { changed(); tick(); }
	release(); await observer.settled(); assert.equal(calls, 2, "overlap creates one follow-up, never a queue per trigger");
	for (let i = 0; i < 20; i++) assert.equal(observer.snapshot().get(row.conversationId)?.runtimeState, "running");
	assert.equal(calls, 2, "reads reuse local evidence without launching checks");
	now = 10_000; tick(); await observer.settled(); assert.equal(calls, 3);
	now = 30_000; assert.equal(observer.snapshot().get(row.conversationId)?.runtimeState, "unknown", "stale evidence expires without inventing stopped");
	await observer.close(); tick(); changed(); await observer.settled(); assert.equal(calls, 3); assert.ok(unsubscribe && cleared);
});

test("observer batches own host only and requires matching generation/launch ownership", async () => {
	const rows = Array.from({ length: 65 }, (_, i) => source(i)); const foreign = { ...source(100), hostId: "foreign" }; const stale = source(101); stale.launch!.generationId = "generation_old";
	const legacy = source(102); delete legacy.window;
	const transitioning = { ...source(103), transitioning: true };
	const local = source(104); delete local.launch; delete local.window; local.managedWindow = false;
	const sizes: number[] = [];
	const observer = new HostRuntimeObserver({ hostId: "host", sources: () => [...rows, foreign, stale, legacy, transitioning, local], windows: { observe: async proofs => { sizes.push(proofs.length); return observed([...proofs]); } } });
	observer.kick(); await observer.settled(); const result = observer.snapshot();
	assert.deepEqual(sizes, [64, 1]); assert.equal(result.has(foreign.conversationId), false);
	for (const row of [stale, legacy, transitioning]) assert.equal(result.get(row.conversationId)?.runtimeState, "unknown");
	assert.equal(result.get(local.conversationId)?.runtimeState, "running"); await observer.close();
});

test("unknown, dead retained pane and failed launch are not reported running from attachment alone", async () => {
	const row = source(); let unavailable = false; let state: "running" | "stopped" | "unknown" = "stopped";
	const observer = new HostRuntimeObserver({ hostId: "host", sources: () => [row], windows: { observe: async proofs => { if (unavailable) throw Error("old launcher"); return observed([...proofs], state); } } });
	observer.kick(); await observer.settled(); assert.equal(observer.snapshot().get(row.conversationId)?.runtimeState, "stopped");
	state = "unknown"; observer.kick(); await observer.settled(); assert.equal(observer.snapshot().get(row.conversationId)?.runtimeState, "unknown");
	row.failed = true; unavailable = true; observer.kick(); await observer.settled(); assert.deepEqual(observer.snapshot().get(row.conversationId), { runtimeState: "unknown", launchState: "failed" });
	unavailable = false; state = "running"; observer.kick(); await observer.settled();
	assert.deepEqual(observer.snapshot().get(row.conversationId), { runtimeState: "unknown", launchState: "failed" }, "a retained failed launch shell is not a healthy running Pi"); await observer.close();
});

test("late observations cannot cross attachment, generation, retirement or exact-window changes", async () => {
	for (const change of ["attachment", "generation", "window", "retirement"] as const) {
		let row: RuntimeObservationSource | undefined = source(); let release!: () => void;
		const wait = new Promise<void>(resolve => { release = resolve; });
		const observer = new HostRuntimeObserver({ hostId: "host", sources: () => row ? [structuredClone(row)] : [], windows: { observe: async proofs => { await wait; return observed([...proofs]); } } });
		observer.kick(); await Promise.resolve();
		if (change === "attachment") row.attachmentId = "new";
		if (change === "generation") row.generationId = "new";
		if (change === "window") row.window!.paneId = "%99";
		if (change === "retirement") row = undefined;
		release(); await observer.settled(); assert.notEqual(observer.snapshot().get(source().conversationId)?.runtimeState, "running"); await observer.close();
	}
});

test("shutdown waits only for the in-flight batch and never publishes its late result", async () => {
	let release!: () => void; let calls = 0; const wait = new Promise<void>(resolve => { release = resolve; });
	const rows = Array.from({ length: 65 }, (_, i) => source(i));
	const observer = new HostRuntimeObserver({ hostId: "host", sources: () => rows, windows: { observe: async proofs => { calls++; await wait; return observed([...proofs]); } } });
	observer.kick(); await Promise.resolve(); const closing = observer.close(); release(); await closing;
	assert.equal(calls, 1); assert.equal(observer.snapshot().get(rows[0]!.conversationId)?.runtimeState, "unknown");
});
