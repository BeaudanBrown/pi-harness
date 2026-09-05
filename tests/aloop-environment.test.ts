import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import { preflightAloopEnvironment, resolveAloopEnvironment } from "../config/agent/extensions/github-issues/aloop-environment.js";

async function fixture(t: test.TestContext) {
	const cwd = await mkdtemp(path.join(tmpdir(), "aloop-env-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	for (const dir of ["project", "fallback"]) await mkdir(path.join(cwd, dir));
	for (const [dir, names] of [["project", ["git"]], ["fallback", ["git", "bash", "nix"]]] as const) {
		for (const name of names) { const file = path.join(cwd, dir, name); await writeFile(file, "#!/bin/sh\nexit 0\n"); await chmod(file, 0o700); }
	}
	return cwd;
}

test("preflight uses project precedence with minimal PATH and does not persist environment values", async (t) => {
	const cwd = await fixture(t);
	const env = { PATH: path.join(cwd, "project"), PI_HARNESS_ENGINEERING_RUNTIME_PATH: path.join(cwd, "fallback"), PI_HARNESS_LSP_FALLBACK_PATH: "", SECRET: "never-record-this-value" };
	const result = await preflightAloopEnvironment({ cwd, env: resolveAloopEnvironment(env), launcher: [process.execPath], canonicalCommand: ["nix", "run", ".#verify"] });
	assert.equal(result.status, "ready");
	assert.equal(result.executables.git, path.join(cwd, "project", "git"));
	assert.equal(result.executables["canonical-command"], path.join(cwd, "fallback", "nix"));
	assert.doesNotMatch(JSON.stringify(result), /SECRET|never-record-this-value/);
	assert.equal(resolveAloopEnvironment(resolveAloopEnvironment(env)).PATH, resolveAloopEnvironment(env).PATH);
});

test("canonical preflight rejects a command available only in worker fallback PATH", async (t) => {
	const cwd = await fixture(t);
	const result = await preflightAloopEnvironment({ cwd, env: { PATH: path.join(cwd, "project"), PI_HARNESS_ENGINEERING_RUNTIME_PATH: path.join(cwd, "fallback"), PI_HARNESS_LSP_FALLBACK_PATH: "" }, launcher: [process.execPath], canonicalCommand: ["nix"] });
	assert.equal(result.status, "environment-blocked");
	assert.deepEqual(result.missing, ["canonical-command"]);
	assert.equal(result.executables.shell, path.join(cwd, "fallback", "bash"));
});

test("missing shell and canonical executable return role labels without commands or private arguments", async (t) => {
	const cwd = await fixture(t);
	const result = await preflightAloopEnvironment({ cwd, env: { PATH: path.join(cwd, "project"), PI_HARNESS_ENGINEERING_RUNTIME_PATH: "", PI_HARNESS_LSP_FALLBACK_PATH: "" }, launcher: [process.execPath], canonicalCommand: ["private-missing-command", "secret-argument"] });
	assert.equal(result.status, "environment-blocked");
	assert.deepEqual(result.missing, ["shell", "canonical-command"]);
	assert.doesNotMatch(JSON.stringify(result), /private-missing-command|secret-argument/);
});

test("preflight checks executable permissions and respects cancellation", async (t) => {
	const cwd = await fixture(t);
	await chmod(path.join(cwd, "fallback", "nix"), 0o600);
	const input = { cwd, env: { PATH: path.join(cwd, "fallback"), PI_HARNESS_ENGINEERING_RUNTIME_PATH: "", PI_HARNESS_LSP_FALLBACK_PATH: "" }, launcher: [process.execPath], canonicalCommand: ["nix"] };
	assert.deepEqual((await preflightAloopEnvironment(input)).missing, ["canonical-command"]);
	await assert.rejects(preflightAloopEnvironment({ ...input, signal: AbortSignal.abort() }), /abort/i);
});
