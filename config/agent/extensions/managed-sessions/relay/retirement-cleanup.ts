import type { RetirementEffect, RetirementRecord } from "./retirement-store.js";

type Outcome = "pending" | "blocked" | "done";
export interface RetirementCleanupAuthority {
	pendingRetirements(): RetirementRecord[];
	retirement(conversationId: string): RetirementRecord | undefined;
	markRetirementCleanup(conversationId: string, effectId: string, phase: "blocked" | "done"): Promise<RetirementRecord>;
}

/** Retry only operation-specific, exact, idempotent cleanup—not model execution or conversation creation. */
export class RetirementCleanup {
	private readonly active = new Map<string, Promise<void>>();
	private readonly controller = new AbortController();
	private cursor = 0;
	private closed = false;
	constructor(private readonly options: {
		authority: RetirementCleanupAuthority;
		/** Must recheck ownership and identity before each external effect; must never expand targets. */
		execute(record: RetirementRecord, effect: RetirementEffect, signal: AbortSignal): Promise<Outcome>;
		concurrency?: number;
	}) {
		if (options.concurrency !== undefined && (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 4)) throw Error("Invalid retirement cleanup concurrency");
	}

	/** Nonblocking admission. A stalled conversation does not hold up unrelated cleanup. */
	kick(): void {
		if (this.closed) return;
		const pending = this.options.authority.pendingRetirements().flatMap((record) => (record.cleanup ?? [])
			.filter((effect) => effect.phase !== "done").map((effect) => ({ conversationId: record.conversationId, effectId: effect.effectId })));
		if (!pending.length) return;
		const limit = this.options.concurrency ?? 4;
		for (let offset = 0; offset < pending.length && this.active.size < limit; offset++) {
			const index = (this.cursor + offset) % pending.length; const record = pending[index];
			if (this.active.has(record.effectId)) continue;
			const work = Promise.resolve().then(() => this.run(record.conversationId, record.effectId)); this.active.set(record.effectId, work);
			void work.finally(() => this.active.delete(record.effectId)).catch(() => undefined);
		}
		this.cursor = (this.cursor + limit) % pending.length;
	}
	async drain(): Promise<void> { await Promise.all([...this.active.values()]); }
	async close(): Promise<void> { this.closed = true; this.controller.abort(); await Promise.allSettled([...this.active.values()]); }
	private async run(conversationId: string, effectId: string): Promise<void> {
		const record = this.options.authority.retirement(conversationId); const effect = record?.cleanup?.find((item) => item.effectId === effectId);
		if (!record || !effect || this.closed || effect.phase === "done") return;
		let outcome: Outcome;
		try { outcome = await this.options.execute(structuredClone(record), structuredClone(effect), this.controller.signal); }
		catch { outcome = "blocked"; }
		const latest = this.options.authority.retirement(conversationId)?.cleanup?.find((item) => item.effectId === effectId);
		if (outcome !== "pending" && latest && latest.phase !== "done") await this.options.authority.markRetirementCleanup(conversationId, effect.effectId, outcome);
	}
}
