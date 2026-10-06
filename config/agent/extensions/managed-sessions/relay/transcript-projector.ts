import {
	deriveChunkId,
	deriveMatrixTransactionId,
	deriveTranscriptEntryId,
	type ManagedSessionEnvelope,
} from "../contracts.js";
import { ManagedMatrixClient } from "./matrix-client.js";
import { RelayRegistry, RelayRegistryError } from "./registry.js";
import { renderTranscript, transcriptContentHash } from "./transcript-renderer.js";

interface TranscriptOffer {
	entryId: string;
	piSessionId: string;
	piEntryKey: string;
	kind: "local_user" | "assistant_final" | "assistant_commentary" | "branch_marker";
	disposition?: "silent" | "notify";
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
		if (payload.kind !== "assistant_final" && payload.disposition === "notify") throw new RelayRegistryError("invalid_state", "Only final transcript text may request attention");
		const rendered = renderTranscript(payload.kind, payload.body);
		if (rendered.length === 0) throw new RelayRegistryError("invalid_state", "Empty transcript entries are not projectable");
		const projection = await this.registry.beginProjection(manifest.conversationId, {
			entryId: payload.entryId,
			kind: payload.kind,
			...(payload.disposition === undefined ? {} : { disposition: payload.disposition }),
			status: "projecting",
			contentHash: transcriptContentHash(payload.kind, payload.body),
			chunks: rendered.map((_chunk, index) => ({
				chunkId: deriveChunkId(payload.entryId, index),
				transactionId: deriveMatrixTransactionId(manifest.conversationId, payload.entryId, index),
				status: "pending" as const,
			})),
		});
		for (let index = 0; index < projection.chunks.length; index += 1) {
			const chunkState = projection.chunks[index]!;
			if (chunkState.status === "sent") continue;
			const chunk = rendered[index];
			if (!chunk) throw new RelayRegistryError("invalid_state", "Transcript chunk plan changed during recovery");
			if (payload.kind === "branch_marker") await this.matrix.sendNotice(manifest.roomId, chunkState.transactionId, chunk.body, undefined, "silent");
			else await this.matrix.sendText(manifest.roomId, chunkState.transactionId, chunk.body, chunk.formattedBody, undefined,
				projection.disposition === "notify" ? (index === 0 ? "notify" : "silent") :
					projection.disposition ?? (["assistant_commentary", "branch_marker"].includes(payload.kind) ? "silent" : undefined));
			await this.registry.markProjectionChunkSent(manifest.conversationId, payload.entryId, chunkState.chunkId);
		}
	}
}
