import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const exec = promisify(execFile);
import { fileURLToPath } from "node:url";
import { parseHeadlessRequest, runHeadless } from "../config/agent/extensions/aloop/headless.mjs";
const fixture = fileURLToPath(new URL("./fixtures/aloop-headless/fake-pi.mjs", import.meta.url));

test("headless command accepts only bounded execution options", () => {
  assert.equal(parseHeadlessRequest(["#1", "--settlement-minutes", "1"]).epic, 1);
  for (const args of [["1", "--approve", "1"], ["1", "--max-minutes", "241"], ["1", "__proto__", "1"], ["0"], ["1", "--max-minutes", "3", "--max-minutes", "4"]]) assert.throws(() => parseHeadlessRequest(args));
});
for (const [mode, expected] of [["completed", "completed"], ["missing", "missing-outcome"], ["wrong-id", "invalid-outcome"], ["incomplete", "incomplete"], ["decision-required", "decision-required"], ["cancelled", "cancelled"], ["malformed", "rpc-malformed"], ["unsupported", "unsupported-launcher"], ["timeout", "driver-timeout"], ["null", "rpc-malformed"], ["overflow", "rpc-overflow"], ["completed-nonzero", "process-failed"], ["conflicting", "conflicting-outcome"], ["exit", "missing-outcome"]]) {
  test(`headless ${mode} is authoritative and redacted`, async () => {
    const outcome = await runHeadless({ launcher: [process.execPath, fixture], request: { ...parseHeadlessRequest(["1"]), timeoutMs: mode === "timeout" ? 300 : 3000 }, env: { ...process.env, FAKE_HEADLESS_MODE: mode }, graceMs: 500 });
    assert.equal(outcome.status, expected);
    assert.doesNotMatch(JSON.stringify(outcome), /secret-provider|prompt|arguments/);
  });
}
test("packaged headless driver returns a terminal dirty-startup failure without model or GitHub calls", { skip: !process.env.PI_HARNESS_HEADLESS_PI }, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "aloop-headless-package-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await exec("git", ["init", "-q"], { cwd });
  await writeFile(join(cwd, "partial.txt"), "retain this work\n");
  try {
    await exec(process.env.PI_HARNESS_HEADLESS_PI, ["1"], { cwd, env: { PATH: "", HOME: cwd }, timeout: 15_000 });
    assert.fail("dirty startup must not succeed");
  } catch (error) {
    assert.equal(error.code, 2);
    assert.equal(JSON.parse(error.stdout).status, "startup-failed");
  }
});

test("cancelled headless startup cannot report success", async () => {
  const result = await runHeadless({ launcher: [process.execPath, fixture], request: parseHeadlessRequest(["1"]), signal: AbortSignal.abort(), graceMs: 500 });
  assert.equal(result.status, "cancelled");
});
