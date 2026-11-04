import type { RelayRegistry } from "./registry.js";
import type { ManagedMatrixClient } from "./matrix-client.js";

/** Durable future-attempt permission comes exclusively from queue-resumption audit.
 * Retry frozen text/transaction identities, never reconstruct missing legacy payloads. */
export class ProjectionResumptionOwner {
 private readonly controller = new AbortController();
 private timer?: ReturnType<typeof setInterval>;
 private work?: Promise<void>;
 constructor(private readonly registry: RelayRegistry, private readonly matrix: Pick<ManagedMatrixClient, "sendText" | "sendNotice">) {}
 start(): void {
  if (this.timer || this.controller.signal.aborted) return;
  this.timer = setInterval(() => { void this.kick().catch(() => {}); }, 5000); this.timer.unref();
  void this.kick().catch(() => {});
 }
 kick(): Promise<void> {
  if (this.controller.signal.aborted) return Promise.resolve();
  return this.work ??= this.flush().finally(() => { this.work = undefined; });
 }
 private async flush(): Promise<void> {
  const signal = this.controller.signal;
  for (const target of this.registry.resumedProjectionTargets()) {
   signal.throwIfAborted();
   await this.registry.withQueueEffect(target.conversationId, async () => {
    // Admission may have changed between selection and acquiring the producer lease.
    if (!this.registry.resumedProjectionTargets().some(t => t.conversationId === target.conversationId && t.entryId === target.entryId)) return;
    const manifest = this.registry.manifestByConversationId(target.conversationId);
    const projection = this.registry.projectionByEntryId(target.conversationId, target.entryId);
    if (!manifest || !projection) return;
    for (let index = 0; index < projection.chunks.length; index++) {
     signal.throwIfAborted(); const chunk = projection.chunks[index];
     const current = this.registry.projectionByEntryId(target.conversationId, target.entryId);
     if (!current || ["projected", "cancelled"].includes(current.status) || this.registry.queueItemHeld(target.conversationId, "projection", target.entryId)) return;
     if (current.chunks.find(c => c.chunkId === chunk.chunkId)?.status === "sent") continue;
     if (chunk.body === undefined || chunk.formattedBody === undefined) throw Error("Original output payload is unavailable; the original producer must reoffer it");
     if (projection.kind === "branch_marker") await this.matrix.sendNotice(manifest.roomId, chunk.transactionId, chunk.body, signal, "silent");
     else await this.matrix.sendText(manifest.roomId, chunk.transactionId, chunk.body, chunk.formattedBody, signal,
      projection.disposition === "notify" ? (index === 0 ? "notify" : "silent") : projection.disposition ?? (projection.kind === "assistant_commentary" ? "silent" : undefined));
     await this.registry.markProjectionChunkSent(target.conversationId, target.entryId, chunk.chunkId);
    }
   });
  }
 }
 async close(): Promise<void> {
  this.controller.abort(); if (this.timer) clearInterval(this.timer);
  await this.work?.catch(() => {});
 }
}
