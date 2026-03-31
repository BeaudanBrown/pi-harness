import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createRuntimeStatusAdapter } from "./runtime-status.mjs";

function envFor(runtimeDir) {
  return {
    PI_HARNESS_WORKSTREAM_ID: "focus-bugfix",
    PI_HARNESS_RUNTIME_DIR: runtimeDir,
    PI_HARNESS_TMUX_SESSION: "ph:focus-bugfix",
  };
}

async function readRuntimeFile(runtimeDir) {
  const filePath = path.join(runtimeDir, "focus-bugfix.json");
  return JSON.parse(await readFile(filePath, "utf8"));
}

test("registers the required lifecycle hooks when configured", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "pi-harness-runtime-"));
  const adapter = createRuntimeStatusAdapter({ env: envFor(runtimeDir) });
  const handlers = new Map();
  const pi = {
    on(event, handler) {
      handlers.set(event, handler);
    },
  };

  adapter.register(pi);

  assert.deepEqual([...handlers.keys()].sort(), [
    "agent_end",
    "agent_start",
    "session_shutdown",
    "session_start",
  ]);
});

test("session_start writes an idle runtime record", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "pi-harness-runtime-"));
  const adapter = createRuntimeStatusAdapter({
    env: envFor(runtimeDir),
    cwd: () => "/tmp/project",
    now: () => "2026-03-31T02:00:00Z",
  });

  await adapter.handleSessionStart();

  assert.deepEqual(await readRuntimeFile(runtimeDir), {
    schemaVersion: 1,
    workstreamId: "focus-bugfix",
    tmuxSession: "ph:focus-bugfix",
    state: "idle",
    cwd: "/tmp/project",
    lastSeenAt: "2026-03-31T02:00:00Z",
  });
});

test("agent lifecycle writes processing then idle while preserving lastProcessingAt", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "pi-harness-runtime-"));
  let tick = 0;
  const timestamps = [
    "2026-03-31T02:00:00Z",
    "2026-03-31T02:01:00Z",
    "2026-03-31T02:02:00Z",
    "2026-03-31T02:03:00Z",
  ];
  const adapter = createRuntimeStatusAdapter({
    env: envFor(runtimeDir),
    cwd: () => "/tmp/project",
    now: () => timestamps[tick++],
  });

  await adapter.handleSessionStart();
  await adapter.handleAgentStart();
  let status = await readRuntimeFile(runtimeDir);
  assert.equal(status.state, "processing");
  assert.equal(status.lastSeenAt, "2026-03-31T02:01:00Z");
  assert.equal(status.lastProcessingAt, "2026-03-31T02:01:00Z");

  await adapter.handleAgentEnd();
  status = await readRuntimeFile(runtimeDir);
  assert.equal(status.state, "idle");
  assert.equal(status.lastSeenAt, "2026-03-31T02:02:00Z");
  assert.equal(status.lastProcessingAt, "2026-03-31T02:01:00Z");

  await adapter.handleSessionShutdown();
  status = await readRuntimeFile(runtimeDir);
  assert.equal(status.state, "idle");
  assert.equal(status.lastSeenAt, "2026-03-31T02:03:00Z");
  assert.equal(status.lastProcessingAt, "2026-03-31T02:01:00Z");

  const entries = await readdir(runtimeDir);
  assert.deepEqual(entries, ["focus-bugfix.json"]);
});

test("missing harness environment leaves the extension inert", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "pi-harness-runtime-"));
  const adapter = createRuntimeStatusAdapter({
    env: { PI_HARNESS_RUNTIME_DIR: runtimeDir },
    cwd: () => "/tmp/project",
  });
  const handlers = new Map();

  adapter.register({
    on(event, handler) {
      handlers.set(event, handler);
    },
  });
  const wrote = await adapter.handleAgentStart();

  assert.equal(wrote, false);
  assert.equal(handlers.size, 0);
  assert.deepEqual(await readdir(runtimeDir), []);
});
