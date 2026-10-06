import assert from "node:assert/strict";
import test from "node:test";
import { deriveConversationId, deriveTranscriptEntryId } from "../config/agent/extensions/managed-sessions/contracts.js";
import { eligibleTranscriptEntries, type SessionBinding } from "../config/agent/extensions/managed-sessions/adapter/state.js";
import { AdapterTree } from "../config/agent/extensions/managed-sessions/adapter/tree.js";
import { TREE_ENTRY_TYPE, TREE_NOTICE, latestTreeChange, treeBoundaryIndex, type TreeChange } from "../config/agent/extensions/managed-sessions/adapter/tree-boundary.js";
const binding: SessionBinding = { version: "1.0.0", conversationId: deriveConversationId("host", "tree"), sessionId: "session", role: "ordinary_adapter", concept: "Tree", bindingBoundaryEntryId: deriveTranscriptEntryId("session", "binding-root") };
const data: TreeChange = { version: "1.0.0", conversationId: binding.conversationId, sessionId: binding.sessionId, bindingBoundaryEntryId: binding.bindingBoundaryEntryId, operationId: "tree-one", phase: "prepared", oldLeafId: "old", targetId: "target" };
const marker = (id: string, value: TreeChange = data) => ({ id, type: "custom", customType: TREE_ENTRY_TYPE, data: value });
const message = (id: string, body: string) => ({ id, type: "message", message: { role: "user", content: body } });

function controllerFixture() {
	const entries: any[] = []; let branch: any[] = [{ id: "old" }]; let idle = false; let failComplete = false; let failPrepare = false;
	const requests: Array<{ phase: string; cancelled?: boolean }> = [];
	const options = { binding, entries: () => entries, branch: () => branch, idle: () => idle, valid: () => true, diagnostic: () => undefined,
		append: (kind: string, data: unknown) => { const entry = { id: `entry-${entries.length}`, type: "custom", customType: kind, data: structuredClone(data) }; entries.push(entry); branch.push(entry); return entry.id; },
		ensureBinding: () => undefined,
		request: async (_id: string, phase: "prepare" | "complete", cancelled?: boolean) => { requests.push({ phase, cancelled }); if (phase === "prepare" ? failPrepare : failComplete) throw Error("response unavailable"); } };
	return { entries, requests, options, changeBranch: () => { branch = [{ id: "target" }]; }, setIdle: () => { idle = true; },
		failComplete: (value: boolean) => { failComplete = value; }, failPrepare: () => { failPrepare = true; } };
}

test("relay fence without matching local intent holds input rather than treating missing metadata as a clean session", async t => {
	const f = controllerFixture(); const owner = new AdapterTree(f.options); t.after(() => owner.close());
	await assert.rejects(owner.recover("tree-lost-journal"), /no matching native journal/); assert.equal(owner.pending, true); assert.equal(f.requests.length, 0);
});

test("tree commit holds input until durable metadata and relay completion, then reconnect does not reset receipts", async t => {
	const f = controllerFixture(); const owner = new AdapterTree(f.options); t.after(() => owner.close());
	assert.equal(await owner.prepare("old", "target", new AbortController().signal), true); assert.equal(owner.pending, true);
	let admitted = false; const input = owner.ready().then(() => { admitted = true; }); await Promise.resolve(); assert.equal(admitted, false);
	f.changeBranch(); await owner.committed("old"); await input; assert.equal(admitted, true);
	assert.deepEqual(f.entries.map(entry => entry.data.phase), ["prepared", "committed"]);
	await owner.recover(); assert.equal(f.requests.length, 2, "ordinary reconnect does not replay completed reconciliation");
});

test("tree lost completion acknowledgement recovers without replaying navigation or appending another marker", async t => {
	const f = controllerFixture(); let owner = new AdapterTree(f.options); t.after(() => owner.close());
	await owner.prepare("old", "target", new AbortController().signal); f.changeBranch(); f.failComplete(true); await owner.committed("old");
	assert.equal(owner.pending, true); owner.close(); f.failComplete(false); owner = new AdapterTree(f.options); await owner.recover();
	assert.equal(owner.pending, false); assert.equal(f.entries.length, 2); assert.deepEqual(f.requests.map(row => row.phase), ["prepare", "complete", "complete"]);
});

