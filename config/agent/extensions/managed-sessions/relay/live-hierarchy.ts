import { join } from "node:path";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { MatrixUserIdSchema } from "../identity-contracts.js";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { deriveConversationId, type ConversationManifest } from "../contracts.js";
import { deriveCheckoutId, parseManagedProvenance, safeManagedTitle, ManagedProvenanceSchema, type ManagedProvenance } from "../managed-provenance.js";
import { AtomicJsonFile, ensurePrivateDirectory } from "./atomic-json.js";
import { ManagedMatrixClient } from "./matrix-client.js";

const identifier = Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" });
const stable = (prefix: string) => Type.String({ pattern: `^${prefix}_[a-f0-9]{32}$` });
const room = Type.String({ pattern: "^![^\\s:]{1,200}:[^\\s]{1,200}$", maxLength: 255 });
const common = { key: identifier, creationKey: identifier, title: Type.String({ minLength: 1, maxLength: 256 }),
	roomId: Type.Optional(room), parentRoomId: Type.Optional(room), createAttempted: Type.Optional(Type.Literal(true)), linked: Type.Boolean() };
const NodeSchema = Type.Union([
	Type.Object({ ...common, kind: Type.Literal("host_space") }, { additionalProperties: false }),
	Type.Object({ ...common, kind: Type.Literal("project_space"), parentKey: identifier, projectKey: stable("project") }, { additionalProperties: false }),
	Type.Object({ ...common, kind: Type.Literal("worktree_space"), parentKey: identifier, projectKey: stable("project"), checkoutId: stable("checkout") }, { additionalProperties: false }),
	Type.Object({ ...common, kind: Type.Literal("conversation"), parentKey: identifier, projectKey: stable("project"), checkoutId: stable("checkout"), conversationId: stable("conv") }, { additionalProperties: false }),
]);
type Node = Static<typeof NodeSchema>;
const SpaceRetirementSchema = Type.Object({ roomId: room, provenance: ManagedProvenanceSchema,
	operatorUserId: MatrixUserIdSchema, botUserId: MatrixUserIdSchema, complete: Type.Boolean() }, { additionalProperties: false });
type SpaceRetirement = Static<typeof SpaceRetirementSchema>;
export type HierarchySpaceIdentity = Omit<SpaceRetirement, "complete">;
export interface HierarchyLink { projectKey: string; child: { roomId: string; provenance: ManagedProvenance }; parent: { roomId: string; provenance: ManagedProvenance } }
function spaceIdentity(target: HierarchySpaceIdentity): HierarchySpaceIdentity {
	return { roomId: target.roomId, provenance: target.provenance, operatorUserId: target.operatorUserId, botUserId: target.botUserId };
}
function successorKey(key: string, roomId: string): string { return `${key}.r.${createHash("sha256").update(roomId).digest("hex").slice(0, 32)}`; }
const StateSchema = Type.Object({ version: Type.Literal(1), hostId: identifier, nodes: Type.Array(NodeSchema, { maxItems: 16384 }),
	retiredSpaces: Type.Optional(Type.Array(SpaceRetirementSchema, { maxItems: 16384 })) }, { additionalProperties: false });
