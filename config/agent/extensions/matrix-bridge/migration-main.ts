import { resolve } from "node:path";
import { exportSnapshot, readSnapshot } from "./migration-files.js";
import { convert } from "./migration-convert.js";
import { checkMigration, importSnapshot } from "./migration.js";

try {
  const [operation, source, target, ...extra] = process.argv.slice(2);
  if (extra.length || !source || !["export", "import", "check", "inventory"].includes(operation ?? "") || (operation === "inventory" ? target !== undefined : !target)) throw Error("Usage: pi-bridge-migrate inventory SNAPSHOT | export SNAPSHOT NEW_BUNDLE | import READ_ONLY_BUNDLE NEW_STATE | check READ_ONLY_BUNDLE STATE");
  if (operation === "inventory") {
    const snapshot = readSnapshot(resolve(source)), report = convert(snapshot).report;
    console.log(JSON.stringify({ source: snapshot.inventory.digest, files: snapshot.inventory.files.length, bindings: report.bindings.length, findings: report.findings, affectedBindings: report.bindings.filter(row => row.findings.length || row.omittedFindings).length }));
  } else if (operation === "export") {
    const value = exportSnapshot(resolve(source), resolve(target!));
    console.log(JSON.stringify({ source: value.digest, files: value.files.length, destination: resolve(target!), next: "Mount the independent exported bundle read-only before import/check. No live authority was changed." }));
  } else {
    const value = operation === "import" ? importSnapshot(resolve(source), resolve(target!)) : checkMigration(resolve(source), resolve(target!));
    const { report, ...status } = value;
    console.log(JSON.stringify({ ...status, bindings: report.bindings.length, affectedBindings: report.bindings.filter(row => row.findings.length || row.omittedFindings).length, report: `${value.destination}/migration-report.json`, effects: "none; activation, membership and receipt reconciliation require separate approval" }));
  }
} catch (error) {
  console.error(`pi-bridge-migrate: ${error instanceof Error ? error.message : "offline migration failed"}`);
  process.exitCode = 1;
}
