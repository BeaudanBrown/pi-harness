import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("legacy exit observer: process birth, descendants, retained panes and read-only failure boundaries", () => {
	const result = spawnSync("python3", ["-B", "-m", "unittest", "discover", "-s", "tests", "-p", "test_managed_legacy_observe.py", "-v"], { encoding: "utf8", timeout: 15_000 });
	assert.equal(result.error, undefined);
	assert.equal(result.status, 0, result.stdout + result.stderr);
});
