import { createHash } from "node:crypto";
import { MANAGED_SESSION_PROTOCOL_VERSION, type ManagedSessionEnvelope } from "../contracts.js";
import { deriveInboundBlobId, MAX_MEDIA_CHUNK_BYTES } from "../v2-contracts.js";
import type { ManagedSessionIpcServer } from "./ipc-server.js";
import type { ManagedMatrixClient } from "./matrix-client.js";
import { BlobSpool, type SpoolBlob } from "./blob-spool.js";

export const CAPTIONLESS_IMAGE_PROMPT = "Please analyze the attached image.";
const MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
type ImageMimeType = typeof MIME_TYPES[number];

export interface MatrixImageEvent {
	kind: "image";
	eventId: string;
	senderUserId: string;
	mxcUrl: string;
	declaredMimeType: ImageMimeType;
	declaredSize?: number;
	declaredWidth?: number;
	declaredHeight?: number;
	caption?: string;
}
export interface PendingImage {
	blobId: string; sha256: string; mimeType: ImageMimeType; byteLength: number; width: number; height: number; chunkCount: number;
}
export interface MediaPendingInput {
	deliveryId: string; matrixEventId: string; senderUserId?: string; kind: string; body?: string; media?: PendingImage;
}

function imageMime(bytes: Buffer): ImageMimeType {
	if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
	if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
	if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
	throw new Error("Downloaded media is not a supported JPEG, PNG or WebP image");
}

export class ManagedImageTransport {
	constructor(readonly spool: BlobSpool, private readonly matrix: ManagedMatrixClient) {}

	async initialize(liveBlobIds: ReadonlySet<string>): Promise<void> { await this.spool.initialize(liveBlobIds); }

	async accept(conversationId: string, event: MatrixImageEvent, signal?: AbortSignal): Promise<{ image: PendingImage; prompt: string }> {
		if (!MIME_TYPES.includes(event.declaredMimeType)) throw new Error("Image MIME type is unsupported");
		const { bytes } = await this.matrix.downloadMedia(event.mxcUrl, signal);
		if (!bytes.length) throw new Error("Matrix returned an empty image");
		const mimeType = imageMime(bytes);
		const sha256 = createHash("sha256").update(bytes).digest("hex");
		const blobId = deriveInboundBlobId(conversationId, sha256);
		const blob = await this.spool.commitInbound({ blobId, sha256, mimeType, byteLength: bytes.length,
			// Neutral compatibility fields: Pi receives original bytes, not these dimensions.
			width: 1, height: 1 }, bytes);
		return { image: this.pending(blob), prompt: event.caption?.trim() || CAPTIONLESS_IMAGE_PROMPT };
	}

	async deliver(server: ManagedSessionIpcServer, conversationId: string, input: MediaPendingInput): Promise<boolean> {
		if (!input.media || !input.body) return false;
		const bytes = await this.spool.read(input.media);
		const begin: ManagedSessionEnvelope = { protocolVersion: MANAGED_SESSION_PROTOCOL_VERSION, messageId: `relay-media-${input.deliveryId}-begin`, conversationId,
			role: "relay", type: "media.begin", payload: { deliveryId: input.deliveryId, matrixEventId: input.matrixEventId,
				...(input.senderUserId ? { senderUserId: input.senderUserId } : {}), ...input.media, caption: input.body } };
		if (!server.sendToConversation(begin)) return false;
		for (let index = 0; index < input.media.chunkCount; index += 1) {
			const chunk = bytes.subarray(index * MAX_MEDIA_CHUNK_BYTES, (index + 1) * MAX_MEDIA_CHUNK_BYTES);
			if (!server.sendToConversation({ protocolVersion: MANAGED_SESSION_PROTOCOL_VERSION, messageId: `relay-media-${input.deliveryId}-${index}`, conversationId,
				role: "relay", type: "media.chunk", payload: { deliveryId: input.deliveryId, blobId: input.media.blobId, index,
					sha256: createHash("sha256").update(chunk).digest("hex"), data: chunk.toString("base64") } })) return false;
		}
		return true;
	}

	async consume(blobId: string, liveBlobIds: ReadonlySet<string>): Promise<void> { await this.spool.remove(blobId, liveBlobIds); }

	private pending(blob: SpoolBlob): PendingImage {
		if (!MIME_TYPES.includes(blob.mimeType as ImageMimeType)) throw new Error("Inbound image spool MIME is invalid");
		return { blobId: blob.blobId, sha256: blob.sha256, mimeType: blob.mimeType as ImageMimeType, byteLength: blob.byteLength,
			width: blob.width, height: blob.height, chunkCount: Math.ceil(blob.byteLength / MAX_MEDIA_CHUNK_BYTES) };
	}
}
