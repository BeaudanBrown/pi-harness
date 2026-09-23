import { AtomicJsonFile } from "./atomic-json.js";
import { RelayRegistryError } from "./registry.js";

export type Notice = { conversationId: string; sourceId: string; piSessionId: string; roomId: string; body: string; sent: boolean; blocked?: true };
type State = { version: 1; notices: Notice[] };
function parse(value: unknown): State {
	const state = value as State;
	if (!state || state.version !== 1 || Object.keys(state).some((key) => !["version", "notices"].includes(key)) || !Array.isArray(state.notices) || state.notices.length > 4096 ||
		state.notices.some((item) => !item || ["conversationId", "sourceId", "piSessionId", "roomId", "body"].some((key) => typeof item[key as keyof Notice] !== "string") || typeof item.sent !== "boolean" || (item.blocked !== undefined && item.blocked !== true) || Object.keys(item).some((key) => !["conversationId", "sourceId", "piSessionId", "roomId", "body", "sent", "blocked"].includes(key))) ||
		new Set(state.notices.map((item) => JSON.stringify([item.conversationId, item.sourceId]))).size !== state.notices.length || Buffer.byteLength(JSON.stringify(state)) > 16 * 1024 * 1024) throw new Error("Invalid or full managed notice outbox");
	return state;
}

/** Freeze notice identity/content before any PUT; lifecycle success never depends on delivery. */
export class NoticeOutbox {
	private state: State = { version: 1, notices: [] };
	private work: Promise<void> = Promise.resolve();
	private readonly running = new Map<Notice, Promise<void>>();
	private timer?: NodeJS.Timeout;
	private stopped = false;
	private readonly file: AtomicJsonFile<State>;
	constructor(path: string, private readonly send: (notice: Notice) => Promise<void>, private readonly diagnostic: (message: string) => void) { this.file = new AtomicJsonFile(path, parse); }
	async load(): Promise<void> { this.state = await this.file.read() ?? this.state; }
	start(): void { this.timer = setInterval(() => this.drain(), 5_000); this.timer.unref(); this.drain(); }
	async enqueue(notice: Omit<Notice, "sent">): Promise<void> {
		if (this.stopped) throw new Error("Notice outbox is shutting down; retry after reconnect");
		await this.mutate((state) => {
			if (!state.notices.some((item) => item.conversationId === notice.conversationId && item.sourceId === notice.sourceId)) state.notices.push({ ...notice, sent: false });
		});
		this.drain();
	}
	private drain(): void {
		if (this.stopped) return;
		const busy = new Set([...this.running.keys()].map((item) => item.conversationId));
		for (const notice of this.state.notices) {
			if (this.running.size >= 8) break;
			if (notice.sent || notice.blocked || busy.has(notice.conversationId)) continue;
			busy.add(notice.conversationId);
			let succeeded = false;
			const run = this.send(notice).then(async () => {
				await this.mutate((state) => {
					const saved = state.notices.find((item) => item.conversationId === notice.conversationId && item.sourceId === notice.sourceId)!; saved.sent = true;
				});
				succeeded = true;
			}).catch(async (error) => {
				if (error instanceof RelayRegistryError && error.code === "invalid_state") {
					await this.mutate((state) => { state.notices.find((item) => item.conversationId === notice.conversationId && item.sourceId === notice.sourceId)!.blocked = true; });
					succeeded = true; // Isolate the conflict, never rewrite its identity or block later notices.
				}
				this.diagnostic(`notice ${notice.conversationId}: ${error instanceof Error ? error.message : "delivery failed"}`);
			})
				.finally(() => { this.running.delete(notice); if (succeeded) this.drain(); });
			this.running.set(notice, run);
		}
	}
	async close(): Promise<void> { this.stopped = true; clearInterval(this.timer); await Promise.all(this.running.values()); await this.work; }
	private mutate(change: (state: State) => void): Promise<void> {
		const result = this.work.then(async () => { const next = structuredClone(this.state); change(next); await this.file.write(next); this.state = next; });
		this.work = result.catch(() => undefined); return result;
	}
}
