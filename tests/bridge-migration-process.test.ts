import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonical, exportSnapshot, inventory } from "../config/agent/extensions/matrix-bridge/migration-files.js";
import { checkMigration, importSnapshot } from "../config/agent/extensions/matrix-bridge/migration.js";

const source = process.env.PI_BRIDGE_MIGRATION_FIXTURE;
assert.ok(source, "immutable migration fixture is required");
for (const operation of ["export", "import"] as const) test(`actual SIGKILL at ${operation} durable boundaries never publishes partial state or changes frozen source`, () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-migration-death-")), before = inventory(source);
  const entry = operation === "export" ? require.resolve("../config/agent/extensions/matrix-bridge/migration-files.js") : require.resolve("../config/agent/extensions/matrix-bridge/migration.js");
  const boundaries = operation === "export" ? ["export-file", "export-before-marker", "before-publish", "after-publish"] : ["import-before-commit", "import-after-commit", "import-receipt", "before-publish", "after-publish"];
  try {
    for (const boundary of boundaries) {
      const target = join(root, boundary);
      const child: SpawnSyncReturns<string> = spawnSync(process.execPath, ["-e", `const fn=require(process.argv[1])[process.argv[2]]; fn(process.argv[3],process.argv[4],point=>{if(point===process.argv[5])process.kill(process.pid,'SIGKILL')});`, entry, operation === "export" ? "exportSnapshot" : "importSnapshot", source, target, boundary], {
        env: { HOME: root, TMPDIR: root, NODE_PATH: process.env.NODE_PATH, PI_NATIVE_LOCK_ADDON: process.env.PI_NATIVE_LOCK_ADDON }, encoding: "utf8", timeout: 10000,
      });
      assert.equal(child.signal, "SIGKILL", child.stderr); assert.equal(child.status, null);
      assert.equal(existsSync(target), boundary === "after-publish");
      if (boundary !== "after-publish") assert.ok(readdirSync(root).some(name => name.startsWith(`.${boundary}-partial-`)));
      if (operation === "export") assert.equal(exportSnapshot(source, target).digest, before.digest);
      else { assert.equal(importSnapshot(source, target).pristine, true); assert.equal(checkMigration(source, target).started, false); }
      assert.deepEqual(inventory(source), before);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("packaged import rejects malformed cursor and spent transaction reuse before creating any destination", () => {
  const main = process.env.PI_BRIDGE_MIGRATION_MAIN, bwrap = process.env.PI_BRIDGE_MIGRATION_BWRAP;
  assert.ok(main && bwrap, "packaged CLI and private read-only mount helper are required");
  for (const defect of ["cursor", "transaction"]) {
    const root = mkdtempSync(join(tmpdir(), "bridge-migration-invalid-")), copy = join(root, "snapshot"), target = join(root, "state");
    try {
      cpSync(source, copy, { recursive: true });
      const path = join(copy, "state/registry.json"), registry = JSON.parse(readFileSync(path, "utf8"));
      if (defect === "cursor") registry.conversations[0].matrixCursor = { status: "future" };
      else { const chunks = registry.conversations[0].projection[0].chunks; chunks[0].status = "sent"; chunks[1].transactionId = chunks[0].transactionId; }
      chmodSync(path, 0o600); writeFileSync(path, JSON.stringify(registry));
      const seal = join(copy, "inventory.json"), before = inventory(copy, false); chmodSync(seal, 0o600); writeFileSync(seal, canonical(before));
      const result: SpawnSyncReturns<string> = spawnSync(bwrap, ["--bind", "/", "/", "--dev-bind", "/dev", "/dev", "--ro-bind", copy, copy, "--", process.execPath, main, "import", copy, target], { env: { HOME: root, TMPDIR: root }, encoding: "utf8", timeout: 10000 });
      assert.equal(result.status, 1, result.stderr); assert.match(result.stderr, new RegExp(defect));
      assert.equal(existsSync(target), false); assert.ok(!readdirSync(root).some(name => name.includes("partial")));
      assert.deepEqual(inventory(copy, false), before);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("the packaged one-shot CLI exports/imports/checks without a bridge, credentials, Git or a running Matrix service", () => {
  const main = process.env.PI_BRIDGE_MIGRATION_MAIN;
  assert.ok(main, "packaged migration entrypoint is required, not skipped");
  const root = mkdtempSync(join(tmpdir(), "bridge-migration-cli-"));
  const call = (...args: string[]) => spawnSync(process.execPath, [main, ...args], { env: { HOME: root, TMPDIR: root }, encoding: "utf8", timeout: 10000 });
  try {
    for (const args of [["inventory", source], ["export", source, join(root, "backup")], ["import", source, join(root, "state")], ["check", source, join(root, "state")]]) {
      const result = call(...args); assert.equal(result.status, 0, result.stderr); const data = JSON.parse(result.stdout);
      assert.ok(data.source); assert.ok(result.stdout.length < 4096);
    }
    const invalid = call("import", join(root, "backup"), join(root, "not-published"));
    assert.equal(invalid.status, 1); assert.match(invalid.stderr, /Writable\/live/); assert.equal(existsSync(join(root, "not-published")), false);
    const ledger = join(root, "state/bridge.sqlite"), bytes = readFileSync(ledger);
    writeFileSync(`${ledger}-wal`, "uncertain evidence");
    const held = call("check", source, join(root, "state"));
    assert.equal(held.status, 1); assert.match(held.stderr, /journal evidence/);
    assert.deepEqual(readFileSync(ledger), bytes); assert.equal(readFileSync(`${ledger}-wal`, "utf8"), "uncertain evidence");
    assert.equal(existsSync(`${ledger}-shm`), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
