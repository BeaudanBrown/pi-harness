import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const pi = process.env.PI_BRIDGE_TEST_PI, sdk = process.env.PI_BRIDGE_TEST_SDK;
test.before(() => { assert.ok(pi); assert.ok(sdk); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-unpatched-")), home = join(root, "home"); mkdirSync(home);
  const file = join(root, "session.jsonl");
  writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: "native", timestamp: new Date().toISOString(), cwd: root }) + "\n");
  const env = { HOME: home, PATH: process.env.PATH, TERM: "xterm-256color", PI_CODING_AGENT_DIR: join(home, ".pi") };
  const script = code => spawnSync(process.execPath, ["--input-type=module", "-e", `import { SessionManager } from ${JSON.stringify(pathToFileURL(join(sdk, "core/session-manager.js")).href)}; ${code}`], { env, encoding: "utf8", timeout: 10000 });
  return { root, file, env, script };
}

test("unpatched SDK does not impose exclusive history ownership", () => {
  const f = fixture();
  try {
    const result = f.script(`import assert from 'node:assert/strict';
      const a=SessionManager.open(${JSON.stringify(f.file)}), b=SessionManager.open(${JSON.stringify(f.file)});
      assert.equal(a.getSessionId(),b.getSessionId());`);
    assert.equal(result.status, 0, result.stderr);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("upstream persistence defers custom-only sessions until conversation history exists", () => {
  const f = fixture();
  try {
    const result = f.script(`import assert from 'node:assert/strict'; import {readFileSync,existsSync} from 'node:fs';
      const sm=SessionManager.create(${JSON.stringify(f.root)},${JSON.stringify(join(f.root, "sessions"))});
      const file=sm.getSessionFile(); assert.equal(existsSync(file),false);
      const id=sm.appendCustomEntry('fixture',{}); assert.equal(existsSync(file),false);
      sm.appendMessage({role:'user',content:'hello',timestamp:1});
      sm.appendMessage({role:'assistant',content:[{type:'text',text:'hello'}],api:'fixture',provider:'fixture',model:'fixture',stopReason:'stop',timestamp:2,usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}});
      assert.equal(existsSync(file),true); assert.ok(readFileSync(file,'utf8').includes(id));`);
    assert.equal(result.status, 0, result.stderr);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("packaged upstream CLI retains local template expansion", { timeout: 20000 }, () => {
  const f = fixture();
  try {
    const template = join(f.root, "probe-template.md"); writeFileSync(template, "expanded $1");
    const result = spawnSync(pi, ["--print", "--no-session", "--no-extensions", "--no-skills", "--no-context-files", "--no-builtin-tools", "--extension", new URL("./fixtures/matrix-bridge/native-probe.mjs", import.meta.url).pathname, "--prompt-template", template, "--provider", "bridge-probe", "--model", "fake", "/probe-template raw"], { cwd: f.root, env: f.env, encoding: "utf8", timeout: 15000 });
    assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /probe answer/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
