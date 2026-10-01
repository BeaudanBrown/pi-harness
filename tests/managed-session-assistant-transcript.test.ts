import assert from "node:assert/strict";
import test from "node:test";
import { assistantTranscriptParts, assistantTranscriptSourceKey } from "../config/agent/extensions/managed-sessions/adapter/assistant-transcript.js";

const text = (body: string, phase?: string) => ({ type: "text", text: body, ...(phase ? { textSignature: JSON.stringify({ v: 1, id: "msg_1", phase }) } : {}) });
const message = (content: unknown, stopReason = "stop") => ({ role: "assistant", content, stopReason });

test("completed commentary around tools projects text only in persisted order", () => {
	const before = message([text("I will inspect it.", "commentary"), { type: "thinking", thinking: "private reasoning" }, { type: "toolCall", name: "bash", arguments: { command: "private args" } }], "toolUse");
	const after = message([text("The result is clear.", "commentary"), { type: "toolCall", arguments: { body: "private body" } }], "toolUse");
	const final = message([text("Fixed.", "final_answer")]);
	assert.deepEqual([before, after, final].flatMap(assistantTranscriptParts), [
		{ kind: "assistant_commentary", contentIndex: 0, body: "I will inspect it." },
		{ kind: "assistant_commentary", contentIndex: 0, body: "The result is clear." },
		{ kind: "assistant_final", contentIndex: 0, body: "Fixed." },
	]);
});

test("one completed Pi message may contain both commentary and final text", () => {
	const parts = assistantTranscriptParts(message([text("Progress", "commentary"), text("Done", "final_answer")]));
	assert.deepEqual(parts.map((part) => part.body), ["Progress", "Done"]);
	assert.deepEqual(parts.map((part) => assistantTranscriptSourceKey("abcd1234", part, parts)), ["abcd1234:text:0", "abcd1234:text:1"]);
	assert.deepEqual(assistantTranscriptParts(JSON.parse(JSON.stringify(message([text("Progress", "commentary"), text("Done", "final_answer")])))), parts);
});

test("provider-neutral text uses completed tool-use or stop context, never prose guessing", () => {
	assert.equal(assistantTranscriptParts(message([text("All finished!")], "toolUse"))[0]?.kind, "assistant_commentary");
	assert.equal(assistantTranscriptParts(message([text("I will inspect it.")]))[0]?.kind, "assistant_final");
	assert.equal(assistantTranscriptParts(message([{ ...text("Legacy"), textSignature: "opaque-provider-id" }]))[0]?.kind, "assistant_final");
	assert.equal(assistantTranscriptParts(message([text("Tagged commentary", "commentary")]))[0]?.kind, "assistant_commentary");
});

test("historical unsplit final keys and concatenation are unchanged", () => {
	const parts = assistantTranscriptParts(message([{ type: "thinking", thinking: "private" }, text("One"), text(" two")]));
	assert.deepEqual(parts, [{ kind: "assistant_final", contentIndex: 1, body: "One two" }]);
	assert.equal(assistantTranscriptSourceKey("abcd1234", parts[0]!, parts), "abcd1234");
});

test("partial/failed responses, tool results, internal and unknown content never project", () => {
	for (const stopReason of ["pending", "length", "aborted", "error", "deferred", "unknown"]) assert.deepEqual(assistantTranscriptParts(message([text("unfinished")], stopReason)), []);
	for (const role of ["user", "toolResult", "custom", "compactionSummary", "branchSummary", "bashExecution"]) assert.deepEqual(assistantTranscriptParts({ ...message([text("not assistant")]), role }), []);
	for (const content of [[text("visible"), { type: "image", data: "private" }], [null], [text("x", "future-phase")], [{ ...text("x"), textSignature: "{malformed" }]]) assert.deepEqual(assistantTranscriptParts(message(content)), []);
	assert.deepEqual(assistantTranscriptParts(message([{ type: "thinking", thinking: "private" }, { type: "toolCall", name: "bash", arguments: { command: "private" } }], "toolUse")), []);
});
