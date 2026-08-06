import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	RemoteSessionStateStore,
	bindingIdForRoom,
	stateRootForSessionDirectory,
} from "../config/agent/extensions/remote-session/state-store.js";

const binding = {
	version: 2 as const,
	bindingId: bindingIdForRoom("!durable:example.com"),
	roomId: "!durable:example.com",
	conceptName: "durable relay",
};

async function temporaryStore(hostId = "@pi-grill:example.com"): Promise<RemoteSessionStateStore> {
	return new RemoteSessionStateStore(await mkdtemp(join(tmpdir(), "pi-remote-state-")), hostId);
}

test("shared binding and session lineage survive a new store instance", async () => {
	const first = await temporaryStore();
	await first.bindSession("session-parent", binding);

	const resumed = new RemoteSessionStateStore(first.root, "@pi-grill:example.com");
	assert.deepEqual(await resumed.bindingForSession("session-parent"), binding);

	await resumed.inheritSession("session-fork", "session-parent");
	assert.deepEqual(await resumed.bindingForSession("session-fork"), binding);
});

test("conflicting room or concept identity is rejected", async () => {
	const store = await temporaryStore();
	await store.bindSession("session-1", binding);

	await assert.rejects(
		store.bindSession("session-2", { ...binding, conceptName: "renamed concept" }),
		/Conflicting durable Matrix binding/,
	);
	await assert.rejects(
		store.bindSession("session-1", { ...binding, bindingId: "different-binding", roomId: "!other:example.com" }),
		/Session session-1 is already bound/,
	);
});

test("each bot has an independent cursor while sharing room identity", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-remote-state-"));
	const grill = new RemoteSessionStateStore(root, "@pi-grill:example.com");
	const t480 = new RemoteSessionStateStore(root, "@pi-t480:example.com");
	await grill.bindSession("session-1", binding);

	await grill.advanceCursor(binding.bindingId, "grill-cursor");
	await t480.advanceCursor(binding.bindingId, "t480-cursor");

	assert.equal((await grill.hostProgress(binding.bindingId)).since, "grill-cursor");
	assert.equal((await t480.hostProgress(binding.bindingId)).since, "t480-cursor");
	assert.deepEqual(await t480.bindingForSession("session-1"), binding);
});

test("accepted event IDs are durable and produce stable outbound transactions", async () => {
	const first = await temporaryStore();
	await first.bindSession("session-1", binding);
	const accepted = await first.acceptSync(binding.bindingId, "cursor-1", [
		{ eventId: "$prompt", prompt: "Investigate this" },
	]);
	assert.equal(accepted.length, 1);
	assert.match(accepted[0]?.transactionId ?? "", /^pi-[a-f0-9]{48}$/);

	const resumed = new RemoteSessionStateStore(first.root, "@pi-grill:example.com");
	assert.deepEqual(await resumed.acceptSync(binding.bindingId, "cursor-2", [
		{ eventId: "$prompt", prompt: "Investigate this" },
	]), []);
	assert.deepEqual(await resumed.unfinishedInbounds(binding.bindingId), accepted);
	await resumed.markInboundInjected(binding.bindingId, "$prompt");
	assert.deepEqual(await resumed.unfinishedInbounds(binding.bindingId), accepted);

	await resumed.recordAnswer(binding.bindingId, "$prompt", "Final answer");
	assert.deepEqual(await resumed.unfinishedInbounds(binding.bindingId), []);
	assert.deepEqual(await resumed.pendingOutbounds(binding.bindingId), [
		{
			eventId: "$prompt",
			transactionId: accepted[0]?.transactionId,
			body: "Final answer",
		},
	]);
	await resumed.markOutboundSent(binding.bindingId, "$prompt");
	assert.deepEqual(await resumed.pendingOutbounds(binding.bindingId), []);
});

test("control kind is durable and handled controls leave no unfinished turn", async () => {
	const store = await temporaryStore();
	await store.bindSession("session-1", binding);
	const [accepted] = await store.acceptSync(binding.bindingId, "control-cursor", [
		{ eventId: "$abort", prompt: "", kind: "abort" },
	]);
	assert.equal(accepted?.kind, "abort");
	assert.deepEqual(await store.unfinishedInbounds(binding.bindingId), [accepted]);
	await store.markInboundHandled(binding.bindingId, "$abort");
	assert.deepEqual(await store.unfinishedInbounds(binding.bindingId), []);
	assert.deepEqual(await store.pendingOutbounds(binding.bindingId), []);
});

test("concurrent host updates retain every accepted event", async () => {
	const store = await temporaryStore();
	await store.bindSession("session-1", binding);
	await Promise.all([
		store.acceptSync(binding.bindingId, "cursor-a", [{ eventId: "$a", prompt: "First" }]),
		store.acceptSync(binding.bindingId, "cursor-b", [{ eventId: "$b", prompt: "Second" }]),
	]);
	assert.deepEqual((await store.hostProgress(binding.bindingId)).processedEventIds.sort(), ["$a", "$b"]);
});

test("pending event capacity applies backpressure without advancing the cursor", async () => {
	const store = await temporaryStore();
	await store.bindSession("session-1", binding);
	const capacityBatch = Array.from({ length: 2048 }, (_, index) => ({
		eventId: `$capacity-${index}`,
		prompt: `Prompt ${index}`,
	}));
	await store.acceptSync(binding.bindingId, "capacity-cursor", capacityBatch);
	await assert.rejects(
		store.acceptSync(binding.bindingId, "must-not-advance", [{ eventId: "$overflow", prompt: "Overflow" }]),
		/event capacity 2048 reached/,
	);
	const progress = await store.hostProgress(binding.bindingId);
	assert.equal(progress.since, "capacity-cursor");
	assert.equal(progress.processedEventIds.length, 2048);
});

test("session root sidecar and parent session IDs support fork recovery", async () => {
	const sessionDirectory = "/home/beau/.pi/agent/sessions/--home-beau-project--";
	assert.equal(
		stateRootForSessionDirectory(sessionDirectory),
		"/home/beau/.pi/agent/sessions/.remote-session",
	);

	const directory = await mkdtemp(join(tmpdir(), "pi-parent-session-"));
	const parentFile = join(directory, "parent.jsonl");
	await writeFile(
		parentFile,
		`${JSON.stringify({ type: "session", version: 3, id: "parent-session-id", cwd: "/project" })}\n`,
		{ mode: 0o600 },
	);
	const store = await temporaryStore();
	await store.bindSession("parent-session-id", binding);
	assert.deepEqual(await store.inheritSessionFromFile("fork-session-id", parentFile), binding);

	const persisted = JSON.parse(await readFile(join(store.root, "sessions", "fork-session-id.json"), "utf8")) as {
		bindingId: string;
	};
	assert.equal(persisted.bindingId, binding.bindingId);
});
