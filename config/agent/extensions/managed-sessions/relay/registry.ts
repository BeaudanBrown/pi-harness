import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	MANAGED_SESSION_STATE_VERSION,
	MAX_COMPLETED_CONTROLS,
	MAX_PENDING_CONTROLS,
	MAX_PENDING_INPUTS,
	MAX_PROJECTION_ENTRIES,
	deriveGenerationId,
	deriveGenerationTransitionId,
	deriveMatrixTransactionId,
	type ConversationManifest,
	type PendingLocalConversation,
	type RegisteredConversation,
	type WorkspaceIdentity,
	hasMatrixBinding,
	parsePendingLocalConversation,
	parseConversationManifest,
	assertLocalBindingIdentity,
	type SessionGeneration,
	type HostRuntimeState,
	type ManagedSessionEnvelope,
	parseHostRuntimeState,
	parsePersistenceBundle,
} from "../contracts.js";
import { parseConversationTitle, type ConversationTitle } from "../title-contracts.js";
import type { RuntimeObservationSource } from "./runtime-observer.js";
import { AtomicJsonFile, ensurePrivateDirectory } from "./atomic-json.js";
import { ConversationManifestStore } from "./manifest-store.js";
import { redactManagedValue } from "./redaction.js";
import { RetirementStore, retirementId, retirementEffectId, type RetirementRecord, type RetirementTarget } from "./retirement-store.js";

type RuntimeConversation = HostRuntimeState["conversations"][number];
type AdapterRole = "ordinary_adapter" | "coordinator_adapter";

export class RelayRegistryError extends Error {
	constructor(
		readonly code: "permission_denied" | "invalid_nonce" | "attachment_conflict" | "not_found" | "invalid_state" | "capacity_reached" | "launch_failed" | "matrix_unavailable" | "activity_interrupted",
		message: string,
	) {
		super(message);
		this.name = "RelayRegistryError";
	}
}

function nonceHash(nonce: string): string {
	return createHash("sha256").update("pi-managed-sessions:attachment-nonce:v1\0").update(nonce).digest("hex");
}

