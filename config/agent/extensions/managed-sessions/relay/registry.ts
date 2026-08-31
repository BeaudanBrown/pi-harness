import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { join, resolve } from "node:path";
import {
	MANAGED_SESSION_STATE_VERSION,
	type ConversationManifest,
	type HostRuntimeState,
	type ManagedSessionEnvelope,
	parseHostRuntimeState,
	parsePersistenceBundle,
} from "../contracts.js";
import { AtomicJsonFile, ensurePrivateDirectory } from "./atomic-json.js";
import { ConversationManifestStore } from "./manifest-store.js";

type RuntimeConversation = HostRuntimeState["conversations"][number];
type AdapterRole = "ordinary_adapter" | "coordinator_adapter";

export class RelayRegistryError extends Error {
	constructor(
		readonly code: "permission_denied" | "invalid_nonce" | "attachment_conflict" | "not_found" | "invalid_state",
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
				pendingInputs: [],
				projection: [],
				managedWindow: null,
			})),
		};
		const bundle = parsePersistenceBundle(manifests, runtime);
		this.manifests = new Map(bundle.manifests.map((manifest) => [manifest.conversationId, manifest]));
		this.state = bundle.runtime;
		if (!stored) await this.runtimeFile.write(this.state);
	}

	beginRestartReconciliation(): void {
		this.restartReconciling = true;
		this.liveConnections.clear();
	}

	async finishRestartReconciliation(): Promise<void> {
		await this.mutate(async () => {
			for (const conversation of this.state.conversations) {
				if (conversation.state === "active" && !this.liveConnections.has(conversation.conversationId)) {
					conversation.state = "dormant";
					conversation.attachment = null;
				}
			}
			this.restartReconciling = false;
		});
	}

	async setMatrixCursor(conversationId: string, matrixSince: string): Promise<void> {
		await this.mutate(async () => {
			this.runtimeConversation(conversationId).matrixSince = matrixSince;
		});
	}

	async recordAcceptedInput(conversationId: string, input: RuntimeConversation["pendingInputs"][number]): Promise<void> {
		await this.mutate(async () => {
			const conversation = this.runtimeConversation(conversationId);
			const existing = conversation.pendingInputs.find((candidate) => candidate.deliveryId === input.deliveryId || candidate.matrixEventId === input.matrixEventId);
			if (existing) {
				if (JSON.stringify(existing) !== JSON.stringify(input)) throw new RelayRegistryError("invalid_state", "Conflicting accepted Matrix input identity");
				return;
			}
			conversation.pendingInputs.push(input);
			parseHostRuntimeState(this.state);
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
					pendingInputs: [],
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

	async deleteConversation(conversationId: string): Promise<DeletedConversation> {
		const manifest = this.manifests.get(conversationId);
		const runtime = this.state.conversations.find((candidate) => candidate.conversationId === conversationId);
		if (!manifest || !runtime) throw new RelayRegistryError("not_found", "Managed conversation was not found");
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

	async acknowledgeInput(conversationId: string, deliveryId: string, status: string, piEntryId?: string): Promise<void> {
		await this.mutate(async () => {
			const input = this.runtimeConversation(conversationId).pendingInputs.find((candidate) => candidate.deliveryId === deliveryId);
			if (!input) throw new RelayRegistryError("not_found", "Managed delivery was not found");
			const rank: Record<string, number> = { accepted: 0, delivered: 1, persisted: 2, completed: 3, cancelled: 3 };
			if (!(status in rank) || rank[status]! < rank[input.status]! ||
				((input.status === "completed" || input.status === "cancelled") && input.status !== status)) {
				throw new RelayRegistryError("invalid_state", "Managed delivery acknowledgement regressed");
			}
			if ((status === "persisted" || status === "completed") && !piEntryId) {
				throw new RelayRegistryError("invalid_state", "Persisted delivery acknowledgement requires a Pi entry ID");
			}
			input.status = status;
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
			return { attachmentId, conversationId: manifest.conversationId, role, state: "active" };
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
		return [...this.manifests.values()].map((manifest) => manifest.roomId);
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
