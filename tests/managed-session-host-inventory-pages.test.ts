import assert from "node:assert/strict";
import test from "node:test";
import { HostInventoryPages } from "../config/agent/extensions/managed-sessions/relay/host-inventory-pages.js";
import { HostControlError, hostErrorResponse } from "../config/agent/extensions/managed-sessions/relay/host-control-error.js";
import { parseHostResponse } from "../config/agent/extensions/managed-sessions/live-workspace-contracts.js";

const stale = (error: unknown) => error instanceof HostControlError && error.code === "stale_preview";
const rows = Array.from({ length: 121 }, (_, id) => ({ id, title: `Conversation ${id}` }));

test("inventory pages are count/byte bounded, immutable and complete", () => {
	const pages = new HostInventoryPages("host");
	const first = pages.page({ operation: "conversation.list" }, rows);
	assert.equal(first.items.length, 50); assert.ok(first.nextCursor);
	first.items[0].title = "mutated consumer";
	assert.equal(pages.page({ operation: "conversation.list" }, rows).items[0].title, "Conversation 0");
	const second = pages.page({ operation: "conversation.list", cursor: first.nextCursor! }, rows);
	const third = pages.page({ operation: "conversation.list", cursor: second.nextCursor! }, rows);
	assert.deepEqual([...first.items, ...second.items, ...third.items].map((row) => row.id), rows.map((row) => row.id));
	assert.equal(third.nextCursor, null);
	const large = Array.from({ length: 100 }, (_, id) => ({ id, title: "界".repeat(1_000) }));
	const limited = pages.page({ operation: "conversation.list", limit: 100 }, large);
	assert.ok(limited.items.length < 100); assert.ok(limited.nextCursor);
	assert.ok(Buffer.byteLength(JSON.stringify(limited)) < 64 * 1024);
});

test("inventory cursors bind host, operation, filters and current revision", () => {
	const pages = new HostInventoryPages("host");
	const action = { operation: "worktree.list" as const, rootKey: "projects", workspace: "repo", limit: 1 };
	const cursor = pages.page(action, rows).nextCursor!;
	assert.throws(() => pages.page({ ...action, cursor, workspace: "other" }, rows), stale);
	assert.throws(() => pages.page({ operation: "conversation.list", cursor }, rows), stale);
	assert.throws(() => new HostInventoryPages("other-host").page({ ...action, cursor }, rows), stale);
	assert.throws(() => new HostInventoryPages("host").page({ ...action, cursor }, rows), stale, "restart discards snapshots");
	assert.throws(() => pages.page({ ...action, cursor }, [...rows].reverse()), stale);
	assert.throws(() => pages.page({ ...action, cursor }, rows.map((row) => ({ ...row, title: "changed" }))), stale);
	const [id, offset, signature] = cursor.split(".");
	assert.throws(() => pages.page({ ...action, cursor: `${id}.${Number(offset) + 1}.${signature}` }, rows), stale);
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
	const nonCanonical = signature.slice(0, -1) + alphabet[alphabet.indexOf(signature.at(-1)!) ^ 1];
	assert.throws(() => pages.page({ ...action, cursor: `${id}.${offset}.${nonCanonical}` }, rows), stale);
});

test("snapshot expiry is not extended by reads; capacity eviction fails stale", () => {
	let now = 1_000; const pages = new HostInventoryPages("host", () => now);
	const action = { operation: "conversation.list" as const, limit: 1 };
	const cursor = pages.page(action, rows).nextCursor!;
	now += 59_999; assert.equal(pages.page({ ...action, cursor }, rows).items[0].id, 1);
	now++; assert.throws(() => pages.page({ ...action, cursor }, rows), stale);
	const current = pages.page(action, rows).nextCursor!;
	for (let i = 0; i < 8; i++) pages.page({ operation: "worktree.list", rootKey: "projects", workspace: `repo-${i}` }, rows);
	assert.throws(() => pages.page({ ...action, cursor: current }, rows), stale);
});

test("invalid page limits and oversized inventories fail without unbounded frames", () => {
	const pages = new HostInventoryPages("host");
	for (const limit of [0, 101, 1.5]) assert.throws(() => pages.page({ operation: "conversation.list", limit }, rows));
	assert.throws(() => pages.page({ operation: "conversation.list" }, Array(4_097).fill({ id: 1 })));
	assert.throws(() => pages.page({ operation: "conversation.list" }, [{ text: "x".repeat(9 * 1024 * 1024) }]));
	assert.throws(() => pages.page({ operation: "conversation.list" }, [{ text: "x".repeat(64 * 1024) }]));
});

test("legacy summaries explicitly omit unknown checkout identity and errors hide raw diagnostics", () => {
	const response = { version: "1.0.0", requestId: "read-1", ok: true, data: {
		conversationId: `conv_${"a".repeat(32)}`, kind: "project", title: "Legacy conversation", reconciliationRequired: true,
		runtimeState: "unknown", launchState: "none", setupState: "pending", activeGenerationId: `generation_${"a".repeat(32)}`, capabilities: [],
	} };
	assert.doesNotThrow(() => parseHostResponse("conversation.status", response));
	assert.throws(() => parseHostResponse("conversation.status", { ...response, data: { ...response.data, checkoutId: "invented" } }));
	assert.throws(() => parseHostResponse("conversation.status", { ...response, data: { ...response.data, cwd: "/private/path" } }));
	for (const placement of [
		{ rootKey: "projects", workspace: "repo", relativeCwd: "/private/path" },
		{ rootKey: "/private/path", workspace: "repo", relativeCwd: "" },
		{ rootKey: "projects", workspace: "../private", relativeCwd: "" },
	]) assert.throws(() => parseHostResponse("conversation.status", { ...response, data: { ...response.data, placement } }));
	const oversized = hostErrorResponse("\nunsafe-id", new HostControlError("failed", "x".repeat(513)));
	assert.equal(oversized.requestId, "invalid-request"); assert.equal(oversized.error.message, "Host operation failed");
	const failure = hostErrorResponse("read-1", new Error("credential and private path"));
	assert.equal(failure.error.message, "Host operation failed");
	assert.doesNotThrow(() => parseHostResponse("conversation.status", failure));
});