function equalHash(left: string, right: string): boolean {
	const leftBytes = Buffer.from(left, "hex");
	const rightBytes = Buffer.from(right, "hex");
	return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function expectedRole(manifest: RegisteredConversation): AdapterRole {
	return manifest.kind === "coordinator" ? "coordinator_adapter" : "ordinary_adapter";
}

export interface RegistryConversationMetadata {
	conversationId: string; kind: "project" | "coordinator"; title: string; activeGenerationId: string;
	attached: boolean; matrixBound: boolean; placement?: WorkspaceIdentity; projectKey?: string; checkoutId?: string;
	projectDisplayName?: string; checkoutDisplayName?: string;
}

export interface AcceptedAttachment {
	attachmentId: string;
	conversationId: string;
	role: AdapterRole;
	state: "active";
	generation: number;
}

export class RelayRegistry {
	private readonly runtimeFile: AtomicJsonFile<HostRuntimeState>;
	private readonly retirements: RetirementStore;
	private manifests = new Map<string, RegisteredConversation>();
	private state: HostRuntimeState;
	private readonly liveConnections = new Map<string, string>();
	private operations: Promise<void> = Promise.resolve();
	private restartReconciling = false;
	private readonly runtimeObservers = new Set<() => void>();
	private runtimeObservationKey?: string;

	constructor(
		readonly hostId: string,
		runtimeRoot: string,
		private readonly manifestStore: ConversationManifestStore,
	) {
		this.runtimeFile = new AtomicJsonFile(join(resolve(runtimeRoot), "registry.json"), parseHostRuntimeState);
		this.retirements = new RetirementStore(join(resolve(runtimeRoot), "retirements"), hostId);
		this.state = { schemaVersion: MANAGED_SESSION_STATE_VERSION, hostId, conversations: [] };
	}

	async load(): Promise<void> {
		await ensurePrivateDirectory(resolve(this.runtimeFile.path, ".."));
		await this.retirements.load();
		const allManifests = await this.manifestStore.list();
		const stored = await this.runtimeFile.read();
		const excluded = new Set([...allManifests, ...(stored?.localConversations ?? [])].filter((manifest) =>
			this.retirements.has(manifest.conversationId) || this.retirements.hasCreationKey(manifest.creationKey)).map((manifest) => manifest.conversationId));
		const manifests = allManifests.filter((manifest) => !excluded.has(manifest.conversationId));
		if (stored) {
			stored.conversations = stored.conversations.filter((item) => !excluded.has(item.conversationId) && !this.retirements.has(item.conversationId));
			if (stored.localConversations) stored.localConversations = stored.localConversations.filter((item) => !excluded.has(item.conversationId));
		}
		const runtime = stored ?? {
			schemaVersion: MANAGED_SESSION_STATE_VERSION,
			hostId: this.hostId,
			conversations: manifests.map((manifest) => ({
				conversationId: manifest.conversationId,
				state: "dormant" as const,
				attachment: null,
				matrixCursor: { status: "bootstrap" as const },
				pendingInputs: [],
				pendingControls: [],
				completedControlIds: [],
				publishingControlPoll: null,
				activeControlPoll: null,
				publishingCheckpointPoll: null,
				activeCheckpointPoll: null,
				closingCheckpointPolls: [],
				artifactExports: [],
				projection: [],
				managedWindow: null,
			})),
		};
		const bundle = parsePersistenceBundle(manifests, runtime);
		if (bundle.runtime.hostId !== this.hostId) throw new RelayRegistryError("invalid_state", "Relay registry belongs to a different host");
		this.manifests = new Map([...bundle.manifests, ...(bundle.runtime.localConversations ?? [])].map((manifest) => [manifest.conversationId, manifest]));
		this.state = bundle.runtime;
		await this.runtimeFile.write(this.state);
	}

	beginRestartReconciliation(): void {
		this.restartReconciling = true;
		this.liveConnections.clear();
	}

	async finishRestartReconciliation(): Promise<void> {
		await this.mutate(async () => {
			for (const conversation of this.state.conversations) {
				if (conversation.state !== "dormant" && !this.liveConnections.has(conversation.conversationId)) {
					conversation.state = "dormant";
					conversation.attachment = null;
				}
			}
			this.restartReconciling = false;
		});
	}

	async setMatrixCursor(conversationId: string, matrixSince: string): Promise<void> {
		await this.mutate(async () => {
			this.runtimeConversation(conversationId).matrixCursor = { status: "established", since: matrixSince };
		});
	}

	async recordAcceptedInput(conversationId: string, input: RuntimeConversation["pendingInputs"][number]): Promise<void> {
		await this.mutate(async () => {
			this.addPendingInput(this.runtimeConversation(conversationId), input);
			parseHostRuntimeState(this.state);
		});
	}

	async recordPendingControl(conversationId: string, control: RuntimeConversation["pendingControls"][number]): Promise<void> {
		await this.mutate(async () => {
			const conversation = this.runtimeConversation(conversationId);
			const inserted = this.addPendingControl(conversation, control);
			if (inserted && control.name === "new" && control.argument === "--confirm") {
				conversation.pendingControls.find((item) => item.controlId === control.controlId)!.cancelDeliveryIds =
					conversation.pendingInputs.filter((item) => item.status !== "completed" && item.status !== "cancelled").map((item) => item.deliveryId);
			}
			if (inserted && control.name === "stop") {
				for (const input of conversation.pendingInputs) if (input.status !== "completed") input.status = "cancelled";
			}
			if (inserted && conversation.publishingControlPoll?.scope === control.name) {
				const supersededId = conversation.publishingControlPoll.sourceControl.controlId;
				const sourceIndex = conversation.pendingControls.findIndex((candidate) => candidate.controlId === supersededId);
				if (sourceIndex === -1) throw new RelayRegistryError("invalid_state", "Publishing control poll source is unavailable");
				conversation.pendingControls.splice(sourceIndex, 1);
				if (conversation.completedControlIds.length >= MAX_COMPLETED_CONTROLS) conversation.completedControlIds.shift();
				conversation.completedControlIds.push(supersededId);
				conversation.publishingControlPoll = null;
			}
			if (inserted && conversation.activeControlPoll?.scope === control.name) conversation.activeControlPoll = null;
			parseHostRuntimeState(this.state);
		});
	}

	async beginControlPollPublication(conversationId: string, intent: NonNullable<RuntimeConversation["publishingControlPoll"]>): Promise<"publishing" | "active"> {
		return this.mutate(async () => {
			const conversation = this.runtimeConversation(conversationId);
			const source = conversation.pendingControls.find((control) => control.controlId === intent.sourceControl.controlId);
			if (!source || JSON.stringify(source) !== JSON.stringify(intent.sourceControl) || source.name !== intent.scope) {
				throw new RelayRegistryError("invalid_state", "Control poll publication intent does not match its pending source control");
			}
			const active = conversation.activeControlPoll;
			if (active?.sourceControlId === source.controlId) {
				if (active.scope !== intent.scope || JSON.stringify(active.options) !== JSON.stringify(intent.options)) {
					throw new RelayRegistryError("invalid_state", "Conflicting active control poll identity");
				}
				return "active";
			}
			const existing = conversation.publishingControlPoll;
			if (existing && JSON.stringify(existing) !== JSON.stringify(intent)) {
				throw new RelayRegistryError("invalid_state", "Conflicting control poll publication intent");
			}
			conversation.publishingControlPoll = structuredClone(intent);
			parseHostRuntimeState(this.state);
			return "publishing";
		});
	}

	publishingControlPolls(): Array<{ conversationId: string; intent: NonNullable<RuntimeConversation["publishingControlPoll"]> }> {
		this.retirements.assertAvailable();
		return this.state.conversations.flatMap((conversation) => conversation.publishingControlPoll
			? [{ conversationId: conversation.conversationId, intent: structuredClone(conversation.publishingControlPoll) }] : []);
	}

	async completeControlPollPublication(conversationId: string, sourceControlId: string, pollEventId: string): Promise<void> {
		await this.mutate(async () => {
			const conversation = this.runtimeConversation(conversationId);
			const intent = conversation.publishingControlPoll;
			if (!intent || intent.sourceControl.controlId !== sourceControlId) {
				const active = conversation.activeControlPoll;
				if (active?.sourceControlId === sourceControlId && active.pollEventId === pollEventId) return;
				throw new RelayRegistryError("invalid_state", "Control poll publication intent is unavailable");
			}
			const index = conversation.pendingControls.findIndex((control) => control.controlId === sourceControlId);
			if (index === -1) throw new RelayRegistryError("invalid_state", "Control poll source is no longer pending");
			conversation.activeControlPoll = { pollEventId, sourceControlId, scope: intent.scope, options: structuredClone(intent.options) };
			conversation.publishingControlPoll = null;
			conversation.pendingControls.splice(index, 1);
			if (conversation.completedControlIds.length >= MAX_COMPLETED_CONTROLS) conversation.completedControlIds.shift();
			conversation.completedControlIds.push(sourceControlId);
			parseHostRuntimeState(this.state);
		});
	}

	async registerActiveControlPoll(conversationId: string, poll: NonNullable<RuntimeConversation["activeControlPoll"]>): Promise<void> {
		await this.mutate(async () => {
			const conversation = this.runtimeConversation(conversationId);
			const source = conversation.pendingControls.find((control) => control.controlId === poll.sourceControlId);
			if (!source || source.name !== poll.scope) throw new RelayRegistryError("invalid_state", "Published control poll does not match its pending control scope");
			const existing = conversation.activeControlPoll;
			if (existing?.sourceControlId === poll.sourceControlId) {
				if (JSON.stringify(existing) !== JSON.stringify(poll)) throw new RelayRegistryError("invalid_state", "Conflicting published control poll identity");
				return;
			}
			conversation.activeControlPoll = structuredClone(poll);
			parseHostRuntimeState(this.state);
		});
	}

	activeControlPollOption(conversationId: string, pollEventId: string, answerId: string): string | undefined {
		const poll = this.runtimeConversation(conversationId).activeControlPoll;
		if (!poll || poll.pollEventId !== pollEventId) return undefined;
		return poll.options.find((option) => option.answerId === answerId)?.command;
	}

	async acceptActiveControlPollResponse(conversationId: string, pollEventId: string, answerId: string, command: string,
		control: RuntimeConversation["pendingControls"][number]): Promise<boolean> {
		return this.mutate(async () => {
			const conversation = this.runtimeConversation(conversationId);
			const poll = conversation.activeControlPoll;
			const option = poll?.pollEventId === pollEventId ? poll.options.find((candidate) => candidate.answerId === answerId) : undefined;
			if (!poll || !option || option.command !== command || control.name !== poll.scope) return false;
			if (!this.addPendingControl(conversation, control)) return false;
			conversation.activeControlPoll = null;
			parseHostRuntimeState(this.state);
			return true;
		});
	}

	async beginCheckpointPollPublication(conversationId: string, intent: NonNullable<RuntimeConversation["publishingCheckpointPoll"]>): Promise<"publishing" | "active"> {
		return this.mutate(async () => {
			const conversation = this.runtimeConversation(conversationId);
			const active = conversation.activeCheckpointPoll;
			if (active?.checkpointId === intent.checkpointId) {
				const { pollEventId: _pollEventId, ...activeIntent } = active;
				if (JSON.stringify(activeIntent) !== JSON.stringify(intent)) throw new RelayRegistryError("invalid_state", "Conflicting active checkpoint poll identity");
				return "active";
			}
			if (active) throw new RelayRegistryError("invalid_state", "A different checkpoint poll is already active");
			if (conversation.publishingCheckpointPoll && JSON.stringify(conversation.publishingCheckpointPoll) !== JSON.stringify(intent)) {
				throw new RelayRegistryError("invalid_state", "Conflicting checkpoint poll publication intent");
			}
			conversation.publishingCheckpointPoll = structuredClone(intent);
			parseHostRuntimeState(this.state);
			return "publishing";
		});
	}

	hasPublishingCheckpointPoll(conversationId: string): boolean {
		return this.runtimeConversation(conversationId).publishingCheckpointPoll !== null;
	}

	publishingCheckpointPolls(): Array<{ conversationId: string; intent: NonNullable<RuntimeConversation["publishingCheckpointPoll"]> }> {
		this.retirements.assertAvailable();
		return this.state.conversations.flatMap((conversation) => conversation.publishingCheckpointPoll
			? [{ conversationId: conversation.conversationId, intent: structuredClone(conversation.publishingCheckpointPoll) }] : []);
	}

	async completeCheckpointPollPublication(conversationId: string, checkpointId: string, pollEventId: string): Promise<void> {
		await this.mutate(async () => {
			const conversation = this.runtimeConversation(conversationId);
			const intent = conversation.publishingCheckpointPoll;
			if (!intent || intent.checkpointId !== checkpointId) {
				if (conversation.activeCheckpointPoll?.checkpointId === checkpointId && conversation.activeCheckpointPoll.pollEventId === pollEventId) return;
				throw new RelayRegistryError("invalid_state", "Checkpoint poll publication intent is unavailable");
			}
			conversation.activeCheckpointPoll = { ...structuredClone(intent), pollEventId };
			conversation.publishingCheckpointPoll = null;
			parseHostRuntimeState(this.state);
		});
	}

	activeCheckpointPoll(conversationId: string, pollEventId: string): NonNullable<RuntimeConversation["activeCheckpointPoll"]> | undefined {
		const poll = this.runtimeConversation(conversationId).activeCheckpointPoll;
		return poll?.pollEventId === pollEventId ? structuredClone(poll) : undefined;
	}

	activeCheckpointPollOption(conversationId: string, pollEventId: string, answerId: string): string | undefined {
		return this.activeCheckpointPoll(conversationId, pollEventId)?.options.find((option) => option.answerId === answerId)?.text;
	}

	async acceptActiveCheckpointPollResponse(conversationId: string, pollEventId: string, answerId: string, text: string,
		input: RuntimeConversation["pendingInputs"][number]): Promise<RuntimeConversation["closingCheckpointPolls"][number] | undefined> {
		return this.mutate(async () => {
			const conversation = this.runtimeConversation(conversationId);
			const poll = conversation.activeCheckpointPoll;
			const option = poll?.pollEventId === pollEventId ? poll.options.find((candidate) => candidate.answerId === answerId) : undefined;
			if (!poll || !option || option.text !== text || !this.addPendingInput(conversation, input)) return undefined;
			const closing = this.checkpointPollClosure(conversation, poll, input.matrixEventId, "Selection accepted", answerId);
			conversation.activeCheckpointPoll = null;
			parseHostRuntimeState(this.state);
			return structuredClone(closing);
		});
	}

	async acceptActiveCheckpointText(conversationId: string, input: RuntimeConversation["pendingInputs"][number]): Promise<RuntimeConversation["closingCheckpointPolls"][number] | undefined> {
		return this.mutate(async () => {
			const conversation = this.runtimeConversation(conversationId);
			const poll = conversation.activeCheckpointPoll;
			if (!poll || !this.addPendingInput(conversation, input)) return undefined;
			const closing = this.checkpointPollClosure(conversation, poll, input.matrixEventId, "Answered by text");
			conversation.activeCheckpointPoll = null;
			parseHostRuntimeState(this.state);
			return structuredClone(closing);
		});
	}

	closingCheckpointPolls(): Array<{ conversationId: string; closing: RuntimeConversation["closingCheckpointPolls"][number] }> {
		this.retirements.assertAvailable();
		return this.state.conversations.flatMap((conversation) => conversation.closingCheckpointPolls.map((closing) => ({
			conversationId: conversation.conversationId, closing: structuredClone(closing),
		})));
	}

	async completeCheckpointPollClosure(conversationId: string, pollEventId: string, closureTransactionId: string): Promise<void> {
		await this.mutate(async () => {
			const conversation = this.runtimeConversation(conversationId);
			const index = conversation.closingCheckpointPolls.findIndex((closing) => closing.pollEventId === pollEventId && closing.closureTransactionId === closureTransactionId);
			if (index === -1) return;
			conversation.closingCheckpointPolls.splice(index, 1);
		});
	}

	pendingControls(conversationId: string): RuntimeConversation["pendingControls"] {
		return structuredClone(this.runtimeConversation(conversationId).pendingControls);
	}

	controlResultState(conversationId: string, controlId: string): "pending" | "completed" | "unknown" {
		const conversation = this.runtimeConversation(conversationId);
		if (conversation.pendingControls.some((control) => control.controlId === controlId)) return "pending";
		return conversation.completedControlIds.includes(controlId) ? "completed" : "unknown";
	}

	async acknowledgeControlResult(conversationId: string, controlId: string): Promise<void> {
		await this.mutate(async () => {
			const conversation = this.runtimeConversation(conversationId);
			if (conversation.completedControlIds.includes(controlId)) return;
			const index = conversation.pendingControls.findIndex((control) => control.controlId === controlId);
			if (index === -1) throw new RelayRegistryError("not_found", "Pending managed control was not found");
			conversation.pendingControls.splice(index, 1);
			if (conversation.completedControlIds.length >= MAX_COMPLETED_CONTROLS) conversation.completedControlIds.shift();
			conversation.completedControlIds.push(controlId);
		});
	}

	async recordProjection(conversationId: string, projection: RuntimeConversation["projection"][number]): Promise<void> {
		await this.mutate(async () => {
			const conversation = this.runtimeConversation(conversationId);
			const existing = conversation.projection.find((candidate) => candidate.entryId === projection.entryId);
			if (existing) {
				if (JSON.stringify(existing) !== JSON.stringify(projection)) throw new RelayRegistryError("invalid_state", "Conflicting transcript projection identity");
				return;
			}
			conversation.projection.push(projection);
			parseHostRuntimeState(this.state);
		});
	}

	async beginCheckpointPollProjection(conversationId: string, projection: RuntimeConversation["projection"][number],
		intent: NonNullable<RuntimeConversation["publishingCheckpointPoll"]>): Promise<RuntimeConversation["projection"][number]> {
		return this.mutate(async () => {
			const conversation = this.runtimeConversation(conversationId);
			const existing = conversation.projection.find((candidate) => candidate.entryId === projection.entryId);
			if (existing) {
				if (existing.kind !== projection.kind || existing.contentHash !== projection.contentHash || existing.originDeliveryId !== projection.originDeliveryId ||
					existing.chunks.length !== projection.chunks.length || existing.chunks.some((chunk, index) =>
						chunk.chunkId !== projection.chunks[index]?.chunkId || chunk.transactionId !== projection.chunks[index]?.transactionId)) {
					throw new RelayRegistryError("invalid_state", "Conflicting checkpoint poll projection content");
				}
				return structuredClone(existing);
			}
			if (conversation.projection.length >= MAX_PROJECTION_ENTRIES) throw new RelayRegistryError("capacity_reached", "Transcript projection capacity was reached");
			if (conversation.publishingCheckpointPoll || conversation.activeCheckpointPoll) throw new RelayRegistryError("invalid_state", "Another checkpoint poll lifecycle is unresolved");
			conversation.projection.push(projection);
			conversation.publishingCheckpointPoll = structuredClone(intent);
			parseHostRuntimeState(this.state);
			return structuredClone(projection);
		});
	}

	async beginProjection(
		conversationId: string,
		projection: RuntimeConversation["projection"][number],
	): Promise<RuntimeConversation["projection"][number]> {
		return this.mutate(async () => {
			const conversation = this.runtimeConversation(conversationId);
			const existing = conversation.projection.find((candidate) => candidate.entryId === projection.entryId);
			if (existing) {
				if (existing.kind !== projection.kind || existing.contentHash !== projection.contentHash || existing.originDeliveryId !== projection.originDeliveryId ||
					existing.disposition !== projection.disposition || existing.chunks.length !== projection.chunks.length || existing.chunks.some((chunk, index) =>
						chunk.chunkId !== projection.chunks[index]?.chunkId || chunk.transactionId !== projection.chunks[index]?.transactionId)) {
					throw new RelayRegistryError("invalid_state", "Conflicting transcript projection content");
				}
				return structuredClone(existing);
			}
			if (conversation.projection.length >= MAX_PROJECTION_ENTRIES) throw new RelayRegistryError("capacity_reached", "Transcript projection capacity was reached");
			conversation.projection.push(projection);
			parseHostRuntimeState(this.state);
			return structuredClone(projection);
		});
	}

	checkpointProjectionForOrigin(conversationId: string, originDeliveryId: string): RuntimeConversation["projection"][number] | undefined {
		const projection = this.runtimeConversation(conversationId).projection.find((candidate) =>
			candidate.kind === "checkpoint" && candidate.originDeliveryId === originDeliveryId);
		return projection ? structuredClone(projection) : undefined;
	}

	async markProjectionChunkSent(conversationId: string, entryId: string, chunkId: string): Promise<void> {
		await this.mutate(async () => {
			const projection = this.runtimeConversation(conversationId).projection.find((candidate) => candidate.entryId === entryId);
			const chunk = projection?.chunks.find((candidate) => candidate.chunkId === chunkId);
			if (!projection || !chunk) throw new RelayRegistryError("not_found", "Transcript projection chunk was not found");
			chunk.status = "sent";
			projection.status = projection.chunks.every((candidate) => candidate.status === "sent") ? "projected" : "projecting";
		});
	}

	manifestByCreationKey(creationKey: string): ConversationManifest | undefined {
		this.retirements.assertAvailable();
		if (this.retirements.hasCreationKey(creationKey)) throw new RelayRegistryError("invalid_state", "Managed creation identity is permanently retired");
		const manifest = [...this.manifests.values()].find((candidate) => candidate.creationKey === creationKey);
		return manifest && hasMatrixBinding(manifest) ? structuredClone(manifest) : undefined;
	}

	manifestByConversationId(conversationId: string): ConversationManifest | undefined {
		this.retirements.assertAvailable();
		if (this.retirements.has(conversationId)) return undefined;
		const manifest = this.manifests.get(conversationId);
		return manifest && hasMatrixBinding(manifest) ? structuredClone(manifest) : undefined;
	}

	registeredConversation(conversationId: string): RegisteredConversation | undefined {
		this.retirements.assertAvailable();
		if (this.retirements.has(conversationId)) return undefined;
		const manifest = this.manifests.get(conversationId);
		return manifest ? structuredClone(manifest) : undefined;
	}

	localConversations(): PendingLocalConversation[] { this.retirements.assertAvailable(); return structuredClone(this.state.localConversations ?? []); }

	/** Cheap read projection: no queues, credentials, transcripts, paths or history clones. */
	conversationMetadata(): RegistryConversationMetadata[] {
		this.retirements.assertAvailable();
		const runtime = new Map(this.state.conversations.map((item) => [item.conversationId, item]));
		return [...this.manifests.values()].map((manifest) => {
			const state = runtime.get(manifest.conversationId);
			return {
				conversationId: manifest.conversationId, kind: manifest.kind, title: manifest.title ?? manifest.concept,
				activeGenerationId: this.activeGeneration(manifest).generationId,
				attached: Boolean(this.liveConnections.has(manifest.conversationId) && state?.state === "active" && state.attachment?.sessionId === manifest.piSessionId),
				matrixBound: hasMatrixBinding(manifest),
				...(manifest.kind === "project" ? { ...(manifest.placement ? { placement: { ...manifest.placement } } : {}),
					...(manifest.projectKey ? { projectKey: manifest.projectKey } : {}), ...(manifest.checkoutId ? { checkoutId: manifest.checkoutId } : {}),
					...(manifest.projectDisplayName ? { projectDisplayName: manifest.projectDisplayName } : {}),
					...(manifest.checkoutDisplayName ? { checkoutDisplayName: manifest.checkoutDisplayName } : {}),
				} : {}),
			};
		});
	}

	titleInventory(): Array<{ conversationId: string; sessionId: string; concept: string; title?: string; titleRevision?: number; roomId?: string }> {
		this.retirements.assertAvailable();
		return [...this.manifests.values()].filter(row => !this.retirements.has(row.conversationId)).map(row => ({ conversationId: row.conversationId, sessionId: row.piSessionId, concept: row.concept,
			...(row.title === undefined ? {} : { title: row.title, titleRevision: row.titleRevision }), ...(hasMatrixBinding(row) ? { roomId: row.roomId } : {}) }));
	}

	async updateConversationTitle(conversationId: string, value: ConversationTitle): Promise<void> {
		const title = parseConversationTitle(value);
		await this.mutate(async () => {
			const manifest = this.registeredConversation(conversationId);
			if (!manifest) throw new RelayRegistryError("not_found", "Conversation title target is unavailable");
			if ((manifest.titleRevision ?? 0) > title.revision || manifest.titleRevision === title.revision && manifest.title !== title.title) throw new RelayRegistryError("invalid_state", "Conversation title revision conflicts");
			if (manifest.titleRevision === title.revision) return;
			const next = { ...manifest, title: title.title, titleRevision: title.revision };
			if (hasMatrixBinding(next)) await this.manifestStore.write(parseConversationManifest(next));
			else { parsePendingLocalConversation(next); const index = this.state.localConversations!.findIndex(row => row.conversationId === conversationId); this.state.localConversations![index] = next; }
			this.manifests.set(conversationId, next);
		});
	}

	/** Bounded metadata projection, deliberately excluding queues, history and secrets. */
	runtimeObservationSources(): RuntimeObservationSource[] {
		this.retirements.assertAvailable();
		const runtime = new Map(this.state.conversations.map(row => [row.conversationId, row]));
		return [...this.manifests.values()].filter(manifest => manifest.ownerHostId === this.hostId && !this.retirements.has(manifest.conversationId)).flatMap(manifest => {
			const row = runtime.get(manifest.conversationId); if (!row) return [];
			return [{ hostId: this.hostId, conversationId: manifest.conversationId, generationId: this.activeGeneration(manifest).generationId,
				piSessionId: manifest.piSessionId, state: row.state,
				attached: Boolean(this.liveConnections.has(manifest.conversationId) && row.state === "active" && row.attachment?.sessionId === manifest.piSessionId),
				...(row.attachment ? { attachmentId: row.attachment.attachmentId } : {}),
				...(row.launch ? { launch: { launchId: row.launch.launchId, generationId: row.launch.generationId } } : {}),
				...(row.managedWindow?.ownership ? { window: structuredClone(row.managedWindow.ownership) } : {}),
				managedWindow: Boolean(row.managedWindow), failed: Boolean(row.lastLaunchError), transitioning: Boolean(row.generationTransition && row.generationTransition.phase !== "attached"),
			}];
		});
	}

	onRuntimeObservationChange(listener: () => void): () => void {
		this.runtimeObservationKey = JSON.stringify(this.runtimeObservationSources());
		this.runtimeObservers.add(listener);
		return () => { this.runtimeObservers.delete(listener); if (!this.runtimeObservers.size) this.runtimeObservationKey = undefined; };
	}

	private notifyRuntimeObservers(): void {
		if (!this.runtimeObservers.size) return;
		const next = JSON.stringify(this.runtimeObservationSources());
		if (next === this.runtimeObservationKey) return;
		this.runtimeObservationKey = next;
		for (const listener of this.runtimeObservers) { try { listener(); } catch { /* Presentation cannot roll back committed authority. */ } }
	}

	conversationState(conversationId: string): "starting" | "active" | "dormant" {
		return this.runtimeConversation(conversationId).state;
	}

	listManifests(): ConversationManifest[] {
		this.retirements.assertAvailable();
		return [...this.manifests.values()].filter(hasMatrixBinding).map((manifest) => structuredClone(manifest));
	}

	activeGeneration(manifest: RegisteredConversation): SessionGeneration {
		return manifest.generations?.at(-1) ?? {
			generationId: deriveGenerationId(manifest.conversationId, 1), ordinal: 1, piSessionId: manifest.piSessionId,
			bindingBoundaryEntryId: manifest.bindingBoundaryEntryId, createdAt: manifest.createdAt,
		};
	}

	hasGenerationTransition(conversationId: string): boolean {
		return this.runtimeConversation(conversationId).generationTransition != null;
	}

	hasGenerationBoundary(conversationId: string): boolean {
		const conversation = this.runtimeConversation(conversationId);
		return conversation.generationTransition != null || conversation.pendingControls.some((control) => control.name === "new" && control.argument === "--confirm");
	}

	pendingTreeOperation(conversationId: string): string | undefined { return this.runtimeConversation(conversationId).treeTransition?.operationId; }

	hasDeliveryBoundary(conversationId: string): boolean {
		return Boolean(this.runtimeConversation(conversationId).treeTransition) || this.hasGenerationBoundary(conversationId);
	}

	/** In-place branch navigation fences delivery, not process/generation ownership. */
	async prepareTreeChange(conversationId: string, operationId: string): Promise<void> {
		await this.mutate(async () => {
			const row = this.runtimeConversation(conversationId); const manifest = this.manifests.get(conversationId);
			if (!manifest || !this.isActiveGenerationAttached(conversationId)) throw new RelayRegistryError("invalid_state", "Tree source is not attached");
			if (row.treeTransition) {
				if (row.treeTransition.operationId !== operationId || row.treeTransition.sessionId !== manifest.piSessionId) throw new RelayRegistryError("invalid_state", "Another tree transition is pending");
				return;
			}
			if (row.completedTreeOperation === operationId || this.isRefreshing(conversationId) || this.hasGenerationBoundary(conversationId) || row.pendingControls.length || row.activeCheckpointPoll || row.publishingCheckpointPoll || row.activeControlPoll || row.publishingControlPoll ||
				row.closingCheckpointPolls.length || row.projection.some(projection => projection.status !== "projected") ||
				row.pendingInputs.some(input => input.status !== "completed" && input.status !== "cancelled")) throw new RelayRegistryError("invalid_state", "Wait for pending managed input, controls, projection and poll closure before changing branches");
			row.treeTransition = { operationId, sessionId: manifest.piSessionId };
		});
	}
	async completeTreeChange(conversationId: string, operationId: string, cancelled = false): Promise<void> {
		await this.mutate(async () => {
			const row = this.runtimeConversation(conversationId); const manifest = this.manifests.get(conversationId);
			if (!manifest || !this.isActiveGenerationAttached(conversationId)) throw new RelayRegistryError("invalid_state", "Tree source is not attached");
			if (!row.treeTransition && (row.completedTreeOperation === operationId || cancelled)) return;
			if (row.treeTransition?.operationId !== operationId || row.treeTransition.sessionId !== manifest.piSessionId) throw new RelayRegistryError("invalid_state", "Tree transition changed");
			delete row.treeTransition; row.completedTreeOperation = operationId;
		});
	}

	isActiveGenerationAttached(conversationId: string): boolean {
		const conversation = this.runtimeConversation(conversationId); const manifest = this.manifests.get(conversationId);
		return Boolean(manifest && this.liveConnections.has(conversationId) && conversation.state === "active" && conversation.attachment?.sessionId === manifest.piSessionId);
	}

	generationTransitions(): Array<{ conversationId: string; transition: NonNullable<RuntimeConversation["generationTransition"]> }> {
		this.retirements.assertAvailable();
		return this.state.conversations.flatMap((conversation) => conversation.generationTransition ? [{ conversationId: conversation.conversationId, transition: structuredClone(conversation.generationTransition) }] : []);
	}

	async updateActiveGenerationModel(conversationId: string, model: string): Promise<SessionGeneration> {
		return this.updateActiveGenerationPreference(conversationId, "model", model);
	}

	async updateActiveGenerationThinking(conversationId: string, thinking: string): Promise<SessionGeneration> {
		return this.updateActiveGenerationPreference(conversationId, "thinking", thinking);
	}

	async beginGenerationTransition(conversationId: string, sourceControlId: string, metadata: { model?: string; thinking?: string }): Promise<NonNullable<RuntimeConversation["generationTransition"]>> {
		return this.mutate(async () => {
			const conversation = this.runtimeConversation(conversationId);
			const manifest = this.manifests.get(conversationId);
			if (manifest && !hasMatrixBinding(manifest)) throw new RelayRegistryError("matrix_unavailable", "Matrix binding is pending");
			if (!manifest || manifest.kind !== "project") throw new RelayRegistryError("permission_denied", "Only project conversations support fresh generations");
			if (conversation.generationTransition) {
				if (conversation.generationTransition.sourceControlId !== sourceControlId) throw new RelayRegistryError("invalid_state", "Another generation transition is unresolved");
				return structuredClone(conversation.generationTransition);
			}
			const active = this.activeGeneration(manifest); const ordinal = active.ordinal + 1;
			const transition = { transitionId: deriveGenerationTransitionId(conversationId, active.ordinal, ordinal), sourceControlId, phase: "requested" as const,
				fromGenerationId: active.generationId, toGenerationId: deriveGenerationId(conversationId, ordinal), ordinal, requestedAt: new Date().toISOString(), ...metadata };
			const cutoff = conversation.pendingControls.find((control) => control.controlId === sourceControlId)?.cancelDeliveryIds;
			for (const input of conversation.pendingInputs) {
				if ((cutoff === undefined || cutoff.includes(input.deliveryId)) && input.status !== "completed") input.status = "cancelled";
			}
			conversation.generationTransition = transition;
			return structuredClone(transition);
		});
	}

	async recordGenerationSession(conversationId: string, transitionId: string, session: { sessionId: string; boundaryEntryId: string }): Promise<void> {
		await this.mutate(async () => {
			const transition = this.runtimeConversation(conversationId).generationTransition;
			if (!transition || transition.transitionId !== transitionId) throw new RelayRegistryError("invalid_state", "Generation transition is unavailable");
			if (transition.toPiSessionId && (transition.toPiSessionId !== session.sessionId || transition.toBindingBoundaryEntryId !== session.boundaryEntryId)) throw new RelayRegistryError("invalid_state", "Generation session identity changed during recovery");
			transition.toPiSessionId = session.sessionId; transition.toBindingBoundaryEntryId = session.boundaryEntryId; transition.phase = "session_persisted"; delete transition.failure;
		});
	}

	async activateGeneration(conversationId: string, transitionId: string): Promise<ConversationManifest> {
		const current = this.boundConversation(conversationId);
		const transition = this.runtimeConversation(conversationId).generationTransition;
		if (!current || !transition || transition.transitionId !== transitionId || !transition.toPiSessionId || !transition.toBindingBoundaryEntryId) throw new RelayRegistryError("invalid_state", "Persisted generation is unavailable for activation");
		let replacement = current;
		if (current.activeGenerationId !== transition.toGenerationId) {
			const history = current.generations ?? [this.activeGeneration(current)];
			if (history.at(-1)?.generationId !== transition.fromGenerationId) throw new RelayRegistryError("invalid_state", "Generation activation no longer follows the active generation");
			const generation: SessionGeneration = { generationId: transition.toGenerationId, ordinal: transition.ordinal, piSessionId: transition.toPiSessionId,
				bindingBoundaryEntryId: transition.toBindingBoundaryEntryId, createdAt: new Date().toISOString(), ...(transition.model ? { model: transition.model } : {}), ...(transition.thinking ? { thinking: transition.thinking } : {}) };
			replacement = { ...current, piSessionId: generation.piSessionId, bindingBoundaryEntryId: generation.bindingBoundaryEntryId,
				activeGenerationId: generation.generationId, generations: [...history, generation],
				...(transition.model ? { selectedModel: transition.model } : {}), ...(transition.thinking ? { selectedThinking: transition.thinking } : {}) };
			await this.manifestStore.write(replacement);
		}
		return this.mutate(async () => {
			const live = this.runtimeConversation(conversationId).generationTransition;
			if (!live || live.transitionId !== transitionId) throw new RelayRegistryError("invalid_state", "Generation transition changed during activation");
			this.manifests.set(conversationId, replacement); this.liveConnections.delete(conversationId);
			const runtime = this.runtimeConversation(conversationId); runtime.attachment = null; runtime.state = "starting";
			delete runtime.treeTransition; delete runtime.completedTreeOperation; live.phase = "activated"; delete live.failure;
			return structuredClone(replacement);
		});
	}

	async markGenerationAttached(conversationId: string, transitionId: string): Promise<void> {
		await this.mutate(async () => {
			const conversation = this.runtimeConversation(conversationId); const transition = conversation.generationTransition;
			const manifest = this.manifests.get(conversationId);
			if (!transition || transition.transitionId !== transitionId || !manifest || conversation.state !== "active" ||
				conversation.attachment?.sessionId !== manifest.piSessionId) throw new RelayRegistryError("invalid_state", "Active generation attachment is unavailable");
			transition.phase = "attached"; delete transition.failure;
		});
	}

	async failGenerationTransition(conversationId: string, transitionId: string, error: unknown): Promise<void> {
		await this.mutate(async () => {
			const transition = this.runtimeConversation(conversationId).generationTransition;
			if (!transition || transition.transitionId !== transitionId) return;
			transition.phase = "failed"; transition.failure = { code: "generation_failed", message: redactManagedValue(error instanceof Error ? error.message : "Generation transition failed"), at: new Date().toISOString() };
		});
	}

	async completeGenerationTransition(conversationId: string, transitionId: string): Promise<void> {
		await this.mutate(async () => {
			const conversation = this.runtimeConversation(conversationId);
			if (conversation.generationTransition?.transitionId !== transitionId) throw new RelayRegistryError("invalid_state", "Generation transition changed before completion");
			conversation.generationTransition = null;
		});
	}

	listConversations(): Array<{ conversationId: string; concept: string; kind: "project" | "coordinator"; state: "starting" | "active" | "dormant" }> {
		this.retirements.assertAvailable();
		return [...this.manifests.values()].map((manifest) => ({
			conversationId: manifest.conversationId, concept: manifest.title ?? manifest.concept, kind: manifest.kind,
			state: this.runtimeConversation(manifest.conversationId).state,
		}));
	}

	async cancelPendingInputsExcept(conversationId: string, preservedDeliveryId: string): Promise<void> {
		await this.mutate(async () => {
			for (const input of this.runtimeConversation(conversationId).pendingInputs) {
				if (input.deliveryId !== preservedDeliveryId && input.status !== "completed" && input.status !== "cancelled") input.status = "cancelled";
			}
		});
	}

	async cancelPendingInputs(conversationId: string): Promise<void> {
		await this.mutate(async () => {
			for (const input of this.runtimeConversation(conversationId).pendingInputs) {
				if (input.status !== "completed" && input.status !== "cancelled") input.status = "cancelled";
			}
		});
	}

	async markDormant(conversationId: string, clearManagedWindow = false): Promise<void> {
		await this.mutate(async () => {
			const conversation = this.runtimeConversation(conversationId);
			this.liveConnections.delete(conversationId);
			conversation.state = "dormant";
			conversation.attachment = null;
			if (clearManagedWindow) conversation.managedWindow = null;
		});
	}

	async createProjectConversation(manifest: ConversationManifest, nonce: string, promotionSourceSessionFile?: string): Promise<ConversationManifest> {
		const result = await this.registerProject(manifest, nonce, promotionSourceSessionFile);
		if (!hasMatrixBinding(result)) throw new RelayRegistryError("matrix_unavailable", "Matrix binding is pending");
		return result;
	}

	async registerLocalConversation(manifest: PendingLocalConversation, nonce: string, sourceSessionFile: string): Promise<RegisteredConversation> {
		return this.registerProject(parsePendingLocalConversation(manifest), nonce, sourceSessionFile);
	}

	private async registerProject(manifest: RegisteredConversation, nonce: string, promotionSourceSessionFile?: string): Promise<RegisteredConversation> {
		if (manifest.creationKey === "coordinator") throw new RelayRegistryError("permission_denied", "Coordinator identity is protected");
		if (manifest.kind !== "project" || manifest.ownerHostId !== this.hostId || !manifest.placement) {
			throw new RelayRegistryError("permission_denied", "Self binding requires a host-owned project manifest");
		}
		if (!/^[A-Za-z0-9_-]{32,128}$/.test(nonce)) throw new RelayRegistryError("invalid_nonce", "Attachment nonce is invalid");
		let created = false;
		try {
			return await this.mutate(async () => {
				this.assertNotRetired(manifest.conversationId);
				if (this.retirements.hasCreationKey(manifest.creationKey)) throw new RelayRegistryError("invalid_state", "Managed creation identity is permanently retired");
				const existing = [...this.manifests.values()].find((candidate) =>
					candidate.creationKey === manifest.creationKey || candidate.conversationId === manifest.conversationId ||
					candidate.piSessionId === manifest.piSessionId);
				if (existing) {
					if (existing.creationKey === manifest.creationKey && existing.conversationId === manifest.conversationId &&
						existing.piSessionId === manifest.piSessionId && existing.concept === manifest.concept &&
						existing.projectKey === manifest.projectKey && existing.checkoutId === manifest.checkoutId &&
						(!hasMatrixBinding(manifest) || (hasMatrixBinding(existing) && existing.roomId === manifest.roomId &&
							existing.projectSpace === manifest.projectSpace && existing.checkoutSpace === manifest.checkoutSpace)) &&
						existing.bindingBoundaryEntryId === manifest.bindingBoundaryEntryId &&
						JSON.stringify(existing.placement) === JSON.stringify(manifest.placement)) {
						const runtime = this.runtimeConversation(existing.conversationId);
						if (!runtime.attachmentNonceHash || !equalHash(runtime.attachmentNonceHash, nonceHash(nonce))) {
							if (runtime.promotion?.phase !== "prepared" || runtime.state !== "dormant" || runtime.attachment) {
								throw new RelayRegistryError("invalid_nonce", "Attachment nonce does not match the existing binding");
							}
							runtime.attachmentNonceHash = nonceHash(nonce);
						}
						if (promotionSourceSessionFile !== undefined && runtime.promotion?.sourceSessionFile !== promotionSourceSessionFile) {
							throw new RelayRegistryError("invalid_state", "Promotion retry changed its source Pi session");
						}
						return existing;
					}
					throw new RelayRegistryError("invalid_state", "Managed conversation identity already exists");
				}
				if (hasMatrixBinding(manifest)) { await this.manifestStore.write(manifest); created = true; }
				else {
					if (await this.manifestStore.read(manifest.conversationId)) throw new RelayRegistryError("invalid_state", "Unindexed Matrix binding requires registry reconciliation");
					(this.state.localConversations ??= []).push(manifest);
				}
				this.manifests.set(manifest.conversationId, manifest);
				this.state.conversations.push({
					conversationId: manifest.conversationId,
					state: "dormant",
					attachmentNonceHash: nonceHash(nonce),
					attachment: null,
					matrixCursor: { status: "bootstrap" },
					pendingInputs: [],
					pendingControls: [],
					completedControlIds: [],
					publishingControlPoll: null,
					activeControlPoll: null,
					publishingCheckpointPoll: null,
					activeCheckpointPoll: null,
					closingCheckpointPolls: [],
					artifactExports: [],
					projection: [],
					managedWindow: null,
					...(promotionSourceSessionFile ? { promotion: { sourceSessionFile: promotionSourceSessionFile, phase: "prepared" as const, requestedAt: new Date().toISOString() } } : {}),
				});
				return manifest;
			});
		} catch (error) {
			if (created) await this.manifestStore.remove(manifest.conversationId).catch(() => undefined);
			throw error;
		}
	}

	async completeLocalBinding(conversationId: string, value: Required<Pick<ConversationManifest, "roomId" | "projectSpace" | "checkoutId" | "checkoutSpace">>): Promise<ConversationManifest> {
		const binding = { roomId: value.roomId, projectSpace: value.projectSpace, checkoutId: value.checkoutId, checkoutSpace: value.checkoutSpace };
		// Freeze a private, verified receipt before publishing into the synchronized store.
		await this.mutate(async () => {
			const current = this.manifests.get(conversationId);
			if (!current) throw new RelayRegistryError("not_found", "Local enrollment is unavailable");
			if (hasMatrixBinding(current)) return;
			if (current.checkoutId !== binding.checkoutId) throw new RelayRegistryError("invalid_state", "Local checkout identity changed");
			const receipt = { roomId: binding.roomId, projectSpace: binding.projectSpace, checkoutSpace: binding.checkoutSpace };
			if (current.verifiedBinding && !isDeepStrictEqual(current.verifiedBinding, receipt)) throw new RelayRegistryError("invalid_state", "Verified binding receipt changed");
			const replacement = parsePendingLocalConversation({ ...current, verifiedBinding: receipt });
			if (!this.state.localConversations?.some((item) => item.conversationId === conversationId)) throw new RelayRegistryError("invalid_state", "Local enrollment record is missing");
			this.state.localConversations = this.state.localConversations.map((item) => item.conversationId === conversationId ? replacement : item);
			this.manifests.set(conversationId, replacement);
		});
		return this.mutate(async () => {
			const current = this.manifests.get(conversationId);
			if (!current) throw new RelayRegistryError("not_found", "Local enrollment is unavailable");
			if (hasMatrixBinding(current)) {
				if (current.roomId !== binding.roomId || current.projectSpace !== binding.projectSpace || current.checkoutId !== binding.checkoutId || current.checkoutSpace !== binding.checkoutSpace) {
					throw new RelayRegistryError("invalid_state", "Completed Matrix binding identity changed");
				}
				return structuredClone(current);
			}
			const { version: _version, verifiedBinding: _receipt, ...identity } = current;
			const manifest = parseConversationManifest({ ...identity, schemaVersion: MANAGED_SESSION_STATE_VERSION,
				roomId: binding.roomId, projectSpace: binding.projectSpace, checkoutId: binding.checkoutId, checkoutSpace: binding.checkoutSpace });
			assertLocalBindingIdentity(current, manifest);
			const saved = await this.manifestStore.read(conversationId);
			if (saved && !isDeepStrictEqual(saved, manifest)) throw new RelayRegistryError("invalid_state", "Saved Matrix binding conflicts with local enrollment");
			if (!saved) await this.manifestStore.write(manifest);
			this.state.localConversations = (this.state.localConversations ?? []).filter((item) => item.conversationId !== conversationId);
			if (!this.state.localConversations.length) delete this.state.localConversations;
			this.manifests.set(conversationId, manifest);
			return structuredClone(manifest);
		});
	}

	async createCoordinatorConversation(manifest: ConversationManifest): Promise<ConversationManifest> {
		if (manifest.kind !== "coordinator" || manifest.ownerHostId !== this.hostId) {
			throw new RelayRegistryError("permission_denied", "Coordinator bootstrap requires a host-owned coordinator manifest");
		}
		let written = false;
		try {
			return await this.mutate(async () => {
			this.assertNotRetired(manifest.conversationId);
			if (this.retirements.hasCreationKey(manifest.creationKey)) throw new RelayRegistryError("invalid_state", "Retired identity cannot become coordinator");
			const existingCoordinator = this.listManifests().find((candidate) => candidate.kind === "coordinator");
			if (existingCoordinator) {
				if (JSON.stringify(existingCoordinator) === JSON.stringify(manifest)) return existingCoordinator;
				throw new RelayRegistryError("invalid_state", "A different coordinator manifest already exists");
			}
			if ([...this.manifests.values()].some((candidate) => candidate.creationKey === manifest.creationKey ||
				candidate.conversationId === manifest.conversationId || candidate.piSessionId === manifest.piSessionId || candidate.roomId === manifest.roomId)) {
				throw new RelayRegistryError("invalid_state", "Coordinator identity conflicts with an existing conversation");
			}
			await this.manifestStore.write(manifest);
			written = true;
			this.manifests.set(manifest.conversationId, manifest);
			this.state.conversations.push({
				conversationId: manifest.conversationId, state: "dormant", attachment: null,
				matrixCursor: { status: "bootstrap" }, pendingInputs: [], pendingControls: [], completedControlIds: [], publishingControlPoll: null, activeControlPoll: null,
				publishingCheckpointPoll: null, activeCheckpointPoll: null, closingCheckpointPolls: [], artifactExports: [], projection: [], managedWindow: null,
			});
			return manifest;
			});
		} catch (error) {
			if (written) await this.manifestStore.remove(manifest.conversationId).catch(() => undefined);
			throw error;
		}
	}

	async reconcileProjectManifest(conversationId: string, sourceHash: string, targetHash: string,
		identity: Required<Pick<ConversationManifest, "projectKey" | "projectDisplayName" | "checkoutDisplayName" | "projectSpace">>): Promise<ConversationManifest> {
		const existing = this.boundConversation(conversationId);
		if (existing.kind !== "project") throw new RelayRegistryError("not_found", "Project conversation was not found");
		const hash = (value: ConversationManifest) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
		const currentHash = hash(existing);
		if (currentHash === targetHash) return existing;
		if (currentHash !== sourceHash || existing.projectKey !== undefined || existing.projectDisplayName !== undefined ||
			existing.checkoutDisplayName !== undefined) throw new RelayRegistryError("invalid_state", "Project manifest changed after reconciliation preview");
		const replacement = { ...existing, ...identity };
		if (hash(replacement) !== targetHash) throw new RelayRegistryError("invalid_state", "Project reconciliation target identity changed");
		await this.manifestStore.write(replacement);
		try {
			return await this.mutate(async () => { this.assertNotRetired(conversationId); this.manifests.set(conversationId, replacement); return replacement; });
		} catch (error) {
			await this.manifestStore.write(existing).catch(() => undefined); throw error;
		}
	}

	async replaceCoordinatorRoom(conversationId: string, roomId: string, hostSpace?: string): Promise<ConversationManifest> {
		const existing = this.manifests.get(conversationId);
		if (!existing || existing.kind !== "coordinator") throw new RelayRegistryError("not_found", "Coordinator conversation was not found");
		const replacement = { ...existing, roomId, ...(hostSpace ? { hostSpace } : {}) };
		await this.manifestStore.write(replacement);
		try {
			return await this.mutate(async () => {
				this.manifests.set(conversationId, replacement);
				return replacement;
			});
		} catch (error) {
			await this.manifestStore.write(existing).catch(() => undefined);
			throw error;
		}
	}

	/** Deliberate coordinator departure is non-retiring and never automatic rejoin consent. */
	async recordCoordinatorDeparture(conversationId: string): Promise<void> {
		await this.mutate(async () => {
			if (this.boundConversation(conversationId).kind !== "coordinator") throw new RelayRegistryError("permission_denied", "Project departure requires canonical retirement");
			this.runtimeConversation(conversationId).operatorDeparted = true;
		});
	}

	launchIdentity(conversationId: string): RuntimeConversation["launch"] { return structuredClone(this.runtimeConversation(conversationId).launch); }

	/** Commit admission before invoking the launcher. An uncertain invocation is never replayed. */
	async prepareProjectLaunch(conversationId: string, nonce: string): Promise<NonNullable<RuntimeConversation["launch"]>> {
		if (!/^[A-Za-z0-9_-]{32,128}$/.test(nonce)) throw new RelayRegistryError("invalid_nonce", "Attachment nonce is invalid");
		return this.mutate(async () => {
			const conversation = this.runtimeConversation(conversationId);
			if (conversation.state === "active" || conversation.managedWindow || conversation.launch?.observed === false)
				throw new RelayRegistryError("invalid_state", "Previous launch requires ownership-safe inspection before retry");
			const generationId = this.activeGeneration(this.boundConversation(conversationId)).generationId;
			const ordinal = (conversation.launch?.ordinal ?? 0) + 1;
			if (!Number.isSafeInteger(ordinal)) throw new RelayRegistryError("capacity_reached", "Launch ordinal limit reached");
			const hash = createHash("sha256").update("pi-managed-sessions:launch:live-v1\0");
			for (const part of [conversationId, generationId, String(ordinal)]) hash.update(`${Buffer.byteLength(part)}:${part}`);
			conversation.launch = { launchId: `launch_${hash.digest("hex").slice(0, 32)}`, generationId, ordinal, observed: false };
			conversation.attachmentNonceHash = nonceHash(nonce); conversation.state = "starting";
			return structuredClone(conversation.launch);
		});
	}

	async beginLaunch(conversationId: string): Promise<void> {
		await this.mutate(async () => {
			const conversation = this.runtimeConversation(conversationId);
			if (conversation.state === "active") return;
			conversation.state = "starting";
		});
	}

	async failLaunch(conversationId: string): Promise<void> {
		await this.mutate(async () => {
			const conversation = this.runtimeConversation(conversationId);
			if (conversation.state === "starting") {
				conversation.state = "dormant";
				conversation.attachment = null;
			}
		});
	}

	async setManagedWindow(conversationId: string, window: RuntimeConversation["managedWindow"]): Promise<void> {
		await this.mutate(async () => {
			const conversation = this.runtimeConversation(conversationId);
			if (window && conversation.launch) {
				if (window.ownership?.launchId !== conversation.launch.launchId) throw new RelayRegistryError("invalid_state", "Observed window changed its reserved launch");
				conversation.launch.observed = true;
			}
			conversation.managedWindow = window ? structuredClone(window) : null;
			conversation.lastLaunchError = undefined;
		});
	}

	async recordLaunchError(conversationId: string, code: string, message: string): Promise<void> {
		await this.mutate(async () => {
			this.runtimeConversation(conversationId).lastLaunchError = {
				code: code.replace(/[^A-Za-z0-9._:-]/g, "_").slice(0, 128) || "launch_failed",
				message: redactManagedValue(message),
				at: new Date().toISOString(),
			};
		});
	}

	managedWindow(conversationId: string): RuntimeConversation["managedWindow"] {
		return structuredClone(this.runtimeConversation(conversationId).managedWindow);
	}

	pendingInputs(conversationId: string): RuntimeConversation["pendingInputs"] {
		return structuredClone(this.runtimeConversation(conversationId).pendingInputs);
	}

	liveMediaBlobIds(): Set<string> {
		this.retirements.assertAvailable();
		return new Set(this.state.conversations.flatMap((conversation) => [
			...conversation.pendingInputs.filter((input) => input.media && input.status !== "completed" && input.status !== "cancelled").map((input) => input.media!.blobId),
			...conversation.artifactExports.filter((artifact) => artifact.state !== "sent" && !artifact.failure).map((artifact) => artifact.blobId),
		]));
	}

	private readonly refreshing = new Set<string>();

	isRefreshing(conversationId: string): boolean { return this.refreshing.has(conversationId); }

	beginRefresh(conversationId: string): void {
		const conversation = this.runtimeConversation(conversationId);
		if (this.refreshing.has(conversationId) || conversation.state === "starting" || this.hasGenerationBoundary(conversationId) ||
			conversation.pendingControls.length || conversation.pendingInputs.some((input) => input.status === "persisted" || input.status === "delivered")) {
			throw new RelayRegistryError("invalid_state", "Refresh refused: conversation is busy or has unsettled work");
		}
		this.refreshing.add(conversationId);
	}

	endRefresh(conversationId: string): void { this.refreshing.delete(conversationId); }

	artifactExports(conversationId?: string): Array<{ conversationId: string; artifact: RuntimeConversation["artifactExports"][number] }> {
		this.retirements.assertAvailable();
		return this.state.conversations.filter((conversation) => !conversationId || conversation.conversationId === conversationId)
			.flatMap((conversation) => conversation.artifactExports.map((artifact) => ({ conversationId: conversation.conversationId, artifact: structuredClone(artifact) })));
	}

	async recordArtifactExport(conversationId: string, artifact: RuntimeConversation["artifactExports"][number]): Promise<void> {
		await this.mutate(async () => {
			const conversation = this.runtimeConversation(conversationId);
			const existing = conversation.artifactExports.find((candidate) => candidate.uploadId === artifact.uploadId);
			if (existing) {
				const immutable = ["blobId", "sha256", "filename", "mimeType", "mediaType", "byteLength", "width", "height", "transactionId", "createdAt"] as const;
				if (immutable.some((field) => existing[field] !== artifact[field])) throw new RelayRegistryError("invalid_state", "Artifact export retry conflicts with durable state");
				Object.assign(existing, structuredClone(artifact));
			} else {
				if (conversation.artifactExports.length >= 256) throw new RelayRegistryError("capacity_reached", "Artifact export history capacity was reached");
				conversation.artifactExports.push(structuredClone(artifact));
			}
			parseHostRuntimeState(this.state);
		});
	}

	async markInputDelivered(conversationId: string, deliveryId: string): Promise<void> {
		await this.mutate(async () => {
			const input = this.runtimeConversation(conversationId).pendingInputs.find((candidate) => candidate.deliveryId === deliveryId);
			if (!input) throw new RelayRegistryError("not_found", "Managed delivery was not found");
			if (input.status === "accepted") input.status = "delivered";
		});
	}

	async acknowledgeInput(conversationId: string, deliveryId: string, status: string, piEntryId?: string, completionKind?: string): Promise<void> {
		await this.mutate(async () => {
			const input = this.runtimeConversation(conversationId).pendingInputs.find((candidate) => candidate.deliveryId === deliveryId);
			if (!input) throw new RelayRegistryError("not_found", "Managed delivery was not found");
			const rank: Record<string, number> = { accepted: 0, delivered: 1, persisted: 2, completed: 3, cancelled: 3 };
			const receiptAfterSocketDelivery = status === "accepted" && input.status === "delivered";
			if (!(status in rank) || (!receiptAfterSocketDelivery && rank[status]! < rank[input.status]!) ||
				((input.status === "completed" || input.status === "cancelled") && input.status !== status)) {
				throw new RelayRegistryError("invalid_state", "Managed delivery acknowledgement regressed");
			}
			if (status === "persisted" && !piEntryId) throw new RelayRegistryError("invalid_state", "Persisted delivery acknowledgement requires a Pi entry ID");
			if (completionKind === "extension_command") {
				if (status !== "completed" || piEntryId) throw new RelayRegistryError("invalid_state", "Extension-command completion is malformed");
			} else if (status === "completed" && !piEntryId) {
				throw new RelayRegistryError("invalid_state", "Ordinary completed delivery acknowledgement requires a Pi entry ID");
			}
			if (piEntryId && input.piEntryId && input.piEntryId !== piEntryId) {
				throw new RelayRegistryError("invalid_state", "Managed delivery changed its persisted Pi entry identity");
			}
			if (piEntryId) input.piEntryId = piEntryId;
			if (piEntryId) {
				const conversation = this.runtimeConversation(conversationId);
				const projection = conversation.projection.find((candidate) => candidate.entryId === piEntryId);
				if (projection && (projection.kind !== "matrix_user" || projection.status !== "projected" || projection.chunks.length !== 0)) {
					throw new RelayRegistryError("invalid_state", "Matrix-origin Pi entry conflicts with transcript projection state");
				}
				if (!projection) {
					if (conversation.projection.length >= MAX_PROJECTION_ENTRIES) throw new RelayRegistryError("capacity_reached", "Transcript projection capacity was reached");
					conversation.projection.push({ entryId: piEntryId, kind: "matrix_user", status: "projected", chunks: [] });
				}
			}
			if (!receiptAfterSocketDelivery) input.status = status;
		});
	}

	promotion(conversationId: string): RuntimeConversation["promotion"] {
		const value = this.runtimeConversation(conversationId).promotion;
		return value ? { ...value } : value;
	}

	pendingPromotionConversationIds(): string[] {
		this.retirements.assertAvailable();
		return this.state.conversations.filter((conversation) => conversation.promotion && ["shutdown_confirmed", "adopted"].includes(conversation.promotion.phase))
			.map((conversation) => conversation.conversationId);
	}

	async requestPromotion(conversationId: string): Promise<void> {
		await this.mutate(async () => {
			const conversation = this.runtimeConversation(conversationId);
			if (!conversation.promotion) throw new RelayRegistryError("invalid_state", "This conversation was not prepared for terminal-session promotion");
			if (conversation.managedWindow) throw new RelayRegistryError("invalid_state", "A managed conversation cannot be promoted again");
			if (conversation.state !== "active" || !conversation.attachment) throw new RelayRegistryError("invalid_state", "Promotion requires the attached terminal Pi session");
			if (conversation.promotion.phase === "adopted") throw new RelayRegistryError("invalid_state", "The promoted session has already been adopted");
			conversation.promotion.phase = "shutdown_requested";
		});
	}

	async markPromotionAdopted(conversationId: string): Promise<void> {
		await this.mutate(async () => {
			const promotion = this.runtimeConversation(conversationId).promotion;
			if (!promotion || promotion.phase !== "shutdown_confirmed") throw new RelayRegistryError("invalid_state", "Promotion is not ready for session adoption");
			promotion.phase = "adopted";
		});
	}

	async finishPromotion(conversationId: string): Promise<void> {
		await this.mutate(async () => {
			const conversation = this.runtimeConversation(conversationId);
			if (conversation.promotion?.phase !== "adopted") {
				throw new RelayRegistryError("invalid_state", "Promotion did not reach the adopted phase");
			}
			conversation.promotion = null;
		});
	}

	async setAttachmentNonce(conversationId: string, nonce: string): Promise<void> {
		if (!/^[A-Za-z0-9_-]{32,128}$/.test(nonce)) throw new RelayRegistryError("invalid_nonce", "Attachment nonce is invalid");
		await this.mutate(async () => {
			const conversation = this.runtimeConversation(conversationId);
			conversation.attachmentNonceHash = nonceHash(nonce);
		});
	}

	async attach(envelope: ManagedSessionEnvelope, connectionId: string): Promise<AcceptedAttachment> {
		if (envelope.type !== "attachment.attach" || !envelope.conversationId || envelope.role === "relay") {
			throw new RelayRegistryError("permission_denied", "First adapter message must be attachment.attach");
		}
		return this.mutate(async () => {
			const manifest = this.manifests.get(envelope.conversationId!);
			if (!manifest) throw new RelayRegistryError("not_found", "Managed conversation was not found");
			const role = envelope.role as AdapterRole;
			if (role !== expectedRole(manifest)) throw new RelayRegistryError("permission_denied", "Adapter role is not authorized for this conversation");
			const payload = envelope.payload as { sessionId: string; attachmentNonce: string; bindingBoundaryEntryId: string; runtimeId?: string; requestedCapabilities?: string[] };
			if (payload.sessionId !== manifest.piSessionId || payload.bindingBoundaryEntryId !== manifest.bindingBoundaryEntryId) {
				throw new RelayRegistryError("permission_denied", "Adapter session binding does not match the conversation manifest");
			}
			const conversation = this.runtimeConversation(manifest.conversationId);
			if (!conversation.attachmentNonceHash || !equalHash(conversation.attachmentNonceHash, nonceHash(payload.attachmentNonce))) {
				throw new RelayRegistryError("invalid_nonce", "Attachment nonce was rejected");
			}
			if (!hasMatrixBinding(manifest) && !payload.requestedCapabilities?.includes("local-enrollment-v1")) {
				throw new RelayRegistryError("matrix_unavailable", "Local enrollment requires a capable adapter while Matrix binding is pending");
			}
			const liveConnection = this.liveConnections.get(manifest.conversationId);
			if (liveConnection && liveConnection !== connectionId) {
				throw new RelayRegistryError("attachment_conflict", "Conversation already has an attached adapter");
			}
			if (conversation.attachment && !this.restartReconciling && liveConnection !== connectionId) {
				throw new RelayRegistryError("attachment_conflict", "Conversation already has an attached adapter");
			}
			const attachmentId = `attachment-${randomUUID()}`;
			conversation.state = "active";
			conversation.attachment = { attachmentId, sessionId: payload.sessionId, connectedAt: new Date().toISOString(), ...(payload.runtimeId ? { runtimeId: payload.runtimeId } : {}) };
			this.liveConnections.set(manifest.conversationId, connectionId);
			return { attachmentId, conversationId: manifest.conversationId, role, state: "active", generation: this.activeGeneration(manifest).ordinal };
		});
	}

	assertAuthorized(envelope: ManagedSessionEnvelope, connectionId: string, attachment: AcceptedAttachment): void {
		if (envelope.role === "relay" || envelope.conversationId !== attachment.conversationId || envelope.role !== attachment.role) {
			throw new RelayRegistryError("permission_denied", "Message role or conversation does not match the attachment");
		}
		if (this.liveConnections.get(attachment.conversationId) !== connectionId) {
			throw new RelayRegistryError("invalid_state", "Adapter attachment is no longer active");
		}
	}

	async detach(connectionId: string, attachment: AcceptedAttachment, requestedAttachmentId?: string, reason?: "shutdown" | "session_change" | "stop" | "bridge_delete"): Promise<void> {
		await this.mutate(async () => {
			if (this.liveConnections.get(attachment.conversationId) !== connectionId) return;
			const conversation = this.runtimeConversation(attachment.conversationId);
			if (requestedAttachmentId && conversation.attachment?.attachmentId !== requestedAttachmentId) {
				throw new RelayRegistryError("permission_denied", "Attachment ID does not match this connection");
			}
			this.liveConnections.delete(attachment.conversationId);
			conversation.state = "dormant";
			conversation.attachment = null;
			if (reason === "shutdown" && conversation.promotion?.phase === "shutdown_requested") {
				conversation.promotion.phase = "shutdown_confirmed";
			}
		});
	}

	snapshot(): HostRuntimeState {
		this.retirements.assertAvailable();
		return structuredClone(this.state);
	}

	/** Only original frozen cleanup resources; never an ordinary conversation inventory. */
	retirementRoomIds(): string[] {
		return [...new Set(this.pendingRetirements().flatMap((record) => (record.cleanup ?? []).flatMap((effect) => effect.kind === "stop" ? [] : [effect.roomId])))];
	}
	managedRoomIds(): string[] {
		this.retirements.assertAvailable();
		return [...new Set([...this.manifests.values()].flatMap((manifest) => [manifest.roomId, manifest.hostSpace, manifest.projectSpace, manifest.checkoutSpace]
			.filter((roomId): roomId is string => roomId !== undefined)))];
	}

	private checkpointPollClosure(conversation: RuntimeConversation, poll: NonNullable<RuntimeConversation["activeCheckpointPoll"]>, resolutionEventId: string,
		fallback: "Selection accepted" | "Answered by text", selectedAnswerId?: string): RuntimeConversation["closingCheckpointPolls"][number] {
		if (conversation.closingCheckpointPolls.length >= 64) throw new RelayRegistryError("capacity_reached", "Checkpoint poll closure capacity was reached");
		const closing = { ...structuredClone(poll), resolutionEventId, ...(selectedAnswerId ? { selectedAnswerId } : {}),
			closureTransactionId: deriveMatrixTransactionId(conversation.conversationId, poll.pollEventId, 0), fallback };
		conversation.closingCheckpointPolls.push(closing);
		return closing;
	}

	private addPendingInput(conversation: RuntimeConversation, input: RuntimeConversation["pendingInputs"][number]): boolean {
		const existing = conversation.pendingInputs.find((candidate) => candidate.deliveryId === input.deliveryId || candidate.matrixEventId === input.matrixEventId);
		if (existing) {
			if (existing.deliveryId !== input.deliveryId || existing.matrixEventId !== input.matrixEventId || existing.senderUserId !== input.senderUserId || existing.kind !== input.kind ||
				existing.body !== input.body || JSON.stringify(existing.media) !== JSON.stringify(input.media)) {
				throw new RelayRegistryError("invalid_state", "Conflicting accepted Matrix input identity");
			}
			return false;
		}
		if (conversation.pendingInputs.length >= MAX_PENDING_INPUTS) throw new RelayRegistryError("capacity_reached", "Pending input capacity was reached");
		conversation.pendingInputs.push(input);
		return true;
	}

	private addPendingControl(conversation: RuntimeConversation, control: RuntimeConversation["pendingControls"][number]): boolean {
		if (conversation.completedControlIds.includes(control.controlId)) return false;
		const existing = conversation.pendingControls.find((candidate) =>
			candidate.controlId === control.controlId || candidate.matrixEventId === control.matrixEventId);
		if (existing) {
			if (JSON.stringify(existing) !== JSON.stringify(control)) throw new RelayRegistryError("invalid_state", "Conflicting pending control identity");
			return false;
		}
		if (conversation.pendingControls.length >= MAX_PENDING_CONTROLS) throw new RelayRegistryError("capacity_reached", "Pending control capacity was reached");
		conversation.pendingControls.push(control);
		return true;
	}

	private async updateActiveGenerationPreference(conversationId: string, kind: "model" | "thinking", value: string): Promise<SessionGeneration> {
		return this.mutate(async () => {
			const current = this.boundConversation(conversationId);
			const active = this.activeGeneration(current);
			if (active.generationId !== (current.activeGenerationId ?? deriveGenerationId(conversationId, 1))) {
				throw new RelayRegistryError("invalid_state", `Active generation is unavailable for ${kind} selection persistence`);
			}
			const replacement: ConversationManifest = kind === "model" ? { ...current, selectedModel: value } : { ...current, selectedThinking: value };
			await this.manifestStore.write(replacement);
			this.manifests.set(conversationId, replacement);
			return { ...structuredClone(active), [kind]: value };
		});
	}

	/** Private, bounded preparation snapshot; retireConversation revalidates it at commit. */
	retirementCandidate(conversationId: string): { manifest: RegisteredConversation; generationId: string; state: RuntimeConversation["state"]; unresolvedLaunch: boolean; attachmentId?: string; window: RuntimeConversation["managedWindow"] } {
		this.assertNotRetired(conversationId);
		const manifest = this.manifests.get(conversationId);
		if (!manifest || manifest.kind !== "project") throw new RelayRegistryError("permission_denied", "Retirement requires a project conversation");
		const runtime = this.runtimeConversation(conversationId);
		return { manifest: structuredClone(manifest), generationId: this.activeGeneration(manifest).generationId, state: runtime.state, unresolvedLaunch: runtime.state === "starting" || runtime.launch?.observed === false,
			...(runtime.attachment ? { attachmentId: runtime.attachment.attachmentId } : {}), window: structuredClone(runtime.managedWindow) };
	}
	retirement(conversationId: string): RetirementRecord | undefined { return this.retirements.get(conversationId); }
	pendingRetirements(): RetirementRecord[] { return this.retirements.pending(); }
	markRetirementCleanup(conversationId: string, effectId: string, phase: "blocked" | "done"): Promise<RetirementRecord> { return this.retirements.progress(conversationId, effectId, phase); }

	/** Owner-resolved targets only. Commit terminal authority before runtime removal or any cleanup. */
	async retireConversation(conversationId: string, targets: RetirementTarget[]): Promise<RetirementRecord> {
		return this.mutate(async () => {
			const previous = this.retirements.get(conversationId); if (previous) return previous;
			const manifest = this.manifests.get(conversationId);
			if (!manifest) throw new RelayRegistryError("not_found", "Managed conversation was not found");
			if (manifest.kind !== "project") throw new RelayRegistryError("permission_denied", "Coordinator cannot be retired");
			const runtime = this.runtimeConversation(conversationId); const generation = this.activeGeneration(manifest);
			const roomId = hasMatrixBinding(manifest) ? manifest.roomId : manifest.verifiedBinding?.roomId;
			if (!targets.some((target) => target.kind === "stop") || roomId && (!targets.some((target) => target.kind === "operator_leave_forget") || !targets.some((target) => target.kind === "bot_leave")))
				throw new RelayRegistryError("invalid_state", "Retirement omitted required exact cleanup");
			for (const target of targets) {
				if (target.kind === "stop" && (target.generationId !== generation.generationId || target.attachmentId !== runtime.attachment?.attachmentId ||
					Boolean(target.unresolvedLaunch) !== (runtime.state === "starting" || runtime.launch?.observed === false) || Boolean(target.unresolvedBinding) !== (!hasMatrixBinding(manifest) && !manifest.verifiedBinding) ||
					Boolean(target.window) !== Boolean(runtime.managedWindow) || target.window && (target.window.windowId !== runtime.managedWindow?.windowId || target.window.paneId !== runtime.managedWindow?.paneId || target.window.sessionName !== runtime.managedWindow?.sessionName || !isDeepStrictEqual(target.window.ownership, runtime.managedWindow?.ownership))))
					throw new RelayRegistryError("invalid_state", "Retirement stop target changed");
				if ((target.kind === "operator_leave_forget" || target.kind === "bot_leave") && target.roomId !== roomId) throw new RelayRegistryError("invalid_state", "Retirement room target changed");
				if (target.kind === "ancestor") {
					const checkout = hasMatrixBinding(manifest) ? manifest.checkoutSpace : manifest.verifiedBinding?.checkoutSpace;
					const project = hasMatrixBinding(manifest) ? manifest.projectSpace : manifest.verifiedBinding?.projectSpace;
					const hostSpace = [...this.manifests.values()].find((item) => item.kind === "coordinator")?.hostSpace;
					if (!("projectKey" in target.provenance) || target.provenance.projectKey !== manifest.projectKey ||
						target.spaceKind === "checkout_space" && (!("checkoutId" in target.provenance) || target.provenance.checkoutId !== manifest.checkoutId) ||
						!("parentRoomId" in target.provenance) || target.provenance.parentRoomId !== (target.spaceKind === "checkout_space" ? project : hostSpace) ||
						target.roomId === hostSpace || target.roomId !== (target.spaceKind === "checkout_space" ? checkout : project) || target.childRoomId !== (target.spaceKind === "checkout_space" ? roomId : checkout))
						throw new RelayRegistryError("invalid_state", "Retirement ancestor target changed");
				}
			}
			const id = retirementId(this.hostId, conversationId);
			const record = await this.retirements.retire({ version: 1, hostId: this.hostId, conversationId, creationKey: manifest.creationKey, retirementId: id, retiredAt: Date.now(),
				cleanup: targets.map((target) => ({ ...target, effectId: retirementEffectId(id, target), phase: "pending" })) });
			this.pruneRetired(); return record;
		});
	}
	private assertNotRetired(conversationId: string): void {
		if (this.retirements.has(conversationId)) throw new RelayRegistryError("invalid_state", "Managed conversation is permanently retired");
	}
	private pruneRetired(): void {
		this.retirements.assertAvailable();
		const excluded = new Set<string>();
		for (const [id, manifest] of this.manifests) if (this.retirements.has(id) || this.retirements.hasCreationKey(manifest.creationKey)) { excluded.add(id); this.manifests.delete(id); this.liveConnections.delete(id); }
		this.state.conversations = this.state.conversations.filter((item) => !excluded.has(item.conversationId) && !this.retirements.has(item.conversationId));
		if (this.state.localConversations) this.state.localConversations = this.state.localConversations.filter((item) => !excluded.has(item.conversationId) && !this.retirements.has(item.conversationId));
	}

	private boundConversation(conversationId: string): ConversationManifest {
		this.assertNotRetired(conversationId);
		const manifest = this.manifests.get(conversationId);
		if (!manifest) throw new RelayRegistryError("not_found", "Managed conversation was not found");
		if (!hasMatrixBinding(manifest)) throw new RelayRegistryError("matrix_unavailable", "Matrix binding is pending");
		return manifest;
	}

	private runtimeConversation(conversationId: string): RuntimeConversation {
		this.assertNotRetired(conversationId);
		const conversation = this.state.conversations.find((candidate) => candidate.conversationId === conversationId);
		if (!conversation) throw new RelayRegistryError("not_found", "Managed conversation runtime state was not found");
		return conversation;
	}

	private async mutate<T>(operation: () => Promise<T>): Promise<T> {
		let result!: T;
		let failure: unknown;
		const run = this.operations.then(async () => {
			this.retirements.assertAvailable();
			const before = structuredClone(this.state);
			const liveBefore = new Map(this.liveConnections);
			const manifestsBefore = new Map(this.manifests);
			try {
				result = await operation();
				this.pruneRetired();
				await this.runtimeFile.write(this.state);
			} catch (error) {
				this.state = before;
				this.manifests = manifestsBefore;
				this.liveConnections.clear();
				for (const [conversationId, connectionId] of liveBefore) this.liveConnections.set(conversationId, connectionId);
				// Runtime rollback can never roll back separately committed negative authority.
				this.pruneRetired();
				failure = error;
			}
		});
		this.operations = run.catch(() => undefined);
		await run;
		try { this.notifyRuntimeObservers(); } catch { /* Observers fail closed independently of committed mutations. */ }
		if (failure) throw failure;
		return result;
	}
}
