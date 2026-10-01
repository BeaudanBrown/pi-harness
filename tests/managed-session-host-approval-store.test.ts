import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HostApprovalStore } from "../config/agent/extensions/managed-sessions/relay/host-approval-store.js";
import { prepareHostApproval, type ModelHostRequest } from "../config/agent/extensions/managed-sessions/relay/host-approval-record.js";

function proposal(toolCallId = "tool-1") {
	const request: ModelHostRequest = { version: "1.0.0", actor: { kind: "model", requestId: "request-1", conversationId: `conv_${"a".repeat(32)}`,
		generationId: `generation_${"a".repeat(32)}`, runId: "run-1", toolCallId, presentation: "local_dialog" },
		action: { operation: "conversation.stop", conversationId: `conv_${"b".repeat(32)}` } };
	return prepareHostApproval("host", request, { effects: [request.action], preconditions: { instance: "original" } }, 1000);
}

test("private approval writes survive restart, preserve frozen retries and drain before ownership release", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "approval-store-")); t.after(() => rm(root, { recursive: true, force: true }));
	const store = new HostApprovalStore(root, "host"); await store.load(); const prepared = proposal();
	await store.prepare(prepared); const file = join(root, `${prepared.approvalId}.json`);
	assert.equal((await stat(root)).mode & 0o777, 0o700); assert.equal((await stat(file)).mode & 0o777, 0o600);
	const first = store.transition(prepared.approvalId, { phase: "presented", presentation: { kind: "local_dialog", id: "dialog-1" } });
	const next = store.transition(prepared.approvalId, { phase: "approved", decision: { choice: "approve", at: 2000, voter: { kind: "local" } } });
	await store.close(); await first; const approved = await next;
	const reopened = new HostApprovalStore(root, "host"); await reopened.load();
	assert.deepEqual(reopened.get(prepared.approvalId), approved);
	assert.deepEqual(await reopened.prepare(prepared), approved, "duplicate preparation cannot rewind consent or extend expiry");
	const clone = reopened.get(prepared.approvalId)!; clone.frozen.preconditions.instance = "changed";
	assert.equal(reopened.get(prepared.approvalId)!.frozen.preconditions.instance, "original");
	const accepted = await reopened.transition(prepared.approvalId, { phase: "accepted", acceptedAt: 3000 });
	assert.equal(accepted.expiresAt, prepared.expiresAt);
	await assert.rejects(reopened.transition(prepared.approvalId, { phase: "cancelled", acceptedAt: undefined }));
	assert.equal(JSON.parse(await readFile(file, "utf8")).phase, "accepted");
	await reopened.close(); await assert.rejects(reopened.prepare(prepared), /closed/);
});

test("capacity and conflicting preparation fail closed without discarding existing authority", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "approval-capacity-")); t.after(() => rm(root, { recursive: true, force: true }));
	const store = new HostApprovalStore(root, "host", 1); await store.load(); const prepared = proposal(); await store.prepare(prepared);
	await assert.rejects(store.prepare(proposal("tool-2")), /capacity/);
	const changed = prepareHostApproval("host", prepared.request, { ...prepared.frozen, preconditions: { instance: "other" } }, prepared.createdAt);
	await assert.rejects(store.prepare(changed), /conflicts/); assert.deepEqual(store.get(prepared.approvalId), prepared);
	await store.close();
});

test("malformed primary state never falls back to temporary files; wrong ownership and privacy are rejected", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "approval-corrupt-")); t.after(() => rm(root, { recursive: true, force: true }));
	const prepared = proposal(); const path = join(root, `${prepared.approvalId}.json`);
	const temporary = `${path}.123.aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.tmp`;
	await writeFile(temporary, JSON.stringify(prepared), { mode: 0o600 });
	const empty = new HostApprovalStore(root, "host"); await empty.load(); assert.deepEqual(empty.list(), []); await empty.close();
	await writeFile(path, "{broken", { mode: 0o600 }); await assert.rejects(new HostApprovalStore(root, "host").load());
	await writeFile(path, JSON.stringify(prepared)); await assert.rejects(new HostApprovalStore(root, "other-host").load(), /identity/);
	await chmod(path, 0o644); await assert.rejects(new HostApprovalStore(root, "host").load(), /private/);
	await rm(path); await symlink(temporary, path); await assert.rejects(new HostApprovalStore(root, "host").load());
});

test("uncertain write failure poisons the in-memory writer instead of continuing from an old snapshot", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "approval-write-fail-")); t.after(() => rm(root, { recursive: true, force: true }));
	const store = new HostApprovalStore(root, "host"); await store.load(); const prepared = proposal();
	await mkdir(join(root, `${prepared.approvalId}.json`));
	await assert.rejects(store.prepare(prepared));
	assert.throws(() => store.list(), /recovery is required/);
	await assert.rejects(store.prepare(proposal("other-tool")), /recovery is required/); await store.close();
});

test("close joins in-progress load and prevents later reads or reopen", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "approval-load-close-")); t.after(() => rm(root, { recursive: true, force: true }));
	const store = new HostApprovalStore(join(root, "state"), "host");
	const loading = assert.rejects(store.load(), /closed while loading/); await store.close(); await loading;
	assert.throws(() => store.list(), /closed/); await assert.rejects(store.load(), /closed/);
});
