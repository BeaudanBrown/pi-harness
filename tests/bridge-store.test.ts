import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BridgeStore } from "../config/agent/extensions/matrix-bridge/store.js";

test("durable intake deduplicates and restart uncertainty never blocks a fresh request", () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-store-"));
  let store: BridgeStore | undefined;
  try {
    const filename = join(root, "bridge.sqlite");
    store = new BridgeStore(filename, "test-host");
    const binding = store.register({ file: "/project/session.jsonl", nativeId: "native-id", cwd: "/project", title: "Development", boundary: "before" });
    store.setRoom(binding.key, "!room:example.org");
    const first = { id: "$one", room: "!room:example.org", event: { type: "m.room.message", sender: "@friend:example.org", content: { msgtype: "m.text", body: "first" } } };
    store.intake("cursor-one", [first]);
    store.intake("cursor-two", [first]);
    assert.equal(store.status(binding.key).received, 1);
    store.authorize("$one", { text: "first", sender: "@friend:example.org" });
    assert.equal(store.takeInput(binding.key)?.id, "$one");
    store.close();
    store = new BridgeStore(filename, "test-host");
    assert.equal(store.status(binding.key).interrupted, 1);
    assert.equal(store.takeInput(binding.key), undefined);
    store.intake("cursor-three", [{ ...first, id: "$two" }]);
    store.authorize("$two", { text: "second", sender: "@friend:example.org" });
    assert.equal(store.takeInput(binding.key)?.id, "$two");
    assert.equal(store.takeInput(binding.key), undefined);
    assert.equal(store.cursor(), "cursor-three");
  } finally { store?.close(); rmSync(root, { recursive: true, force: true }); }
});

test("lost output acknowledgements retry the frozen payload and transaction after reopening", () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-output-"));
  let store = new BridgeStore(join(root, "bridge.sqlite"), "test-host");
  try {
    const binding = store.register({ file: "/project/session.jsonl", nativeId: "native", cwd: "/project", title: "Task", boundary: null });
    store.setRoom(binding.key, "!room:example.org");
    const [original] = store.offer(binding.key, "entry-1", () => [{ type: "m.room.message", content: { msgtype: "m.text", body: "original" } }]);
    store.close(); store = new BridgeStore(join(root, "bridge.sqlite"), "test-host");
    const [retry] = store.offer(binding.key, "entry-1", () => { throw Error("must not re-render an uncertain send"); });
    assert.deepEqual(retry, original);
    store.sent(retry!.id, "$sent");
    assert.equal(store.outputs(binding.key).length, 0);
    assert.equal(store.offer(binding.key, "entry-1", () => []).at(0)?.eventId, "$sent");
    assert.throws(() => store.sent(retry!.id, "$conflicting"), /Conflicting/);
    assert.throws(() => store.setRoom(binding.key, "!replacement:example.org"), /immutable/);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("intake failure commits neither a partial batch nor its cursor; queued input recovers", () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-atomic-"));
  let store = new BridgeStore(join(root, "bridge.sqlite"), "test-host");
  try {
    const binding = store.register({ file: "/p/session.jsonl", nativeId: "n", cwd: "/p", title: "Task", boundary: null });
    store.setRoom(binding.key, "!room:example.org");
    const event = { id: "$valid", room: "!room:example.org", event: { body: "hello" } };
    assert.throws(() => store.intake("bad-cursor", [event, { ...event, id: "$invalid", event: { invalid: 1n } }]));
    assert.equal(store.cursor(), undefined);
    assert.equal(store.status(binding.key).received, 0);
    store.intake("good-cursor", [event]); store.authorize(event.id, { text: "hello", sender: "@friend:example.org" });
    store.close(); store = new BridgeStore(join(root, "bridge.sqlite"), "test-host");
    assert.equal(store.status(binding.key).queued, 1);
    assert.equal(store.takeInput(binding.key)?.id, "$valid");
    assert.throws(() => store.register({ file: "/p/session.jsonl", nativeId: "different", cwd: "/p", title: "Replacement", boundary: null }));
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
