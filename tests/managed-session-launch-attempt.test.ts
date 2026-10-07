import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { beginLaunchAttempt } from "../config/agent/extensions/managed-sessions/launch/attempt.js";
import { parseHostCliArgs } from "../config/agent/extensions/managed-sessions/relay/host-cli-args.js";
import { savedSessionKey } from "../config/agent/extensions/managed-sessions/live-workspace-contracts.js";

const action = { operation: "conversation.create" as const, creationKey: "retry-key", title: "Work", placement: { rootKey: "projects", workspace: "app", relativeCwd: "" } };

test("caller retry identity is durable before import/admission and cannot be overwritten by a competing attempt", async t => {
	const root = await mkdtemp(join(tmpdir(), "launch-attempt-")); t.after(() => rm(root, { recursive: true, force: true }));
	const results = await Promise.allSettled([beginLaunchAttempt(root, "host", action, { path: "/source.jsonl", sessionId: "source" }), beginLaunchAttempt(root, "host", action)]);
	assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
	const winner = results.find(result => result.status === "fulfilled")!; if (winner.status !== "fulfilled") assert.fail();
	const attempt = winner.value, initial = JSON.parse(await readFile(attempt.path, "utf8"));
	assert.equal(initial.phase, "preparing"); assert.equal(initial.action.creationKey, action.creationKey);
	assert.equal((await stat(attempt.path)).mode & 0o777, 0o600);
	await assert.rejects(attempt.complete(), /requires inspection/);
	const ready = { ...action, expectedSessionKey: savedSessionKey("host", "copied-native") };
	await attempt.ready(ready);
	const record = JSON.parse(await readFile(attempt.path, "utf8")); assert.equal(record.phase, "ready"); assert.deepEqual(record.action, ready);
	await assert.rejects(beginLaunchAttempt(root, "host", action), { code: "EEXIST" });
	assert.deepEqual(JSON.parse(await readFile(attempt.path, "utf8")), record);
	// Explicit recovery uses the same typed action/key, never a fresh UUID or a replay daemon.
	const cli = parseHostCliArgs(["conversation", "create", "--creation-key", record.action.creationKey, "--title", record.action.title,
		"--root-key", "projects", "--workspace", "app", "--expected-session-key", record.action.expectedSessionKey]);
	assert.ok("request" in cli); assert.deepEqual(cli.request.action, ready);
	await assert.rejects(attempt.ready(ready), /cannot be replayed/);
	await attempt.complete(); assert.deepEqual(await readdir(root), []);
});

test("incomplete imported attempts retain their identity and cannot become unfenced empty launches", async t => {
	const root = await mkdtemp(join(tmpdir(), "launch-attempt-import-")); t.after(() => rm(root, { recursive: true, force: true }));
	const attempt = await beginLaunchAttempt(root, "host", action, { path: "/source.jsonl", sessionId: "source" });
	await assert.rejects(attempt.ready(action), /identity changed/);
	const record = JSON.parse(await readFile(attempt.path, "utf8")); assert.equal(record.phase, "preparing"); assert.equal(record.source.sessionId, "source");
	await assert.rejects(attempt.complete(), /requires inspection/);
	await assert.rejects(beginLaunchAttempt(root, "host", { ...action, creationKey: "large" }, { path: "x".repeat(20_000), sessionId: "source" }), /exceeds its bound/);
	assert.equal((await readdir(root)).length, 1);
});
