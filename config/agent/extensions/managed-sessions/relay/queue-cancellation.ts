import { createHash } from "node:crypto";
import type { HostRuntimeState, RegisteredConversation, QueueCancellationReceipt } from "../contracts.js";
import { HostControlError } from "./host-control-error.js";

type Row = HostRuntimeState["conversations"][number];
export interface QueueCancellationSnapshot {
	conversationId: string; sourceDigest: string; items: QueueCancellationReceipt["items"]; blockers: string[];
}
const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function queueCancellationSnapshot(manifest: RegisteredConversation, row: Row, busy: boolean): QueueCancellationSnapshot {
	const items: QueueCancellationReceipt["items"] = [
		...row.pendingInputs.filter(i => !["completed", "cancelled"].includes(i.status)).map(i => ({ kind: "input" as const, id: i.deliveryId, priorState: i.status, digest: digest(i) })),
		...row.pendingControls.map(i => ({ kind: "control" as const, id: i.controlId, priorState: "pending", digest: digest(i) })),
		...row.projection.filter(i => !["projected", "cancelled"].includes(i.status)).map(i => ({ kind: "projection" as const, id: i.entryId, priorState: i.status, digest: digest(i) })),
	].sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`));
	const blockers: string[] = [];
	if (manifest.kind !== "project") blockers.push("The protected coordinator is not eligible");
	if (busy || row.attachment || row.state !== "dormant") blockers.push("Attached, launching or in-flight work blocks abandonment");
	if (row.generationTransition || row.treeTransition || row.promotion || row.publishingControlPoll || row.activeControlPoll || row.publishingCheckpointPoll || row.activeCheckpointPoll || row.closingCheckpointPolls.length)
		blockers.push("Resolve lifecycle transitions and poll obligations separately");
	if (row.projection.some(i => i.kind === "checkpoint" && !["projected", "cancelled"].includes(i.status))) blockers.push("Checkpoint boundaries require separate resolution");
	if (row.artifactExports.some(i => i.state !== "sent" && !i.failure)) blockers.push("Artifact delivery is not covered by queue abandonment");
	if (!items.length) blockers.push("No pending items to abandon");
	if (items.length > 32 || (row.queueCancellations?.length ?? 0) >= 32 || (row.abandonedControls?.length ?? 0) + row.pendingControls.length > 1024)
		blockers.push("Cancellation audit capacity exceeded; no implicit pruning");
	return { conversationId: manifest.conversationId, sourceDigest: digest({ manifest, row }), items, blockers };
}

/** Synchronous admission prevents new producers from crossing an awaited cancellation commit.
 * Existing producers cause rejection, not cancellation/termination of their effects. */
export class QueueActivityGate {
	private readonly active = new Map<string, number>();
	private readonly held = new Set<string>();
	busy(id: string): boolean { return (this.active.get(id) ?? 0) > 0; }
	async effect<T>(id: string, work: () => Promise<T>): Promise<T> {
		if (this.held.has(id)) throw new HostControlError("busy", "Queue abandonment admission is in progress");
		this.active.set(id, (this.active.get(id) ?? 0) + 1);
		try { return await work(); } finally {
			const count = this.active.get(id)! - 1; if (count) this.active.set(id, count); else this.active.delete(id);
		}
	}
	async exclusive<T>(id: string, work: () => Promise<T>): Promise<T> {
		if (this.busy(id) || this.held.has(id)) throw new HostControlError("busy", "Queue work is in flight; retry with a fresh preview");
		this.held.add(id);
		try { return await work(); } finally { this.held.delete(id); }
	}
}
export function abandonQueue(row: Row, snapshot: QueueCancellationSnapshot, operationId: string, at: string): void {
	// The owner revalidates the complete snapshot inside its serialized writer first.
	for (const item of snapshot.items) {
		if (item.kind === "input") row.pendingInputs.find(i => i.deliveryId === item.id)!.status = "cancelled";
		if (item.kind === "projection") row.projection.find(i => i.entryId === item.id)!.status = "cancelled";
	}
	(row.abandonedControls ??= []).push(...row.pendingControls);
	row.pendingControls = [];
	(row.queueCancellations ??= []).push({ operationId, at, sourceDigest: snapshot.sourceDigest,
		semantics: "abandon_future_attempts_prior_effects_uncertain", items: structuredClone(snapshot.items) });
}
export function wasQueueCancelled(row: Row, kind: QueueCancellationReceipt["items"][number]["kind"], id: string): boolean {
	return row.queueCancellations?.some(r => r.items.some(i => i.kind === kind && i.id === id)) ?? false;
}
export const QUEUE_CANCELLATION_WARNING = "Abandon ONLY future dispatch/retries for the frozen IDs. Prior execution or Matrix delivery may already have occurred and remains uncertain. Preserve saved history, prior effects and sent-chunk evidence; never mark abandonment successfully completed. No launch, stop, retirement or membership change.";
