/** One-shot offline filesystem boundary. Never imported by the daemon/adapter. */
import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import lock from "./session-lock.cjs";
import { object, string } from "./wire.js";

export type Root = { role: "state" | "manifests" | "native" | "account"; name: string; original: string };
export type Source = { version: 1; hostId: string; botUserId: string; operatorUserId: string; quiescence: string; roots: Root[]; unavailable: string[]; currentFiles: Record<string, string>; groupings: Record<string, { project: string; checkout: string }> };
export type File = { path: string; size: number; sha256: string };
export type Inventory = { version: 1; source: Source; directories: string[]; files: File[]; digest: string };
export type Snapshot = { root: string; inventory: Inventory; file(path: string): Buffer; json(path: string): Record<string, unknown>; original(path: string): string };
export type Boundary = (name: string) => void;
export const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
export const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const inside = (parent: string, child: string) => child === parent || child.startsWith(`${parent}/`);
function absolute(value: unknown): string {
  const path = string(value, 4096);
  if (!isAbsolute(path) || path !== resolve(path) || /[\x00-\x1f\x7f]/.test(path)) throw Error("Migration paths must be normalized absolute paths");
  return path;
}
function source(value: unknown): Source {
  const row = object(value);
  if (row.version !== 1 || !Array.isArray(row.roots) || row.roots.length < 3 || row.roots.length > 32 || !Array.isArray(row.unavailable) || row.unavailable.length > 32) throw Error("Unsupported offline source descriptor");
  const roots: Root[] = row.roots.map(value => {
    const item = object(value), role = string(item.role), name = string(item.name, 64);
    if (!["state", "manifests", "native", "account"].includes(role) || !/^[a-z][a-z0-9-]*$/.test(name)) throw Error("Invalid source root");
    return { role: role as Root["role"], name, original: absolute(item.original) };
  });
  for (const role of ["state", "manifests"]) if (roots.filter(root => root.role === role).length !== 1) throw Error(`Exactly one ${role} root is required`);
  if (!roots.some(root => root.role === "native") || new Set(roots.map(root => root.name)).size !== roots.length) throw Error("Native roots must be explicit and names unique");
  const hostId = string(row.hostId, 128), botUserId = string(row.botUserId, 255), operatorUserId = string(row.operatorUserId, 255);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(hostId) || !/^@[^\s:]+:[^\s]+$/.test(botUserId) || !/^@[^\s:]+:[^\s]+$/.test(operatorUserId) || botUserId === operatorUserId) throw Error("Invalid source account identity");
  const groupings = Object.fromEntries(Object.entries(object(row.groupings ?? {})).map(([key, value]) => {
    if (!/^conv_[a-f0-9]{32}$/.test(key)) throw Error("Invalid grouping conversation");
    const item = object(value); return [key, { project: absolute(item.project), checkout: absolute(item.checkout) }];
  }));
  const currentFiles = Object.fromEntries(Object.entries(object(row.currentFiles ?? {})).map(([nativeId, value]) => [string(nativeId, 128), absolute(value)]));
  return { version: 1, hostId, botUserId, operatorUserId, quiescence: string(row.quiescence, 2000), roots, groupings, currentFiles, unavailable: row.unavailable.map(value => string(value, 300)) };
}
/** Linux VFS mount flags, not chmod/access(). A read-only bind of the ORIGINAL
 * store is still rejected separately. Privileged remounts are outside this tool. */
