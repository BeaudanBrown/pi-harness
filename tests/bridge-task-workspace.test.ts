import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createTask, prepareTask } from "../config/agent/extensions/matrix-bridge/task-worker.js";
import locks from "../config/agent/extensions/matrix-bridge/session-lock.cjs";
import type { TaskIntent, TaskPlan, TaskSource } from "../config/agent/extensions/matrix-bridge/task-contract.js";

const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-task-test-")));
const git = (cwd: string, args: string[]) => execFileSync(process.env.PI_TASK_TEST_GIT!, ["-C", cwd, ...args], { encoding: "utf8", env: process.env, stdio: ["ignore", "pipe", "pipe"] }).trim();
function fixture() {
  const directory = mkdtempSync(join(root, "case-")), cwd = join(directory, "project"); mkdirSync(cwd);
  git(cwd, ["init", "-q"]); git(cwd, ["config", "user.name", "Task fixture"]); git(cwd, ["config", "user.email", "task@example.invalid"]); git(cwd, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(cwd, "tracked.txt"), "committed\n"); git(cwd, ["add", "tracked.txt"]); git(cwd, ["commit", "-qm", "base"]);
  const nativeId = randomUUID(), file = join(directory, "source.jsonl"), key = createHash("sha256").update(file).digest("hex");
  writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: nativeId, cwd, timestamp: new Date().toISOString() }) + "\n" + JSON.stringify({ type: "custom", id: "private", parentId: null, customType: "private", data: "SOURCE_SECRET_AND_PENDING_APPROVAL" }) + "\n");
  const source: TaskSource = { key, file, nativeId, cwd }, intent: TaskIntent = { branch: "task/example", base_ref: "HEAD", title: "Example task", handoff_summary: "Implement the explicitly discussed task. Wait for a new human instruction." };
  return { source, intent, key: createHash("sha256").update(key + JSON.stringify(intent)).digest("hex"), nativeId: randomUUID() };
}
test.before(() => {
  for (const name of ["PI_TASK_TEST_GIT", "PI_TASK_TEST_PYTHON", "PI_TASK_TEST_GIT_WAITER", "PI_TASK_TEST_DIRENV", "PI_TASK_TEST_ENV", "PI_TASK_TEST_SESSION_MANAGER", "PI_NATIVE_LOCK_ADDON"]) assert.ok(process.env[name], `${name} is required; native task tests must not skip`);
  process.env.PI_SESSION_LOCK_DIRECTORY = join(root, "locks"); process.env.PI_TASK_SESSION_DIRECTORY = join(root, "native-history");
  process.env.HOME = join(root, "home"); mkdirSync(process.env.HOME);
  process.env.XDG_CONFIG_HOME = join(root, "config"); process.env.XDG_CACHE_HOME = join(root, "cache"); process.env.XDG_DATA_HOME = join(root, "data");
  for (const key of ["DIRENV_DIR", "DIRENV_DIFF", "DIRENV_WATCHES", "DIRENV_CONFIG"]) delete process.env[key];
  process.env.GIT_CONFIG_NOSYSTEM = "1"; process.env.GIT_CONFIG_GLOBAL = "/dev/null";
});
test.after(() => rmSync(root, { recursive: true, force: true }));
async function until(check: () => boolean): Promise<void> {
  const end = Date.now() + 8000;
  while (!check()) { if (Date.now() > end) throw Error("Owned task fixture condition timed out"); await new Promise(resolve => setTimeout(resolve, 20)); }
}
function worker(plan: TaskPlan, stopAt = "none") {
  const module = join(__dirname, "../config/agent/extensions/matrix-bridge/task-worker.js"), lockModule = join(__dirname, "../config/agent/extensions/matrix-bridge/session-lock.cjs");
  const script = `const plan=JSON.parse(process.argv[1]), stop=process.argv[2]; const pause=stage=>{if(stage===stop){process.stdout.write(stage+'\\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}}; const locks=require(${JSON.stringify(lockModule)}), rename=locks.renameNoReplace; locks.renameNoReplace=(from,to)=>{if(to===plan.container)pause('before-container-publish');if(to===plan.nativeFile)pause('before-session-publish');rename(from,to);};require(${JSON.stringify(module)}).createTask(plan,pause).then(result=>process.stdout.write(JSON.stringify(result)+'\\n')).catch(error=>{process.stderr.write(String(error));process.exitCode=1;});`;
  const child = spawn(process.execPath, ["-e", script, JSON.stringify(plan), stopAt], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "", error = ""; child.stdout.on("data", bytes => { output += String(bytes); }); child.stderr.on("data", bytes => { error = (error + String(bytes)).slice(-4000); });
  return { child, reached: () => { if (child.exitCode !== null || child.signalCode !== null) throw Error(`Task child exited before boundary: ${error}`); return output.includes(stopAt + "\n"); },
    stop: async () => { if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; } } };
}

