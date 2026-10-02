import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { ConversationIdSchema, GenerationIdSchema, MatrixUserIdSchema } from "../identity-contracts.js";
import { ExactWindowProofSchema, assertExactWindowBinding } from "../exact-window-contracts.js";
import { ManagedProvenanceSchema } from "../managed-provenance.js";
import { deriveConversationId } from "../contracts.js";
import { AtomicJsonFile, ensurePrivateDirectory } from "./atomic-json.js";

const text = (maxLength: number) => Type.String({ minLength: 1, maxLength });
const room = Type.String({ pattern: "^!\\S{1,254}$" });
const phase = Type.Enum(["pending", "blocked", "done"]);
const effectBase = { effectId: Type.String({ pattern: "^cleanup_[a-f0-9]{32}$" }), phase };
const window = Type.Object({ sessionName: text(128), windowId: text(64), paneId: text(64),
	serverId: Type.Optional(text(255)), ownership: Type.Optional(ExactWindowProofSchema) }, { additionalProperties: false });
export const RetirementEffectSchema = Type.Union([
	Type.Object({ ...effectBase, kind: Type.Literal("stop"), generationId: GenerationIdSchema, attachmentId: Type.Optional(text(128)), window: Type.Optional(window) }, { additionalProperties: false }),
	Type.Object({ ...effectBase, kind: Type.Enum(["operator_leave_forget", "bot_leave"]), roomId: room, userId: MatrixUserIdSchema }, { additionalProperties: false }),
	Type.Object({ ...effectBase, kind: Type.Literal("ancestor"), roomId: room, childRoomId: room,
		spaceKind: Type.Enum(["checkout_space", "project_space"]), creationKey: text(128), provenance: ManagedProvenanceSchema,
		operatorUserId: MatrixUserIdSchema, botUserId: MatrixUserIdSchema }, { additionalProperties: false }),
]);
const recordSchema = Type.Object({
	version: Type.Literal(1), hostId: text(128), conversationId: ConversationIdSchema, creationKey: text(128),
	retirementId: Type.String({ pattern: "^retirement_[a-f0-9]{32}$" }), retiredAt: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
	cleanup: Type.Optional(Type.Array(RetirementEffectSchema, { minItems: 1, maxItems: 5 })),
}, { additionalProperties: false });
export type RetirementEffect = Static<typeof RetirementEffectSchema>;
export type RetirementRecord = Static<typeof recordSchema>;
type Target<T> = T extends unknown ? Omit<T, "effectId" | "phase"> : never;
export type RetirementTarget = Target<RetirementEffect>;
function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
	return JSON.stringify(value);
}
function digest(domain: string, ...parts: string[]): string {
	const hash = createHash("sha256").update(`pi-managed-sessions:${domain}:live-v1\0`);
	for (const part of parts) hash.update(`${Buffer.byteLength(part)}:`).update(part);
	return hash.digest("hex").slice(0, 32);
}
export function retirementId(hostId: string, conversationId: string): string { return `retirement_${digest("retirement", hostId, conversationId)}`; }
export function retirementEffectId(id: string, target: RetirementTarget): string { return `cleanup_${digest("retirement-cleanup", id, canonical(target))}`; }
export function parseRetirementRecord(value: unknown): RetirementRecord {
	if (!Check(recordSchema, value) || Buffer.byteLength(JSON.stringify(value)) > 16384) throw Error("Invalid retirement record");
	const record = value as RetirementRecord;
	if (record.conversationId === deriveConversationId(record.hostId, "coordinator")) throw Error("Coordinator cannot be retired");
	if (record.retirementId !== retirementId(record.hostId, record.conversationId)) throw Error("Retirement identity changed");
	const kinds = new Set<string>();
	for (const effect of record.cleanup ?? []) {
		const { effectId, phase: _phase, ...target } = effect;
		if (effectId !== retirementEffectId(record.retirementId, target)) throw Error("Retirement cleanup identity changed");
		const key = effect.kind === "ancestor" ? `${effect.kind}:${effect.spaceKind}` : effect.kind;
		if (kinds.has(key) || effect.kind === "ancestor" && effect.roomId === effect.childRoomId) throw Error("Conflicting retirement cleanup targets");
		if (effect.kind === "ancestor" && (effect.provenance.hostId !== record.hostId || effect.provenance.creationKey !== effect.creationKey ||
			effect.provenance.kind !== (effect.spaceKind === "checkout_space" ? "worktree_space" : "project_space"))) throw Error("Retirement ancestor ownership changed");
		if (effect.kind === "stop" && effect.window) {
			assertExactWindowBinding(record.conversationId, effect.window);
			if (effect.window.ownership && effect.window.serverId && effect.window.serverId !== effect.window.ownership.serverId) throw Error("Retirement server ownership changed");
		}
		kinds.add(key);
	}
	const operator = record.cleanup?.find((effect) => effect.kind === "operator_leave_forget");
	const bot = record.cleanup?.find((effect) => effect.kind === "bot_leave");
	const checkout = record.cleanup?.find((effect) => effect.kind === "ancestor" && effect.spaceKind === "checkout_space");
	if (operator && bot && "roomId" in operator && "roomId" in bot && operator.roomId !== bot.roomId) throw Error("Retirement room identities conflict");
	for (const effect of record.cleanup ?? []) if (effect.kind === "ancestor") {
		if (effect.spaceKind === "checkout_space" && (!bot || !("roomId" in bot) || effect.childRoomId !== bot.roomId) ||
			effect.spaceKind === "project_space" && (!checkout || checkout.kind !== "ancestor" || effect.childRoomId !== checkout.roomId || !("parentRoomId" in checkout.provenance) || checkout.provenance.parentRoomId !== effect.roomId))
			throw Error("Retirement ancestor chain changed");
		if (!operator || !("userId" in operator) || !bot || !("userId" in bot) || effect.operatorUserId !== operator.userId || effect.botUserId !== bot.userId)
			throw Error("Retirement ancestor account identity changed");
	}
	return structuredClone(record);
}

