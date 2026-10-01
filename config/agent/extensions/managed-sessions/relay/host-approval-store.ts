import { constants } from "node:fs";
import { open, readdir, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { AtomicJsonFile, ensurePrivateDirectory } from "./atomic-json.js";
import { parseHostApprovalRecord, transitionHostApproval, type HostApprovalRecord } from "./host-approval-record.js";

const MAX_FILE_BYTES = 256 * 1024;
const MAX_STORE_BYTES = 32 * 1024 * 1024;
const idPattern = /^approval_[a-f0-9]{32}$/;
function storedBytes(record: HostApprovalRecord): number { return Buffer.byteLength(`${JSON.stringify(record, null, 2)}\n`, "utf8"); }

async function readPrivateRecord(path: string): Promise<{ record: HostApprovalRecord; bytes: number }> {
	const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const info = await file.stat();
		if (!info.isFile() || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid()) || info.size > MAX_FILE_BYTES)
			throw Error("Approval record must be a bounded private relay-user file");
		const buffer = Buffer.alloc(MAX_FILE_BYTES + 1); let length = 0;
		while (length < buffer.length) {
			const chunk = await file.read(buffer, length, buffer.length - length, length);
			if (!chunk.bytesRead) break;
			length += chunk.bytesRead;
		}
		if (length > MAX_FILE_BYTES) throw Error("Approval record file exceeds bounds");
		return { record: parseHostApprovalRecord(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length)))), bytes: length };
	} finally { await file.close(); }
}

/** Caller holds the relay ownership lock through close. Serializes only durable writes, never approval waits. */
export class HostApprovalStore {
	private readonly directory: string;
	private records = new Map<string, HostApprovalRecord>();
	private sizes = new Map<string, number>();
	private loading?: Promise<void>;
	private bytes = 0;
	private loaded = false;
	private closed = false;
	private poisoned = false;
	private tail: Promise<void> = Promise.resolve();
	constructor(directory: string, private readonly hostId: string, private readonly capacity = 1024) {
		this.directory = resolve(directory);
		if (!hostId || hostId.length > 128 || !Number.isInteger(capacity) || capacity < 1 || capacity > 4096) throw Error("Invalid approval store configuration");
	}

	load(): Promise<void> {
		if (this.closed) return Promise.reject(Error("Approval store is closed"));
		return this.loading ??= this.loadOnce();
	}
	private async loadOnce(): Promise<void> {
		await ensurePrivateDirectory(this.directory);
		const names = await readdir(this.directory);
		if (names.length > 8192) throw Error("Approval directory capacity exceeded");
		const records = new Map<string, HostApprovalRecord>(); const sizes = new Map<string, number>(); let bytes = 0;
		for (const name of names) {
			// Interrupted atomic writes are never a fallback source of authority.
			if (/^approval_[a-f0-9]{32}\.json\.[0-9]+\.[a-f0-9-]{36}\.tmp$/.test(name)) continue;
			if (!/^approval_[a-f0-9]{32}\.json$/.test(name)) throw Error("Unexpected approval store entry");
			const { record, bytes: size } = await readPrivateRecord(join(this.directory, name));
			if (record.hostId !== this.hostId || name !== `${record.approvalId}.json`) throw Error("Approval store identity mismatch");
			records.set(record.approvalId, record); sizes.set(record.approvalId, size); bytes += size;
			if (records.size > this.capacity || bytes > MAX_STORE_BYTES) throw Error("Approval store capacity exceeded");
		}
		if (this.closed) throw Error("Approval store closed while loading");
		this.records = records; this.sizes = sizes; this.bytes = bytes; this.loaded = true;
	}

	get(approvalId: string): HostApprovalRecord | undefined {
		if (this.closed) throw Error("Approval store is closed");
		this.assertReady(); if (!idPattern.test(approvalId)) throw Error("Invalid approval identity");
		const record = this.records.get(approvalId); return record && structuredClone(record);
	}
	list(): HostApprovalRecord[] { if (this.closed) throw Error("Approval store is closed"); this.assertReady(); return structuredClone([...this.records.values()]); }

	prepare(value: HostApprovalRecord): Promise<HostApprovalRecord> {
		const record = parseHostApprovalRecord(value);
		if (record.hostId !== this.hostId || record.phase !== "prepared") return Promise.reject(Error("Approval preparation identity or phase is invalid"));
		return this.write(async () => {
			const previous = this.records.get(record.approvalId);
			if (previous) {
				if (previous.payloadDigest !== record.payloadDigest) throw Error("Approval identity conflicts with its frozen payload");
				return structuredClone(previous);
			}
			return this.persist(record);
		});
	}
	transition(approvalId: string, patch: Parameters<typeof transitionHostApproval>[1]): Promise<HostApprovalRecord> {
		const detached = structuredClone(patch);
		return this.write(async () => {
			const previous = this.records.get(approvalId); if (!previous) throw Error("Approval record was not found");
			return this.persist(transitionHostApproval(previous, detached));
		});
	}
	/** Discard settled consent; an accepted record is never replay authorization on recovery. */
	discard(approvalId: string): Promise<void> {
		if (!idPattern.test(approvalId)) return Promise.reject(Error("Invalid approval identity"));
		return this.write(async () => {
			const record = this.records.get(approvalId); if (!record) return;
			if (!["denied", "expired", "cancelled", "accepted"].includes(record.phase)) throw Error("Pending approval must be settled before removal");
			try {
				await unlink(join(this.directory, `${approvalId}.json`)).catch((error: unknown) => {
					if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
				});
				const directory = await open(this.directory, "r");
				try { await directory.sync(); } finally { await directory.close(); }
			} catch (error) { this.poisoned = true; throw error; }
			this.bytes -= this.sizes.get(approvalId) ?? 0; this.sizes.delete(approvalId); this.records.delete(approvalId);
		});
	}
	async close(): Promise<void> { this.closed = true; await this.loading?.catch(() => undefined); await this.tail; }

	private assertReady(): void {
		if (!this.loaded || this.poisoned) throw Error("Approval store is unavailable; ownership-safe recovery is required");
	}
	private write<T>(work: () => Promise<T>): Promise<T> {
		if (this.closed) return Promise.reject(Error("Approval store is closed"));
		const next = this.tail.then(() => { this.assertReady(); return work(); });
		this.tail = next.then(() => undefined, () => undefined); return next;
	}
	private async persist(record: HostApprovalRecord): Promise<HostApprovalRecord> {
		const previous = this.records.get(record.approvalId); const size = storedBytes(record);
		const bytes = this.bytes - (this.sizes.get(record.approvalId) ?? 0) + size;
		if ((!previous && this.records.size >= this.capacity) || size > MAX_FILE_BYTES || bytes > MAX_STORE_BYTES) throw Error("Approval store capacity exceeded");
		try { await new AtomicJsonFile(join(this.directory, `${record.approvalId}.json`), parseHostApprovalRecord).write(record); }
		catch (error) { this.poisoned = true; throw error; } // Rename/fsync may have committed: do not continue from uncertain memory.
		this.records.set(record.approvalId, record); this.sizes.set(record.approvalId, size); this.bytes = bytes; return structuredClone(record);
	}
}
