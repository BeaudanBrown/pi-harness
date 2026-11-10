import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { BridgeRelay } from "../config/agent/extensions/matrix-bridge/relay.js";
import { BridgeMatrix } from "../config/agent/extensions/matrix-bridge/matrix.js";
import { localTasks } from "../config/agent/extensions/matrix-bridge/local-process.js";
import { POLL_RESPONSE } from "../config/agent/extensions/matrix-bridge/interaction.js";
import type { TaskIntent } from "../config/agent/extensions/matrix-bridge/task-contract.js";
import type { TaskRunner } from "../config/agent/extensions/matrix-bridge/tasks.js";
import { BOT, OWNER, SetupHttp } from "./fixtures/matrix-bridge/setup-http.js";

const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-task-approval-")));
const git = (cwd: string, args: string[]) => execFileSync(process.env.PI_TASK_TEST_GIT!, ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
test.before(() => {
  for (const name of ["PI_TASK_TEST_GIT", "PI_TASK_TEST_HELPER", "PI_TASK_TEST_DIRENV", "PI_NATIVE_LOCK_ADDON"]) assert.ok(process.env[name], `${name} is required; approval tests must not skip`);
  process.env.HOME = join(root, "home"); mkdirSync(process.env.HOME);
  process.env.XDG_CONFIG_HOME = join(root, "config"); process.env.XDG_DATA_HOME = join(root, "data"); process.env.XDG_CACHE_HOME = join(root, "cache"); process.env.XDG_STATE_HOME = join(root, "state");
  process.env.PI_SESSION_LOCK_DIRECTORY = join(root, "locks"); process.env.GIT_CONFIG_NOSYSTEM = "1"; process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  for (const key of ["DIRENV_DIR", "DIRENV_DIFF", "DIRENV_WATCHES", "DIRENV_CONFIG"]) delete process.env[key];
});
test.after(() => rmSync(root, { recursive: true, force: true }));

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(root, "case-")), cwd = join(directory, "project"), history = join(directory, "native"); mkdirSync(cwd);
  git(cwd, ["init", "-q"]); git(cwd, ["config", "user.name", "Task fixture"]); git(cwd, ["config", "user.email", "task@example.invalid"]); git(cwd, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(cwd, "tracked"), "committed\n"); git(cwd, ["add", "tracked"]); git(cwd, ["commit", "-qm", "base"]);
  const file = join(directory, "source.jsonl"), nativeId = randomUUID(), timestamp = new Date().toISOString();
  writeFileSync(file, [
    { type: "session", version: 3, id: nativeId, cwd, timestamp },
    { type: "custom", id: "private", parentId: null, timestamp, customType: "private", data: "SECRET_HISTORY_AND_PENDING_APPROVAL" },
    { type: "custom", id: "boundary", parentId: "private", timestamp, customType: "matrix-bridge.boundary", data: { nativeId } },
  ].map(entry => JSON.stringify(entry) + "\n").join(""));
  const wrapper = join(directory, "task-wrapper.mjs");
  writeFileSync(wrapper, `#!${process.execPath}\nimport {spawn} from 'node:child_process';\nconst child = spawn(${JSON.stringify(process.env.PI_TASK_TEST_HELPER)}, process.argv.slice(2), {stdio:'inherit',env:{...process.env,PI_TASK_SESSION_DIRECTORY:${JSON.stringify(history)},GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'}}); child.on('error',()=>process.exit(1)); child.on('close', code=>process.exit(code??1));\n`, { mode: 0o700 });
  const packaged = localTasks(wrapper); let creates = 0, active = 0, maximum = 0, loseResult = false, opens = 0, now = Date.now();
  t.mock.method(Date, "now", () => now);
  const runner: TaskRunner = { prepare: (...args) => packaged.prepare(...args), create: async (plan, progress) => {
    creates++; active++; maximum = Math.max(maximum, active);
    try { const result = await packaged.create(plan, progress); if (loseResult) { loseResult = false; throw Error("lost result after native publication"); } return result; }
    finally { active--; }
  } };
  const http = new SetupHttp(), matrix = new BridgeMatrix(http.bot, BOT, new Set());
  const config = { hostId: "host", stateDirectory: join(directory, "bridge"), socket: join(directory, "runtime/bridge.sock"), roots: [root], operatorUserId: OWNER };
  const make = () => new BridgeRelay(config, matrix, async () => { opens++; throw Error("fixture did not request a native open"); }, runner);
  let relay = make();
  const source = relay.store.register({ file, nativeId, cwd, title: "Development", boundary: "boundary" });
  await relay.organization!.pump();
  for (const room of http.rooms.keys()) http.member(room, "join"); now += 6000; await relay.organization!.pump();
  relay.store.intake("ready", []);
  const binding = () => relay.store.binding(source.key)!;
  const intent: TaskIntent = { branch: "task/example", base_ref: "HEAD", title: "Approved handoff", handoff_summary: "Only this explicit plan is copied. Wait for fresh human intent." };
  t.after(async () => { await relay.stop(); });
  return { directory, cwd, file, history, http, intent, binding, get relay() { return relay; },
    get creates() { return creates; }, get maximum() { return maximum; }, get opens() { return opens; },
    lose: () => { loseResult = true; }, advance: (ms = 6000) => { now += ms; },
    restart: async (operator = OWNER) => { await relay.stop(); config.operatorUserId = operator; relay = make(); now += 6000; },
    request: async (call: string, surface: "local" | "matrix" = "matrix", value: unknown = intent) => {
      const proposal = await relay.tasks!.prepare(binding(), value, call, surface);
      return surface === "matrix" ? relay.tasks!.publishApproval(binding(), proposal.key, proposal.request) : proposal;
    },
    publish: () => relay.pump(),
    poll: (key: string) => relay.store.outputs(source.key, `interaction:${relay.store.task(key)!.request.interaction}`)[0]!.eventId!,
    event: async (id: string, event: Record<string, unknown>, room = binding().room!) => { relay.store.intake(id, [{ id, room, event: { event_id: id, ...event } }]); await relay.pump(); },
    vote: async (id: string, poll: string, sender = OWNER, answer = 0) => {
      relay.store.intake(id, [{ id, room: binding().room!, event: { event_id: id, sender, type: POLL_RESPONSE, content: { "m.relates_to": { rel_type: "m.reference", event_id: poll }, [POLL_RESPONSE]: { answers: [`answer-${answer}`] } } } }]); await relay.pump();
    },
  };
}

