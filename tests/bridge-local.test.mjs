import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
const python = process.env.PI_TEST_PYTHON || "python3";
const tmux = process.env.PI_TEST_TMUX || "tmux";
const pi = process.env.PI_BRIDGE_TEST_PI;
const helper = resolve("config/agent/extensions/matrix-bridge/local.py");
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function fixture(t) {
  assert.ok(pi, "real packaged Pi is required");
  const root = mkdtempSync(join(tmpdir(), "pi-local-open-"));
  const home = join(root, "home"); mkdirSync(home);
  mkdirSync(join(home, ".config/tmux"), { recursive: true });
  writeFileSync(join(home, ".config/tmux/tmux.conf"), "");
  const history = join(root, "sessions"); mkdirSync(history);
  const file = join(history, "native.jsonl");
  const nativeId = randomUUID();
  const header = id => JSON.stringify({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd: root }) + "\n";
  writeFileSync(file, header(nativeId));
  const launcher = join(root, "pi"), ready = join(root, "ready"), probe = join(root, "ready.mjs");
  writeFileSync(probe, `import { writeFileSync } from "node:fs"; import {installPresentation} from ${JSON.stringify(resolve("config/agent/extensions/matrix-bridge/presentation.ts"))}; export default pi => { installPresentation(pi); pi.on("session_start", (_event, ctx) => { writeFileSync(${JSON.stringify(ready)}, ctx.sessionManager.getSessionId()); }); };`);
  const body = `exec '${pi}' --no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files --no-builtin-tools --extension '${probe}' "$@"\n`;
  const launch = prefix => writeFileSync(launcher, `#!/bin/sh\n${prefix ?? ""}${body}`, { mode: 0o700 });
  launch();
  const socket = join(root, "tmux.sock");
  const shell = spawnSync("sh", ["-c", "command -v sh"], { encoding: "utf8" }).stdout.trim();
  /** @type {NodeJS.ProcessEnv} */
  const env = { PATH: process.env.PATH, HOME: home, SHELL: shell, TERM: "xterm-256color", PI_CODING_AGENT_DIR: join(home, ".pi"), PI_SESSION_LOCK_DIRECTORY: join(root, "locks"), PI_BRIDGE_SESSION_ROOTS: JSON.stringify([history]), PI_BRIDGE_TMUX_SOCKET: socket, PI_BRIDGE_PI: launcher, PI_BRIDGE_TMUX: tmux };
  if (process.env.PI_BRIDGE_TEST_WINDOW_LAUNCHER) env.PI_BRIDGE_WINDOW_LAUNCHER = process.env.PI_BRIDGE_TEST_WINDOW_LAUNCHER;
  const call = (...args) => spawnSync(python, [helper, ...args], { env, encoding: "utf8", timeout: 15000 });
  const value = (...args) => { const result = call(...args); assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout); };
  const server = (...args) => spawnSync(tmux, ["-S", socket, ...args], { env, encoding: "utf8" });
  t.after(async () => {
    const state = pid => {
      try { const text = readFileSync(`/proc/${pid}/stat`, "utf8"); const fields = text.slice(text.lastIndexOf(")") + 2).split(" "); return { state: fields[0], birth: fields[19] }; }
      catch { return undefined; }
    };
    const owned = server("list-panes", "-a", "-F", "#{pane_pid}").stdout.trim().split("\n").filter(pid => /^\d+$/.test(pid)).map(pid => ({ pid, birth: state(pid)?.birth }));
    server("kill-server");
    // A tmux shutdown reply is not child exit. Wait for the actual fixture
    // processes before deleting directories they may still be initializing.
    const alive = () => owned.some(({ pid, birth }) => { const current = state(pid); return birth && current?.birth === birth && current.state !== "Z"; });
    const until = Date.now() + 5000;
    while (alive() && Date.now() < until) await pause(20);
    assert.equal(alive(), false, "disposable pane processes must exit before fixture removal");
    rmSync(root, { recursive: true, force: true });
  });
  return { root, file, nativeId, header, env, shell, launcher, launch, ready, call, value, server };
}

test("local list/open/status work with no relay, reuse the live writer and reopen after server loss", { timeout: 30000 }, async t => {
  const { root, file, nativeId, env, call, value, server } = fixture(t);
  assert.equal(value("list").length, 1);
  assert.equal(value("status", file).running, false);
  const concurrent = () => new Promise((resolve, reject) => {
    const child = spawn(python, [helper, "open", file], { env }); let stdout = "", stderr = "";
    child.stdout.on("data", c => { stdout += c; }); child.stderr.on("data", c => { stderr += c; });
    child.on("error", reject); child.on("close", status => resolve({ status, stdout, stderr }));
  });
  const results = await Promise.all([concurrent(), concurrent()]);
  assert.ok(results.some(r => r.status === 0), JSON.stringify(results));
  for (const failed of results.filter(r => r.status !== 0)) assert.match(failed.stderr, /open is in progress/);
  const first = JSON.parse(results.find(r => r.status === 0).stdout); assert.equal(first.running, true); assert.match(first.pane, /^%\d+$/);
  // A lost open reply never authorizes cancellation, a duplicate writer or replay.
  const second = value("open", file, "--expected-id", nativeId); assert.equal(second.pane, first.pane);
  assert.notEqual(call("open", file, "--expected-id", "different-session").status, 0);
  assert.ok(Number.isSafeInteger(second.serverPid) && second.serverPid > 0);
  assert.equal(server("list-panes", "-a", "-F", "#{pane_id}").stdout.trim().split("\n").length, env.PI_BRIDGE_WINDOW_LAUNCHER ? 2 : 1);
  assert.equal(value("list")[0].running, true);
  assert.notEqual(call("open", join(root, "missing.jsonl")).status, 0);
  server("kill-server");
  // Observe live pane hints disappearing, not a relay-disconnect receipt.
  const until = Date.now() + 4000;
  while (value("status", file).running && Date.now() < until) await pause(30);
  assert.equal(value("status", file).running, false);
  assert.equal(value("open", file).running, true);
});

