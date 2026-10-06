import assert from "node:assert/strict";
import { dirname, join, relative } from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { classifyLaunchMode, type LaunchModeContext } from "../config/agent/extensions/managed-sessions/launch/mode.js";
import { inspectSavedHistory, resolveNativeSessionPath } from "../config/agent/extensions/managed-sessions/launch/history.js";
import { assertBasicManagedInvocation } from "../config/agent/extensions/managed-sessions/launch/arguments.js";

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
		[[], "candidate", undefined], [["--mode", "text"], "candidate", undefined], [["--export", ""], "candidate", undefined],
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

test("automatic workspace eligibility is read-only, Git-only and validates linked checkout identity", async t => {
	const launcher = process.env.PI_MANAGED_TEST_LAUNCHER; if (!launcher) return t.skip("packaged launcher unavailable");
	const root = await mkdtemp(join(tmpdir(), "pi-auto-workspace-")); t.after(() => rm(root, { recursive: true, force: true }));
	const workspaces = join(root, "configured roots"); const main = join(workspaces, "main"); const plain = join(workspaces, "plain");
	await mkdir(main, { recursive: true }); await mkdir(plain);
	const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", PI_MANAGED_TEST_WORKSPACE_ROOT: workspaces,
		PI_MANAGED_TEST_TMUX_SOCKET: `unused-auto-${process.pid}`, PI_MANAGED_SESSIONS_WORKSPACE_ROOTS: JSON.stringify({ projects: workspaces }) };
	const git = (args: string[]) => execFileSync("git", args, { env, cwd: root, stdio: "pipe" });
	git(["-C", main, "init", "-b", "main"]);
	git(["-C", main, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "--no-gpg-sign", "--allow-empty", "-m", "fixture"]);
	const invoke = (cwd: string, roots: Record<string, string> = { projects: workspaces }) => JSON.parse(execFileSync(launcher, ["managed", "workspace-identify-auto"], {
		input: JSON.stringify({ cwd }), encoding: "utf8", cwd: root, stdio: "pipe", env: { ...env, PI_MANAGED_SESSIONS_WORKSPACE_ROOTS: JSON.stringify(roots) },
	}));
	assert.deepEqual(invoke(plain), { eligible: false, reason: "not-git-checkout" });
	assert.deepEqual(invoke(main), { eligible: true, placement: { rootKey: "projects", workspace: "main", relativeCwd: "" }, cwd: main });
	const relative = "literal $(touch CANARY) ; punctuation"; const subdir = join(main, relative); await mkdir(subdir);
	assert.deepEqual(invoke(subdir, { outer: root, projects: workspaces, absent: join(root, "missing") }), {
		eligible: true, placement: { rootKey: "projects", workspace: "main", relativeCwd: relative }, cwd: subdir,
	});
	assert.equal((await readdir(root)).includes("CANARY"), false, "literal cwd cannot execute shell text");
	const linked = join(workspaces, "linked"); git(["-C", main, "worktree", "add", linked, "-b", "linked"]);
	assert.equal(invoke(linked).eligible, true);
	const forged = join(workspaces, "forged"); await mkdir(forged); await writeFile(join(forged, ".git"), await readFile(join(linked, ".git")));
	assert.throws(() => invoke(forged), "a copied gitdir pointer is not a registered linked checkout");
	const nested = join(main, "nested-repo"); await mkdir(nested); git(["-C", nested, "init", "-b", "main"]);
	assert.deepEqual(invoke(nested), { eligible: false, reason: "outside-configured-checkouts" }, "never bind a nested repo as the enclosing checkout");
	const outside = join(root, "outside"); await mkdir(outside); git(["-C", outside, "init", "-b", "main"]);
	assert.deepEqual(invoke(outside), { eligible: false, reason: "outside-configured-checkouts" });
	assert.throws(() => invoke(main, { first: workspaces, second: workspaces }), /Ambiguous configured checkout roots/, "duplicate root authorities are ambiguous before resolver dispatch");
	const explicit = JSON.parse(execFileSync(launcher, ["managed", "workspace-resolve"], {
		input: JSON.stringify({ rootKey: "projects", workspace: "plain", relativeCwd: "" }), encoding: "utf8", cwd: root, env, stdio: "pipe",
	}));
	assert.equal(explicit.cwd, plain, "existing explicit non-Git support remains intact");
	assert.deepEqual(await readdir(plain), [], "eligibility and explicit resolution create no session or workspace files");
});

