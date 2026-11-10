import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { credential, localEnvironment, localOpen } from "../config/agent/extensions/matrix-bridge/main.js";
import type { Binding } from "../config/agent/extensions/matrix-bridge/store.js";
import { interactiveProcess } from "../config/agent/extensions/matrix-bridge/adapter.js";

test("existing environment-file credentials are parsed as data, never exported or evaluated", () => {
  assert.equal(credential("# token\nPI_MATRIX_ACCESS_TOKEN=opaque-token\n"), "opaque-token");
  assert.equal(credential('PI_MATRIX_ACCESS_TOKEN="literal$token"'), "literal$token");
  assert.throws(() => credential("OTHER=value\nPI_MATRIX_ACCESS_TOKEN=token"));
  assert.throws(() => credential("PI_MATRIX_ACCESS_TOKEN=\n"));
  assert.deepEqual(localEnvironment({ HOME: "/home/user", PATH: "/bin", PI_MATRIX_ACCESS_TOKEN: "secret", CREDENTIALS_DIRECTORY: "/run/secret", TMUX: "old-server", PI_MANAGED_SESSION_LAUNCH_ROLE: "coordinator" }), { HOME: "/home/user", PATH: "/bin" });
});

test("automatic enrollment recognizes human text mode and excludes headless, worker and experimental launchers", () => {
  const argv = process.argv;
  const keys = ["PI_HARNESS_ENABLE_PI_R", "PI_HARNESS_ENABLE_AGENTGRAPH", "PI_HARNESS_AGENT_PROFILE"];
  const saved = keys.map(key => process.env[key]);
  const streams = [process.stdin, process.stdout];
  const descriptors = streams.map(stream => Object.getOwnPropertyDescriptor(stream, "isTTY"));
  try {
    for (const key of keys) delete process.env[key];
    for (const stream of streams) Object.defineProperty(stream, "isTTY", { value: true, configurable: true });
    for (const args of [[], ["--mode", "text"], ["--mode=text"]]) {
      process.argv = ["pi", ...args]; assert.equal(interactiveProcess(), true);
    }
    for (const args of [["--mode", "rpc"], ["--mode=json"], ["--print"], ["-p"], ["--no-session"]]) {
      process.argv = ["pi", ...args]; assert.equal(interactiveProcess(), false);
    }
    process.argv = ["pi"];
    for (const [key, value] of [["PI_HARNESS_ENABLE_PI_R", "1"], ["PI_HARNESS_ENABLE_AGENTGRAPH", "1"], ["PI_HARNESS_AGENT_PROFILE", "worker-minimal"]] as const) {
      process.env[key] = value; assert.equal(interactiveProcess(), false); delete process.env[key];
    }
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    assert.equal(interactiveProcess(), false);
  } finally {
    process.argv = argv;
    keys.forEach((key, index) => { if (saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index]; });
    streams.forEach((stream, index) => { const descriptor = descriptors[index]; if (descriptor) Object.defineProperty(stream, "isTTY", descriptor); else Reflect.deleteProperty(stream, "isTTY"); });
  }
});

test("remote wake uses only the same local helper and frozen native identity without Matrix credentials", async () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-launch-wiring-")), helper = join(root, "pi-session"), captured = join(root, "captured.json");
  const binding: Binding = { key: "binding", file: join(root, "session with spaces.jsonl"), nativeId: "native-id", cwd: root, title: "Task", boundary: null, archived: false, enabled: true };
  writeFileSync(helper, `#!${process.execPath}\nconst fs=require('node:fs'); fs.writeFileSync(${JSON.stringify(captured)},JSON.stringify({args:process.argv.slice(2),env:process.env})); console.log(JSON.stringify({file:process.argv[3],id:process.argv[5],running:true}));\n`, { mode: 0o700 });
  const old = process.env.PI_MATRIX_ACCESS_TOKEN;
  process.env.PI_MATRIX_ACCESS_TOKEN = "must-not-reach-helper";
  try {
    await localOpen(helper)(binding);
    const observed = JSON.parse(readFileSync(captured, "utf8")) as { args: string[]; env: Record<string, string> };
    assert.deepEqual(observed.args, ["open", binding.file, "--expected-id", binding.nativeId]);
    assert.equal(observed.env.PI_MATRIX_ACCESS_TOKEN, undefined);
    assert.equal(observed.env.CREDENTIALS_DIRECTORY, undefined);
    assert.equal(observed.env.HOME, process.env.HOME);
    assert.throws(() => localOpen("relative-helper"), /absolute/);
  } finally {
    if (old === undefined) delete process.env.PI_MATRIX_ACCESS_TOKEN; else process.env.PI_MATRIX_ACCESS_TOKEN = old;
    rmSync(root, { recursive: true, force: true });
  }
});