;

test("a native process without presentation hints is not claimed as an exclusively owned session", { timeout: 10000 }, async t => {
  const { file, env, value, server } = fixture(t);
  const child = spawn(pi, ["--mode", "rpc", "--session", file, "--no-extensions", "--no-skills", "--no-context-files"], { env, stdio: ["pipe", "pipe", "pipe"] });
  const closed = new Promise(resolve => child.once("close", resolve));
  try {
    await new Promise((resolve, reject) => {
      let buffer = "", stderr = "";
      const timer = setTimeout(() => reject(Error("native RPC readiness timed out: " + stderr)), 5000);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.stderr.on("data", chunk => { stderr += chunk; });
      child.stdout.on("data", chunk => {
        buffer += chunk;
        if (buffer.split("\n").some(line => { try { return JSON.parse(line).id === "ready"; } catch { return false; } })) { clearTimeout(timer); resolve(); }
      });
      child.stdin.write(JSON.stringify({ type: "get_state", id: "ready" }) + "\n");
    });
    const observed = value("status", file);
    assert.equal(observed.running, false); assert.equal(observed.pane, undefined);
    assert.notEqual(server("list-panes", "-a").status, 0, "no tmux server was created");
  } finally { child.kill("SIGKILL"); await closed; }
});

test("native file and workspace semicolons remain literal arguments", { timeout: 10000 }, t => {
  const { root, nativeId, value, server } = fixture(t);
  const cwd = join(root, "plain directory;"); mkdirSync(cwd);
  const file = join(root, "native file;");
  writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: nativeId, cwd, timestamp: new Date().toISOString() }) + "\n");
  const opened = value("open", file, "--expected-id", nativeId);
  assert.equal(opened.running, true); assert.equal(opened.file, file);
  assert.equal(server("display-message", "-p", "-t", opened.pane, "#{pane_current_path}").stdout.trim(), cwd);
});

test("slow bootstrap is focusable, but a replaced pane cannot reserve the native session", { timeout: 30000 }, t => {
  const { root, file, launch, value, server, shell } = fixture(t);
  launch(`while [ ! -f '${root}/release' ]; do sleep 0.05; done\n`); // Explicit unreleased bootstrap, not a fixed sleep.
  const pending = value("open", file);
  assert.equal(pending.running, false); assert.equal(pending.pending, true);
  assert.equal(value("open", file).pane, pending.pane);
  assert.equal(value("list")[0].pending, true);
  assert.equal(value("status", file).pending, true);
  const hint = server("show-option", "-p", "-v", "-t", pending.pane, "@pi_native_launch").stdout.trim();
  server("set-option", "-p", "-t", pending.pane, "@pi_native_launch", JSON.stringify({ ...JSON.parse(hint), created: 0 }));
  assert.notEqual(value("status", file).pending, true, "a wedged live bootstrap has no permanent reservation");
  assert.equal(server("respawn-pane", "-k", "-t", pending.pane, shell, "-c", "exec cat").status, 0);
  // Preserve the old annotation deliberately: PID/birth, not its mere presence,
  // determines whether the now-unrelated live pane is a bootstrap hint.
  assert.equal(server("set-option", "-p", "-t", pending.pane, "@pi_native_launch", hint).status, 0);
  launch();
  const opened = value("open", file);
  assert.equal(opened.running, true); assert.notEqual(opened.pane, pending.pane);
  assert.equal(server("display-message", "-p", "-t", pending.pane, "#{pane_dead}").stdout.trim(), "0");
});

test("native /new releases old history without leaving a live bootstrap reservation", { timeout: 15000 }, async t => {
  const { file, nativeId, value, server, ready } = fixture(t);
  const original = value("open", file);
  const loaded = Date.now() + 5000;
  while (!existsSync(ready) && Date.now() < loaded) await pause(20);
  assert.equal(readFileSync(ready, "utf8"), nativeId);
  // Simulated human TUI input only. Bridge delivery never uses keystrokes.
  server("send-keys", "-t", original.pane, "-l", "/new"); server("send-keys", "-t", original.pane, "Enter");
  const switched = Date.now() + 5000;
  while (readFileSync(ready, "utf8") === nativeId && Date.now() < switched) await pause(20);
  assert.notEqual(readFileSync(ready, "utf8"), nativeId, "observe the real native session switch");
  const saved = value("status", file);
  assert.equal(saved.running, false); assert.notEqual(saved.pending, true);
  const resumed = value("open", file);
  assert.equal(resumed.running, true); assert.notEqual(resumed.pane, original.pane);
});