test("real linked worktree and native idle handoff copy only the explicit plan, leaving the dirty source unchanged", async () => {
  const f = fixture(); writeFileSync(join(f.source.cwd, "tracked.txt"), "staged source work\n"); git(f.source.cwd, ["add", "tracked.txt"]);
  writeFileSync(join(f.source.cwd, "tracked.txt"), "unstaged source work\n"); writeFileSync(join(f.source.cwd, "secret.txt"), "SOURCE_SECRET_AND_PENDING_APPROVAL");
  const before = git(f.source.cwd, ["status", "--porcelain"]), sourceBytes = readFileSync(f.source.file);
  const plan = await prepareTask(f.source, f.intent, f.key, f.nativeId), result = await createTask(plan);
  assert.equal(git(plan.worktree, ["rev-parse", "HEAD"]), plan.base); assert.equal(git(plan.worktree, ["branch", "--show-current"]), f.intent.branch);
  assert.equal(readFileSync(join(plan.worktree, "tracked.txt"), "utf8"), "committed\n"); assert.equal(existsSync(join(plan.worktree, "secret.txt")), false);
  assert.equal(git(f.source.cwd, ["status", "--porcelain"]), before); assert.deepEqual(readFileSync(f.source.file), sourceBytes);
  const text = readFileSync(result.file, "utf8"), entries = text.trim().split("\n").map(line => JSON.parse(line));
  assert.equal(dirname(result.file), process.env.PI_TASK_SESSION_DIRECTORY);
  assert.equal(entries[0].id, f.nativeId); assert.equal(entries[0].parentSession, undefined); assert.equal(entries.filter(entry => entry.type === "message").length, 0);
  assert.ok(entries.some(entry => entry.type === "custom_message" && entry.display === true && entry.content === f.intent.handoff_summary));
  assert.doesNotMatch(text, /SOURCE_SECRET_AND_PENDING_APPROVAL/); assert.equal(git(plan.worktree, ["status", "--porcelain"]), "");
  assert.deepEqual(await createTask(plan), result); assert.equal(readFileSync(result.file, "utf8"), text);
});

for (const stage of ["container", "branch", "worktree", "session"]) test(`lost receipt after ${stage} reuses the frozen branch, worktree and native identity`, async () => {
  const f = fixture(), plan = await prepareTask(f.source, f.intent, f.key, f.nativeId);
  await assert.rejects(createTask(plan, effect => { if (effect === stage) throw Error("lost receipt"); }), /lost receipt/);
  const prior = existsSync(plan.nativeFile) ? readFileSync(plan.nativeFile, "utf8") : undefined;
  const result = await createTask(plan); assert.equal(result.file, plan.nativeFile); assert.equal(result.nativeId, f.nativeId);
  if (prior) assert.equal(readFileSync(result.file, "utf8"), prior);
  assert.equal(git(f.source.cwd, ["worktree", "list", "--porcelain"]).split("\n").filter(line => line === `worktree ${plan.worktree}`).length, 1);
});

