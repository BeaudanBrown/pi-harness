import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { BridgeStore } from "./store.js";
import { IMAGE_CHUNK_BYTES } from "./wire.js";
import { convert, type Conversion } from "./migration-convert.js";
import { canonical, destination, durable, publish, readSnapshot, sha256, stage, sync, type Boundary, type Snapshot } from "./migration-files.js";

function privateFile(path: string): Buffer {
  const info = lstatSync(path);
  if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid!() || (info.mode & 0o077)) throw Error("Unsafe migration destination file");
  return readFileSync(path);
}
export function checkMigration(root: string, target: string): { source: string; destination: string; started: boolean; pristine: boolean; nativeUnchanged: boolean; rollback: string; report: Conversion["report"] } {
  const snapshot = readSnapshot(root, true); target = destination(snapshot, target);
  const directory = lstatSync(target);
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid!() || (directory.mode & 0o077)) throw Error("Unsafe destination directory");
  const receipt = JSON.parse(privateFile(join(target, "migration-receipt.json")).toString("utf8"));
  if (receipt.version !== 1 || receipt.source !== snapshot.inventory.digest) throw Error("Foreign or incomplete migration destination; nothing overwritten");
  const ledger = join(target, "bridge.sqlite"), bytes = privateFile(ledger);
  // SQLite can create/rebuild a shared-memory sidecar even with readOnly=true.
  // Do not make a live/crashed destination into an implicit checkpoint/repair.
  if (["-wal", "-shm", "-journal"].some(suffix => existsSync(`${ledger}${suffix}`))) throw Error("Destination has live/crash journal evidence; preserve it and obtain approved offline receipt reconciliation, not stale rollback");
  const uri = pathToFileURL(ledger); uri.searchParams.set("immutable", "1");
  // Even a clean WAL-mode header creates sidecars on ordinary readOnly opens.
  // With no journal evidence present, SQLite's immutable URI is truly read-only.
  const db = new DatabaseSync(uri.href, { readOnly: true, timeout: 0 });
  let started: boolean;
  try {
    const meta = (key: string) => db.prepare("SELECT value FROM meta WHERE key=?").get(key)?.value;
    if (meta("version") !== "4" || meta("host") !== snapshot.inventory.source.hostId || meta("migration") !== receipt.source || db.prepare("PRAGMA quick_check").get()?.quick_check !== "ok") throw Error("Migration ledger identity/integrity mismatch");
    started = meta("migration_started") === "true";
  } finally { db.close(); }
  const reportBytes = privateFile(join(target, "migration-report.json"));
  if (sha256(reportBytes) !== receipt.report) throw Error("Migration report changed");
  const report = JSON.parse(reportBytes.toString("utf8")) as Conversion["report"];
  const converted = convert(snapshot);
  if (canonical(converted.report) !== canonical(report)) throw Error("Conversion report differs from the frozen source");
  let nativeUnchanged = true;
  for (const root of snapshot.inventory.source.roots.filter(root => root.role === "native")) {
    const expected = new Set([...snapshot.inventory.directories, ...snapshot.inventory.files.map(file => file.path)].filter(path => path === root.name || path.startsWith(`${root.name}/`)));
    const visit = (path: string): void => {
      if (!expected.delete(path)) throw Error("New native-root evidence appeared after capture");
      const original = join(root.original, path.slice(root.name.length));
      const info = lstatSync(original);
      if (info.isSymbolicLink() || !info.isDirectory() && !info.isFile()) throw Error("Native-root evidence changed");
      if (info.isDirectory()) for (const name of readdirSync(original)) visit(`${path}/${name}`);
    };
    try { visit(root.name); if (expected.size) nativeUnchanged = false; } catch { nativeUnchanged = false; }
  }
  for (const file of snapshot.inventory.files.filter(file => snapshot.inventory.source.roots.some(root => root.role === "native" && file.path.startsWith(`${root.name}/`)))) {
    const original = snapshot.original(file.path);
    try {
      const info = lstatSync(original);
      if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid!() || realpathSync(original) !== original || sha256(readFileSync(original)) !== file.sha256) nativeUnchanged = false;
    } catch { nativeUnchanged = false; }
  }
  if (["-wal", "-shm", "-journal"].some(suffix => existsSync(`${ledger}${suffix}`)) || sha256(privateFile(ledger)) !== sha256(bytes)) throw Error("Destination changed during offline check; quiesce and preserve all receipt evidence");
  const pristine = sha256(bytes) === receipt.ledger;
  return { source: receipt.source, destination: target, started, pristine, nativeUnchanged, rollback: !started && pristine && nativeUnchanged ? "pre-start-only; separate approval required" : "receipt reconciliation or local-only continuation; never restore stale queues", report };
}
function writeLedger(snapshot: Snapshot, converted: Conversion, path: string, fault: Boundary): void {
  // Only a fresh unpublished directory ever enters the runtime schema constructor.
  const empty = new BridgeStore(path, snapshot.inventory.source.hostId); empty.close();
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; BEGIN IMMEDIATE");
    for (const binding of converted.bindings) db.prepare("INSERT INTO bindings VALUES (?,?,?,?)").run(binding.key, binding.file, binding.room ?? null, canonical(binding));
    for (const input of converted.inputs) db.prepare("INSERT INTO inputs(id,binding,position,event,prompt,state,interaction,held,archive_revision) VALUES (?,?,?,?,NULL,?,NULL,1,-1)").run(input.id, input.binding, input.position, canonical(input.event), input.state);
    for (const output of converted.outputs) db.prepare("INSERT INTO outputs VALUES (?,?,?,0,?,?,NULL)").run(output.id, output.binding, output.source, output.type, canonical(output.content));
    const image = db.prepare("INSERT INTO images VALUES (?,?,?,?)");
    for (const item of converted.images) {
      const bytes = snapshot.file(item.path);
      for (let offset = 0; offset < bytes.length; offset += IMAGE_CHUNK_BYTES) image.run(item.input, offset, bytes.length, bytes.subarray(offset, offset + IMAGE_CHUNK_BYTES));
    }
    const progress = db.prepare("INSERT INTO progress VALUES (?,?)");
    for (const [key, value] of Object.entries(converted.progress).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) progress.run(key, canonical(value));
    progress.run("migration-source", canonical(snapshot.inventory.digest));
    const meta = db.prepare("INSERT INTO meta VALUES (?,?)");
    meta.run("migration", snapshot.inventory.digest); meta.run("position", String(converted.inputs.length));
    if (converted.cursor) meta.run("cursor", converted.cursor);
    fault("import-before-commit"); db.exec("COMMIT"); fault("import-after-commit");
    if (db.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok" || db.prepare("PRAGMA foreign_key_check").all().length) throw Error("Imported ledger integrity check failed");
  } finally { db.close(); }
  sync(path);
}
export function importSnapshot(root: string, target: string, fault: Boundary = () => {}): ReturnType<typeof checkMigration> {
  const snapshot = readSnapshot(root, true); target = destination(snapshot, target);
  if (existsSync(target)) return checkMigration(root, target); // Read only, including after new work; NEVER restore old queues.
  const converted = convert(snapshot), staging = stage(target), ledger = join(staging, "bridge.sqlite");
  writeLedger(snapshot, converted, ledger, fault);
  const report = canonical(converted.report);
  durable(join(staging, "migration-report.json"), report);
  durable(join(staging, "migration-receipt.json"), canonical({ version: 1, source: snapshot.inventory.digest, ledger: sha256(readFileSync(ledger)), report: sha256(report) }));
  fault("import-receipt"); publish(staging, target, fault);
  return checkMigration(root, target);
}
