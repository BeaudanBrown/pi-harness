import { join } from "node:path";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { deriveConversationId, type ConversationManifest } from "../contracts.js";
import { deriveCheckoutId, parseManagedProvenance, safeManagedTitle, type ManagedProvenance } from "../managed-provenance.js";
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
const StateSchema = Type.Object({ version: Type.Literal(1), hostId: identifier, nodes: Type.Array(NodeSchema, { maxItems: 16384 }) }, { additionalProperties: false });
type State = Static<typeof StateSchema>;
function parse(value: unknown): State {
	if (!Check(StateSchema, value) || Buffer.byteLength(JSON.stringify(value)) > 16 * 1024 * 1024) throw Error("Invalid or full live hierarchy state");
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
			(node.kind !== "conversation" && node.creationKey !== node.key) ||
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
	private work: Promise<void> = Promise.resolve();
	private readonly running = new Map<string, Promise<string>>();
	private readonly controller = new AbortController();
	private readonly file: AtomicJsonFile<State>;
	constructor(private readonly directory: string, readonly hostId: string, private readonly matrix: HierarchyMatrix,
		private readonly coordinator: () => ConversationManifest | undefined) {
		this.state = { version: 1, hostId, nodes: [] }; this.file = new AtomicJsonFile(join(directory, "hierarchy.json"), parse);
	}
	async load(): Promise<void> {
		await ensurePrivateDirectory(this.directory);
		const state = await this.file.read();
		if (state && state.hostId !== this.hostId) throw Error("Live hierarchy belongs to another host");
		this.state = state ?? parse(this.state);
	}
	async prepare(input: HierarchyPlacement): Promise<{ conversationId: string; checkoutId: string }> {
		this.controller.signal.throwIfAborted();
		const checkoutId = deriveCheckoutId(this.hostId, input.projectKey, input.canonicalCheckoutRoot);
		const conversationId = deriveConversationId(this.hostId, input.creationKey);
		const requested: Node[] = [
			{ key: "host", creationKey: "host", kind: "host_space", title: safeManagedTitle(this.hostId, this.hostId, "host"), linked: false },
			{ key: input.projectKey, creationKey: input.projectKey, kind: "project_space", projectKey: input.projectKey, parentKey: "host", title: safeManagedTitle(input.projectTitle, input.projectKey, "project"), linked: false },
			{ key: checkoutId, creationKey: checkoutId, kind: "worktree_space", projectKey: input.projectKey, checkoutId, parentKey: input.projectKey, title: safeManagedTitle(input.checkoutTitle, checkoutId, "worktree"), linked: false },
			{ key: conversationId, creationKey: input.creationKey, kind: "conversation", projectKey: input.projectKey, checkoutId, conversationId, parentKey: checkoutId, title: safeManagedTitle(input.conversationTitle, conversationId), linked: false },
		];
		await this.mutate((state) => {
			for (const wanted of requested) {
				const existing = state.nodes.find((item) => item.key === wanted.key);
				if (!existing) { state.nodes.push(wanted); continue; }
				for (const key of Object.keys(wanted).filter((key) => !["title", "linked"].includes(key))) {
					if ((existing as Record<string, unknown>)[key] !== (wanted as Record<string, unknown>)[key]) throw Error("Hierarchy reservation changed immutable identity");
				}
			}
		});
		return { conversationId, checkoutId };
	}
	listConversations(): Array<{ conversationId: string; checkoutId: string; projectKey: string; title: string; phase: "pending" | "hierarchy_ready" }> {
		return this.state.nodes.flatMap((node) => node.kind === "conversation" ? [{ conversationId: node.conversationId,
			checkoutId: node.checkoutId, projectKey: node.projectKey, title: node.title, phase: node.linked ? "hierarchy_ready" as const : "pending" as const }] : []);
	}
	status(conversationId: string): "pending" | "hierarchy_ready" | undefined {
		const node = this.state.nodes.find((item) => item.kind === "conversation" && item.key === conversationId);
		return node ? node.linked ? "hierarchy_ready" : "pending" : undefined; // Not a phone/account-ready claim.
	}
	async provision(conversationId: string): Promise<HierarchyBinding> {
		this.controller.signal.throwIfAborted();
		const reserved = this.node(conversationId);
		if (reserved.kind !== "conversation") throw Error("Expected conversation hierarchy target");
		if (!reserved.linked) await this.ensure(conversationId);
		this.controller.signal.throwIfAborted();
		const conversation = this.node(conversationId);
		if (conversation.kind !== "conversation") throw Error("Expected conversation hierarchy target");
		return { conversationId, checkoutId: conversation.checkoutId, roomId: conversation.roomId!,
			checkoutSpace: this.node(conversation.checkoutId).roomId!, projectSpace: this.node(conversation.projectKey).roomId!, hostSpace: this.node("host").roomId! };
	}
	async close(): Promise<void> {
		this.controller.abort(); await Promise.allSettled([...this.running.values()]); await this.work;
	}
	private node(key: string): Node { const node = this.state.nodes.find((item) => item.key === key); if (!node) throw Error("Hierarchy target was not reserved"); return node; }
	private ensure(key: string): Promise<string> {
		const pending = this.running.get(key); if (pending) return pending;
		const run = this.ensureOnce(key).finally(() => this.running.delete(key)); this.running.set(key, run); return run;
	}
	private async ensureOnce(key: string): Promise<string> {
		this.controller.signal.throwIfAborted();
		let node = this.node(key);
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
	private mutate(change: (state: State) => void): Promise<void> {
		const result = this.work.then(async () => { const next = structuredClone(this.state); change(next); await this.file.write(next); this.state = next; });
		this.work = result.catch(() => undefined); return result;
	}
}
