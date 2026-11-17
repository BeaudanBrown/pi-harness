import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTask, prepareTask } from "../config/agent/extensions/matrix-bridge/task-worker.js";
import { projectIntent, taskPlan } from "../config/agent/extensions/matrix-bridge/task-contract.js";
import { BridgeStore, identity } from "../config/agent/extensions/matrix-bridge/store.js";
import { TaskWorkspaces } from "../config/agent/extensions/matrix-bridge/tasks.js";
import { BridgeOrganization } from "../config/agent/extensions/matrix-bridge/organization.js";
import { SetupHttp, BOT, OWNER } from "./fixtures/matrix-bridge/setup-http.js";

const root = mkdtempSync(join(tmpdir(), "bridge-project-test-"));
test.before(() => {
  for (const key of ["PI_TASK_TEST_GIT", "PI_TASK_TEST_SESSION_MANAGER", "PI_NATIVE_LOCK_ADDON"]) assert.ok(process.env[key], key);
  process.env.PI_SESSION_LOCK_DIRECTORY = join(root, "locks"); process.env.PI_TASK_SESSION_DIRECTORY = join(root, "sessions");
});
test.after(() => rmSync(root, { recursive: true, force: true }));
const git = (cwd: string, ...args: string[]) => execFileSync(process.env.PI_TASK_TEST_GIT!, ["-C", cwd, ...args], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } }).trim();
function fixture() {
  const projects = mkdtempSync(join(root, "projects-")), cwd = join(projects, "non-git"); mkdirSync(cwd);
  const file = join(root, randomUUID() + ".jsonl"), nativeId = randomUUID();
  writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: nativeId, cwd, timestamp: new Date().toISOString() }) + "\n" + JSON.stringify({ type: "custom", id: "secret", customType: "private", data: "PARENT_SECRET_APPROVAL" }) + "\n");
  const source = { key: identity("source", file), file, nativeId, cwd };
  const input = { name: "new-project", description: "Disposable project", handoff_summary: "Only this explicit handoff. Wait for a human." };
  const intent = projectIntent(input, projects), key = identity("task", source.key, JSON.stringify(intent));
  return { projects, source, input, intent, key, nativeId: randomUUID() };
}
test("fresh project from non-Git source has main/README/commit and saved idle native session, never copied history", async () => {
  const f = fixture(), source = readFileSync(f.source.file);
  const plan = await prepareTask(f.source, f.intent, f.key, f.nativeId);
  assert.equal(existsSync(plan.worktree), false); assert.equal(existsSync(plan.nativeFile), false);
  const result = await createTask(plan);
  assert.equal(plan.worktree, join(f.projects, "new-project"));
  assert.equal(git(result.cwd, "branch", "--show-current"), "main");
  assert.equal(git(result.cwd, "log", "-1", "--format=%s"), "Initialize project");
  assert.equal(git(result.cwd, "config", "user.name"), "Pi Project");
  assert.equal(git(result.cwd, "remote"), ""); assert.equal(git(result.cwd, "status", "--porcelain"), "");
  assert.equal(readFileSync(join(result.cwd, "README.md"), "utf8"), "# new-project\n\nDisposable project\n");
  const history = readFileSync(result.file, "utf8"), entries = history.trim().split("\n").map(line => JSON.parse(line));
  assert.equal(entries[0].id, f.nativeId); assert.equal(entries[0].cwd, result.cwd);
  assert.equal(entries.filter(entry => entry.type === "message").length, 0);
  assert.ok(entries.some(entry => entry.type === "custom_message" && entry.content === f.input.handoff_summary));
  assert.doesNotMatch(history, /PARENT_SECRET_APPROVAL/); assert.deepEqual(readFileSync(f.source.file), source);
  assert.deepEqual(await createTask(plan), result); assert.equal(readFileSync(result.file, "utf8"), history);
  writeFileSync(join(result.cwd, "human.txt"), "later human work");
  assert.deepEqual(await createTask(plan), result); assert.equal(readFileSync(join(result.cwd, "human.txt"), "utf8"), "later human work");
});
test("unsafe project names, arbitrary paths and foreign/symlink destinations are refused", async () => {
  const f = fixture();
  for (const name of ["../escape", ".git", "a/b", "-option", "a b", "a\n", "a\\b"]) assert.throws(() => projectIntent({ ...f.input, name }, f.projects));
  assert.throws(() => projectIntent({ ...f.input, approved: true }, f.projects));
  assert.throws(() => projectIntent({ ...f.input, root: "/tmp" }, f.projects));
  const plan = await prepareTask(f.source, f.intent, f.key, f.nativeId);
  symlinkSync(join(root, "missing"), plan.worktree);
  await assert.rejects(prepareTask(f.source, f.intent, f.key, f.nativeId), /exists/);
  await assert.rejects(createTask(plan));
  assert.equal(existsSync(plan.nativeFile), false);
});
test("fresh project ignores inherited Git templates, hooks, signing and configuration", async t => {
  const f = fixture(), poison = join(f.projects, "poison-config"), template = join(f.projects, "template"), hook = join(template, "hooks");
  mkdirSync(template); mkdirSync(hook);
  const ran = join(f.projects, "HOOK_RAN");
  writeFileSync(join(hook, "post-commit"), `#!/bin/sh\ntouch '${ran}'\n`, { mode: 0o700 });
  writeFileSync(poison, `[init]\n templateDir = ${template}\n[commit]\n gpgsign = true\n[gpg]\n program = /missing-signing-program\n`);
  const saved = { ...process.env };
  t.after(() => { for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); });
  Object.assign(process.env, { GIT_CONFIG_GLOBAL: poison, GIT_TEMPLATE_DIR: template, GIT_DIR: join(f.projects, "redirect.git"), GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: hook });
  const plan = await prepareTask(f.source, f.intent, f.key, f.nativeId), result = await createTask(plan);
  assert.ok(result.file); assert.equal(existsSync(ran), false); assert.equal(existsSync(join(f.projects, "redirect.git")), false);
  assert.equal(readFileSync(poison, "utf8").includes("gpgsign = true"), true);
});

