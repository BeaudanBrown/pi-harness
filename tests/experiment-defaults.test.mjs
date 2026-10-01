import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const launcher = process.env.PI_HARNESS_NORMAL_PI;
if (!launcher) throw new Error("Packaged Pi launcher required");

function probe(flags = {}) {
  const root = mkdtempSync(join(tmpdir(), "pi-experiments-"));
  mkdirSync(join(root, "home"));
  const output = join(root, "tools.json");
  const extension = join(root, "probe.mjs");
  writeFileSync(extension, `import { writeFileSync } from 'node:fs';
export default function(pi) {
  pi.on('session_start', () => writeFileSync(process.env.PROBE_OUTPUT, JSON.stringify(pi.getActiveTools())));
}`);
  const env = { ...process.env, HOME: join(root, "home"), PI_CODING_AGENT_DIR: join(root, "home", "agent"),
    PROBE_OUTPUT: output,
    PI_HARNESS_AGENTGRAPH_ROOT: "/nonexistent/development-override",
    PI_HARNESS_AGENTGRAPH_SKILLS_DIR: "/nonexistent/skills",
    PI_R_RESOURCE_ROOT: "/nonexistent/r",
  };
  delete env.PI_HARNESS_ENABLE_PI_R;
  delete env.PI_HARNESS_ENABLE_AGENTGRAPH;
  Object.assign(env, flags);
  const result = spawnSync(launcher, ["--mode", "rpc", "--no-session", "--extension", extension], {
    cwd: root, env, encoding: "utf8", timeout: 30_000,
    input: JSON.stringify({ id: "commands", type: "get_commands" }) + "\n",
  });
  return { result, output };
}

for (const flags of [{}, { PI_HARNESS_ENABLE_PI_R: "0", PI_HARNESS_ENABLE_AGENTGRAPH: "0" }]) {
  test(`normal experiments absent with ${JSON.stringify(flags)}`, () => {
    const { result, output } = probe(flags);
    assert.equal(result.status, 0, result.stderr);
    const events = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
    const response = events.find((event) => event.id === "commands");
    assert.equal(response.success, true);
    const commands = response.data.commands.map((command) => command.name);
    assert.ok(commands.includes("sesh"));
    assert.ok(!commands.includes("r"));
    assert.ok(!commands.includes("ag"));
    assert.ok(!commands.some((name) => /skill:(pi-r|agentgraph)/.test(name)));
    const tools = JSON.parse(readFileSync(output, "utf8"));
    assert.ok(tools.includes("bash"));
    assert.ok(tools.includes("web_search"));
    assert.ok(!tools.some((name) => /^(r_|agentgraph_)|^evaluate_r$/.test(name)));
  });
}

test("unknown switch values fail rather than enabling experiments", () => {
  const { result } = probe({ PI_HARNESS_ENABLE_PI_R: "true" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /must be 0 or 1/);
});

test("explicit AgentGraph opt-in consults the development resource path", () => {
  const { result } = probe({ PI_HARNESS_ENABLE_AGENTGRAPH: "1" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing AgentGraph extension/);
});
