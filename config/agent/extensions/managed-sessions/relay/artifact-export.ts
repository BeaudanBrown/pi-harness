import { createHash } from "node:crypto";
import { MAX_MEDIA_CHUNK_BYTES } from "../v2-contracts.js";
import { deriveMatrixTransactionId } from "../contracts.js";
import { BlobSpool } from "./blob-spool.js";
import { ManagedMatrixClient } from "./matrix-client.js";
import { RelayRegistry, RelayRegistryError } from "./registry.js";

export interface ArtifactDescriptor {
	uploadId: string; blobId: string; sha256: string; filename: string; mimeType: string; mediaType: "image" | "audio" | "file";
	byteLength: number; chunkCount: number; width?: number; height?: number;
}
interface Transfer { conversationId: string; descriptor: ArtifactDescriptor; chunks: Buffer[]; timer?: NodeJS.Timeout }
const MAX_ACTIVE_TRANSFERS = 8;
const MAX_ACTIVE_TRANSFERS_PER_CONVERSATION = 2;
const MAX_RESERVED_TRANSFER_BYTES = 64 * 1024 * 1024;
const TRANSFER_EXPIRY_MS = 5 * 60 * 1_000;
type ArtifactRecord = ReturnType<RelayRegistry["artifactExports"]>[number]["artifact"];

export class ManagedArtifactExporter {
	private readonly transfers = new Map<string, Transfer>();
	private readonly projections = new Map<string, Promise<void>>();
	constructor(private readonly spool: BlobSpool, private readonly registry: RelayRegistry, private readonly matrix: ManagedMatrixClient) {}

	async reconcile(): Promise<void> {
		for (const { conversationId, artifact } of this.registry.artifactExports()) if (artifact.state !== "sent") await this.project(conversationId, artifact);
	}

	async begin(conversationId: string, descriptor: ArtifactDescriptor): Promise<"ready" | "sent"> {
		const manifest = this.registry.manifestByConversationId(conversationId);
		if (!manifest || manifest.kind !== "project") throw new RelayRegistryError("permission_denied", "Artifact export requires a managed project conversation");
		const existing = this.registry.artifactExports(conversationId).find((item) => item.artifact.uploadId === descriptor.uploadId)?.artifact;
		if (existing) {
			this.assertSame(existing, descriptor);
			if (existing.state !== "sent") await this.project(conversationId, existing);
			return "sent";
		}
		const active = this.transfers.get(descriptor.uploadId);
		if (active) { if (active.conversationId !== conversationId) throw new RelayRegistryError("invalid_state", "Artifact upload identity is already active"); this.assertSame(active.descriptor, descriptor); active.chunks = []; this.refresh(active); return "ready"; }
		const values = [...this.transfers.values()];
		if (values.length >= MAX_ACTIVE_TRANSFERS || values.filter((item) => item.conversationId === conversationId).length >= MAX_ACTIVE_TRANSFERS_PER_CONVERSATION ||
			values.reduce((sum, item) => sum + item.descriptor.byteLength, 0) + descriptor.byteLength > MAX_RESERVED_TRANSFER_BYTES) {
			throw new RelayRegistryError("capacity_reached", "Artifact transfer capacity was reached");
		}
		const transfer: Transfer = { conversationId, descriptor: structuredClone(descriptor), chunks: [] };
		transfer.timer = setTimeout(() => this.expire(descriptor.uploadId, transfer), TRANSFER_EXPIRY_MS); transfer.timer.unref();
		this.transfers.set(descriptor.uploadId, transfer);
		return "ready";
	}

	async chunk(conversationId: string, payload: { uploadId: string; blobId: string; index: number; sha256: string; data: string }): Promise<"ready" | "sent"> {
		const transfer = this.transfers.get(payload.uploadId);
		if (!transfer || transfer.conversationId !== conversationId || transfer.descriptor.blobId !== payload.blobId || payload.index !== transfer.chunks.length) {
			throw new RelayRegistryError("invalid_state", "Artifact chunks were missing, duplicated, or out of order");
		}
		const chunk = Buffer.from(payload.data, "base64");
		if (createHash("sha256").update(chunk).digest("hex") !== payload.sha256) throw new RelayRegistryError("invalid_state", "Artifact chunk digest is invalid");
		transfer.chunks.push(chunk); this.refresh(transfer);
		if (transfer.chunks.length < transfer.descriptor.chunkCount) return "ready";
		this.transfers.delete(payload.uploadId); if (transfer.timer) clearTimeout(transfer.timer);
		const bytes = Buffer.concat(transfer.chunks);
		if (bytes.length !== transfer.descriptor.byteLength || createHash("sha256").update(bytes).digest("hex") !== transfer.descriptor.sha256) throw new RelayRegistryError("invalid_state", "Artifact transfer failed final size or digest validation");
		const d = transfer.descriptor;
		await this.spool.commit({ blobId: d.blobId, sha256: d.sha256, mimeType: d.mimeType, byteLength: d.byteLength, width: d.width ?? 1, height: d.height ?? 1 }, bytes);
		const record: ArtifactRecord = { uploadId: d.uploadId, blobId: d.blobId, sha256: d.sha256, filename: d.filename, mimeType: d.mimeType,
			mediaType: d.mediaType, byteLength: d.byteLength, ...(d.width === undefined ? {} : { width: d.width }), ...(d.height === undefined ? {} : { height: d.height }),
			transactionId: deriveMatrixTransactionId(conversationId, d.uploadId, 0), state: "spooled", createdAt: new Date().toISOString() };
		try { await this.registry.recordArtifactExport(conversationId, record); }
		catch (error) { await this.spool.remove(d.blobId, this.registry.liveMediaBlobIds()).catch(() => undefined); throw error; }
		await this.project(conversationId, record);
		return "sent";
	}