test("duplicate creations serialize and distinct same-name intents cannot adopt the first project", async () => {
  const f = fixture(), a = await prepareTask(f.source, f.intent, f.key, f.nativeId);
  const other = projectIntent({ ...f.input, description: "Different approval" }, f.projects);
  const b = await prepareTask(f.source, other, identity("other", f.key), randomUUID());
  const [first, second] = await Promise.all([createTask(a), createTask(a)]);
  assert.deepEqual(first, second); await assert.rejects(createTask(b), /different creation/);
  assert.equal(existsSync(b.nativeFile), false);
});
for (const stage of ["container", "worktree", "session"]) test(`project lost ${stage} receipt reuses exact repository and native identity`, async () => {
  const f = fixture(), plan = await prepareTask(f.source, f.intent, f.key, f.nativeId);
  await assert.rejects(createTask(plan, at => { if (at === stage) throw Error("lost receipt"); }), /lost receipt/);
  const commit = git(plan.worktree, "rev-parse", "HEAD");
  const result = await createTask(plan); assert.equal(result.nativeId, f.nativeId); assert.equal(git(result.cwd, "rev-parse", "HEAD"), commit);
});
test("changed incomplete project is retained, never reset to finish a lost receipt", async () => {
  const f = fixture(), plan = await prepareTask(f.source, f.intent, f.key, f.nativeId);
  await assert.rejects(createTask(plan, at => { if (at === "container") throw Error("lost"); }));
  writeFileSync(join(plan.worktree, "README.md"), "human edit");
  await assert.rejects(createTask(plan), /changed after publication/); assert.equal(existsSync(plan.nativeFile), false);
  assert.equal(readFileSync(join(plan.worktree, "README.md"), "utf8"), "human edit");
});
for (const stage of ["before-repo", "container", "before-session", "session"]) test(`project helper death at ${stage} retains single published identity`, async () => {
  const f = fixture(), plan = await prepareTask(f.source, f.intent, f.key, f.nativeId);
  const worker = join(__dirname, "../config/agent/extensions/matrix-bridge/task-worker.js"), lock = join(__dirname, "../config/agent/extensions/matrix-bridge/session-lock.cjs");
  const script = `const p=JSON.parse(process.argv[1]);const pause=s=>{if(s===process.argv[2]){console.log(s);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}};const l=require(${JSON.stringify(lock)}),r=l.renameNoReplace;l.renameNoReplace=(a,b)=>{if(b===p.worktree)pause('before-repo');if(b===p.nativeFile)pause('before-session');return r(a,b);};require(${JSON.stringify(worker)}).createTask(p,pause).catch(e=>{console.error(e);process.exit(1)});`;
  const child = spawn(process.execPath, ["-e", script, JSON.stringify(plan), stage], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  try {
    await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(Error("death boundary not reached")), 10000); child.once("exit", () => { clearTimeout(timer); reject(Error("fixture child exited early")); }); child.stdout.on("data", chunk => { if (String(chunk).includes(stage)) { clearTimeout(timer); resolve(); } }); });
  } finally { const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; }
  const result = await createTask(plan); assert.equal(result.nativeId, f.nativeId); assert.equal(git(result.cwd, "rev-list", "--count", "HEAD"), "1");
  assert.equal(readdirSync(f.projects).filter(name => name === "new-project").length, 1);
});
test("explicit project root is independent of enrollment and frozen approvals cannot follow policy changes", async () => {
  const f = fixture(), destination = join(f.projects, "creation-root"), changed = join(f.projects, "other-root");
  mkdirSync(destination); mkdirSync(changed);
  const store = new BridgeStore(join(f.projects, "policy.sqlite"), "host");
  const policy = { roots: [f.source.cwd, destination, changed], projectRoot: destination };
  const tasks = new TaskWorkspaces(store, { prepare: prepareTask, create: createTask }, policy);
  try {
    const binding = store.register({ ...f.source, title: "Other enrolled folder", boundary: null });
    const proposal = await tasks.prepare(binding, f.input, "root-change", "local", "project");
    assert.equal(proposal.cwd, join(destination, "new-project"));
    assert.deepEqual(policy.roots, [f.source.cwd, destination, changed]);
    policy.projectRoot = changed;
    const refused = await tasks.confirmLocal(binding, proposal.key, proposal.request, true);
    assert.equal(refused.localReady, false); assert.equal(refused.phase, "failed");
    assert.equal(existsSync(join(destination, "new-project")), false); assert.equal(existsSync(join(changed, "new-project")), false);
    policy.projectRoot = destination;
    const next = await tasks.prepare(binding, { ...f.input, name: "approved-project" }, "valid-root", "local", "project");
    const created = await tasks.confirmLocal(binding, next.key, next.request, true);
    assert.equal(created.cwd, join(destination, "approved-project")); assert.equal(created.localReady, true);
    const outside = new TaskWorkspaces(store, { prepare: prepareTask, create: createTask }, { roots: [f.source.cwd], projectRoot: destination });
    await assert.rejects(outside.prepare(binding, f.input, "outside", "local", "project")); await outside.stop();
    const alias = join(f.projects, "root-alias"); symlinkSync(destination, alias);
    const unsafe = new TaskWorkspaces(store, { prepare: prepareTask, create: createTask }, { roots: [f.projects], projectRoot: alias });
    await assert.rejects(unsafe.prepare(binding, f.input, "alias", "local", "project"), /canonical/); await unsafe.stop();
  } finally { await tasks.stop(); store.close(); }
});

