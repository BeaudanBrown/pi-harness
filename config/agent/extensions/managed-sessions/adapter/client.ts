import { randomUUID } from "node:crypto";
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

export interface BoundAdapterOptions {
	socketPath: string;
	role: AdapterRole;
	attachmentNonce: string;
	binding: SessionBinding;
	onEnvelope: (envelope: ManagedSessionEnvelope) => Promise<void> | void;
	onDisconnect?: () => void;
}

export class BoundAdapterClient {
	#socket?: Socket;
	#buffer = Buffer.alloc(0);
	#pending = new Map<string, PendingRequest>();
	#attachmentId?: string;
	#closing = false;
	#inboundWork: Promise<void> = Promise.resolve();

	constructor(protected readonly options: BoundAdapterOptions) {}

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
				.then(() => this.options.onEnvelope(envelope))
				.then(() => undefined)
				.catch(() => { this.#socket?.destroy(); });
		}
	}

	private handleClose(): void {
		this.#socket = undefined;
		this.#attachmentId = undefined;
		this.#buffer = Buffer.alloc(0);
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
