import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const cases = [
	{ name: "owner read", mode: 0o400, accepted: true },
	{ name: "owner read/write", mode: 0o600, accepted: true },
	{ name: "systemd group read", mode: 0o440, accepted: true },
	{ name: "owner write and group read", mode: 0o640, accepted: true },
	{ name: "foreign group read", mode: 0o440, accepted: false, foreignGroup: true },
	{ name: "systemd root-owned root-group read-only", mode: 0o440, accepted: true, metadata: { uid: 0, gid: 0 } },
	{ name: "root-group but non-root owner", mode: 0o440, accepted: false, metadata: { uid: 64806, gid: 0 } },
	{ name: "root owner but foreign non-root group", mode: 0o440, accepted: false, metadata: { uid: 0, gid: 958 } },
	{ name: "root-owned root-group owner-writable", mode: 0o640, accepted: false, metadata: { uid: 0, gid: 0 } },
	{ name: "root-owned root-group group-writable", mode: 0o460, accepted: false, metadata: { uid: 0, gid: 0 } },
	{ name: "root-owned root-group world-readable", mode: 0o444, accepted: false, metadata: { uid: 0, gid: 0 } },
	{ name: "root-owned root-group setuid", mode: 0o440, accepted: false, metadata: { uid: 0, gid: 0, mode: 0o104440 } },
	{ name: "root-owned root-group setgid", mode: 0o440, accepted: false, metadata: { uid: 0, gid: 0, mode: 0o102440 } },
	{ name: "root-owned root-group sticky", mode: 0o440, accepted: false, metadata: { uid: 0, gid: 0, mode: 0o101440 } },
	{ name: "group write", mode: 0o460, accepted: false },
	{ name: "group execute", mode: 0o450, accepted: false },
	{ name: "world read", mode: 0o444, accepted: false },
	{ name: "world write", mode: 0o402, accepted: false },
	{ name: "world execute", mode: 0o401, accepted: false },
	{ name: "oversized", mode: 0o440, accepted: false, oversized: true },
	{ name: "symlink", mode: 0o440, accepted: false, symlink: true },
	{ name: "directory", mode: 0o700, accepted: false, directory: true },
];
for (const scenario of cases) test(`credential entrypoint: ${scenario.name}`, t => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-chat-credential-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const secret = "private-credential-sentinel";
	const tokenPath = path.join(dir, "matrix"), config = path.join(dir, "config.json"), preload = path.join(dir, "preload.cjs");
	fs.writeFileSync(config, JSON.stringify({ homeserver: "https://matrix.example.com", ownerUserId: "@owner:example.com",
		remoteOwnerUserIds: [], roomIds: ["!one:example.com"], allJoinedRooms: false, modelSocket: "/unused" }));
	if (scenario.directory) fs.mkdirSync(tokenPath);
	else {
		const target = scenario.symlink ? path.join(dir, "target") : tokenPath;
		fs.writeFileSync(target, scenario.oversized ? "x".repeat(4098) : secret);
		fs.chmodSync(target, scenario.mode);
		if (scenario.symlink) fs.symlinkSync(target, tokenPath);
	}
	// Stop at the first network boundary: these tests must never contact Matrix.
	fs.writeFileSync(preload, `global.fetch = async () => { process.exit(0); };
		${scenario.foreignGroup ? `process.getegid = () => require('node:fs').statSync(${JSON.stringify(tokenPath)}).gid + 1;` : ""}
		${scenario.metadata ? `
			// Model the metadata observed inside systemd without requiring root/chown.
			const fs = require('node:fs'), original = fs.fstatSync;
			fs.fstatSync = (...args) => Object.assign(original(...args), ${JSON.stringify(scenario.metadata)});
			process.getegid = () => 957;
			process.geteuid = () => 64806;
		` : ""}`);
	const result = spawnSync(process.execPath, ["--require", preload, require.resolve("../config/agent/extensions/bridge-chat/main.js"), config], {
		encoding: "utf8", timeout: 5000,
		env: { ...process.env, NODE_OPTIONS: "", CREDENTIALS_DIRECTORY: dir, STATE_DIRECTORY: dir },
	});
	assert.equal(result.error, undefined);
	assert.equal(result.status, scenario.accepted ? 0 : 1, result.stderr);
	assert.ok(!(result.stdout + result.stderr).includes(secret));
	const stages = result.stdout.trim().split("\n").map(line => JSON.parse(line));
	assert.equal(stages.at(-1).stage, scenario.accepted ? "identity_request" : "credential_read");
	if (!scenario.accepted) assert.equal(JSON.parse(result.stderr.trim()).stage, "credential_read");
});