type State = Static<typeof StateSchema>;
function parse(value: unknown): State {
	if (!Check(StateSchema, value) || Buffer.byteLength(JSON.stringify(value)) > 16 * 1024 * 1024) throw Error("Invalid or full live hierarchy state");
	const retired = value.retiredSpaces ?? [];
	if (new Set(retired.map((item) => item.roomId)).size !== retired.length || retired.some((item) => item.provenance.hostId !== value.hostId ||
		!["project_space", "worktree_space"].includes(item.provenance.kind))) throw Error("Invalid retired Space authority");
	const nodes = new Map(value.nodes.map((node) => [node.key, node]));
	const rooms = value.nodes.flatMap((node) => node.roomId ? [node.roomId] : []);
	if (nodes.size !== value.nodes.length || new Set(rooms).size !== rooms.length) throw Error("Duplicate live hierarchy identity");
	for (const node of value.nodes) {
		if (node.linked && !node.roomId) throw Error("Linked hierarchy node lacks its room");
		if (node.kind === "host_space") {
			if (node.key !== "host" || node.creationKey !== "host" || node.parentRoomId || node.createAttempted) throw Error("Invalid host hierarchy identity");
			continue;
		}
		const parent = nodes.get(node.parentKey);
		const expectedParentKind = node.kind === "project_space" ? "host_space" : node.kind === "worktree_space" ? "project_space" : "worktree_space";
		const expectedKey = node.kind === "project_space" ? node.projectKey : node.kind === "worktree_space" ? node.checkoutId : node.conversationId;
		if (node.key !== expectedKey || parent?.kind !== expectedParentKind ||
			(node.kind !== "conversation" && node.creationKey !== node.key && !retired.some((item) =>
				"projectKey" in item.provenance && item.provenance.projectKey === node.projectKey && item.provenance.kind === node.kind &&
				(node.kind !== "worktree_space" || "checkoutId" in item.provenance && item.provenance.checkoutId === node.checkoutId) &&
				node.creationKey === successorKey(node.key, item.roomId))) ||
			(node.kind === "conversation" && node.conversationId !== deriveConversationId(value.hostId, node.creationKey)) ||
			("projectKey" in parent && parent.projectKey !== node.projectKey) ||
			("checkoutId" in parent && node.kind === "conversation" && parent.checkoutId !== node.checkoutId) ||
			(node.parentRoomId !== undefined && (node.parentRoomId !== parent.roomId || !parent.linked)) || (node.roomId !== undefined && !node.parentRoomId)) throw Error("Conflicting live hierarchy parent or identity");
	}
	return value;
}
function provenance(hostId: string, node: Node): ManagedProvenance {
	const identity = { version: 1, hostId, kind: node.kind, creationKey: node.creationKey };
	return parseManagedProvenance(node.kind === "host_space" ? identity : { ...identity, parentRoomId: node.parentRoomId,
		projectKey: node.projectKey, ...(node.kind !== "project_space" ? { checkoutId: node.checkoutId } : {}),
		...(node.kind === "conversation" ? { conversationId: node.conversationId } : {}) });
}
type HierarchyMatrix = Pick<ManagedMatrixClient, "ensureLegacyHostProvenance" | "ensureManagedRoom" | "recoverManagedAlias" | "recoverManagedRoom" | "addSpaceChild">;
export interface HierarchyPlacement {
	creationKey: string; projectKey: string; canonicalCheckoutRoot: string;
	projectTitle: string; checkoutTitle: string; conversationTitle: string;
}
export interface HierarchyBinding { conversationId: string; checkoutId: string; projectSpace: string; checkoutSpace: string; roomId: string; hostSpace: string }

