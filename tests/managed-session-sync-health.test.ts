import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

for (const state of ["starting", "blocked", "stale", "healthy", "future"] as const) {
	test(`host sync health reports ${state} without exposing cursor or conversation content`, async (t) => {
		const root = await mkdtemp(join(tmpdir(), "managed-sync-health-")); t.after(() => rm(root, { recursive: true, force: true }));
		const health = join(root, "health.json");
		await writeFile(health, JSON.stringify({ status: ["stale", "future"].includes(state) ? "healthy" : state,
			lastSuccessfulSyncAt: state === "starting" ? null : new Date(Date.now() + (state === "future" ? 300_000 : state === "stale" ? -300_000 : -1_000)).toISOString(),
			unexpectedPrivateField: "do-not-expose" }));
		const result = execFileSync(process.env.PI_HARNESS_JQ ?? "jq", ["--slurpfile", "health", health, "--argjson", "pending", "0",
			"-f", "scripts/managed-session-status.jq"], { encoding: "utf8", input: JSON.stringify({ conversations: [{ state: "dormant",
			matrixCursor: { status: "established", since: "do-not-expose" }, pendingInputs: [{ body: "do-not-expose" }] }] }) });
		assert.doesNotMatch(result, /do-not-expose/);
		const report = JSON.parse(result);
		assert.equal(report.service, "active"); assert.equal(report.cursorConfigured, true);
		assert.equal(report.sync.ready, state === "healthy");
	});
}
