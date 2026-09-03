import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { WorkspaceIdentity } from "../contracts.js";
import { AtomicJsonFile } from "./atomic-json.js";
import type { ResolvedWorkspace } from "./host-lifecycle.js";
import { ManagedMatrixClient } from "./matrix-client.js";
import { RelayRegistry, RelayRegistryError } from "./registry.js";

interface ReconciliationItem {
	conversationId: string; concept: string; workspace: string; roomId: string; oldProjectSpace?: string;
	projectKey: string; projectDisplayName: string; checkoutDisplayName: string;
	sourceManifestHash: string; plannedProjectSpace?: string; targetManifestHash?: string; targetProjectSpace?: string;
	hostLinked: boolean; roomLinked: boolean; manifestUpdated: boolean; oldUnlinked: boolean;
}
interface CleanupSpace { spaceId: string; hostUnlinked: boolean; operatorRemoved: boolean; left: boolean }
interface ReconciliationIntent { version: 1; reconciliationKey: string; items: ReconciliationItem[]; cleanupSpaces?: CleanupSpace[] }

const id = /^![^\s:]{1,200}:[^\s]{1,200}$/;
const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const planIdentity = (item: ReconciliationItem) => ({ conversationId: item.conversationId, concept: item.concept, workspace: item.workspace,
	roomId: item.roomId, ...(item.oldProjectSpace ? { oldProjectSpace: item.oldProjectSpace } : {}), projectKey: item.projectKey,
	projectDisplayName: item.projectDisplayName, checkoutDisplayName: item.checkoutDisplayName, sourceManifestHash: item.sourceManifestHash,
	...(item.plannedProjectSpace ? { plannedProjectSpace: item.plannedProjectSpace } : {}) });

