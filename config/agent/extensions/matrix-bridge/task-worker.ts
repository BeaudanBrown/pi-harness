import { spawn, execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fsyncSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";
import locks from "./session-lock.cjs";
import { hostPath, object } from "./wire.js";
import { TaskFailure, taskIntent, taskKey, taskPlan, taskSource, type TaskIntent, type TaskLocalResult, type TaskPlan, type TaskSource } from "./task-contract.js";

// Fixed package paths; overrides exist only for disposable integration fixtures.
const git = () => process.env.PI_TASK_TEST_GIT ?? "@taskGit@";
const python = () => process.env.PI_TASK_TEST_PYTHON ?? "@taskPython@";
const gitWaiter = () => process.env.PI_TASK_TEST_GIT_WAITER ?? "@taskGitWaiter@";
const sdk = () => process.env.PI_TASK_TEST_SESSION_MANAGER ?? "@taskSessionManager@";
const execute = promisify(execFile);
async function projectEnvironment(cwd: string): Promise<NodeJS.ProcessEnv> {
  const result = await execute(process.env.PI_TASK_TEST_DIRENV ?? "@taskDirenv@", ["exec", cwd, process.env.PI_TASK_TEST_ENV ?? "@taskEnv@", "-0"],
    { cwd, env: process.env, timeout: 10000, maxBuffer: 1024 * 1024 });
  const env: NodeJS.ProcessEnv = {};
  for (const entry of result.stdout.split("\0")) {
    if (!entry) continue; const separator = entry.indexOf("=");
    if (separator < 1) throw new TaskFailure(("Invalid project environment")); env[entry.slice(0, separator)] = entry.slice(separator + 1);
  }
  // Project PATH/configuration belongs to Git and its hooks, not the host's
  // native-history location, lock namespace, SDK or helper interpreter.
  env.GIT_TERMINAL_PROMPT = "0"; env.GIT_OPTIONAL_LOCKS = "0";
  for (const key of Object.keys(env)) if (/^GIT_(DIR|COMMON_DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CEILING_DIRECTORIES|DISCOVERY_ACROSS_FILESYSTEM|CONFIG_COUNT|CONFIG_PARAMETERS|CONFIG_KEY_.*|CONFIG_VALUE_.*)$/.test(key)) delete env[key];
  return env;
}
async function readGit(cwd: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  const result = await execute(git(), ["--no-pager", "-C", cwd, ...args], { env, timeout: 3000, maxBuffer: 65536 });
  return result.stdout.trim();
}
async function refExists(cwd: string, ref: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  try { await readGit(cwd, ["show-ref", "--exists", ref], env); return true; }
  catch (error) { if ((error as { code?: unknown }).code === 2) return false; throw error; }
}
async function taskLock(common: string, purpose: "setup" | "git") {
  let lock; while (!(lock = locks.tryTaskLock(common, purpose))) await new Promise(resolve => setTimeout(resolve, 50)); return lock;
}
async function mutateGit(plan: TaskPlan, args: string[], env: NodeJS.ProcessEnv, input?: string): Promise<void> {
  const lock = await taskLock(plan.common, "git");
  try {
    await new Promise<void>((resolve, reject) => {
      // Transfer an already-locked open-file description, closing the orphan
      // admission gap between spawning a child and that child acquiring a lock.
      const child = spawn(python(), ["-I", gitWaiter(), git(), "--no-pager", "-C", plan.source.cwd, ...args], { env: process.env, stdio: ["pipe", "ignore", "ignore", lock.fd] });
      lock.release();
      // No diagnostic pipes to the parent: its death must not SIGPIPE Git.
      // Output is discarded, never buffered or exposed as a room explanation.
      child.stdin!.on("error", () => {}); child.stdin!.end(JSON.stringify({ env, input }));
      child.once("error", () => reject(new TaskFailure("Task Git helper unavailable")));
      child.once("close", code => code === 0 ? resolve() : reject(new TaskFailure("Task Git effect did not confirm completion; owned partial resources are retained")));
    });
  } finally { lock.release(); }
}
function syncDirectory(path: string): void { const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); try { fsyncSync(fd); } finally { closeSync(fd); } }
function durableFile(path: string, content: string): void {
  const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, content); fsyncSync(fd); } finally { closeSync(fd); }
  syncDirectory(dirname(path));
}
function ownedDirectory(path: string): void {
  const stat = lstatSync(path); if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid!()) throw new TaskFailure(("Task directory is foreign or unsafe"));
}
function prefix(path: string, durable = false): Array<Record<string, unknown>> {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd); if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid!()) throw new TaskFailure(("Unsafe native task history"));
    const bytes = Buffer.alloc(65536), length = readSync(fd, bytes, 0, bytes.length, 0), text = bytes.subarray(0, length).toString("utf8");
    if (durable) fsyncSync(fd);
    return text.slice(0, text.lastIndexOf("\n") + 1).split("\n").filter(Boolean).map(line => object(JSON.parse(line)));
  } finally { closeSync(fd); }
}
function sourceExists(source: TaskSource): void {
  const header = prefix(source.file)[0];
  if (header?.type !== "session" || header.version !== 3 || header.id !== source.nativeId || header.cwd !== source.cwd || realpathSync(source.cwd) !== source.cwd) throw new TaskFailure(("Source native session changed or is missing"));
}
const proof = (plan: TaskPlan) => createHash("sha256").update(JSON.stringify(plan)).digest("hex");
const marker = (plan: TaskPlan) => JSON.stringify({ version: 1, key: plan.key, proof: proof(plan) }) + "\n";
function ownsMarker(path: string, plan: TaskPlan): boolean {
  try { const stat = lstatSync(path); return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.uid === process.getuid!() && readFileSync(path, "utf8") === marker(plan); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
async function sourceProject(source: TaskSource, env: NodeJS.ProcessEnv): Promise<{ common: string; root: string; anchor: string }> {
  sourceExists(source);
  const lines = (await readGit(source.cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir", "--show-toplevel"], env)).split("\n");
  if (lines.length !== 2) throw new TaskFailure(("Task creation requires an ordinary Git checkout"));
  const first = (await readGit(source.cwd, ["worktree", "list", "--porcelain", "-z"], env)).split("\0")[0];
  if (!first?.startsWith("worktree ")) throw new TaskFailure("Git did not identify its main checkout or bare anchor");
  return { common: realpathSync(lines[0]!), root: realpathSync(lines[1]!), anchor: realpathSync(first.slice(9)) };
}
function canonicalDestination(path: string): string {
  let parent = resolve(path); const missing: string[] = [];
  while (!existsSync(parent)) { missing.unshift(basename(parent)); const next = dirname(parent); if (next === parent) throw new TaskFailure(("No native history parent")); parent = next; }
  return join(realpathSync(parent), ...missing);
}
function nativeFile(cwd: string, id: string): string {
  // Pi's pinned, tested default session-directory spelling; no mkdir occurs
  // during approval preparation. Explicit central sessionDirectory wins.
  const directory = process.env.PI_TASK_SESSION_DIRECTORY ? hostPath(process.env.PI_TASK_SESSION_DIRECTORY) :
    join(homedir(), ".pi", "agent", "sessions", `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
  return join(canonicalDestination(directory), `${id}.jsonl`);
}
export async function prepareTask(sourceValue: TaskSource, intentValue: TaskIntent, keyValue: string, nativeId: string): Promise<TaskPlan> {
  const source = taskSource(sourceValue), intent = taskIntent(intentValue), key = taskKey(keyValue); sourceExists(source);
  const env = await projectEnvironment(source.cwd), project = await sourceProject(source, env);
  if (await readGit(source.cwd, ["check-ref-format", "--branch", intent.branch], env) !== intent.branch) throw new TaskFailure(("Task branch must be an explicit new branch name"));
  const base = await readGit(source.cwd, ["rev-parse", "--verify", "--end-of-options", `${intent.base_ref}^{commit}`], env);
  const slug = intent.branch.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 48), projectName = basename(project.anchor).replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 48);
  const container = join(dirname(project.anchor), `${projectName}--${slug}-${key.slice(0, 12)}`);
  const plan = taskPlan({ version: 1, key, source, intent, base, nativeId, common: project.common, sourceRoot: project.root, container,
    worktree: join(container, slug), nativeFile: nativeFile(join(container, slug), nativeId) });
  if (existsSync(container)) throw new TaskFailure(("Task destination already exists; it will not be adopted"));
  if (await refExists(source.cwd, `refs/heads/${intent.branch}`, env)) throw new TaskFailure(("Task branch already exists; it will not be adopted"));
  return plan;
}
function localResult(plan: TaskPlan): TaskLocalResult {
  const entries = prefix(plan.nativeFile, true), header = entries[0];
  const ownership = entries.find(entry => entry.type === "custom" && entry.customType === "matrix-bridge.task" && object(entry.data).proof === proof(plan));
  const boundary = entries.find(entry => entry.type === "custom" && entry.customType === "matrix-bridge.boundary" && object(entry.data).nativeId === plan.nativeId);
  const handoff = entries.find(entry => entry.type === "custom_message" && entry.customType === "matrix-bridge.handoff" && entry.content === plan.intent.handoff_summary && entry.display === true);
  if (header?.type !== "session" || header.id !== plan.nativeId || header.cwd !== plan.worktree || !ownership || !boundary || typeof boundary.id !== "string" || !handoff) throw new TaskFailure(("Native task file is foreign or incomplete; it will not be overwritten"));
  return { file: plan.nativeFile, nativeId: plan.nativeId, cwd: plan.worktree, boundary: boundary.id };
}
async function linkedAdmin(plan: TaskPlan, env: NodeJS.ProcessEnv): Promise<string> {
  ownedDirectory(plan.worktree);
  const common = realpathSync(await readGit(plan.worktree, ["rev-parse", "--path-format=absolute", "--git-common-dir"], env));
  const admin = realpathSync(await readGit(plan.worktree, ["rev-parse", "--absolute-git-dir"], env));
  if (common !== plan.common || dirname(admin) !== realpathSync(join(common, "worktrees"))) throw new TaskFailure("Task path is not the expected linked worktree");
  return admin;
}
export async function createTask(value: TaskPlan, afterEffect: (stage: string) => void = () => {}): Promise<TaskLocalResult> {
  const plan = taskPlan(value), lock = await taskLock(plan.common, "setup");
  try { return await createOwnedTask(plan, afterEffect); } finally { lock.release(); }
}
async function createOwnedTask(plan: TaskPlan, afterEffect: (stage: string) => void): Promise<TaskLocalResult> {
  sourceExists(plan.source);
  const env = await projectEnvironment(plan.source.cwd), project = await sourceProject(plan.source, env);
  if (project.common !== plan.common || project.root !== plan.sourceRoot || dirname(plan.worktree) !== plan.container || basename(plan.nativeFile) !== `${plan.nativeId}.jsonl`) throw new TaskFailure(("Frozen task project or destination changed"));
  // Whole-setup exclusion ends when a helper dies. A surviving Git child has
  // its own inherited kernel lease: wait before interpreting resources.
  await mutateGit(plan, ["rev-parse", "--verify", plan.base], env);
  const ownership = join(plan.container, ".pi-task-owner.json"), reflog = `pi-bridge-task:${plan.key}:${proof(plan)}`;
  if (!existsSync(plan.container)) {
    const staging = mkdtempSync(join(dirname(plan.container), ".pi-task-staging-"));
    durableFile(join(staging, ".pi-task-owner.json"), marker(plan));
    try { locks.renameNoReplace(staging, plan.container); syncDirectory(dirname(plan.container)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!ownsMarker(ownership, plan)) throw new TaskFailure("Task destination already exists and is not owned by this request");
    }
  }
  ownedDirectory(plan.container); if (!ownsMarker(ownership, plan)) throw new TaskFailure(("Task destination is not owned by this frozen creation"));
  syncDirectory(dirname(plan.container));
  afterEffect("container"); sourceExists(plan.source);
  if (existsSync(plan.nativeFile)) {
    // A durable native handoff plus immutable worktree receipt proves completed
    // creation. Later human commits are not a reason to recreate/reset anything.
    const admin = await linkedAdmin(plan, env);
    if (!ownsMarker(join(admin, "pi-bridge-task-owner.json"), plan)) throw new TaskFailure("Completed task worktree ownership is missing");
    const result = localResult(plan); syncDirectory(dirname(plan.nativeFile)); afterEffect("session"); return result;
  }
  const ref = `refs/heads/${plan.intent.branch}`;
  const branch = await readGit(plan.source.cwd, ["for-each-ref", "--format=%(refname)", ref], env);
  if (!branch.split("\n").includes(ref)) await mutateGit(plan, ["update-ref", "--no-deref", "--create-reflog", "-m", reflog, "--stdin"], env, `create ${ref} ${plan.base}\n`);
  if (await readGit(plan.source.cwd, ["rev-parse", "--verify", ref], env) !== plan.base || await readGit(plan.source.cwd, ["reflog", "show", "-1", "--format=%gs", ref], env) !== reflog) throw new TaskFailure(("Task branch is foreign or changed; it will not be reset"));
  afterEffect("branch"); sourceExists(plan.source);
  if (!existsSync(plan.worktree)) await mutateGit(plan, ["worktree", "add", "--lock", "--reason", reflog, "--", plan.worktree, plan.intent.branch], env);
  const admin = await linkedAdmin(plan, env), receipt = join(admin, "pi-bridge-task-owner.json");
  if (await readGit(plan.worktree, ["symbolic-ref", "HEAD"], env) !== ref) throw new TaskFailure(("Task worktree belongs to a different repository or branch"));
  if (!ownsMarker(receipt, plan)) {
    if (readFileSync(join(admin, "locked"), "utf8").trim() !== reflog || await readGit(plan.worktree, ["status", "--porcelain", "--untracked-files=all"], env)) throw new TaskFailure(("Task worktree completion is unproven; partial work is retained"));
    durableFile(receipt, marker(plan));
  }
  if (existsSync(join(admin, "locked"))) {
    if (readFileSync(join(admin, "locked"), "utf8").trim() !== reflog) throw new TaskFailure(("Task worktree has a foreign lock; it will not be changed"));
    await mutateGit(plan, ["worktree", "unlock", "--", plan.worktree], env);
  }
  afterEffect("worktree"); sourceExists(plan.source);
  const sessionDir = dirname(plan.nativeFile);
  if (canonicalDestination(sessionDir) !== sessionDir) throw new TaskFailure("Frozen native history directory changed");
  if (!existsSync(sessionDir)) mkdirSync(sessionDir, { recursive: true, mode: 0o700 }); ownedDirectory(sessionDir);
  if (realpathSync(sessionDir) !== sessionDir) throw new TaskFailure(("Frozen native history directory changed"));
  if (existsSync(plan.nativeFile)) { const result = localResult(plan); syncDirectory(sessionDir); afterEffect("session"); return result; }
  const release = locks.acquireSessionLock(plan.nativeFile);
  try {
    if (!existsSync(plan.nativeFile)) {
      const { SessionManager } = await import(sdk()) as typeof import("@earendil-works/pi-coding-agent");
      const manager = SessionManager.inMemory(plan.worktree, { id: plan.nativeId });
      manager.appendCustomEntry("matrix-bridge.enrollment", { nativeId: plan.nativeId, enabled: true });
      manager.appendCustomEntry("matrix-bridge.task", { key: plan.key, proof: proof(plan) });
      manager.appendCustomEntry("matrix-bridge.boundary", { nativeId: plan.nativeId });
      manager.appendCustomMessageEntry("matrix-bridge.handoff", plan.intent.handoff_summary, true, { key: plan.key });
      manager.appendSessionInfo(plan.intent.title);
      // Serialize public SDK entries, not copied history or an invented session
      // schema. An unpublished .partial file cannot enter native/picker discovery.
      const staging = join(sessionDir, `.pi-task-${randomUUID()}.partial`);
      durableFile(staging, [manager.getHeader(), ...manager.getEntries()].map(entry => JSON.stringify(entry)).join("\n") + "\n");
      locks.renameNoReplace(staging, plan.nativeFile); syncDirectory(sessionDir);
    }
    const result = localResult(plan); afterEffect("session"); return result;
  } finally { release(); }
}
async function main(): Promise<void> {
  process.umask(0o077);
  if (process.argv.length !== 3) throw new TaskFailure(("Task helper requires exactly one operation"));
  process.stdin.setEncoding("utf8");
  let raw = ""; for await (const chunk of process.stdin) { raw += String(chunk); if (Buffer.byteLength(raw) > 65536) throw new TaskFailure(("Task helper input exceeds one bounded request")); }
  const value = object(JSON.parse(raw)), mode = process.argv[2];
  const result = mode === "prepare" ? await prepareTask(taskSource(value.source), taskIntent(value.intent), taskKey(value.key), String(value.nativeId)) :
    mode === "create" ? await createTask(taskPlan(value), stage => process.stdout.write(JSON.stringify({ stage }) + "\n")) : undefined;
  if (!result) throw new TaskFailure(("Unknown task helper operation")); process.stdout.write(JSON.stringify({ result }) + "\n");
}
if (require.main === module) void main().catch(error => {
  process.stdout.write(JSON.stringify({ error: error instanceof TaskFailure ? error.message : "Task helper could not confirm the operation. Check the source, ref and trusted project environment locally; existing resources were not reset or removed." }) + "\n");
  process.exitCode = 1;
});
