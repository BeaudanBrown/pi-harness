import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { transportFailure } from "../config/agent/extensions/bridge-chat/diagnostics.js";
import { MatrixError } from "../config/agent/extensions/matrix-shared/http.js";

const secret = "private-token-message-body-sentinel";
test("transport diagnostics allowlist metadata without serializing error contents", () => {
	for (const error of [secret, { code: secret }, Object.assign(new Error(secret), { code: secret, cause: new Error(secret) }), new SyntaxError(secret)]) {
		const output = transportFailure("configuration", error);
		assert.ok(!output.includes(secret));
		assert.equal(JSON.parse(output).stage, "configuration");
	}
	assert.deepEqual(JSON.parse(transportFailure("credential_read", Object.assign(new Error(secret), { code: "EACCES" }))),
		{ event: "transport_failed", stage: "credential_read", code: "EACCES" });
	assert.deepEqual(JSON.parse(transportFailure("identity_request", new MatrixError("http", secret, 401))),
		{ event: "transport_failed", stage: "identity_request", code: "http", httpStatus: 401 });
	assert.ok(!transportFailure("identity_request", new MatrixError("network", secret, 999)).includes("httpStatus"));
});

for (const scenario of ["configuration", "credential_read", "matrix_client", "identity_request", "identity_validation", "database_open", "policy_initialization", "running"] as const) {
	test(`actual transport entrypoint reports ${scenario} without exposing inputs`, t => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-chat-diagnostic-"));
		t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
		const config = path.join(dir, "config.json");
		fs.writeFileSync(config, scenario === "configuration" ? secret : JSON.stringify({
			homeserver: "https://matrix.example.com", ownerUserId: "@owner:example.com", remoteOwnerUserIds: [],
			roomIds: ["!one:example.com"], allJoinedRooms: false, modelSocket: "/unused",
		}));
		if (scenario !== "credential_read") fs.writeFileSync(path.join(dir, "matrix"), scenario === "matrix_client" ? secret + " invalid" : secret, { mode: 0o600 });
		const preload = path.join(dir, "fetch.cjs");
		fs.writeFileSync(preload, `global.fetch = async (url) => {
			if (String(url).includes('/sync?')) process.exit(0);
			return new Response(JSON.stringify({user_id: ${JSON.stringify(scenario === "identity_validation" ? secret : "@owner:example.com")}, device_id: 'device'}), {status: ${scenario === "identity_request" ? 401 : 200}});
		};`);
		if (scenario === "policy_initialization") {
			fs.appendFileSync(preload, `
				const { Store } = require(${JSON.stringify(require.resolve("../config/agent/extensions/bridge-chat/transport.js"))});
				Store.prototype.resetPolicy = () => { throw new Error(${JSON.stringify(secret)}); };
				const close = Store.prototype.close;
				Store.prototype.close = function () { close.call(this); require('node:fs').writeFileSync(${JSON.stringify(path.join(dir, "closed"))}, 'yes'); };
			`);
		}
		const result = spawnSync(process.execPath, ["--require", preload, require.resolve("../config/agent/extensions/bridge-chat/main.js"), config], {
			encoding: "utf8", timeout: 5000,
			env: { ...process.env, NODE_OPTIONS: "", CREDENTIALS_DIRECTORY: dir, STATE_DIRECTORY: scenario === "database_open" ? path.join(dir, "missing") : dir },
		});
		assert.equal(result.error, undefined);
		if (scenario === "policy_initialization") assert.equal(fs.readFileSync(path.join(dir, "closed"), "utf8"), "yes");
		assert.equal(result.status, scenario === "running" ? 0 : 1, result.stderr);
		assert.ok(!(result.stdout + result.stderr).includes(secret));
		assert.ok(!(result.stdout + result.stderr).includes(dir));
		const progress = result.stdout.trim().split("\n").map(line => JSON.parse(line));
		assert.equal(progress.at(-1).stage, scenario);
		if (scenario !== "running") {
			const failure = result.stderr.split("\n").find(line => line.startsWith('{"event":"transport_failed"'));
			assert.ok(failure, result.stderr);
			assert.equal(JSON.parse(failure).stage, scenario);
		} else {
			assert.ok(progress.some(entry => entry.stage === "policy_initialization"));
		}
	});
}