/** Permanent negative authority plus bounded exact cleanup obligations. No removal or resurrection API. */
export class RetirementStore {
	private readonly records = new Map<string, RetirementRecord>();
	private readonly creationKeys = new Map<string, string>();
	private readonly sizes = new Map<string, number>();
	private totalBytes = 0;
	private pendingCount = 0;
	private work: Promise<void> = Promise.resolve();
	private loaded = false;
	private loading?: Promise<void>;
	private closing = false;
	private poisoned = false;
	readonly directory: string;
	constructor(directory: string, readonly hostId: string) { this.directory = resolve(directory); }
	load(): Promise<void> {
		if (this.closing) return Promise.reject(Error("Retirement store is closed"));
		if (!this.loading) this.loading = this.loadOnce();
		return this.loading;
	}
	private async loadOnce(): Promise<void> {
		await ensurePrivateDirectory(this.directory);
		const names = await readdir(this.directory);
		if (names.length > 100000) throw Error("Retirement directory exceeds safety bound");
		for (const name of names.sort()) {
			if (name.endsWith(".tmp")) continue; // Interrupted temporary writes are never authority.
			if (!/^conv_[a-f0-9]{32}\.json$/.test(name)) throw Error("Unexpected retirement entry");
			const file = await open(join(this.directory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
			try {
				const info = await file.stat();
				if (!info.isFile() || info.size > 16384 || (info.mode & 0o077) !== 0 || process.getuid?.() !== undefined && info.uid !== process.getuid!()) throw Error("Retirement file is not private bounded state");
				if (this.totalBytes + info.size > 128 * 1024 * 1024) throw Error("Retirement storage exceeds aggregate bound");
				const bytes = Buffer.alloc(16385); let size = 0;
				while (size < bytes.length) { const result = await file.read(bytes, size, bytes.length - size, null); if (!result.bytesRead) break; size += result.bytesRead; }
				if (size > 16384 || this.totalBytes + size > 128 * 1024 * 1024) throw Error("Retirement file exceeds bounds");
				const record = parseRetirementRecord(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size))));
				if (record.hostId !== this.hostId || name !== `${record.conversationId}.json` || this.creationKeys.has(record.creationKey)) throw Error("Retirement owner or creation identity conflicts");
				if (record.cleanup && ++this.pendingCount > 4096) throw Error("Pending retirement capacity exceeded");
				this.sizes.set(record.conversationId, size); this.totalBytes += size;
				this.records.set(record.conversationId, record); this.creationKeys.set(record.creationKey, record.conversationId);
			} finally { await file.close(); }
		}
		this.loaded = true;
	}
	assertAvailable(): void { this.assertReady(); }
	has(conversationId: string): boolean { this.assertReady(); return this.records.has(conversationId); }
	get(conversationId: string): RetirementRecord | undefined { this.assertReady(); const record = this.records.get(conversationId); return record ? structuredClone(record) : undefined; }
	hasCreationKey(key: string): boolean { this.assertReady(); return this.creationKeys.has(key); }
	pending(): RetirementRecord[] { this.assertReady(); return [...this.records.values()].filter((record) => record.cleanup).map((record) => structuredClone(record)); }
	retire(value: RetirementRecord): Promise<RetirementRecord> {
		return this.serialize(async () => {
			const record = parseRetirementRecord(value);
			if (record.hostId !== this.hostId) throw Error("Retirement belongs to another host");
			const saved = this.records.get(record.conversationId);
			if (saved) {
				if (saved.creationKey !== record.creationKey) throw Error("Retirement creation identity changed");
				return structuredClone(saved); // Never replace frozen cleanup with newer caller observations.
			}
			if (this.creationKeys.has(record.creationKey)) throw Error("Retired creation key cannot be reassigned");
			if (this.records.size >= 100000 || this.pendingCount >= 4096) throw Error("Retirement capacity reached");
			if (!record.cleanup || record.cleanup.some((effect) => effect.phase !== "pending")) throw Error("New retirement cleanup must be pending");
			await this.persist(record); return structuredClone(record);
		});
	}
	progress(conversationId: string, effectId: string, next: "blocked" | "done"): Promise<RetirementRecord> {
		return this.serialize(async () => {
			const saved = this.records.get(conversationId); if (!saved) throw Error("Retirement was not found");
			const record = structuredClone(saved); const effect = record.cleanup?.find((item) => item.effectId === effectId);
			if (!effect) throw Error("Retirement cleanup was not found");
			if (effect.phase === "done" && next !== "done") throw Error("Completed retirement cleanup cannot regress");
			effect.phase = next;
			if (record.cleanup!.every((item) => item.phase === "done")) delete record.cleanup;
			await this.persist(record); return structuredClone(record);
		});
	}
	async close(): Promise<void> { this.closing = true; await this.loading?.catch(() => undefined); await this.work; }
	private assertReady(): void { if (!this.loaded || this.poisoned) throw Error("Retirement authority is unavailable; fail closed until ownership-safe recovery"); }
	private serialize<T>(operation: () => Promise<T>): Promise<T> {
		if (this.closing) return Promise.reject(Error("Retirement store is closing"));
		const result = this.work.then(() => { this.assertReady(); return operation(); }); this.work = result.then(() => undefined, () => undefined); return result;
	}
	private async persist(record: RetirementRecord): Promise<void> {
		const size = Buffer.byteLength(`${JSON.stringify(record, null, 2)}\n`);
		const bytes = this.totalBytes - (this.sizes.get(record.conversationId) ?? 0) + size;
		if (size > 16384 || bytes > 128 * 1024 * 1024) throw Error("Retirement storage capacity reached");
		try { await new AtomicJsonFile(join(this.directory, `${record.conversationId}.json`), parseRetirementRecord).write(record); }
		catch (error) { this.poisoned = true; throw error; }
		this.pendingCount += Number(Boolean(record.cleanup)) - Number(Boolean(this.records.get(record.conversationId)?.cleanup));
		this.sizes.set(record.conversationId, size); this.totalBytes = bytes;
		this.records.set(record.conversationId, structuredClone(record)); this.creationKeys.set(record.creationKey, record.conversationId);
	}
}