/** Local reservation precedes remote effects. Loading/status never reparents existing rooms. */
export class LiveHierarchy {
	private state: State;
	private poisoned = false;
	private work: Promise<void> = Promise.resolve();
	private readonly running = new Map<string, Promise<string>>();
	private readonly projectScopes = new Map<string, { tail: Promise<void>; readers: Set<Promise<void>>; writers: number }>();
	private readonly scopedWork = new Set<Promise<void>>();
	private readonly controller = new AbortController();
	private readonly file: AtomicJsonFile<State>;
	constructor(private readonly directory: string, readonly hostId: string, private readonly matrix: HierarchyMatrix,
		private readonly coordinator: () => ConversationManifest | undefined,
		private readonly isRetired: (conversationId: string) => boolean = () => false) {
		this.state = { version: 1, hostId, nodes: [] }; this.file = new AtomicJsonFile(join(directory, "hierarchy.json"), parse);
	}
	async load(): Promise<void> {
		await ensurePrivateDirectory(this.directory);
		const state = await this.file.read();
		if (state && state.hostId !== this.hostId) throw Error("Live hierarchy belongs to another host");
		this.state = state ?? parse(this.state);
	}
	prepare(input: HierarchyPlacement): Promise<{ conversationId: string; checkoutId: string }> {
		return this.projectScope(input.projectKey, false, () => this.prepareOnce(input));
	}
	private async prepareOnce(input: HierarchyPlacement): Promise<{ conversationId: string; checkoutId: string }> {
		this.controller.signal.throwIfAborted();
		const checkoutId = deriveCheckoutId(this.hostId, input.projectKey, input.canonicalCheckoutRoot);
		const conversationId = deriveConversationId(this.hostId, input.creationKey);
		if (this.isRetired(conversationId)) throw Error("Managed conversation is permanently retired");
		const requested: Node[] = [
			{ key: "host", creationKey: "host", kind: "host_space", title: this.hostId, linked: false },
			{ key: input.projectKey, creationKey: input.projectKey, kind: "project_space", projectKey: input.projectKey, parentKey: "host", title: input.projectTitle, linked: false },
			{ key: checkoutId, creationKey: checkoutId, kind: "worktree_space", projectKey: input.projectKey, checkoutId, parentKey: input.projectKey, title: input.checkoutTitle, linked: false },
			{ key: conversationId, creationKey: input.creationKey, kind: "conversation", projectKey: input.projectKey, checkoutId, conversationId, parentKey: checkoutId, title: input.conversationTitle, linked: false },
		];
		await this.mutate((state) => {
			// Only an explicit new reservation replaces a fenced branch; cleanup may still be pending.
			// Load/status never replace resources, and old cleanup keeps its original frozen IDs.
			for (const wanted of requested.filter((node) => node.kind === "project_space" || node.kind === "worktree_space")) {
				const old = state.nodes.find((node) => node.key === wanted.key);
				const fence = state.retiredSpaces?.find((item) => item.roomId === old?.roomId);
				if (fence) {
					const branch = new Set([wanted.key]);
					for (let depth = 0; depth < 3; depth++) for (const node of state.nodes) if ("parentKey" in node && branch.has(node.parentKey)) branch.add(node.key);
					for (const node of state.nodes.filter((item) => branch.has(item.key))) {
						if (node.kind === "conversation" ? !this.isRetired(node.conversationId) : node.roomId && !state.retiredSpaces?.some((item) => item.roomId === node.roomId))
							throw Error("Retired Space still has unresolved hierarchy references");
					}
					state.nodes = state.nodes.filter((node) => !branch.has(node.key));
				}
				const previous = state.retiredSpaces?.filter((item) => item.provenance.kind === wanted.kind && "projectKey" in item.provenance &&
					item.provenance.projectKey === input.projectKey && (wanted.kind !== "worktree_space" || "checkoutId" in item.provenance && item.provenance.checkoutId === checkoutId)).at(-1);
				if (previous) wanted.creationKey = successorKey(wanted.key, previous.roomId);
			}
			for (const wanted of requested) {
				const existing = state.nodes.find((item) => item.key === wanted.key);
				if (!existing) {
					const fallback = ({ host_space: "host", project_space: "project", worktree_space: "worktree", conversation: "conversation" } as const)[wanted.kind];
					wanted.title = safeManagedTitle(wanted.title, wanted.kind === "host_space" ? this.hostId : wanted.key, fallback, new Set(state.nodes.map((item) => item.title)));
					state.nodes.push(wanted); continue;
				}
				for (const key of Object.keys(wanted).filter((key) => !["title", "linked"].includes(key))) {
					if ((existing as Record<string, unknown>)[key] !== (wanted as Record<string, unknown>)[key]) throw Error("Hierarchy reservation changed immutable identity");
				}
			}
		});
		return { conversationId, checkoutId };
	}
	listConversations(): Array<{ conversationId: string; checkoutId: string; projectKey: string; title: string; phase: "pending" | "hierarchy_ready" }> {
		return this.state.nodes.flatMap((node) => node.kind === "conversation" && !this.isRetired(node.conversationId) ? [{ conversationId: node.conversationId,
			checkoutId: node.checkoutId, projectKey: node.projectKey, title: node.title, phase: node.linked ? "hierarchy_ready" as const : "pending" as const }] : []);
	}
	status(conversationId: string): "pending" | "hierarchy_ready" | undefined {
		if (this.isRetired(conversationId)) return undefined;
		const node = this.state.nodes.find((item) => item.kind === "conversation" && item.key === conversationId);
		return node ? node.linked ? "hierarchy_ready" : "pending" : undefined; // Not a phone/account-ready claim.
	}
	provision(conversationId: string): Promise<HierarchyBinding> {
		const node = this.node(conversationId);
		if (node.kind !== "conversation") return Promise.reject(Error("Expected conversation hierarchy target"));
		return this.projectScope(node.projectKey, false, () => this.provisionOnce(conversationId));
	}
	private async provisionOnce(conversationId: string): Promise<HierarchyBinding> {
		this.controller.signal.throwIfAborted();
		if (this.isRetired(conversationId)) throw Error("Managed conversation is permanently retired");
		const reserved = this.node(conversationId);
		this.assertUnretiredBranch(reserved);
		if (reserved.kind !== "conversation") throw Error("Expected conversation hierarchy target");
		if (!reserved.linked) await this.ensure(conversationId);
		this.controller.signal.throwIfAborted();
		const conversation = this.node(conversationId);
		if (conversation.kind !== "conversation") throw Error("Expected conversation hierarchy target");
		return { conversationId, checkoutId: conversation.checkoutId, roomId: conversation.roomId!,
			checkoutSpace: this.node(conversation.checkoutId).roomId!, projectSpace: this.node(conversation.projectKey).roomId!, hostSpace: this.node("host").roomId! };
	}
	/** Exact saved identities only. Does not discover, adopt, create or rename rooms. */
	maintenanceLinks(cleanup = false): HierarchyLink[] {
		this.assertAvailable();
		const identities = new Map<string, ManagedProvenance>();
		for (const node of this.state.nodes) if (node.roomId) identities.set(node.roomId, provenance(this.hostId, node));
		for (const retired of this.state.retiredSpaces ?? []) identities.set(retired.roomId, retired.provenance);
		const fences = new Map((this.state.retiredSpaces ?? []).map((item) => [item.roomId, item]));
		const references = cleanup ? this.referencedRooms(this.isRetired) : undefined;
		const result: HierarchyLink[] = [];
		for (const [roomId, proof] of identities) {
			if (proof.kind === "host_space" || proof.kind === "coordinator" || !("projectKey" in proof) || !("parentRoomId" in proof)) continue;
			const fenced = fences.get(roomId);
			if (cleanup) {
				if (!["project_space", "worktree_space"].includes(proof.kind) || fenced?.complete || references!.has(roomId)) continue;
			} else {
				if (fenced || fences.has(proof.parentRoomId) ||
					(proof.kind === "conversation" && this.isRetired(proof.conversationId))) continue;
			}
			const parent = identities.get(proof.parentRoomId); if (!parent) continue;
			result.push({ projectKey: proof.projectKey, child: { roomId, provenance: proof }, parent: { roomId: proof.parentRoomId, provenance: parent } });
		}
		return structuredClone(result.sort((a, b) => a.child.roomId.localeCompare(b.child.roomId)));
	}

