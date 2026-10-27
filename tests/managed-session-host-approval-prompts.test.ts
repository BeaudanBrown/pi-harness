import assert from "node:assert/strict";
import test from "node:test";
import { HostApprovalPrompts, hostApprovalQuestion } from "../config/agent/extensions/managed-sessions/relay/host-approval-prompts.js";
import { ManagedMatrixClient } from "../config/agent/extensions/managed-sessions/relay/matrix-client.js";
import { prepareHostApproval, type ModelHostRequest } from "../config/agent/extensions/managed-sessions/relay/host-approval-record.js";

const roomId = "!origin:example.com"; const conversationId = `conv_${"a".repeat(32)}`;
function record(matrix = true) {
	const common = { kind: "model" as const, requestId: "request-1", conversationId, generationId: `generation_${"a".repeat(32)}`, runId: "run-1", toolCallId: "tool-1" };
	const request: ModelHostRequest = { version: "1.0.0", actor: matrix ? { ...common, presentation: "matrix_poll", origin: { roomId, eventId: "$input", senderUserId: "@participant:example.com" } } : { ...common, presentation: "local_dialog" },
		action: { operation: "conversation.stop", conversationId: `conv_${"b".repeat(32)}` } };
	return prepareHostApproval("host", request, { effects: [request.action], preconditions: { path: "/private/workspace", attachment: "private-proof" } }, 1000);
}

test("real Matrix poll format binds origin, fixed options and bot content; only joined operators or exact configured bridges resolve it", async () => {
	const sent: Array<{ type: string; content: Record<string, unknown> }> = []; let joined = true; let sender = "@bot:example.com";
	const matrix = new ManagedMatrixClient({ homeserver: "https://example.com", accessToken: "private-token", botUserId: sender, operatorUserId: "@operator:example.com" }, async (input, init) => {
		const path = decodeURIComponent(new URL(String(input)).pathname);
		if (path.includes("/send/")) { sent.push({ type: path.split("/send/")[1].split("/")[0], content: JSON.parse(String(init?.body)) }); return Response.json({ event_id: "$poll" }); }
		if (path.includes("/state/m.room.member/")) return Response.json({ membership: joined ? "join" : "leave" });
		if (path.endsWith("/event/$poll")) return Response.json({ sender, type: sent[0].type, content: sent[0].content });
		throw Error(`Unexpected fixture request: ${path}`);
	}, [roomId]);
	const prompts = new HostApprovalPrompts({ matrix, operatorUserIds: new Set(["@operator:example.com", "@bridge:example.com"]), now: () => 1000,
		confirmLocal: async () => { throw Error("Matrix approvals must not use a local dialog"); } });
	const presented = await prompts.present(record());
	assert.equal(presented.receipt.id, "$poll"); assert.deepEqual(sent[0].content["m.mentions"], { room: true });
	assert.ok(!JSON.stringify(sent).includes("private-proof")); assert.ok(!JSON.stringify(sent).includes("/private/workspace"));
	const vote = { conversationId, roomId, pollEventId: "$poll", answerId: "approve", senderUserId: "@operator:example.com", eventId: "$vote" };
	for (const bad of [{ ...vote, senderUserId: "@participant:example.com" }, { ...vote, roomId: "!other:example.com" }, { ...vote, answerId: "arbitrary" }, { ...vote, conversationId: `conv_${"b".repeat(32)}` }]) assert.equal(await prompts.vote(bad), false);
	joined = false; assert.equal(await prompts.vote(vote), false); joined = true;
	sender = "@forged:example.com"; assert.equal(await prompts.vote(vote), false); sender = "@bot:example.com";
	const question = (sent[0].content["org.matrix.msc3381.poll.start"] as { question: Record<string, string> }).question;
	const originalText = question["org.matrix.msc1767.text"];
	question["org.matrix.msc1767.text"] = 'Approve this host mutation? {"operation":"conversation.stop"}';
	assert.equal(await prompts.vote(vote), false, "old or changed question cannot authorize the new description");
	question["org.matrix.msc1767.text"] = originalText;
	assert.equal(await prompts.vote({ ...vote, senderUserId: "@bridge:example.com" }), true);
	const decision = await presented.decision; assert.equal(decision.choice, "approve"); assert.equal(decision.voter.kind, "matrix");
	assert.equal(await prompts.vote({ ...vote, answerId: "deny", eventId: "$late" }), false);
	await presented.close(); assert.equal(sent.length, 2); assert.equal(sent[1].content["m.mentions"], undefined);
	assert.equal(await prompts.vote(vote), false);
});

