import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveConversationId, deriveTranscriptEntryId, type ConversationManifest } from "../config/agent/extensions/managed-sessions/contracts.js";
import { CoordinatorRouter, operatorDepartureEvents } from "../config/agent/extensions/managed-sessions/relay/coordinator-router.js";
import { RelayRegistry } from "../config/agent/extensions/managed-sessions/relay/registry.js";
import { ConversationManifestStore } from "../config/agent/extensions/managed-sessions/relay/manifest-store.js";
import { ConversationRetirement } from "../config/agent/extensions/managed-sessions/relay/conversation-retirement.js";
import { ManagedMatrixClient } from "../config/agent/extensions/managed-sessions/relay/matrix-client.js";
import type { ManagedSessionIpcServer } from "../config/agent/extensions/managed-sessions/relay/ipc-server.js";

const operator = "@operator:example.com";
function manifest(key: string, kind: "project" | "coordinator" = "project"): ConversationManifest {
	return { schemaVersion: "1.0.0", kind, ownerHostId: "host", conversationId: deriveConversationId("host", key), creationKey: key, concept: key,
		piSessionId: key, roomId: `!${key}:example.com`, bindingBoundaryEntryId: deriveTranscriptEntryId(key, "boundary"), createdAt: "2026-01-01T00:00:00.000Z",
		...(kind === "coordinator" ? { hostSpace: "!host:example.com" } : { placement: { rootKey: "projects", workspace: key, relativeCwd: "" } }) };
}
const leave = () => ({ type: "m.room.member", event_id: "$leave", sender: operator, state_key: operator, origin_server_ts: Date.now(), content: { membership: "leave" } });
const response = (roomId: string, events: unknown[]) => ({ rooms: { join: { [roomId]: { timeline: { events } } } } });
async function until(condition: () => boolean) { for (let i = 0; i < 200 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 5)); assert.ok(condition(), "condition timed out"); }

test("only an operator self-leave in this bound conversation is retirement consent", () => {
	const project = manifest("project"); const event = leave();
	assert.deepEqual(operatorDepartureEvents(response(project.roomId, [event]), project, operator), ["$leave"]);
	for (const changed of [
		{ ...event, sender: "@admin:example.com" }, { ...event, state_key: "@other:example.com" },
		{ ...event, content: { membership: "ban" } }, { ...event, content: { membership: "join" } },
		{ ...event, origin_server_ts: 0 }, { ...event, origin_server_ts: Date.now() + 600_000 }, { ...event, event_id: "" },
	]) assert.deepEqual(operatorDepartureEvents(response(project.roomId, [changed]), project, operator), []);
	assert.deepEqual(operatorDepartureEvents(response("!host:example.com", [event]), project, operator), [], "Space departure cannot cascade");
	const initial = { rooms: { join: { [project.roomId]: { state: { events: [event] }, timeline: { limited: true, events: [] } } } } };
	assert.deepEqual(operatorDepartureEvents(initial, project, operator, Date.now(), true), ["$leave"], "initial state closure consent does not replay prompts");
});