test("independent local decisions freeze the base, never accept model approval claims, and leave a native idle handoff", async t => {
  const f = await fixture(t);
  await assert.rejects(f.request("claim", "local", { ...f.intent, approved: true }), /only branch/);
  const first = await f.request("first", "local"); assert.equal(f.creates, 0); assert.equal(existsSync(first.cwd!), false);
  assert.equal((await f.relay.tasks!.confirmLocal(f.binding(), first.key, first.request, false)).phase, "declined");
  const request = await f.request("second", "local"), frozen = f.relay.store.task(request.key)!.plan.base;
  writeFileSync(join(f.cwd, "later"), "later source commit\n"); git(f.cwd, ["add", "later"]); git(f.cwd, ["commit", "-qm", "later"]);
  const sourceBytes = readFileSync(f.file), result = await f.relay.tasks!.confirmLocal(f.binding(), request.key, request.request, true);
  assert.equal(result.localReady, true); assert.equal(result.remotePending, true); assert.equal(f.creates, 1); assert.equal(f.opens, 0);
  assert.equal(git(result.cwd!, ["rev-parse", "HEAD"]), frozen); assert.equal(existsSync(join(result.cwd!, "later")), false);
  assert.deepEqual(readFileSync(f.file), sourceBytes); assert.doesNotMatch(readFileSync(result.file!, "utf8"), /SECRET_HISTORY_AND_PENDING_APPROVAL/);
  const entries = readFileSync(result.file!, "utf8").trim().split("\n").map(line => JSON.parse(line)); assert.equal(entries.filter(entry => entry.type === "message").length, 0);
  assert.equal((await f.request("repeat", "local")).file, result.file); assert.equal(f.creates, 1);
});

test("only the current operator can answer the original task poll; other members and stale polls cannot grant creation", async t => {
  const f = await fixture(t), other = "@collaborator:example.test";
  f.http.set(f.binding().room!, "m.room.member", other, { membership: "join" });
  const old = await f.request("old"); await f.publish(); const oldPoll = f.poll(old.key);
  const current = await f.request("current"); await f.publish(); const poll = f.poll(current.key); assert.notEqual(oldPoll, poll);
  await f.vote("$other", poll, other); await f.vote("$stale", oldPoll); assert.equal(f.creates, 0);
  await assert.rejects(f.relay.tasks!.confirmLocal(f.binding(), current.key, current.request, true), /another approval surface/);
  await f.vote("$owner", poll); await f.relay.tasks!.run(current.key);
  assert.equal(f.creates, 1); assert.equal(f.relay.tasks!.status(f.binding(), current.key).localReady, true); assert.equal(f.opens, 0);
  await f.vote("$duplicate-choice", poll); await f.relay.tasks!.run(current.key); assert.equal(f.creates, 1);
  assert.equal(f.relay.store.nextInput(f.binding().key), undefined, "approval never becomes a native model prompt");
});