function parseIntent(value: unknown): ReconciliationIntent {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new RelayRegistryError("invalid_state", "Project reconciliation intent is malformed");
	const record = value as Record<string, unknown>;
	if (Object.keys(record).some((key) => !["version", "reconciliationKey", "items", "cleanupSpaces"].includes(key)) || record.version !== 1 ||
		typeof record.reconciliationKey !== "string" || !/^reconcile_[a-f0-9]{32}$/.test(record.reconciliationKey) || !Array.isArray(record.items) || record.items.length > 64 ||
		(record.cleanupSpaces !== undefined && (!Array.isArray(record.cleanupSpaces) || record.cleanupSpaces.length > 64))) throw new RelayRegistryError("invalid_state", "Project reconciliation intent is malformed");
	for (const item of record.items as unknown[]) {
		if (typeof item !== "object" || item === null || Array.isArray(item)) throw new RelayRegistryError("invalid_state", "Project reconciliation item is malformed");
		const entry = item as Record<string, unknown>; const allowed = ["conversationId", "concept", "workspace", "roomId", "oldProjectSpace", "projectKey", "projectDisplayName", "checkoutDisplayName", "sourceManifestHash", "plannedProjectSpace", "targetManifestHash", "targetProjectSpace", "hostLinked", "roomLinked", "manifestUpdated", "oldUnlinked"];
		if (Object.keys(entry).some((key) => !allowed.includes(key)) || typeof entry.conversationId !== "string" || !/^conv_[a-f0-9]{32}$/.test(entry.conversationId) ||
			![entry.concept, entry.workspace].every((field) => typeof field === "string" && field.length > 0 && field.length <= 128 && !/[\u0000-\u001f\u007f]/.test(field)) ||
			![entry.projectDisplayName, entry.checkoutDisplayName].every((field) => typeof field === "string" && field.length > 0 && field.length <= 128 && !/[\u0000-\u001f\u007f/]/.test(field)) ||
			typeof entry.roomId !== "string" || !id.test(entry.roomId) || typeof entry.projectKey !== "string" || !/^project_[a-f0-9]{32}$/.test(entry.projectKey) ||
			typeof entry.sourceManifestHash !== "string" || !/^[a-f0-9]{64}$/.test(entry.sourceManifestHash) ||
			[entry.oldProjectSpace, entry.plannedProjectSpace, entry.targetProjectSpace].some((field) => field !== undefined && (typeof field !== "string" || !id.test(field))) ||
			(entry.targetManifestHash !== undefined && (typeof entry.targetManifestHash !== "string" || !/^[a-f0-9]{64}$/.test(entry.targetManifestHash))) ||
			(entry.plannedProjectSpace !== undefined && entry.targetProjectSpace !== entry.plannedProjectSpace) ||
			![entry.hostLinked, entry.roomLinked, entry.manifestUpdated, entry.oldUnlinked].every((field) => typeof field === "boolean") ||
			(entry.hostLinked && !entry.targetProjectSpace) || (entry.roomLinked && !entry.hostLinked) || (entry.manifestUpdated && (!entry.roomLinked || !entry.targetManifestHash)) || (entry.oldUnlinked && !entry.manifestUpdated)) {
			throw new RelayRegistryError("invalid_state", "Project reconciliation item is malformed");
		}
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

export class ProjectReconciler {
	private readonly path: string;
	private readonly file: AtomicJsonFile<ReconciliationIntent>;
	private running?: Promise<unknown>;
	constructor(private readonly options: { registry: RelayRegistry; matrix: ManagedMatrixClient; intentDirectory: string;
		resolveWorkspace: (placement: WorkspaceIdentity) => Promise<ResolvedWorkspace> }) {
		this.path = join(resolve(options.intentDirectory), "project-reconciliation.json"); this.file = new AtomicJsonFile(this.path, parseIntent);
	}

	pendingCount(): number { return this.options.registry.listManifests().filter((item) => item.kind === "project" && !item.projectKey).length; }

	preview(): Promise<ReconciliationPreview> { return this.serial(() => this.previewOnce()); }
	apply(reconciliationKey: string): Promise<Record<string, unknown>> { return this.serial(() => this.applyOnce(reconciliationKey)); }
	cleanup(reconciliationKey: string): Promise<Record<string, unknown>> { return this.serial(() => this.cleanupOnce(reconciliationKey)); }

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
		const completed = intent.items.filter((item) => item.oldUnlinked).length; const targets = new Set(intent.items.map((item) => item.targetProjectSpace));
		const stableReferences = new Set(this.options.registry.listManifests().filter((item) => item.kind === "project" && Boolean(item.projectKey)).map((item) => item.projectSpace));
		const projectedObsolete = new Set(intent.items.map((item) => item.oldProjectSpace).filter((space): space is string => Boolean(space) && !targets.has(space) && !stableReferences.has(space))).size;
		return { operation: "project.reconcile.preview", reconciliationKey: intent.reconciliationKey, pending: intent.items.length - completed, completed,
			items: intent.items.map((item) => ({ conversationId: item.conversationId, concept: item.concept, workspace: item.workspace,
				projectDisplayName: item.projectDisplayName, checkoutDisplayName: item.checkoutDisplayName, status: item.oldUnlinked ? "completed" : "pending" })),
			obsoleteSpaces: intent.cleanupSpaces?.filter((item) => !item.left).length ?? projectedObsolete };
	}
	private async previewOnce(): Promise<ReconciliationPreview> {
		const existing = await this.readIntent(); if (existing) return this.summary(existing);
		const stableSpaces = new Map<string, string>();
		for (const manifest of this.options.registry.listManifests()) if (manifest.kind === "project" && manifest.projectKey && manifest.projectSpace) {
			const prior = stableSpaces.get(manifest.projectKey); if (prior && prior !== manifest.projectSpace) throw new RelayRegistryError("invalid_state", "Stable project identity maps to conflicting Matrix Spaces");
			stableSpaces.set(manifest.projectKey, manifest.projectSpace);
		}
		const compatibility = this.options.registry.listManifests().filter((item) => item.kind === "project" && !item.projectKey).sort((a, b) => a.conversationId.localeCompare(b.conversationId));
		const coordinator = this.options.registry.listManifests().find((item) => item.kind === "coordinator");
		if (compatibility.length > 0 && coordinator?.kind === "coordinator" && coordinator.hostSpace) {
			await this.options.matrix.assertRoomAuthority(coordinator.hostSpace, true, undefined, { spaceChild: true });
		}
		const items: ReconciliationItem[] = [];
		for (const manifest of compatibility) {
			if (!manifest.placement) throw new RelayRegistryError("invalid_state", "Compatibility project manifest omitted workspace placement");
			const resolved = await this.options.resolveWorkspace(manifest.placement); await this.options.matrix.assertRoomAuthority(manifest.roomId, false);
			let targetProjectSpace = stableSpaces.get(resolved.projectKey);
			if (!targetProjectSpace) targetProjectSpace = await this.options.matrix.resolvePrivateRoomAlias(`pi-${resolved.projectKey.slice("project_".length)}-space`, true);
			if (targetProjectSpace) { stableSpaces.set(resolved.projectKey, targetProjectSpace); await this.options.matrix.assertRoomAuthority(targetProjectSpace, true, undefined, { spaceChild: true }); }
			if (manifest.projectSpace) await this.options.matrix.assertRoomAuthority(manifest.projectSpace, true, undefined, { spaceChild: true });
			const sourceManifestHash = hash(manifest); const target = targetProjectSpace ? { ...manifest, projectKey: resolved.projectKey, projectDisplayName: resolved.projectDisplayName,
				checkoutDisplayName: resolved.checkoutDisplayName, projectSpace: targetProjectSpace } : undefined;
			items.push({ conversationId: manifest.conversationId, concept: manifest.concept, workspace: manifest.placement.workspace, roomId: manifest.roomId,
				...(manifest.projectSpace ? { oldProjectSpace: manifest.projectSpace } : {}), projectKey: resolved.projectKey, projectDisplayName: resolved.projectDisplayName,
				checkoutDisplayName: resolved.checkoutDisplayName, sourceManifestHash, ...(target ? { plannedProjectSpace: targetProjectSpace, targetProjectSpace, targetManifestHash: hash(target) } : {}),
				hostLinked: false, roomLinked: false, manifestUpdated: false, oldUnlinked: false });
		}
		if (items.length > 64) throw new RelayRegistryError("capacity_reached", "Project reconciliation preview exceeds 64 conversations");
		const intent: ReconciliationIntent = { version: 1, reconciliationKey: `reconcile_${hash(items.map(planIdentity)).slice(0, 32)}`, items };
		return this.summary(intent);
	}
	private async applyOnce(reconciliationKey: string): Promise<Record<string, unknown>> {
		let intent = await this.readIntent();
		if (!intent) {
			const preview = await this.previewOnce(); if (preview.reconciliationKey !== reconciliationKey) throw new RelayRegistryError("invalid_state", "Reconciliation preview changed before apply");
			const stableSpaces = new Map<string, string>();
			for (const manifest of this.options.registry.listManifests()) if (manifest.kind === "project" && manifest.projectKey && manifest.projectSpace) stableSpaces.set(manifest.projectKey, manifest.projectSpace);
			const items: ReconciliationItem[] = [];
			for (const shown of preview.items) {
				const manifest = this.options.registry.manifestByConversationId(shown.conversationId); if (!manifest || manifest.kind !== "project" || !manifest.placement) throw new RelayRegistryError("invalid_state", "Reconciliation source manifest disappeared");
				const resolved = await this.options.resolveWorkspace(manifest.placement); const targetProjectSpace = stableSpaces.get(resolved.projectKey) ?? await this.options.matrix.resolvePrivateRoomAlias(`pi-${resolved.projectKey.slice("project_".length)}-space`, true);
				if (targetProjectSpace) stableSpaces.set(resolved.projectKey, targetProjectSpace);
				const target = targetProjectSpace ? { ...manifest, projectKey: resolved.projectKey, projectDisplayName: resolved.projectDisplayName, checkoutDisplayName: resolved.checkoutDisplayName, projectSpace: targetProjectSpace } : undefined;
				items.push({ conversationId: manifest.conversationId, concept: manifest.concept, workspace: manifest.placement.workspace, roomId: manifest.roomId,
					...(manifest.projectSpace ? { oldProjectSpace: manifest.projectSpace } : {}), projectKey: resolved.projectKey, projectDisplayName: resolved.projectDisplayName,
					checkoutDisplayName: resolved.checkoutDisplayName, sourceManifestHash: hash(manifest), ...(target ? { plannedProjectSpace: targetProjectSpace, targetProjectSpace, targetManifestHash: hash(target) } : {}),
					hostLinked: false, roomLinked: false, manifestUpdated: false, oldUnlinked: false });
			}
			intent = { version: 1, reconciliationKey: `reconcile_${hash(items.map(planIdentity)).slice(0, 32)}`, items };
			if (intent.reconciliationKey !== reconciliationKey) throw new RelayRegistryError("invalid_state", "Reconciliation preview changed before apply");
			await this.file.write(intent);
		}
		if (intent.reconciliationKey !== reconciliationKey) throw new RelayRegistryError("invalid_state", "Reconciliation key does not match the durable intent");
		const coordinator = this.options.registry.listManifests().find((item) => item.kind === "coordinator");
		for (let index = 0; index < intent.items.length; index += 1) {
			let item = intent.items[index]!; const manifest = this.options.registry.manifestByConversationId(item.conversationId);
			if (!manifest || manifest.kind !== "project") throw new RelayRegistryError("invalid_state", "Reconciliation conversation disappeared");
			if (!item.targetProjectSpace) {
				const shared = intent.items.find((candidate) => candidate.projectKey === item.projectKey && candidate.targetProjectSpace)?.targetProjectSpace;
				const spaceId = shared ?? await this.options.matrix.createPrivateSpaceIdempotent(item.projectDisplayName, `pi-${item.projectKey.slice("project_".length)}-space`);
				const target = { ...manifest, projectKey: item.projectKey, projectDisplayName: item.projectDisplayName, checkoutDisplayName: item.checkoutDisplayName, projectSpace: spaceId };
				item = { ...item, targetProjectSpace: spaceId, targetManifestHash: hash(target) }; intent.items[index] = item; await this.file.write(intent);
			}
			const targetSpace = item.targetProjectSpace; const targetManifestHash = item.targetManifestHash;
			if (!targetSpace || !targetManifestHash) throw new RelayRegistryError("invalid_state", "Reconciliation target Space identity is unavailable");
			const aliasSpace = await this.options.matrix.resolvePrivateRoomAlias(`pi-${item.projectKey.slice("project_".length)}-space`, true);
			if (aliasSpace !== targetSpace) throw new RelayRegistryError("invalid_state", "Reconciliation target Space no longer matches its deterministic alias");
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
			if (!item.oldUnlinked) { if (item.oldProjectSpace && item.oldProjectSpace !== targetSpace) await this.options.matrix.removeSpaceChild(item.oldProjectSpace, item.roomId);
				item = { ...item, oldUnlinked: true }; intent.items[index] = item; await this.file.write(intent); }
		}
		if (!intent.cleanupSpaces) {
			const targets = new Set(intent.items.map((item) => item.targetProjectSpace)); const referenced = new Set(this.options.registry.listManifests().map((item) => item.projectSpace).filter(Boolean));
			intent = { ...intent, cleanupSpaces: [...new Set(intent.items.map((item) => item.oldProjectSpace).filter((space): space is string => Boolean(space)))]
				.filter((space) => !targets.has(space) && !referenced.has(space)).sort().map((spaceId) => ({ spaceId, hostUnlinked: false, operatorRemoved: false, left: false })) }; await this.file.write(intent);
		}
		const cleanupSpaces = intent.cleanupSpaces;
		if (!cleanupSpaces) throw new RelayRegistryError("invalid_state", "Reconciliation cleanup inventory is unavailable");
		return { operation: "project.reconcile.apply", reconciliationKey, reconciled: intent.items.length, obsoleteSpaces: cleanupSpaces.length };
	}
	private async cleanupOnce(reconciliationKey: string): Promise<Record<string, unknown>> {
		let intent = await this.readIntent(); if (!intent || intent.reconciliationKey !== reconciliationKey || !intent.cleanupSpaces || intent.items.some((item) => !item.oldUnlinked)) {
			throw new RelayRegistryError("invalid_state", "Completed reconciliation is required before Space cleanup");
		}
		const coordinator = this.options.registry.listManifests().find((item) => item.kind === "coordinator"); let cleaned = 0;
		for (let index = 0; index < intent.cleanupSpaces.length; index += 1) {
			let item = intent.cleanupSpaces[index]!; if (item.left) continue;
			if (item.hostUnlinked && !await this.options.matrix.memberJoined(item.spaceId, this.options.matrix.botUserId)) {
				item = { ...item, left: true }; intent.cleanupSpaces[index] = item; await this.file.write(intent); cleaned += 1; continue;
			}
			if (this.options.registry.listManifests().some((manifest) => manifest.projectSpace === item.spaceId)) throw new RelayRegistryError("invalid_state", "Obsolete Space became referenced before cleanup");
			await this.options.matrix.assertRoomAuthority(item.spaceId, true, undefined, { spaceChild: true, kick: true });
			if ((await this.options.matrix.spaceChildren(item.spaceId)).length !== 0) throw new RelayRegistryError("invalid_state", "Obsolete managed project Space is not empty");
			if (!item.hostUnlinked) { if (coordinator?.kind === "coordinator" && coordinator.hostSpace) {
				await this.options.matrix.assertRoomAuthority(coordinator.hostSpace, true, undefined, { spaceChild: true });
				await this.options.matrix.removeSpaceChild(coordinator.hostSpace, item.spaceId);
			}
				item = { ...item, hostUnlinked: true }; intent.cleanupSpaces[index] = item; await this.file.write(intent); }
			if (!item.operatorRemoved) {
				if (await this.options.matrix.memberJoined(item.spaceId, this.options.matrix.operatorUserId)) await this.options.matrix.removeRoomMember(item.spaceId, this.options.matrix.operatorUserId);
				item = { ...item, operatorRemoved: true }; intent.cleanupSpaces[index] = item; await this.file.write(intent);
			}
			if (await this.options.matrix.memberJoined(item.spaceId, this.options.matrix.botUserId)) await this.options.matrix.leaveRoom(item.spaceId);
			item = { ...item, left: true }; intent.cleanupSpaces[index] = item; await this.file.write(intent); cleaned += 1;
		}
		return { operation: "project.space.cleanup", reconciliationKey, cleaned, remaining: intent.cleanupSpaces.filter((item) => !item.left).length };
	}
}
