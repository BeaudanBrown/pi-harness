import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, closeSync, existsSync, fstatSync, lstatSync, mkdtempSync, openSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import locks from "./session-lock.cjs";
import { TaskFailure, taskPlan, type TaskIntent, type TaskLocalResult, type TaskPlan, type TaskSource } from "./task-contract.js";
import { durableFile, git, localResult, marker, nativeFile, ownedDirectory, ownsMarker, publishNativeHandoff, sourceExists, syncDirectory, taskLock } from "./task-worker.js";

const execute = promisify(execFile);
const readme = (intent: TaskIntent) => `# ${intent.project!.name}\n\n${intent.project!.description}\n`;
function present(path: string): boolean {
  try { lstatSync(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
function validate(plan: TaskPlan): void {
  const project = plan.intent.project;
  if (!project || !plan.createdAt || realpathSync(project.root) !== project.root || dirname(plan.worktree) !== project.root || basename(plan.worktree) !== project.name ||
      plan.container !== plan.worktree || plan.common !== plan.worktree || plan.sourceRoot !== project.root || basename(plan.nativeFile) !== `${plan.nativeId}.jsonl` ||
      plan.base !== createHash("sha256").update(readme(plan.intent)).digest("hex")) throw new TaskFailure("Frozen project destination changed");
  ownedDirectory(project.root); sourceExists(plan.source);
}
export async function prepareProject(source: TaskSource, intent: TaskIntent, key: string, nativeId: string): Promise<TaskPlan> {
  const project = intent.project!;
  const destination = join(project.root, project.name);
  const plan = taskPlan({ version: 1, key, source, intent, base: createHash("sha256").update(readme(intent)).digest("hex"),
    common: destination, sourceRoot: project.root, container: destination, worktree: destination,
    nativeFile: nativeFile(destination, nativeId), nativeId, createdAt: new Date().toISOString() });
  validate(plan);
  if (present(destination)) throw new TaskFailure("Project destination already exists; it will not be adopted");
  return plan;
}
async function projectGit(cwd: string, plan: TaskPlan, args: string[]): Promise<string> {
  // Never inherit project/agent Git config, signing programs, templates or hooks.
  // This is a new minimal repository, not execution of a trusted project's env.
  const env = { PATH: dirname(git()), HOME: cwd, LANG: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Pi Project", GIT_AUTHOR_EMAIL: "pi-project@localhost", GIT_COMMITTER_NAME: "Pi Project", GIT_COMMITTER_EMAIL: "pi-project@localhost",
    GIT_AUTHOR_DATE: plan.createdAt!, GIT_COMMITTER_DATE: plan.createdAt! };
  try {
    const result = await execute(git(), ["--no-pager", "-C", cwd, "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "core.fsmonitor=false", "-c", "core.fsync=all", ...args],
      { env, timeout: 15000, maxBuffer: 65536 });
    return result.stdout.trim();
  } catch { throw new TaskFailure("Project Git operation was not confirmed; partial resources retained"); }
}
function initialCommit(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid!() || stat.size > 100) throw new TaskFailure("Unsafe project commit receipt");
    const value = readFileSync(fd, "utf8").trim();
    if (!/^[a-f0-9]{40}$/.test(value)) throw new TaskFailure("Invalid project commit receipt");
    return value;
  } finally { closeSync(fd); }
}
export async function createProject(value: TaskPlan, afterEffect: (stage: string) => void = () => {}): Promise<TaskLocalResult> {
  const plan = taskPlan(value); validate(plan);
  const lease = await taskLock(plan.worktree, "setup");
  try {
    validate(plan);
    if (!present(plan.worktree)) {
      // Every attempt has private staging. Orphan Git children can finish only
      // there; they can never publish a destination after their helper dies.
      const staging = mkdtempSync(join(plan.sourceRoot, ".pi-project-staging-"));
      durableFile(join(staging, "README.md"), readme(plan.intent));
      await projectGit(staging, plan, ["init", "--initial-branch=main", "--object-format=sha1", "--template="]);
      await projectGit(staging, plan, ["config", "user.name", "Pi Project"]);
      await projectGit(staging, plan, ["config", "user.email", "pi-project@localhost"]);
      await projectGit(staging, plan, ["add", "--", "README.md"]);
      await projectGit(staging, plan, ["commit", "--no-gpg-sign", "-m", "Initialize project"]);
      const commit = await projectGit(staging, plan, ["rev-parse", "HEAD"]);
      durableFile(join(staging, ".git", "pi-project-initial"), commit + "\n");
      durableFile(join(staging, ".git", "pi-bridge-project-owner.json"), marker(plan));
      syncDirectory(staging);
      sourceExists(plan.source);
      locks.renameNoReplace(staging, plan.worktree);
      syncDirectory(plan.sourceRoot);
    }
    ownedDirectory(plan.worktree);
    const admin = join(plan.worktree, ".git"); ownedDirectory(admin);
    if (realpathSync(plan.worktree) !== plan.worktree || realpathSync(admin) !== admin || !ownsMarker(join(admin, "pi-bridge-project-owner.json"), plan)) throw new TaskFailure("Project belongs to a different creation; no adoption or overwrite");
    if (await projectGit(plan.worktree, plan, ["rev-parse", "--absolute-git-dir"]) !== admin) throw new TaskFailure("Project Git identity changed");
    const commit = initialCommit(join(admin, "pi-project-initial"));
    syncDirectory(plan.sourceRoot); afterEffect("container");
    if (existsSync(plan.nativeFile)) {
      const result = localResult(plan); afterEffect("session"); return result;
    }
    if (await projectGit(plan.worktree, plan, ["rev-parse", "HEAD"]) !== commit ||
        await projectGit(plan.worktree, plan, ["symbolic-ref", "HEAD"]) !== "refs/heads/main" ||
        await projectGit(plan.worktree, plan, ["status", "--porcelain", "--untracked-files=all"])) throw new TaskFailure("Incomplete project changed after publication; inspect without resetting it");
    sourceExists(plan.source); afterEffect("worktree");
    return await publishNativeHandoff(plan, afterEffect);
  } finally { lease.release(); }
}
