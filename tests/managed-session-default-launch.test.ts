import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { classifyLaunchMode, type LaunchModeContext } from "../config/agent/extensions/managed-sessions/launch/mode.js";

const interactive: LaunchModeContext = { configured: true, localOnly: false, stdinIsTTY: true, stdoutIsTTY: true,
	trustedDispatch: false, internalWorker: false, experimentsEnabled: false };

async function realSdk() {
	const pi = process.env.PI_MANAGED_ADAPTER_TEST_PI;
	if (!pi) return undefined;
	return import(pathToFileURL(join(dirname(dirname(pi)), "lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js")).href);
}

test("default launch mode follows real Pi parsing rather than option-looking prompt text", async t => {
	const sdk = await realSdk(); if (!sdk) return t.skip("packaged Pi SDK unavailable");
	const rows: Array<[string[], string, string | undefined]> = [
		[[], "candidate", undefined], [["--mode", "text"], "candidate", undefined],
		[["--", "--print", "--mode", "rpc"], "candidate", undefined],
		[["--extension", "--print"], "candidate", undefined],
		[["--mode", "rpc"], "native", "headless"], [["--mode", "json"], "native", "headless"],
		[["--mode", "text", "-p", "prompt"], "native", "headless"], [["--no-session"], "native", "ephemeral"],
		[["--help"], "native", "diagnostic"], [["--version"], "native", "diagnostic"],
		[["--list-models"], "native", "diagnostic"], [["--export", "saved.jsonl"], "native", "diagnostic"],
		[["--name"], "native", "diagnostic"], [["-unknown"], "native", "diagnostic"],
	];
	for (const [argv, kind, reason] of rows) {
		const actual = classifyLaunchMode(argv, sdk.parseArgs(argv), interactive);
		assert.deepEqual(actual, reason ? { kind, reason } : { kind }, JSON.stringify(argv));
	}
});

test("default launch excludes commands, workers, headless pipes and deliberate experiments", async t => {
	const sdk = await realSdk(); if (!sdk) return t.skip("packaged Pi SDK unavailable");
	for (const command of ["install", "remove", "uninstall", "update", "list", "config", "auth"]) {
		assert.deepEqual(classifyLaunchMode([command], sdk.parseArgs([command]), interactive), { kind: "native", reason: "command" });
	}
	for (const profile of ["review-worker", "diagnostic-worker", "aloop-implementation", "aloop-patch", "pi-local", "managed-coordinator", "managed-project", "custom-explicit-profile"]) {
		assert.deepEqual(classifyLaunchMode([], sdk.parseArgs([]), { ...interactive, profile }), { kind: "native", reason: "worker" });
	}
	for (const context of [{ ...interactive, stdinIsTTY: false }, { ...interactive, stdoutIsTTY: false }]) {
		assert.deepEqual(classifyLaunchMode([], sdk.parseArgs([]), context), { kind: "native", reason: "headless" });
	}
	assert.deepEqual(classifyLaunchMode([], sdk.parseArgs([]), { ...interactive, internalWorker: true }), { kind: "native", reason: "worker" });
	assert.deepEqual(classifyLaunchMode([], sdk.parseArgs([]), { ...interactive, experimentsEnabled: true }), { kind: "native", reason: "experiment" });
	assert.deepEqual(classifyLaunchMode([], sdk.parseArgs([]), { ...interactive, configured: false }), { kind: "native", reason: "not-configured" });
});

test("intentional dispatch and local-only are not automatic-launch candidates and return no parsed credentials", async t => {
	const sdk = await realSdk(); if (!sdk) return t.skip("packaged Pi SDK unavailable");
	const argv = ["--mode", "rpc", "--api-key", "fixture-not-for-host-ipc"]; const parsed = sdk.parseArgs(argv);
	assert.deepEqual(classifyLaunchMode(argv, parsed, { ...interactive, trustedDispatch: true }), { kind: "dispatch" });
	assert.deepEqual(classifyLaunchMode(argv, parsed, { ...interactive, trustedDispatch: true, localOnly: true }), { kind: "local-only" });
	assert.equal(parsed.apiKey, "fixture-not-for-host-ipc", "classifier never mutates native arguments");
	assert.equal(JSON.stringify(classifyLaunchMode(argv, parsed, interactive)).includes("fixture-not-for-host-ipc"), false);
});
