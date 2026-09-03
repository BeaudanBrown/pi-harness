import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { MANAGED_SESSION_PROTOCOL_VERSION, type ManagedSessionEnvelope } from "../contracts.js";
import { deriveBlobId, MAX_BLOB_BYTES, MAX_MEDIA_CHUNK_BYTES } from "../v2-contracts.js";
import type { ManagedSessionIpcServer } from "./ipc-server.js";
import type { ManagedMatrixClient } from "./matrix-client.js";
import { BlobSpool, type SpoolBlob } from "./blob-spool.js";

const execFileAsync = promisify(execFile);
export const MAX_IMAGE_DIMENSION = 16_384;
export const MAX_IMAGE_PIXELS = 40_000_000;
export const CAPTIONLESS_IMAGE_PROMPT = "Please analyze the attached image.";
const MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
type ImageMimeType = typeof MIME_TYPES[number];
export type ImageNormalizer = (bytes: Buffer, mimeType: ImageMimeType) => Promise<Buffer>;

export interface MatrixImageEvent {
	kind: "image";
	eventId: string;
	mxcUrl: string;
	declaredMimeType: ImageMimeType;
	declaredSize: number;
	declaredWidth: number;
	declaredHeight: number;
	caption?: string;
}
export interface PendingImage {
	blobId: string; sha256: string; mimeType: ImageMimeType; byteLength: number; width: number; height: number; chunkCount: number;
}
export interface MediaPendingInput {
	deliveryId: string; matrixEventId: string; kind: string; body?: string; media?: PendingImage;
}

function dimensions(bytes: Buffer, mimeType: ImageMimeType): { width: number; height: number } {
	let width = 0; let height = 0;
	if (mimeType === "image/png") {
		if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || bytes.toString("ascii", 12, 16) !== "IHDR") throw new Error("PNG signature is malformed");
		width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20);
	} else if (mimeType === "image/jpeg") {
		if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error("JPEG signature is malformed");
		for (let offset = 2; offset + 3 < bytes.length;) {
			if (bytes[offset] !== 0xff) { offset += 1; continue; }
			while (bytes[offset] === 0xff) offset += 1;
			const marker = bytes[offset++]!;
			if (marker === 0xd8 || marker === 0xd9 || marker >= 0xd0 && marker <= 0xd7) continue;
			if (offset + 1 >= bytes.length) break;
			const length = bytes.readUInt16BE(offset);
			if (length < 2 || offset + length > bytes.length) break;
			if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 7) {
				height = bytes.readUInt16BE(offset + 3); width = bytes.readUInt16BE(offset + 5); break;
			}
			offset += length;
		}
		if (!width || !height) throw new Error("JPEG dimensions are unavailable");
	} else {
		if (bytes.length < 30 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WEBP") throw new Error("WebP signature is malformed");
		const kind = bytes.toString("ascii", 12, 16);
		if (kind === "VP8X") { width = 1 + bytes.readUIntLE(24, 3); height = 1 + bytes.readUIntLE(27, 3); }
		else if (kind === "VP8 " && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
			width = bytes.readUInt16LE(26) & 0x3fff; height = bytes.readUInt16LE(28) & 0x3fff;
		} else if (kind === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
			const packed = bytes.readUInt32LE(21); width = 1 + (packed & 0x3fff); height = 1 + ((packed >>> 14) & 0x3fff);
		} else throw new Error("WebP dimensions are unavailable");
	}
	if (width < 1 || height < 1 || width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION || width * height > MAX_IMAGE_PIXELS) throw new Error("Image dimensions exceed the safety bounds");
	return { width, height };
}

function normalizedMime(value: string | undefined): string | undefined { return value?.split(";", 1)[0]?.trim().toLowerCase(); }

export class ManagedImageTransport {
	constructor(readonly spool: BlobSpool, private readonly matrix: ManagedMatrixClient, private readonly normalizer?: string | ImageNormalizer) {}

