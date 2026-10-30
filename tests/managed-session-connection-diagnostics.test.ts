import assert from "node:assert/strict";
import test from "node:test";
import { connectionDiagnosticLogger, reportConnectionDiagnostic, type ConnectionDiagnostic } from "../config/agent/extensions/managed-sessions/connection-diagnostics.js";

test("connection diagnostics allowlist metadata and bound output across reconnections", () => {
	const lines: string[] = []; const log = connectionDiagnosticLogger(line => lines.push(line), 2);
	const input = { side: "adapter", reason: "invalid_frame", conversationId: `conv_${"a".repeat(32)}`,
		connectionId: "00000000-0000-0000-0000-000000000000", attachmentId: "attachment-00000000-0000-0000-0000-000000000000",
		lastReceivedType: "secret.token", lastSentType: "attachment.attach", failedReceivedType: "host.run.check", failureCode: "timeout", sent: 2, received: 1, pending: 1,
		body: "secret-body", error: new Error("secret-error"), token: "secret-token", nonce: "secret-nonce" };
	log(input as ConnectionDiagnostic); log({ side: "relay", reason: "peer_closed", conversationId: "secret-id", sent: Infinity, received: -1,
		failedReceivedType: "secret-type", failureCode: "secret-code" } as unknown as ConnectionDiagnostic);
	for (let i = 0; i < 100; i++) log({ side: "relay", reason: "socket_error" });
	assert.equal(lines.length, 2); assert.ok(!lines.join().includes("secret"));
	const first = JSON.parse(lines[0]!.slice("[managed-connection] ".length));
	assert.equal(first.lastSentType, "attachment.attach"); assert.equal(first.conversationId, input.conversationId);
	assert.equal(first.failedReceivedType, "host.run.check"); assert.equal(first.failureCode, "timeout");
	const second = JSON.parse(lines[1]!.slice("[managed-connection] ".length));
	assert.equal(second.pid, process.pid); assert.ok(Number.isFinite(Date.parse(second.at))); delete second.pid; delete second.at;
	assert.deepEqual(second, { side: "relay", reason: "peer_closed" });
	assert.ok(lines.every(line => line.length < 700));
});

test("rate windows resume details and summarize suppressed categories without retaining identities", () => {
	let time = 0; const lines: string[] = [];
	const log = connectionDiagnosticLogger(line => lines.push(line), 2, { now: () => time, windowMs: 1000 });
	const record = { side: "adapter" as const, reason: "unexpected_reply" as const };
	log(record); log(record);
	for (let i = 0; i < 1000; i++) log({ ...record, conversationId: `secret-identity-${i}` });
	log({ side: "relay", reason: "socket_error" });
	log({ side: "relay", reason: "secret-reason" } as unknown as ConnectionDiagnostic);
	assert.equal(lines.length, 2);
	time = 1000; log(record);
	assert.equal(lines.length, 4, "one summary and a new detail; logger is not permanently exhausted");
	const summary = JSON.parse(lines[2]!.slice("[managed-connection] ".length));
	assert.equal(summary.event, "suppressed_connections");
	assert.deepEqual(summary.counts, { "adapter:unexpected_reply": 1000, "relay:socket_error": 1 });
	assert.ok(!lines.join().includes("secret"));
	log(record); log(record); assert.equal(lines.length, 5);
	time = 2000; log(record);
	assert.deepEqual(JSON.parse(lines[5]!.slice("[managed-connection] ".length)).counts, { "adapter:unexpected_reply": 1 });
	time = 3000; log(record); assert.equal(lines.length, 8, "no empty summary on a quiet window");
});

test("rate-window summaries cannot throw into cleanup and invalid window sizes reject", () => {
	let time = 0; let attempts = 0;
	const log = connectionDiagnosticLogger(() => { attempts++; throw Error("sink failed"); }, 1, { now: () => time, windowMs: 1000 });
	const record = { side: "relay" as const, reason: "peer_closed" as const };
	assert.doesNotThrow(() => { log(record); log(record); time = 1000; log(record); });
	assert.equal(attempts, 3);
	for (const windowMs of [0, -1, Infinity, 1.5]) assert.throws(() => connectionDiagnosticLogger(() => undefined, 1, { windowMs }));
});

test("diagnostics cannot throw into connection cleanup or turn arbitrary error strings into categories", () => {
	const lines: string[] = []; const log = connectionDiagnosticLogger(line => lines.push(line));
	log({ side: "adapter", reason: "secret-error" } as unknown as ConnectionDiagnostic);
	assert.deepEqual(lines, []);
	assert.doesNotThrow(() => reportConnectionDiagnostic(() => { throw Error("sink failed"); }, { side: "relay", reason: "peer_closed" }));
	assert.doesNotThrow(() => connectionDiagnosticLogger(() => { throw Error("sink failed"); })({ side: "relay", reason: "peer_closed" }));
	for (const limit of [0, -1, Infinity, 257, 1.5]) assert.throws(() => connectionDiagnosticLogger(() => undefined, limit));
});
