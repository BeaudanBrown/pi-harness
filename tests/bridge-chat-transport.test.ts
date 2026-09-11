import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { command, Store, OwnerMatrix, FAILURE, MAX_AGE_MS, MAX_PENDING, type ChatConfig, type ChatMatrix } from "../config/agent/extensions/bridge-chat/transport.js";
const NOW = 1800000000000, OWNER = "@owner:example.com", ROOM = "!one:example.com";
const CFG: ChatConfig = { homeserver: "https://matrix.example.com", ownerUserId: OWNER, remoteOwnerUserIds: ["@signal_self:example.com"], roomIds: [ROOM], allJoinedRooms: false, modelSocket: "/unused" };
const event = (id = "$one", ts = NOW, body = "!pi question") => ({ type: "m.room.message", sender: OWNER, event_id: id, origin_server_ts: ts, content: { msgtype: "m.text", body } });
const batch = (events: unknown[], room = ROOM, limited = false) => ({ next_batch: "cursor", rooms: { join: { [room]: { timeline: { limited, events } } } } });
class FakeMatrix implements ChatMatrix {
	sent: [string, string, string][] = []; allowed = true; fail = false;
	async usable() { return this.allowed; }
	async send(room: string, txn: string, text: string) { this.sent.push([room, txn, text]); if (this.fail) throw Error("unknown outcome"); return { event_id: "$reply" }; }
}
function fixture(t: { after(fn: () => void): void }) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-chat-store-")), filename = path.join(dir, "requests.sqlite");
	let store = new Store(filename);
	store.ingest(batch([event("$bootstrap", NOW - 2)]), CFG, NOW - 1, true);
	t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
	return { get store() { return store; }, filename, reopen() { store.close(); store = new Store(filename); },
		accept() { store.ingest(batch([event()]), CFG, NOW); }, rows() { return store.db.prepare("SELECT * FROM requests ORDER BY created,id").all(); } };
}
test("owner-only exact prefix, plain text, age, relations, malformed metadata and surrogate rejection", () => {
	assert.equal(command(event(), new Set([OWNER]), NOW - 1, NOW), "question");
	for (const body of ["!pi", "!pi ", "Hi !pi q", "Pi: !pi q", "!pilot q", "!PI q", "!pi " + "é".repeat(4001), "!pi \0", "!pi \ud800"]) assert.equal(command(event("$x", NOW, body), new Set([OWNER]), NOW - 1, NOW), undefined);
	assert.equal(command(event("$x", NOW, "!pi\nnew question"), new Set([OWNER]), NOW - 1, NOW), "new question");
	for (const change of [{ sender: "@stranger:example.com" }, { sender: {} }, { type: "m.room.encrypted" }, { event_id: "bad" }, { origin_server_ts: NOW + 30001 }, { origin_server_ts: true }, { unsigned: [] }, { unsigned: { redacted_because: {} } }, { content: [] }]) assert.equal(command({ ...event(), ...change }, new Set([OWNER]), NOW - 1, NOW), undefined);
	for (const key of ["m.relates_to", "m.new_content", "file", "url"]) assert.equal(command({ ...event(), content: { ...event().content, [key]: {} } }, new Set([OWNER]), NOW - 1, NOW), undefined);
	assert.equal(command(event("$old", NOW - MAX_AGE_MS - 1), new Set([OWNER]), 0, NOW), undefined);
	assert.equal(command({ ...event(), content: { msgtype: "m.image", body: "!pi image" } }, new Set([OWNER]), 0, NOW), undefined);
});
test("self puppet authority is explicit, not inferred from display metadata", () => {
	const e = { ...event(), sender: CFG.remoteOwnerUserIds[0] };
	assert.equal(command(e, new Set([OWNER]), 0, NOW), undefined);
	assert.equal(command(e, new Set([OWNER, e.sender]), 0, NOW), "question");
});
test("initial, new and limited discard floors survive replay/restart", t => {
	const f = fixture(t), cfg = { ...CFG, allJoinedRooms: true };
	for (const kind of ["initial", "new", "limited"]) {
		const room = "!" + kind + ":example.com";
		if (kind === "limited") f.store.ingest(batch([], room), cfg, NOW - 1);
		const before = f.rows().length, skipped = event("$skipped-" + kind, NOW + 1000);
		f.store.ingest(batch([skipped], room, kind === "limited"), cfg, NOW, kind === "initial"); f.reopen();
		f.store.ingest(batch([skipped], room), cfg, NOW + 1001); assert.equal(f.rows().length, before);
		f.store.ingest(batch([event("$new-" + kind, NOW + 1002)], room), cfg, NOW + 1002); assert.equal(f.rows().length, before + 1);
	}
});
test("dedup, no plain chatter persistence and cleared completed text", async t => {
	const f = fixture(t), matrix = new FakeMatrix(), questions: string[] = [];
	f.store.ingest(batch([event("$ordinary", NOW, "ordinary private sentinel")]), CFG, NOW); assert.equal(f.rows().length, 0);
	f.accept(); f.accept();
	await f.store.step(matrix, async q => { questions.push(q); return "answer"; }, CFG, () => NOW);
	f.accept(); await f.store.step(matrix, async () => assert.fail("duplicate model"), CFG, () => NOW);
	assert.deepEqual(questions, ["question"]); assert.equal(matrix.sent.length, 1); assert.equal(matrix.sent[0][0], ROOM);
	assert.deepEqual([f.rows()[0].phase, f.rows()[0].question, f.rows()[0].answer], ["done", "", ""]);
	assert.equal(fs.readFileSync(f.filename).includes(Buffer.from("ordinary private sentinel")), false);
});
test("sync acceptance and cursor are one atomic transaction", t => {
	const f = fixture(t); const bad: any = batch([event()]); bad.next_batch = "new"; bad.rooms.join["!bad"] = { timeline: [] };
	assert.throws(() => f.store.ingest(bad, CFG, NOW)); assert.equal(f.rows().length, 0); assert.equal(f.store.get("cursor"), "cursor");
});
for (const phase of ["running", "ready", "sending"]) test(`restart in ${phase} recovers conservatively`, async t => {
	const f = fixture(t), matrix = new FakeMatrix(); f.accept(); f.store.phase(String(f.rows()[0].id), phase, "saved answer"); f.reopen();
	await f.store.step(matrix, async () => assert.fail("must not retry model"), CFG, () => NOW);
	if (phase === "sending") { assert.equal(f.rows()[0].phase, "uncertain"); assert.equal(matrix.sent.length, 0); }
	else { assert.equal(matrix.sent[0][2], phase === "running" ? FAILURE : "saved answer"); assert.equal(f.rows()[0].phase, "done"); }
});
test("uncertain Matrix send never retries even after restart", async t => {
	const f = fixture(t), matrix = new FakeMatrix(); matrix.fail = true; f.accept();
	await f.store.step(matrix, async () => "answer", CFG, () => NOW); f.reopen(); f.accept();
	await f.store.step(matrix, async () => assert.fail("retry"), CFG, () => NOW);
	assert.equal(matrix.sent.length, 1); assert.equal(f.rows()[0].phase, "uncertain"); assert.equal(f.rows()[0].answer, "");
});
test("changed encryption, scope and auth policy block old work", async t => {
	const f = fixture(t), matrix = new FakeMatrix(); f.accept();
	await f.store.step(matrix, async () => { matrix.allowed = false; return "answer"; }, CFG, () => NOW);
	assert.equal(matrix.sent.length, 0); assert.equal(f.rows()[0].phase, "discarded");
	f.store.ingest(batch([event("$next")]), CFG, NOW); f.store.resetPolicy(); assert.equal(f.store.pending(), 0);
});
test("capacity, expired requests, model failures and retention remain bounded", async t => {
	const f = fixture(t), matrix = new FakeMatrix();
	for (let i = 0; i <= MAX_PENDING; i++) f.store.ingest(batch([event("$" + i)]), CFG, NOW);
	assert.equal(f.store.pending(), MAX_PENDING);
	await f.store.step(matrix, async () => assert.fail("expired model"), CFG, () => NOW + MAX_AGE_MS + 1);
	assert.match(matrix.sent[0][2], /expired/);
	await f.store.step(matrix, async () => { throw Error("private backend details"); }, CFG, () => NOW); assert.equal(matrix.sent[1][2], FAILURE);
	f.store.resetPolicy(); f.store.ingest(batch([event()]), CFG, NOW + 8 * 86400000); assert.equal(f.rows().length, 0);
});
test("capacity-discarded commands cannot become fresh after space is freed or restart", t => {
	const f = fixture(t);
	const events = Array.from({ length: MAX_PENDING + 1 }, (_, i) => event("$capacity-" + i));
	assert.equal(f.store.ingest(batch(events), CFG, NOW), 1);
	f.store.db.exec("UPDATE requests SET phase='done',question='',answer=''"); f.reopen();
	f.store.ingest(batch([events.at(-1)]), CFG, NOW + 1);
	assert.equal(f.store.pending(), 0); assert.equal(f.rows().length, MAX_PENDING);
});
test("room eligibility latency cannot execute a now-expired question", async t => {
	const f = fixture(t), matrix = new FakeMatrix(); let clock = NOW;
	f.accept(); matrix.usable = async () => { clock += MAX_AGE_MS + 1; return true; };
	await f.store.step(matrix, async () => assert.fail("expired model"), CFG, () => clock);
	assert.match(matrix.sent[0][2], /expired/);
});
test("two chats never share model context or response destination", async t => {
	const f = fixture(t), matrix = new FakeMatrix(), room = "!two:example.com", cfg = { ...CFG, roomIds: [ROOM, room] };
	f.store.ingest(batch([], room), cfg, NOW); f.accept(); f.store.ingest(batch([event("$second", NOW + 1, "!pi separate")], room), cfg, NOW + 1);
	for (let i = 0; i < 2; i++) await f.store.step(matrix, async q => q, cfg, () => NOW + 1);
	assert.deepEqual(Object.fromEntries(matrix.sent.map(([r, , q]) => [r, q])), { [ROOM]: "question", [room]: "separate" });
});
test("unlisted rooms and encrypted rooms never invoke the model", async t => {
	const f = fixture(t), matrix = new FakeMatrix();
	f.store.ingest(batch([], "!other"), CFG, NOW - 1); f.store.ingest(batch([event()], "!other"), CFG, NOW); assert.equal(f.rows().length, 0);
	f.accept(); matrix.allowed = false; await f.store.step(matrix, async () => assert.fail("model"), CFG, () => NOW); assert.equal(f.rows()[0].phase, "discarded");
});
test("rejoin is discard-only, store lock exclusive, and 404 is the only no-encryption status", async t => {
	const f = fixture(t); f.store.ingest({ next_batch: "left", rooms: { leave: { [ROOM]: {} } } }, CFG, NOW); f.accept(); assert.equal(f.rows().length, 0);
	assert.throws(() => new Store(f.filename));
	const client = new OwnerMatrix({ homeserver: CFG.homeserver, accessToken: "fixture" }, async url => new Response(String(url).includes("m.room.encryption") ? '{}' : '{"membership":"join"}', { status: String(url).includes("m.room.encryption") ? 404 : 200 }));
	assert.equal(await client.usable(ROOM, OWNER), true);
	const denied = new OwnerMatrix({ homeserver: CFG.homeserver, accessToken: "fixture" }, async () => new Response('{}', { status: 403 }));
	await assert.rejects(denied.usable(ROOM, OWNER));
});
