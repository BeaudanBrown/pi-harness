import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationTitles, type MatrixNameEvent } from "../config/agent/extensions/managed-sessions/relay/conversation-titles.js";
import { TITLE_STATE_EVENT, conversationTitle, parseConversationTitle } from "../config/agent/extensions/managed-sessions/title-contracts.js";
import { deriveConversationId, deriveTranscriptEntryId, parseConversationManifest } from "../config/agent/extensions/managed-sessions/contracts.js";
import { ConversationManifestStore } from "../config/agent/extensions/managed-sessions/relay/manifest-store.js";
import { RelayRegistry } from "../config/agent/extensions/managed-sessions/relay/registry.js";
import { migrateV1Manifest } from "../config/agent/extensions/managed-sessions/v2-contracts.js";
import type { RuntimeObservation } from "../config/agent/extensions/managed-sessions/relay/runtime-observer.js";

const id = deriveConversationId("host", "titles"); const room = "!room:example.com"; const bot = "@bot:example.com";
const event = (name: string, n = 1, sender = "@operator:example.com"): MatrixNameEvent => ({ event_id: `$name-${n}`, sender, type: "m.room.name", state_key: "", content: { name } });
async function fixture(t: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "titles-")); t.after(() => rm(root, { recursive: true, force: true }));
	let source: { conversationId: string; sessionId: string; concept: string; title?: string; titleRevision?: number; roomId?: string } | undefined = { conversationId: id, sessionId: "pi-session", concept: "Original", roomId: room };
	let current: MatrixNameEvent | undefined = event("Original", 0, bot); let now = 10_000; let nextId = 10;
	let state: RuntimeObservation["runtimeState"] = "running"; let launchState: RuntimeObservation["launchState"] = "attached";
	const writes: Array<{ name: string; writeId: string }> = []; const published: unknown[] = [];
	const ports = { root, hostId: "host", botUserId: bot, now: () => now, runtime: () => new Map([[id, { runtimeState: state, launchState }]]),
		registry: { titleInventory: () => source ? [structuredClone(source)] : [], updateConversationTitle: async (cid: string, value: { title: string; revision: number }) => {
			assert.equal(cid, id); if (!source) throw Error("retired"); assert.ok((source.titleRevision ?? 0) <= value.revision); source.title = value.title; source.titleRevision = value.revision;
		} },
		readName: async () => current ? structuredClone(current) : undefined,
		writeName: async (_room: string, name: string, writeId: string) => { writes.push({ name, writeId }); current = { ...event(name, nextId++, bot), content: { name, [TITLE_STATE_EVENT]: writeId } }; return current.event_id; },
		changed: (_cid: string, value: unknown) => { published.push(value); },
	};
	let owner = new ConversationTitles(ports); t.after(() => owner.close());
	return { ports, writes, published, source: () => source, current: () => current, owner: () => owner,
		setEvent: (value: MatrixNameEvent) => { current = value; }, setState: (value: typeof state) => { state = value; }, setFailed: () => { launchState = "failed"; }, retire: () => { source = undefined; },
		tick: async () => { now += 1000; owner.kick(); await owner.settled(); },
		ingest: async (value: MatrixNameEvent, target = room) => { await owner.ingest({ rooms: { join: { [target]: { timeline: { events: [value] } } } } }); await owner.settled(); },
		restart: async () => { await owner.close(); owner = new ConversationTitles(ports); }, root,
	};
}

test("title normalization strips one exact prefix, stays Unicode-safe and lengthens fallback collisions", () => {
	assert.equal(conversationTitle("●  A\u202e\n title  ", id), "A title");
	assert.equal(conversationTitle("○ ○ title", id), "○ title");
	assert.equal(conversationTitle("●title", id), "●title");
	const fallback = conversationTitle("", id); assert.notEqual(conversationTitle("", id, new Set([fallback])), fallback);
	const emoji = conversationTitle("🚀".repeat(100), id); assert.ok(emoji.length <= 128); assert.doesNotThrow(() => parseConversationTitle({ title: emoji, revision: 1 }));
	for (const title of ["\u202e", "\u0000", "\ud800", " "]) assert.throws(() => parseConversationTitle({ title, revision: 1 }));
});

