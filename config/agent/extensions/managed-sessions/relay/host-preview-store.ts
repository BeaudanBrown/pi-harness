import { createHash } from "node:crypto";
import { APPROVAL_LIFETIME_MS, parseHostResponse, type HostAction, type HostResult } from "../live-workspace-contracts.js";
import { HostControlError } from "./host-control-error.js";
type Result = HostResult<"conversation.delete.preview">;
export interface HostPreviewData { source: { operation: HostAction["operation"] }; expiresAt: number;
	targets: Result["targets"]; activeRuns: Result["activeRuns"]; blockers: string[]; warnings?: string[] }
export const staleHostPreview = () => new HostControlError("stale_preview", "Frozen targets changed or expired; obtain a new preview and consent");
/** Bounded disposable preview handles. Not consent, a durable receipt, or a retry executor. */
export class HostPreviewStore<T extends HostPreviewData> {
	private readonly entries = new Map<string, T>();
	constructor(private readonly hostId: string, private readonly now: () => number = Date.now) {}
	expiresAt(): number {
		for (const [id, value] of this.entries) if (value.expiresAt <= this.now()) this.entries.delete(id);
		if (this.entries.size >= 128) throw new HostControlError("busy", "Too many pending previews; retry after expiry");
		return this.now() + APPROVAL_LIFETIME_MS;
	}
	save(value: T): Result {
		// Bounds apply equally to all features, including opaque JSON snapshots.
		if (Buffer.byteLength(JSON.stringify(value)) > 48 * 1024) throw new HostControlError("unavailable", "Preview exceeds approval bounds; select fewer targets");
		const previewId = `preview_${createHash("sha256").update("pi-managed-sessions:preview:live-v1\0").update(this.hostId).update("\0").update(JSON.stringify(value)).digest("hex").slice(0, 32)}`;
		const result = { previewId, expiresAt: new Date(value.expiresAt).toISOString(), targets: value.targets, activeRuns: value.activeRuns, blockers: value.blockers, ...(value.warnings ? { warnings: value.warnings } : {}) };
		try { parseHostResponse(value.source.operation, { version: "1.0.0", requestId: "preview", ok: true, data: result }); }
		catch { throw new HostControlError("unavailable", "Preview exceeds target bounds; request a smaller operation"); }
		this.expiresAt(); this.entries.set(previewId, structuredClone(value)); return structuredClone(result);
	}
	get(action: Extract<HostAction, { previewId: string }>): T {
		const value = this.entries.get(action.previewId);
		const expected = action.operation === "worktree.branch.delete" ? "worktree.branch.preview" : action.operation.replace(/\.apply$/, ".preview");
		if (!value || value.expiresAt <= this.now() || value.source.operation !== expected) throw staleHostPreview();
		return structuredClone(value);
	}
}
/** FrozenJson has a narrow key grammar; Matrix keys stay inside bounded JSON strings. */
export function freezeJsonChunks(value: unknown): string[] {
	const json = JSON.stringify(value); if (Buffer.byteLength(json) > 44 * 1024) throw new HostControlError("unavailable", "Frozen snapshot exceeds approval bounds; select fewer targets");
	return Array.from({ length: Math.ceil(json.length / 4096) }, (_, i) => json.slice(i * 4096, (i + 1) * 4096));
}
