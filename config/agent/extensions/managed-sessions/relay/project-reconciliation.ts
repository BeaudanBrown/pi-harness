import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { LiveHierarchy, type HierarchyLink, type HierarchySpaceIdentity } from "./live-hierarchy.js";
import { lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { deriveConversationId, WorkspaceIdentitySchema, type WorkspaceIdentity } from "../contracts.js";
import { Check } from "typebox/value";
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
interface ReconciliationIntent { version: 1; reconciliationKey: string; items: ReconciliationItem[]; cleanupSpaces?: CleanupSpace[] }

const id = /^![^\s:]{1,200}:[^\s]{1,200}$/;
const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const planIdentity = (item: ReconciliationItem) => ({ conversationId: item.conversationId, concept: item.concept, workspace: item.workspace,
	roomId: item.roomId, ...(item.oldProjectSpace ? { oldProjectSpace: item.oldProjectSpace } : {}), projectKey: item.projectKey,
	projectDisplayName: item.projectDisplayName, checkoutDisplayName: item.checkoutDisplayName, sourceManifestHash: item.sourceManifestHash,
	...(item.plannedProjectSpace ? { plannedProjectSpace: item.plannedProjectSpace } : {}), ...(item.checkout ? { checkout: item.checkout } : {}) });

function parseIntent(value: unknown): ReconciliationIntent {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new RelayRegistryError("invalid_state", "Project reconciliation intent is malformed");
	const record = value as Record<string, unknown>;
	if (Object.keys(record).some((key) => !["version", "reconciliationKey", "items", "cleanupSpaces"].includes(key)) || record.version !== 1 ||
		typeof record.reconciliationKey !== "string" || !/^reconcile_[a-f0-9]{32}$/.test(record.reconciliationKey) || !Array.isArray(record.items) || record.items.length > 64 ||
		(record.cleanupSpaces !== undefined && (!Array.isArray(record.cleanupSpaces) || record.cleanupSpaces.length > 64))) throw new RelayRegistryError("invalid_state", "Project reconciliation intent is malformed");
	for (const item of record.items as unknown[]) {
		if (typeof item !== "object" || item === null || Array.isArray(item)) throw new RelayRegistryError("invalid_state", "Project reconciliation item is malformed");
		const entry = item as Record<string, unknown>; const allowed = ["conversationId", "concept", "workspace", "roomId", "oldProjectSpace", "projectKey", "projectDisplayName", "checkoutDisplayName", "sourceManifestHash", "plannedProjectSpace", "targetManifestHash", "targetProjectSpace", "checkout", "targetCheckoutSpace", "retired", "hostLinked", "roomLinked", "manifestUpdated", "oldUnlinked"];
		if (Object.keys(entry).some((key) => !allowed.includes(key)) || typeof entry.conversationId !== "string" || !/^conv_[a-f0-9]{32}$/.test(entry.conversationId) ||
			![entry.concept, entry.workspace].every((field) => typeof field === "string" && field.length > 0 && field.length <= 128 && !/[\u0000-\u001f\u007f]/.test(field)) ||
			![entry.projectDisplayName, entry.checkoutDisplayName].every((field) => typeof field === "string" && field.length > 0 && field.length <= 128 && !/[\u0000-\u001f\u007f/]/.test(field)) ||
			typeof entry.roomId !== "string" || !id.test(entry.roomId) || typeof entry.projectKey !== "string" || !/^project_[a-f0-9]{32}$/.test(entry.projectKey) ||
			typeof entry.sourceManifestHash !== "string" || !/^[a-f0-9]{64}$/.test(entry.sourceManifestHash) ||
			[entry.oldProjectSpace, entry.plannedProjectSpace, entry.targetProjectSpace, entry.targetCheckoutSpace].some((field) => field !== undefined && (typeof field !== "string" || !id.test(field))) ||
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
				!id.test(checkout.hostSpace) || !Check(WorkspaceIdentitySchema, checkout.placement) || !/^checkout_[a-f0-9]{32}$/.test(checkout.checkoutId) ||
				(entry.hostLinked && !entry.targetCheckoutSpace)) throw new RelayRegistryError("invalid_state", "Checkout migration identity is malformed");
		} else if (entry.targetCheckoutSpace) throw new RelayRegistryError("invalid_state", "Checkout migration source is missing");
	}
	const typedItems = record.items as unknown as ReconciliationItem[];
	if (new Set(typedItems.map((item) => item.conversationId)).size !== typedItems.length ||
		`reconcile_${hash(typedItems.map(planIdentity)).slice(0, 32)}` !== record.reconciliationKey) throw new RelayRegistryError("invalid_state", "Project reconciliation identity is inconsistent");
	for (const item of (record.cleanupSpaces ?? []) as unknown[]) {
		if (typeof item !== "object" || item === null || Array.isArray(item) || Object.keys(item).some((key) => !["spaceId", "hostUnlinked", "operatorRemoved", "left"].includes(key))) throw new RelayRegistryError("invalid_state", "Project cleanup intent is malformed");
		const entry = item as Record<string, unknown>;
		if (typeof entry.spaceId !== "string" || !id.test(entry.spaceId) || typeof entry.hostUnlinked !== "boolean" || typeof entry.operatorRemoved !== "boolean" || typeof entry.left !== "boolean" || entry.operatorRemoved && !entry.hostUnlinked || entry.left && !entry.operatorRemoved) throw new RelayRegistryError("invalid_state", "Project cleanup intent is malformed");
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

export interface LiveSpacePreview { links: HierarchyLink[]; operatorUserId: string; botUserId: string; migration?: ReconciliationIntent;
	legacyPlacements?: Array<{ conversationId: string; hostSpace: string; workspace: ResolvedWorkspace }> }
export interface SpaceCleanupAccount {
	leaveAndForget(target: HierarchySpaceIdentity, signal: AbortSignal): Promise<boolean>;
	completed(target: HierarchySpaceIdentity, signal: AbortSignal): Promise<boolean>;
}

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

	/** Read-only preview: saved live links plus the explicit, frozen legacy migration plan. */
	async previewLive(cleanup: boolean): Promise<LiveSpacePreview> {
		const hierarchy = this.options.hierarchy; if (!hierarchy) throw new RelayRegistryError("invalid_state", "Live hierarchy is unavailable");
		const links = hierarchy.maintenanceLinks(cleanup);
		if (links.length > 100) throw new RelayRegistryError("invalid_state", "Live Space preview exceeds bounds");
		const result: HierarchyLink[] = [];
		for (const link of links) {
			if (cleanup && hierarchy.spaceRetirement(this.spaceIdentity(link)) === "pending" && !await this.options.matrix.accountJoined(link.child.roomId)) { result.push(link); continue; }
			await this.verifyLink(link);
			if (!cleanup || await this.emptySpace(link)) result.push(link);
		}
		const migration = cleanup ? undefined : await this.planOnce();
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
			...(migration?.items.length ? { migration } : {}), ...(legacyPlacements.length ? { legacyPlacements } : {}) };
	}
	applyLive(frozen: LiveSpacePreview, cleanup: boolean): Promise<{ remaining: number }> {
		const snapshot = structuredClone(frozen);
		return this.serial(async () => {
			const hierarchy = this.options.hierarchy; if (!hierarchy || !isDeepStrictEqual(await this.previewLive(cleanup), snapshot)) throw new RelayRegistryError("invalid_state", "Live Space preview changed");
			let remaining = 0;
			if (snapshot.migration) {
				if (cleanup) throw new RelayRegistryError("invalid_state", "Migration is not cleanup authority");
				await this.applyOnce(snapshot.migration.reconciliationKey, snapshot.legacyPlacements);
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
	private async emptySpace(link: HierarchyLink, signal?: AbortSignal): Promise<boolean> {
		const { matrix, hierarchy, registry } = this.options; const roomId = link.child.roomId;
		if (!["project_space", "worktree_space"].includes(link.child.provenance.kind) || hierarchy!.hasReferences(roomId, (id) => Boolean(registry.retirement(id)))) return false;
		if ([...registry.listManifests(), ...registry.localConversations()].some((manifest) => {
			const binding = "verifiedBinding" in manifest ? manifest.verifiedBinding : manifest;
			return binding && (binding.projectSpace === roomId || ("checkoutSpace" in binding && binding.checkoutSpace === roomId));
		})) return false;
		await matrix.assertRoomAuthority(roomId, true, signal, { spaceChild: true });
		if ((await matrix.spaceChildren(roomId, signal)).length) return false;
		return [...await matrix.joinedMemberIds(roomId, signal)].every((id) => id === matrix.operatorUserId || id === matrix.botUserId);
	}
	private async cleanupLiveSpace(link: HierarchyLink, signal: AbortSignal): Promise<boolean> {
		const { matrix, hierarchy, account } = this.options; const target = this.spaceIdentity(link);
		if (hierarchy!.spaceRetirement(target) === "pending" && !await matrix.accountJoined(target.roomId, signal)) {
			if (!await account?.completed(target, signal)) return false;
			await hierarchy!.completeSpace(target); return true;
		}
		await this.verifyLink(link, signal); if (!await this.emptySpace(link, signal)) throw new RelayRegistryError("invalid_state", "Live Space is no longer empty or exclusively managed");
		await hierarchy!.fenceSpace(target);
		// No kicks or credential fallback. Account execution is the separately configured NAS port.
		if (!account) return false;
		await this.verifyLink(link, signal); if (!await this.emptySpace(link, signal)) return false;
		if (!await account.leaveAndForget(target, signal)) return false;
		await this.verifyLink(link, signal); if (!await this.emptySpace(link, signal)) return false;
		if ((await matrix.spaceChildren(link.parent.roomId, signal)).includes(target.roomId)) await matrix.removeSpaceChild(link.parent.roomId, target.roomId, signal);
		await this.verifyLink(link, signal); if (!await this.emptySpace(link, signal)) return false;
		signal.throwIfAborted(); await matrix.leaveRoom(target.roomId, signal);
		if (await matrix.accountJoined(target.roomId, signal) || !await account.completed(target, signal)) return false;
		await hierarchy!.completeSpace(target); return true;
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
	private async planOnce(): Promise<ReconciliationIntent> {
		const existing = await this.readIntent();
		// Complete an already admitted #68 plan without expanding its frozen effects.
		// A subsequent explicit preview may then migrate the resulting grouping.
		const completed = existing?.items.every(item => item.oldUnlinked || item.retired);
		for (const item of existing?.items ?? []) {
			const retired = this.options.registry.retirement(item.conversationId);
			if (item.retired && !retired) throw new RelayRegistryError("invalid_state", "Migration retirement authority is missing");
			if (retired) item.retired = true;
		}
		if (existing && !(this.options.hierarchy && completed)) return existing;
		const stableSpaces = new Map<string, string>();
		for (const manifest of this.options.registry.listManifests()) if (manifest.kind === "project" && manifest.projectKey && manifest.projectSpace) {
			const preferred = this.options.hierarchy?.migrationProjectSpace(manifest.projectKey);
			const prior = stableSpaces.get(manifest.projectKey); if (!preferred && prior && prior !== manifest.projectSpace) throw new RelayRegistryError("invalid_state", "Stable project identity maps to conflicting Matrix Spaces");
			stableSpaces.set(manifest.projectKey, preferred ?? manifest.projectSpace);
		}
		const compatibility = this.options.registry.listManifests().filter((item) => item.kind === "project" && (this.options.hierarchy ? !item.checkoutSpace : !item.projectKey)).sort((a, b) => a.conversationId.localeCompare(b.conversationId));
		const coordinator = this.options.registry.listManifests().find((item) => item.kind === "coordinator");
		if (compatibility.length > 0 && coordinator?.kind === "coordinator" && coordinator.hostSpace) {
			await this.options.matrix.assertRoomAuthority(coordinator.hostSpace, true, undefined, { spaceChild: true });
			if (this.options.hierarchy) await this.options.matrix.inspectLegacyProvenance(coordinator.hostSpace,
				{ version: 1, hostId: this.options.registry.hostId, kind: "host_space", creationKey: "host" });
		}
		const items: ReconciliationItem[] = [];
		for (const manifest of compatibility) {
			if (!manifest.placement) throw new RelayRegistryError("invalid_state", "Compatibility project manifest omitted workspace placement");
			if (this.options.hierarchy && manifest.conversationId !== deriveConversationId(this.options.registry.hostId, manifest.creationKey)) throw new RelayRegistryError("invalid_state", "Legacy conversation identity requires explicit recovery");
			const resolved = await this.options.resolveWorkspace(manifest.placement); await this.options.matrix.assertRoomAuthority(manifest.roomId, false);
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
		}
		if (items.length > 64) throw new RelayRegistryError("capacity_reached", "Project reconciliation preview exceeds 64 conversations");
		const intent: ReconciliationIntent = { version: 1, reconciliationKey: `reconcile_${hash(items.map(planIdentity)).slice(0, 32)}`, items };
		return parseIntent(intent);
	}
	private async verifyLegacyParent(roomId: string, projectKey: string): Promise<void> {
		const proof = await this.options.matrix.inspectLegacyRoom(roomId, true);
		if (proof && (proof.hostId !== this.options.registry.hostId || proof.kind !== "project_space" || proof.projectKey !== projectKey))
			throw new RelayRegistryError("invalid_state", "Legacy parent ownership changed");
	}
	private async applyOnce(reconciliationKey: string, legacyPlacements?: LiveSpacePreview["legacyPlacements"]): Promise<Record<string, unknown>> {
		let intent = await this.readIntent(); const retry = intent !== undefined;
		if (!intent || this.options.hierarchy && intent.items.every(item => item.oldUnlinked || item.retired)) {
			const previous = intent;
			intent = await this.planOnce();
			if (intent.reconciliationKey !== reconciliationKey) throw new RelayRegistryError("invalid_state", "Reconciliation preview changed before apply");
			if (previous) {
				const receipt = new AtomicJsonFile(join(resolve(this.options.intentDirectory), `project-reconciliation-${previous.reconciliationKey}.json`), parseIntent);
				const saved = await receipt.read();
				if (saved && !isDeepStrictEqual(saved, previous)) throw new RelayRegistryError("invalid_state", "Prior reconciliation receipt changed");
				if (!saved) await receipt.write(previous);
			}
			await this.file.write(intent);
		}
		if (intent.reconciliationKey !== reconciliationKey) throw new RelayRegistryError("invalid_state", "Reconciliation key does not match the durable intent");
		const coordinator = this.options.registry.listManifests().find((item) => item.kind === "coordinator");
		for (let index = 0; index < intent.items.length; index += 1) {
			let item = intent.items[index]!;
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
		return { operation: "project.reconcile.apply", reconciliationKey, reconciled: intent.items.filter(item => !item.retired).length, obsoleteSpaces: 0 };
	}
	private async cleanupOnce(_reconciliationKey: string): Promise<Record<string, unknown>> {
		throw new RelayRegistryError("permission_denied", "Legacy Space cleanup requires a fresh modern ownership preview; retained IDs are not destructive authority");
	}
}
