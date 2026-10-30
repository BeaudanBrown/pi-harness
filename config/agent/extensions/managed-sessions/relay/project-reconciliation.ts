import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { HostControlError } from "./host-control-error.js";
import { LiveHierarchy, type HierarchyLink, type HierarchySpaceIdentity } from "./live-hierarchy.js";
import { LiveSpaceCleanup, type SpaceCleanupAccount } from "./live-space-cleanup.js";
export type { SpaceCleanupAccount } from "./live-space-cleanup.js";
import { lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { deriveConversationId, WorkspaceIdentitySchema, type WorkspaceIdentity } from "../contracts.js";
import { Check } from "typebox/value";
import { isMatrixRoomId } from "../../matrix-shared/room-id.js";
import { deriveCheckoutId } from "../managed-provenance.js";
import { AtomicJsonFile } from "./atomic-json.js";
import type { ResolvedWorkspace } from "./host-lifecycle.js";
import { ManagedMatrixClient } from "./matrix-client.js";
import { ProjectSpaces } from "./project-spaces.js";
import { RelayRegistry, RelayRegistryError, projectGroupingHash } from "./registry.js";

interface ReconciliationItem {
	conversationId: string; concept: string; workspace: string; roomId: string; oldProjectSpace?: string;
	projectKey: string; projectDisplayName: string; checkoutDisplayName: string;
	sourceManifestHash: string; plannedProjectSpace?: string; targetManifestHash?: string; targetProjectSpace?: string;
	checkout?: { creationKey: string; root: string; hostSpace: string; placement: WorkspaceIdentity; checkoutId: string };
	targetCheckoutSpace?: string; retired?: true;
	hostLinked: boolean; roomLinked: boolean; manifestUpdated: boolean; oldUnlinked: boolean;
}
interface CleanupSpace { spaceId: string; hostUnlinked: boolean; operatorRemoved: boolean; left: boolean }
interface ReconciliationIntent { version: 1; reconciliationKey: string; items: ReconciliationItem[]; selection?: string[]; cleanupSpaces?: CleanupSpace[] }
interface ReconciliationPlan extends ReconciliationIntent { continuationOf?: string }
const selectionIds = (ids: string[]): string[] => {
	if (!Array.isArray(ids) || !ids.length || ids.length > 64 || new Set(ids).size !== ids.length || ids.some(id => !/^conv_[a-f0-9]{32}$/.test(id))) throw new RelayRegistryError("invalid_state", "Select 1–64 unique exact conversation IDs");
	return [...ids].sort();
};
const planKey = (items: ReconciliationItem[], selection?: string[]) => `reconcile_${hash(selection ? { selection, items: items.map(planIdentity) } : items.map(planIdentity)).slice(0, 32)}`;


const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const planIdentity = (item: ReconciliationItem) => ({ conversationId: item.conversationId, concept: item.concept, workspace: item.workspace,
	roomId: item.roomId, ...(item.oldProjectSpace ? { oldProjectSpace: item.oldProjectSpace } : {}), projectKey: item.projectKey,
	projectDisplayName: item.projectDisplayName, checkoutDisplayName: item.checkoutDisplayName, sourceManifestHash: item.sourceManifestHash,
	...(item.plannedProjectSpace ? { plannedProjectSpace: item.plannedProjectSpace } : {}), ...(item.checkout ? { checkout: item.checkout } : {}) });

function parseIntent(value: unknown): ReconciliationIntent {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new RelayRegistryError("invalid_state", "Project reconciliation intent is malformed");
	const record = value as Record<string, unknown>;
	if (Object.keys(record).some((key) => !["version", "reconciliationKey", "items", "selection", "cleanupSpaces"].includes(key)) || record.version !== 1 ||
		typeof record.reconciliationKey !== "string" || !/^reconcile_[a-f0-9]{32}$/.test(record.reconciliationKey) || !Array.isArray(record.items) || record.items.length > 64 ||
		(record.cleanupSpaces !== undefined && (!Array.isArray(record.cleanupSpaces) || record.cleanupSpaces.length > 64))) throw new RelayRegistryError("invalid_state", "Project reconciliation intent is malformed");
	for (const item of record.items as unknown[]) {
		if (typeof item !== "object" || item === null || Array.isArray(item)) throw new RelayRegistryError("invalid_state", "Project reconciliation item is malformed");
		const entry = item as Record<string, unknown>; const allowed = ["conversationId", "concept", "workspace", "roomId", "oldProjectSpace", "projectKey", "projectDisplayName", "checkoutDisplayName", "sourceManifestHash", "plannedProjectSpace", "targetManifestHash", "targetProjectSpace", "checkout", "targetCheckoutSpace", "retired", "hostLinked", "roomLinked", "manifestUpdated", "oldUnlinked"];
		if (Object.keys(entry).some((key) => !allowed.includes(key)) || typeof entry.conversationId !== "string" || !/^conv_[a-f0-9]{32}$/.test(entry.conversationId) ||
			![entry.concept, entry.workspace].every((field) => typeof field === "string" && field.length > 0 && field.length <= 128 && !/[\u0000-\u001f\u007f]/.test(field)) ||
			![entry.projectDisplayName, entry.checkoutDisplayName].every((field) => typeof field === "string" && field.length > 0 && field.length <= 128 && !/[\u0000-\u001f\u007f/]/.test(field)) ||
			typeof entry.roomId !== "string" || !isMatrixRoomId(entry.roomId) || typeof entry.projectKey !== "string" || !/^project_[a-f0-9]{32}$/.test(entry.projectKey) ||
			typeof entry.sourceManifestHash !== "string" || !/^[a-f0-9]{64}$/.test(entry.sourceManifestHash) ||
			[entry.oldProjectSpace, entry.plannedProjectSpace, entry.targetProjectSpace, entry.targetCheckoutSpace].some((field) => field !== undefined && (typeof field !== "string" || !isMatrixRoomId(field))) ||
			(entry.targetManifestHash !== undefined && (typeof entry.targetManifestHash !== "string" || !/^[a-f0-9]{64}$/.test(entry.targetManifestHash))) ||
			(entry.plannedProjectSpace !== undefined && entry.targetProjectSpace !== entry.plannedProjectSpace) ||
			(entry.retired !== undefined && entry.retired !== true) ||
			![entry.hostLinked, entry.roomLinked, entry.manifestUpdated, entry.oldUnlinked].every((field) => typeof field === "boolean") ||
			(entry.hostLinked && !entry.targetProjectSpace) || (entry.roomLinked && !entry.hostLinked) || (entry.manifestUpdated && (!entry.roomLinked || !entry.targetManifestHash)) || (entry.oldUnlinked && !entry.manifestUpdated)) {
			throw new RelayRegistryError("invalid_state", "Project reconciliation item is malformed");
		}
		if (entry.checkout !== undefined) {
			const checkout = entry.checkout as ReconciliationItem["checkout"];
			if (!checkout || typeof checkout !== "object" || Object.keys(checkout).sort().join(",") !== "checkoutId,creationKey,hostSpace,placement,root" ||
				typeof checkout.creationKey !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(checkout.creationKey) ||
				typeof checkout.root !== "string" || !checkout.root.startsWith("/") || checkout.root.length > 4096 || /[\u0000-\u001f\u007f]/.test(checkout.root) ||
				!isMatrixRoomId(checkout.hostSpace) || !Check(WorkspaceIdentitySchema, checkout.placement) || !/^checkout_[a-f0-9]{32}$/.test(checkout.checkoutId) ||
				(entry.hostLinked && !entry.targetCheckoutSpace)) throw new RelayRegistryError("invalid_state", "Checkout migration identity is malformed");
		} else if (entry.targetCheckoutSpace) throw new RelayRegistryError("invalid_state", "Checkout migration source is missing");
	}
	const typedItems = record.items as unknown as ReconciliationItem[];
	const selection = record.selection === undefined ? undefined : selectionIds(record.selection as string[]);
	if (selection && (!isDeepStrictEqual(selection, record.selection) || typedItems.some(item => !selection.includes(item.conversationId)))) throw new RelayRegistryError("invalid_state", "Reconciliation selection is inconsistent");
	if (new Set(typedItems.map((item) => item.conversationId)).size !== typedItems.length ||
		planKey(typedItems, selection) !== record.reconciliationKey) throw new RelayRegistryError("invalid_state", "Project reconciliation identity is inconsistent");
	for (const item of (record.cleanupSpaces ?? []) as unknown[]) {
		if (typeof item !== "object" || item === null || Array.isArray(item) || Object.keys(item).some((key) => !["spaceId", "hostUnlinked", "operatorRemoved", "left"].includes(key))) throw new RelayRegistryError("invalid_state", "Project cleanup intent is malformed");
		const entry = item as Record<string, unknown>;
		if (typeof entry.spaceId !== "string" || !isMatrixRoomId(entry.spaceId) || typeof entry.hostUnlinked !== "boolean" || typeof entry.operatorRemoved !== "boolean" || typeof entry.left !== "boolean" || entry.operatorRemoved && !entry.hostUnlinked || entry.left && !entry.operatorRemoved) throw new RelayRegistryError("invalid_state", "Project cleanup intent is malformed");
	}
	const cleanup = (record.cleanupSpaces ?? []) as unknown as CleanupSpace[];
	if (new Set(cleanup.map((item) => item.spaceId)).size !== cleanup.length) throw new RelayRegistryError("invalid_state", "Project cleanup identity is inconsistent");
	return record as unknown as ReconciliationIntent;
}

export interface ReconciliationPreview extends Record<string, unknown> {
	operation: "project.reconcile.preview"; reconciliationKey: string; pending: number; completed: number;
	items: Array<{ conversationId: string; concept: string; workspace: string; projectDisplayName: string; checkoutDisplayName: string; status: "pending" | "completed" }>;
	obsoleteSpaces: number;
}

export interface LiveSpacePreview { links: HierarchyLink[]; operatorUserId: string; botUserId: string; migration?: ReconciliationPlan;
	selection?: string[]; blockers?: string[]; continuationJournal?: string;
	legacyPlacements?: Array<{ conversationId: string; hostSpace: string; workspace: ResolvedWorkspace }> }

export class ProjectReconciler {
	private readonly path: string;
	private readonly file: AtomicJsonFile<ReconciliationIntent>;
	private running?: Promise<unknown>;
	private readonly spaces: ProjectSpaces;
	constructor(private readonly options: { registry: RelayRegistry; matrix: ManagedMatrixClient; intentDirectory: string;
		resolveWorkspace: (placement: WorkspaceIdentity) => Promise<ResolvedWorkspace>; hierarchy?: LiveHierarchy; account?: SpaceCleanupAccount }) {
		this.path = join(resolve(options.intentDirectory), "project-reconciliation.json"); this.file = new AtomicJsonFile(this.path, parseIntent);
		this.spaces = new ProjectSpaces(options.registry, options.matrix);
	}

	pendingCount(): number { return this.options.registry.listManifests().filter((item) => item.kind === "project" && (this.options.hierarchy ? !item.checkoutSpace : !item.projectKey)).length; }

	preview(): Promise<ReconciliationPreview> { return this.serial(() => this.previewOnce()); }
	apply(reconciliationKey: string): Promise<Record<string, unknown>> { return this.serial(() => this.applyOnce(reconciliationKey)); }
	cleanup(reconciliationKey: string): Promise<Record<string, unknown>> { return this.serial(() => this.cleanupOnce(reconciliationKey)); }

	/** A completed subset of an older broad plan may need the newer checkout
	 * migration. Keep that follow-on journal separate; never rewrite the old
	 * plan's identity or the excluded entries. Once created, always recover it. */
	private async continuationOwner(selection?: string[]): Promise<ProjectReconciler | undefined> {
		if (!selection) return undefined;
		const child = new ProjectReconciler({ ...this.options, intentDirectory: join(this.options.intentDirectory, `scoped-${hash(selection).slice(0, 32)}`) });
		if (await child.readIntent()) return child;
		const existing = await this.readIntent();
		if (existing && !existing.selection && selection.every(id => !existing.items.some(item => item.conversationId === id) || existing.items.some(item => item.conversationId === id && (item.oldUnlinked || item.retired)))
			&& existing.items.some(item => !item.oldUnlinked && !item.retired)) return child;
		return undefined;
	}

	/** Read-only preview: saved live links plus the explicit, frozen legacy migration plan. */
	async previewLive(cleanup: boolean, conversationIds?: string[]): Promise<LiveSpacePreview> {
		const hierarchy = this.options.hierarchy; if (!hierarchy) throw new RelayRegistryError("invalid_state", "Live hierarchy is unavailable");
		const selection = conversationIds ? selectionIds(conversationIds) : undefined;
		if (cleanup && selection) throw new RelayRegistryError("invalid_state", "Selection is not cleanup authority");
		const continuation = await this.continuationOwner(selection);
		if (continuation) return { ...await continuation.previewLive(cleanup, selection), continuationJournal: hash(selection) };
		const manifests = this.options.registry.listManifests().filter(item => selection?.includes(item.conversationId));
		if (selection) {
			const blockers: string[] = [];
			const admitted = await this.readIntent();
			for (const id of selection) {
				// A retired member of this exact admitted plan is skipped by apply,
				// never restored; it must not prevent finishing the other members.
				if (this.options.registry.retirement(id) && admitted && (!admitted.selection || isDeepStrictEqual(admitted.selection, selection)) && admitted.items.some(item => item.conversationId === id)) continue;
				const manifest = manifests.find(item => item.conversationId === id);
				if (!manifest || manifest.kind !== "project" || !manifest.placement || this.options.registry.retirement(id)) { blockers.push(`${id}: select an existing, non-retired project conversation`); continue; }
				try { await this.options.resolveWorkspace(manifest.placement); }
				catch { blockers.push(`${id} (${manifest.concept}): cannot resolve workspace ${manifest.placement.rootKey}/${manifest.placement.workspace}; restore the checkout or exclude this conversation`.slice(0, 512)); }
			}
			if (blockers.length) return { links: [], selection, blockers, operatorUserId: this.options.matrix.operatorUserId, botUserId: this.options.matrix.botUserId };
		}
		const projects = new Set(manifests.map(item => item.projectKey));
		const checkouts = new Set(manifests.map(item => item.checkoutId));
		for (const link of hierarchy.maintenanceLinks(false)) if (link.child.provenance.kind === "conversation" && selection?.includes(link.child.provenance.conversationId)) {
			projects.add(link.child.provenance.projectKey); checkouts.add(link.child.provenance.checkoutId);
		}
		const links = hierarchy.maintenanceLinks(cleanup).filter(link => !selection || (link.child.provenance.kind === "conversation" ? selection.includes(link.child.provenance.conversationId)
			: link.child.provenance.kind === "worktree_space" ? checkouts.has(link.child.provenance.checkoutId) : projects.has(link.projectKey)));
		if (links.length > 100) throw new RelayRegistryError("invalid_state", "Live Space preview exceeds bounds");
		const result: HierarchyLink[] = [];
		for (const link of links) {
			if (cleanup && hierarchy.spaceRetirement(this.spaceIdentity(link)) === "pending" && !await this.options.matrix.accountJoined(link.child.roomId)) { result.push(link); continue; }
			try { await this.verifyLink(link); }
			catch (error) {
				if (!selection) throw error;
				return { links: [], selection, blockers: [`Cannot verify ownership or permissions for hierarchy link ${link.parent.roomId} -> ${link.child.roomId}; inspect these rooms before reconciliation`.slice(0, 512)], operatorUserId: this.options.matrix.operatorUserId, botUserId: this.options.matrix.botUserId };
			}
			if (!cleanup || await this.emptySpace(link)) result.push(link);
		}
		let migration: ReconciliationPlan | undefined;
		try { migration = cleanup ? undefined : await this.planOnce(selection); }
		catch (error) {
			if (!selection) throw error;
			return { links: [], selection, blockers: [error instanceof HostControlError ? error.message : "Selected hierarchy planning failed host/project ownership or saved-intent validation; inspect the existing plan and Space authority before retrying"], operatorUserId: this.options.matrix.operatorUserId, botUserId: this.options.matrix.botUserId };
		}
		const legacyPlacements: NonNullable<LiveSpacePreview["legacyPlacements"]> = [];
		for (const item of migration?.items ?? []) if (!item.checkout && !item.retired && !item.oldUnlinked) {
			const manifest = this.options.registry.manifestByConversationId(item.conversationId);
			if (!manifest?.placement || ![item.sourceManifestHash, item.targetManifestHash].includes(hash(manifest))) throw new RelayRegistryError("invalid_state", "Legacy reconciliation source changed; explicit recovery required");
			const workspace = await this.options.resolveWorkspace(manifest.placement);
			if (workspace.projectKey !== item.projectKey) throw new RelayRegistryError("invalid_state", "Legacy project placement changed");
			const hostSpace = this.options.registry.listManifests().find(manifest => manifest.kind === "coordinator")?.hostSpace;
			if (!hostSpace) throw new RelayRegistryError("invalid_state", "Legacy host Space is unavailable");
			await this.options.matrix.inspectLegacyProvenance(hostSpace, { version: 1, hostId: this.options.registry.hostId, kind: "host_space", creationKey: "host" });
			const proof = await this.options.matrix.inspectLegacyRoom(item.roomId, false);
			if (proof && (proof.hostId !== this.options.registry.hostId || proof.kind !== "conversation" || proof.conversationId !== item.conversationId)) throw new RelayRegistryError("invalid_state", "Legacy conversation ownership changed");
			for (const parent of [item.oldProjectSpace, item.targetProjectSpace]) if (parent) await this.verifyLegacyParent(parent, item.projectKey);
			legacyPlacements.push({ conversationId: item.conversationId, hostSpace, workspace });
		}
		return { links: result, operatorUserId: this.options.matrix.operatorUserId, botUserId: this.options.matrix.botUserId,
			...(selection ? { selection } : {}),
			...(migration?.items.length ? { migration } : {}), ...(legacyPlacements.length ? { legacyPlacements } : {}) };
	}
	applyLive(frozen: LiveSpacePreview, cleanup: boolean): Promise<{ remaining: number }> {
		const snapshot = structuredClone(frozen);
		return this.serial(async () => {
			const hierarchy = this.options.hierarchy; if (!hierarchy || snapshot.blockers?.length || !isDeepStrictEqual(await this.previewLive(cleanup, snapshot.selection), snapshot)) throw new RelayRegistryError("invalid_state", "Live Space preview changed");
			if (snapshot.continuationJournal) {
				const continuation = await this.continuationOwner(snapshot.selection);
				if (!continuation || snapshot.continuationJournal !== hash(snapshot.selection)) throw new RelayRegistryError("invalid_state", "Continuation journal changed");
				const { continuationJournal: _journal, ...childSnapshot } = snapshot;
				return continuation.applyLive(childSnapshot, cleanup);
			}
			let remaining = 0;
			if (snapshot.migration) {
				if (cleanup) throw new RelayRegistryError("invalid_state", "Migration is not cleanup authority");
				await this.applyOnce(snapshot.migration.reconciliationKey, snapshot.legacyPlacements, snapshot.selection, snapshot.migration.continuationOf);
			}
			for (const link of snapshot.links) await hierarchy.withProjectCleanup(link.projectKey, async (signal) => {
				if (!hierarchy.maintenanceLinks(cleanup).some((current) => isDeepStrictEqual(current, link))) throw new RelayRegistryError("invalid_state", "Live Space ownership changed before mutation");
				if (cleanup) { if (!await this.cleanupLiveSpace(link, signal)) remaining++; return; }
				await this.verifyLink(link, signal);
				if (!(await this.options.matrix.spaceChildren(link.parent.roomId, signal)).includes(link.child.roomId)) {
					signal.throwIfAborted(); await this.options.matrix.addSpaceChild(link.parent.roomId, link.child.roomId, signal);
				}
			});
			return { remaining };
		});
	}
	private spaceIdentity(link: HierarchyLink): HierarchySpaceIdentity {
		return { roomId: link.child.roomId, provenance: link.child.provenance,
			operatorUserId: this.options.matrix.operatorUserId, botUserId: this.options.matrix.botUserId };
	}
	private async verifyLink(link: HierarchyLink, signal?: AbortSignal): Promise<void> {
		const { matrix } = this.options;
		await matrix.recoverManagedRoom(link.parent.roomId, link.parent.provenance, signal);
		await matrix.recoverManagedRoom(link.child.roomId, link.child.provenance, signal);
		await matrix.assertRoomAuthority(link.parent.roomId, true, signal, { spaceChild: true });
	}
	private emptySpace(link: HierarchyLink, signal?: AbortSignal): Promise<boolean> {
		return new LiveSpaceCleanup({ ...this.options, hierarchy: this.options.hierarchy! }).empty(link, signal);
	}
	private cleanupLiveSpace(link: HierarchyLink, signal: AbortSignal): Promise<boolean> {
		return new LiveSpaceCleanup({ ...this.options, hierarchy: this.options.hierarchy! }).apply(link, signal);
	}

	private serial<T>(operation: () => Promise<T>): Promise<T> {
		const prior = this.running ?? Promise.resolve(); const next = prior.catch(() => undefined).then(operation);
		const tracked = next.finally(() => { if (this.running === tracked) this.running = undefined; }); this.running = tracked; return tracked;
	}
	private async readIntent(): Promise<ReconciliationIntent | undefined> {
		const intent = await this.file.read(); if (!intent) return undefined;
		const info = await lstat(this.path); if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 ||
			(process.getuid?.() !== undefined && info.uid !== process.getuid!())) throw new RelayRegistryError("invalid_state", "Existing project reconciliation intent is not a private relay-user file");
		return intent;
	}
	private summary(intent: ReconciliationIntent): ReconciliationPreview {
		intent = { ...intent, items: intent.items.filter(item => !item.retired) };
		const completed = intent.items.filter((item) => item.oldUnlinked).length;
		return { operation: "project.reconcile.preview", reconciliationKey: intent.reconciliationKey, pending: intent.items.length - completed, completed,
			items: intent.items.map((item) => ({ conversationId: item.conversationId, concept: item.concept, workspace: item.workspace,
				projectDisplayName: item.projectDisplayName, checkoutDisplayName: item.checkoutDisplayName, status: item.oldUnlinked ? "completed" : "pending" })),
			obsoleteSpaces: 0 };
	}
	private async previewOnce(): Promise<ReconciliationPreview> { return this.summary(await this.planOnce()); }
	private async planOnce(selection?: string[]): Promise<ReconciliationPlan> {
		const existing = await this.readIntent();
		// Complete an already admitted #68 plan without expanding its frozen effects.
		// A subsequent explicit preview may then migrate the resulting grouping.
		const completed = existing?.items.every(item => item.oldUnlinked || item.retired);
		for (const item of existing?.items ?? []) {
			if (selection && !selection.includes(item.conversationId)) continue;
			const retired = this.options.registry.retirement(item.conversationId);
			if (item.retired && !retired) throw new RelayRegistryError("invalid_state", "Migration retirement authority is missing");
			if (retired) item.retired = true;
		}
		if (existing && !(this.options.hierarchy && completed)) {
			if (!isDeepStrictEqual(existing.selection, selection)) {
				if (selection && !existing.selection && selection.every(id => existing.items.some(item => item.conversationId === id))) {
					const items = existing.items.filter(item => selection.includes(item.conversationId));
					return { version: 1, selection, items, reconciliationKey: planKey(items, selection), continuationOf: existing.reconciliationKey };
				}
				throw new HostControlError("conflict", "An unfinished reconciliation must retain its original selection; finish that plan before selecting different conversations");
			}
			return existing;
		}
		const stableSpaces = new Map<string, string>();
		for (const manifest of this.options.registry.listManifests()) if ((!selection || selection.includes(manifest.conversationId)) && manifest.kind === "project" && manifest.projectKey && manifest.projectSpace) {
			const preferred = this.options.hierarchy?.migrationProjectSpace(manifest.projectKey);
			const prior = stableSpaces.get(manifest.projectKey); if (!preferred && prior && prior !== manifest.projectSpace) throw new RelayRegistryError("invalid_state", "Stable project identity maps to conflicting Matrix Spaces");
			stableSpaces.set(manifest.projectKey, preferred ?? manifest.projectSpace);
		}
		const compatibility = this.options.registry.listManifests().filter((item) => (!selection || selection.includes(item.conversationId)) && item.kind === "project" && (this.options.hierarchy ? !item.checkoutSpace : !item.projectKey)).sort((a, b) => a.conversationId.localeCompare(b.conversationId));
		const coordinator = this.options.registry.listManifests().find((item) => item.kind === "coordinator");
		if (compatibility.length > 0 && coordinator?.kind === "coordinator" && coordinator.hostSpace) {
			await this.options.matrix.assertRoomAuthority(coordinator.hostSpace, true, undefined, { spaceChild: true });
			if (this.options.hierarchy) await this.options.matrix.inspectLegacyProvenance(coordinator.hostSpace,
				{ version: 1, hostId: this.options.registry.hostId, kind: "host_space", creationKey: "host" });
		}
		const items: ReconciliationItem[] = [];
		for (const manifest of compatibility) {
			let stage = "workspace and identity verification";
			try {
			if (!manifest.placement) throw new RelayRegistryError("invalid_state", "Compatibility project manifest omitted workspace placement");
			if (this.options.hierarchy && manifest.conversationId !== deriveConversationId(this.options.registry.hostId, manifest.creationKey)) throw new RelayRegistryError("invalid_state", "Legacy conversation identity requires explicit recovery");
			const resolved = await this.options.resolveWorkspace(manifest.placement);
			stage = "Matrix room and ancestor ownership verification";
			await this.options.matrix.assertRoomAuthority(manifest.roomId, false);
			if (manifest.projectKey && manifest.projectKey !== resolved.projectKey) throw new RelayRegistryError("invalid_state", "Saved project identity differs from current placement");
			let targetProjectSpace = this.options.hierarchy?.migrationProjectSpace(resolved.projectKey) ?? stableSpaces.get(resolved.projectKey);
			if (!targetProjectSpace) targetProjectSpace = await this.spaces.find(resolved.projectKey);
			if (targetProjectSpace) { stableSpaces.set(resolved.projectKey, targetProjectSpace); await this.options.matrix.assertRoomAuthority(targetProjectSpace, true, undefined, { spaceChild: true }); }
			if (manifest.projectSpace) await this.options.matrix.assertRoomAuthority(manifest.projectSpace, true, undefined, { spaceChild: true });
			if (this.options.hierarchy) {
				if (manifest.projectSpace) await this.verifyLegacyParent(manifest.projectSpace, resolved.projectKey);
				const proof = await this.options.matrix.inspectLegacyRoom(manifest.roomId, false);
				if (proof && !this.options.hierarchy.accountInventory().some(node => node.roomId === manifest.roomId && isDeepStrictEqual(node.provenance, proof)))
					throw new RelayRegistryError("invalid_state", "Legacy room has an unrecognized existing ownership proof");
				if (targetProjectSpace) {
					const existing = this.options.hierarchy.accountInventory().find(node => node.roomId === targetProjectSpace);
					await this.options.matrix.inspectLegacyProvenance(targetProjectSpace, existing?.provenance ?? { version: 1, hostId: this.options.registry.hostId,
						kind: "project_space", projectKey: resolved.projectKey, creationKey: resolved.projectKey, parentRoomId: coordinator!.hostSpace! });
				}
			}
			const sourceManifestHash = this.options.hierarchy ? projectGroupingHash(manifest) : hash(manifest); const target = !this.options.hierarchy && targetProjectSpace ? { ...manifest, projectKey: resolved.projectKey, projectDisplayName: resolved.projectDisplayName,
				checkoutDisplayName: resolved.checkoutDisplayName, projectSpace: targetProjectSpace } : undefined;
			items.push({ conversationId: manifest.conversationId, concept: manifest.concept, workspace: manifest.placement.workspace, roomId: manifest.roomId,
				...(manifest.projectSpace ? { oldProjectSpace: manifest.projectSpace } : {}), projectKey: resolved.projectKey, projectDisplayName: resolved.projectDisplayName,
				checkoutDisplayName: resolved.checkoutDisplayName, sourceManifestHash,
				...(this.options.hierarchy ? { checkout: { creationKey: manifest.creationKey, root: resolved.workspacePath, hostSpace: coordinator?.hostSpace ?? "", placement: manifest.placement,
					checkoutId: deriveCheckoutId(this.options.registry.hostId, resolved.projectKey, resolved.workspacePath) },
					...(targetProjectSpace ? { plannedProjectSpace: targetProjectSpace, targetProjectSpace } : {}) } : {}), ...(target ? { plannedProjectSpace: targetProjectSpace, targetProjectSpace, targetManifestHash: hash(target) } : {}),
				hostLinked: false, roomLinked: false, manifestUpdated: false, oldUnlinked: false });
			} catch (error) {
				if (!selection) throw error;
				throw new HostControlError("conflict", `${manifest.conversationId} (${manifest.concept}): ${stage} failed; inspect this target or exclude it from the selection`);
			}
		}
		if (items.length > 64) throw new RelayRegistryError("capacity_reached", "Project reconciliation preview exceeds 64 conversations");
		const intent: ReconciliationIntent = { version: 1, reconciliationKey: planKey(items, selection), items, ...(selection ? { selection } : {}) };
		return parseIntent(intent);
	}
	private async verifyLegacyParent(roomId: string, projectKey: string): Promise<void> {
		const proof = await this.options.matrix.inspectLegacyRoom(roomId, true);
		if (proof && (proof.hostId !== this.options.registry.hostId || proof.kind !== "project_space" || proof.projectKey !== projectKey))
			throw new RelayRegistryError("invalid_state", "Legacy parent ownership changed");
	}
	private async applyOnce(reconciliationKey: string, legacyPlacements?: LiveSpacePreview["legacyPlacements"], selection?: string[], continuationOf?: string): Promise<Record<string, unknown>> {
		let intent = await this.readIntent(); const retry = intent !== undefined;
		if (continuationOf && (!intent || intent.selection || intent.reconciliationKey !== continuationOf || !selection ||
			!selection.every(id => intent!.items.some(item => item.conversationId === id)) ||
			planKey(intent.items.filter(item => selection.includes(item.conversationId)), selection) !== reconciliationKey)) throw new RelayRegistryError("invalid_state", "Original broad reconciliation changed");
		if (!intent || !continuationOf && this.options.hierarchy && intent.items.every(item => item.oldUnlinked || item.retired)) {
			const previous = intent;
			intent = await this.planOnce(selection);
			if (intent.reconciliationKey !== reconciliationKey) throw new RelayRegistryError("invalid_state", "Reconciliation preview changed before apply");
			if (previous) {
				const receipt = new AtomicJsonFile(join(resolve(this.options.intentDirectory), `project-reconciliation-${previous.reconciliationKey}.json`), parseIntent);
				const saved = await receipt.read();
				if (saved && !isDeepStrictEqual(saved, previous)) throw new RelayRegistryError("invalid_state", "Prior reconciliation receipt changed");
				if (!saved) await receipt.write(previous);
			}
			await this.file.write(intent);
		}
		if (intent.reconciliationKey !== (continuationOf ?? reconciliationKey)) throw new RelayRegistryError("invalid_state", "Reconciliation key does not match the durable intent");
		const coordinator = this.options.registry.listManifests().find((item) => item.kind === "coordinator");
		for (let index = 0; index < intent.items.length; index += 1) {
			let item = intent.items[index]!;
			if (continuationOf && !selection!.includes(item.conversationId)) continue;
			if (item.oldUnlinked) continue;
			if (this.options.registry.retirement(item.conversationId)) {
				if (!item.retired) { item = { ...item, retired: true }; intent.items[index] = item; await this.file.write(intent); }
				continue;
			}
			if (item.retired) throw new RelayRegistryError("invalid_state", "Migration retirement authority is missing");
			const manifest = this.options.registry.manifestByConversationId(item.conversationId);
			if (!manifest || manifest.kind !== "project") throw new RelayRegistryError("invalid_state", "Reconciliation conversation disappeared");
			if (item.checkout) {
				if (item.oldUnlinked) continue;
				const frozen = item.checkout, resolved = await this.options.resolveWorkspace(frozen.placement);
				if (!this.options.hierarchy || this.options.registry.retirement(item.conversationId) || coordinator?.hostSpace !== frozen.hostSpace ||
					resolved.workspacePath !== frozen.root || resolved.projectKey !== item.projectKey ||
					deriveConversationId(this.options.registry.hostId, frozen.creationKey) !== item.conversationId || manifest.roomId !== item.roomId ||
					deriveCheckoutId(this.options.registry.hostId, resolved.projectKey, resolved.workspacePath) !== frozen.checkoutId ||
					![item.sourceManifestHash, item.targetManifestHash].includes(projectGroupingHash(manifest))) throw new RelayRegistryError("invalid_state", "Frozen migration placement or grouping changed");
				if (item.oldProjectSpace) await this.verifyLegacyParent(item.oldProjectSpace, item.projectKey);
				const binding = await this.options.hierarchy.migrateExisting({ creationKey: frozen.creationKey, projectKey: item.projectKey,
					canonicalCheckoutRoot: frozen.root, projectTitle: item.projectDisplayName, checkoutTitle: item.checkoutDisplayName, conversationTitle: item.concept }, item.roomId, item.targetProjectSpace);
				for (const [parent, child] of [[binding.hostSpace, binding.projectSpace], [binding.projectSpace, binding.checkoutSpace], [binding.checkoutSpace, binding.roomId]]) {
					if (!(await this.options.matrix.spaceChildren(parent!)).includes(child!)) throw new HostControlError("conflict", "New hierarchy link readback failed; old links and manifest are retained until verification succeeds");
				}
				const identity = { projectKey: item.projectKey, projectDisplayName: item.projectDisplayName, checkoutDisplayName: item.checkoutDisplayName,
					projectSpace: binding.projectSpace, checkoutId: binding.checkoutId, checkoutSpace: binding.checkoutSpace };
				item = { ...item, targetProjectSpace: binding.projectSpace, targetCheckoutSpace: binding.checkoutSpace,
					targetManifestHash: projectGroupingHash({ ...manifest, ...identity }), hostLinked: true, roomLinked: true };
				intent.items[index] = item; await this.file.write(intent);
				await this.options.registry.reconcileProjectManifest(item.conversationId, item.sourceManifestHash, item.targetManifestHash!, identity, true);
				item = { ...item, manifestUpdated: true }; intent.items[index] = item; await this.file.write(intent);
			} else {
				if (![item.sourceManifestHash, item.targetManifestHash].includes(hash(manifest))) throw new RelayRegistryError("invalid_state", "Legacy reconciliation source changed; explicit recovery required");
				const frozen = legacyPlacements?.find(saved => saved.conversationId === item.conversationId);
				if (legacyPlacements && !item.oldUnlinked && (!frozen || frozen.hostSpace !== coordinator?.hostSpace || !manifest.placement || !isDeepStrictEqual(frozen.workspace, await this.options.resolveWorkspace(manifest.placement)))) throw new RelayRegistryError("invalid_state", "Legacy project placement changed");
			}
			if (!item.targetProjectSpace) {
				const shared = intent.items.find((candidate) => candidate.projectKey === item.projectKey && candidate.targetProjectSpace)?.targetProjectSpace;
				const spaceId = shared ?? await this.spaces.ensure(item.projectKey, item.projectDisplayName, retry);
				const target = { ...manifest, projectKey: item.projectKey, projectDisplayName: item.projectDisplayName, checkoutDisplayName: item.checkoutDisplayName, projectSpace: spaceId };
				item = { ...item, targetProjectSpace: spaceId, targetManifestHash: hash(target) }; intent.items[index] = item; await this.file.write(intent);
			}
			const targetSpace = item.targetProjectSpace; const targetManifestHash = item.targetManifestHash;
			if (!targetSpace || !targetManifestHash) throw new RelayRegistryError("invalid_state", "Reconciliation target Space identity is unavailable");
			if (!item.checkout) await this.spaces.assertTarget(item.projectKey, targetSpace);
			await this.options.matrix.assertRoomAuthority(item.roomId, false); await this.options.matrix.assertRoomAuthority(targetSpace, true, undefined, { spaceChild: true });
			if (item.oldProjectSpace) await this.options.matrix.assertRoomAuthority(item.oldProjectSpace, true, undefined, { spaceChild: true });
			if (!item.hostLinked) { if (coordinator?.kind === "coordinator" && coordinator.hostSpace) {
				await this.options.matrix.assertRoomAuthority(coordinator.hostSpace, true, undefined, { spaceChild: true });
				await this.options.matrix.addSpaceChild(coordinator.hostSpace, targetSpace);
			}
				item = { ...item, hostLinked: true }; intent.items[index] = item; await this.file.write(intent); }
			if (!item.roomLinked) { await this.options.matrix.addSpaceChild(targetSpace, item.roomId); item = { ...item, roomLinked: true }; intent.items[index] = item; await this.file.write(intent); }
			if (!item.manifestUpdated) { await this.options.registry.reconcileProjectManifest(item.conversationId, item.sourceManifestHash, targetManifestHash,
				{ projectKey: item.projectKey, projectDisplayName: item.projectDisplayName, checkoutDisplayName: item.checkoutDisplayName, projectSpace: targetSpace });
				item = { ...item, manifestUpdated: true }; intent.items[index] = item; await this.file.write(intent); }
			if (!item.oldUnlinked) {
				if (item.checkout && item.oldProjectSpace) await this.verifyLegacyParent(item.oldProjectSpace, item.projectKey);
				if (this.options.registry.retirement(item.conversationId)) throw new RelayRegistryError("invalid_state", "Retirement superseded migration");
				if (item.oldProjectSpace && item.oldProjectSpace !== (item.targetCheckoutSpace ?? targetSpace)) await this.options.matrix.removeSpaceChild(item.oldProjectSpace, item.roomId);
				item = { ...item, oldUnlinked: true }; intent.items[index] = item; await this.file.write(intent); }
		}
		// Old parent IDs stay in the item/receipt, not in new destructive authority.
		// Pre-existing #68 cleanup records remain readable for backup/recovery only.
		if (!intent.cleanupSpaces) { intent = { ...intent, cleanupSpaces: [] }; await this.file.write(intent); }
		return { operation: "project.reconcile.apply", reconciliationKey, reconciled: intent.items.filter(item => !item.retired && (!continuationOf || selection!.includes(item.conversationId))).length, obsoleteSpaces: 0 };
	}
	private async cleanupOnce(_reconciliationKey: string): Promise<Record<string, unknown>> {
		throw new RelayRegistryError("permission_denied", "Legacy Space cleanup requires a fresh modern ownership preview; retained IDs are not destructive authority");
	}
}
