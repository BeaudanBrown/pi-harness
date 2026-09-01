import { randomUUID } from "node:crypto";
import { chmod, lstat, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { dirname, resolve } from "node:path";
import {
	MANAGED_SESSION_PROTOCOL_VERSION,
	MAX_NDJSON_FRAME_BYTES,
	type ManagedSessionEnvelope,
	encodeNdjsonEnvelope,
	parseNdjsonEnvelope,
} from "../contracts.js";
import { ensurePrivateDirectory } from "./atomic-json.js";
import { type AcceptedAttachment, RelayRegistry, RelayRegistryError } from "./registry.js";

export type PeerUidResolver = (socket: Socket) => number | undefined | Promise<number | undefined>;
export type EnvelopeHandler = (envelope: ManagedSessionEnvelope, attachment: AcceptedAttachment) => Promise<ManagedSessionEnvelope | undefined>;
export type UnboundEnvelopeHandler = (envelope: ManagedSessionEnvelope) => Promise<ManagedSessionEnvelope | undefined>;
export type AttachmentHandler = (attachment: AcceptedAttachment) => Promise<void> | void;

interface ConnectionState {
	id: string;
	buffer: Buffer;
	attachment?: AcceptedAttachment;
	messageIds: Set<string>;
	closed: boolean;
	work: Promise<void>;
}

function relayError(conversationId: string, inReplyTo: string, error: unknown): ManagedSessionEnvelope {
	const registryError = error instanceof RelayRegistryError ? error : undefined;
	return {
		protocolVersion: MANAGED_SESSION_PROTOCOL_VERSION,
		messageId: `relay-${randomUUID()}`,
		conversationId,
		role: "relay",
		type: "error",
		inReplyTo,
		payload: {
			code: registryError?.code ?? "invalid_state",
			message: registryError?.message ?? "Relay operation failed",
			retryable: false,
		},
	};
}

export class ManagedSessionIpcServer {
	private server?: Server;
	private readonly sockets = new Set<Socket>();
	private readonly attachedSockets = new Map<string, Socket>();
	private preserveAttachmentsOnClose = false;
	private readonly runtimeDirectory: string;
	readonly socketPath: string;

	constructor(
		private readonly registry: RelayRegistry,
		options: {
			runtimeDirectory: string;
			socketPath?: string;
			expectedUid?: number;
			peerUid?: PeerUidResolver;
			onEnvelope?: EnvelopeHandler;
			onUnboundEnvelope?: UnboundEnvelopeHandler;
			onAttachment?: AttachmentHandler;
		},
	) {
		this.runtimeDirectory = resolve(options.runtimeDirectory);
		this.socketPath = resolve(options.socketPath ?? `${this.runtimeDirectory}/relay.sock`);
		if (dirname(this.socketPath) !== this.runtimeDirectory) throw new Error("Relay socket must be directly inside the private runtime directory");
		this.expectedUid = options.expectedUid;
		this.peerUid = options.peerUid;
		this.onEnvelope = options.onEnvelope;
		this.onUnboundEnvelope = options.onUnboundEnvelope;
		this.onAttachment = options.onAttachment;
	}

	private readonly expectedUid?: number;
	private readonly peerUid?: PeerUidResolver;
	private readonly onEnvelope?: EnvelopeHandler;
	private readonly onUnboundEnvelope?: UnboundEnvelopeHandler;
	private readonly onAttachment?: AttachmentHandler;

	sendToConversation(envelope: ManagedSessionEnvelope): boolean {
		if (envelope.role !== "relay" || !envelope.conversationId || envelope.inReplyTo) throw new Error("Server push must be an uncorrelated relay envelope");
		const socket = this.attachedSockets.get(envelope.conversationId);
		if (!socket || socket.destroyed) return false;
		this.send(socket, envelope);
		return true;
	}

	async start(): Promise<void> {
		if (this.server) throw new Error("Managed-session IPC server is already running");
		await ensurePrivateDirectory(this.runtimeDirectory);
		try {
			const existing = await lstat(this.socketPath);
			if (!existing.isSocket() || existing.isSymbolicLink()) throw new Error("Refusing to replace a non-socket relay path");
			if (this.expectedUid !== undefined && existing.uid !== this.expectedUid) throw new Error("Refusing to replace a relay socket owned by another user");
			await rm(this.socketPath);
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
		}
		this.server = createServer((socket) => void this.accept(socket));
		await new Promise<void>((resolveListen, reject) => {
			this.server!.once("error", reject);
			this.server!.listen(this.socketPath, () => {
				this.server!.off("error", reject);
				resolveListen();
			});
		});
		await chmod(this.socketPath, 0o600);
	}

	async close(options: { preserveAttachments?: boolean } = {}): Promise<void> {
		this.preserveAttachmentsOnClose = options.preserveAttachments ?? false;
		for (const socket of this.sockets) socket.destroy();
		if (this.server) {
			await new Promise<void>((resolveClose) => this.server!.close(() => resolveClose()));
			this.server = undefined;
		}
		await rm(this.socketPath, { force: true });
	}

	private async accept(socket: Socket): Promise<void> {
		socket.pause();
		this.sockets.add(socket);
		if (this.peerUid) {
			try {
				const uid = await this.peerUid(socket);
				if (uid !== undefined && this.expectedUid !== undefined && uid !== this.expectedUid) {
					socket.destroy();
					return;
				}
			} catch {
				socket.destroy();
				return;
			}
		}
		const state: ConnectionState = {
			id: randomUUID(), buffer: Buffer.alloc(0), messageIds: new Set(), closed: false, work: Promise.resolve(),
		};
		socket.on("data", (chunk) => {
			socket.pause();
			state.work = state.work
				.then(() => this.consume(socket, state, chunk))
				.catch(() => { socket.destroy(); })
				.finally(() => { socket.resume(); });
		});
		socket.on("error", () => undefined);
		socket.on("close", () => {
			state.closed = true;
			this.sockets.delete(socket);
			if (state.attachment && this.attachedSockets.get(state.attachment.conversationId) === socket) {
				this.attachedSockets.delete(state.attachment.conversationId);
			}
			if (state.attachment && !this.preserveAttachmentsOnClose) void this.registry.detach(state.id, state.attachment).catch(() => undefined);
		});
		socket.resume();
	}

	private async consume(socket: Socket, state: ConnectionState, chunk: Buffer): Promise<void> {
		if (state.closed) return;
		state.buffer = Buffer.concat([state.buffer, chunk]);
		while (true) {
			const newline = state.buffer.indexOf(0x0a);
			if (newline === -1) {
				if (state.buffer.length > MAX_NDJSON_FRAME_BYTES) socket.destroy();
				return;
			}
			if (newline + 1 > MAX_NDJSON_FRAME_BYTES) {
				socket.destroy();
				return;
			}
			const frame = state.buffer.subarray(0, newline + 1);
			state.buffer = state.buffer.subarray(newline + 1);
			let envelope: ManagedSessionEnvelope;
			try {
				envelope = parseNdjsonEnvelope(frame);
			} catch {
				socket.destroy();
				return;
			}
			if (state.messageIds.size >= 4_096 || state.messageIds.has(envelope.messageId) || envelope.role === "relay") {
				socket.destroy();
				return;
			}
			state.messageIds.add(envelope.messageId);
			try {
				if (!state.attachment && envelope.type === "self.bind") {
					const response = await this.onUnboundEnvelope?.(envelope);
					if (!response || response.role !== "relay" || response.inReplyTo !== envelope.messageId || response.type !== "self.result") {
						throw new RelayRegistryError("invalid_state", "Initial self binding is unavailable");
					}
					this.send(socket, response);
					continue;
				}
				if (!state.attachment) {
					state.attachment = await this.registry.attach(envelope, state.id);
					this.attachedSockets.set(state.attachment.conversationId, socket);
					this.send(socket, {
						protocolVersion: MANAGED_SESSION_PROTOCOL_VERSION,
						messageId: `relay-${randomUUID()}`,
						conversationId: state.attachment.conversationId,
						role: "relay",
						type: "attachment.accepted",
						inReplyTo: envelope.messageId,
						payload: { attachmentId: state.attachment.attachmentId, state: "active" },
					});
					await this.onAttachment?.(state.attachment);
					continue;
				}
				this.registry.assertAuthorized(envelope, state.id, state.attachment);
				if (envelope.type === "attachment.detach") {
					await this.registry.detach(state.id, state.attachment, (envelope.payload as { attachmentId: string }).attachmentId);
					socket.end();
					return;
				}
				const response = await this.onEnvelope?.(envelope, state.attachment);
				if (!response && ["input.acknowledge", "session.change"].includes(envelope.type)) continue;
				if (!response) throw new RelayRegistryError("invalid_state", "Operation is not available in the relay foundation");
				if (response.role !== "relay" || response.conversationId !== state.attachment.conversationId || response.inReplyTo !== envelope.messageId) {
					throw new Error("Relay handler returned an uncorrelated response");
				}
				this.send(socket, response);
			} catch (error) {
				const conversationId = envelope.conversationId;
				if (conversationId) this.send(socket, relayError(conversationId, envelope.messageId, error));
				socket.destroySoon();
				return;
			}
		}
	}

	private send(socket: Socket, envelope: ManagedSessionEnvelope): void {
		socket.write(encodeNdjsonEnvelope(envelope));
	}
}
