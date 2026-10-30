import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { dirname } from "node:path";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { ConversationIdSchema, GenerationIdSchema, WorkspaceIdentitySchema } from "../identity-contracts.js";
import { MatrixRoomIdSchema } from "../../matrix-shared/room-id.js";
import { deriveConversationId } from "../contracts.js";
import { AtomicJsonFile, ensurePrivateDirectory } from "./atomic-json.js";

const text = Type.String({ minLength: 1, maxLength: 128, pattern: "^[^\\u0000-\\u001f\\u007f]+$" });
const digest = Type.String({ pattern: "^[a-f0-9]{64}$" });
export const ArchiveSourceSchema = Type.Object({
	conversationId: ConversationIdSchema, creationKey: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" }), generationId: GenerationIdSchema,
	roomId: MatrixRoomIdSchema, title: text, placement: WorkspaceIdentitySchema,
	projectKey: Type.String({ pattern: "^project_[a-f0-9]{32}$" }), projectTitle: text, checkoutTitle: text,
	projectSpace: Type.Optional(MatrixRoomIdSchema), checkoutSpace: Type.Optional(MatrixRoomIdSchema),
	checkoutId: Type.Optional(Type.String({ pattern: "^checkout_[a-f0-9]{32}$" })), manifestHash: digest,
}, { additionalProperties: false });
export type ArchiveSource = Static<typeof ArchiveSourceSchema>;
const recordSchema = Type.Object({
	version: Type.Literal(1), hostId: text, archiveId: Type.String({ pattern: "^archive_[a-f0-9]{32}$" }),
	admittedAt: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
	phase: Type.Literal("archiving"), source: ArchiveSourceSchema,
}, { additionalProperties: false });
export type ArchiveRecord = Static<typeof recordSchema>;
const storeSchema = Type.Object({ version: Type.Literal(1), hostId: text,
	records: Type.Array(recordSchema, { maxItems: 4096 }) }, { additionalProperties: false });
type State = Static<typeof storeSchema>;
const presenceSchema = Type.Object({ version: Type.Literal(1), hostId: text }, { additionalProperties: false });
const MAX_BYTES = 32 * 1024 * 1024;
export function archiveId(hostId: string, conversationId: string): string {
	const hash = createHash("sha256").update("pi-managed-sessions:archive:live-v1\0");
	for (const value of [hostId, conversationId]) hash.update(`${Buffer.byteLength(value)}:`).update(value);
	return `archive_${hash.digest("hex").slice(0, 32)}`;
}
function parse(value: unknown): State {
	if (!Check(storeSchema, value) || Buffer.byteLength(JSON.stringify(value)) > MAX_BYTES) throw Error("Invalid archive authority");
	const state = value as State; const conversations = new Set<string>(); const keys = new Set<string>();
	for (const record of state.records) {
		const source = record.source;
		if (record.hostId !== state.hostId || source.creationKey === "coordinator" ||
			source.conversationId !== deriveConversationId(state.hostId, source.creationKey) ||
			record.archiveId !== archiveId(state.hostId, source.conversationId) || conversations.has(source.conversationId) || keys.has(source.creationKey)) throw Error("Archive identity conflicts");
		conversations.add(source.conversationId); keys.add(source.creationKey);
	}
	return structuredClone(state);
}

/** Separate negative authority survives rollback/restoration of the runtime projection.
 * No remove/unarchive API. Matrix completion is owned by the archive workflow. */
