import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import test from "node:test";
const python = process.env.PI_TEST_PYTHON || "python3";
const tmux = process.env.PI_TEST_TMUX || "tmux";
const pi = process.env.PI_BRIDGE_TEST_PI;
const helper = resolve("config/agent/extensions/matrix-bridge/local.py");
test("local list/open/status work with no relay, reuse the live writer and reopen after server loss", { timeout: 30000 }, async () => {
  assert.ok(pi, "real packaged Pi is required");
  const root = mkdtempSync(join(tmpdir(), "pi-local-open-"));
  const home = join(root, "home"); mkdirSync(home);
  const history = join(root, "sessions"); mkdirSync(history);
  const file = join(history, "native.jsonl");
  writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: randomUUID(), timestamp: new Date().toISOString(), cwd: root }) + "\n");
  const launcher = join(root, "pi");
  writeFileSync(launcher, `#!/bin/sh\nexec '${pi}' --no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files --no-builtin-tools "$@"\n`, { mode: 0o700 });
  const socket = join(root, "tmux.sock");
  const env = { PATH: process.env.PATH, HOME: home, TERM: "xterm-256color", PI_CODING_AGENT_DIR: join(home, ".pi"), PI_SESSION_LOCK_DIRECTORY: join(root, "locks"), PI_BRIDGE_SESSION_ROOTS: JSON.stringify([history]), PI_BRIDGE_TMUX_SOCKET: socket, PI_BRIDGE_PI: launcher, PI_BRIDGE_TMUX: tmux };
  const call = (...args) => spawnSync(python, [helper, ...args], { env, encoding: "utf8", timeout: 15000 });
  const value = (...args) => { const result = call(...args); assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout); };
  const server = (...args) => spawnSync(tmux, ["-S", socket, ...args], { env, encoding: "utf8" });
  try {
    assert.equal(value("list").length, 1);
    assert.equal(value("status", file).running, false);
    const concurrent = () => new Promise((resolve, reject) => {
      const child = spawn(python, [helper, "open", file], { env }); let stdout = "", stderr = "";
      child.stdout.on("data", c => { stdout += c; }); child.stderr.on("data", c => { stderr += c; });
      child.on("error", reject); child.on("exit", status => resolve({ status, stdout, stderr }));
    });
    const results = await Promise.all([concurrent(), concurrent()]);
    assert.ok(results.some(r => r.status === 0), JSON.stringify(results));
    for (const failed of results.filter(r => r.status !== 0)) assert.match(failed.stderr, /open is in progress/);
    const first = JSON.parse(results.find(r => r.status === 0).stdout); assert.equal(first.running, true); assert.match(first.pane, /^%\d+$/);
    // Retrying after a lost open response observes the same writer and pane.
    const second = value("open", file); assert.equal(second.pane, first.pane);
    assert.equal(server("list-panes", "-a", "-F", "#{pane_id}").stdout.trim().split("\n").length, 1);
    assert.equal(value("list")[0].running, true);
    assert.notEqual(call("open", join(root, "missing.jsonl")).status, 0);
    server("kill-server");
    // Native Pi receives terminal hangup. This checks its actual lock lifetime,
    // not a fabricated relay-disconnect/exit receipt.
    const until = Date.now() + 4000;
    while (value("status", file).running && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);
    assert.equal(value("status", file).running, false);
    const reopened = value("open", file); assert.equal(reopened.running, true);
  } finally { server("kill-server"); rmSync(root, { recursive: true, force: true }); }
});
