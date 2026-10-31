import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { MatrixRoomIdSchema as room } from "../../matrix-shared/room-id.js";
import { MatrixUserIdSchema } from "../identity-contracts.js";
import { deriveConversationId } from "../contracts.js";
import { ManagedProvenanceSchema, parseManagedProvenance, safeManagedTitle, type ManagedProvenance } from "../managed-provenance.js";
import { ArchiveClosureReceiptSchema, type ArchiveClosure } from "./archive-runtime.js";
import { ArchiveSourceSchema, type ArchiveSource } from "./archive-store.js";
import { AtomicJsonFile, ensurePrivateDirectory } from "./atomic-json.js";
import type { RelayRegistry } from "./registry.js";
import type { ManagedMatrixClient } from "./matrix-client.js";
import type { LiveHierarchy } from "./live-hierarchy.js";
import { LiveSpaceCleanup, type SpaceCleanupAccount } from "./live-space-cleanup.js";

const id = Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" });
const projectId = Type.String({ pattern: "^project_[a-f0-9]{32}$" });
const checkoutId = Type.String({ pattern: "^checkout_[a-f0-9]{32}$" });
const savedRoom = Type.Object({ roomId: room, provenance: Type.Optional(ManagedProvenanceSchema) }, { additionalProperties: false });
const ownedRoom = Type.Object({ roomId: room, provenance: ManagedProvenanceSchema }, { additionalProperties: false });
const linkSchema = Type.Object({ projectKey: projectId, child: ownedRoom, parent: ownedRoom }, { additionalProperties: false });
const content = Type.Union([Type.Null(), Type.Record(Type.String(), Type.Unknown())]);
const targetSchema = Type.Object({ key: id, title: Type.String({ minLength: 1, maxLength: 256 }),
	kind: Type.Union([Type.Literal("archive_root_space"), Type.Literal("archive_project_space"), Type.Literal("archive_worktree_space")]),
	parentKey: Type.Optional(id), projectKey: Type.Optional(projectId), checkoutId: Type.Optional(checkoutId) }, { additionalProperties: false });
type Target = Static<typeof targetSchema>;
export const ArchivePlanSchema = Type.Object({ source: ArchiveSourceSchema, host: ownedRoom, conversation: savedRoom,
	operatorUserId: MatrixUserIdSchema, botUserId: MatrixUserIdSchema,
	parents: Type.Array(Type.Object({ ...savedRoom.properties, content }, { additionalProperties: false }), { maxItems: 2 }),
	targets: Type.Array(targetSchema, { minItems: 3, maxItems: 3 }), ancestors: Type.Array(linkSchema, { maxItems: 2 }) }, { additionalProperties: false });
export type ArchivePlan = Static<typeof ArchivePlanSchema>;
const nodeSchema = Type.Object({ target: targetSchema, parentRoomId: Type.Optional(room), roomId: Type.Optional(room),
	createAttempted: Type.Boolean(), linked: Type.Boolean() }, { additionalProperties: false });
const entrySchema = Type.Object({ plan: ArchivePlanSchema, closure: Type.Optional(ArchiveClosureReceiptSchema), lastInspection: Type.Optional(ArchiveClosureReceiptSchema), linked: Type.Boolean(), completed: Type.Boolean(),
	unlinkAttempted: Type.Array(room, { maxItems: 2, uniqueItems: true }), unlinked: Type.Array(room, { maxItems: 2, uniqueItems: true }),
	cleanup: Type.Array(Type.Union([Type.Literal("pending"), Type.Literal("preserved"), Type.Literal("done")]), { maxItems: 2 }) }, { additionalProperties: false });