export class ArchiveStore {
	private records = new Map<string, ArchiveRecord>();
	private keys = new Set<string>();
	private loaded = false;
	private loading?: Promise<void>;
	private poisoned = false;
	private work: Promise<void> = Promise.resolve();
	private readonly file: AtomicJsonFile<State>;
	constructor(path: string, readonly hostId: string) { this.file = new AtomicJsonFile(path, parse); }
	load(): Promise<void> {
		if (this.poisoned) return Promise.reject(Error("Archive authority is unavailable; create a fresh owner to reload"));
		return this.loading ??= this.loadOnce();
	}
	private async loadOnce(): Promise<void> {
		await ensurePrivateDirectory(dirname(this.file.path));
		// This marker is outside registry.json: restoring an old runtime snapshot
		// must not turn a missing archive authority into an empty new store.
		const presencePath = `${this.file.path}.initialized`;
		let initialized = false; let presence;
		try { presence = await open(presencePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		if (presence) try {
			const info = await presence.stat();
			if (!info.isFile() || info.size > 1024 || (info.mode & 0o077) !== 0 || process.getuid && info.uid !== process.getuid()) throw Error("Invalid archive presence marker");
			const bytes = Buffer.alloc(info.size + 1); let size = 0;
			while (size < bytes.length) { const read = await presence.read(bytes, size, bytes.length - size, null); if (!read.bytesRead) break; size += read.bytesRead; }
			if (size !== info.size) throw Error("Archive presence marker changed");
			const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size)));
			if (!Check(presenceSchema, value) || value.hostId !== this.hostId) throw Error("Archive presence identity changed");
			initialized = true;
		} finally { await presence.close(); }
		let state: State = { version: 1, hostId: this.hostId, records: [] };
		let file;
		try { file = await open(this.file.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		if (!file && initialized) throw Error("Initialized archive authority is missing; restore the complete backup");
		if (file) try {
			const info = await file.stat();
			if (!info.isFile() || info.size > MAX_BYTES || (info.mode & 0o077) !== 0 || process.getuid && info.uid !== process.getuid()) throw Error("Archive authority is not private bounded state");
			const bytes = Buffer.alloc(info.size + 1); let size = 0;
			while (size < bytes.length) { const read = await file.read(bytes, size, bytes.length - size, null); if (!read.bytesRead) break; size += read.bytesRead; }
			if (size !== info.size) throw Error("Archive authority changed while reading");
			state = parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size))));
		} finally { await file.close(); }
		if (state.hostId !== this.hostId) throw Error("Archive authority belongs to another host");
		if (!initialized) {
			// Empty authority precedes its marker. Interruption here admits no archive;
			// an existing valid authority can safely acquire the missing marker.
			if (!file) await this.file.write(state);
			await new AtomicJsonFile(presencePath, value => {
				if (!Check(presenceSchema, value) || value.hostId !== this.hostId) throw Error("Invalid archive presence identity"); return value;
			}).write({ version: 1, hostId: this.hostId });
		}
		this.records = new Map(state.records.map(record => [record.source.conversationId, record]));
		this.keys = new Set(state.records.map(record => record.source.creationKey)); this.loaded = true;
	}
	assertAvailable(): void { if (!this.loaded || this.poisoned) throw Error("Archive authority is unavailable; fail closed until reload"); }
	has(id: string): boolean { this.assertAvailable(); return this.records.has(id); }
	hasCreationKey(key: string): boolean { this.assertAvailable(); return this.keys.has(key); }
	get(id: string): ArchiveRecord | undefined { this.assertAvailable(); const value = this.records.get(id); return value && structuredClone(value); }
	list(): ArchiveRecord[] { this.assertAvailable(); return [...this.records.values()].map(value => structuredClone(value)); }
	admit(record: ArchiveRecord): Promise<ArchiveRecord> {
		const frozen = structuredClone(record);
		const operation = this.work.then(async () => {
			this.assertAvailable(); const prior = this.records.get(frozen.source.conversationId);
			if (prior) {
				if (JSON.stringify(prior.source) !== JSON.stringify(frozen.source) || prior.archiveId !== frozen.archiveId || frozen.hostId !== this.hostId) throw Error("Archive admission identity changed");
				return structuredClone(prior);
			}
			const next = parse({ version: 1, hostId: this.hostId, records: [...this.records.values(), frozen] });
			if (Buffer.byteLength(`${JSON.stringify(next, null, 2)}\n`) > MAX_BYTES) throw Error("Archive capacity reached");
			try { await this.file.write(next); } catch (error) { this.poisoned = true; throw error; }
			this.records.set(frozen.source.conversationId, frozen); this.keys.add(frozen.source.creationKey);
			return structuredClone(frozen);
		});
		this.work = operation.then(() => undefined, () => undefined); return operation;
	}
}
