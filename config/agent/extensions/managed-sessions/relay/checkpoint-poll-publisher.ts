import type { HostRuntimeState } from "../contracts.js";
import { ManagedMatrixClient } from "./matrix-client.js";
import { RelayRegistry, RelayRegistryError } from "./registry.js";

type CheckpointPollIntent = NonNullable<HostRuntimeState["conversations"][number]["publishingCheckpointPoll"]>;

export class CheckpointPollPublisher {
	constructor(
		private readonly registry: RelayRegistry,
		private readonly matrix: ManagedMatrixClient,
		private readonly afterMatrixAcceptance: () => void = () => undefined,
	) {}

	async publish(conversationId: string, roomId: string, intent: CheckpointPollIntent): Promise<string> {
		const state = await this.registry.beginCheckpointPollPublication(conversationId, intent);
		if (state === "active") {
			const active = this.registry.snapshot().conversations.find((item) => item.conversationId === conversationId)?.activeCheckpointPoll;
			if (!active || active.checkpointId !== intent.checkpointId) throw new RelayRegistryError("invalid_state", "Active checkpoint poll disappeared during publication");
			const chunkId = this.projectionChunkId(conversationId, intent.entryId);
			await this.registry.markProjectionChunkSent(conversationId, intent.entryId, chunkId);
			return active.pollEventId;
		}
		const pollEventId = await this.matrix.startPoll(roomId, intent.transactionId, intent.question,
			intent.options.map((option) => ({ id: option.answerId, text: option.text })), undefined, "unstable");
		this.afterMatrixAcceptance();
		await this.registry.completeCheckpointPollPublication(conversationId, intent.checkpointId, pollEventId);
		await this.registry.markProjectionChunkSent(conversationId, intent.entryId, this.projectionChunkId(conversationId, intent.entryId));
		return pollEventId;
	}

	private projectionChunkId(conversationId: string, entryId: string): string {
		const projection = this.registry.snapshot().conversations.find((item) => item.conversationId === conversationId)?.projection.find((item) => item.entryId === entryId);
		const chunkId = projection?.chunks[0]?.chunkId;
		if (!chunkId) throw new RelayRegistryError("invalid_state", "Checkpoint poll projection chunk is unavailable");
		return chunkId;
	}

	async close(conversationId: string, roomId: string, closing: HostRuntimeState["conversations"][number]["closingCheckpointPolls"][number], signal?: AbortSignal): Promise<void> {
		const dialect = await this.matrix.pollDialect(roomId, closing.pollEventId, signal);
		if (!dialect) throw new RelayRegistryError("invalid_state", "Checkpoint poll closure could not verify its bot-owned start event");
		await this.matrix.endPoll(roomId, closing.closureTransactionId, closing.pollEventId, closing.fallback, signal, dialect);
		await this.registry.completeCheckpointPollClosure(conversationId, closing.pollEventId, closing.closureTransactionId);
	}

	async reconcile(): Promise<void> {
		for (const { conversationId, intent } of this.registry.publishingCheckpointPolls()) {
			const manifest = this.registry.manifestByConversationId(conversationId);
			if (!manifest) throw new RelayRegistryError("not_found", "Checkpoint poll conversation was not found");
			await this.publish(conversationId, manifest.roomId, intent);
		}
		for (const { conversationId, closing } of this.registry.closingCheckpointPolls()) {
			const manifest = this.registry.manifestByConversationId(conversationId);
			if (!manifest) throw new RelayRegistryError("not_found", "Closing checkpoint poll conversation was not found");
			await this.close(conversationId, manifest.roomId, closing);
		}
	}
}
