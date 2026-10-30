import { isDeepStrictEqual } from "node:util";
import { deriveConversationId } from "../contracts.js";
import type { HostAction, HostResult } from "../live-workspace-contracts.js";
import type { ArchiveHierarchy, ArchivePlan } from "./archive-hierarchy.js";
import type { ArchiveRuntimeChecks } from "./archive-runtime.js";
import type { RelayRegistry } from "./registry.js";
import { HostInventoryPages } from "./host-inventory-pages.js";
import { HostControlError } from "./host-control-error.js";
export type ArchivePreviewAction = Extract<HostAction, { operation: "conversation.archive.preview" | "conversation.archive.cleanup.preview" }>;
export interface ArchiveControlSnapshot {
	source: ArchivePreviewAction; plans: ArchivePlan[]; blockers: string[];
	witnesses: Array<{ conversationId: string; basis: string; windowDigest?: string; bootId?: string; progress?: unknown }>;
}
/** Feature-owned orchestration. Consent/expiry remain in the shared host owner, not here. */
export class ArchiveHostControls {
	private readonly pages: HostInventoryPages;
	constructor(private readonly options: { registry: RelayRegistry; hierarchy: ArchiveHierarchy; runtime: ArchiveRuntimeChecks }) {
		this.pages = new HostInventoryPages(options.registry.hostId);
	}
	async snapshot(input: ArchivePreviewAction): Promise<ArchiveControlSnapshot> {
		const source = structuredClone(input); source.conversationIds.sort();
		const result: ArchiveControlSnapshot = { source, plans: [], witnesses: [], blockers: [] };
		const cleanup = source.operation === "conversation.archive.cleanup.preview";
		for (const id of source.conversationIds) try {
			if (id === deriveConversationId(this.options.registry.hostId, "coordinator")) throw new HostControlError("forbidden", "The protected coordinator cannot be archived");
			const record = this.options.registry.archiveRecord(id);
			if (record) {
				const progress = this.options.hierarchy.status(id);
				if (!progress || cleanup && progress.phase !== "archived") throw new HostControlError("conflict", "Complete the archive move before ancestor cleanup");
				const cleanupEvidence = cleanup ? await this.options.hierarchy.cleanupPreview(id) : undefined;
				if (cleanupEvidence?.some(row => row.state === "unverifiable")) throw new HostControlError("conflict", "Ancestor cleanup ownership or emptiness is unverifiable; repair separately without implicit rejoin");
				const closure = !cleanup ? await this.options.runtime.inspect(record.source, source.operation === "conversation.archive.preview" && source.legacyClosure === true) : undefined;
				const evidence = closure ? { basis: closure.receipt.basis, windowDigest: closure.receipt.windowDigest, bootId: closure.receipt.bootId } : { basis: "cleanup_only" };
				result.plans.push(await this.options.hierarchy.preview(id)); result.witnesses.push({ conversationId: id, ...evidence, progress: { ...progress, ...(cleanupEvidence ? { cleanupEvidence } : {}) } });
			} else {
				if (cleanup) throw new HostControlError("conflict", "Conversation has not been archived");
				const candidate = this.options.registry.archiveCandidate(id);
				const closure = await this.options.runtime.inspect(candidate.source, source.operation === "conversation.archive.preview" && source.legacyClosure === true);
				result.plans.push(await this.options.hierarchy.preview(id, closure.window));
				const { checkedAt: _, ...evidence } = closure.receipt; result.witnesses.push({ conversationId: id, ...evidence });
			}
		} catch (error) {
			result.blockers.push(`${id}: ${error instanceof HostControlError ? error.message : "Archive ownership or state inspection failed; resolve before retrying"}`.slice(0, 512));
		}
		return result;
	}
	warnings(snapshot: ArchiveControlSnapshot): string[] {
		if (snapshot.source.operation === "conversation.archive.cleanup.preview") return [
			"Clean up only the frozen original ancestor Spaces when still owned, empty and unreferenced. Preserve shared/untracked Spaces and all archived conversation rooms/history/membership.",
			"Account outages or uncertain departure can leave cleanup pending; no automatic rejoin, kick or inferred completion.",
		];
		const legacy = snapshot.witnesses.filter(w => w.basis === "operator_attested").length;
		return [
			"Archive these exact conversations under host -> Archive -> historical project -> worktree. Preserve the original Matrix rooms, history and operator membership; disable managed input/attachment/launch. No reactivation or checkout restoration.",
			"Ancestor cleanup is separate. Pending archive-Space joins keep original links. Matrix has no conditional state writes: avoid concurrent hierarchy edits; observed conflicts block rather than overwrite.",
			...(legacy ? [`LEGACY ATTESTATION for ${legacy} selected conversations: approving asserts that their old Pi processes were closed. Fresh complete conflict inspection must pass. This is operator attestation, NOT verified process exit. Never confirm on the operator's behalf.`] : ["Runtime closure is inspected afresh, including retries; an existing archive fence does not replace closure inspection."]),
		];
	}
	async valid(snapshot: ArchiveControlSnapshot): Promise<boolean> {
		return snapshot.blockers.length === 0 && isDeepStrictEqual(snapshot, await this.snapshot(snapshot.source));
	}
	async apply(snapshot: ArchiveControlSnapshot, operationId: string): Promise<boolean> {
		if (!await this.valid(snapshot)) throw new HostControlError("stale_preview", "Archive targets or closure evidence changed; obtain fresh preview and consent");
		let pending = false;
		for (const plan of snapshot.plans) {
			const status = snapshot.source.operation === "conversation.archive.cleanup.preview"
				? await this.options.hierarchy.cleanup(plan.source.conversationId)
				: await this.options.hierarchy.apply(plan, snapshot.source.legacyClosure === true, operationId);
			pending ||= !status || status.phase !== "archived" || status.cleanupPending > 0;
		}
		return pending;
	}
	list(action: Extract<HostAction, { operation: "conversation.archive.list" }>): HostResult<"conversation.archive.list"> {
		const rows = this.options.registry.archiveRecords().map(record => {
			const status = this.options.hierarchy.status(record.source.conversationId);
			if (!status || status.phase === "reserved" || !status.closureBasis) throw new HostControlError("unavailable", "Archive receipt is unavailable; restore complete authority");
			return { ...status, phase: status.phase, closureBasis: status.closureBasis, title: record.source.title, roomId: record.source.roomId, placement: record.source.placement,
				projectDisplayName: record.source.projectTitle, checkoutDisplayName: record.source.checkoutTitle };
		}).sort((a, b) => a.conversationId.localeCompare(b.conversationId));
		return this.pages.page(action, rows);
	}
}
