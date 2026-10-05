import assert from "node:assert/strict";
import test from "node:test";
import { AdapterTitleSync, TITLE_ENTRY } from "../config/agent/extensions/managed-sessions/adapter/title-sync.js";
import type { BoundAdapterClient } from "../config/agent/extensions/managed-sessions/adapter/client.js";
import { deriveConversationId } from "../config/agent/extensions/managed-sessions/contracts.js";
const conversationId = deriveConversationId("host", "titles");

test("native title synchronization is metadata only, suppresses delayed echoes and never submits cached names", async () => {
	const entries: any[] = []; let name = "Cached stale name"; let value = { title: "Host title", revision: 1 }; const observations: unknown[] = [];
	let capable = true, valid = true; let sync!: AdapterTitleSync;
	const client = { connected: true, supports: () => capable, title: async (sequence?: number, title?: string) => {
		if (sequence !== undefined) { observations.push({ sequence, title }); value = { title: title!, revision: value.revision + 1 }; } return value;
	} } as unknown as BoundAdapterClient;
	const options = { conversationId, sessionId: "source", entries, valid: () => valid, client: () => client,
		persist: (state: unknown) => { entries.push({ type: "custom", customType: TITLE_ENTRY, data: structuredClone(state) }); },
		currentName: () => name, setName: (next: string) => { name = next; queueMicrotask(() => sync.onName(next)); } };
	sync = new AdapterTitleSync(options); sync.connected(); await sync.settled(); await Promise.resolve();
	assert.equal(name, "Host title"); assert.equal(observations.length, 0, "cached startup name is not a new observation");
	name = "Human rename"; sync.onName(name); await sync.settled(); assert.equal(observations.length, 1);
	sync.receive({ title: "Matrix rename", revision: 3 }); await Promise.resolve(); assert.equal(name, "Matrix rename"); assert.equal(observations.length, 1);
	sync.receive({ title: "old update", revision: 2 }); assert.equal(name, "Matrix rename");
	assert.throws(() => sync.receive({ title: "conflict", revision: 3 }), /Conflicting/);
	sync.close(); value = { title: "Matrix rename", revision: 3 }; sync = new AdapterTitleSync(options); sync.connected(); await sync.settled(); assert.equal(observations.length, 1);
	valid = false; name = "stale closure"; sync.onName(name); sync.receive({ title: "late update", revision: 4 }); assert.equal(name, "stale closure"); sync.close();
	valid = true; capable = false; sync = new AdapterTitleSync(options); sync.connected(); name = "legacy"; sync.onName(name); assert.equal(observations.length, 1); sync.close();
});

test("native pending metadata survives lost acknowledgement but never crosses a copied session identity", async () => {
	const entries: any[] = []; let name = "Original"; let offline = false; let calls = 0;
	const client = { connected: true, supports: () => true, title: async (sequence?: number, title?: string) => {
		if (sequence !== undefined) { calls++; if (offline) throw Error("response lost"); return { title: title!, revision: 2 }; } return { title: "Original", revision: 1 };
	} } as unknown as BoundAdapterClient;
	const options = { conversationId, sessionId: "source", entries, valid: () => true, client: () => client,
		persist: (state: unknown) => { entries.push({ type: "custom", customType: TITLE_ENTRY, data: structuredClone(state) }); }, currentName: () => name, setName: (next: string) => { name = next; } };
	let sync = new AdapterTitleSync(options); sync.connected(); await sync.settled(); offline = true; name = "Pending"; sync.onName(name); await sync.settled(); sync.close();
	assert.ok(entries.at(-1).data.pending); offline = false; sync = new AdapterTitleSync(options); sync.connected(); await sync.settled(); sync.close();
	assert.equal(calls, 2); assert.equal(entries.at(-1).data.pending, undefined);
	sync = new AdapterTitleSync({ ...options, sessionId: "fork" }); sync.connected(); await sync.settled(); assert.equal(calls, 2); sync.close();
});

test("returning to the previous title while another observation is in flight remains a fresh intent", async () => {
	let name = "A", release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); const observed: string[] = [];
	const client = { connected: true, supports: () => true, title: async (sequence?: number, title?: string) => {
		if (sequence === undefined) return { title: "A", revision: 1 }; observed.push(title!); if (sequence === 1) await gate; return { title: title!, revision: sequence + 1 };
	} } as unknown as BoundAdapterClient;
	const sync = new AdapterTitleSync({ conversationId, sessionId: "source", entries: [], valid: () => true, client: () => client,
		persist: () => undefined, currentName: () => name, setName: next => { name = next; } });
	sync.connected(); await sync.settled(); name = "B"; sync.onName(name); name = "A"; sync.onName(name); release(); await sync.settled(); await sync.settled();
	assert.deepEqual(observed, ["B", "A"]); assert.equal(name, "A"); sync.close();
});

test("a failed native metadata persistence cannot leak an unjournaled observation", async () => {
	let name = "A", fail = false, calls = 0;
	const client = { connected: true, supports: () => true, title: async (sequence?: number) => { if (sequence !== undefined) calls++; return { title: "A", revision: 1 }; } } as unknown as BoundAdapterClient;
	const sync = new AdapterTitleSync({ conversationId, sessionId: "source", entries: [], valid: () => true, client: () => client,
		persist: () => { if (fail) throw Error("disk failed"); }, currentName: () => name, setName: next => { name = next; } });
	sync.connected(); await sync.settled(); fail = true; name = "B"; assert.throws(() => sync.onName(name), /disk failed/); sync.flush(); await sync.settled(); assert.equal(calls, 0); sync.close();
});
