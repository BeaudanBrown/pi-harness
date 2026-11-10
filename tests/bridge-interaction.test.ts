import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { BridgeRelay, connect } from "../config/agent/extensions/matrix-bridge/relay.js";
import { object, type Peer } from "../config/agent/extensions/matrix-bridge/wire.js";
import { readImage } from "../config/agent/extensions/matrix-bridge/media.js";
import { POLL_START, POLL_RESPONSE, POLL_END } from "../config/agent/extensions/matrix-bridge/interaction.js";
import { BOT, USER, ROOM, InteractionHttp, textEvent } from "./fixtures/matrix-bridge/interaction-http.js";

async function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "bridge-interaction-")), file = join(root, "native.jsonl"), socket = join(root, "bridge.sock");
  const config = { hostId: "host", stateDirectory: join(root, "state"), socket, roots: [root] }, http = new InteractionHttp();
  writeFileSync(file, [JSON.stringify({ type: "session", version: 3, id: "native", cwd: root }), JSON.stringify({ type: "custom", id: "boundary", customType: "matrix-bridge.boundary", data: { nativeId: "native" } })].join("\n") + "\n");
  let now = Date.now(); t.mock.method(Date, "now", () => now);
  let opens = 0, relay = new BridgeRelay(config, http.matrix, async () => { opens++; }), peer: Peer | undefined, cursor = 0;
  const delivered: Array<{ id: string; prompt: Record<string, unknown>; image?: { data: string; mimeType: string } }> = [];
  const attach = async () => {
    peer = await connect(socket, async (_method, params) => {
      const id = String(params.id); let payload = "";
      for (;;) { const chunk = object(await peer!.request("input.read", { id, offset: payload.length })); payload += String(chunk.text); if (chunk.done) break; }
      const prompt = object(JSON.parse(payload)), image = prompt.image ? await readImage(peer!, id, prompt.image, () => true) : undefined;
      delivered.push({ id, prompt, ...(image ? { image } : {}) }); return { accepted: true };
    });
    const registration = object(await peer.request("register", { file, nativeId: "native", boundary: "boundary", title: "Native", idle: true }));
    return String(registration.key);
  };
  await relay.start(false); const key = await attach(); relay.store.setRoom(key, ROOM); relay.store.intake("live", []);
  t.after(async () => { peer?.close(); await relay.stop(); rmSync(root, { recursive: true, force: true }); });
  const intake = (...events: Array<Record<string, unknown>>) => relay.store.intake(`cursor-${++cursor}`, events.map(event => ({ id: String(event.event_id), room: ROOM, event })));
  return { root, file, http, key, delivered, get relay() { return relay; }, get opens() { return opens; }, intake,
    question: (id = "question", options = ["First", "Second"]) => appendFileSync(file, JSON.stringify({ type: "custom", id, customType: "matrix-bridge.question", data: { nativeId: "native", checkpoint: { kind: "question", decision: "Which option?", options } } }) + "\n"),
    observe: () => intake(...http.sent.values()),
    advance: () => { now += 6000; },
    detach: async () => { peer?.close(); peer = undefined; await new Promise(resolve => setTimeout(resolve, 10)); },
    restart: async () => { peer?.close(); await relay.stop(); relay = new BridgeRelay(config, http.matrix, async () => { opens++; }); await relay.start(false); await attach(); now += 6000; },
  };
}
const vote = (id: string, event: string, answer = "answer-0", sender = USER) => ({ event_id: id, sender, type: POLL_RESPONSE, content: { "m.relates_to": { rel_type: "m.reference", event_id: event }, [POLL_RESPONSE]: { answers: [answer] } } });