	ancestorProvenance(roomId: string): ManagedProvenance | undefined {
		this.assertAvailable(); const node = this.state.nodes.find((item) => item.roomId === roomId);
		return node && (node.kind === "project_space" || node.kind === "worktree_space") ? structuredClone(provenance(this.hostId, node)) : undefined;
	}
	/** Call under withProjectCleanup after fresh checks, before the first account mutation. */
	fenceSpace(target: HierarchySpaceIdentity): Promise<void> {
		return this.mutate((state) => {
			const saved = state.retiredSpaces?.find((item) => item.roomId === target.roomId);
			if (saved) { this.matchSpace(saved, target); return; }
			const node = state.nodes.find((item) => item.roomId === target.roomId);
			if (!node || !["project_space", "worktree_space"].includes(node.kind) || !isDeepStrictEqual(provenance(this.hostId, node), target.provenance)) throw Error("Space retirement ownership changed");
			if (this.hasReferences(target.roomId, this.isRetired)) throw Error("Space is still referenced");
			(state.retiredSpaces ??= []).push({ ...structuredClone(spaceIdentity(target)), complete: false });
		}, true);
	}
	completeSpace(target: HierarchySpaceIdentity): Promise<void> {
		return this.mutate((state) => {
			const saved = state.retiredSpaces?.find((item) => item.roomId === target.roomId);
			if (!saved) throw Error("Space retirement was not fenced"); this.matchSpace(saved, target); saved.complete = true;
		}, true);
	}
	spaceRetirement(target: HierarchySpaceIdentity): "pending" | "done" | undefined {
		this.assertAvailable(); const saved = this.state.retiredSpaces?.find((item) => item.roomId === target.roomId);
		if (!saved) return undefined; this.matchSpace(saved, target); return saved.complete ? "done" : "pending";
	}
	private matchSpace(saved: SpaceRetirement, target: HierarchySpaceIdentity): void {
		const { complete: _complete, ...identity } = saved;
		if (!isDeepStrictEqual(identity, spaceIdentity(target))) throw Error("Retired Space identity changed");
	}
	private assertAvailable(): void { if (this.poisoned) throw Error("Hierarchy retirement authority is unavailable; restart for ownership-safe recovery"); }
	private assertUnretiredBranch(node: Node): void {
		let current: Node | undefined = node;
		while (current) {
			if (this.state.retiredSpaces?.some((item) => item.roomId === current!.roomId)) throw Error("Ancestor Space is permanently retired");
			current = "parentKey" in current ? this.node(current.parentKey) : undefined;
		}
	}
	/** Includes unpublished reservations; caller supplies permanent conversation retirement authority. */
	hasReferences(roomId: string, isRetired: (conversationId: string) => boolean): boolean {
		return this.referencedRooms(isRetired).has(roomId);
	}
	private referencedRooms(isRetired: (conversationId: string) => boolean): Set<string> {
		this.assertAvailable(); const rooms = new Set<string>();
		const nodes = new Map(this.state.nodes.map((node) => [node.key, node]));
		for (const node of this.state.nodes) {
			if (node.kind !== "conversation" || isRetired(node.conversationId)) continue;
			let current: Node | undefined = node;
			while (current) {
				if (current.roomId) rooms.add(current.roomId);
				current = "parentKey" in current ? nodes.get(current.parentKey) : undefined;
			}
		}
		return rooms;
	}
	/** Cleanup is exclusive with reservations/provisioning in this project, not with other projects.
	 * Callers must use this signal and keep fresh checks and the next mutation inside the callback. */
	withProjectCleanup<T>(projectKey: string, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
		return this.projectScope(projectKey, true, () => operation(this.controller.signal));
	}
	private async projectScope<T>(projectKey: string, exclusive: boolean, operation: () => Promise<T>): Promise<T> {
		this.controller.signal.throwIfAborted();
		this.assertAvailable();
		if (!/^project_[a-f0-9]{32}$/.test(projectKey)) throw Error("Invalid hierarchy project identity");
		if (this.scopedWork.size >= 256) throw Error("Hierarchy operation capacity reached");
		let scope = this.projectScopes.get(projectKey);
		if (!scope) { scope = { tail: Promise.resolve(), readers: new Set(), writers: 0 }; this.projectScopes.set(projectKey, scope); }
		const blockers = exclusive ? [scope.tail, ...scope.readers] : [scope.tail];
		let release!: () => void; const done = new Promise<void>((resolve) => { release = resolve; }); this.scopedWork.add(done);
		if (exclusive) { scope.tail = done; scope.writers++; } else scope.readers.add(done);
		try { await Promise.all(blockers); this.controller.signal.throwIfAborted(); this.assertAvailable(); return await operation(); }
		finally {
			if (exclusive) scope.writers--; else scope.readers.delete(done);
			if (!scope.writers && !scope.readers.size) this.projectScopes.delete(projectKey);
			this.scopedWork.delete(done); release();
		}
	}
	async close(): Promise<void> {
		this.controller.abort(); await Promise.allSettled([...this.scopedWork, ...this.running.values()]); await this.work;
	}
	private node(key: string): Node { const node = this.state.nodes.find((item) => item.key === key); if (!node) throw Error("Hierarchy target was not reserved"); return node; }
	private ensure(key: string): Promise<string> {
		const pending = this.running.get(key); if (pending) return pending;
		const run = this.ensureOnce(key).finally(() => this.running.delete(key)); this.running.set(key, run); return run;
	}
	private async ensureOnce(key: string): Promise<string> {
		this.controller.signal.throwIfAborted();
		let node = this.node(key);
		this.assertUnretiredBranch(node);
		if (node.kind === "host_space") {
			const coordinator = this.coordinator();
			if (!coordinator?.hostSpace) throw Error("Host Space provisioning is pending");
			if (node.roomId && node.roomId !== coordinator.hostSpace) throw Error("Saved host Space changed; explicit migration required");
			const roomId = await this.matrix.ensureLegacyHostProvenance(this.hostId, coordinator, this.controller.signal);
			await this.update(key, { roomId, linked: true }); return roomId;
		}
		const parentRoomId = await this.ensure(node.parentKey);
		if (node.parentRoomId && node.parentRoomId !== parentRoomId) throw Error("Saved hierarchy parent changed; explicit migration required");
		if (!node.parentRoomId) await this.update(key, { parentRoomId });
		node = this.node(key);
		const proof = provenance(this.hostId, node);
		let roomId = node.roomId;
		if (roomId) await this.matrix.recoverManagedRoom(roomId, proof, this.controller.signal);
		else {
			if (node.createAttempted) {
				roomId = await this.matrix.recoverManagedAlias(proof, this.controller.signal);
				if (!roomId) throw Error("Uncertain room creation has no verifiable alias; explicit reconciliation required");
			} else {
				await this.update(key, { createAttempted: true });
				roomId = await this.matrix.ensureManagedRoom(node.title, proof, this.controller.signal);
			}
			await this.update(key, { roomId });
		}
		if (!node.linked) { await this.matrix.addSpaceChild(parentRoomId, roomId, this.controller.signal); await this.update(key, { linked: true }); }
		return roomId;
	}
	private update(key: string, fields: { roomId?: string; parentRoomId?: string; createAttempted?: true; linked?: boolean }): Promise<void> {
		return this.mutate((state) => { Object.assign(state.nodes.find((item) => item.key === key)!, fields); });
	}
	private mutate(change: (state: State) => void, retirement = false): Promise<void> {
		const result = this.work.then(async () => {
			this.assertAvailable(); const next = structuredClone(this.state); change(next); parse(next);
			try { await this.file.write(next); } catch (error) { if (retirement) this.poisoned = true; throw error; }
			this.state = next;
		});
		this.work = result.catch(() => undefined); return result;
	}
}
