import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { BridgeStore } from "../config/agent/extensions/matrix-bridge/store.js";
import { BridgeMatrix, syncIntoStore } from "../config/agent/extensions/matrix-bridge/matrix.js";
import { MatrixHttp } from "../config/agent/extensions/matrix-shared/http.js";

const event = (event_id: string) => ({ event_id, type: "m.room.message", sender: "@friend:example.org", content: { msgtype: "m.text", body: event_id } });
test("one atomic sync skips a limited room, preserves queued chat, and never backfills or replays", async t => {
  const root = mkdtempSync(join(tmpdir(), "bridge-sync-")), file = join(root, "state.sqlite");
  let store = new BridgeStore(file, "host"); t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const a = store.register({ file: "/a", nativeId: "a", cwd: "/", title: "A", boundary: null }), b = store.register({ ...a, file: "/b", nativeId: "b" });
  const room = "!a:example.org", healthy = "!b:example.org"; store.setRoom(a.key, room); store.setRoom(b.key, healthy);
  store.intake("s0", [{ id: "$queued", room, event: event("$queued") }]); store.authorize("$queued", { text: "queued", sender: "@friend:example.org" });
  let fresh = false;
  const matrix = new BridgeMatrix(new MatrixHttp({ homeserver: "https://example.org", accessToken: "fixture" }, async url => {
    assert.ok(new URL(String(url)).pathname.endsWith("/sync"), "no history recovery requests");
    return Response.json({ next_batch: fresh ? "s2" : "s1", rooms: { join: {
      [room]: { timeline: { limited: !fresh, events: [event("$missed"), ...(fresh ? [event("$fresh")] : [])] } },
      [healthy]: { timeline: { events: [event("$healthy")] } },
    } } });
  }), "@bot:example.org");
  const fault = new DatabaseSync(file); t.after(() => fault.close());
  fault.exec("CREATE TRIGGER fault BEFORE UPDATE ON meta WHEN NEW.key='cursor' BEGIN SELECT RAISE(ABORT,'fixture fault'); END");
  await assert.rejects(syncIntoStore(matrix, store), /fixture fault/);
  assert.equal(store.cursor(), "s0"); assert.deepEqual(store.outputs(a.key), []); assert.deepEqual(store.received(b.key), []);
  fault.exec("DROP TRIGGER fault"); await syncIntoStore(matrix, store);
  assert.equal(store.cursor(), "s1"); assert.deepEqual(store.outputs(b.key), []); assert.equal(store.outputs(a.key).length, 1);
  assert.deepEqual(store.queuedInputs(a.key).map(x => x.id), ["$queued"]); assert.deepEqual(store.received(b.key).map(x => x.id), ["$healthy"]);
  const notice = store.outputs(a.key)[0]!.id;
  store.close(); store = new BridgeStore(file, "host"); fresh = true; await syncIntoStore(matrix, store);
  assert.deepEqual(store.outputs(a.key).map(x => x.id), [notice]); assert.deepEqual(store.received(a.key).map(x => x.id), ["$fresh"]);
});
