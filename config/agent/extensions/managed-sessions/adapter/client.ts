import { createHash, randomUUID } from "node:crypto";
import { connect, type Socket } from "node:net";
import {
	MANAGED_SESSION_PROTOCOL_VERSION,
	MAX_NDJSON_FRAME_BYTES,
	type ManagedSessionEnvelope,
	type WorkspaceIdentity,
	encodeNdjsonEnvelope,
	parseNdjsonEnvelope,
} from "../contracts.js";
import type { AdapterRole, SessionBinding } from "./state.js";
import { artifactChunks, type WorkspaceArtifact } from "./artifact-export.js";

const REQUEST_TIMEOUT_MS = 5_000;
const LIFECYCLE_REQUEST_TIMEOUT_MS = 120_000;

export class ManagedAdapterError extends Error {
	constructor(message: string, readonly code = "adapter_error") {
		super(message);
		this.name = "ManagedAdapterError";
	}
}

interface PendingRequest {
	resolve: (envelope: ManagedSessionEnvelope) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

function messageId(prefix: string): string {
	return `${prefix}-${randomUUID()}`;
}

export interface ReceivedImage {
	deliveryId: string; matrixEventId: string; senderUserId?: string; blobId: string; sha256: string; mimeType: "image/jpeg" | "image/png" | "image/webp";
	byteLength: number; width: number; height: number; caption: string; data: Buffer;
}

export interface BoundAdapterOptions {
	socketPath: string;
	role: AdapterRole;
	attachmentNonce: string;
	binding: SessionBinding;
	onEnvelope: (envelope: ManagedSessionEnvelope) => Promise<void> | void;
	onMedia?: (image: ReceivedImage) => Promise<void> | void;
	onDisconnect?: () => void;
}

export class BoundAdapterClient {
	#socket?: Socket;
	#buffer = Buffer.alloc(0);
	#pending = new Map<string, PendingRequest>();
	#attachmentId?: string;
	#generation = 1;
	#closing = false;
	#inboundWork: Promise<void> = Promise.resolve();
	#media = new Map<string, { descriptor: Omit<ReceivedImage, "data"> & { chunkCount: number }; chunks: Buffer[] }>();

	constructor(protected readonly options: BoundAdapterOptions) {}