const stateSchema = Type.Object({ version: Type.Literal(1), hostId: id, nodes: Type.Array(nodeSchema, { maxItems: 16384 }), entries: Type.Array(entrySchema, { maxItems: 4096 }) }, { additionalProperties: false });
type State = Static<typeof stateSchema>;
type Entry = Static<typeof entrySchema>;
type SavedRoom = Static<typeof savedRoom>;
const MAX_BYTES = 32 * 1024 * 1024;
/** No realpath, checkout lookup or directory access: legacy identity is saved placement only. */
export function historicalCheckoutId(hostId: string, source: ArchiveSource): string {
	return source.checkoutId ?? `checkout_${createHash("sha256").update(JSON.stringify(["archive-historical-checkout-v1", hostId, source.projectKey, source.placement.rootKey, source.placement.workspace])).digest("hex").slice(0, 32)}`;
}
function targets(hostId: string, source: ArchiveSource): Target[] {
	const checkout = historicalCheckoutId(hostId, source);
	return [
		{ key: "archive-root", title: "Archive", kind: "archive_root_space" },
		{ key: `archive-${source.projectKey}`, title: safeManagedTitle(source.projectTitle, source.projectKey, "project"), kind: "archive_project_space", parentKey: "archive-root", projectKey: source.projectKey },
		{ key: `archive-${checkout}`, title: safeManagedTitle(source.checkoutTitle, checkout, "worktree"), kind: "archive_worktree_space", parentKey: `archive-${source.projectKey}`, projectKey: source.projectKey, checkoutId: checkout },
	];
}
function identity(target: Target): Omit<Target, "title"> { const { title: _, ...value } = target; return value; }
function live(content: Record<string, unknown> | null): boolean { return Array.isArray(content?.via) && content.via.length > 0 && content.via.every(v => typeof v === "string" && v.length > 0 && v.length <= 255); }
function empty(content: Record<string, unknown> | null): boolean { return content === null || Object.keys(content).length === 0; }
function validatePlan(plan: ArchivePlan, hostId: string): void {
	if (!Check(ArchivePlanSchema, plan) || plan.source.conversationId !== deriveConversationId(hostId, plan.source.creationKey) || plan.source.roomId !== plan.conversation.roomId ||
		plan.host.provenance.kind !== "host_space" || plan.host.provenance.hostId !== hostId || plan.operatorUserId === plan.botUserId ||
		!isDeepStrictEqual(plan.targets.map(identity), targets(hostId, plan.source).map(identity))) throw Error("Invalid archive plan identity");
	const parents = [...new Set([plan.source.checkoutSpace, plan.source.projectSpace].filter((v): v is string => Boolean(v)))].sort();
	if (!isDeepStrictEqual(plan.parents.map(p => p.roomId), parents) || parents.includes(plan.host.roomId) || parents.includes(plan.source.roomId)) throw Error("Invalid archive source links");
	if (plan.conversation.provenance && (plan.conversation.provenance.kind !== "conversation" || plan.conversation.provenance.hostId !== hostId ||
		plan.conversation.provenance.conversationId !== plan.source.conversationId || plan.conversation.provenance.creationKey !== plan.source.creationKey ||
		plan.conversation.provenance.projectKey !== plan.source.projectKey || !parents.includes(plan.conversation.provenance.parentRoomId))) throw Error("Invalid archived conversation proof");
	if (plan.parents.some(p => !live(p.content) && !empty(p.content))) throw Error("Ambiguous archive source child state");
	for (const ancestor of plan.ancestors) if (!parents.includes(ancestor.child.roomId) || ancestor.projectKey !== plan.source.projectKey ||
		!(["project_space", "worktree_space"].includes(ancestor.child.provenance.kind)) || ancestor.child.provenance.hostId !== hostId || ancestor.parent.provenance.hostId !== hostId ||
		!("parentRoomId" in ancestor.child.provenance) || ancestor.child.provenance.parentRoomId !== ancestor.parent.roomId) throw Error("Invalid archive ancestor scope");
	if (new Set(plan.ancestors.map(a => a.child.roomId)).size !== plan.ancestors.length) throw Error("Duplicate archive cleanup scope");
}
function parse(value: unknown): State {
	if (!Check(stateSchema, value) || Buffer.byteLength(JSON.stringify(value)) > MAX_BYTES) throw Error("Invalid archive hierarchy journal");
	const state = value as State; const nodes = new Map(state.nodes.map(n => [n.target.key, n]));
	if (nodes.size !== state.nodes.length || new Set(state.nodes.flatMap(n => n.roomId ? [n.roomId] : [])).size !== state.nodes.filter(n => n.roomId).length ||
		new Set(state.entries.map(e => e.plan.source.conversationId)).size !== state.entries.length) throw Error("Duplicate archive journal identity");
	if (state.nodes.some(n => !state.entries.some(e => e.plan.targets.some(t => t.key === n.target.key)))) throw Error("Unreserved archive node");
	for (const entry of state.entries) {
		if (entry.linked && entry.plan.targets.some(t => !nodes.get(t.key)?.linked)) throw Error("Archive link lacks its verified path");
		validatePlan(entry.plan, state.hostId);
		for (const receipt of [entry.closure, entry.lastInspection]) {
			if (receipt?.basis === "operator_attested" && !receipt.operationId) throw Error("Legacy archive attestation lacks its consent reference");
			if (receipt?.incompleteInspection && receipt.basis !== "operator_attested") throw Error("Incomplete inspection cannot claim exact exit");
		}
		if (entry.cleanup.length !== entry.plan.ancestors.length || entry.completed && (!entry.linked || entry.unlinked.length !== entry.plan.parents.length) ||
			entry.unlinked.some(p => !entry.plan.parents.some(r => r.roomId === p)) || entry.unlinkAttempted.some(p => !entry.plan.parents.some(r => r.roomId === p)) ||
			(entry.unlinked.length > 0 || entry.unlinkAttempted.length > 0) && !entry.linked || !entry.completed && entry.cleanup.some(c => c !== "pending")) throw Error("Invalid archive progress");
		for (const target of entry.plan.targets) {
			const node = nodes.get(target.key); if (!node || !isDeepStrictEqual(node.target, target)) throw Error("Archive target changed");
			const parent = target.parentKey ? nodes.get(target.parentKey) : undefined;
			if (node.linked && !node.roomId || node.roomId && (!node.createAttempted || !node.parentRoomId) ||
				node.parentRoomId && node.parentRoomId !== (parent?.roomId ?? (!target.parentKey ? entry.plan.host.roomId : undefined))) throw Error("Invalid archive parent receipt");
		}
	}
	return structuredClone(state);
}

