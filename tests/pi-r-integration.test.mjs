import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

const exec = promisify(execFile);
const normalPi = process.env.PI_HARNESS_NORMAL_PI;
const localPi = process.env.PI_HARNESS_LOCAL_PI;
if (!normalPi || !localPi) throw new Error("Pi harness launcher paths are required");

async function git(cwd, ...args) {
  return (await exec("git", args, { cwd })).stdout.trim();
}

async function rpc(launcher, args, options, commands) {
  return await new Promise((resolve, reject) => {
    const child = spawn(launcher, args, options);
    let stdout = "";
    let stderr = "";
    let buffer = "";
    let next = 0;
    const sendNext = () => {
      if (next === commands.length) child.stdin.end();
      else child.stdin.write(`${JSON.stringify(commands[next])}\n`);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`RPC probe timed out: ${stderr}`));
    }, 30_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      buffer += chunk;
      while (buffer.includes("\n")) {
        const index = buffer.indexOf("\n");
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        const event = JSON.parse(line);
        if (event.type === "response" && event.id === commands[next]?.id) {
          next += 1;
          sendNext();
        }
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`RPC probe exited ${code}: ${stderr}`));
    });
    sendNext();
  });
}

async function probe(launcher, expectedKind) {
  const root = await mkdtemp(join(tmpdir(), `pi-r-${expectedKind}-`));
  await mkdir(join(root, "home"));
  await git(root, "init", "-q");
  await git(root, "config", "user.name", "Pi R Test");
  await git(root, "config", "user.email", "pi-r@example.invalid");
  await writeFile(join(root, "README.md"), "# probe\n");
  await git(root, "add", "README.md");
  await git(root, "commit", "-qm", "Initial");

  const resultPath = join(root, "probe.jsonl");
  const probePath = join(root, "probe.mjs");
  await writeFile(probePath, `
import { appendFileSync } from "node:fs";
const record = (kind, tools) => appendFileSync(process.env.PI_R_PROBE, JSON.stringify({ kind, tools }) + "\\n");
export default function (pi) {
  pi.registerCommand("pi-r-probe", { handler: async (arg) => record(arg.trim(), pi.getActiveTools()) });
  pi.on("session_shutdown", () => record("shutdown", pi.getActiveTools()));
}
`);

  const commands = [
    { id: "commands", type: "get_commands" },
    { id: "initial", type: "prompt", message: "/pi-r-probe initial" },
    { id: "start", type: "prompt", message: "/r start" },
    { id: "active", type: "prompt", message: "/pi-r-probe active" },
    { id: "stop", type: "prompt", message: "/r stop" },
    { id: "restored", type: "prompt", message: "/pi-r-probe restored" },
  ];
  const { stdout } = await rpc(launcher, ["--mode", "rpc", "--no-session", "--extension", probePath], {
    cwd: root,
    env: { ...process.env, HOME: join(root, "home"), PI_R_PROBE: resultPath },
    stdio: ["pipe", "pipe", "pipe"],
  }, commands);
  const events = stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const commandResponse = events.find((event) => event.type === "response" && event.id === "commands");
  assert.equal(commandResponse?.success, true);
  const names = commandResponse.data.commands.map((command) => command.name);
  assert.ok(names.includes("r"));
  assert.ok(names.includes("pi-r-probe"));
  if (expectedKind === "normal") {
    assert.ok(names.includes("remote"), "normal Pi must retain harness commands");
    assert.equal(names.includes("skill:pi-r"), false, "normal Pi must not add inactive R guidance");
  } else {
    assert.ok(names.includes("skill:pi-r"), "local Pi must explicitly load only the pi-r skill");
    assert.equal(names.includes("remote"), false, "local Pi must not load general harness extensions");
    assert.equal(names.some((name) => name.startsWith("skill:") && name !== "skill:pi-r"), false);
  }

  const records = (await readFile(resultPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const initial = records.find((entry) => entry.kind === "initial").tools;
  const active = records.find((entry) => entry.kind === "active").tools;
  const restored = records.find((entry) => entry.kind === "restored").tools;
  const shutdown = records.find((entry) => entry.kind === "shutdown").tools;
  assert.equal(initial.some((name) => name.startsWith("r_") || name === "evaluate_r"), false);
  assert.deepEqual(active, ["read", "grep", "find", "ls", "r_contract_propose", "evaluate_r", "r_worker_status", "r_worker_reset"]);
  assert.deepEqual(restored, initial, `${expectedKind} launcher tools must be restored by /r stop`);
  assert.deepEqual(shutdown, initial, `${expectedKind} launcher tools must remain restored at shutdown`);
  if (expectedKind === "local") {
    assert.deepEqual(initial, ["read", "bash", "edit", "write", "grep", "find", "ls"]);
  }
}

test("normal Pi keeps pi-r inactive and restores its full tool surface", { timeout: 40_000 }, async () => {
  await probe(normalPi, "normal");
});

test("lean local Pi loads only explicit pi-r guidance and restores lean tools", { timeout: 40_000 }, async () => {
  await probe(localPi, "local");
});