test("concurrent votes/text fallback resolve a native question once and obsolete explicit replies never dispatch", async t => {
  const f = await fixture(t); f.question(); await f.relay.pump(); f.observe();
  const start = [...f.http.sent.values()].find(event => event.type === POLL_START)!;
  f.intake(vote("$one", start.event_id), textEvent("$two", "ordinary fallback"), vote("$three", start.event_id, "answer-1", "@second:example.test"));
  await Promise.all([f.relay.pump(), f.relay.pump()]);
  assert.equal(f.delivered.length, 1); assert.equal(f.delivered[0]!.id, "$one"); assert.equal(f.delivered[0]!.prompt.question, "question");
  assert.ok([...f.http.sent.values()].some(event => event.type === POLL_END));
  f.intake(vote("$one", start.event_id), vote("$obsolete", start.event_id), { ...textEvent("$stale-text", "Second"), content: { msgtype: "m.text", body: "Second", "m.relates_to": { "m.in_reply_to": { event_id: start.event_id } } } });
  await f.relay.pump(); assert.equal(f.delivered.length, 1);
  await f.restart(); f.intake(textEvent("$fresh", "A genuinely fresh request")); await f.relay.pump();
  assert.deepEqual(f.delivered.map(item => item.id), ["$one", "$fresh"]);
});

test("plain text fallback uses timeline order, not clocks or messages posted before the question", async t => {
  const f = await fixture(t); f.question(); await f.relay.pump();
  f.intake(textEvent("$early", "posted before the poll")); f.observe(); f.intake(textEvent("$answer", "ordinary text answer"));
  await f.relay.pump();
  assert.deepEqual(f.delivered.map(item => item.id), ["$answer"]);
  assert.equal(f.delivered[0]!.prompt.text, "ordinary text answer");
  assert.ok([...f.http.sent.values()].some(event => String(event.content.body).includes("preceded the displayed question")));
});

test("lost poll start/end receipts survive restart and keep exactly the original transactions and bodies", async t => {
  const f = await fixture(t); f.question(); f.http.loseType = POLL_START; await f.relay.pump();
  const start = [...f.http.sent.values()].find(event => event.type === POLL_START)!;
  f.intake(vote("$vote-before-ack", start.event_id)); await f.restart(); await f.relay.pump();
  assert.equal(f.delivered.length, 0, "unknown publication receipt cannot authorize a vote yet");
  f.http.loseType = POLL_END; await f.relay.pump(); assert.equal(f.delivered.length, 1);
  await f.restart(); await f.relay.pump();
  assert.equal(f.delivered.length, 1);
  for (const type of [POLL_START, POLL_END]) {
    const entries = [...f.http.sent.entries()].filter(([, event]) => event.type === type); assert.equal(entries.length, 1);
    assert.equal(f.http.attempts.filter(id => id === entries[0]![0]).length, 2);
  }
});

test("departed/ignored senders and malformed/foreign votes never resolve a question", async t => {
  const f = await fixture(t); f.question(); await f.relay.pump(); f.observe();
  const start = [...f.http.sent.values()].find(event => event.type === POLL_START)!;
  f.intake(vote("$outsider", start.event_id, "answer-0", "@outside:example.test"), vote("$bot", start.event_id, "answer-0", BOT),
    vote("$service", start.event_id, "answer-0", "@service:example.test"), vote("$foreign", "$foreign"), vote("$malformed", start.event_id, "answer-999"));
  await f.relay.pump(); assert.equal(f.delivered.length, 0); assert.equal(f.relay.store.activeInteraction(f.key)?.state, "active");
  f.intake(vote("$valid", start.event_id)); await f.relay.pump(); assert.equal(f.delivered.length, 1);
});

test("local input closes old questions and publication replay cannot cancel a later recorded question", async t => {
  const f = await fixture(t); f.question("old"); await f.relay.pump(); f.observe();
  appendFileSync(f.file, JSON.stringify({ type: "message", id: "local", message: { role: "user", content: "answered locally" } }) + "\n");
  f.question("new");
  const save = f.relay.store.saveProgress.bind(f.relay.store);
  let failed = false;
  t.mock.method(f.relay.store, "saveProgress", (key: string, value: unknown) => {
    if (!failed && key === `projection:${f.key}` && value === "new") { failed = true; throw Error("crash before final projection checkpoint"); }
    return save(key, value);
  });
  await f.relay.pump(); assert.equal(failed, true);
  await f.restart(); await f.relay.pump(); assert.equal(f.relay.store.activeInteraction(f.key)?.nativeEntry, "new");
});