	get generation(): number { return this.#generation; }

	get connected(): boolean {
		return this.#socket !== undefined && !this.#socket.destroyed && this.#attachmentId !== undefined;
	}

	async connect(): Promise<void> {
		if (this.#socket) throw new ManagedAdapterError("Adapter is already connected");
		this.#closing = false;
		const socket = await openSocket(this.options.socketPath);
		this.#socket = socket;
		socket.on("data", (chunk) => this.consume(chunk));
		socket.on("error", () => undefined);
		socket.on("close", () => this.handleClose());
		try {
			const response = await this.request({
				protocolVersion: MANAGED_SESSION_PROTOCOL_VERSION,
				messageId: messageId("attach"),
				conversationId: this.options.binding.conversationId,
				role: this.options.role,
				type: "attachment.attach",
				payload: {
					sessionId: this.options.binding.sessionId,
					attachmentNonce: this.options.attachmentNonce,
					bindingBoundaryEntryId: this.options.binding.bindingBoundaryEntryId,
				},
			});
			if (response.type !== "attachment.accepted") throw responseError(response);
			this.#attachmentId = String(response.payload.attachmentId);
			this.#generation = Number.isSafeInteger(response.payload.generation) ? Number(response.payload.generation) : 1;
		} catch (error) {
			socket.destroy();
			throw error;
		}
	}

	async acknowledgeInput(deliveryId: string, status: "accepted" | "persisted" | "completed" | "cancelled", piEntryId?: string,
		completionKind?: "extension_command"): Promise<void> {
		const result = await this.request({
			protocolVersion: MANAGED_SESSION_PROTOCOL_VERSION,
			messageId: messageId("ack"),
			conversationId: this.options.binding.conversationId,
			role: this.options.role,
			type: "input.acknowledge",
			payload: { deliveryId, status, ...(piEntryId ? { piEntryId } : {}), ...(completionKind ? { completionKind } : {}) },
		});
		if (result.type !== "input.result" || result.payload.deliveryId !== deliveryId || result.payload.status !== status) {
			throw new ManagedAdapterError("Relay did not confirm input acknowledgement", "invalid_response");
		}
	}

	async updateActivity(payload: Record<string, unknown>, finalize = false): Promise<void> {
		if (this.options.role !== "ordinary_adapter") return;
		const result = await this.request({
			protocolVersion: MANAGED_SESSION_PROTOCOL_VERSION,
			messageId: messageId("activity"), conversationId: this.options.binding.conversationId,
			role: "ordinary_adapter", type: finalize ? "activity.finalize" : "activity.update", payload,
		});
		if (result.type !== "activity.acknowledge" || result.payload.activityId !== payload.activityId || result.payload.revision !== payload.revision ||
			result.payload.status !== (finalize ? "finalized" : "updated")) throw new ManagedAdapterError("Relay did not confirm activity projection", "invalid_response");
	}

	async controlResult(controlId: string, status: "ok" | "rejected", message: string, options?: string[], generation?: { model?: string; thinking?: string },
		selection?: { model: string } | { thinking: string }): Promise<void> {
		const result = await this.request({
			protocolVersion: MANAGED_SESSION_PROTOCOL_VERSION,
			messageId: messageId("control-result"), conversationId: this.options.binding.conversationId,
			role: this.options.role, type: "control.result",
			payload: { controlId, status, message: message.slice(0, 4_096), ...(options ? { options: options.slice(0, 20) } : {}),
				...(generation ? { generation } : {}), ...(selection ? { selection } : {}) },
		});
		if (result.type !== "self.result" || result.payload.operation !== "control.result" || result.payload.status !== "ok") {
			throw new ManagedAdapterError("Relay did not confirm control result", "invalid_response");
		}
	}

	async exportArtifact(artifact: WorkspaceArtifact): Promise<void> {
		if (this.options.role !== "ordinary_adapter") throw new ManagedAdapterError("Artifact export requires an ordinary managed conversation", "permission_denied");
		const chunks = artifactChunks(artifact.data);
		const payload = { uploadId: artifact.uploadId, blobId: artifact.blobId, sha256: artifact.sha256, filename: artifact.filename,
			mimeType: artifact.mimeType, mediaType: artifact.mediaType, byteLength: artifact.byteLength, chunkCount: chunks.length,
			...(artifact.width === undefined ? {} : { width: artifact.width }), ...(artifact.height === undefined ? {} : { height: artifact.height }) };
		const begin = await this.request({ protocolVersion: MANAGED_SESSION_PROTOCOL_VERSION, messageId: messageId("artifact-begin"),
			conversationId: this.options.binding.conversationId, role: "ordinary_adapter", type: "artifact.begin", payload }, LIFECYCLE_REQUEST_TIMEOUT_MS);
		if (begin.type !== "artifact.acknowledge" || begin.payload.uploadId !== artifact.uploadId || !["ready", "sent"].includes(String(begin.payload.status))) {
			throw new ManagedAdapterError("Relay did not accept artifact export", "invalid_response");
		}
		if (begin.payload.status === "sent") return;
		for (let index = 0; index < chunks.length; index += 1) {
			const chunk = chunks[index]!;
			const result = await this.request({ protocolVersion: MANAGED_SESSION_PROTOCOL_VERSION, messageId: messageId("artifact-chunk"),
				conversationId: this.options.binding.conversationId, role: "ordinary_adapter", type: "artifact.chunk", payload: { uploadId: artifact.uploadId,
					blobId: artifact.blobId, index, sha256: createHash("sha256").update(chunk).digest("hex"), data: chunk.toString("base64") } }, LIFECYCLE_REQUEST_TIMEOUT_MS);
			const expected = index + 1 === chunks.length ? "sent" : "ready";
			if (result.type !== "artifact.acknowledge" || result.payload.uploadId !== artifact.uploadId || result.payload.status !== expected) {
				throw new ManagedAdapterError("Relay did not confirm artifact transfer", "invalid_response");
			}
		}
	}

	async rejectMedia(deliveryId: string, blobId: string, reason: "unsupported_model" | "invalid_media"): Promise<void> {
		const result = await this.request({ protocolVersion: MANAGED_SESSION_PROTOCOL_VERSION, messageId: messageId("media-reject"),
			conversationId: this.options.binding.conversationId, role: this.options.role, type: "media.reject", payload: { deliveryId, blobId, reason } });
		if (result.type !== "media.result" || result.payload.deliveryId !== deliveryId || result.payload.blobId !== blobId || result.payload.status !== "rejected") {
			throw new ManagedAdapterError("Relay did not confirm media rejection", "invalid_response");
		}
	}

	async offerTranscript(entry: {
		entryId: string;
		piSessionId: string;
		piEntryKey: string;
		kind: "local_user" | "assistant_final";
		body: string;
	}): Promise<ManagedSessionEnvelope> {
		const result = await this.request({
			protocolVersion: MANAGED_SESSION_PROTOCOL_VERSION,
			messageId: messageId("transcript"), conversationId: this.options.binding.conversationId,
			role: this.options.role, type: "transcript.offer", payload: entry,
		});
		if (result.type !== "transcript.acknowledge" || result.payload.entryId !== entry.entryId || result.payload.status !== "projected") {
			throw new ManagedAdapterError("Relay did not confirm transcript projection", "invalid_response");
		}
		return result;
	}

	async offerCheckpoint(checkpoint: { checkpointId: string; originDeliveryId: string; checkpoint: Record<string, unknown> }): Promise<ManagedSessionEnvelope> {
		const result = await this.request({
			protocolVersion: MANAGED_SESSION_PROTOCOL_VERSION,
			messageId: messageId("checkpoint"), conversationId: this.options.binding.conversationId,
			role: this.options.role, type: "checkpoint.offer", payload: checkpoint,
		});
		if (result.type !== "checkpoint.acknowledge" || result.payload.checkpointId !== checkpoint.checkpointId || result.payload.status !== "projected") {
			throw new ManagedAdapterError("Relay did not confirm checkpoint projection", "invalid_response");
		}
		return result;
	}

	async offerAloopNotice(payload: { scopeSessionId: string; lifecycleId: string; kind: string; epic: number; issue?: number; body: string; timestamp: string }): Promise<void> {
		if (this.options.role !== "ordinary_adapter") return;
		const result = await this.request({
			protocolVersion: MANAGED_SESSION_PROTOCOL_VERSION,
			messageId: messageId("aloop"), conversationId: this.options.binding.conversationId,
			role: "ordinary_adapter", type: "aloop.notice", payload,
		});
		if (result.type !== "aloop.acknowledge" || result.payload.lifecycleId !== payload.lifecycleId || result.payload.status !== "projected") {
			throw new ManagedAdapterError("Relay did not confirm aloop lifecycle projection", "invalid_response");
		}
	}

	async selfStatus(): Promise<ManagedSessionEnvelope> {
		return this.request({
			protocolVersion: MANAGED_SESSION_PROTOCOL_VERSION,
			messageId: messageId("status"), conversationId: this.options.binding.conversationId,
			role: this.options.role, type: "self.status", payload: {},
		});
	}

	async selfDelete(): Promise<ManagedSessionEnvelope> {
		if (this.options.role !== "ordinary_adapter") throw new ManagedAdapterError("Coordinator bridge deletion is forbidden", "permission_denied");
		return this.request({
			protocolVersion: MANAGED_SESSION_PROTOCOL_VERSION,
			messageId: messageId("delete"), conversationId: this.options.binding.conversationId,
			role: "ordinary_adapter", type: "self.delete", payload: { confirmed: true },
		});
	}

	async close(reason: "shutdown" | "session_change" | "stop" | "bridge_delete" = "shutdown"): Promise<void> {
		this.#closing = true;
		const socket = this.#socket;
		if (!socket) return;
		if (this.#attachmentId && !socket.destroyed) {
			const envelope: ManagedSessionEnvelope = {
				protocolVersion: MANAGED_SESSION_PROTOCOL_VERSION,
				messageId: messageId("detach"), conversationId: this.options.binding.conversationId,
				role: this.options.role, type: "attachment.detach", payload: { attachmentId: this.#attachmentId, reason },
			};
			socket.write(encodeNdjsonEnvelope(envelope));
		}
		socket.end();
		await waitForClose(socket, 1_000);
	}

	protected request(envelope: ManagedSessionEnvelope, timeoutMs = REQUEST_TIMEOUT_MS): Promise<ManagedSessionEnvelope> {
		const socket = this.#socket;
		if (!socket || socket.destroyed) return Promise.reject(new ManagedAdapterError("Relay connection is unavailable"));
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.#pending.delete(envelope.messageId);
				reject(new ManagedAdapterError("Relay request timed out", "timeout"));
			}, timeoutMs);
			this.#pending.set(envelope.messageId, { resolve, reject, timer });
			try {
				socket.write(encodeNdjsonEnvelope(envelope));
			} catch (error) {
				clearTimeout(timer);
				this.#pending.delete(envelope.messageId);
				reject(error instanceof Error ? error : new ManagedAdapterError("Relay request failed"));
			}
		});
	}

