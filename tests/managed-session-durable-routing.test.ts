import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DurableInbox } from "../config/agent/extensions/managed-sessions/relay/durable-inbox.js";
import { NoticeOutbox } from "../config/agent/extensions/managed-sessions/relay/notice-outbox.js";
import { ManagedMatrixClient } from "../config/agent/extensions/managed-sessions/relay/matrix-client.js";
import { HostLifecycle } from "../config/agent/extensions/managed-sessions/relay/host-lifecycle.js";
import { RelayRegistryError } from "../config/agent/extensions/managed-sessions/relay/registry.js";

async function until(check: () => boolean): Promise<void> {
	for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
	assert.ok(check(), "condition timed out");
}

test("durable inbox isolates rooms, retains order and resumes accepted work across restart", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "managed-inbox-")); t.after(() => rm(root, { recursive: true, force: true }));
	const path = join(root, "inbox.json"); const delivered: unknown[] = [];
	const first = new DurableInbox(path, async (room, response) => { if (room === "blocked") throw Error("429"); delivered.push(response); }, () => {}, 10);
	await first.load(); first.start();
	await first.accept("cursor-1", [{ conversationId: "blocked", response: { order: 1 } }, { conversationId: "healthy", response: { order: 2 } }]);
	await first.accept("cursor-2", [{ conversationId: "blocked", response: { order: 3 } }]);
	await until(() => delivered.length === 1); await first.close();
	assert.deepEqual(delivered, [{ order: 2 }]);
	const second = new DurableInbox(path, async (_room, response) => { (delivered as unknown[]).push(response); }, () => {}, 10);
	await second.load();
	// Crash after inbox acceptance but before the registry cursor: replay must not append again.
	await second.accept("cursor-2", [{ conversationId: "blocked", response: { order: 3 } }]);
	second.start(); await until(() => delivered.length === 3); await second.close();
	assert.deepEqual(delivered, [{ order: 2 }, { order: 1 }, { order: 3 }]);
});

test("capacity validation rejects proposed state before durable acceptance", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "managed-capacity-")); t.after(() => rm(root, { recursive: true, force: true }));
	const inbox = new DurableInbox(join(root, "inbox.json"), async () => { throw Error("retain"); }, () => {});
	await inbox.load(); await inbox.accept("safe", []);
	await assert.rejects(() => inbox.accept("too-large", [{ conversationId: "room", response: { body: "x".repeat(16 * 1024 * 1024) } }]), /Invalid or full/);
	await assert.rejects(() => inbox.accept("too-many", Array.from({ length: 4097 }, () => ({ conversationId: "room", response: {} }))), /Invalid or full/);
	assert.equal(JSON.parse(await readFile(join(root, "inbox.json"), "utf8")).lastBatch, "safe"); await inbox.close();
	const outbox = new NoticeOutbox(join(root, "notices.json"), async () => {}, () => {}); await outbox.load();
	const notice = { conversationId: "room", sourceId: "safe", piSessionId: "session", roomId: "!room:test", body: "safe" };
	await outbox.enqueue(notice);
	await assert.rejects(() => outbox.enqueue({ ...notice, sourceId: "too-large", body: "x".repeat(16 * 1024 * 1024) }), /Invalid or full/);
	await outbox.close();
	assert.equal(JSON.parse(await readFile(join(root, "notices.json"), "utf8")).notices.length, 1);
});

