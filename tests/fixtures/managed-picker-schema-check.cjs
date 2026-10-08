// Usage: node managed-picker-schema-check.cjs <harness-typescript-build> <go-test-log>
// The owning Go test emits public-schema-fixture records. No external checkout,
// live endpoint, private registry or network access is needed by this checker.
const fs = require("node:fs");
const path = require("node:path");
const { parseHostResponse } = require(path.join(
  process.argv[2], "build/config/agent/extensions/managed-sessions/live-workspace-contracts.js",
));
let count = 0;
for (const line of fs.readFileSync(process.argv[3], "utf8").split("\n")) {
  const marker = "public-schema-fixture:";
  const index = line.indexOf(marker);
  if (index < 0) continue;
  const fixture = JSON.parse(line.slice(index + marker.length));
  let valid = true;
  try { parseHostResponse(fixture.operation, fixture.response); } catch { valid = false; }
  if (valid !== fixture.valid) {
    console.error("Public parser disagreement:", line);
    process.exitCode = 1;
  }
  count++;
}
if (count < 40) throw Error("Missing conformance cases");
console.log(`${count} Go fixtures checked against production TypeBox schemas`);