for (const stage of ["before-container-publish", "container", "branch", "worktree", "before-session-publish", "session"]) test(`actual helper death at ${stage} releases setup authority and reuses only its frozen resources`, { timeout: 15000 }, async () => {
  const f = fixture(), plan = await prepareTask(f.source, f.intent, f.key, f.nativeId), child = worker(plan, stage);
  try {
    await until(child.reached); await child.stop();
    const prior = existsSync(plan.nativeFile) ? readFileSync(plan.nativeFile) : undefined, result = await createTask(plan);
    assert.equal(result.nativeId, f.nativeId); assert.equal(result.file, plan.nativeFile);
    if (prior) assert.deepEqual(readFileSync(plan.nativeFile), prior);
    assert.equal(git(f.source.cwd, ["worktree", "list", "--porcelain"]).split("\n").filter(line => line === `worktree ${plan.worktree}`).length, 1);
  } finally { await child.stop(); }
});

test("an in-flight Git effect retains its inherited lease after the task helper dies, without leaking it to hooks", { timeout: 15000 }, async () => {
  const f = fixture(), hooks = join(dirname(f.source.cwd), "hooks"), entered = join(dirname(f.source.cwd), "entered.json"), release = join(dirname(f.source.cwd), "release"); mkdirSync(hooks);
  writeFileSync(join(hooks, "post-checkout"), `#!${process.env.PI_TASK_TEST_PYTHON} -I\nimport json, os, time\nfrom pathlib import Path\nPath(${JSON.stringify(entered)}).write_text(json.dumps({'inherited':os.path.exists('/proc/self/fd/3')}))\nend=time.monotonic()+12\nwhile not Path(${JSON.stringify(release)}).exists():\n if time.monotonic()>end: raise SystemExit(7)\n time.sleep(.02)\nprint('x'*100000)\n`, { mode: 0o700 });
  git(f.source.cwd, ["config", "core.hooksPath", hooks]); const plan = await prepareTask(f.source, f.intent, f.key, f.nativeId), child = worker(plan);
  let retry: Promise<unknown> | undefined;
  try {
    await until(() => existsSync(entered)); assert.equal(JSON.parse(readFileSync(entered, "utf8")).inherited, false);
    await child.stop(); const probe = locks.tryTaskLock(plan.common, "git"); if (probe) probe.release();
    assert.equal(probe, undefined, "the surviving finite Git waiter, not a PID hint or file's existence, holds the effect lease");
    const stages: string[] = []; retry = createTask(plan, stage => stages.push(stage));
    await new Promise(resolve => setTimeout(resolve, 150)); assert.deepEqual(stages, []); assert.equal(existsSync(plan.nativeFile), false);
    writeFileSync(release, ""); await retry;
    assert.equal(existsSync(plan.nativeFile), true); assert.equal(git(plan.worktree, ["status", "--porcelain"]), "");
    assert.equal(git(f.source.cwd, ["worktree", "list", "--porcelain"]).split("\n").filter(line => line === `worktree ${plan.worktree}`).length, 1);
  } finally { writeFileSync(release, ""); await child.stop(); await retry; }
});

test("foreign branch/path/symlink, changed intent and missing source cannot be adopted or overwritten", async () => {
  const branch = fixture(); git(branch.source.cwd, ["branch", branch.intent.branch]);
  await assert.rejects(prepareTask(branch.source, branch.intent, branch.key, branch.nativeId), /already exists/);
  const path = fixture(), plan = await prepareTask(path.source, path.intent, path.key, path.nativeId); mkdirSync(plan.container);
  await assert.rejects(createTask(plan), /publication|owned|destination/i); assert.deepEqual(git(path.source.cwd, ["branch", "--list", path.intent.branch]), "");
  const link = fixture(), linkPlan = await prepareTask(link.source, link.intent, link.key, link.nativeId); symlinkSync(link.source.cwd, linkPlan.container);
  await assert.rejects(createTask(linkPlan), /foreign|unsafe/);
  const changed = fixture(), changedPlan = await prepareTask(changed.source, changed.intent, changed.key, changed.nativeId);
  await assert.rejects(createTask(changedPlan, stage => { if (stage === "container") throw Error("pause"); }), /pause/);
  await assert.rejects(createTask({ ...changedPlan, intent: { ...changedPlan.intent, handoff_summary: "Changed intent" } }), /not owned/);
  const missing = fixture(), missingPlan = await prepareTask(missing.source, missing.intent, missing.key, missing.nativeId); rmSync(missing.source.file);
  await assert.rejects(createTask(missingPlan)); assert.equal(existsSync(missingPlan.container), false);
  assert.ok(existsSync(dirname(changedPlan.container)));
});