test("saved history inspection uses real SDK parsing and refuses concealed or unproven authority", async t => {
	const sdk = await realSdk(); if (!sdk) return t.skip("packaged Pi SDK unavailable");
	const id = randomUUID(); const header = { type: "session", version: sdk.CURRENT_SESSION_VERSION, id, cwd: process.cwd(), timestamp: new Date().toISOString() };
	const encode = (...rows: unknown[]) => rows.map(row => JSON.stringify(row)).join("\n") + "\n";
	const inspect = (text: string) => inspectSavedHistory(text, sdk.parseSessionEntries, sdk.CURRENT_SESSION_VERSION);
	assert.deepEqual(inspect(encode(header)), { sessionId: id, cwd: process.cwd(), managedMarkers: false });
	for (const customType of ["managed-session.binding", "managed-session.binding-boundary", "managed-session.unbound", "managed-session.tree"]) {
		const marker = { type: "custom", id: "scope", parentId: null, customType, data: { version: "1.0.0", sessionId: id } };
		assert.equal(inspect(encode(header, marker)).managedMarkers, true);
		assert.equal(inspect(encode({ ...header, id: randomUUID() }, marker)).managedMarkers, false, "copied old-session metadata is not new-session authority");
		for (const data of [undefined, null, {}, { version: "1.0.0", sessionId: "" }, { version: "1.0.0", sessionId: "invalid scope" }, { version: "future", sessionId: randomUUID() }]) {
			assert.equal(inspect(encode(header, { ...marker, data })).managedMarkers, true, "malformed scope cannot imply unbound");
		}
	}
	assert.equal(inspect(encode(header, { type: "custom", customType: "managed-session.binding-future", data: { version: "1.0.0", sessionId: randomUUID() } })).managedMarkers, true, "unknown binding schemas cannot prove a foreign scope");
	assert.throws(() => inspect(encode(header) + '{"type":"custom",broken\n'), /safely inspected/);
	assert.throws(() => inspect(encode(header, null)), /safely inspected/);
	assert.throws(() => inspect(encode(header, { ...header, id: randomUUID() })), /ambiguous session header/);
	assert.throws(() => inspect(encode({ ...header, version: sdk.CURRENT_SESSION_VERSION + 1 })), /unsupported/);
	assert.throws(() => inspectSavedHistory(encode(header), sdk.parseSessionEntries, NaN), /Unsupported SDK/);
});

test("basic managed invocation accepts bare Pi and literal resume selectors without rewriting", async t => {
	const sdk = await realSdk(); if (!sdk) return t.skip("packaged Pi SDK unavailable");
	for (const argv of [[], ["-c"], ["-r"], ["--session", "literal ; $(no-exec).jsonl"], ["--session-id", randomUUID()], ["-r", "--session-dir", "/saved histories"]]) {
		const parsed = sdk.parseArgs(argv); const original = structuredClone(parsed);
		assert.doesNotThrow(() => assertBasicManagedInvocation(parsed));
		assert.deepEqual(parsed, original);
	}
	for (const argv of [["--session", ""], ["--session", "invalid\0path"], ["--session-id", randomUUID(), "-r"], ["--session-dir", "/new storage"]]) {
		assert.throws(() => assertBasicManagedInvocation(sdk.parseArgs(argv)));
	}
});

test("basic managed invocation refuses overrides without echoing secrets or silently dropping values", async t => {
	const sdk = await realSdk(); if (!sdk) return t.skip("packaged Pi SDK unavailable");
	for (const argv of [["--api-key", "fixture-secret"], ["--model", "fixture-model"], ["--thinking", "high"], ["--name", "title"],
		["--extension", "plugin.ts"], ["--skill", "skills"], ["--theme", "theme"], ["@notes.md"], ["prompt"], ["-r", "prompt"],
		["--append-system-prompt", "scratch prompt"], ["--no-context-files"], ["--fork", "source.jsonl"], ["--mode", "text"],
		["--session=source.jsonl"], ["--custom"], ["--", "--session"], ["--system-prompt"], ["--thinking", "invalid"]]) {
		assert.throws(() => assertBasicManagedInvocation(sdk.parseArgs(argv)), error => error instanceof Error && error.message.includes("pi-local-only") && !error.message.includes("fixture-secret"));
	}
	assert.throws(() => assertBasicManagedInvocation({ ...sdk.parseArgs([]), futureOption: true }), /pi-local-only/);
});

test("native path normalization agrees with public SessionManager without modifying fixture history",  async t => {
	const sdk = await realSdk(); if (!sdk) return t.skip("packaged Pi SDK unavailable");
	const root = await mkdtemp(join(tmpdir(), "pi-native-path-")); t.after(() => rm(root, { recursive: true, force: true }));
	const path = join(root, "literal # percent % ; saved.jsonl");
	const original = JSON.stringify({ type: "session", version: sdk.CURRENT_SESSION_VERSION, id: randomUUID(), cwd: root, timestamp: new Date().toISOString() }) + "\n";
	await writeFile(path, original);
	for (const selector of [path, relative(process.cwd(), path), `~/${relative(homedir(), path)}`, pathToFileURL(path).href]) {
		assert.equal(resolveNativeSessionPath(selector, process.cwd()), path);
		assert.equal(sdk.SessionManager.open(selector).getSessionFile(), path, "only disposable existing fixtures are opened to compare SDK semantics");
		assert.equal(await readFile(path, "utf8"), original);
	}
});