test("status writes are changed-only; own echoes never replace the accepted title; unknown keeps the marker", async t => {
	const f = await fixture(t); await f.tick(); assert.deepEqual(f.writes.map(row => row.name), ["● Original"]);
	await f.ingest(f.current()!); await f.tick(); assert.equal(f.writes.length, 1);
	f.setState("stopped"); await f.tick(); assert.equal(f.writes.at(-1)?.name, "○ Original");
	f.setState("unknown"); await f.tick(); assert.equal(f.writes.length, 2);
	const rename = { ...event("● New title", 100), content: { name: "● New title", [TITLE_STATE_EVENT]: f.writes[0]!.writeId } };
	f.setEvent(rename); await f.ingest(rename); await f.tick(); assert.equal(f.source()?.title, "New title");
	assert.equal(f.current()?.content.name, "○ New title", "unknown preserves the last-known marker across a manual rename");
	await f.ingest(event("old replay", 100)); await f.tick(); assert.equal(f.source()?.title, "New title");
	await f.ingest(event("foreign", 200), "!foreign:example.com"); assert.equal(f.source()?.title, "New title");
});

test("a failed retained launch displays stopped/failed rather than claiming running", async t => {
	const f = await fixture(t); await f.tick(); f.setState("unknown"); f.setFailed(); await f.tick();
	assert.equal(f.current()?.content.name, "○ Original");
});

test("native observations are generation-bound and durably idempotent across lost acknowledgement and restart", async t => {
	const f = await fixture(t); const first = await f.owner().observe(id, "pi-session", 1, "Renamed");
	assert.equal(first.title, "Renamed"); await f.restart();
	assert.deepEqual(await f.owner().observe(id, "pi-session", 1, "Renamed"), first);
	await assert.rejects(f.owner().observe(id, "pi-session", 1, "changed"), /Conflicting/);
	await assert.rejects(f.owner().observe(id, "old-session", 2, "stale"), /Stale/);
	await assert.rejects(f.owner().observe(id, "pi-session", 2, "stale", () => false), /Stale/);
	const newer = await f.owner().observe(id, "pi-session", 3, "Newest");
	assert.deepEqual(await f.owner().observe(id, "pi-session", 2, "Delayed"), newer);
	assert.equal(f.source()?.concept, "Original", "mutable titles never rewrite construction identity");
});

test("lost Matrix write response is resolved from exact state before another PUT", async t => {
	const f = await fixture(t); const write = f.ports.writeName;
	f.ports.writeName = async (...args) => { await write(...args); throw Error("accepted before connection failed"); };
	await f.tick(); assert.equal(f.writes.length, 1); await f.restart();
	for (let i = 0; i < 6; i++) await f.tick();
	assert.equal(f.writes.length, 1); assert.equal(f.source()?.title, "Original");
});

test("an in-flight old status PUT cannot restore the old canonical title or block native metadata", async t => {
	const f = await fixture(t); let release!: () => void; let started!: () => void;
	const gate = new Promise<void>(resolve => { release = resolve; }); const sending = new Promise<void>(resolve => { started = resolve; });
	const write = f.ports.writeName; f.ports.writeName = async (...args) => { started(); await gate; return write(...args); };
	const tick = f.tick(); await sending;
	await f.owner().observe(id, "pi-session", 1, "Latest"); assert.equal(f.source()?.title, "Latest");
	release(); await tick; f.ports.writeName = write; await f.tick();
	assert.deepEqual(f.writes.map(item => item.name), ["● Original", "● Latest"]);
	assert.equal(f.source()?.title, "Latest");
});

