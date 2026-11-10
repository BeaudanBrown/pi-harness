import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BridgeStore } from "../config/agent/extensions/matrix-bridge/store.js";
import { BridgeMatrix, syncIntoStore } from "../config/agent/extensions/matrix-bridge/matrix.js";
import { MatrixHttp } from "../config/agent/extensions/matrix-shared/http.js";

const event = (event_id: string) => ({ event_id, type: "m.room.message", sender: "@friend:example.org", content: { msgtype: "m.text", body: event_id } });
test("limited-room recovery is durable across restarts and cannot block healthy-room intake", async () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-sync-")), file = join(root, "state.sqlite");
  let store = new BridgeStore(file, "host"), recover = false;
  const requests: string[] = [];
  try {
    const a = store.register({ file: "/a.jsonl", nativeId: "a", cwd: "/a", title: "A", boundary: null });
    const b = store.register({ file: "/b.jsonl", nativeId: "b", cwd: "/b", title: "B", boundary: null });
    store.setRoom(a.key, "!a:example.org"); store.setRoom(b.key, "!b:example.org"); store.intake("s0", []);
    const matrix = new BridgeMatrix(new MatrixHttp({ homeserver: "https://example.org", accessToken: "test" }, async url => {
      const parsed = new URL(String(url));
      if (parsed.pathname.endsWith("/sync")) return Response.json({ next_batch: "s1", rooms: { join: {
        "!a:example.org": { timeline: { limited: true, events: [event("$a2")] } },
        "!b:example.org": { timeline: { events: [event("$b")] } },
      } } });
      const from = parsed.searchParams.get("from"); requests.push(String(from));
      assert.equal(parsed.searchParams.get("to"), "s1");
      if (from === "s0") return Response.json({ start: "s0", end: "p1", chunk: [event("$a1")] });
      if (!recover) return new Response("unavailable", { status: 503 });
      assert.equal(from, "p1"); return Response.json({ start: "p1", end: "s1", chunk: [event("$a2")] });
    }, { maxAttempts: 1 }), "@bridge:example.org");
    const failed = await syncIntoStore(matrix, store);
    assert.equal(failed.length, 1); assert.equal(failed[0]!.room, "!a:example.org");
    assert.equal(store.cursor(), "s0"); assert.equal(store.status(b.key).received, 1);
    assert.deepEqual(store.received(a.key).map(input => input.id), ["$a1"]);
    store.close(); store = new BridgeStore(file, "host"); recover = true;
    assert.deepEqual(await syncIntoStore(matrix, store), []);
    assert.equal(store.cursor(), "s1");
    assert.deepEqual(store.received(a.key).map(input => input.id), ["$a1", "$a2"]);
    assert.equal(store.status(b.key).received, 1);
    assert.deepEqual(requests, ["s0", "p1", "p1"]);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