test("live partial appends do not gate listing/focus, while a saved corrupt file is rejected", { timeout: 10000 }, async t => {
  const { file, nativeId, value, call, ready } = fixture(t);
  appendFileSync(file, JSON.stringify({ id: "name", parentId: null, name: "Native title", type: "session_info" }) + "\n");
  assert.equal(value("list")[0].title, "Native title", "metadata field order is immaterial");
  const pane = value("open", file).pane;
  // Readiness is observed explicitly before simulating a partial append.
  const until = Date.now() + 5000;
  while (!existsSync(ready) && Date.now() < until) await pause(20);
  assert.ok(existsSync(ready), "actual session_start hook must finish before simulating a live append");
  appendFileSync(file, '{"type":"session_info","name":"incomplete');
  assert.equal(value("list")[0].running, true);
  assert.equal(value("open", file, "--expected-id", nativeId).pane, pane);
  assert.ok(readFileSync(file, "utf8").endsWith('"name":"incomplete'));
  const broken = file + ".broken.jsonl";
  writeFileSync(broken, readFileSync(file));
  assert.notEqual(call("open", broken).status, 0, "a non-running corrupt resume is an explicit error");
});

test("optional read-only archive presentation never gates native access or transfers between identities", { timeout: 15000 }, async t => {
  const { root, file, nativeId, header, env, value } = fixture(t);
  const state = join(root, "state"); mkdirSync(state, { mode: 0o700 });
  env.PI_BRIDGE_STATE_DIRECTORY = state;
  const bound = join(root, "outside-default-history.jsonl"), boundId = randomUUID();
  writeFileSync(bound, header(boundId));
  assert.ok(process.env.PI_BRIDGE_TEST_STORE, "compiled real BridgeStore is required");
  const { BridgeStore } = await import(pathToFileURL(process.env.PI_BRIDGE_TEST_STORE).href);
  const path = join(state, "bridge.sqlite"), store = new BridgeStore(path, "local-view");
  const binding = store.register({ file, nativeId, cwd: root, title: "Native", boundary: null });
  store.saveBinding({ ...binding, archived: true });
  store.register({ file: bound, nativeId: boundId, cwd: root, title: "Bound", boundary: null });
  store.close();
  const before = readFileSync(path);
  assert.deepEqual(value("list").map(row => row.file), [bound]);
  assert.equal(value("list", "--all").length, 2);
  assert.equal(value("status", file).archived, true);
  assert.deepEqual(readFileSync(path), before, "presentation does not modify the ledger");
  writeFileSync(file, header(randomUUID()));
  assert.equal(value("list").length, 2, "a different native identity does not inherit an archive flag");
  writeFileSync(file, header(nativeId));
  assert.equal(value("open", file).running, true, "archive is not local launch admission");
  writeFileSync(path, "unavailable ledger");
  assert.equal(value("list").length, 1, "corrupt optional state falls back to ordinary history roots");
  rmSync(path);
  assert.equal(spawnSync(python, ["-c", "import os,sys; os.mkfifo(sys.argv[1], 0o600)", path]).status, 0);
  assert.equal(value("list").length, 1, "a non-regular optional database must not block native discovery");
  env.PI_BRIDGE_STATE_DIRECTORY = "invalid-relative-cache";
  assert.equal(value("list").length, 1);
});

test("a blocked direnv bootstrap is retryable; an allowed project environment reaches native Pi", { timeout: 30000 }, t => {
  const { root, file, env, launch, call, value } = fixture(t);
  const direnv = process.env.PI_TEST_DIRENV || spawnSync("sh", ["-c", "command -v direnv"], { encoding: "utf8" }).stdout.trim();
  assert.ok(direnv.startsWith("/"), "real direnv is required");
  env.PI_BRIDGE_DIRENV = direnv;
  writeFileSync(join(root, ".envrc"), "export BRIDGE_PROJECT_PROBE=project\nPATH_add bin\n");
  mkdirSync(join(root, "bin"));
  writeFileSync(join(root, "bin/project-probe"), "#!/bin/sh\nprintf project-tool", { mode: 0o700 });
  launch(`printf '%s\\n' "$BRIDGE_PROJECT_PROBE" > '${root}/environment'\nproject-probe >> '${root}/environment'\n`);
  assert.notEqual(call("open", file).status, 0, "unapproved .envrc must not execute");
  assert.equal(spawnSync(direnv, ["allow", root], { env, encoding: "utf8" }).status, 0);
  assert.equal(value("open", file).running, true, "failure leaves no durable launch reservation");
  assert.equal(readFileSync(join(root, "environment"), "utf8"), "project\nproject-tool");
});