test("notice outbox freezes content and generation identity across failed sends and restart", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "managed-notices-")); t.after(() => rm(root, { recursive: true, force: true }));
	const path = join(root, "outbox.json"); let attempts = 0;
	const first = new NoticeOutbox(path, async () => { attempts++; throw Error("429"); }, () => {});
	await first.load();
	const notice = { conversationId: "room", sourceId: "reset:completed", piSessionId: "generation-1", roomId: "!room:test", body: "original result" };
	await first.enqueue(notice); await until(() => attempts > 0); await first.close();
	const sent: unknown[] = [];
	const second = new NoticeOutbox(path, async (value) => { sent.push(value); }, () => {});
	await second.load();
	await second.enqueue({ ...notice, piSessionId: "generation-2", body: "changed result" });
	await until(() => sent.length === 1); await second.close();
	assert.deepEqual(sent, [{ ...notice, sent: false }]);
	const third = new NoticeOutbox(path, async () => { throw Error("must not resend completed notice"); }, () => {});
	await third.load(); await third.enqueue(notice); await third.close();
	await assert.rejects(() => third.enqueue({ ...notice, sourceId: "after-stop" }), /shutting down/);
});

test("notification outages cannot hold an attached generation transitioning", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "managed-reset-outbox-")); t.after(() => rm(root, { recursive: true, force: true }));
	const outbox = new NoticeOutbox(join(root, "notices.json"), async () => { throw Error("429"); }, () => {});
	await outbox.load(); t.after(() => outbox.close());
	let completed = false; let ready = false;
	const manifest = { kind: "project", conversationId: "room", piSessionId: "session", roomId: "!room:test", activeGenerationId: "next", placement: {} };
	const transition = { transitionId: "reset", toGenerationId: "next", ordinal: 2 };
	const lifecycle = new HostLifecycle({ launcher: "/never-invoked", projectSessionDirectory: root,
		registry: { manifestByConversationId: () => manifest, generationTransitions: () => [{ conversationId: "room", transition }],
			isActiveGenerationAttached: () => true, markGenerationAttached: async () => {}, completeGenerationTransition: async () => { completed = true; },
			failGenerationTransition: async () => assert.fail("notification failure must not fail activation") },
		projectNotice: async (sourceId: string, _manifest: unknown, body: string) => outbox.enqueue({ conversationId: "room", sourceId, piSessionId: "session", roomId: "!room:test", body }),
		generationReady: async () => { ready = true; },
	} as unknown as ConstructorParameters<typeof HostLifecycle>[0]);
	(lifecycle as unknown as { invoke: (operation: string) => Promise<unknown> }).invoke = async (operation) => operation === "workspace-resolve" ? { cwd: root } : { sessionName: "test" };
	await lifecycle.reconcileGenerationTransitions(); assert.equal(completed, true); assert.equal(ready, true);
});

test("conflicting legacy notice is retained but cannot block later room notices", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "managed-notice-conflict-")); t.after(() => rm(root, { recursive: true, force: true }));
	const sent: string[] = [];
	const outbox = new NoticeOutbox(join(root, "notices.json"), async (notice) => {
		if (notice.sourceId === "old") throw new RelayRegistryError("invalid_state", "Conflicting transcript projection content");
		sent.push(notice.sourceId);
	}, () => {});
	await outbox.load();
	const notice = { conversationId: "room", piSessionId: "session", roomId: "!room:test", body: "test" };
	await outbox.enqueue({ ...notice, sourceId: "old" }); await outbox.enqueue({ ...notice, sourceId: "new" });
	await until(() => sent.length === 1); await outbox.close(); assert.deepEqual(sent, ["new"]);
});

test("managed one-attempt transport shares event cooldown without blocking reads", async () => {
	let sends = 0;
	const client = new ManagedMatrixClient({ homeserver: "https://matrix.example.com", accessToken: "fake", botUserId: "@bot:example.com", operatorUserId: "@owner:example.com" }, async (url) => {
		if (String(url).includes("/send/")) { sends++; return Response.json({ retry_after_ms: 60_000 }, { status: 429 }); }
		return Response.json({ user_id: "@bot:example.com" });
	}, ["!a:example.com", "!b:example.com"], { maxAttempts: 1 });
	await assert.rejects(() => client.sendNotice("!a:example.com", "first", "working"), { status: 429 });
	await assert.rejects(() => client.sendNotice("!b:example.com", "second", "working"), { status: 429 });
	assert.equal(sends, 1); assert.equal(await client.whoami(), "@bot:example.com");
});
