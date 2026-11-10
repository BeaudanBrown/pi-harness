import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const normal = process.env.PI_HARNESS_NORMAL_PI;
const local = process.env.PI_HARNESS_LOCAL_PI;
const native = process.env.PI_HARNESS_NATIVE_PI;
const nativeLocalOnly = process.env.PI_HARNESS_NATIVE_LOCAL_ONLY_PI;
if (!native || !nativeLocalOnly) throw new Error("Packaged native bridge launchers are required");
if (!normal || !local || !process.env.PI_HARNESS_WORKER_EXTENSION) throw new Error("Packaged engineering launchers are required");

async function probe(t, launcher, role, projectPath, nested = false) {
  const cwd = await mkdtemp(join(tmpdir(), "engineering-runtime-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const resultPath = join(cwd, "probe.json");
  const extension = join(cwd, "probe.mjs");
  await mkdir(join(cwd, "home"));
  await mkdir(join(cwd, "bin"));
  await mkdir(join(cwd, "home/.nix-profile/bin"), { recursive: true });
  for (const [directory, label] of [["bin", "project"], ["home/.nix-profile/bin", "host"]]) {
    const path = join(cwd, directory, "pi-host-profile-probe");
    await writeFile(path, `#!/bin/sh\nprintf ${label}`); await chmod(path, 0o700);
  }
  await writeFile(join(cwd, "home/.profile"), "exit 91\n"); // Must never source shell startup files.
  await writeFile(join(cwd, "bin/git"), "#!/bin/sh\nprintf project-git\\n\n");
  await chmod(join(cwd, "bin/git"), 0o700);
  await writeFile(extension, `
import { readFileSync, writeFileSync } from "node:fs";
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
    const managedEnvironment = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
      name.startsWith("PI_MANAGED_SESSION_") || name.startsWith("PI_MANAGED_PROJECT_") || name.startsWith("PI_MANAGED_COORDINATOR_") || name === "PI_HARNESS_AGENT_PROFILE" || name === "PI_MANAGED_LOCAL_MODEL_TOOLS"));
    const managedTransport = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.startsWith("PI_MANAGED_") || name.startsWith("PI_MATRIX_") || name.startsWith("PI_BRIDGE_CHAT_")));
    let nestedResult;
    if (process.env.ENGINEERING_NESTED_LAUNCHER) {
      const nestedPath = process.env.ENGINEERING_PROBE_RESULT + ".nested";
      const child = spawnSync(process.env.ENGINEERING_NESTED_LAUNCHER, ["--mode", "rpc", "--no-session", "--approve", "--extension", ${JSON.stringify(extension)}], {
        env: { ...process.env, ENGINEERING_NESTED_LAUNCHER: "", ENGINEERING_PROBE_RESULT: nestedPath },
        input: JSON.stringify({ id: "nested-state", type: "get_state" }) + "\\n", encoding: "utf8", timeout: 20000,
      });
      if (child.status !== 0) throw new Error("Nested probe failed: " + child.stderr);
      nestedResult = JSON.parse(readFileSync(nestedPath, "utf8"));
    }
    writeFileSync(process.env.ENGINEERING_PROBE_RESULT, JSON.stringify({ nestedResult, managedTransport, publicBridge: process.env.PI_MATRIX_BRIDGE_UI_CONFIG ? JSON.parse(readFileSync(process.env.PI_MATRIX_BRIDGE_UI_CONFIG, "utf8")) : null, secretKeys: ["MATRIX_ACCESS_TOKEN", "MATRIX_OPERATOR_TOKEN", "CREDENTIALS_DIRECTORY"].filter(key => process.env[key]), lspEnabled: process.env.PI_HARNESS_LSP_ENABLED, registeredTools: pi.getAllTools().map(tool => tool.name), argv: process.argv.slice(2), pathEntries: (process.env.PATH ?? "").split(":"), hostProbe: spawnSync("pi-host-profile-probe", [], { encoding: "utf8" }).stdout ?? null, injected: !!process.env.PI_HARNESS_ENGINEERING_RUNTIME_PATH, tools, diagnosisAborted: /abort/i.test(diagnosis.error ?? ""), managedEnvironment }));
  });
}
`);
  const env = { HOME: join(cwd, "home"), PATH: projectPath ? join(cwd, "bin") : "", XDG_RUNTIME_DIR: cwd, ENGINEERING_PROBE_RESULT: resultPath,
    ...(nested ? { ENGINEERING_NESTED_LAUNCHER: native } : {}) };
  if (["native", "native-local-only"].includes(role)) Object.assign(env, { PI_MATRIX_ACCESS_TOKEN: "fixture-only", PI_BRIDGE_CHAT_SOCKET: "/must-not-connect", PI_MANAGED_SESSIONS_STATE_DIR: "/must-not-use", MATRIX_ACCESS_TOKEN: "fixture-only", MATRIX_OPERATOR_TOKEN: "fixture-only", CREDENTIALS_DIRECTORY: "/must-not-read" });
  if (["native", "native-local-only"].includes(role)) Object.assign(env, {
    PI_MANAGED_PROJECT_SESSION_FILE: join(cwd, "stale-project.jsonl"), PI_MANAGED_COORDINATOR_CWD: cwd,
    PI_MANAGED_COORDINATOR_SESSION_FILE: join(cwd, "stale-coordinator.jsonl"), PI_MANAGED_SESSION_ATTACHMENT_NONCE: "a".repeat(32),
    PI_MANAGED_SESSION_CONVERSATION_ID: "conv_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", PI_MANAGED_SESSION_CONCEPT: "stale",
    PI_MANAGED_SESSION_BINDING_BOUNDARY_ENTRY_ID: "boundary", PI_MANAGED_SESSION_ROOT_KEY: "projects",
    PI_MANAGED_SESSION_WORKSPACE: "stale", PI_MANAGED_SESSION_RELATIVE_CWD: "nested", PI_MANAGED_SESSION_WORKSPACE_PATH: cwd,
    PI_MANAGED_SESSION_MODEL: "stale/model", PI_MANAGED_SESSION_THINKING: "high", PI_HARNESS_AGENT_PROFILE: "managed-project",
    PI_MANAGED_LOCAL_MODEL_TOOLS: "bash"
  });
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

for (const [name, launcher, role] of [["normal", normal, undefined], ["native bridge", native, "native"], ["native local-only", nativeLocalOnly, "native-local-only"]]) {
  test(`${name} packaged launcher supplies the engineering baseline from empty PATH`, async (t) => {
    const { result } = await probe(t, launcher, role, false);
    assert.equal(result.injected, true);
    assert.equal(result.hostProbe, null, "ordinary launchers do not gain shell-profile fallbacks");
    for (const tool of ["managed_host", "remote_session_delete", "remote_artifact_export"]) assert.ok(!result.registeredTools.includes(tool), `removed tool ${tool}`);
    assert.equal(result.diagnosisAborted, true, "already-aborted diagnosis must not select or start a model");
    if (["native", "native-local-only"].includes(role)) assert.deepEqual(result.managedEnvironment, { PI_HARNESS_AGENT_PROFILE: "engineering-full" });
    if (role === "native-local-only") assert.deepEqual(result.managedTransport, {}, "local-only removes inherited managed and Matrix transport configuration");
    if (role === "native" || role === "native-local-only") {
      assert.deepEqual(result.secretKeys, []);
      assert.equal(result.lspEnabled, "1");
      for (const tool of ["web_search", "run_worker", "review_agents", "github_issue_inspect", "lsp_diagnostics"]) assert.ok(result.registeredTools.includes(tool), tool);
      if (role === "native") {
        assert.deepEqual(Object.keys(result.managedTransport), ["PI_MATRIX_BRIDGE_UI_CONFIG"]);
        assert.deepEqual(result.publicBridge, { socket: "%t/pi-matrix-bridge/bridge.sock", roots: ["%h/projects"] });
      } else assert.equal(result.publicBridge, null);
    }
    for (const [name, tool] of Object.entries(result.tools)) { assert.equal(tool.code, 0, name); assert.ok(tool.path, name); if ("versionExit" in tool) assert.equal(tool.versionExit, 0, name); }
  });
  test(`${name} preserves project executable precedence`, async (t) => {
    const { result, cwd } = await probe(t, launcher, role, true);
    assert.equal(result.tools.git.path, join(cwd, "bin/git"));
    assert.equal(result.hostProbe, "project", "project executable shadows the host profile");
  });
}
test("nested native Pi does not inherit an obsolete role or a fixed parent session argument", async t => {
  const { result } = await probe(t, native, "native", false, true);
  assert.deepEqual(result.nestedResult.managedEnvironment, { PI_HARNESS_AGENT_PROFILE: "engineering-full" });
  assert.equal(result.nestedResult.argv.includes("--session"), false);
});

test("lean local launcher does not explicitly inject the engineering baseline", async t => {
  const { result } = await probe(t, local, undefined, false);
  assert.equal(result.injected, false);
  assert.equal(result.hostProbe, null, "lean launcher does not gain shell-profile fallbacks");
});