test("abort requests cannot release input before SDK idle proves the source branch unchanged", async t => {
	const f = controllerFixture(); const owner = new AdapterTree(f.options); t.after(() => owner.close()); const abort = new AbortController();
	await owner.prepare("old", "target", abort.signal); abort.abort(); await owner.recover(); assert.equal(owner.pending, true); assert.equal(f.requests.length, 1);
	f.setIdle(); await owner.recover(); assert.equal(owner.pending, false); assert.equal(f.entries.at(-1).data.phase, "cancelled"); assert.equal(f.requests.at(-1)?.cancelled, true);
});

test("older SDKs without a tree-idle signal hold interrupted navigation until restart instead of guessing", async t => {
	const f = controllerFixture(); f.setIdle(); let owner = new AdapterTree(f.options); t.after(() => owner.close()); const abort = new AbortController();
	await owner.prepare("old", "target", abort.signal, false); abort.abort(); await owner.recover();
	assert.equal(owner.pending, true); assert.equal(owner.navigating, true); assert.equal(f.requests.length, 1);
	owner.close(); owner = new AdapterTree(f.options); await owner.recover(); assert.equal(owner.pending, false);
});

test("restart cancels only a provably unchanged tree prepare; unproven partial navigation stays held", async t => {
	for (const changed of [false, true]) {
		const f = controllerFixture(); let owner = new AdapterTree(f.options); t.after(() => owner.close());
		await owner.prepare("old", "target", new AbortController().signal); owner.close(); if (changed) f.changeBranch(); owner = new AdapterTree(f.options);
		if (changed) { await assert.rejects(owner.recover(), /Unproven/); assert.equal(owner.pending, true); }
		else { await owner.recover(); assert.equal(owner.pending, false); assert.equal(f.requests.at(-1)?.cancelled, true); }
	}
});

test("a failed prepare is cancelled explicitly rather than leaving a phantom delivery fence", async t => {
	const f = controllerFixture(); f.failPrepare(); const owner = new AdapterTree(f.options); t.after(() => owner.close());
	assert.equal(await owner.prepare("old", "target", new AbortController().signal), false); assert.equal(owner.pending, false);
	assert.equal(f.requests.at(-1)?.cancelled, true);
});

test("tree projection uses the newest committed boundary even before the original binding branch", () => {
	const first = marker("boundary-one", { ...data, phase: "committed" });
	const branch = [message("target", "historical user"), first, message("new-user", "new activity")];
	assert.equal(treeBoundaryIndex(branch, binding), 1);
	assert.deepEqual(eligibleTranscriptEntries(branch, binding, new Map()).map(entry => [entry.kind, entry.body]), [["branch_marker", TREE_NOTICE], ["local_user", "new activity"]]);
	branch.push(marker("boundary-two", { ...data, operationId: "tree-two", phase: "committed" }), message("newest", "latest activity"));
	assert.deepEqual(eligibleTranscriptEntries(branch, binding, new Map()).map(entry => [entry.kind, entry.body]), [["branch_marker", TREE_NOTICE], ["local_user", "latest activity"]]);
});

test("tree metadata cannot transfer projection authority to a copied session or foreign binding", () => {
	const branch = [marker("boundary", { ...data, phase: "committed" })];
	for (const changed of [{ sessionId: "copied" }, { conversationId: deriveConversationId("host", "other") }, { bindingBoundaryEntryId: deriveTranscriptEntryId("session", "other") }]) {
		assert.equal(treeBoundaryIndex(branch, { ...binding, ...changed }), -1);
		assert.throws(() => eligibleTranscriptEntries(branch, { ...binding, ...changed }, new Map()), /boundary is absent/);
	}
});

test("tree operation journal distinguishes prepare, cancellation and commit without replay", () => {
	assert.equal(latestTreeChange([marker("prepared")], binding)?.data.phase, "prepared");
	assert.equal(latestTreeChange([marker("prepared"), marker("cancelled", { ...data, phase: "cancelled" })], binding)?.data.phase, "cancelled");
	const journal = [marker("prepared"), marker("committed", { ...data, phase: "committed" })];
	assert.equal(latestTreeChange(journal, binding)?.data.phase, "committed");
	assert.throws(() => latestTreeChange([journal[1]], binding), /no prepare/);
	assert.throws(() => latestTreeChange([...journal, marker("replayed", { ...data, phase: "committed" })], binding), /Conflicting/);
	assert.throws(() => latestTreeChange([marker("prepared"), marker("wrong", { ...data, targetId: "changed", phase: "committed" })], binding), /Conflicting/);
	assert.throws(() => treeBoundaryIndex([marker("invalid", { ...data, phase: "invalid" as TreeChange["phase"] })], binding), /Invalid/);
});
