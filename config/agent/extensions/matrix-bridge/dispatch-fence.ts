import { lstatSync } from "node:fs";

type ReadOnlyDatabase = { prepare(sql: string): { get(key: string): Record<string, unknown> | null | undefined }; exec(sql: string): unknown; close(): void };
function openLedger(file: string): ReadOnlyDatabase {
  // The pinned executable is Bun; SDK/fixture consumers are Node. Both expose
  // native SQLite, but Bun does not implement node:sqlite in this package.
  if (process.versions.bun) {
    const { Database } = require("bun:sqlite") as { Database: new (file: string, options: { readonly: true; create: false }) => ReadOnlyDatabase };
    return new Database(file, { readonly: true, create: false });
  }
  const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
  return new DatabaseSync(file, { readOnly: true, timeout: 0 });
}

export type DispatchFence = { ledger: string; binding: string; file: string; nativeId: string };

/** Read only this native binding's committed dispatch policy at the consumption boundary.
 * No connection cache/snapshot, writes, credentials, queue repair or local launch admission.
 * A read before a concurrent commit authorizes existing in-flight work; a read after it
 * must observe the hold even if the asynchronous adapter notification is still in transit.
 */
export function dispatchAllowed(fence: DispatchFence | undefined, revision: number): boolean {
  if (!fence) return false;
  let db: ReadOnlyDatabase | undefined;
  try {
    const info = lstatSync(fence.ledger);
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid!() || (info.mode & 0o077)) return false;
    db = openLedger(fence.ledger); db.exec("PRAGMA busy_timeout=0");
    const row = db.prepare("SELECT value FROM bindings WHERE key=?").get(fence.binding);
    if (!row) return false;
    const value = JSON.parse(String(row.value)) as Record<string, unknown>;
    return value.file === fence.file && value.nativeId === fence.nativeId && value.enabled === true && value.archived === false && value.resumePending !== true && (value.archiveRevision ?? 0) === revision;
  } catch { return false; }
  finally { db?.close(); }
}
