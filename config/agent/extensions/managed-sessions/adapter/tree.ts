import { randomUUID } from "node:crypto";
import type { SessionBinding } from "./state.js";
import { latestTreeChange, TREE_ENTRY_TYPE, type TreeChange, type TreeRecord } from "./tree-boundary.js";

/** A local projection boundary and a relay delivery fence, never a session handoff. */
export class AdapterTree {
	private record?: TreeRecord;
	private live = false;
	private idleFenced = false;
	private closed = false;
	private work?: Promise<void>;
	private timer?: NodeJS.Timeout;
	private removeAbort?: () => void;
	private gate?: Promise<void>;
	private release?: () => void;
	constructor(private readonly options: {
		binding: SessionBinding; entries: () => readonly unknown[]; branch: () => readonly { id: string }[];
		append: (kind: string, data: unknown) => string; ensureBinding: () => void;
		request: (operationId: string, phase: "prepare" | "complete", cancelled?: boolean) => Promise<void>;
		valid: () => boolean; idle: () => boolean; diagnostic: () => void; onReady?: () => void;
	}) {
		this.record = latestTreeChange(options.entries(), options.binding);
		if (this.record) this.hold();
	}
	get pending(): boolean { return Boolean(this.gate); }
	get navigating(): boolean { return this.live; }
	async ready(): Promise<void> { await this.gate; }
	private hold(): void { this.gate ??= new Promise(resolve => { this.release = resolve; }); }
	private clear(): void { if (this.timer) clearTimeout(this.timer); this.timer = undefined; this.removeAbort?.(); this.removeAbort = undefined; this.release?.(); this.release = undefined; this.gate = undefined; if (!this.closed && this.options.valid()) this.options.onReady?.(); }
	private persist(data: TreeChange): void { this.record = { id: this.options.append(TREE_ENTRY_TYPE, data), data }; }
	async recover(remoteOperationId?: string): Promise<void> {
		if (this.closed || !this.options.valid()) return;
		if (remoteOperationId && this.record?.data.operationId !== remoteOperationId) { this.hold(); throw Error("Relay tree fence has no matching native journal; explicit recovery required"); }
		if (!this.pending || !this.record) return;
		if (this.record.data.phase === "prepared") {
			if (this.live && (!this.idleFenced || !this.options.idle())) return;
			this.live = false;
			if (!this.options.branch().some(entry => entry.id === this.record!.id)) throw Error("Unproven tree change requires explicit recovery; managed input is held");
			this.persist({ ...this.record.data, phase: "cancelled" });
		} else if (this.record.data.phase === "cancelled" && !this.options.branch().some(entry => entry.id === this.record!.id)) {
			throw Error("Cancelled tree source is not the current branch; explicit recovery required");
		} else if (this.record.data.phase === "committed") {
			if (!this.options.branch().some(entry => entry.id === this.record!.id)) throw Error("Tree boundary is outside the current branch");
			this.options.ensureBinding();
		}
		await this.finish();
	}
	async prepare(oldLeafId: string | null, targetId: string, signal: AbortSignal, idleFenced = true): Promise<boolean> {
		this.idleFenced = idleFenced;
		if (this.pending || this.closed || signal.aborted || !this.options.valid()) return false;
		this.hold(); const { conversationId, sessionId, bindingBoundaryEntryId } = this.options.binding;
		this.persist({ version: "1.0.0", conversationId, sessionId, bindingBoundaryEntryId, operationId: `tree-${randomUUID()}`, phase: "prepared", oldLeafId, targetId });
		try {
			await this.options.request(this.record!.data.operationId, "prepare");
			if (signal.aborted || this.closed || !this.options.valid()) throw Error("Tree change cancelled");
			this.live = true;
			// Abort is a request, not proof that SDK navigation stopped. Observe the
			// public idle boundary and unchanged persisted source before cancelling.
			const abort = () => this.poll();
			signal.addEventListener("abort", abort, { once: true }); this.removeAbort = () => signal.removeEventListener("abort", abort);
			this.poll(); return true;
		} catch {
			this.persist({ ...this.record!.data, phase: "cancelled" }); await this.finish(); return false;
		}
	}
	async committed(oldLeafId: string | null): Promise<void> {
		if (!this.live || !this.record || this.record.data.oldLeafId !== oldLeafId || this.closed || !this.options.valid()) throw Error("Tree completion changed its prepared source");
		this.live = false; this.removeAbort?.(); this.removeAbort = undefined;
		this.persist({ ...this.record.data, phase: "committed" }); this.options.ensureBinding(); await this.finish();
	}
	private poll(): void {
		if (this.timer || this.closed) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			if (this.closed || !this.options.valid() || !this.pending) return;
			void this.recover().catch(() => this.options.diagnostic()).finally(() => { if (this.pending) this.poll(); });
		}, 1000); this.timer.unref();
	}
	private async finish(): Promise<void> {
		if (this.work) return this.work;
		this.work = (async () => {
			if (!this.record || this.closed || !this.options.valid()) return;
			try {
				await this.options.request(this.record.data.operationId, "complete", this.record.data.phase === "cancelled");
				if (!this.closed && this.options.valid()) this.clear();
			} catch {
				this.options.diagnostic();
				if (!this.closed && !this.timer) { this.timer = setTimeout(() => { this.timer = undefined; void this.finish(); }, 5000); this.timer.unref(); }
			}
		})();
		try { await this.work; } finally { this.work = undefined; }
	}
	close(): void { this.closed = true; if (this.timer) clearTimeout(this.timer); this.clear(); }
}
