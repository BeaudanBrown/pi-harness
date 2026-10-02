import { deriveChunkId, deriveMatrixTransactionId, type HostRuntimeState } from "../contracts.js";
import { renderTranscript as renderLegacyTranscript } from "./legacy-transcript-renderer.js";
import { renderTranscript } from "./transcript-renderer.js";
import { RelayRegistry, RelayRegistryError } from "./registry.js";

type Projection = HostRuntimeState["conversations"][number]["projection"][number];

/** Select old plans before parsing, and freeze new transaction bodies before any send. */
export async function prepareTextProjection(registry: RelayRegistry, conversationId: string,
	identity: Pick<Projection, "entryId" | "kind" | "contentHash" | "originDeliveryId">,
	body: string, renderKind: "local_user" | "assistant_final", singleEvent = false): Promise<Projection> {
	const existing = registry.projectionByEntryId(conversationId, identity.entryId);
	if (existing && (existing.kind !== identity.kind || existing.contentHash !== identity.contentHash ||
		existing.originDeliveryId !== identity.originDeliveryId)) {
		throw new RelayRegistryError("invalid_state", "Conflicting transcript projection content");
	}
	if (existing?.renderingVersion === 2 || existing?.status === "projected") return existing;
	const rendered = (existing ? renderLegacyTranscript : renderTranscript)(renderKind, body);
	if (!rendered.length) throw new RelayRegistryError("invalid_state", "Empty transcript entries are not projectable");
	if (singleEvent && rendered.length !== 1) throw new RelayRegistryError("invalid_state", "Checkpoint must fit one Matrix event");
	const projection = await registry.beginProjection(conversationId, {
		...identity, status: "projecting", ...(!existing ? { renderingVersion: 2 as const } : {}),
		chunks: rendered.map((chunk, index) => ({
			chunkId: deriveChunkId(identity.entryId, index),
			transactionId: deriveMatrixTransactionId(conversationId, identity.entryId, index),
			status: "pending", ...(!existing ? chunk : {}),
		})),
	});
	// Legacy payloads are reconstructed using the exact legacy renderer, never persisted as v2.
	if (!projection.renderingVersion) return { ...projection, chunks: projection.chunks.map((chunk, index) => ({ ...chunk, ...rendered[index]! })) };
	return projection;
}