test("manual sync names are accepted during an older in-flight PUT and the latest human revision wins", async t => {
	const f = await fixture(t); await f.tick(); const write = f.ports.writeName; let release!: () => void, started!: () => void;
	const blocked = new Promise<void>(resolve => { release = resolve; }); const entering = new Promise<void>(resolve => { started = resolve; });
	f.ports.writeName = async (...args) => { started(); await blocked; return write(...args); };
	f.setState("stopped"); const working = f.tick(); await entering;
	for (let i = 0; i < 2; i++) {
		const name = event(`Manual ${i}`, 500 + i); f.setEvent(name);
		await f.owner().ingest({ rooms: { join: { [room]: { timeline: { events: [name] } } } } });
		assert.equal(f.source()?.title, `Manual ${i}`, "human observation is durably accepted without waiting for old network work");
	}
	release(); await working; f.ports.writeName = write; await f.tick();
	assert.equal(f.current()?.content.name, "○ Manual 1");
});

test("a malformed trailing event or own echo cannot consume an unaccepted human rename", async t => {
	for (const trailing of ["malformed", "own-echo"] as const) {
		const f = await fixture(t); await f.tick(); const human = event(`Human ${trailing}`, 600);
		const tail = trailing === "own-echo" ? f.current()! : { ...event("invalid", 601), content: { name: 42 } };
		const response = { rooms: { join: { [room]: { timeline: { events: [human, tail] } } } } };
		await f.owner().ingest(response); assert.equal(f.source()?.title, human.content.name);
		await f.owner().settled(); await f.tick(); assert.equal(f.current()?.content.name, `● ${human.content.name}`);
		const revision = f.source()?.titleRevision; await f.owner().ingest(response); await f.tick();
		assert.equal(f.source()?.titleRevision, revision, "the accepted event is still idempotent");
		await f.owner().ingest({ rooms: { join: { [room]: { timeline: { events: [event("older unseen", 599), human] } } } } });
		assert.equal(f.source()?.titleRevision, revision, "an already accepted newer human event fences older unseen history");
	}
});

test("initial sync history is not imported over a newer current room name", async t => {
	const f = await fixture(t); await f.tick(); await f.owner().observe(id, "pi-session", 1, "Newest"); await f.tick();
	await f.owner().ingest({ rooms: { join: { [room]: { timeline: { events: [event("Historical title", 700)] } } } } }, true);
	await f.tick(); assert.equal(f.source()?.title, "Newest");
});

test("a late GET is discarded after newer accepted metadata and retirement prevents fresh sends", async t => {
	const f = await fixture(t); let release!: () => void; let started!: () => void;
	const gate = new Promise<void>(resolve => { release = resolve; }); const reading = new Promise<void>(resolve => { started = resolve; });
	f.ports.readName = async () => { started(); await gate; return event("Old snapshot", 300); };
	const tick = f.tick(); await reading; await f.owner().observe(id, "pi-session", 1, "Newest"); release(); await tick;
	assert.equal(f.source()?.title, "Newest"); assert.equal(f.writes.length, 0);
	f.retire(); await f.tick(); await assert.rejects(f.owner().read(id), /retired/); assert.equal(f.writes.length, 0);
});

test("rate-limit deadlines survive restart and rapid native names coalesce into the newest state", async t => {
	const f = await fixture(t); const write = f.ports.writeName; let attempts = 0;
	f.ports.writeName = async () => { attempts++; throw Object.assign(Error("rate limited"), { retryAfterMs: 5000 }); };
	await f.tick(); assert.equal(attempts, 1); assert.equal(f.owner().status(id), "pending"); await f.restart();
	await f.owner().observe(id, "pi-session", 1, "A"); await f.owner().observe(id, "pi-session", 2, "B"); await f.owner().observe(id, "pi-session", 3, "Latest");
	for (let i = 0; i < 4; i++) await f.tick(); assert.equal(attempts, 1);
	f.ports.writeName = async (...args) => { attempts++; return write(...args); }; await f.tick();
	assert.equal(attempts, 2); assert.deepEqual(f.writes.map(item => item.name), ["● Latest"]); assert.equal(f.owner().status(id), "ready");
});

