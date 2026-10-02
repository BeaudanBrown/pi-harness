import {
	deriveTranscriptEntryId,
	type ManagedSessionEnvelope,
} from "../contracts.js";
import { ManagedMatrixClient } from "./matrix-client.js";
import { RelayRegistry, RelayRegistryError } from "./registry.js";
import { transcriptContentHash } from "./transcript-renderer.js";
import { prepareTextProjection } from "./text-projection.js";

interface TranscriptOffer {
	entryId: string;
	piSessionId: string;
	piEntryKey: string;
	kind: "local_user" | "assistant_final";
	body: string;
}

export class TranscriptProjector {
	constructor(private readonly registry: RelayRegistry, private readonly matrix: ManagedMatrixClient) {}

	async project(envelope: ManagedSessionEnvelope): Promise<void> {
		if (envelope.type !== "transcript.offer" || !envelope.conversationId || envelope.role === "relay") {
			throw new RelayRegistryError("permission_denied", "Transcript offer requires an attached adapter");
		}
		const payload = envelope.payload as unknown as TranscriptOffer;
		const manifest = this.registry.manifestByConversationId(envelope.conversationId);
		if (!manifest || payload.piSessionId !== manifest.piSessionId ||
			payload.entryId !== deriveTranscriptEntryId(payload.piSessionId, payload.piEntryKey)) {
			throw new RelayRegistryError("permission_denied", "Transcript entry does not belong to the bound Pi session");
		}
		const projection = await prepareTextProjection(this.registry, manifest.conversationId, {
			entryId: payload.entryId, kind: payload.kind,
			contentHash: transcriptContentHash(payload.kind, payload.body),
		}, payload.body, payload.kind);
		for (let index = 0; index < projection.chunks.length; index += 1) {
			const chunkState = projection.chunks[index]!;
			if (chunkState.status === "sent") continue;
			if (chunkState.body === undefined || chunkState.formattedBody === undefined) throw new RelayRegistryError("invalid_state", "Transcript payload is missing during recovery");
			await this.matrix.sendText(manifest.roomId, chunkState.transactionId, chunkState.body, chunkState.formattedBody);
			await this.registry.markProjectionChunkSent(manifest.conversationId, payload.entryId, chunkState.chunkId);
		}
	}
}
