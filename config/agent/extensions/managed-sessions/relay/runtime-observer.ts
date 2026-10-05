import type { ExactWindowProof } from "../exact-window-contracts.js";
import { MAX_EXACT_OBSERVATIONS, type ExactWindowClient } from "./exact-window-client.js";

/** Private host metadata only: no histories, input queues, credentials or paths. */
export interface RuntimeObservationSource {
	hostId: string; conversationId: string; generationId: string; piSessionId: string;
	attached: boolean; attachmentId?: string; state: "starting" | "active" | "dormant";
	launch?: { launchId: string; generationId: string }; window?: ExactWindowProof;
	failed: boolean; transitioning: boolean; managedWindow: boolean;
}
export interface RuntimeObservation {
	runtimeState: "running" | "stopped" | "unknown";
	launchState: "none" | "prepared" | "window_created" | "attached" | "failed";
}
const key = (source: RuntimeObservationSource): string => JSON.stringify(source);
const launchState = (source: RuntimeObservationSource): RuntimeObservation["launchState"] => source.failed ? "failed" : source.attached ? "attached" : source.window ? "window_created" : source.launch ? "prepared" : "none";

/** Disposable presentation cache, never lifecycle authority. No work runs on a prompt lane. */
export class HostRuntimeObserver {
	private readonly cache = new Map<string, { key: string; at: number; state: RuntimeObservation["runtimeState"] }>();
	private work?: Promise<void>;
	private dirty = false;
	private closed = false;
	private stopTimer?: () => void;
	private unsubscribe?: () => void;
	private readonly now: () => number;
	constructor(private readonly options: {
		hostId: string; sources: () => RuntimeObservationSource[]; windows: Pick<ExactWindowClient, "observe">;
		subscribe?: (changed: () => void) => () => void;
		now?: () => number; every?: (milliseconds: number, callback: () => void) => () => void;
	}) { this.now = options.now ?? (() => performance.now()); }
	start(): void {
		if (this.closed || this.stopTimer) return;
		this.unsubscribe = this.options.subscribe?.(() => this.kick());
		this.stopTimer = (this.options.every ?? ((ms, callback) => { const timer = setInterval(callback, ms); timer.unref(); return () => clearInterval(timer); }))(10_000, () => this.kick());
		this.kick();
	}
	kick(): void {
		if (this.closed) return;
		this.dirty = true;
		if (this.work) return;
		this.work = Promise.resolve().then(async () => {
			while (this.dirty && !this.closed) {
				this.dirty = false;
				try { await this.collect(); } catch { this.cache.clear(); }
			}
		}).finally(() => { this.work = undefined; if (this.dirty && !this.closed) this.kick(); });
	}
	async settled(): Promise<void> { while (this.work) await this.work; }
	async close(): Promise<void> {
		this.closed = true; this.stopTimer?.(); this.unsubscribe?.(); await this.work; this.cache.clear();
	}
	/** One cheap source snapshot per caller, with revalidation against the current epoch. */
	snapshot(): Map<string, RuntimeObservation> {
		const rows = this.options.sources().filter(row => row.hostId === this.options.hostId);
		const now = this.now();
		return new Map(rows.map(row => {
			const saved = this.cache.get(row.conversationId);
			const fresh = !this.closed && saved && saved.key === key(row) && now >= saved.at && now - saved.at < 20_000;
			return [row.conversationId, { runtimeState: fresh && !(row.failed && saved.state === "running") ? saved.state : "unknown", launchState: launchState(row) }];
		}));
	}
	private async collect(): Promise<void> {
		const sources = this.options.sources().filter(row => row.hostId === this.options.hostId);
		if (sources.length > 4_096 || new Set(sources.map(row => row.conversationId)).size !== sources.length) throw Error("Runtime observation capacity or identity invalid");
		const next = new Map<string, { key: string; at: number; state: RuntimeObservation["runtimeState"] }>();
		const owned: RuntimeObservationSource[] = [];
		for (const row of sources) {
			next.set(row.conversationId, { key: key(row), at: this.now(), state: "unknown" });
			if (row.transitioning) continue;
			if (row.window) {
				if (row.launch?.generationId === row.generationId && row.launch.launchId === row.window.launchId && row.window.conversationId === row.conversationId) owned.push(row);
			} else if (!row.managedWindow && !row.launch && row.attached && row.state === "active") {
				// An ordinary local adapter can be live without a host-owned tmux window.
				next.get(row.conversationId)!.state = "running";
			}
		}
		for (let start = 0; start < owned.length && !this.closed; start += MAX_EXACT_OBSERVATIONS) {
			const batch = owned.slice(start, start + MAX_EXACT_OBSERVATIONS);
			const at = this.now();
			try {
				const observations = await this.options.windows.observe(batch.map(row => row.window!));
				for (const observation of observations) {
					const saved = next.get(observation.conversationId)!;
					saved.at = at; saved.state = observation.state;
				}
			} catch { /* Unsupported launcher, outage or malformed response stays unknown. */ }
		}
		if (this.closed) return;
		const current = new Map(this.options.sources().filter(row => row.hostId === this.options.hostId).map(row => [row.conversationId, key(row)]));
		this.cache.clear();
		for (const [id, value] of next) if (current.get(id) === value.key) this.cache.set(id, value);
	}
}