	async initialize(liveBlobIds: ReadonlySet<string>): Promise<void> { await this.spool.initialize(liveBlobIds); }

	async accept(conversationId: string, event: MatrixImageEvent, signal?: AbortSignal): Promise<{ image: PendingImage; prompt: string }> {
		if (!MIME_TYPES.includes(event.declaredMimeType) || event.declaredSize < 1 || event.declaredSize > MAX_BLOB_BYTES) throw new Error("Image declaration is unsupported or oversized");
		const downloaded = await this.matrix.downloadMedia(event.mxcUrl, event.declaredSize, signal);
		if (normalizedMime(downloaded.mimeType) !== event.declaredMimeType || downloaded.bytes.length !== event.declaredSize) throw new Error("Image download disagrees with its declaration");
		const declaredDimensions = dimensions(downloaded.bytes, event.declaredMimeType);
		if (declaredDimensions.width !== event.declaredWidth || declaredDimensions.height !== event.declaredHeight) throw new Error("Image dimensions disagree with their declaration");
		const normalized = await this.normalize(downloaded.bytes, event.declaredMimeType);
		const normalizedDimensions = dimensions(normalized, event.declaredMimeType);
		const sha256 = createHash("sha256").update(normalized).digest("hex");
		const blobId = deriveBlobId(conversationId, sha256);
		const blob = await this.spool.commit({ blobId, sha256, mimeType: event.declaredMimeType, byteLength: normalized.length,
			width: normalizedDimensions.width, height: normalizedDimensions.height }, normalized);
		return { image: this.pending(blob), prompt: event.caption?.trim() || CAPTIONLESS_IMAGE_PROMPT };
	}

	async deliver(server: ManagedSessionIpcServer, conversationId: string, input: MediaPendingInput): Promise<boolean> {
		if (!input.media || !input.body) return false;
		const bytes = await this.spool.read(input.media);
		const begin: ManagedSessionEnvelope = { protocolVersion: MANAGED_SESSION_PROTOCOL_VERSION, messageId: `relay-media-${input.deliveryId}-begin`, conversationId,
			role: "relay", type: "media.begin", payload: { deliveryId: input.deliveryId, matrixEventId: input.matrixEventId, ...input.media, caption: input.body } };
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

	private async normalize(bytes: Buffer, mimeType: ImageMimeType): Promise<Buffer> {
		if (!this.normalizer) throw new Error("Image normalization is unavailable");
		if (typeof this.normalizer === "function") {
			const normalized = await this.normalizer(bytes, mimeType);
			if (normalized.length < 1 || normalized.length > MAX_BLOB_BYTES) throw new Error("Normalized image exceeds the blob size bound");
			return normalized;
		}
		const directory = await mkdtemp(join(this.spool.root, ".normalize-"));
		const extension = mimeType === "image/jpeg" ? "jpg" : mimeType.slice("image/".length);
		const input = join(directory, `input.${extension}`); const output = join(directory, `normalized.${extension}`);
		try {
			await writeFile(input, bytes, { mode: 0o600 });
			await execFileAsync(this.normalizer, [`${input}[0]`, "-auto-orient", "-strip", output], { timeout: 30_000, maxBuffer: 64 * 1024,
				env: { MAGICK_MEMORY_LIMIT: "256MiB", MAGICK_MAP_LIMIT: "256MiB", MAGICK_DISK_LIMIT: "512MiB", MAGICK_AREA_LIMIT: String(MAX_IMAGE_PIXELS), MAGICK_WIDTH_LIMIT: String(MAX_IMAGE_DIMENSION), MAGICK_HEIGHT_LIMIT: String(MAX_IMAGE_DIMENSION) } });
			const normalized = await readFile(output);
			if (normalized.length < 1 || normalized.length > MAX_BLOB_BYTES) throw new Error("Normalized image exceeds the blob size bound");
			return normalized;
		} catch { throw new Error("Image decoding or normalization failed"); }
		finally { await rm(directory, { recursive: true, force: true }); }
	}
}
