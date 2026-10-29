import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { HostActionSchema } from "../config/agent/extensions/managed-sessions/live-workspace-contracts.js";
import { parseHostCliArgs, hostControlHelp } from "../config/agent/extensions/managed-sessions/relay/host-cli-args.js";
import { runHostCli } from "../config/agent/extensions/managed-sessions/relay/host-cli.js";
import { HostControlServer } from "../config/agent/extensions/managed-sessions/relay/host-control-server.js";
import { HostDispatcher } from "../config/agent/extensions/managed-sessions/relay/host-dispatcher.js";
import { HostPolicy } from "../config/agent/extensions/managed-sessions/relay/host-policy.js";

const cid = `conv_${"a".repeat(32)}`; const preview = `preview_${"a".repeat(32)}`;
const workspace = "--root-key projects --workspace repo";
const creation = "--creation-key create-1 --title Label";
const apply = `--preview-id ${preview} --confirmed`;
const commands = [
	"host status", "workspace list --limit 50", `project create ${workspace} ${creation}`, `worktree list ${workspace}`,
	`worktree create ${workspace} --creation-key create-1 --base-ref main --branch topic`,
	`worktree conversation create ${workspace} ${creation} --base-ref main --branch topic`,
	`worktree conversation fork ${workspace} ${creation} --source-conversation-id ${cid} --base-ref main --branch topic --summary context`,
	`worktree remove preview ${workspace} --merge-target main`, `worktree remove apply ${apply}`,
	`worktree conversation cleanup preview ${cid}`, `worktree conversation cleanup apply ${apply}`, `worktree branch delete ${apply}`, `worktree branch preview ${workspace} --branch feature/test --merge-target main`,
	"conversation list", `conversation status ${cid}`, `conversation create ${workspace} ${creation}`,
	...["open", "resume", "stop"].map((word) => `conversation ${word} ${cid}`),
	`conversation admin preview --conversation-ids ${cid} --include-spaces`,
	`conversation admin apply --preview-id preview_${"1".repeat(32)} --confirmed`,
	`conversation recover preview ${cid}`,
	`conversation recover apply --preview-id preview_${"1".repeat(32)} --confirmed --operator-closed --accept-incomplete-inspection`,
	...["refresh", "delete", "migrate"].map((word) => `conversation ${word} ${cid} --confirmed`),
	`conversation delete preview --conversation-ids ${cid}`, `conversation delete apply ${apply}`,
	`space reconcile preview --conversation-ids ${cid}`, `space reconcile apply ${apply}`, "space cleanup preview", `space cleanup apply ${apply}`,
	"coordinator membership restore --confirmed",
];

test("CLI noun/action grammar covers the complete operation catalog", () => {
	const operations: string[] = [];
	for (const command of commands) {
		const parsed = parseHostCliArgs([...command.split(" "), "--json", "--request-id", "retry-1"]);
		assert.ok("request" in parsed); assert.equal(parsed.json, true); assert.equal(parsed.request.actor.requestId, "retry-1");
		operations.push(parsed.request.action.operation);
		assert.ok(hostControlHelp().includes(parsed.request.action.operation.replaceAll(".", " ")));
		if (parsed.request.action.operation === "conversation.create") assert.equal(parsed.request.action.placement.relativeCwd, "");
	}
	assert.deepEqual(operations.sort(), HostActionSchema.anyOf.map((schema) => schema.properties.operation.const).sort());
	assert.ok(Buffer.byteLength(hostControlHelp()) < 16 * 1024);
});

