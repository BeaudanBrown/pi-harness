import fs from "node:fs";
import path from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { inspectArtifactBytes } from "../managed-sessions/adapter/artifact-export.js";
import { fileRefs, MAX_FILE_BYTES, type FileRef } from "./file-types.js";

const TTL = 24 * 60 * 60 * 1000;
const MAX_STAGING_BYTES = 256 * 1024 * 1024;
/** Private, flat, opaque-name spool; never accept a model-selected filesystem path. */
export function sweepFiles(directory: string, now = Date.now(), reserveEntries = 0): number {
	let total = 0, count = 0;
	for (const name of fs.readdirSync(directory)) {
		if (!/^[a-f0-9]{32}$/.test(name) && !/^download-[A-Za-z0-9]+$/.test(name)) continue;
		const filename = path.join(directory, name), stat = fs.lstatSync(filename);
		if (now - stat.mtimeMs > TTL) {
			if (stat.isDirectory() && name.startsWith("download-")) fs.rmSync(filename, { recursive: true, force: true });
			else fs.unlinkSync(filename);
			continue;
		}
		if (++count + reserveEntries > 64) throw Error("File staging is full; allow retention cleanup before downloading more files");
		if (stat.isFile()) total += stat.size;
	}
	return total;
}
export async function stageFile(directory: string, filename: string, data: Buffer): Promise<FileRef> {
	const descriptor = await inspectArtifactBytes(filename, data);
	if (sweepFiles(directory, Date.now(), 1) + data.length > MAX_STAGING_BYTES) throw Error("File staging byte limit reached");
	const id = randomBytes(16).toString("hex");
	const filenameOnDisk = path.join(directory, id), fd = fs.openSync(filenameOnDisk, "wx", 0o640);
	try { fs.fchmodSync(fd, 0o640); fs.writeFileSync(fd, data); }
	catch (error) { fs.unlinkSync(filenameOnDisk); throw error; }
	finally { fs.closeSync(fd); }
	return { id, ...descriptor };
}
export function readStagedFile(directory: string, value: FileRef): Buffer {
	const ref = fileRefs([value])[0]!;
	const fd = fs.openSync(path.join(directory, ref.id), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
	try {
		const before = fs.fstatSync(fd);
		if (!before.isFile() || before.nlink !== 1 || before.size !== ref.byteLength || before.size > MAX_FILE_BYTES) throw Error("Staged file unavailable");
		const data = Buffer.alloc(before.size); let offset = 0;
		while (offset < data.length) { const size = fs.readSync(fd, data, offset, data.length - offset, offset); if (!size) break; offset += size; }
		const after = fs.fstatSync(fd);
		if (offset !== data.length || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || createHash("sha256").update(data).digest("hex") !== ref.sha256) throw Error("Staged file changed");
		return data;
	} finally { fs.closeSync(fd); }
}
export function removeFiles(directory: string, values: FileRef[]): void {
	for (const value of values) { const ref = fileRefs([value])[0]!; try { fs.unlinkSync(path.join(directory, ref.id)); } catch { /* retention cleanup handles interrupted delivery */ } }
}