	private async project(conversationId: string, initial: ArtifactRecord): Promise<void> {
		const current = this.projections.get(initial.uploadId);
		if (current) return current;
		const work = this.projectOnce(conversationId, initial).finally(() => this.projections.delete(initial.uploadId));
		this.projections.set(initial.uploadId, work); return work;
	}

	private async projectOnce(conversationId: string, initial: ArtifactRecord): Promise<void> {
		let artifact = this.registry.artifactExports(conversationId).find((item) => item.artifact.uploadId === initial.uploadId)?.artifact ?? initial;
		const manifest = this.registry.manifestByConversationId(conversationId);
		if (!manifest || manifest.kind !== "project") throw new RelayRegistryError("not_found", "Artifact conversation is unavailable");
		if (artifact.state === "spooled") {
			const reservation = await this.matrix.createMedia(); artifact = { ...artifact, state: "created", mxcUrl: reservation.contentUri, reservationExpiresAt: reservation.unusedExpiresAt };
			await this.registry.recordArtifactExport(conversationId, artifact);
		}
		if (artifact.state === "created" && Date.parse(artifact.reservationExpiresAt!) <= Date.now()) {
			const reservation = await this.matrix.createMedia(); artifact = { ...artifact, mxcUrl: reservation.contentUri, reservationExpiresAt: reservation.unusedExpiresAt };
			await this.registry.recordArtifactExport(conversationId, artifact);
		}
		if (artifact.state === "created") {
			const bytes = await this.spool.read({ blobId: artifact.blobId, sha256: artifact.sha256, mimeType: artifact.mimeType,
				byteLength: artifact.byteLength, width: artifact.width ?? 1, height: artifact.height ?? 1 });
			await this.matrix.uploadMedia(artifact.mxcUrl!, artifact.filename, artifact.mimeType, bytes);
			artifact = { ...artifact, state: "uploaded" }; await this.registry.recordArtifactExport(conversationId, artifact);
		}
		if (artifact.state === "uploaded") {
			const eventId = await this.matrix.sendMedia(manifest.roomId, artifact.transactionId, { contentUri: artifact.mxcUrl!, filename: artifact.filename,
				mimeType: artifact.mimeType, mediaType: artifact.mediaType, byteLength: artifact.byteLength,
				...(artifact.width === undefined ? {} : { width: artifact.width }), ...(artifact.height === undefined ? {} : { height: artifact.height }) });
			artifact = { ...artifact, state: "sent", eventId }; await this.registry.recordArtifactExport(conversationId, artifact);
			await this.spool.remove(artifact.blobId, this.registry.liveMediaBlobIds());
		}
	}

	private refresh(transfer: Transfer): void {
		if (transfer.timer) clearTimeout(transfer.timer); transfer.timer = setTimeout(() => this.expire(transfer.descriptor.uploadId, transfer), TRANSFER_EXPIRY_MS); transfer.timer.unref();
	}
	private expire(uploadId: string, transfer: Transfer): void { if (this.transfers.get(uploadId) === transfer) this.transfers.delete(uploadId); }

	private assertSame(existing: ArtifactRecord | ArtifactDescriptor, descriptor: ArtifactDescriptor): void {
		for (const field of ["uploadId", "blobId", "sha256", "filename", "mimeType", "mediaType", "byteLength", "width", "height"] as const) {
			if (existing[field] !== descriptor[field]) throw new RelayRegistryError("invalid_state", "Artifact export retry conflicts with its stable identity");
		}
		if ("chunkCount" in existing && existing.chunkCount !== descriptor.chunkCount) throw new RelayRegistryError("invalid_state", "Artifact export retry changed its chunk plan");
		if (descriptor.chunkCount !== Math.ceil(descriptor.byteLength / MAX_MEDIA_CHUNK_BYTES)) throw new RelayRegistryError("invalid_state", "Artifact export chunk plan is invalid");
	}
}
