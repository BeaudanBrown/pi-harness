import assert from "node:assert/strict";
import test from "node:test";
import { HostPreviewStore, freezeJsonChunks } from "../config/agent/extensions/managed-sessions/relay/host-preview-store.js";
const cid = `conv_${"a".repeat(32)}`;
const sample = (expiresAt: number) => ({ source: { operation: "conversation.delete.preview" as const, conversationIds: [cid] }, expiresAt,
	targets: [{ kind: "conversation" as const, conversationId: cid }], activeRuns: [], blockers: [] as string[], privateValue: { revision: 1 } });
test("shared preview storage detaches values and enforces expiry and operation correlation", () => {
	let now = 1000; const store = new HostPreviewStore<ReturnType<typeof sample>>("host", () => now);
	const value = sample(store.expiresAt()); const result = store.save(value); value.privateValue.revision = 2;
	const action = { operation: "conversation.delete.apply" as const, previewId: result.previewId, confirmed: true as const };
	assert.equal(store.get(action).privateValue.revision, 1); store.get(action).privateValue.revision = 3; assert.equal(store.get(action).privateValue.revision, 1);
	assert.throws(() => store.get({ ...action, operation: "space.cleanup.apply" }), /changed or expired/);
	now = Date.parse(result.expiresAt); assert.throws(() => store.get(action), /changed or expired/);
	assert.ok(store.save(sample(store.expiresAt())).previewId);
});
test("shared preview storage and opaque snapshots remain bounded", () => {
	const store = new HostPreviewStore<ReturnType<typeof sample>>("host", () => 1000);
	for (let revision = 0; revision < 128; revision++) { const value = sample(store.expiresAt()); value.privateValue.revision = revision; store.save(value); }
	assert.throws(() => store.expiresAt(), /Too many/);
	assert.throws(() => freezeJsonChunks({ value: "x".repeat(45057) }), /bounds/);
	const value = { "@operator:example.com": { "m.space.child": "opaque values, not grammar keys" } };
	assert.deepEqual(JSON.parse(freezeJsonChunks(value).join("")), value);
});
