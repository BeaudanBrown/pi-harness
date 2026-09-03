import { createHash } from "node:crypto";
import {
	deriveCheckpointPollAnswerId,
	deriveCheckpointPollIntentHash,
	deriveChunkId,
	deriveMatrixTransactionId,
	deriveTranscriptEntryId,
	type ManagedSessionEnvelope,
} from "../contracts.js";
import { renderRemoteCheckpoint, renderRemoteCheckpointPollQuestion, validateRemoteCheckpoint } from "../checkpoint.js";
import { CheckpointPollPublisher } from "./checkpoint-poll-publisher.js";
import { ManagedMatrixClient } from "./matrix-client.js";
import { RelayRegistry, RelayRegistryError } from "./registry.js";
import { renderTranscript } from "./transcript-renderer.js";

export class RelayEventProjector {
	readonly checkpointPollPublisher: CheckpointPollPublisher;

	constructor(private readonly registry: RelayRegistry, private readonly matrix: ManagedMatrixClient) {
		this.checkpointPollPublisher = new CheckpointPollPublisher(registry, matrix);
	}

	async projectCheckpoint(envelope: ManagedSessionEnvelope): Promise<void> {
		if (envelope.type !== "checkpoint.offer" || !envelope.conversationId || envelope.role === "relay") {
			throw new RelayRegistryError("permission_denied", "Checkpoint offer requires an attached adapter");
		}
		const payload = envelope.payload as { checkpointId: string; originDeliveryId: string; checkpoint: unknown };
		const manifest = this.registry.manifestByConversationId(envelope.conversationId);
		if (!manifest) throw new RelayRegistryError("not_found", "Managed conversation was not found");
		const origin = this.registry.pendingInputs(envelope.conversationId).find((input) => input.deliveryId === payload.originDeliveryId);
		const sourceKey = `checkpoint:${payload.checkpointId}`;
		const expectedEntryId = deriveTranscriptEntryId(manifest.piSessionId, sourceKey);
		const existing = this.registry.checkpointProjectionForOrigin(envelope.conversationId, payload.originDeliveryId);
		if (!origin || !origin.piEntryId || (origin.status !== "persisted" &&
			!(origin.status === "completed" && existing?.entryId === expectedEntryId))) {
			throw new RelayRegistryError("invalid_state", "Checkpoint origin delivery is not available for this boundary");
		}
		if (existing && existing.entryId !== expectedEntryId) throw new RelayRegistryError("invalid_state", "Checkpoint origin already has a different boundary");
		const checkpoint = validateRemoteCheckpoint(payload.checkpoint);
		if (checkpoint.kind === "question" && checkpoint.options?.length) {
			const transactionId = deriveMatrixTransactionId(manifest.conversationId, expectedEntryId, 0);
			const intentBase = {
				checkpointId: payload.checkpointId, originDeliveryId: payload.originDeliveryId, entryId: expectedEntryId, transactionId,
				question: renderRemoteCheckpointPollQuestion(checkpoint),
				options: checkpoint.options.map((text, index) => ({ answerId: deriveCheckpointPollAnswerId(payload.checkpointId, index), text })),
			};
			const intent = { ...intentBase, intentHash: deriveCheckpointPollIntentHash(intentBase) };
			const projection = await this.registry.beginCheckpointPollProjection(manifest.conversationId, {
				entryId: expectedEntryId, kind: "checkpoint", status: "projecting", contentHash: intent.intentHash,
				originDeliveryId: payload.originDeliveryId,
				chunks: [{ chunkId: deriveChunkId(expectedEntryId, 0), transactionId, status: "pending" }],
			}, intent);
			if (projection.chunks[0]?.transactionId !== transactionId) throw new RelayRegistryError("invalid_state", "Checkpoint poll projection has a conflicting transaction");
			const runtime = this.registry.snapshot().conversations.find((item) => item.conversationId === manifest.conversationId);
			if (runtime?.publishingCheckpointPoll?.checkpointId === payload.checkpointId || runtime?.activeCheckpointPoll?.checkpointId === payload.checkpointId) {
				await this.checkpointPollPublisher.publish(manifest.conversationId, manifest.roomId, intent);
			} else if (projection.status !== "projected") {
				throw new RelayRegistryError("invalid_state", "Checkpoint poll projection lost its durable lifecycle");
			}
		} else {
			await this.project(manifest.conversationId, manifest.piSessionId, manifest.roomId,
				sourceKey, "checkpoint", renderRemoteCheckpoint(checkpoint), payload.originDeliveryId);
		}
		await this.registry.acknowledgeInput(manifest.conversationId, payload.originDeliveryId, "completed", origin.piEntryId);
	}

	async projectNotice(conversationId: string, sourceId: string, body: string): Promise<void> {
		const manifest = this.registry.manifestByConversationId(conversationId);
		if (!manifest) throw new RelayRegistryError("not_found", "Managed conversation was not found");
		await this.project(conversationId, manifest.piSessionId, manifest.roomId, `notice:${sourceId}`, "notice", body);
	}

	private async project(conversationId: string, piSessionId: string, roomId: string, sourceKey: string,
		kind: "checkpoint" | "notice", body: string, originDeliveryId?: string): Promise<void> {
		const entryId = deriveTranscriptEntryId(piSessionId, sourceKey);
		const rendered = renderTranscript("assistant_final", body);
		if (kind === "checkpoint" && rendered.length !== 1) throw new RelayRegistryError("invalid_state", "Checkpoint must fit one Matrix event");
		const projection = await this.registry.beginProjection(conversationId, {
			entryId, kind, status: "projecting", contentHash: createHash("sha256").update(`managed-${kind}\0`).update(body).digest("hex"),
			...(originDeliveryId ? { originDeliveryId } : {}),
			chunks: rendered.map((_chunk, index) => ({ chunkId: deriveChunkId(entryId, index),
				transactionId: deriveMatrixTransactionId(conversationId, entryId, index), status: "pending" as const })),
		});
		for (let index = 0; index < projection.chunks.length; index += 1) {
			const chunkState = projection.chunks[index]!;
			if (chunkState.status === "sent") continue;
			const chunk = rendered[index];
			if (!chunk) throw new RelayRegistryError("invalid_state", "Relay event chunk plan changed during recovery");
			await this.matrix.sendText(roomId, chunkState.transactionId, chunk.body, chunk.formattedBody);
			await this.registry.markProjectionChunkSent(conversationId, entryId, chunkState.chunkId);
		}
	}
}