/** Matrix-only historical workflow. Public caller must freeze independent consent.
 * Reservation is durable BEFORE negative authority; no Matrix effect precedes both. */
export class ArchiveHierarchy {
	private state: State;
	private loaded = false;
	private poisoned = false;
	private work: Promise<void> = Promise.resolve();
	private readonly running = new Map<string, Promise<string>>();
	private readonly operations = new Set<Promise<unknown>>();
	private readonly stop = new AbortController();
	private readonly file: AtomicJsonFile<State>;
	constructor(private readonly options: { directory: string; registry: RelayRegistry; matrix: ManagedMatrixClient; hierarchy: LiveHierarchy;
		account?: SpaceCleanupAccount; assertRuntimeAbsent: (source: ArchiveSource, signal: AbortSignal, legacyClosure: boolean, acceptIncompleteInspection: boolean) => Promise<ArchiveClosure> }) {
		this.state = { version: 1, hostId: options.registry.hostId, nodes: [], entries: [] };
		this.file = new AtomicJsonFile(join(options.directory, "archive-hierarchy.json"), parse);
	}
	async load(): Promise<void> {
		if (this.loaded || this.poisoned) throw Error("Archive hierarchy requires a fresh owner to reload");
		await ensurePrivateDirectory(this.options.directory);
		let file;
		try { file = await open(this.file.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		if (file) try {
			const info = await file.stat();
			if (!info.isFile() || info.size > MAX_BYTES || (info.mode & 0o077) !== 0 || process.getuid && info.uid !== process.getuid()) throw Error("Invalid archive journal file");
			const bytes = Buffer.alloc(info.size + 1); let size = 0;
			while (size < bytes.length) { const read = await file.read(bytes, size, bytes.length - size, null); if (!read.bytesRead) break; size += read.bytesRead; }
			if (size !== info.size) throw Error("Archive journal changed while reading");
			this.state = parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size))));
		} finally { await file.close(); }
		if (this.state.hostId !== this.options.registry.hostId) throw Error("Archive journal belongs to another host");
		for (const entry of this.state.entries) {
			const record = this.options.registry.archiveRecord(entry.plan.source.conversationId);
			if (record ? !entry.closure || !isDeepStrictEqual(record.source, entry.plan.source) : entry.linked || entry.completed) throw Error("Archive authority and journal disagree");
		}
		for (const record of this.options.registry.archiveRecords()) if (!this.entry(record.source.conversationId)) throw Error("Archive journal is missing; restore the complete backup");
		this.loaded = true;
	}
	private assertAvailable(): void { this.stop.signal.throwIfAborted(); if (!this.loaded || this.poisoned) throw Error("Archive hierarchy is unavailable; restart for safe recovery"); }
	private entry(id: string): Entry | undefined { return this.state.entries.find(e => e.plan.source.conversationId === id); }
	private node(key: string) { const node = this.state.nodes.find(n => n.target.key === key); if (!node) throw Error("Archive target is not reserved"); return node; }
	private proof(key: string): ManagedProvenance {
		const { target, parentRoomId } = this.node(key);
		return parseManagedProvenance({ version: 1, hostId: this.state.hostId, creationKey: target.key, kind: target.kind, parentRoomId,
			...(target.projectKey ? { projectKey: target.projectKey } : {}), ...(target.checkoutId ? { checkoutId: target.checkoutId } : {}) });
	}
	private async inspect(roomId: string, space: boolean, signal: AbortSignal): Promise<SavedRoom> {
		const provenance = await this.options.matrix.inspectLegacyRoom(roomId, space, signal);
		if (provenance && provenance.hostId !== this.state.hostId) throw Error("Archive source has foreign provenance");
		return { roomId, ...(provenance ? { provenance } : {}) };
	}
	private async verify(saved: SavedRoom, space: boolean, signal: AbortSignal): Promise<void> {
		if (!isDeepStrictEqual(await this.inspect(saved.roomId, space, signal), saved)) throw Error("Archive room ownership changed");
	}
	private async readable(plan: ArchivePlan, signal: AbortSignal): Promise<void> {
		if (plan.operatorUserId !== this.options.matrix.operatorUserId || plan.botUserId !== this.options.matrix.botUserId) throw Error("Archive actors changed");
		if (this.options.registry.listManifests().find(m => m.kind === "coordinator")?.hostSpace !== plan.host.roomId) throw Error("Archive host Space changed");
		await this.verify(plan.host, true, signal); await this.verify(plan.conversation, false, signal);
		if (!await this.options.matrix.memberJoined(plan.source.roomId, plan.operatorUserId, signal)) throw Error("Archive requires existing operator membership; restoration is separate");
	}
	/** GET-only. Admitted intents never change. Unadmitted drafts may be replanned;
	 * replacing a draft requires fresh apply consent and cannot discard effect receipts. */
	async preview(conversationId: string, closedWindow?: ArchiveClosure["window"]): Promise<ArchivePlan> {
		this.assertAvailable(); const existing = this.entry(conversationId);
		if (existing && this.options.registry.archiveRecord(conversationId)) return structuredClone(existing.plan);
		if (this.options.registry.archiveRecord(conversationId)) throw Error("Archive journal missing; cannot infer prior effects");
		const candidate = this.options.registry.archiveCandidate(conversationId, closedWindow);
		if (candidate.blockers.length) throw Error(candidate.blockers.join("; "));
		const source = candidate.source; const signal = this.stop.signal;
		const coordinator = this.options.registry.listManifests().find(m => m.kind === "coordinator");
		if (!coordinator?.hostSpace) throw Error("Host Space is unavailable");
		const host = await this.inspect(coordinator.hostSpace, true, signal);
		if (host.provenance?.kind !== "host_space") throw Error("Host Space requires separately verified provenance");
		const conversation = await this.inspect(source.roomId, false, signal);
		if (conversation.provenance && (conversation.provenance.kind !== "conversation" || conversation.provenance.conversationId !== source.conversationId ||
			conversation.provenance.creationKey !== source.creationKey || conversation.provenance.projectKey !== source.projectKey || source.checkoutId && conversation.provenance.checkoutId !== source.checkoutId)) throw Error("Archive conversation identity changed");
		const parentIds = [...new Set([source.checkoutSpace, source.projectSpace].filter((v): v is string => Boolean(v)))].sort();
		const parents: ArchivePlan["parents"] = [];
		for (const roomId of parentIds) parents.push({ ...await this.inspect(roomId, true, signal), content: await this.options.matrix.spaceChildContent(roomId, source.roomId, signal) });
		const ancestors = this.options.hierarchy.maintenanceLinks().filter(link => parentIds.includes(link.child.roomId) && ["project_space", "worktree_space"].includes(link.child.provenance.kind))
			.sort((a, b) => Number(a.child.provenance.kind === "project_space") - Number(b.child.provenance.kind === "project_space"));
		for (const link of ancestors) await new LiveSpaceCleanup(this.options).verify(link, signal);
		const plan: ArchivePlan = { source, host: { roomId: host.roomId, provenance: host.provenance }, conversation, parents, ancestors,
			operatorUserId: this.options.matrix.operatorUserId, botUserId: this.options.matrix.botUserId,
			targets: targets(this.state.hostId, source).map(t => structuredClone(this.state.nodes.find(n => n.target.key === t.key)?.target ?? t)) };
		validatePlan(plan, this.state.hostId); await this.readable(plan, signal); return plan;
	}
	async apply(frozen: ArchivePlan, legacyClosure = false, operationId?: string, acceptIncompleteInspection = false,
		expectedInspection?: Pick<ArchiveClosure["receipt"], "incompleteInspection">): Promise<ReturnType<ArchiveHierarchy["status"]>> {
		this.assertAvailable(); const plan = structuredClone(frozen); validatePlan(plan, this.state.hostId);
		if (acceptIncompleteInspection && (!legacyClosure || !expectedInspection)) throw Error("Incomplete inspection requires frozen evidence and explicit legacy consent");
		const inspectClosure = async (source: ArchiveSource, signal: AbortSignal) => {
			const closure = await this.options.assertRuntimeAbsent(source, signal, legacyClosure, acceptIncompleteInspection);
			if (closure.receipt.incompleteInspection && (!acceptIncompleteInspection || closure.receipt.basis !== "operator_attested")) throw Error("Incomplete inspection is not authorized");
			if (acceptIncompleteInspection && !isDeepStrictEqual(closure.receipt.incompleteInspection, expectedInspection?.incompleteInspection)) throw Error("Incomplete inspection evidence changed; obtain fresh preview and consent");
			return closure;
		};
		if (legacyClosure && (!operationId || !/^operation_[a-f0-9]{32}$/.test(operationId))) throw Error("Legacy archive requires an approved operation reference");
		return this.track(this.options.hierarchy.withProjectCleanup(plan.source.projectKey, async scopeSignal => {
			const signal = AbortSignal.any([scopeSignal, this.stop.signal]); this.assertAvailable();
			const id = plan.source.conversationId; let entry = this.entry(id);
			const wasAdmitted = Boolean(this.options.registry.archiveRecord(id));
			if (entry && !isDeepStrictEqual(entry.plan, plan) && this.options.registry.archiveRecord(id)) throw Error("Frozen archive intent changed");
			if (!entry || !isDeepStrictEqual(entry.plan, plan)) {
				if (this.options.registry.archiveRecord(id)) throw Error("Archive journal missing; cannot reconstruct effect history");
				const closure = await inspectClosure(plan.source, signal);
				if (!isDeepStrictEqual(await this.preview(id, closure.window), plan)) throw Error("Archive preview changed; obtain fresh consent");
				await this.mutate(state => {
					if (this.options.registry.archiveRecord(id)) throw Error("Archive was admitted while reserving; obtain a fresh preview");
					for (const target of plan.targets) {
						const prior = state.nodes.find(n => n.target.key === target.key);
						if (prior && !isDeepStrictEqual(prior.target, target)) throw Error("Archive reservation changed");
						if (!prior) state.nodes.push({ target, createAttempted: false, linked: false, ...(target.parentKey ? {} : { parentRoomId: plan.host.roomId }) });
					}
					const draft: Entry = { plan, linked: false, completed: false, unlinkAttempted: [], unlinked: [], cleanup: plan.ancestors.map(() => "pending") };
					const index = state.entries.findIndex(e => e.plan.source.conversationId === id);
					if (index < 0) state.entries.push(draft); else state.entries[index] = draft;
					state.nodes = state.nodes.filter(node => {
						if (state.entries.some(e => e.plan.targets.some(t => t.key === node.target.key))) return true;
						if (node.createAttempted || node.roomId) throw Error("Cannot discard an uncertain archive target");
						return false;
					});
				}); entry = this.entry(id)!;
			}
			if (!this.options.registry.archiveRecord(id)) {
				await this.readable(plan, signal);
				for (const parent of plan.parents) {
					await this.verify({ roomId: parent.roomId, ...(parent.provenance ? { provenance: parent.provenance } : {}) }, true, signal);
					if (!isDeepStrictEqual(await this.options.matrix.spaceChildContent(parent.roomId, plan.source.roomId, signal), parent.content)) throw Error("Archive source link changed");
				}
				const closure = await inspectClosure(plan.source, signal); signal.throwIfAborted();
				if (closure.receipt.basis === "operator_attested" && !legacyClosure) throw Error("Legacy closure requires explicit operator attestation");
				await this.update(id, e => { e.closure = { ...structuredClone(closure.receipt), ...(operationId ? { operationId } : {}) }; }, plan);
				signal.throwIfAborted(); await this.options.registry.admitArchive(plan.source, closure.window);
			}
			if (!isDeepStrictEqual(this.options.registry.archiveRecord(id)?.source, plan.source)) throw Error("Archive authority changed");
			await this.readable(plan, signal);
			if (wasAdmitted) {
				const closure = await inspectClosure(plan.source, signal);
				if (closure.receipt.basis === "operator_attested" && !legacyClosure) throw Error("Archive retry requires fresh legacy attestation");
				await this.update(id, e => { e.lastInspection = { ...closure.receipt, ...(operationId ? { operationId } : {}) }; }, plan);
			}
			// A completed archive does not depend on departed original ancestors.
			await this.ensure(plan.targets[2]!.key, signal);
			for (const target of plan.targets) if (!await this.options.matrix.memberJoined(this.node(target.key).roomId!, plan.operatorUserId, signal)) return this.status(id);
			const destination = this.node(plan.targets[2]!.key).roomId!;
			await this.link(destination, plan.source.roomId, signal);
			await this.update(id, e => { e.linked = true; }, plan);
			for (const parent of plan.parents) {
				if (this.entry(id)!.unlinked.includes(parent.roomId)) continue;
				await this.readable(plan, signal); await this.verifyPath(plan, signal);
				await this.verify({ roomId: parent.roomId, ...(parent.provenance ? { provenance: parent.provenance } : {}) }, true, signal);
				const current = await this.options.matrix.spaceChildContent(parent.roomId, plan.source.roomId, signal);
				const retry = this.entry(id)!.unlinkAttempted.includes(parent.roomId);
				if (!isDeepStrictEqual(current, parent.content) && !(retry && empty(current))) throw Error("Archive source link changed before unlink");
				if (live(current)) {
					if (!live(await this.options.matrix.spaceChildContent(destination, plan.source.roomId, signal))) throw Error("Archive link disappeared before unlink");
					await this.update(id, e => { if (!e.unlinkAttempted.includes(parent.roomId)) e.unlinkAttempted.push(parent.roomId); }, plan);
					if (!isDeepStrictEqual(await this.options.matrix.spaceChildContent(parent.roomId, plan.source.roomId, signal), current)) throw Error("Concurrent archive source link change");
					await this.options.matrix.removeSpaceChild(parent.roomId, plan.source.roomId, signal);
					if (!empty(await this.options.matrix.spaceChildContent(parent.roomId, plan.source.roomId, signal))) throw Error("Archive unlink readback changed");
				}
				await this.update(id, e => { e.unlinked.push(parent.roomId); }, plan);
			}
			await this.readable(plan, signal); await this.verifyPath(plan, signal); await this.update(id, e => { e.completed = true; }, plan); return this.status(id);
		}));
	}
	private async verifyPath(plan: ArchivePlan, signal: AbortSignal): Promise<void> {
		for (const target of plan.targets) {
			const node = this.node(target.key);
			await this.options.matrix.recoverManagedRoom(node.roomId!, this.proof(target.key), signal);
			if (!await this.options.matrix.memberJoined(node.roomId!, plan.operatorUserId, signal) || !live(await this.options.matrix.spaceChildContent(node.parentRoomId!, node.roomId!, signal))) throw Error("Archive path is no longer readable");
		}
		if (!live(await this.options.matrix.spaceChildContent(this.node(plan.targets[2]!.key).roomId!, plan.source.roomId, signal))) throw Error("Archive conversation link disappeared");
	}
	/** Fresh read-only cleanup evidence; unknown authority is not an empty Space. */
	async cleanupPreview(conversationId: string): Promise<Array<{ roomId: string; state: "done" | "eligible" | "preserved" | "unverifiable" }>> {
		this.assertAvailable(); const entry = this.entry(conversationId);
		if (!entry?.completed || entry.plan.operatorUserId !== this.options.matrix.operatorUserId || entry.plan.botUserId !== this.options.matrix.botUserId) throw Error("Archive cleanup scope unavailable");
		const owner = new LiveSpaceCleanup(this.options); const rows: Array<{ roomId: string; state: "done" | "eligible" | "preserved" | "unverifiable" }> = [];
		for (const link of entry.plan.ancestors) {
			let state: typeof rows[number]["state"];
			try {
				if (this.options.hierarchy.spaceRetirement(owner.identity(link)) === "done") state = "done";
				else { await owner.verify(link, this.stop.signal); state = await owner.empty(link, this.stop.signal) ? "eligible" : "preserved"; }
			} catch { this.stop.signal.throwIfAborted(); state = "unverifiable"; }
			rows.push({ roomId: link.child.roomId, state });
		}
		return rows;
	}
	/** Separately retryable, exactly frozen ancestors only. Never touches conversation membership. */
	async cleanup(conversationId: string): Promise<ReturnType<ArchiveHierarchy["status"]>> {
		this.assertAvailable(); const entry = this.entry(conversationId); if (!entry?.completed) throw Error("Archive is not complete");
		if (entry.plan.operatorUserId !== this.options.matrix.operatorUserId || entry.plan.botUserId !== this.options.matrix.botUserId) throw Error("Archive cleanup actors changed");
		return this.track(this.options.hierarchy.withProjectCleanup(entry.plan.source.projectKey, async scopeSignal => {
			const signal = AbortSignal.any([scopeSignal, this.stop.signal]); const owner = new LiveSpaceCleanup(this.options);
			for (const [index, link] of entry.plan.ancestors.entries()) {
				if (this.entry(conversationId)!.cleanup[index] === "done") continue;
				let status: "done" | "pending" | "preserved";
				try {
					if (this.options.hierarchy.spaceRetirement(owner.identity(link)) === "done") status = "done";
					else if (this.options.hierarchy.spaceRetirement(owner.identity(link)) === "pending") status = await owner.apply(link, signal) ? "done" : "pending";
					else if (!await owner.empty(link, signal)) status = "preserved";
					else status = await owner.apply(link, signal) ? "done" : "pending";
				} catch { signal.throwIfAborted(); status = "pending"; }
				await this.update(conversationId, e => { e.cleanup[index] = status; }, entry.plan);
			}
			return this.status(conversationId);
		}));
	}
	status(conversationId: string) {
		this.assertAvailable(); const entry = this.entry(conversationId); if (!entry) return undefined;
		return { conversationId, closureBasis: entry.closure?.basis, phase: entry.completed ? "archived" as const : this.options.registry.archiveRecord(conversationId) ? "archiving" as const : "reserved" as const,
			cleanupPending: entry.cleanup.filter(s => s === "pending").length,
			preservedSpaces: entry.plan.parents.filter(p => !entry.plan.ancestors.some(a => a.child.roomId === p.roomId)).map(p => p.roomId)
				.concat(entry.plan.ancestors.filter((_, i) => entry.cleanup[i] === "preserved").map(a => a.child.roomId)),
			archiveSpaces: entry.plan.targets.flatMap(t => this.node(t.key).roomId ? [this.node(t.key).roomId!] : []) };
	}
	accountBaseline(): string[] { this.assertAvailable(); return this.state.nodes.map(n => `${n.target.kind}:${n.target.key}`); }
	accountInventory() {
		this.assertAvailable(); const root = this.state.nodes.find(n => n.target.kind === "archive_root_space");
		return this.state.nodes.flatMap(n => {
			if (!n.roomId || !n.linked || !root?.roomId || !root.parentRoomId) return [];
			const project = n.target.projectKey ? this.node(`archive-${n.target.projectKey}`) : undefined;
			return [{ roomId: n.roomId, hostSpaceId: root.parentRoomId, archiveRootSpaceId: root.roomId, provenance: this.proof(n.target.key), preserveNotificationPolicy: true as const,
				...(project?.roomId ? { project: { projectKey: n.target.projectKey!, spaceId: project.roomId } } : {}),
				...(n.target.checkoutId ? { checkout: { checkoutId: n.target.checkoutId, spaceId: n.roomId } } : {}) }];
		});
	}
	private ensure(key: string, signal: AbortSignal): Promise<string> {
		const pending = this.running.get(key); if (pending) return pending;
		const result = this.ensureOnce(key, signal).finally(() => this.running.delete(key)); this.running.set(key, result); return result;
	}
	private async ensureOnce(key: string, signal: AbortSignal): Promise<string> {
		this.assertAvailable(); signal.throwIfAborted(); let node = this.node(key);
		const parentRoomId = node.target.parentKey ? await this.ensure(node.target.parentKey, signal) : node.parentRoomId!;
		if (node.parentRoomId && node.parentRoomId !== parentRoomId) throw Error("Archive parent changed");
		if (!node.parentRoomId) await this.mutate(s => { s.nodes.find(n => n.target.key === key)!.parentRoomId = parentRoomId; });
		node = this.node(key); const proof = this.proof(key); let roomId = node.roomId;
		if (roomId) await this.options.matrix.recoverManagedRoom(roomId, proof, signal);
		else {
			if (node.createAttempted) { roomId = await this.options.matrix.recoverManagedAlias(proof, signal); if (!roomId) throw Error("Uncertain archive creation lacks its verified alias; reconciliation required"); }
			else {
				await this.mutate(s => { s.nodes.find(n => n.target.key === key)!.createAttempted = true; });
				roomId = await this.options.matrix.ensureManagedRoom(node.target.title, proof, signal, true);
			}
			await this.mutate(s => { s.nodes.find(n => n.target.key === key)!.roomId = roomId; });
		}
		await this.options.matrix.assertOperatorSpaceAdmin(roomId, signal);
		const parentProof = node.target.parentKey ? this.proof(node.target.parentKey) : this.state.entries[0]!.plan.host.provenance;
		await this.options.matrix.recoverManagedRoom(parentRoomId, parentProof, signal);
		await this.link(parentRoomId, roomId, signal);
		await this.mutate(s => { s.nodes.find(n => n.target.key === key)!.linked = true; }); return roomId;
	}
	private async link(parent: string, child: string, signal: AbortSignal): Promise<void> {
		const matrix = this.options.matrix; const before = await matrix.spaceChildContent(parent, child, signal);
		if (live(before)) return; // Preserve existing order/suggested/other metadata.
		if (!empty(before)) throw Error("Conflicting archive child state");
		if (!isDeepStrictEqual(before, await matrix.spaceChildContent(parent, child, signal))) throw Error("Concurrent archive child state change");
		signal.throwIfAborted(); await matrix.addSpaceChild(parent, child, signal);
		if (!live(await matrix.spaceChildContent(parent, child, signal))) throw Error("Archive link readback failed");
	}
	private update(id: string, change: (entry: Entry) => void, plan: ArchivePlan): Promise<void> {
		return this.mutate(state => {
			const entry = state.entries.find(e => e.plan.source.conversationId === id);
			if (!entry || !isDeepStrictEqual(entry.plan, plan)) throw Error("Archive intent changed before recording progress");
			change(entry);
		});
	}
	private mutate(change: (state: State) => void): Promise<void> {
		const result = this.work.then(async () => {
			this.assertAvailable(); const next = structuredClone(this.state); change(next); parse(next);
			try { await this.file.write(next); } catch (error) { this.poisoned = true; throw error; }
			this.state = next;
		}); this.work = result.catch(() => undefined); return result;
	}
	private track<T>(operation: Promise<T>): Promise<T> {
		this.operations.add(operation); return operation.finally(() => this.operations.delete(operation));
	}
	async close(): Promise<void> { this.stop.abort(); await Promise.allSettled([...this.operations, ...this.running.values()]); await this.work; }
}
