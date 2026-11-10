import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BridgeStore } from "../config/agent/extensions/matrix-bridge/store.js";
import { DatabaseSync } from "node:sqlite";
import { imageInfo } from "../config/agent/extensions/matrix-bridge/media.js";

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

test("schema-one upgrade preserves durable delivery facts and advances the version fence", () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-upgrade-")), file = join(root, "bridge.sqlite");
  let store = new BridgeStore(file, "host");
  try {
    const binding = store.register({ file: "/p/session.jsonl", nativeId: "native", cwd: "/p", title: "Task", boundary: "boundary" });
    store.setRoom(binding.key, "!room:example.test"); store.intake("saved-cursor", [{ id: "$queued", room: "!room:example.test", event: {} }]);
    store.authorize("$queued", { text: "preserved", sender: "@friend:example.test" });
    const output = store.offer(binding.key, "native:original", () => [{ type: "m.room.message", content: { body: "immutable" } }])[0]!;
    store.close();
    // Reconstitute the exact prior additive schema, not a production downgrade.
    const prior = new DatabaseSync(file);
    prior.exec("DROP TABLE tasks; DROP TABLE images; DROP TABLE interactions; DROP INDEX output_receipt; ALTER TABLE inputs DROP COLUMN interaction; UPDATE meta SET value='1' WHERE key='version'"); prior.close();
    store = new BridgeStore(file, "host");
    assert.equal(store.cursor(), "saved-cursor"); assert.equal(store.binding(binding.key)?.boundary, "boundary");
    assert.equal(store.nextInput(binding.key)?.prompt?.text, "preserved"); assert.deepEqual(store.outputs(binding.key)[0], output);
    const inspect = new DatabaseSync(file, { readOnly: true });
    assert.equal(inspect.prepare("SELECT value FROM meta WHERE key='version'").get()!.value, "3"); inspect.close();
    assert.throws(() => new BridgeStore(file, "wrong-host"), /another host/);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("schema-two upgrade preserves interaction, media, output and cursor identities while adding task creation", () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-upgrade-two-")), file = join(root, "bridge.sqlite"); let store = new BridgeStore(file, "host");
  try {
    const binding = store.register({ file: "/p/native.jsonl", nativeId: "native", cwd: "/p", title: "Task", boundary: "boundary" }); store.setRoom(binding.key, "!room:example.test");
    const question = store.offerInteraction(binding.key, "question", { kind: "question", nativeEntry: "question", question: "Keep?", options: ["Yes", "No"] });
    const output = store.outputs(binding.key)[0]!; store.sent(output.id, "$original-poll");
    const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    store.intake("saved-cursor-two", [{ id: "$image", room: "!room:example.test", event: {} }]); store.authorize("$image", { text: "caption", sender: "@friend:example.test", image: imageInfo(bytes) }, { image: bytes });
    store.saveProgress("setup:original", { room: "!room:example.test", stage: "invitation" }); store.close();
    const prior = new DatabaseSync(file); prior.exec("DROP TABLE tasks; UPDATE meta SET value='2' WHERE key='version'"); prior.close();
    store = new BridgeStore(file, "host"); assert.equal(store.cursor(), "saved-cursor-two"); assert.deepEqual(store.interaction(question.id), question);
    assert.equal(store.outputs(binding.key, `interaction:${question.id}`)[0]!.eventId, "$original-poll"); assert.equal(store.takeInput(binding.key)?.id, "$image");
    assert.deepEqual(Buffer.from(store.imageChunk(binding.key, "$image", 0).data, "base64"), bytes); assert.deepEqual(store.progress("setup:original"), { room: "!room:example.test", stage: "invitation" }); assert.deepEqual(store.tasks(["approval"]), []);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("large original media authorization is atomic, chunk-scoped and durable without export caps", () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-image-store-")), filename = join(root, "bridge.sqlite");
  let store = new BridgeStore(filename, "host");
  try {
    const binding = store.register({ file: "/p/native.jsonl", nativeId: "native", cwd: "/p", title: "Task", boundary: null });
    store.setRoom(binding.key, "!room:example.test"); store.intake("cursor", [{ id: "$image", room: "!room:example.test", event: { content: "original" } }]);
    // Synthetic signature payload: exercise size/storage, not image codec validity.
    const bytes = Buffer.alloc(25 * 1024 * 1024 + 1); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
    const info = imageInfo(bytes), prompt = { text: "caption", sender: "@friend:example.test", image: info };
    assert.throws(() => store.authorize("$image", { ...prompt, image: { ...info, sha256: "0".repeat(64) } }, { image: bytes }), /integrity/);
    assert.equal(store.status(binding.key).received, 1);
    store.authorize("$image", prompt, { image: bytes }); store.close(); store = new BridgeStore(filename, "host");
    assert.deepEqual(store.takeInput(binding.key)?.prompt?.image, info);
    assert.throws(() => store.imageChunk("another-binding", "$image", 0), /unavailable/);
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < bytes.length;) {
      const chunk = store.imageChunk(binding.key, "$image", offset), part = Buffer.from(chunk.data, "base64");
      assert.ok(Buffer.byteLength(JSON.stringify(chunk)) < 65536); chunks.push(part); offset += part.length;
      assert.equal(chunk.done, offset === bytes.length);
    }
    assert.deepEqual(Buffer.concat(chunks), bytes);
    store.settle(binding.key, "$image"); assert.throws(() => store.imageChunk(binding.key, "$image", 0), /unavailable/);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