test("a dangling foreign symbolic branch is never followed or overwritten", async () => {
  const f = fixture(), plan = await prepareTask(f.source, f.intent, f.key, f.nativeId), ref = `refs/heads/${f.intent.branch}`, foreign = "refs/heads/foreign-target";
  git(f.source.cwd, ["symbolic-ref", ref, foreign]);
  await assert.rejects(createTask(plan));
  assert.equal(git(f.source.cwd, ["symbolic-ref", ref]), foreign);
  assert.throws(() => git(f.source.cwd, ["show-ref", "--verify", foreign]), "a foreign symbolic target must remain absent");
});

test("concurrent duplicates serialize the whole setup and reuse exactly one saved native identity", async () => {
  const f = fixture(), plan = await prepareTask(f.source, f.intent, f.key, f.nativeId);
  const results = await Promise.all([createTask(plan), createTask(plan), createTask(plan)]);
  assert.deepEqual(results[0], results[1]); assert.deepEqual(results[1], results[2]);
  assert.equal(git(f.source.cwd, ["worktree", "list", "--porcelain"]).split("\n").filter(line => line === `worktree ${plan.worktree}`).length, 1);
});

test("cross-process conflicting intents wait for setup ownership and cannot adopt the first intent's branch", { timeout: 15000 }, async () => {
  const f = fixture(), first = await prepareTask(f.source, f.intent, f.key, f.nativeId);
  const other = await prepareTask(f.source, { ...f.intent, title: "Different intent" }, createHash("sha256").update(f.key + "other").digest("hex"), randomUUID()), child = worker(first, "branch");
  let conflict: Promise<void> | undefined;
  try {
    await until(child.reached); conflict = assert.rejects(createTask(other), /foreign or changed/);
    await new Promise(resolve => setTimeout(resolve, 150)); assert.equal(existsSync(other.container), false, "another process cannot enter setup while the first owns it");
    await child.stop(); await conflict; assert.equal(git(f.source.cwd, ["rev-parse", `refs/heads/${f.intent.branch}`]), first.base);
    const result = await createTask(first); assert.equal(result.nativeId, f.nativeId); assert.equal(existsSync(other.nativeFile), false);
  } finally { await child.stop(); await conflict; }
});

test("a completed creation is reused read-only after a lost reply even if a human has since advanced its branch", async () => {
  const f = fixture(), plan = await prepareTask(f.source, f.intent, f.key, f.nativeId), created = await createTask(plan);
  writeFileSync(join(plan.worktree, "human.txt"), "fresh human work\n"); git(plan.worktree, ["add", "human.txt"]); git(plan.worktree, ["commit", "-qm", "human follow-on"]);
  const tip = git(plan.worktree, ["rev-parse", "HEAD"]), bytes = readFileSync(created.file);
  assert.deepEqual(await createTask(plan), created);
  assert.equal(git(plan.worktree, ["rev-parse", "HEAD"]), tip); assert.deepEqual(readFileSync(created.file), bytes);
});

test("a task requested from a linked checkout remains a sibling at the repository anchor, not inside its source container", async () => {
  const f = fixture(), first = await prepareTask(f.source, f.intent, f.key, f.nativeId), created = await createTask(first);
  const source = { key: createHash("sha256").update(created.file).digest("hex"), file: created.file, nativeId: created.nativeId, cwd: created.cwd };
  const next = await prepareTask(source, { ...f.intent, branch: "task/second" }, createHash("sha256").update("second" + f.key).digest("hex"), randomUUID());
  assert.equal(dirname(next.container), dirname(first.container)); assert.notEqual(dirname(next.container), first.container);
  await createTask(next); assert.equal(git(first.worktree, ["status", "--porcelain"]), "");
});
