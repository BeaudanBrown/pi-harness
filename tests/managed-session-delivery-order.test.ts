import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { findDeliveredUserEntry, DELIVERY_ENTRY_TYPE } from "../config/agent/extensions/managed-sessions/adapter/state.js";

const marker = (id: string, deliveryId: string, text: string, parentId: string | null = null) => ({
 type: "custom", id, parentId, customType: DELIVERY_ENTRY_TYPE,
 data: { version: "1.0.0", deliveryId, matrixEventId: `$${deliveryId}`, kind: "prompt", status: "expanded", expandedText: text },
});
const user = (id: string, parentId: string, text: string) => ({ type: "message", id, parentId, message: { role: "user", content: [{ type: "text", text }] } });

test("queued delivery markers cannot steal an earlier message's identity", () => {
 const entries = [marker("a", "first", "HLS?"), marker("b", "second", "implement", "a"), user("u1", "b", "HLS?"), user("u2", "u1", "implement")];
 assert.equal(findDeliveredUserEntry(entries, "first"), "u1");
 assert.equal(findDeliveredUserEntry(entries, "second"), "u2");
});

test("identical queued inputs have separate ordered receipts", () => {
 const entries = [marker("a", "first", "same"), marker("b", "second", "same", "a"), user("u1", "b", "same"), user("u2", "u1", "same")];
 assert.equal(findDeliveredUserEntry(entries, "first"), "u1");
 assert.equal(findDeliveredUserEntry(entries, "second"), "u2");
});

test("identical captions do not conflate different images", () => {
 const a = marker("a", "first", "image"), b = marker("b", "second", "image", "a");
 const hash = (data: string) => createHash("sha256").update(data).digest("hex");
 const entries = [
  { ...a, data: { ...a.data, media: { sha256: hash("first") } } },
  { ...b, data: { ...b.data, media: { sha256: hash("second") } } },
  { type: "message", id: "u2", parentId: "b", message: { role: "user", content: [{ type: "text", text: "image" }, { type: "image", data: Buffer.from("second").toString("base64") }] } },
  { type: "message", id: "u1", parentId: "u2", message: { role: "user", content: [{ type: "text", text: "image" }, { type: "image", data: Buffer.from("first").toString("base64") }] } },
 ];
 assert.equal(findDeliveredUserEntry(entries, "first"), "u1");
 assert.equal(findDeliveredUserEntry(entries, "second"), "u2");
});

test("unrelated branches and mismatched text are never persistence evidence", () => {
 assert.equal(findDeliveredUserEntry([marker("a", "first", "HLS?"), user("u", "elsewhere", "HLS?")], "first"), undefined);
 assert.equal(findDeliveredUserEntry([marker("a", "first", "HLS?"), user("u", "a", "other")], "first"), undefined);
});
