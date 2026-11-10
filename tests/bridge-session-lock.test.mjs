import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import test from "node:test";

const modulePath = resolve("config/agent/extensions/matrix-bridge/session-lock.cjs");
const native = process.env.PI_NATIVE_LOCK_ADDON;
const root = mkdtempSync(join(tmpdir(), "pi-writer-test-"));
const directory = join(root, "locks");
mkdirSync(directory, { mode: 0o700 });
const session = join(root, "session.jsonl");
writeFileSync(session, '{"type":"session","version":3,"id":"test"}\n');
const env = { ...process.env, PI_NATIVE_LOCK_ADDON: native, PI_SESSION_LOCK_DIRECTORY: directory };
const prelude = `const { acquireSessionLock } = require(${JSON.stringify(modulePath)}); const file = ${JSON.stringify(session)};`;
const attempt = (code = "") => spawnSync(process.execPath, ["-e", `${prelude} const release = acquireSessionLock(file); ${code} release();`], { env, encoding: "utf8" });

test.before(() => assert.ok(native, "set PI_NATIVE_LOCK_ADDON to the compiled N-API addon; this test must not skip"));
test.after(() => rmSync(root, { recursive: true, force: true }));
function firstOutput(child) {
  return Promise.race([
    once(child.stdout, "data").then(([bytes]) => bytes),
    once(child, "exit").then(([code]) => { throw Error(`child exited before ready: ${code}`); }),
  ]);
}
test("native writer lock excludes another process and releases after SIGKILL", async () => {
  const child = spawn(process.execPath, ["-e", `${prelude} acquireSessionLock(file); console.log('owned'); setInterval(()=>{},1000);`], { env });
  try {
    await firstOutput(child);
    const second = attempt();
    assert.notEqual(second.status, 0);
    assert.match(second.stderr, /already open/);
    const closed = once(child, "exit");
    child.kill("SIGKILL");
    await closed;
    const third = attempt();
    assert.equal(third.status, 0, third.stderr);
  } finally { child.kill("SIGKILL"); }
});

test("references within a native switch keep ownership until the last manager releases", () => {
  const result = attempt(`const release2=acquireSessionLock(file); release();
    const check=require('node:child_process').spawnSync(process.execPath,['-e',${JSON.stringify(`${prelude} acquireSessionLock(file);`)}],{env:process.env});
    if(check.status===0) throw Error('released during handoff'); release2();`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(attempt().status, 0);
});

test("an unrelated exec child cannot keep the writer lock alive", async () => {
  const child = spawn(process.execPath, ["-e", `${prelude} acquireSessionLock(file);
    const p=require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},10000)'],{detached:true,stdio:'ignore'}); p.unref(); console.log(JSON.stringify({ pid: p.pid }));`], { env });
  let descendant;
  try {
    const bytes = await firstOutput(child);
    descendant = JSON.parse(bytes.toString().trim()).pid;
    assert.ok(Number.isInteger(descendant) && descendant > 0);
    await once(child, "exit");
    process.kill(descendant, 0);
    const result = attempt();
    assert.equal(result.status, 0, result.stderr);
  } finally { if (descendant) try { process.kill(descendant, "SIGTERM"); } catch {} }
});

test("path aliases share ownership and stale lock files are harmless", async () => {
  const result = attempt(`const fs=require('node:fs'); const alias=${JSON.stringify(join(root, "alias.jsonl"))}; fs.symlinkSync(file,alias);
    const check=require('node:child_process').spawnSync(process.execPath,['-e', 'require('+${JSON.stringify(JSON.stringify(modulePath))}+').acquireSessionLock('+JSON.stringify(alias)+')'],{env:process.env});
    if(check.status===0) throw Error('alias admitted');`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(attempt().status, 0);
  assert.equal(readFileSync(session, "utf8"), '{"type":"session","version":3,"id":"test"}\n');
});

test("owned directory/file publication never replaces a foreign path, even an empty directory", () => {
  const { renameNoReplace } = createRequire(import.meta.url)(native);
  const source = join(root, "owned-staging"), target = join(root, "published"); mkdirSync(source);
  writeFileSync(join(source, "owner"), "frozen-creation-key"); mkdirSync(target);
  const inode = lstatSync(target).ino;
  assert.throws(() => renameNoReplace(source, target), error => error.code === "EEXIST");
  assert.equal(lstatSync(target).ino, inode); assert.equal(readFileSync(join(source, "owner"), "utf8"), "frozen-creation-key");
  const published = join(root, "published-owned"); renameNoReplace(source, published);
  assert.equal(existsSync(source), false); assert.equal(readFileSync(join(published, "owner"), "utf8"), "frozen-creation-key");
  const file = join(root, "frozen-native.jsonl"), staged = join(root, "staged-native.jsonl"); writeFileSync(staged, "owned"); writeFileSync(file, "foreign");
  assert.throws(() => renameNoReplace(staged, file), error => error.code === "EEXIST"); assert.equal(readFileSync(file, "utf8"), "foreign");
  const alias = join(root, "foreign-alias"); symlinkSync(file, alias);
  assert.throws(() => renameNoReplace(staged, alias), error => error.code === "EEXIST"); assert.equal(lstatSync(alias).isSymbolicLink(), true);
  assert.throws(() => renameNoReplace(staged + "\0ignored", join(root, "unsafe")), /path/i); assert.equal(existsSync(staged), true);
});