test("presentation persistence failure does not block sync intake and current state is recovered after restart", async t => {
	const f = await fixture(t); await f.tick(); const saved = await readFile(join(f.root, `${id}.json`), "utf8");
	// Corrupt only this metadata file; unrelated message intake must still advance.
	const { writeFile } = await import("node:fs/promises"); await writeFile(join(f.root, `${id}.json`), "broken");
	const renamed = event("Manual during metadata outage", 400); f.setEvent(renamed); await f.ingest(renamed);
	assert.equal(f.owner().status(id), "pending");
	// Explicit repair in this fixture restores the last valid journal, not history replay.
	await writeFile(join(f.root, `${id}.json`), saved); await f.restart(); await f.tick();
	assert.equal(f.source()?.title, "Manual during metadata outage");
});

test("title journals recover portable projection failure without replaying old native names", async t => {
	const f = await fixture(t); const update = f.ports.registry.updateConversationTitle;
	f.ports.registry.updateConversationTitle = async () => { throw Error("disk projection failure"); };
	await assert.rejects(f.owner().observe(id, "pi-session", 1, "Durable"), /disk/);
	assert.equal(JSON.parse(await readFile(join(f.root, `${id}.json`), "utf8")).title, "Durable");
	f.ports.registry.updateConversationTitle = update; await f.restart();
	assert.equal((await f.owner().read(id)).title, "Durable"); assert.equal(f.source()?.title, "Durable");
});

test("a slow room does not hold another room's title writer or native metadata lane", { timeout: 5000 }, async t => {
	const root = await mkdtemp(join(tmpdir(), "title-rooms-")); let release!: () => void; let written!: () => void;
	const blocked = new Promise<void>(resolve => { release = resolve; }); const otherWritten = new Promise<void>(resolve => { written = resolve; });
	const rows: Array<{ conversationId: string; sessionId: string; concept: string; roomId: string; title?: string; titleRevision?: number }> = [0, 1].map(n => ({ conversationId: deriveConversationId("host", `room-${n}`), sessionId: `session-${n}`, concept: `Room ${n}`, roomId: `!room-${n}:example.com` }));
	const owner = new ConversationTitles({ root, hostId: "host", botUserId: bot, runtime: () => new Map(rows.map(row => [row.conversationId, { runtimeState: "running", launchState: "attached" }])),
		registry: { titleInventory: () => structuredClone(rows), updateConversationTitle: async (id, title) => { Object.assign(rows.find(row => row.conversationId === id)!, { title: title.title, titleRevision: title.revision }); } },
		readName: async room => { if (room === rows[0]!.roomId) await blocked; return undefined; },
		writeName: async room => { if (room === rows[1]!.roomId) written(); return `$${room.slice(1)}`; }, changed: () => undefined });
	t.after(async () => { release(); await owner.close(); await rm(root, { recursive: true, force: true }); });
	owner.kick(); await otherWritten;
	assert.equal((await owner.observe(rows[1]!.conversationId, rows[1]!.sessionId, 1, "Still responsive")).title, "Still responsive");
	release(); await owner.settled();
});

test("portable title revision survives real registry reload and v2 conversion without changing binding identity", async t => {
	const root = await mkdtemp(join(tmpdir(), "title-registry-")); t.after(() => rm(root, { recursive: true, force: true }));
	const store = new ConversationManifestStore(join(root, "manifests"));
	const manifest = parseConversationManifest({ schemaVersion: "1.0.0", kind: "project", ownerHostId: "host", conversationId: id, creationKey: "titles", concept: "Original", piSessionId: "pi-session", roomId: room,
		placement: { rootKey: "projects", workspace: "titles", relativeCwd: "" }, bindingBoundaryEntryId: deriveTranscriptEntryId("pi-session", "boundary"), createdAt: new Date().toISOString() });
	await store.write(manifest); const registry = new RelayRegistry("host", root, store); await registry.load();
	await registry.updateConversationTitle(id, { title: "New title", revision: 1 });
	await assert.rejects(registry.updateConversationTitle(id, { title: "Conflicting", revision: 1 }), /conflict/);
	const restored = new RelayRegistry("host", root, store); await restored.load();
	const saved = restored.registeredConversation(id)!; assert.equal(saved.title, "New title"); assert.equal(saved.concept, "Original"); assert.equal(saved.piSessionId, "pi-session");
	assert.equal(migrateV1Manifest(saved).titleRevision, 1); assert.equal(restored.conversationMetadata()[0]?.title, "New title");
});