	private consume(chunk: Buffer): void {
		this.#buffer = Buffer.concat([this.#buffer, chunk]);
		while (true) {
			const newline = this.#buffer.indexOf(0x0a);
			if (newline === -1) {
				if (this.#buffer.length > MAX_NDJSON_FRAME_BYTES) this.#socket?.destroy();
				return;
			}
			if (newline + 1 > MAX_NDJSON_FRAME_BYTES) {
				this.#socket?.destroy();
				return;
			}
			const frame = this.#buffer.subarray(0, newline + 1);
			this.#buffer = this.#buffer.subarray(newline + 1);
			let envelope: ManagedSessionEnvelope;
			try { envelope = parseNdjsonEnvelope(frame); } catch { this.#socket?.destroy(); return; }
			if (envelope.role !== "relay" || envelope.conversationId !== this.options.binding.conversationId) {
				this.#socket?.destroy();
				return;
			}
			if (envelope.inReplyTo) {
				const pending = this.#pending.get(envelope.inReplyTo);
				if (!pending) { this.#socket?.destroy(); return; }
				clearTimeout(pending.timer);
				this.#pending.delete(envelope.inReplyTo);
				if (envelope.type === "error") pending.reject(responseError(envelope));
				else pending.resolve(envelope);
				continue;
			}
			this.#inboundWork = this.#inboundWork
				.then(() => envelope.type === "media.begin" || envelope.type === "media.chunk" ? this.consumeMedia(envelope) : this.options.onEnvelope(envelope))
				.then(() => undefined)
				.catch(() => { this.#socket?.destroy(); });
		}
	}

	private async consumeMedia(envelope: ManagedSessionEnvelope): Promise<void> {
		if (!this.options.onMedia) throw new ManagedAdapterError("Media delivery is unavailable", "invalid_message");
		if (envelope.type === "media.begin") {
			const payload = envelope.payload as Omit<ReceivedImage, "data"> & { chunkCount: number };
			if (this.#media.has(payload.deliveryId) || [...this.#media.values()].some((item) => item.descriptor.blobId === payload.blobId)) throw new ManagedAdapterError("Conflicting duplicate media transfer", "invalid_delivery");
			this.#media.set(payload.deliveryId, { descriptor: { ...payload }, chunks: [] });
			return;
		}
		const payload = envelope.payload as { deliveryId: string; blobId: string; index: number; data: string };
		const transfer = this.#media.get(payload.deliveryId);
		if (!transfer || transfer.descriptor.blobId !== payload.blobId || payload.index !== transfer.chunks.length || payload.index >= transfer.descriptor.chunkCount) {
			throw new ManagedAdapterError("Media chunks were missing, duplicated, or out of order", "invalid_delivery");
		}
		transfer.chunks.push(Buffer.from(payload.data, "base64"));
		if (transfer.chunks.length !== transfer.descriptor.chunkCount) return;
		this.#media.delete(payload.deliveryId);
		const data = Buffer.concat(transfer.chunks);
		if (data.length !== transfer.descriptor.byteLength || createHash("sha256").update(data).digest("hex") !== transfer.descriptor.sha256) {
			await this.rejectMedia(payload.deliveryId, payload.blobId, "invalid_media");
			return;
		}
		await this.options.onMedia({ deliveryId: transfer.descriptor.deliveryId, matrixEventId: transfer.descriptor.matrixEventId,
			...(transfer.descriptor.senderUserId ? { senderUserId: transfer.descriptor.senderUserId } : {}),
			blobId: transfer.descriptor.blobId, sha256: transfer.descriptor.sha256, mimeType: transfer.descriptor.mimeType,
			byteLength: transfer.descriptor.byteLength, width: transfer.descriptor.width, height: transfer.descriptor.height,
			caption: transfer.descriptor.caption, data });
	}

	private handleClose(): void {
		this.#socket = undefined;
		this.#attachmentId = undefined;
		this.#buffer = Buffer.alloc(0);
		this.#media.clear();
		for (const pending of this.#pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(new ManagedAdapterError("Relay connection closed"));
		}
		this.#pending.clear();
		if (!this.#closing) this.options.onDisconnect?.();
	}
}

export class CoordinatorAdapterClient extends BoundAdapterClient {
	async lifecycleRequest(request: Record<string, unknown>): Promise<ManagedSessionEnvelope> {
		const result = await this.request({
			protocolVersion: MANAGED_SESSION_PROTOCOL_VERSION,
			messageId: messageId("lifecycle"), conversationId: this.options.binding.conversationId,
			role: "coordinator_adapter", type: "lifecycle.request", payload: { request },
		}, LIFECYCLE_REQUEST_TIMEOUT_MS);
		if (result.type !== "lifecycle.result") throw new ManagedAdapterError("Relay did not return a lifecycle result", "invalid_response");
		return result;
	}
}

export async function requestSelfBind(options: {
	socketPath: string;
	role: "ordinary_adapter";
	creationKey: string;
	concept: string;
	sessionId: string;
	attachmentNonce: string;
	bindingBoundaryEntryId: string;
	placement: WorkspaceIdentity;
}): Promise<string> {
	const socket = await openSocket(options.socketPath);
	try {
		const request: ManagedSessionEnvelope = {
			protocolVersion: MANAGED_SESSION_PROTOCOL_VERSION,
			messageId: messageId("bind"), role: "ordinary_adapter", type: "self.bind",
			payload: {
				creationKey: options.creationKey, concept: options.concept, sessionId: options.sessionId,
				attachmentNonce: options.attachmentNonce, bindingBoundaryEntryId: options.bindingBoundaryEntryId,
				placement: options.placement,
			},
		};
		socket.write(encodeNdjsonEnvelope(request));
		const response = await readSingleEnvelope(socket, REQUEST_TIMEOUT_MS);
		if (response.role !== "relay" || response.inReplyTo !== request.messageId || response.type !== "self.result" ||
			response.payload.operation !== "self.bind" || response.payload.status !== "ok" ||
			typeof response.payload.boundConversationId !== "string") throw responseError(response);
		return response.payload.boundConversationId;
	} finally {
		socket.destroy();
	}
}

function responseError(envelope: ManagedSessionEnvelope): ManagedAdapterError {
	if (envelope.type === "error") return new ManagedAdapterError(String(envelope.payload.message), String(envelope.payload.code));
	return new ManagedAdapterError(`Unexpected relay response ${envelope.type}`, "invalid_response");
}

function openSocket(path: string): Promise<Socket> {
	return new Promise((resolve, reject) => {
		const socket = connect(path, () => { socket.off("error", reject); resolve(socket); });
		socket.once("error", reject);
	});
}

function readSingleEnvelope(socket: Socket, timeoutMs: number): Promise<ManagedSessionEnvelope> {
	return new Promise((resolve, reject) => {
		let buffer = Buffer.alloc(0);
		const timer = setTimeout(() => finish(new ManagedAdapterError("Relay request timed out", "timeout")), timeoutMs);
		const finish = (value: ManagedSessionEnvelope | Error) => {
			clearTimeout(timer); socket.off("data", onData); socket.off("close", onClose);
			value instanceof Error ? reject(value) : resolve(value);
		};
		const onClose = () => finish(new ManagedAdapterError("Relay connection closed"));
		const onData = (chunk: Buffer) => {
			buffer = Buffer.concat([buffer, chunk]);
			const newline = buffer.indexOf(0x0a);
			if (newline === -1) { if (buffer.length > MAX_NDJSON_FRAME_BYTES) finish(new ManagedAdapterError("Relay frame exceeded size limit")); return; }
			try { finish(parseNdjsonEnvelope(buffer.subarray(0, newline + 1))); } catch { finish(new ManagedAdapterError("Relay returned an invalid frame")); }
		};
		socket.on("data", onData); socket.once("close", onClose);
	});
}

function waitForClose(socket: Socket, timeoutMs: number): Promise<void> {
	if (socket.destroyed) return Promise.resolve();
	return new Promise((resolve) => {
		const timer = setTimeout(() => { socket.destroy(); resolve(); }, timeoutMs);
		socket.once("close", () => { clearTimeout(timer); resolve(); });
	});
}
