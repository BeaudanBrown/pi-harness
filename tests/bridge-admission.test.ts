import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BridgeRelay, connect } from "../config/agent/extensions/matrix-bridge/relay.js";
import { BridgeStore } from "../config/agent/extensions/matrix-bridge/store.js";
import { InteractionHttp, ROOM, USER, textEvent } from "./fixtures/matrix-bridge/interaction-http.js";
import { POLL_RESPONSE } from "../config/agent/extensions/matrix-bridge/interaction.js";

test("reconnect sync holds offline chat and votes without consuming their poll", { timeout: 3000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), "bridge-admission-")), file = join(root, "native.jsonl"), socket = join(root, "bridge.sock");
  writeFileSync(file, [{ type: "session", version: 3, id: "native", cwd: root }, { type: "custom", id: "boundary", customType: "matrix-bridge.boundary", data: { nativeId: "native" } }].map(entry => JSON.stringify(entry) + "\n").join(""));
  const http = new InteractionHttp(), relay = new BridgeRelay({ hostId: "host", stateDirectory: join(root, "state"), socket, roots: [root] }, http.matrix);
  t.after(async () => { await relay.stop(); rmSync(root, { recursive: true, force: true }); });
  await relay.start(false);
  let calls = 0;
  const peer = await connect(socket, async () => { calls++; return { accepted: false, deferred: true }; });
  t.after(() => peer.close());
  await peer.request("register", { protocol: 2, file, nativeId: "native", boundary: "boundary", title: "Native", idle: true });
  const binding = relay.store.bindings()[0]!; relay.store.setRoom(binding.key, ROOM);
  relay.store.intake("initial", []);
  const question = relay.store.offerInteraction(binding.key, "q", { kind: "question", question: "Choose?", options: ["A", "B"] });
  await relay.pump(); const poll = relay.store.outputs(binding.key, `interaction:${question.id}`)[0]!.eventId!;
  const vote = (id: string) => ({ event_id: id, sender: USER, type: POLL_RESPONSE, content: { "m.relates_to": { rel_type: "m.reference", event_id: poll }, [POLL_RESPONSE]: { answers: ["answer-0"] } } });
  http.syncs.push({ next_batch: "caught-up", rooms: { join: { [ROOM]: { timeline: { events: [textEvent("$offline", "old chat"), vote("$old-vote")] } } } } });
  await relay.syncOnce(); await relay.pump();
  assert.equal(calls, 0); assert.equal(relay.store.interaction(question.id)?.state, "active");
  relay.store.intake("fresh", [{ id: "$fresh-vote", room: ROOM, event: vote("$fresh-vote") }]);
  await relay.pump();
  assert.equal(calls, 1); assert.equal(relay.store.interaction(question.id)?.state, "answered");
  assert.equal(relay.store.status(binding.key).queued, 1, "explicit no-submission keeps the answer in the inbox");
});

test("a definite deferral cannot revive an abort/disconnect hold", t => {
  const root = mkdtempSync(join(tmpdir(), "bridge-deferral-")), store = new BridgeStore(join(root, "state.sqlite"), "host");
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const binding = store.register({ file: "/fixture/native.jsonl", nativeId: "native", cwd: "/fixture", boundary: null, title: "Fixture" }); store.setRoom(binding.key, ROOM);
  store.intake("input", [{ id: "$input", room: ROOM, event: textEvent("$input", "instruction") }]); store.authorize("$input", { text: "instruction", sender: USER });
  store.takeBatch(binding.key, ["$input"]); store.disconnect(binding.key); store.deferBatch(binding.key, ["$input"]);
  assert.equal(store.status(binding.key).interrupted, 1); assert.equal(store.takeInput(binding.key), undefined);
});