test("original JPEG/PNG/WebP bytes, captions and captionless input cross bounded private frames once", async t => {
  const f = await fixture(t);
  for (const extension of ["jpg", "png", "webp"]) {
    const bytes = readFileSync(resolve(`tests/fixtures/matrix-bridge/input.${extension}`)); f.http.media = bytes;
    const id = `$${extension}`, event = { event_id: id, sender: USER, type: "m.room.message", content: { msgtype: "m.image", url: "mxc://remote.example/media", ...(extension === "webp" ? {} : { filename: "photo" }), body: extension === "png" ? "original caption" : extension === "webp" ? "caption without filename" : "photo", info: { size: "stale", w: 1000000, mimetype: "wrong/client-hint" } } };
    f.intake(event, event); await f.relay.pump(); const received = f.delivered.at(-1)!;
    assert.equal(received.id, id); assert.deepEqual(Buffer.from(received.image!.data, "base64"), bytes);
    assert.equal(received.prompt.text, extension === "png" ? "original caption" : extension === "webp" ? "caption without filename" : "Please analyze the attached image.");
  }
  assert.equal(f.http.downloads, 3); assert.equal(f.delivered.length, 3);
  assert.ok(!JSON.stringify([...f.http.sent.values()]).includes("daemon-only-token"));
});

test("unsupported/encrypted media explains the whole rejection, never dispatches its caption as a prompt", async t => {
  const f = await fixture(t); f.http.media = Buffer.from("not an image");
  for (const [id, content] of [["bad", { msgtype: "m.image", body: "important caption", filename: "x", url: "mxc://example.test/bad" }],
    ["encrypted", { msgtype: "m.image", body: "important caption", file: { url: "mxc://example.test/encrypted" } }],
    ["video", { msgtype: "m.video", body: "important caption" }]] as const) f.intake({ event_id: `$${id}`, sender: USER, type: "m.room.message", content });
  await f.relay.pump(); assert.equal(f.delivered.length, 0); assert.equal(f.http.sent.size, 3);
  assert.ok([...f.http.sent.values()].every(event => /caption/.test(String(event.content.body))));
});

test("corrupted private image chunks cannot reach the native handoff", async t => {
  const f = await fixture(t); f.http.media = readFileSync(resolve("tests/fixtures/matrix-bridge/input.png"));
  const read = f.relay.store.imageChunk.bind(f.relay.store);
  t.mock.method(f.relay.store, "imageChunk", (...args: Parameters<typeof read>) => ({ ...read(...args), sha256: "0".repeat(64) }));
  f.intake({ event_id: "$corrupt", type: "m.room.message", sender: USER, content: { msgtype: "m.image", url: "mxc://example.test/image" } });
  await f.relay.pump(); assert.equal(f.delivered.length, 0); assert.equal(f.relay.store.status(f.key).interrupted, 1);
});

test("a failed poll publication cannot stall another room's persisted output", async t => {
  const f = await fixture(t); f.question(); f.http.failRoom = ROOM;
  const file = join(f.root, "healthy.jsonl");
  writeFileSync(file, [JSON.stringify({ type: "session", version: 3, id: "healthy", cwd: f.root }), JSON.stringify({ type: "custom", id: "boundary", customType: "matrix-bridge.boundary", data: { nativeId: "healthy" } })].join("\n") + "\n");
  const binding = f.relay.store.register({ file, nativeId: "healthy", cwd: f.root, title: "Healthy", boundary: "boundary" }); f.relay.store.setRoom(binding.key, "!healthy:example.test");
  appendFileSync(file, JSON.stringify({ type: "message", id: "answer", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Healthy persisted output" }] } }) + "\n");
  await f.relay.pump();
  assert.ok([...f.http.sent.values()].some(event => event.room_id === "!healthy:example.test" && event.content.body === "Healthy persisted output"));
  assert.ok(f.relay.store.outputs(f.key).some(output => output.type === POLL_START));
});

test("help/status/stop do not wake detached Pi; explicit start opens without a model turn", async t => {
  const f = await fixture(t); await f.detach();
  for (const [id, body] of [["help", "!help"], ["status", "!status"], ["stop", "!stop"], ["unknown", "!host repair"]]) {
    f.intake(textEvent(`$${id}`, body!)); await f.relay.pump();
  }
  assert.equal(f.opens, 0); assert.equal(f.delivered.length, 0);
  f.intake(textEvent("$start", "!start")); await f.relay.pump(); assert.equal(f.opens, 1);
  await f.relay.pump(); assert.equal(f.opens, 1); assert.equal(f.delivered.length, 0);
});
