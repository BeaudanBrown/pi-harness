import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BridgeStore } from "../config/agent/extensions/matrix-bridge/store.js";
import { BridgeRelay } from "../config/agent/extensions/matrix-bridge/relay.js";
import { InteractionHttp, ROOM, USER, textEvent } from "./fixtures/matrix-bridge/interaction-http.js";

// No latch waits for a remote-wake callback: that operation no longer exists.
test("detached input is rejected promptly without any wake callback", { timeout: 2000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), "bridge-no-wake-")), file = join(root, "native.jsonl");
  writeFileSync(file, [{ type: "session", version: 3, id: "native", cwd: root }, { type: "custom", id: "boundary", customType: "matrix-bridge.boundary", data: { nativeId: "native" } }].map(entry => JSON.stringify(entry) + "\n").join(""));
  const http = new InteractionHttp(); let opens = 0;
  const relay = new BridgeRelay({ hostId: "host", stateDirectory: join(root, "state"), socket: join(root, "bridge.sock"), roots: [root] }, http.matrix);
  t.after(async () => { await relay.stop(); rmSync(root, { recursive: true, force: true }); });
  const binding = relay.store.register({ file, nativeId: "native", cwd: root, boundary: "boundary", title: "Native" }); relay.store.setRoom(binding.key, ROOM);
  relay.store.intake("offline", [{ id: "$offline", room: ROOM, event: textEvent("$offline", "do not wake") }]);
  await relay.pump();
  assert.equal(opens, 0); assert.equal(relay.store.status(binding.key).queued, 0);
  assert.ok([...http.sent.values()].some(event => String(event.content.body).includes("Pi is offline")));
});

test("archive and restore only change presentation, retaining queued input, polls and history", { timeout: 2000 }, t => {
  const root = mkdtempSync(join(tmpdir(), "bridge-archive-only-")), file = join(root, "native.jsonl");
  writeFileSync(file, "unchanged native history");
  const store = new BridgeStore(join(root, "state", "bridge.sqlite"), "host");
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const binding = store.register({ file, nativeId: "native", cwd: root, boundary: null, title: "Native" }); store.setRoom(binding.key, ROOM);
  store.intake("queued", [{ id: "$queued", room: ROOM, event: textEvent("$queued", "waiting") }]);
  assert.equal(store.authorize("$queued", { text: "waiting", sender: USER }), true);
  const question = store.offerInteraction(binding.key, "question", { kind: "question", nativeEntry: "q", question: "Choose", options: ["A", "B"] });
  store.setArchived(binding.key, true, 0);
  assert.equal(store.interaction(question.id)?.state, "active"); assert.equal(store.status(binding.key).queued, 1);
  assert.equal(store.takeInput(binding.key)?.id, "$queued");
  assert.equal(store.setArchived(binding.key, false, 1).resumePending, false);
  assert.throws(() => store.setArchived(binding.key, true, 0), /changed/);
  assert.equal(store.binding(binding.key)?.room, ROOM); assert.equal(readFileSync(file, "utf8"), "unchanged native history");
});
