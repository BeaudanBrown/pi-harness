import { createHash } from "node:crypto";
import {
	deriveCheckpointPollAnswerId,
	deriveCheckpointPollIntentHash,
	deriveChunkId,
	deriveMatrixTransactionId,
	deriveTranscriptEntryId,
	type ManagedSessionEnvelope,
	type ConversationManifest,
} from "../contracts.js";
import { renderRemoteCheckpoint, renderRemoteCheckpointPollQuestion, validateRemoteCheckpoint } from "../checkpoint.js";
import { CheckpointPollPublisher } from "./checkpoint-poll-publisher.js";
import { ManagedMatrixClient } from "./matrix-client.js";
import { RelayRegistry, RelayRegistryError } from "./registry.js";
import { renderTranscript } from "./transcript-renderer.js";
import { NoticeOutbox } from "./notice-outbox.js";
import { type RecoveryAlert, RecoveryAlerts } from "./recovery-alerts.js";

export class RelayEventProjector {
	readonly checkpointPollPublisher: CheckpointPollPublisher;
	private notices?: NoticeOutbox;

	async startNoticeOutbox(path: string, diagnostic: (message: string) => void): Promise<void> {
		this.notices = new NoticeOutbox(path, async (notice) => {
			const manifest = this.registry.manifestByConversationId(notice.conversationId);
			if (!manifest) {
				if (notice.awaitRegistration && !this.registry.retirement(notice.conversationId)) throw new RelayRegistryError("not_found", "Fork destination registration is pending");
				return;
			}
			if (notice.awaitRegistration && manifest.roomId !== notice.roomId) throw new RelayRegistryError("invalid_state", "Fork destination room changed");
			await this.project(notice.conversationId, notice.piSessionId, notice.roomId, `notice:${notice.sourceId}`, "notice", notice.body, undefined, notice.disposition);
		}, diagnostic);
		await this.notices.load(); this.notices.start();
	}
	async close(): Promise<void> { await this.notices?.close(); }

	constructor(private readonly registry: RelayRegistry, private readonly matrix: ManagedMatrixClient, private readonly recovery?: RecoveryAlerts,
		private readonly checkpointDisposition: () => "silent" | "notify" = () => "notify") {
		this.checkpointPollPublisher = new CheckpointPollPublisher(registry, matrix);
	}

	async projectRecoveryAlert(alert: RecoveryAlert): Promise<void> {
		const { conversationId, piSessionId, roomId } = alert.ticket.target;
		// Retirement removes the destination; never recreate it to deliver a reminder.
		if (this.registry.manifestByConversationId(conversationId)?.roomId !== roomId) return;
		await this.project(conversationId, piSessionId, roomId, alert.sourceId, "notice",
			alert.body, undefined, "notify");
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
				...(existing ? existing.disposition ? { disposition: existing.disposition } : {} : { disposition: this.checkpointDisposition() }),
				chunks: [{ chunkId: deriveChunkId(expectedEntryId, 0), transactionId, status: "pending" }],
			}, intent);
			if (projection.disposition !== "silent" && projection.chunks.some((chunk) => chunk.status === "pending")) await this.recovery?.originalAccepted(manifest.conversationId, manifest.piSessionId);
			if (projection.chunks[0]?.transactionId !== transactionId) throw new RelayRegistryError("invalid_state", "Checkpoint poll projection has a conflicting transaction");
			const runtime = this.registry.snapshot().conversations.find((item) => item.conversationId === manifest.conversationId);
			if (runtime?.publishingCheckpointPoll?.checkpointId === payload.checkpointId || runtime?.activeCheckpointPoll?.checkpointId === payload.checkpointId) {
				await this.checkpointPollPublisher.publish(manifest.conversationId, manifest.roomId, intent);
			} else if (projection.status !== "projected") {
				throw new RelayRegistryError("invalid_state", "Checkpoint poll projection lost its durable lifecycle");
			}
		} else {
			await this.project(manifest.conversationId, manifest.piSessionId, manifest.roomId,
				sourceKey, "checkpoint", renderRemoteCheckpoint(checkpoint), payload.originDeliveryId, this.checkpointDisposition());
		}
		await this.registry.acknowledgeInput(manifest.conversationId, payload.originDeliveryId, "completed", origin.piEntryId);
	}

	/** Persist before destination registration: a crash cannot leave a seeded room without its summary notice. */
	async stageForkNotice(manifest: ConversationManifest, sourceId: string, body: string): Promise<void> {
		if (!this.notices) throw new RelayRegistryError("invalid_state", "Durable fork summary publication is unavailable");
		await this.notices.enqueue({ conversationId: manifest.conversationId, sourceId, piSessionId: manifest.piSessionId, roomId: manifest.roomId, body, disposition: "silent", awaitRegistration: true });
	}

	async projectNotice(conversationId: string, sourceId: string, body: string, disposition: "silent" | "notify" = "silent"): Promise<void> {
		const manifest = this.registry.manifestByConversationId(conversationId);
		if (!manifest) throw new RelayRegistryError("not_found", "Managed conversation was not found");
		if (this.notices) {
			await this.notices.enqueue({ conversationId, sourceId, piSessionId: manifest.piSessionId, roomId: manifest.roomId, body, disposition });
		} else await this.project(conversationId, manifest.piSessionId, manifest.roomId, `notice:${sourceId}`, "notice", body, undefined, disposition);
	}

	private async project(conversationId: string, piSessionId: string, roomId: string, sourceKey: string,
		kind: "checkpoint" | "notice", body: string, originDeliveryId?: string, disposition?: "silent" | "notify"): Promise<void> {
		const entryId = deriveTranscriptEntryId(piSessionId, sourceKey);
		const rendered = renderTranscript("assistant_final", body);
		if (kind === "checkpoint" && rendered.length !== 1) throw new RelayRegistryError("invalid_state", "Checkpoint must fit one Matrix event");
		// Existing records, including records without metadata, are already frozen.
		// Never change an uncertain pre-upgrade PUT into a notification-bearing one.
		const existing = this.registry.snapshot().conversations.find((item) => item.conversationId === conversationId)?.projection.find((item) => item.entryId === entryId);
		const frozenDisposition = existing ? existing.disposition : disposition;
		const projection = await this.registry.beginProjection(conversationId, {
			...(frozenDisposition === undefined ? {} : { disposition: frozenDisposition }),
			entryId, kind, status: "projecting", contentHash: createHash("sha256").update(`managed-${kind}\0`).update(body).digest("hex"),
			...(originDeliveryId ? { originDeliveryId } : {}),
			chunks: rendered.map((_chunk, index) => ({ chunkId: deriveChunkId(entryId, index),
				transactionId: deriveMatrixTransactionId(conversationId, entryId, index), status: "pending" as const })),
		});
		if (kind === "checkpoint" && projection.disposition === "notify" && projection.chunks.some((chunk) => chunk.status === "pending")) {
			await this.recovery?.originalAccepted(conversationId, piSessionId);
		}
		for (let index = 0; index < projection.chunks.length; index += 1) {
			const chunkState = projection.chunks[index]!;
			if (chunkState.status === "sent") continue;
			const chunk = rendered[index];
			if (!chunk) throw new RelayRegistryError("invalid_state", "Relay event chunk plan changed during recovery");
			await this.matrix.sendText(roomId, chunkState.transactionId, chunk.body, chunk.formattedBody, undefined,
				projection.disposition === "notify" && index > 0 ? "silent" : projection.disposition);
			await this.registry.markProjectionChunkSent(conversationId, entryId, chunkState.chunkId);
		}
	}
}