test("operator changes, expiry and missing source revoke unconsumed approvals without creating resources", async t => {
  const f = await fixture(t), old = await f.request("old-owner"); await f.publish(); const poll = f.poll(old.key), replacement = "@replacement:example.test";
  f.http.set(f.binding().room!, "m.room.member", replacement, { membership: "join" }); await f.restart(replacement);
  await f.vote("$old-owner", poll); await f.vote("$replacement-old-poll", poll, replacement); assert.equal(f.creates, 0);
  const fresh = await f.request("new-owner"); await f.publish(); f.advance(16 * 60_000);
  await f.vote("$expired", f.poll(fresh.key), replacement); assert.equal(f.creates, 0);
  const local = await f.request("local", "local"); rmSync(f.file);
  await assert.rejects(f.relay.tasks!.confirmLocal(f.binding(), local.key, local.request, true), /unavailable/); assert.equal(f.creates, 0); assert.equal(existsSync(local.cwd!), false);
});

test("an explicit original-poll text reply grants task approval; an unrelated reply does not", async t => {
  const f = await fixture(t), request = await f.request("reply"); await f.publish(); const poll = f.poll(request.key);
  await f.event("$foreign-reply", { sender: OWNER, type: "m.room.message", content: { msgtype: "m.text", body: "Approve", "m.relates_to": { "m.in_reply_to": { event_id: "$foreign" } } } });
  assert.equal(f.creates, 0);
  // The unrelated text is ordinary input, not approval. Clear the test's
  // deliberately unhandled source instruction before testing the real reply.
  const pending = f.relay.store.nextInput(f.binding().key); if (pending) f.relay.store.interruptInput(f.binding().key, pending.id);
  f.advance(); await f.event("$reply", { sender: OWNER, type: "m.room.message", content: { msgtype: "m.text", body: "Approve", "m.relates_to": { "m.in_reply_to": { event_id: poll } } } });
  await f.relay.tasks!.run(request.key); assert.equal(f.creates, 1); assert.equal(f.relay.tasks!.status(f.binding(), request.key).localReady, true);
});

test("lost local result survives a ledger restart, remote outage and lost room acknowledgement without creating a second native identity or room", async t => {
  const f = await fixture(t), request = await f.request("local", "local"); f.lose();
  const uncertain = await f.relay.tasks!.confirmLocal(f.binding(), request.key, request.request, true); assert.equal(uncertain.phase, "failed");
  const plan = f.relay.store.task(request.key)!.plan, bytes = readFileSync(plan.nativeFile); await f.restart();
  f.http.outage = true; const retry = await f.request("retry", "local"); await f.relay.tasks!.run(retry.key);
  const ready = f.relay.tasks!.status(f.binding(), retry.key); assert.equal(ready.localReady, true); assert.equal(ready.remotePending, true); assert.equal(ready.file, plan.nativeFile);
  await f.relay.organization!.pump(); assert.equal(f.relay.store.binding(f.relay.store.task(retry.key)!.child!)!.room, undefined); assert.deepEqual(readFileSync(plan.nativeFile), bytes);
  f.http.outage = false; f.advance(); f.http.createFailure = "after"; await f.relay.organization!.pump();
  const count = f.http.count("/createRoom"); await f.restart(); await f.relay.organization!.pump(); await f.relay.tasks!.pump();
  const linked = f.relay.tasks!.status(f.binding(), retry.key); assert.ok(linked.room); assert.equal(linked.file, plan.nativeFile);
  assert.equal(f.http.count("/createRoom"), count + 1, "only the child checkout Space is new; the accepted conversation is reused");
  assert.equal(f.relay.store.bindings().length, 2); assert.equal(f.opens, 0);
  const notices = f.relay.store.outputs(f.binding().key).map(output => String(output.content.body));
  assert.ok(notices.some(body => body.includes(encodeURIComponent(linked.room!))));
  assert.doesNotMatch(notices.join("\n"), /SECRET_HISTORY_AND_PENDING_APPROVAL/);
  rmSync(plan.nativeFile); const missing = f.relay.tasks!.status(f.binding(), retry.key); assert.equal(missing.localReady, false); assert.match(missing.error!, /missing, moved or corrupt/);
});

