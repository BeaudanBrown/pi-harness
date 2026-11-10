import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BridgeStore } from "../config/agent/extensions/matrix-bridge/store.js";
import { assistantPolicyFingerprint, OwnerMatrix, Store, validateConfig } from "../config/agent/extensions/bridge-chat/transport.js";

const config = { homeserver: "https://example.test", ownerUserId: "@owner:example.test", remoteOwnerUserIds: [], roomIds: ["!room:example.test"], allJoinedRooms: false, modelSocket: "/fixture.sock" };

test("legacy store presence refuses a new writer without converting, creating or erasing files", t => {
  const root = mkdtempSync(join(tmpdir(), "bridge-legacy-refusal-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const marker of ["registry.json", "v1-to-v2-migration.json", "archives.json", "archives.json.initialized", "retirements"]) {
    for (const dangling of [false, true]) {
      const path = join(root, marker), bytes = Buffer.from("uninterpreted legacy evidence\n");
      if (dangling) symlinkSync("unavailable-original", path); else writeFileSync(path, bytes, { mode: 0o600 });
      const before = readdirSync(root); let opened: BridgeStore | undefined;
      try {
        assert.throws(() => { opened = new BridgeStore(join(root, "bridge.sqlite"), "host"); }, /Legacy managed store.*offline migration/);
        assert.deepEqual(readdirSync(root), before, "refusal must not create a ledger or sidecars");
        if (!dangling) assert.deepEqual(readFileSync(path), bytes);
      } finally { opened?.close(); rmSync(path); }
    }
  }
});

test("packaged startup diagnoses an old store before credentials or Matrix HTTP", t => {
  const root = mkdtempSync(join(tmpdir(), "bridge-legacy-cli-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const main = process.env.PI_BRIDGE_TEST_MAIN; assert.ok(main, "actual packaged bridge entrypoint is required");
  const state = join(root, "registry.json"), settings = join(root, "config.json");
  writeFileSync(state, "original legacy bytes\n", { mode: 0o600 });
  writeFileSync(settings, JSON.stringify({ hostId: "host", stateDirectory: root, socket: join(root, "bridge.sock"), roots: [root],
    homeserver: "https://must-not-contact.invalid", botUserId: "@bot:example.test", operatorUserId: config.ownerUserId, ignoredSenderUserIds: [], localHelper: "/must-not-launch" }));
  const before = readdirSync(root);
  const result = spawnSync(process.execPath, [main, "--config", settings, "--credential-file", join(root, "absent-credential")], { encoding: "utf8", timeout: 5000, env: { HOME: root, PATH: "" } });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Legacy managed store.*offline migration/);
  assert.deepEqual(readdirSync(root), before); assert.equal(readFileSync(state, "utf8"), "original legacy bytes\n");
});

test("removed account configuration is rejected even when empty or invitations are disabled", () => {
  for (const managedAccountHosts of [[], [{ hostId: "host", botUserId: "@bot:example.test", deviceId: "old" }]]) {
    assert.throws(() => validateConfig({ ...config, managedAccountHosts }), /Legacy managed account configuration is unsupported/);
  }
  assert.deepEqual(validateConfig({ ...config }), config);
});

test("account removal preserves the existing stateless assistant policy and pending work", t => {
  const root = mkdtempSync(join(tmpdir(), "bridge-assistant-policy-")), filename = join(root, "requests.sqlite");
  let store = new Store(filename); t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  // Before removal the fingerprint omitted both account policies. Freeze that
  // historical formula without importing any legacy consumer or decoder.
  const priorFingerprint = createHash("sha256").update("typescript-v1:" + JSON.stringify(config) + "token").digest("hex");
  store.put("identity", priorFingerprint); store.put("cursor", "original-cutoff");
  const now = 100_000;
  store.ingest({ next_batch: "known-room-cutoff", rooms: { join: { [config.roomIds[0]]: { timeline: { limited: false, events: [] } } } } }, config, now - 1000);
  store.ingest({ next_batch: "next-cutoff", rooms: { join: { [config.roomIds[0]]: { timeline: { limited: false, events: [{
    type: "m.room.message", event_id: "$pending", sender: config.ownerUserId, origin_server_ts: now + 1,
    content: { msgtype: "m.text", body: "!pi keep this queued question" },
  }] } } } } }, config, now);
  assert.equal(store.pending(), 1); store.close(); store = new Store(filename);
  assert.equal(assistantPolicyFingerprint({ ...config, trustedBridgeBots: { host: "@bot:example.test" } }, "token"), store.get("identity"));
  assert.equal(store.get("cursor"), "next-cutoff"); assert.equal(store.pending(), 1);
  assert.notEqual(assistantPolicyFingerprint({ ...config, modelSocket: "/changed.sock" }, "token"), priorFingerprint);
});

test("stateless sync has no managed member or to-device intake", async () => {
  const matrix = new OwnerMatrix({ homeserver: config.homeserver, accessToken: "token" }, async url => {
    const query = new URL(String(url)).searchParams, filter = JSON.parse(query.get("filter")!);
    assert.equal(query.get("since"), "chat-cutoff");
    assert.deepEqual(filter.room.state.types, []); assert.deepEqual(filter.room.timeline.types, ["m.room.message"]);
    assert.deepEqual(filter.room.timeline.senders, [config.ownerUserId]);
    return new Response('{"next_batch":"next"}');
  });
  await matrix.sync("chat-cutoff", [config.ownerUserId], 0);
});