for (const initial of [false, true]) test(`operator departure routes to terminal retirement (${initial ? "initial" : "durable incremental"} sync)`, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "operator-departure-"));
	const store = new ConversationManifestStore(join(root, "manifests"));
	const coordinator = manifest("coordinator", "coordinator"); const project = manifest("project");
	await store.write(coordinator); await store.write(project);
	const registry = new RelayRegistry("host", root, store); await registry.load();
	if (!initial) await registry.setMatrixCursor(coordinator.conversationId, "before");
	let sent = false; let membershipReads = 0;
	const matrix = new ManagedMatrixClient({ homeserver: "https://matrix.example.com", accessToken: "token", botUserId: "@bot:example.com", operatorUserId: operator }, async (input, init) => {
		if (String(input).includes("/sync")) {
			if (!sent) { sent = true; return Response.json({ next_batch: "after", ...response(project.roomId, [leave()]) }); }
			return new Promise<Response>((_resolve, reject) => {
				const fail = () => reject(new Error("aborted")); if (init?.signal?.aborted) fail(); else init?.signal?.addEventListener("abort", fail, { once: true });
			});
		}
		membershipReads++; throw Error("Departure must not require current joined membership");
	}, [coordinator.roomId, project.roomId]);
	const server = { attachment: () => undefined, sendToAttachment: () => false } as unknown as ManagedSessionIpcServer;
	const retirement = new ConversationRetirement({ registry, matrix, server, matrixAuthenticated: () => false,
		windows: { check: async () => "changed", terminate: async () => false } });
	let admit = initial; let attempts = 0;
	const makeRouter = () => new CoordinatorRouter(coordinator, registry, matrix, server, async () => assert.fail("departure cannot wake Pi"),
		undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
		async (item) => { attempts++; if (!admit) throw Error("injected pre-commit failure"); await retirement.retire(item.conversationId); });
	let router = makeRouter();
	t.after(async () => { await router.stop(); await retirement.close(); await rm(root, { recursive: true, force: true }); });
	await router.loadInbox(join(root, "inbox.json")); router.start();
	if (!initial) {
		await until(() => attempts > 0); await router.stop();
		assert.equal(registry.retirement(project.conversationId), undefined);
		admit = true; router = makeRouter(); await router.loadInbox(join(root, "inbox.json")); router.start();
	}
	await until(() => Boolean(registry.retirement(project.conversationId)));
	assert.equal(registry.manifestByConversationId(project.conversationId), undefined);
	assert.ok(registry.manifestByConversationId(coordinator.conversationId)); assert.equal(membershipReads, 0);
	assert.ok(registry.retirement(project.conversationId)?.cleanup?.some((item) => item.kind === "operator_leave_forget"));
});

for (const initial of [false, true]) test(`account intake commits before ${initial ? "initial" : "incremental"} host cursor`, async t => {
	const root = await mkdtemp(join(tmpdir(), "account-cursor-")); const store = new ConversationManifestStore(join(root, "manifests"));
	const coordinator = manifest("coordinator", "coordinator"); await store.write(coordinator); const registry = new RelayRegistry("host", root, store); await registry.load();
	if (!initial) await registry.setMatrixCursor(coordinator.conversationId, "before");
	let intake = false; let release!: () => void; const hold = new Promise<void>(resolve => { release = resolve; }); let sent = false;
	const matrix = new ManagedMatrixClient({ homeserver: "https://matrix.example.com", accessToken: "bot", botUserId: "@bot:example.com", operatorUserId: operator }, async (_input, init) => {
		if (!sent) { sent = true; return Response.json({ next_batch: "after", to_device: { events: [] } }); }
		return new Promise<Response>((_resolve, reject) => { if (init?.signal?.aborted) reject(Error("aborted")); else init?.signal?.addEventListener("abort", () => reject(Error("aborted")), { once: true }); });
	}, [coordinator.roomId]);
	const router = new CoordinatorRouter(coordinator, registry, matrix, { attachment: () => undefined } as unknown as ManagedSessionIpcServer, async () => {},
		undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
		async () => { intake = true; await hold; });
	t.after(async () => { release(); await router.stop(); await rm(root, { recursive: true, force: true }); }); await router.loadInbox(join(root, "inbox.json")); router.start();
	await until(() => intake); assert.notDeepEqual(registry.snapshot().conversations.find(c => c.conversationId === coordinator.conversationId)!.matrixCursor, { status: "established", since: "after" });
	release(); await until(() => { const cursor = registry.snapshot().conversations.find(c => c.conversationId === coordinator.conversationId)!.matrixCursor; return cursor.status === "established" && cursor.since === "after"; });
});

test("coordinator departure preserves identity and persists the no-automatic-reinvite marker", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "coordinator-departure-")); t.after(() => rm(root, { recursive: true, force: true }));
	const store = new ConversationManifestStore(join(root, "manifests")); const coordinator = manifest("coordinator", "coordinator"); const project = manifest("project");
	await store.write(coordinator); await store.write(project);
	const registry = new RelayRegistry("host", root, store); await registry.load();
	await registry.recordCoordinatorDeparture(coordinator.conversationId);
	await assert.rejects(registry.recordCoordinatorDeparture(project.conversationId), /canonical retirement/);
	const recovered = new RelayRegistry("host", root, store); await recovered.load();
	assert.deepEqual(recovered.manifestByConversationId(coordinator.conversationId), registry.manifestByConversationId(coordinator.conversationId));
	assert.equal(recovered.snapshot().conversations.find((item) => item.conversationId === coordinator.conversationId)?.operatorDeparted, true);
	assert.equal(recovered.retirement(coordinator.conversationId), undefined);
});