test("trusted project exports reach Git hooks without redirecting the host helper, locks, SDK or native history", async t => {
  const f = await fixture(t), bin = join(f.directory, "project-bin"), hooks = join(f.directory, "hooks"), captured = join(f.directory, "hook.json"); mkdirSync(bin); mkdirSync(hooks);
  writeFileSync(join(bin, "project-proof"), `#!${process.execPath}\nprocess.stdout.write('project-path-ok');\n`, { mode: 0o700 });
  writeFileSync(join(hooks, "post-checkout"), `#!${process.execPath}\nconst fs=require('node:fs'),cp=require('node:child_process');fs.writeFileSync(${JSON.stringify(captured)},JSON.stringify({proof:cp.execFileSync('project-proof',{encoding:'utf8'}),value:process.env.TASK_PROJECT_VALUE,token:process.env.PI_MATRIX_ACCESS_TOKEN,credential:process.env.CREDENTIALS_DIRECTORY,cwd:process.cwd()}));\n`, { mode: 0o700 });
  git(f.cwd, ["config", "core.hooksPath", hooks]);
  writeFileSync(join(f.cwd, ".envrc"), `export TASK_PROJECT_VALUE='trusted project value'\nexport PATH='${bin}':"$PATH"\nexport PI_TASK_SESSION_DIRECTORY='${f.directory}/wrong-history'\nexport PI_SESSION_LOCK_DIRECTORY='${f.directory}/wrong-locks'\nexport PI_TASK_TEST_SESSION_MANAGER='/missing-sdk'\nexport PI_TASK_TEST_PYTHON='/missing-python'\nexport PYTHONHOME='/missing-python-home'\nexport GIT_DIR='/missing-git-directory'\n`);
  execFileSync(process.env.PI_TASK_TEST_DIRENV!, ["allow", f.cwd], { env: process.env, stdio: "pipe" });
  const before = git(f.cwd, ["status", "--porcelain"]), token = process.env.PI_MATRIX_ACCESS_TOKEN, credentials = process.env.CREDENTIALS_DIRECTORY;
  process.env.PI_MATRIX_ACCESS_TOKEN = "DAEMON_CREDENTIAL_MUST_NOT_ESCAPE"; process.env.CREDENTIALS_DIRECTORY = "/private-daemon-credential";
  try {
    const request = await f.request("environment", "local"), result = await f.relay.tasks!.confirmLocal(f.binding(), request.key, request.request, true);
    assert.equal(result.localReady, true, result.error);
    assert.deepEqual(JSON.parse(readFileSync(captured, "utf8")), { proof: "project-path-ok", value: "trusted project value", cwd: result.cwd });
    assert.ok(result.file!.startsWith(f.history + "/")); assert.equal(existsSync(join(f.directory, "wrong-history")), false); assert.equal(existsSync(join(f.directory, "wrong-locks")), false);
    assert.equal(git(f.cwd, ["status", "--porcelain"]), before); assert.equal(existsSync(join(result.cwd!, ".envrc")), false);
  } finally { if (token === undefined) delete process.env.PI_MATRIX_ACCESS_TOKEN; else process.env.PI_MATRIX_ACCESS_TOKEN = token; if (credentials === undefined) delete process.env.CREDENTIALS_DIRECTORY; else process.env.CREDENTIALS_DIRECTORY = credentials; }
});

test("unpublished native proposals, cancelled approvals and another binding never grant a mutation", async t => {
  const f = await fixture(t), draft = await f.relay.tasks!.prepare(f.binding(), f.intent, "draft", "matrix");
  await f.publish(); assert.equal(f.relay.store.task(draft.key)!.request.interaction, undefined); assert.equal(f.creates, 0);
  const current = await f.request("published"); await f.publish();
  assert.throws(() => f.relay.tasks!.publishApproval({ ...f.binding(), key: "other" }, current.key, current.request), /another native conversation/);
  await f.vote("$cancel", f.poll(current.key), OWNER, 1); assert.equal(f.relay.tasks!.status(f.binding(), current.key).phase, "declined");
  await f.vote("$late-approval", f.poll(current.key)); assert.equal(f.creates, 0); assert.equal(existsSync(current.cwd!), false);
});

test("distinct approved intents serialize by Git common directory", async t => {
  const f = await fixture(t), a = await f.request("a", "local"), b = await f.request("b", "local", { ...f.intent, branch: "task/second" });
  const results = await Promise.all([f.relay.tasks!.confirmLocal(f.binding(), a.key, a.request, true), f.relay.tasks!.confirmLocal(f.binding(), b.key, b.request, true)]);
  assert.ok(results.every(result => result.localReady)); assert.equal(f.maximum, 1); assert.equal(f.creates, 2); assert.notEqual(results[0]!.file, results[1]!.file);
});
