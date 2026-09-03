import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { MAX_BLOBS, MAX_BLOB_BYTES, MAX_SPOOL_BYTES } from "../v2-contracts.js";
import { ensurePrivateDirectory } from "./atomic-json.js";

const BLOB_ID = /^blob_[a-f0-9]{32}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1_000;

export interface BlobSpoolLimits { maxBlobs: number; maxBlobBytes: number; maxTotalBytes: number }

export interface SpoolBlob {
	blobId: string;
	sha256: string;
	mimeType: string;
	byteLength: number;
	width: number;
	height: number;
	createdAt: string;
}

function parseBlob(value: unknown): SpoolBlob {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Malformed blob spool metadata");
	const record = value as Record<string, unknown>;
	if (Object.keys(record).sort().join(",") !== "blobId,byteLength,createdAt,height,mimeType,sha256,width" ||
		typeof record.blobId !== "string" || !BLOB_ID.test(record.blobId) || typeof record.sha256 !== "string" || !DIGEST.test(record.sha256) ||
		typeof record.mimeType !== "string" || !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(record.mimeType) || record.mimeType.length > 127 || !Number.isSafeInteger(record.byteLength) || Number(record.byteLength) < 1 || Number(record.byteLength) > MAX_BLOB_BYTES ||
		!Number.isSafeInteger(record.width) || Number(record.width) < 1 || Number(record.width) > 16_384 ||
		!Number.isSafeInteger(record.height) || Number(record.height) < 1 || Number(record.height) > 16_384 || Number(record.width) * Number(record.height) > 40_000_000 ||
		typeof record.createdAt !== "string" || !Number.isFinite(Date.parse(record.createdAt))) throw new Error("Malformed blob spool metadata");
	return record as unknown as SpoolBlob;
}

async function syncDirectory(path: string): Promise<void> {
	const directory = await open(path, "r");
	try { await directory.sync(); } finally { await directory.close(); }
}

async function atomicWrite(path: string, bytes: Buffer): Promise<void> {
	const directory = dirname(path);
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	const file = await open(temporary, "wx", 0o600);
	try { await file.writeFile(bytes); await file.sync(); } catch (error) { await file.close(); await rm(temporary, { force: true }); throw error; }
	await file.close();
	try { await rename(temporary, path); await chmod(path, 0o600); await syncDirectory(directory); }
	catch (error) { await rm(temporary, { force: true }); throw error; }
}

export class BlobSpool {
	readonly root: string;
	readonly #metadataDirectory: string;
	readonly #dataDirectory: string;
	readonly #limits: BlobSpoolLimits;

