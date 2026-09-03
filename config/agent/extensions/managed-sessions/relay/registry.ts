import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { join, resolve } from "node:path";
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
	type SessionGeneration,
	type HostRuntimeState,
	type ManagedSessionEnvelope,
	parseHostRuntimeState,
	parsePersistenceBundle,
} from "../contracts.js";
import { AtomicJsonFile, ensurePrivateDirectory } from "./atomic-json.js";
import { ConversationManifestStore } from "./manifest-store.js";
import { redactManagedValue } from "./redaction.js";

type RuntimeConversation = HostRuntimeState["conversations"][number];
type AdapterRole = "ordinary_adapter" | "coordinator_adapter";

export class RelayRegistryError extends Error {
	constructor(
		readonly code: "permission_denied" | "invalid_nonce" | "attachment_conflict" | "not_found" | "invalid_state" | "capacity_reached" | "launch_failed" | "matrix_unavailable",
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

function expectedRole(manifest: ConversationManifest): AdapterRole {
	return manifest.kind === "coordinator" ? "coordinator_adapter" : "ordinary_adapter";
}

export interface DeletedConversation {
	manifest: ConversationManifest;
	runtime: RuntimeConversation;
	connectionId?: string;
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
	private manifests = new Map<string, ConversationManifest>();
	private state: HostRuntimeState;
	private readonly liveConnections = new Map<string, string>();
	private operations: Promise<void> = Promise.resolve();
	private restartReconciling = false;

	constructor(
		readonly hostId: string,
		runtimeRoot: string,
		private readonly manifestStore: ConversationManifestStore,
	) {
		this.runtimeFile = new AtomicJsonFile(join(resolve(runtimeRoot), "registry.json"), parseHostRuntimeState);
		this.state = { schemaVersion: MANAGED_SESSION_STATE_VERSION, hostId, conversations: [] };
	}

	async load(): Promise<void> {
		await ensurePrivateDirectory(resolve(this.runtimeFile.path, ".."));
		const manifests = await this.manifestStore.list();
		const stored = await this.runtimeFile.read();
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
		this.manifests = new Map(bundle.manifests.map((manifest) => [manifest.conversationId, manifest]));
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
					existing.chunks.length !== projection.chunks.length || existing.chunks.some((chunk, index) =>
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
		const manifest = [...this.manifests.values()].find((candidate) => candidate.creationKey === creationKey);
		return manifest ? structuredClone(manifest) : undefined;
	}

	manifestByConversationId(conversationId: string): ConversationManifest | undefined {
		const manifest = this.manifests.get(conversationId);
		return manifest ? structuredClone(manifest) : undefined;
	}

	conversationState(conversationId: string): "starting" | "active" | "dormant" {
		return this.runtimeConversation(conversationId).state;
	}

	listManifests(): ConversationManifest[] {
		return [...this.manifests.values()].map((manifest) => structuredClone(manifest));
	}

	activeGeneration(manifest: ConversationManifest): SessionGeneration {
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

	isActiveGenerationAttached(conversationId: string): boolean {
		const conversation = this.runtimeConversation(conversationId); const manifest = this.manifests.get(conversationId);
		return Boolean(manifest && this.liveConnections.has(conversationId) && conversation.state === "active" && conversation.attachment?.sessionId === manifest.piSessionId);
	}

	generationTransitions(): Array<{ conversationId: string; transition: NonNullable<RuntimeConversation["generationTransition"]> }> {
		return this.state.conversations.flatMap((conversation) => conversation.generationTransition ? [{ conversationId: conversation.conversationId, transition: structuredClone(conversation.generationTransition) }] : []);
	}

	async beginGenerationTransition(conversationId: string, sourceControlId: string, metadata: { model?: string; thinking?: string }): Promise<NonNullable<RuntimeConversation["generationTransition"]>> {
		return this.mutate(async () => {
			const conversation = this.runtimeConversation(conversationId);
			const manifest = this.manifests.get(conversationId);
			if (!manifest || manifest.kind !== "project") throw new RelayRegistryError("permission_denied", "Only project conversations support fresh generations");
			if (conversation.generationTransition) {
				if (conversation.generationTransition.sourceControlId !== sourceControlId) throw new RelayRegistryError("invalid_state", "Another generation transition is unresolved");
				return structuredClone(conversation.generationTransition);
			}
			const active = this.activeGeneration(manifest); const ordinal = active.ordinal + 1;
			const transition = { transitionId: deriveGenerationTransitionId(conversationId, active.ordinal, ordinal), sourceControlId, phase: "requested" as const,
				fromGenerationId: active.generationId, toGenerationId: deriveGenerationId(conversationId, ordinal), ordinal, requestedAt: new Date().toISOString(), ...metadata };
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
		const current = this.manifests.get(conversationId);
		const transition = this.runtimeConversation(conversationId).generationTransition;
		if (!current || !transition || transition.transitionId !== transitionId || !transition.toPiSessionId || !transition.toBindingBoundaryEntryId) throw new RelayRegistryError("invalid_state", "Persisted generation is unavailable for activation");
		let replacement = current;
		if (current.activeGenerationId !== transition.toGenerationId) {
			const history = current.generations ?? [this.activeGeneration(current)];
			if (history.at(-1)?.generationId !== transition.fromGenerationId) throw new RelayRegistryError("invalid_state", "Generation activation no longer follows the active generation");
			const generation: SessionGeneration = { generationId: transition.toGenerationId, ordinal: transition.ordinal, piSessionId: transition.toPiSessionId,
				bindingBoundaryEntryId: transition.toBindingBoundaryEntryId, createdAt: new Date().toISOString(), ...(transition.model ? { model: transition.model } : {}), ...(transition.thinking ? { thinking: transition.thinking } : {}) };
			replacement = { ...current, piSessionId: generation.piSessionId, bindingBoundaryEntryId: generation.bindingBoundaryEntryId,
				activeGenerationId: generation.generationId, generations: [...history, generation] };
			await this.manifestStore.write(replacement);
		}
		return this.mutate(async () => {
			const live = this.runtimeConversation(conversationId).generationTransition;
			if (!live || live.transitionId !== transitionId) throw new RelayRegistryError("invalid_state", "Generation transition changed during activation");
			this.manifests.set(conversationId, replacement); this.liveConnections.delete(conversationId);
			const runtime = this.runtimeConversation(conversationId); runtime.attachment = null; runtime.state = "starting"; live.phase = "activated"; delete live.failure;
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
		return [...this.manifests.values()].map((manifest) => ({
			conversationId: manifest.conversationId, concept: manifest.concept, kind: manifest.kind,
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

	async createProjectConversation(manifest: ConversationManifest, nonce: string): Promise<ConversationManifest> {
		if (manifest.kind !== "project" || manifest.ownerHostId !== this.hostId || !manifest.placement) {
			throw new RelayRegistryError("permission_denied", "Self binding requires a host-owned project manifest");
		}
		if (!/^[A-Za-z0-9_-]{32,128}$/.test(nonce)) throw new RelayRegistryError("invalid_nonce", "Attachment nonce is invalid");
		let created = false;
		try {
			return await this.mutate(async () => {
				const existing = [...this.manifests.values()].find((candidate) =>
					candidate.creationKey === manifest.creationKey || candidate.conversationId === manifest.conversationId ||
					candidate.piSessionId === manifest.piSessionId || candidate.concept === manifest.concept);
				if (existing) {
					if (existing.creationKey === manifest.creationKey && existing.conversationId === manifest.conversationId &&
						existing.piSessionId === manifest.piSessionId && existing.concept === manifest.concept &&
						existing.bindingBoundaryEntryId === manifest.bindingBoundaryEntryId &&
						JSON.stringify(existing.placement) === JSON.stringify(manifest.placement)) {
						const runtime = this.runtimeConversation(existing.conversationId);
						if (!runtime.attachmentNonceHash || !equalHash(runtime.attachmentNonceHash, nonceHash(nonce))) {
							throw new RelayRegistryError("invalid_nonce", "Attachment nonce does not match the existing binding");
						}
						return existing;
					}
					throw new RelayRegistryError("invalid_state", "Managed conversation identity already exists");
				}
				await this.manifestStore.write(manifest);
				created = true;
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
				});
				return manifest;
			});
		} catch (error) {
			if (created) await this.manifestStore.remove(manifest.conversationId).catch(() => undefined);
			throw error;
		}
	}

	async createCoordinatorConversation(manifest: ConversationManifest): Promise<ConversationManifest> {
		if (manifest.kind !== "coordinator" || manifest.ownerHostId !== this.hostId) {
			throw new RelayRegistryError("permission_denied", "Coordinator bootstrap requires a host-owned coordinator manifest");
		}
		let written = false;
		try {
			return await this.mutate(async () => {
			const existingCoordinator = [...this.manifests.values()].find((candidate) => candidate.kind === "coordinator");
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
		const existing = this.manifests.get(conversationId);
		if (!existing || existing.kind !== "project") throw new RelayRegistryError("not_found", "Project conversation was not found");
		const hash = (value: ConversationManifest) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
		const currentHash = hash(existing);
		if (currentHash === targetHash) return existing;
		if (currentHash !== sourceHash || existing.projectKey !== undefined || existing.projectDisplayName !== undefined ||
			existing.checkoutDisplayName !== undefined) throw new RelayRegistryError("invalid_state", "Project manifest changed after reconciliation preview");
		const replacement = { ...existing, ...identity };
		if (hash(replacement) !== targetHash) throw new RelayRegistryError("invalid_state", "Project reconciliation target identity changed");
		await this.manifestStore.write(replacement);
		try {
			return await this.mutate(async () => { this.manifests.set(conversationId, replacement); return replacement; });
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
			conversation.managedWindow = window;
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
		return new Set(this.state.conversations.flatMap((conversation) => [
			...conversation.pendingInputs.filter((input) => input.media && input.status !== "completed" && input.status !== "cancelled").map((input) => input.media!.blobId),
			...conversation.artifactExports.filter((artifact) => artifact.state !== "sent").map((artifact) => artifact.blobId),
		]));
	}

	artifactExports(conversationId?: string): Array<{ conversationId: string; artifact: RuntimeConversation["artifactExports"][number] }> {
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

	async deleteConversation(conversationId: string): Promise<DeletedConversation> {
		const manifest = this.manifests.get(conversationId);
		const runtime = this.state.conversations.find((candidate) => candidate.conversationId === conversationId);
		if (!manifest || !runtime) throw new RelayRegistryError("not_found", "Managed conversation was not found");
		if (manifest.kind === "coordinator") throw new RelayRegistryError("permission_denied", "The guaranteed coordinator conversation cannot be deleted");
		const savedManifest = structuredClone(manifest);
		const savedRuntime = structuredClone(runtime);
		const savedConnection = this.liveConnections.get(conversationId);
		await this.mutate(async () => {
			this.manifests.delete(conversationId);
			this.liveConnections.delete(conversationId);
			this.state.conversations = this.state.conversations.filter((candidate) => candidate.conversationId !== conversationId);
		});
		try {
			await this.manifestStore.remove(conversationId);
		} catch (error) {
			await this.mutate(async () => {
				this.manifests.set(conversationId, savedManifest);
				this.state.conversations.push(savedRuntime);
				if (savedConnection) this.liveConnections.set(conversationId, savedConnection);
			});
			throw error;
		}
		return { manifest: savedManifest, runtime: savedRuntime, ...(savedConnection ? { connectionId: savedConnection } : {}) };
	}

	async restoreDeletedConversation(deleted: DeletedConversation): Promise<void> {
		await this.manifestStore.write(deleted.manifest);
		try {
			await this.mutate(async () => {
				if (this.manifests.has(deleted.manifest.conversationId)) return;
				this.manifests.set(deleted.manifest.conversationId, deleted.manifest);
				this.state.conversations.push(deleted.runtime);
				if (deleted.connectionId) this.liveConnections.set(deleted.manifest.conversationId, deleted.connectionId);
			});
		} catch (error) {
			await this.manifestStore.remove(deleted.manifest.conversationId).catch(() => undefined);
			throw error;
		}
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
			const payload = envelope.payload as { sessionId: string; attachmentNonce: string; bindingBoundaryEntryId: string };
			if (payload.sessionId !== manifest.piSessionId || payload.bindingBoundaryEntryId !== manifest.bindingBoundaryEntryId) {
				throw new RelayRegistryError("permission_denied", "Adapter session binding does not match the conversation manifest");
			}
			const conversation = this.runtimeConversation(manifest.conversationId);
			if (!conversation.attachmentNonceHash || !equalHash(conversation.attachmentNonceHash, nonceHash(payload.attachmentNonce))) {
				throw new RelayRegistryError("invalid_nonce", "Attachment nonce was rejected");
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
			conversation.attachment = { attachmentId, sessionId: payload.sessionId, connectedAt: new Date().toISOString() };
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

	async detach(connectionId: string, attachment: AcceptedAttachment, requestedAttachmentId?: string): Promise<void> {
		await this.mutate(async () => {
			if (this.liveConnections.get(attachment.conversationId) !== connectionId) return;
			const conversation = this.runtimeConversation(attachment.conversationId);
			if (requestedAttachmentId && conversation.attachment?.attachmentId !== requestedAttachmentId) {
				throw new RelayRegistryError("permission_denied", "Attachment ID does not match this connection");
			}
			this.liveConnections.delete(attachment.conversationId);
			conversation.state = "dormant";
			conversation.attachment = null;
		});
	}

	snapshot(): HostRuntimeState {
		return structuredClone(this.state);
	}

	managedRoomIds(): string[] {
		return [...new Set([...this.manifests.values()].flatMap((manifest) => [manifest.roomId, manifest.hostSpace, manifest.projectSpace]
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
			if (existing.deliveryId !== input.deliveryId || existing.matrixEventId !== input.matrixEventId || existing.kind !== input.kind ||
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

	private runtimeConversation(conversationId: string): RuntimeConversation {
		const conversation = this.state.conversations.find((candidate) => candidate.conversationId === conversationId);
		if (!conversation) throw new RelayRegistryError("not_found", "Managed conversation runtime state was not found");
		return conversation;
	}

	private async mutate<T>(operation: () => Promise<T>): Promise<T> {
		let result!: T;
		let failure: unknown;
		const run = this.operations.then(async () => {
			const before = structuredClone(this.state);
			const liveBefore = new Map(this.liveConnections);
			const manifestsBefore = new Map(this.manifests);
			try {
				result = await operation();
				await this.runtimeFile.write(this.state);
			} catch (error) {
				this.state = before;
				this.manifests = manifestsBefore;
				this.liveConnections.clear();
				for (const [conversationId, connectionId] of liveBefore) this.liveConnections.set(conversationId, connectionId);
				failure = error;
			}
		});
		this.operations = run.catch(() => undefined);
		await run;
		if (failure) throw failure;
		return result;
	}
}
