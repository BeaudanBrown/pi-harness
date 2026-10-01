/** Bounded retry of durable local registrations; never starts or inspects a Pi process. */
export class LocalEnrollmentReconciler {
	private readonly running = new Map<string, Promise<void>>();
	private readonly retryAt = new Map<string, number>();
	private readonly reported = new Map<string, string>();
	private readonly controller = new AbortController();
	private timer?: ReturnType<typeof setInterval>;
	constructor(private readonly pending: () => string[], private readonly reconcile: (conversationId: string, signal: AbortSignal) => Promise<void>,
		private readonly report: (conversationId: string, error: unknown) => void,
		private readonly intervalMs = 1_000, private readonly retryMs = 5_000, private readonly concurrency = 4) {
		if (![intervalMs, retryMs, concurrency].every(Number.isSafeInteger) || intervalMs < 1 || retryMs < 1 || concurrency < 1 || concurrency > 16) throw Error("Invalid enrollment retry bounds");
	}
	start(): void {
		this.controller.signal.throwIfAborted();
		if (this.timer) return;
		this.timer = setInterval(() => this.tick(), this.intervalMs); this.timer.unref(); this.tick();
	}
	private tick(): void {
		if (this.controller.signal.aborted) return;
		const pending = this.pending(); const ids = new Set(pending); const now = performance.now();
		for (const key of this.retryAt.keys()) if (!ids.has(key) && !this.running.has(key)) { this.retryAt.delete(key); this.reported.delete(key); }
		for (const conversationId of pending) {
			if (this.running.size >= this.concurrency) break;
			if (this.running.has(conversationId) || (this.retryAt.get(conversationId) ?? 0) > now) continue;
			const operation = Promise.resolve().then(() => this.reconcile(conversationId, this.controller.signal)).then(() => {
				this.retryAt.delete(conversationId); this.reported.delete(conversationId);
			}).catch((error: unknown) => {
				this.retryAt.set(conversationId, performance.now() + this.retryMs);
				if (this.controller.signal.aborted) return;
				const signature = (error instanceof Error ? `${error.name}:${error.message}` : "unknown").slice(0, 512);
				if (this.reported.get(conversationId) !== signature) {
					this.reported.set(conversationId, signature);
					try { this.report(conversationId, error); } catch { /* Diagnostics cannot lose durable work. */ }
				}
			}).finally(() => { this.running.delete(conversationId); });
			this.running.set(conversationId, operation);
		}
	}
	async close(): Promise<void> {
		this.controller.abort(); if (this.timer) clearInterval(this.timer);
		await Promise.allSettled([...this.running.values()]);
	}
}
