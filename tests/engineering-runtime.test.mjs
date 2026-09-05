import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const normal = process.env.PI_HARNESS_NORMAL_PI;
const managed = process.env.PI_HARNESS_MANAGED_PI;
const local = process.env.PI_HARNESS_LOCAL_PI;
if (!normal || !managed || !local || !process.env.PI_HARNESS_WORKER_EXTENSION) throw new Error("Packaged engineering launchers are required");

async function probe(t, launcher, role, projectPath) {
  const cwd = await mkdtemp(join(tmpdir(), "engineering-runtime-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const resultPath = join(cwd, "probe.json");
  const extension = join(cwd, "probe.mjs");
  await mkdir(join(cwd, "home"));
  await mkdir(join(cwd, "bin"));
  await writeFile(join(cwd, "bin/git"), "#!/bin/sh\nprintf project-git\\n\n");
  await chmod(join(cwd, "bin/git"), 0o700);
  await writeFile(extension, `
import { writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { diagnoseCommandResult } from ${JSON.stringify(process.env.PI_HARNESS_WORKER_EXTENSION)};
export default function(pi) {
  pi.on("session_start", async () => {
    const names = ["bash", "git", "gh", "nix", "rg", "flock", "jq", "find", "grep", "sed", "cp"];
    const tools = {};
    if (process.env.PI_HARNESS_ENGINEERING_RUNTIME_PATH) {
      for (const name of names) {
        const result = spawnSync("bash", ["-c", 'command -v "$1"', "probe", name], { encoding: "utf8" });
        tools[name] = { code: result.status, path: result.stdout?.trim() };
      }
      for (const name of ["nix", "gh", "rg", "flock"]) {
        tools[name].versionExit = spawnSync(name, ["--version"], { encoding: "utf8" }).status;
      }
    }
    const diagnosis = await diagnoseCommandResult(new Proxy({}, { get() { throw new Error("model context must not be read"); } }), { name: "check", command: ["must-not-run"], task: "diagnose" }, { code: null, cancelled: true, timedOut: false, stdout: "", stderr: "", durationMs: 0, logPath: "not-run" }, "", AbortSignal.abort());
    writeFileSync(process.env.ENGINEERING_PROBE_RESULT, JSON.stringify({ injected: !!process.env.PI_HARNESS_ENGINEERING_RUNTIME_PATH, tools, diagnosisAborted: /abort/i.test(diagnosis.error ?? "") }));
  });
}
`);
  const env = { HOME: join(cwd, "home"), PATH: projectPath ? join(cwd, "bin") : "", ENGINEERING_PROBE_RESULT: resultPath };
  if (role === "project") Object.assign(env, { PI_MANAGED_SESSION_LAUNCH_ROLE: "project", PI_MANAGED_PROJECT_SESSION_FILE: join(cwd, "session.jsonl") });
  if (role === "coordinator") Object.assign(env, { PI_MANAGED_SESSION_LAUNCH_ROLE: "coordinator", PI_MANAGED_COORDINATOR_CWD: cwd, PI_MANAGED_COORDINATOR_SESSION_FILE: join(cwd, "coordinator.jsonl") });
  await new Promise((resolve, reject) => {
    const child = spawn(launcher, ["--mode", "rpc", "--no-session", "--approve", "--extension", extension], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "", buffer = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`Probe timed out: ${stderr}`)); }, 30_000);
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      while (buffer.includes("\n")) {
        const end = buffer.indexOf("\n"), line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try { if (JSON.parse(line).id === "state") child.stdin.end(); } catch { /* diagnostics are not RPC responses */ }
      }
    });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`Probe exit ${code}: ${stderr}`)); });
    child.stdin.write(`${JSON.stringify({ id: "state", type: "get_state" })}\n`);
  });
  return { result: JSON.parse(await readFile(resultPath, "utf8")), cwd };
}

for (const [name, launcher, role] of [["normal", normal, undefined], ["managed project", managed, "project"]]) {
  test(`${name} packaged launcher supplies the engineering baseline from empty PATH`, async (t) => {
    const { result } = await probe(t, launcher, role, false);
    assert.equal(result.injected, true);
    assert.equal(result.diagnosisAborted, true, "already-aborted diagnosis must not select or start a model");
    for (const [name, tool] of Object.entries(result.tools)) { assert.equal(tool.code, 0, name); assert.ok(tool.path, name); if ("versionExit" in tool) assert.equal(tool.versionExit, 0, name); }
  });
  test(`${name} preserves project executable precedence`, async (t) => {
    const { result, cwd } = await probe(t, launcher, role, true);
    assert.equal(result.tools.git.path, join(cwd, "bin/git"));
  });
}
for (const [name, launcher, role] of [["local", local, undefined], ["coordinator", managed, "coordinator"]]) {
  test(`${name} launcher does not explicitly inject the engineering baseline`, async (t) => {
    const { result } = await probe(t, launcher, role, false);
    assert.equal(result.injected, false);
  });
}