test("CLI rejects abbreviated IDs, unknown fields, unbounded data and ambiguous flags", () => {
	for (const command of [
		"conversation open title", "conversation open conv_aaaa", `conversation open ${cid} --window-id @1`,
		`conversation open ${cid} --actor human_local`, "host status --argv echo", "conversation restart",
		"conversation list --limit 101", "conversation list --limit 1e2", "conversation list --limit 0", "conversation list --limit 1 --limit 2",
		"host status --json --json", `conversation delete ${cid}`, `conversation delete ${cid} --confirmed=false`,
		`conversation delete preview --conversation-ids ${cid},${cid}`, "host status --request-id ../file",
		`conversation create --root-key projects --workspace ../foreign ${creation}`, "host status unexpected",
	]) assert.throws(() => parseHostCliArgs(command.split(" ")), command);
	assert.throws(() => parseHostCliArgs(["conversation", "list", "--cursor", "x".repeat(64 * 1024)]));
	const parsed = parseHostCliArgs(["conversation", "create", "--root-key=projects", "--workspace=repo", "--creation-key=key", "--title=--literal-label", "--relative-cwd=src"]);
	assert.ok("request" in parsed && parsed.request.action.operation === "conversation.create");
	assert.equal(parsed.request.action.title, "--literal-label"); assert.equal(parsed.request.action.placement.relativeCwd, "src");
});

test("CLI help needs no host and JSON failures emit exactly one bounded result", async () => {
	for (const args of [["host", "status", "--json"], ["host", "status", "--unknown", "--json"], ["--help", "--json"]]) {
		let stdout = ""; let stderr = "";
		const exit = await runHostCli(args, {}, { stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; } });
		assert.equal(stdout.trim().split("\n").length, 1); assert.equal(JSON.parse(stdout).version, "1.0.0");
		assert.equal(JSON.parse(stdout).ok, false); assert.ok(stderr.length > 0); assert.ok([2, 3].includes(exit));
	}
	let output = "";
	assert.equal(await runHostCli(["--help"], {}, { stdout: (text) => { output += text; }, stderr: () => assert.fail("Unexpected help diagnostic") }), 0);
	assert.ok(output.includes("conversation open <conversation-id>"));
});

test("packaged CLI uses the private dispatcher and returns distinct read, unavailable, forbidden and upgrade results", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pi-host-cli-"));
	const status = { hostId: "host", relayState: "ready", capabilities: ["host-control-v1"], accountState: "unavailable" };
	const dispatcher = new HostDispatcher({ hostId: "host", protectedConversationId: cid,
		policy: new HostPolicy(JSON.parse(readFileSync("config/agent/managed-host-policy.json", "utf8"))), read: async () => status });
	const server = new HostControlServer({ runtimeDirectory: directory, expectedUid: process.getuid!(), peerUid: () => process.getuid!(), dispatcher });
	t.after(async () => { await server.close(); await rm(directory, { recursive: true, force: true }); });
	await server.start();
	const packaged = process.env.PI_MANAGED_SESSIONS_TEST_HOST_CLI;
	const call = (args: string[]) => new Promise<{ code: number; stdout: string; stderr: string }>((done) => {
		execFile(packaged ?? process.execPath, [...(packaged ? [] : [resolve(__dirname, "../config/agent/extensions/managed-sessions/relay/host-cli.js")]), ...args],
			{ env: { ...process.env, PI_MANAGED_SESSIONS_RUNTIME_DIR: directory }, timeout: 5_000, maxBuffer: 128 * 1024 },
			(error, stdout, stderr) => done({ code: error ? Number(error.code) : 0, stdout, stderr }));
	});
	const read = await call(["host", "status", "--json"]);
	assert.equal(read.code, 0); assert.equal(read.stderr, ""); assert.deepEqual(JSON.parse(read.stdout).data, status);
	const forbidden = await call(["conversation", "stop", cid, "--json"]);
	assert.equal(forbidden.code, 5); assert.equal(JSON.parse(forbidden.stdout).error.code, "forbidden");
	const upgrade = await call(["conversation", "open", cid, "--json"]);
	assert.equal(upgrade.code, 7); assert.equal(JSON.parse(upgrade.stdout).error.code, "upgrade_required");
	await server.close();
	const unavailable = await call(["host", "status", "--json"]);
	assert.equal(unavailable.code, 3); assert.equal(JSON.parse(unavailable.stdout).error.code, "unavailable");
});