test("project uses existing independent approval and async organization without requiring source Git or launching a child", async t => {
  let now = Date.now(); t.mock.method(Date, "now", () => now);
  const f = fixture(), store = new BridgeStore(join(f.projects, "bridge.sqlite"), "host"), http = new SetupHttp();
  const organization = new BridgeOrganization(store, http.bot, { hostId: "host", botUserId: BOT, operatorUserId: OWNER });
  const tasks = new TaskWorkspaces(store, { prepare: prepareTask, create: createTask }, { roots: [f.projects], operatorUserId: OWNER });
  try {
    const binding = store.register({ ...f.source, title: "Parent", boundary: null });
    const view = await tasks.prepare(binding, f.input, "first", "local", "project");
    assert.equal(view.phase, "approval"); assert.equal(existsSync(view.cwd!), false); assert.match(view.approvalText, /No Pi process/);
    await tasks.confirmLocal(binding, view.key, view.request, false); assert.equal(existsSync(view.cwd!), false);
    const fresh = await tasks.prepare(binding, f.input, "second", "local", "project");
    await assert.rejects(tasks.confirmLocal(binding, fresh.key, view.request, true));
    const ready = await tasks.confirmLocal(binding, fresh.key, fresh.request, true);
    assert.equal(ready.localReady, true); assert.equal(ready.remotePending, true);
    const child = store.bindings().find(b => b.key !== binding.key)!; assert.ok(child);
    http.outage = true; await organization.pump(); assert.equal(tasks.status(binding, fresh.key).localReady, true);
    http.outage = false; now += 6000; await organization.pump();
    assert.ok(store.binding(child.key)!.room, "existing organization creates the child's conversation asynchronously");
    const room = store.binding(child.key)!.room; await organization.pump();
    assert.equal(store.binding(child.key)!.room, room);
    assert.equal(store.bindings().length, 2);
    assert.equal(readFileSync(child.file, "utf8").includes('"role":"user"'), false);
    const ambiguous = new TaskWorkspaces(store, { prepare: prepareTask, create: createTask }, { roots: [f.projects, f.source.cwd] });
    await assert.rejects(ambiguous.prepare(binding, f.input, "third", "local", "project"), /requires projectRoot/); await ambiguous.stop();
    assert.deepEqual(taskPlan(store.task(fresh.key)!.plan), store.task(fresh.key)!.plan);
  } finally { await tasks.stop(); await organization.stop(); store.close(); }
});
