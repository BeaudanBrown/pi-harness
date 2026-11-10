import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { once } from "node:events";
import test from "node:test";

const pi = process.env.PI_BRIDGE_TEST_PI;
const sdk = process.env.PI_BRIDGE_TEST_SDK;
test.before(() => { assert.ok(pi); assert.ok(sdk); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-native-writer-"));
  const home = join(root, "home"); mkdirSync(home);
  const locks = join(root, "locks"); mkdirSync(locks, { mode: 0o700 });
  const file = join(root, "session.jsonl");
  const now = new Date().toISOString();
  writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: randomUUID(), timestamp: now, cwd: root }) + "\n");
  const env = { HOME: home, PATH: process.env.PATH, TERM: "xterm-256color", PI_CODING_AGENT_DIR: join(home, ".pi"), PI_SESSION_LOCK_DIRECTORY: locks };
  const script = (code) => spawnSync(process.execPath, ["--input-type=module", "-e", `import { SessionManager } from ${JSON.stringify(pathToFileURL(join(sdk, "core/session-manager.js")).href)}; ${code}`], { env, encoding: "utf8" });
  return { root, file, env, script };
}
function rpc(f) {
  const probe = join(f.root, "reload-probe.ts");
  writeFileSync(probe, 'export default function(pi) { pi.registerCommand("reload-check", {handler: async (_args, ctx) => { await ctx.reload(); }}); }');
  const child = spawn(pi, ["--mode", "rpc", "--session", f.file, "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-builtin-tools", "--extension", probe], { cwd: f.root, env: f.env });
  let next = 0, buffer = "", stderr = "";
  const pending = new Map();
  child.stderr.on("data", c => { stderr += c; });
  child.stdout.on("data", c => {
    buffer += c.toString();
    for (;;) {
      const end = buffer.indexOf("\n"); if (end < 0) break;
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (!line) continue;
      let event; try { event = JSON.parse(line); } catch { continue; }
      if (event.type === "response" && pending.has(event.id)) {
        const item = pending.get(event.id); pending.delete(event.id); clearTimeout(item.timer); item.resolve(event);
      }
    }
  });
  child.on("exit", code => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(Error(`Pi exited ${code}: ${stderr}`)); } pending.clear(); });
  const send = (type, extra = {}) => new Promise((resolve, reject) => {
    const id = String(++next);
    const timer = setTimeout(() => { pending.delete(id); reject(Error(`RPC timeout ${type}: ${stderr}`)); }, 15000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ id, type, ...extra }) + "\n");
  });
  return { child, send };
}

test("packaged Bun Pi and Node SDK share writer ownership, release on native new and resume", { timeout: 30000 }, async () => {
  const f = fixture(); const live = rpc(f);
  try {
    const state = await live.send("get_state"); assert.equal(state.success, true);
    const open = () => f.script(`const sm=SessionManager.open(${JSON.stringify(f.file)}); sm.dispose();`);
    assert.match(open().stderr, /already open/);
    const created = await live.send("new_session"); assert.equal(created.success, true, JSON.stringify(created));
    assert.equal(open().status, 0, open().stderr);
    const resumed = await live.send("switch_session", { sessionPath: f.file }); assert.equal(resumed.success, true, JSON.stringify(resumed));
    assert.match(open().stderr, /already open/);
    const reloaded = await live.send("prompt", { message: "/reload-check" }); assert.equal(reloaded.success, true, JSON.stringify(reloaded));
    assert.match(open().stderr, /already open/);
    const exited = once(live.child, "exit"); live.child.kill("SIGKILL"); await exited;
    assert.equal(open().status, 0);
  } finally { live.child.kill("SIGKILL"); rmSync(f.root, { recursive: true, force: true }); }
});

test("missing/empty/corrupt resume is rejected unchanged and failed switching keeps old ownership", () => {
  const f = fixture();
  try {
    for (const value of [null, "", "not a session\n", readFileSync(f.file, "utf8") + "broken json\n"]) {
      const bad = join(f.root, "bad.jsonl");
      if (value !== null) writeFileSync(bad, value);
      const result = f.script(`import assert from 'node:assert/strict'; const sm=SessionManager.open(${JSON.stringify(f.file)});
        assert.throws(()=>sm.setSessionFile(${JSON.stringify(bad)}));
        assert.equal(sm.getSessionFile(),${JSON.stringify(f.file)}); sm.dispose();`);
      assert.equal(result.status, 0, result.stderr);
      if (value !== null) assert.equal(readFileSync(bad, "utf8"), value);
      else assert.equal(existsSync(bad), false);
    }
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("native fork, tree navigation and dispose never leave the previous session locked", () => {
  const f = fixture();
  try {
    const result = f.script(`import assert from 'node:assert/strict';
      const sm=SessionManager.open(${JSON.stringify(f.file)});
      const id=sm.appendMessage({role:'user',content:'hello',timestamp:Date.now()});
      const clone=sm.createBranchedSession(id); assert.notEqual(clone,${JSON.stringify(f.file)});
      const previous=SessionManager.open(${JSON.stringify(f.file)}); previous.dispose();
      sm.branch(id); sm.resetLeaf(); sm.dispose();
      assert.throws(()=>sm.appendCustomEntry('after-dispose',{}),/disposed/);`);
    assert.equal(result.status, 0, result.stderr);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