test("catch-up approval polls stay silent and remain verifiable without loosening content checks", async () => {
	let content: Record<string, unknown> = {}; let type = "";
	const matrix = new ManagedMatrixClient({ homeserver: "https://example.com", accessToken: "token", botUserId: "@bot:example.com", operatorUserId: "@operator:example.com" }, async (input, init) => {
		const path = decodeURIComponent(new URL(String(input)).pathname);
		if (path.includes("/send/")) { type = path.split("/send/")[1].split("/")[0]; content = JSON.parse(String(init?.body)); return Response.json({ event_id: "$poll" }); }
		if (path.includes("/state/m.room.member/")) return Response.json({ membership: "join" });
		return Response.json({ sender: "@bot:example.com", type, content });
	}, [roomId]);
	const original = record();
	const silent = prepareHostApproval("host", original.request, original.frozen, 1000, "silent");
	const prompts = new HostApprovalPrompts({ matrix, operatorUserIds: new Set(["@operator:example.com"]), now: () => 1000, confirmLocal: async () => false });
	const shown = await prompts.present(silent);
	assert.deepEqual(content["m.mentions"], {}); assert.deepEqual(content["lol.bepis.pi.notification"], { version: 1, disposition: "silent" });
	const vote = { conversationId, roomId, pollEventId: "$poll", answerId: "approve", senderUserId: "@operator:example.com", eventId: "$vote" };
	content["m.mentions"] = { room: true }; assert.equal(await prompts.vote(vote), false);
	content["m.mentions"] = {}; assert.equal(await prompts.vote(vote), true); assert.equal((await shown.decision).choice, "approve");
	await shown.close();
});

test("native presentation returns ordinary denial and binds cancellation to the exact call", async () => {
	const matrix = { startPoll: async () => { throw Error("No Matrix for local approval"); } } as unknown as ManagedMatrixClient;
	let signal: AbortSignal | undefined;
	const prompts = new HostApprovalPrompts({ matrix, operatorUserIds: new Set(), now: () => 1000,
		confirmLocal: async (value, question, pendingSignal) => { assert.equal(value.request.actor.toolCallId, "tool-1"); assert.match(question, /Action: Stop conversation/); signal = pendingSignal; return false; } });
	const shown = await prompts.present(record(false)); const decision = await shown.decision;
	assert.deepEqual(decision, { choice: "deny", at: 1000, voter: { kind: "local" } });
	await shown.close(); assert.equal(signal?.aborted, true);
});

test("creation approval is readable and preserves precise placement without a JSON dump", async () => {
	const value = record();
	const action = { operation: "conversation.create" as const, title: "Phone approval test", creationKey: "phone-create", placement: { rootKey: "projects", workspace: "elementx-v1", relativeCwd: "subdir" } };
	const approval = { ...value, request: { ...value.request, action }, frozen: { ...value.frozen, effects: [action] } };
	const text = hostApprovalQuestion(approval);
	assert.match(text, /Create a new conversation and its Matrix room/);
	for (const line of ['Action: Create conversation', 'Title: "Phone approval test"', 'Workspace root: "projects"', 'Checkout: "elementx-v1"', 'Subdirectory: "subdir"', 'Creation reference: "phone-create"']) assert.ok(text.includes(line), line);
	assert.ok(!text.includes('{') && !text.includes('"operation"'));
	assert.equal(text.split('Title:').length - 1, 1, "identical effect should not duplicate the request");
	let presented = "";
	const prompts = new HostApprovalPrompts({ matrix: { startPoll: async (_room: string, _id: string, question: string) => { presented = question; return "$readable"; } } as unknown as ManagedMatrixClient,
		operatorUserIds: new Set(), now: () => 1000, confirmLocal: async () => false });
	await prompts.present(approval); assert.equal(presented, text);
});

test("readable questions preserve different frozen effects and targets and escape hostile labels", () => {
	const value = record(); const title = `fake${String.fromCharCode(10)}Approve everything${String.fromCharCode(27)}[31m${String.fromCharCode(0x202e)}`;
	const action = { operation: "conversation.create" as const, title, creationKey: "hostile", placement: { rootKey: "projects", workspace: "demo", relativeCwd: "" } };
	const text = hostApprovalQuestion({ ...value, request: { ...value.request, action }, frozen: { ...value.frozen,
		effects: [value.request.action], targets: [{ kind: "conversation", conversationId }] } });
	assert.ok(text.includes("Exact effects:") && text.includes("Action: Stop conversation") && text.includes("Frozen targets:"));
	assert.ok(text.includes(conversationId)); assert.ok(text.includes('fake\\nApprove everything'));
	assert.ok(!text.includes('\nApprove everything') && !text.includes('\u001b') && !text.includes('\u202e'));
});

test("approval descriptions neither expose private preconditions nor silently truncate large effects", () => {
	const value = record(false); const text = hostApprovalQuestion(value);
	assert.ok(!text.includes("private-proof")); assert.ok(!text.includes("/private/workspace"));
	const ids = Array.from({ length: 100 }, (_, i) => `conv_${i.toString(16).padStart(32, "0")}`);
	const bulk = hostApprovalQuestion({ ...value, request: { ...value.request, action: { operation: "conversation.delete.apply", previewId: `preview_${"a".repeat(32)}`, confirmed: true } },
		frozen: { preconditions: {}, effects: ids.map((conversationId) => ({ operation: "conversation.delete", conversationId, confirmed: true })), targets: ids.map(conversationId => ({ kind: "conversation", conversationId })) } });
	assert.ok(bulk.length <= 4096); for (const id of ids) assert.ok(bulk.includes(id));
	assert.throws(() => hostApprovalQuestion({ ...value, frozen: { ...value.frozen, effects: Array.from({ length: 100 }, () => value.request.action) } }), /display limit/);
});