export function requireReadOnly(path: string): void {
  if (process.platform !== "linux") throw Error("Offline migration requires Linux read-only snapshot mounts");
  const real = realpathSync(path), mounts = readFileSync("/proc/self/mountinfo", "utf8").trim().split("\n").map(line => {
    const fields = line.split(" ");
    return { path: fields[4]!.replace(/\\([0-7]{3})/g, (_match, value: string) => String.fromCharCode(parseInt(value, 8))), ro: fields[5]!.split(",").includes("ro") };
  }).filter(mount => inside(mount.path === "/" ? "" : mount.path, real));
  const length = Math.max(...mounts.map(mount => mount.path.length));
  if (!mounts.length || mounts.filter(mount => mount.path.length === length).some(mount => !mount.ro)) throw Error("Writable/live migration source refused; use an independent coherent read-only snapshot");
}
function regular(path: string): void {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink()) throw Error("Snapshot contains a symlink or non-regular file");
}
function sameFile(a: string, b: string): boolean {
  if (!existsSync(b)) return false;
  const left = statSync(a, { bigint: true }), right = statSync(b, { bigint: true });
  return left.dev === right.dev && left.ino === right.ino;
}
export function inventory(root: string, enforceReadOnly = true): Inventory {
  root = absolute(root);
  if (realpathSync(root) !== root || !lstatSync(root).isDirectory()) throw Error("Snapshot root must be a canonical directory");
  if (enforceReadOnly) requireReadOnly(root);
  regular(join(root, "source.json"));
  if (enforceReadOnly) requireReadOnly(join(root, "source.json"));
  const spec = source(JSON.parse(readFileSync(join(root, "source.json"), "utf8")));
  const files: File[] = [], directories: string[] = [];
  const visit = (path: string): void => {
    const full = join(root, path), info = lstatSync(full);
    if (enforceReadOnly) requireReadOnly(full);
    if (info.isSymbolicLink() || !info.isDirectory() && !info.isFile()) throw Error("Snapshot contains a symlink or special file");
    const origin = spec.roots.find(item => path === item.name || path.startsWith(`${item.name}/`))!;
    if (sameFile(full, join(origin.original, path.slice(origin.name.length)))) throw Error("Live source file alias refused");
    if (info.isDirectory()) { directories.push(path); for (const name of readdirSync(full).sort()) visit(`${path}/${name}`); }
    else { const bytes = readFileSync(full); files.push({ path, size: bytes.length, sha256: sha256(bytes) }); }
  };
  for (const item of spec.roots) {
    const path = join(root, item.name);
    if (!lstatSync(path).isDirectory() || sameFile(path, item.original)) throw Error("Live source alias or missing snapshot root refused");
    visit(item.name);
  }
  directories.sort(); files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const originals = new Map<string, string>();
  for (const file of files) {
    const item = spec.roots.find(item => file.path.startsWith(`${item.name}/`))!;
    const original = join(item.original, file.path.slice(item.name.length + 1));
    if (originals.has(original) && originals.get(original) !== file.sha256) throw Error("Overlapping snapshot roots contain inconsistent original bytes");
    originals.set(original, file.sha256);
  }
  const data = { version: 1 as const, source: spec, directories, files };
  return { ...data, digest: sha256(canonical(data)) };
}
export function readSnapshot(root: string, bundle = false): Snapshot {
  root = resolve(root);
  const value = inventory(root);
  if (bundle) {
    regular(join(root, "inventory.json"));
    if (canonical(JSON.parse(readFileSync(join(root, "inventory.json"), "utf8"))) !== canonical(value)) throw Error("Frozen bundle inventory changed");
  }
  const known = new Map(value.files.map(file => [file.path, file]));
  const file = (path: string): Buffer => {
    const expected = known.get(path); if (!expected) throw Error(`Missing snapshot evidence: ${path}`);
    regular(join(root, path)); requireReadOnly(join(root, path));
    const bytes = readFileSync(join(root, path));
    if (bytes.length !== expected.size || sha256(bytes) !== expected.sha256) throw Error(`Snapshot evidence changed: ${path}`);
    return bytes;
  };
  return { root, inventory: value, file, json: path => object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(file(path)))), original: path => {
    const item = value.source.roots.find(item => path.startsWith(`${item.name}/`));
    if (!item || !known.has(path)) throw Error("Unknown snapshot file mapping");
    return join(item.original, path.slice(item.name.length + 1));
  } };
}
export function sync(path: string): void { const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); try { fsyncSync(fd); } finally { closeSync(fd); } }
export function durable(path: string, bytes: Buffer | string): void { writeFileSync(path, bytes, { flag: "wx", mode: 0o600 }); sync(path); }
export function destination(snapshot: Snapshot, target: string): string {
  target = absolute(target);
  const parent = dirname(target), info = lstatSync(parent);
  if (!info.isDirectory() || realpathSync(parent) !== parent || info.uid !== process.getuid!() || (info.mode & 0o022)) throw Error("Destination parent must be canonical, user-owned and not writable by others");
  if (inside(snapshot.root, target) || snapshot.inventory.source.roots.some(root => inside(root.original, target))) throw Error("Destination must differ from every old store and snapshot");
  return target;
}
export function stage(target: string): string { return mkdtempSync(join(dirname(target), `.${basename(target)}-partial-`)); }
export function publish(staging: string, target: string, fault: Boundary = () => {}): void {
  sync(staging); fault("before-publish"); lock.renameNoReplace(staging, target); fault("after-publish"); sync(dirname(target));
}
export function exportSnapshot(root: string, target: string, fault: Boundary = () => {}): Inventory {
  const snapshot = readSnapshot(root); target = destination(snapshot, target);
  if (existsSync(target)) {
    if (inventory(target, false).digest !== snapshot.inventory.digest || canonical(JSON.parse(readFileSync(join(target, "inventory.json"), "utf8"))) !== canonical(snapshot.inventory)) throw Error("Different or incomplete export destination; nothing overwritten");
    return snapshot.inventory;
  }
  const staging = stage(target);
  durable(join(staging, "source.json"), canonical(snapshot.inventory.source));
  for (const path of snapshot.inventory.directories) mkdirSync(join(staging, path), { mode: 0o700 });
  for (const file of snapshot.inventory.files) {
    // Re-read through the frozen inventory before copying; source remains read-only.
    durable(join(staging, file.path), snapshot.file(file.path)); fault("export-file");
  }
  for (const path of [...snapshot.inventory.directories].reverse()) sync(join(staging, path));
  fault("export-before-marker"); durable(join(staging, "inventory.json"), canonical(snapshot.inventory));
  publish(staging, target, fault); return snapshot.inventory;
}