	constructor(root: string, limits: Partial<BlobSpoolLimits> = {}) {
		this.root = resolve(root);
		this.#metadataDirectory = join(this.root, "metadata");
		this.#dataDirectory = join(this.root, "data");
		this.#limits = { maxBlobs: limits.maxBlobs ?? MAX_BLOBS, maxBlobBytes: limits.maxBlobBytes ?? MAX_BLOB_BYTES, maxTotalBytes: limits.maxTotalBytes ?? MAX_SPOOL_BYTES };
		if (!Number.isSafeInteger(this.#limits.maxBlobs) || this.#limits.maxBlobs < 1 || this.#limits.maxBlobs > MAX_BLOBS ||
			!Number.isSafeInteger(this.#limits.maxBlobBytes) || this.#limits.maxBlobBytes < 1 || this.#limits.maxBlobBytes > MAX_BLOB_BYTES ||
			!Number.isSafeInteger(this.#limits.maxTotalBytes) || this.#limits.maxTotalBytes < this.#limits.maxBlobBytes || this.#limits.maxTotalBytes > MAX_SPOOL_BYTES) {
			throw new Error("Blob spool limits are invalid");
		}
	}

	async initialize(liveBlobIds: ReadonlySet<string>, now = Date.now()): Promise<void> {
		await ensurePrivateDirectory(this.root);
		await ensurePrivateDirectory(this.#metadataDirectory);
		await ensurePrivateDirectory(this.#dataDirectory);
		for (const directory of [this.root, this.#metadataDirectory, this.#dataDirectory]) {
			for (const name of await readdir(directory)) if (name.endsWith(".tmp")) await rm(join(directory, name), { force: true });
		}
		await this.cleanup(liveBlobIds, now, 0);
	}

	async commit(blob: Omit<SpoolBlob, "createdAt">, bytes: Buffer, now = Date.now()): Promise<SpoolBlob> {
		if (!BLOB_ID.test(blob.blobId) || !DIGEST.test(blob.sha256) || bytes.length !== blob.byteLength || bytes.length < 1 || bytes.length > this.#limits.maxBlobBytes ||
			createHash("sha256").update(bytes).digest("hex") !== blob.sha256) throw new Error("Blob commit failed digest or size validation");
		await ensurePrivateDirectory(this.root);
		await ensurePrivateDirectory(this.#metadataDirectory);
		await ensurePrivateDirectory(this.#dataDirectory);
		const existing = await this.metadata(blob.blobId);
		const committed = parseBlob({ ...blob, createdAt: existing?.createdAt ?? new Date(now).toISOString() });
		if (existing) {
			if (JSON.stringify(existing) !== JSON.stringify(committed)) throw new Error("Conflicting blob identity");
			await this.read(existing);
			return existing;
		}
		const metadata = await this.list();
		const uniqueData = new Map<string, number>();
		for (const item of metadata) uniqueData.set(item.sha256, item.byteLength);
		const additionalBytes = uniqueData.has(blob.sha256) ? 0 : bytes.length;
		if (metadata.length >= this.#limits.maxBlobs || [...uniqueData.values()].reduce((sum, size) => sum + size, 0) + additionalBytes > this.#limits.maxTotalBytes) throw new Error("Blob spool quota was reached");
		const dataPath = this.dataPath(blob.sha256);
		try {
			const info = await lstat(dataPath);
			if (!info.isFile() || info.isSymbolicLink() || info.size !== bytes.length || createHash("sha256").update(await readFile(dataPath)).digest("hex") !== blob.sha256) throw new Error("Blob spool data conflicts with its digest path");
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
			await atomicWrite(dataPath, bytes);
		}
		await atomicWrite(this.metadataPath(blob.blobId), Buffer.from(`${JSON.stringify(committed)}\n`, "utf8"));
		return committed;
	}

	async read(blob: Omit<SpoolBlob, "createdAt"> | SpoolBlob): Promise<Buffer> {
		const persisted = await this.metadata(blob.blobId);
		if (!persisted || persisted.sha256 !== blob.sha256 || persisted.mimeType !== blob.mimeType || persisted.byteLength !== blob.byteLength ||
			persisted.width !== blob.width || persisted.height !== blob.height || ("createdAt" in blob && persisted.createdAt !== blob.createdAt)) {
			throw new Error("Blob spool metadata is unavailable or conflicting");
		}
		const path = this.dataPath(blob.sha256); const info = await lstat(path);
		if (!info.isFile() || info.isSymbolicLink() || info.size !== blob.byteLength) throw new Error("Blob spool data is malformed");
		const bytes = await readFile(path);
		if (createHash("sha256").update(bytes).digest("hex") !== blob.sha256) throw new Error("Blob spool digest verification failed");
		return bytes;
	}

	async remove(blobId: string, liveBlobIds: ReadonlySet<string>): Promise<void> {
		if (liveBlobIds.has(blobId)) throw new Error("Refusing to remove a live recovery blob");
		const blob = await this.metadata(blobId);
		if (!blob) return;
		await rm(this.metadataPath(blobId), { force: true });
		await syncDirectory(this.#metadataDirectory);
		if (!(await this.list()).some((candidate) => candidate.sha256 === blob.sha256)) {
			await rm(this.dataPath(blob.sha256), { force: true });
			await syncDirectory(this.#dataDirectory);
		}
	}

	async cleanup(liveBlobIds: ReadonlySet<string>, now = Date.now(), retentionMs = DEFAULT_RETENTION_MS): Promise<void> {
		const metadata = await this.list();
		for (const blob of metadata) if (!liveBlobIds.has(blob.blobId) && now - Date.parse(blob.createdAt) >= retentionMs) await this.remove(blob.blobId, liveBlobIds);
		const retainedDigests = new Set((await this.list()).map((blob) => blob.sha256));
		for (const name of await readdir(this.#dataDirectory)) {
			if (DIGEST.test(name.replace(/\.blob$/, "")) && name.endsWith(".blob") && !retainedDigests.has(name.slice(0, -5))) await rm(join(this.#dataDirectory, name), { force: true });
		}
	}

	async list(): Promise<SpoolBlob[]> {
		const result: SpoolBlob[] = [];
		for (const name of await readdir(this.#metadataDirectory)) {
			if (!name.endsWith(".json")) continue;
			const info = await lstat(join(this.#metadataDirectory, name));
			if (!info.isFile() || info.isSymbolicLink() || info.size > 2_048) throw new Error("Malformed blob spool metadata file");
			let value: unknown; try { value = JSON.parse(await readFile(join(this.#metadataDirectory, name), "utf8")); } catch { throw new Error("Malformed blob spool metadata file"); }
			const blob = parseBlob(value);
			if (`${blob.blobId}.json` !== name || result.some((candidate) => candidate.blobId === blob.blobId)) throw new Error("Conflicting blob spool metadata identity");
			result.push(blob);
		}
		return result;
	}

	private async metadata(blobId: string): Promise<SpoolBlob | undefined> {
		if (!BLOB_ID.test(blobId)) throw new Error("Malformed blob identity");
		try { return parseBlob(JSON.parse(await readFile(this.metadataPath(blobId), "utf8"))); }
		catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined; throw error; }
	}
	private metadataPath(blobId: string): string { return join(this.#metadataDirectory, `${blobId}.json`); }
	private dataPath(digest: string): string { if (!DIGEST.test(digest)) throw new Error("Malformed blob digest"); return join(this.#dataDirectory, `${digest}.blob`); }
}
