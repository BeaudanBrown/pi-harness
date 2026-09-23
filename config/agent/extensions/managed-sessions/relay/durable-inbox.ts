import { AtomicJsonFile } from "./atomic-json.js";

type Job = { id: string; conversationId: string; response: unknown };
type State = { version: 1; lastBatch: string | null; jobs: Job[] };
const MAX_BYTES = 16 * 1024 * 1024;
function parse(value: unknown): State {
	const state = value as State;
	if (!state || state.version !== 1 || Object.keys(state).some((key) => !["version", "lastBatch", "jobs"].includes(key)) ||
		(state.lastBatch !== null && typeof state.lastBatch !== "string") || !Array.isArray(state.jobs) || state.jobs.length > 4096 ||
		state.jobs.some((job) => !job || typeof job.id !== "string" || typeof job.conversationId !== "string" || !job.response || typeof job.response !== "object" || Object.keys(job).some((key) => !["id", "conversationId", "response"].includes(key))) ||
		new Set(state.jobs.map((job) => job.id)).size !== state.jobs.length || Buffer.byteLength(JSON.stringify(state)) > MAX_BYTES) throw new Error("Invalid or full managed inbox; sync cursor retained");
	return state;
}

/** Disk acceptance precedes the Matrix cursor. Room workers never hold the writer across I/O. */
export class DurableInbox {
	private state: State = { version: 1, lastBatch: null, jobs: [] };
	private work: Promise<void> = Promise.resolve();
	private readonly running = new Map<string, Promise<void>>();
	private readonly retryAt = new Map<string, number>();
	private stopped = false;
	private timer?: NodeJS.Timeout;
	private readonly file: AtomicJsonFile<State>;
	constructor(path: string, private readonly deliver: (conversationId: string, response: unknown) => Promise<void>,
		private readonly diagnostic: (message: string) => void, private readonly retryMs = 5_000) { this.file = new AtomicJsonFile(path, parse); }
	async load(): Promise<void> { this.state = await this.file.read() ?? this.state; }
	hasPending(conversationId: string): boolean { return this.state.jobs.some((job) => job.conversationId === conversationId); }
	start(): void { this.timer = setInterval(() => this.drain(), this.retryMs); this.timer.unref(); this.drain(); }
	async accept(batch: string, jobs: Array<Omit<Job, "id">>): Promise<void> {
		await this.mutate((state) => {
			if (state.lastBatch === batch) return;
			state.jobs.push(...jobs.map((job, index) => ({ ...job, id: `${batch}:${index}` })));
			state.lastBatch = batch;
		});
		this.drain();
	}
	private drain(): void {
		if (this.stopped) return;
		for (const job of this.state.jobs) {
			if (this.running.size >= 8) break;
			if (this.running.has(job.conversationId) || (this.retryAt.get(job.conversationId) ?? 0) > Date.now()) continue;
			const run = this.deliver(job.conversationId, job.response).then(async () => {
				await this.mutate((state) => { state.jobs = state.jobs.filter((item) => item.id !== job.id); });
				this.retryAt.delete(job.conversationId);
			}).catch((error) => {
				this.retryAt.set(job.conversationId, Date.now() + this.retryMs);
				this.diagnostic(`inbox ${job.conversationId}: ${error instanceof Error ? error.message : "delivery failed"}`);
			}).finally(() => { this.running.delete(job.conversationId); this.drain(); });
			this.running.set(job.conversationId, run);
		}
	}
	async close(): Promise<void> { this.stopped = true; clearInterval(this.timer); await Promise.all(this.running.values()); }
	private mutate(change: (state: State) => void): Promise<void> {
		const result = this.work.then(async () => { const next = structuredClone(this.state); change(next); await this.file.write(next); this.state = next; });
		this.work = result.catch(() => undefined); return result;
	}
}
