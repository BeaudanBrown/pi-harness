import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { ConversationIdSchema } from "../identity-contracts.js";
import { ConversationTitleSchema, TitleRevisionSchema, TITLE_STATE_EVENT, conversationTitle, parseConversationTitle, type ConversationTitle } from "../title-contracts.js";
import { AtomicJsonFile } from "./atomic-json.js";
import type { RelayRegistry } from "./registry.js";
import type { RuntimeObservation } from "./runtime-observer.js";

const strict = <T extends Record<string, any>>(fields: T) => Type.Object(fields, { additionalProperties: false });
const text = (n: number) => Type.String({ minLength: 1, maxLength: n });
const writeSchema = strict({ id: text(64), name: text(132), revision: TitleRevisionSchema });
const schema = strict({ version: Type.Literal(1), hostId: text(128), conversationId: ConversationIdSchema,
	title: ConversationTitleSchema, revision: TitleRevisionSchema, serial: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
	roomId: Type.Optional(text(255)), lastPrefix: Type.Optional(Type.Union([Type.Literal("● "), Type.Literal("○ ")])), initialized: Type.Boolean(), needRead: Type.Boolean(), knownName: Type.Optional(Type.String({ maxLength: 4096 })),
	adapter: Type.Optional(strict({ sessionId: text(128), sequence: TitleRevisionSchema, title: Type.String({ maxLength: 4096 }) })),
	seen: Type.Array(text(255), { maxItems: 8192, uniqueItems: true }), writes: Type.Array(writeSchema, { maxItems: 4096 }),
	pending: Type.Optional(text(64)), retryAt: Type.Number({ minimum: 0 }),
});
interface Row extends ConversationTitle {
	version: 1; hostId: string; conversationId: string; serial: number; roomId?: string; lastPrefix?: "● " | "○ "; initialized: boolean; needRead: boolean; knownName?: string;
	adapter?: { sessionId: string; sequence: number; title: string }; seen: string[]; writes: Array<{ id: string; name: string; revision: number }>; pending?: string; retryAt: number;
}
export interface MatrixNameEvent { event_id: string; sender: string; type: "m.room.name"; state_key: ""; content: { name?: string; [TITLE_STATE_EVENT]?: string } }
export function parseMatrixNameEvent(value: unknown): MatrixNameEvent {
	const event = value as MatrixNameEvent;
	if (!event || event.type !== "m.room.name" || event.state_key !== "" || typeof event.event_id !== "string" || !/^\$\S{1,254}$/.test(event.event_id) ||
		typeof event.sender !== "string" || !/^@\S{1,254}$/.test(event.sender) || !event.content || typeof event.content !== "object" || Array.isArray(event.content) ||
		(event.content.name !== undefined && (typeof event.content.name !== "string" || event.content.name.length > 4096))) throw Error("Invalid Matrix name observation");
	return event;
}
function parseRow(value: unknown): Row {
	if (!Check(schema, value)) throw Error("Invalid title journal");
	const row = value as Row; parseConversationTitle({ title: row.title, revision: row.revision });
	if (new Set(row.writes.map(item => item.id)).size !== row.writes.length || row.pending && !row.writes.some(item => item.id === row.pending) ||
		Buffer.byteLength(JSON.stringify(row)) > 4 * 1024 * 1024) throw Error("Invalid title journal capacity or pending write");
	return row;
}

function statusPrefix(runtime: RuntimeObservation | undefined, lastPrefix?: string, knownName?: string): string {
	return runtime?.launchState === "failed" ? "○ " : runtime?.runtimeState === "running" ? "● " : runtime?.runtimeState === "stopped" ? "○ " : lastPrefix ?? /^[●○] /u.exec(knownName ?? "")?.[0] ?? "";
}

/** Title metadata journal, not a model action/receipt store. Network work never owns the admission lane. */
export class ConversationTitles {
	private readonly lanes = new Map<string, Promise<unknown>>();
	private readonly active = new Set<Promise<void>>();
	private readonly busy = new Set<string>();
	private timer?: NodeJS.Timeout;
	private closed = false;
	private cursor = 0;
	private readonly refresh = new Set<string>();
	private readonly initialized = new Set<string>();
	private readonly baselined = new Set<string>();
	private readonly failures = new Set<string>();
	private readonly lastName = new Map<string, string | undefined>();
	private readonly lastPrefix = new Map<string, string | undefined>();
	private nextWrite = 0;
	private readonly now: () => number;
	constructor(private readonly options: {
		root: string; hostId: string; botUserId: string;
		registry: Pick<RelayRegistry, "titleInventory" | "updateConversationTitle">;
		runtime: () => ReadonlyMap<string, RuntimeObservation>;
		readName: (roomId: string, signal: AbortSignal) => Promise<MatrixNameEvent | undefined>;
		writeName: (roomId: string, name: string, writeId: string, signal: AbortSignal) => Promise<string>;
		changed: (conversationId: string, value: ConversationTitle) => void;
		now?: () => number; ready?: () => boolean;
	}) { this.now = options.now ?? Date.now; }
	private source(id: string) {
		const source = this.options.registry.titleInventory().find(row => row.conversationId === id);
		if (!source) throw Error("Title target is unavailable or retired");
		return source;
	}
	private file(id: string): AtomicJsonFile<Row> {
		if (!Check(ConversationIdSchema, id)) throw Error("Invalid title target");
		return new AtomicJsonFile(join(this.options.root, `${id}.json`), parseRow);
	}
	private async load(id: string): Promise<Row> {
		const source = this.source(id); const file = this.file(id);
		try { const info = await lstat(file.path); if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024 || info.mode & 0o077 || process.getuid && info.uid !== process.getuid()) throw Error("Unsafe title journal"); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		const saved = await file.read();
		if (saved) {
			if (saved.hostId !== this.options.hostId || saved.conversationId !== id || saved.roomId && saved.roomId !== source.roomId || (source.titleRevision ?? 0) > saved.revision) throw Error("Title authority changed; explicit recovery required");
			return saved;
		}
		if (source.titleRevision !== undefined) throw Error("Title journal missing; explicit recovery required");
		return { version: 1, hostId: this.options.hostId, conversationId: id,
			title: conversationTitle(source.concept, id, new Set(this.options.registry.titleInventory().filter(row => row.conversationId !== id).map(row => row.title ?? row.concept))),
			revision: 1, serial: 0, initialized: false, needRead: true, seen: [], writes: [], retryAt: 0, ...(source.roomId ? { roomId: source.roomId } : {}) };
	}
	private lane<T>(id: string, work: (row: Row) => Promise<T>): Promise<T> {
		const prior = this.lanes.get(id) ?? Promise.resolve();
		const next = prior.catch(() => undefined).then(async () => work(await this.load(id)));
		this.lanes.set(id, next);
		void next.finally(() => { if (this.lanes.get(id) === next) this.lanes.delete(id); }).catch(() => undefined);
		return next;
	}
	private async save(row: Row): Promise<void> {
		const source = this.source(row.conversationId);
		if (row.roomId && row.roomId !== source.roomId) throw Error("Title room changed");
		if (source.roomId) row.roomId = source.roomId;
		if (row.serial >= Number.MAX_SAFE_INTEGER) throw Error("Title revision capacity exhausted");
		row.serial++;
		await this.file(row.conversationId).write(row); // Accepted metadata before portable projection.
		if (source.titleRevision !== row.revision || source.title !== row.title) await this.options.registry.updateConversationTitle(row.conversationId, { title: row.title, revision: row.revision });
		this.lastName.set(row.conversationId, row.knownName); this.lastPrefix.set(row.conversationId, row.lastPrefix);
		this.options.changed(row.conversationId, { title: row.title, revision: row.revision });
	}
	private rename(row: Row, title: string): void {
		const next = conversationTitle(title, row.conversationId, new Set(this.options.registry.titleInventory().filter(item => item.conversationId !== row.conversationId).map(item => item.title ?? item.concept)));
		if (next !== row.title) { if (row.revision === Number.MAX_SAFE_INTEGER) throw Error("Title revision capacity exhausted"); row.title = next; row.revision++; }
	}
	private seen(row: Row, id: string): void { if (!row.seen.includes(id)) { if (row.seen.length >= 8192) throw Error("Title observation capacity exhausted"); row.seen.push(id); } }
	async read(id: string): Promise<ConversationTitle> {
		return this.lane(id, async row => { await this.save(row); return { title: row.title, revision: row.revision }; });
	}
	async observe(id: string, sessionId: string, sequence: number, title: string, current: () => boolean = () => true): Promise<ConversationTitle> {
		if (!Number.isSafeInteger(sequence) || sequence < 1 || title.length > 4096) throw Error("Invalid native title observation");
		return this.lane(id, async row => {
			if (!current() || this.source(id).sessionId !== sessionId) throw Error("Stale native title source");
			if (row.adapter?.sessionId === sessionId && row.adapter.sequence >= sequence) {
				if (row.adapter.sequence === sequence && row.adapter.title !== title) throw Error("Conflicting native title observation");
			} else { row.adapter = { sessionId, sequence, title }; this.rename(row, title); }
			await this.save(row); return { title: row.title, revision: row.revision };
		});
	}
	/** Accept the latest incremental human event after a current-state baseline.
	 * Initial history is only a wake-up. Presentation IO failure never blocks input;
	 * current room state is reread on restart/reconnect as well. */
	async ingest(response: unknown, initialSync = false): Promise<void> {
		const joined = (response as any)?.rooms?.join;
		if (!joined || typeof joined !== "object") return;
		for (const source of this.options.registry.titleInventory()) {
			if (!source.roomId || !Object.hasOwn(joined, source.roomId)) continue;
			const room = joined[source.roomId];
			const events = [...(Array.isArray(room?.state?.events) ? room.state.events : []), ...(Array.isArray(room?.timeline?.events) ? room.timeline.events : [])]
				.filter(event => event?.type === "m.room.name" && event?.state_key === "");
			if (!events.length) continue;
			try { await this.lane(source.conversationId, async row => {
				if (!events.some(event => !row.seen.includes(event.event_id))) return;
				const parsed = events.map(event => { try { return parseMatrixNameEvent(event); } catch { return undefined; } });
				const latest = parsed.filter((event): event is MatrixNameEvent => Boolean(event && event.sender !== this.options.botUserId)).at(-1);
				const baseline = !initialSync && this.baselined.has(source.conversationId);
				if (baseline && latest && latest.sender !== this.options.botUserId && !row.seen.includes(latest.event_id)) {
					this.rename(row, latest.content.name ?? "");
				}
				for (const event of parsed) if (event && (baseline || event !== latest)) this.seen(row, event.event_id);
				this.refresh.add(source.conversationId); row.needRead = true; await this.save(row);
			}); } catch { this.refresh.add(source.conversationId); this.failures.add(source.conversationId); }
		}
		this.kick();
	}
	status(id: string): "pending" | "ready" {
		if (this.failures.has(id) || this.refresh.has(id) || !this.initialized.has(id)) return "pending";
		const source = this.options.registry.titleInventory().find(row => row.conversationId === id);
		if (!source?.roomId) return "pending";
		const name = this.lastName.get(id);
		const prefix = statusPrefix(this.options.runtime().get(id), this.lastPrefix.get(id), name);
		return name === prefix + (source.title ?? source.concept) ? "ready" : "pending";
	}
	reconnect(): void { for (const source of this.options.registry.titleInventory()) this.refresh.add(source.conversationId); this.kick(); }
	start(): void { if (this.closed || this.timer) return; this.timer = setInterval(() => this.kick(), 1000); this.timer.unref(); this.kick(); }
	kick(): void {
		if (this.closed || this.options.ready?.() === false) return;
		let inventory; try { inventory = this.options.registry.titleInventory(); } catch { return; }
		for (let i = 0; i < inventory.length && this.busy.size < 4; i++) {
			const source = inventory[this.cursor++ % inventory.length]!;
			if (this.busy.has(source.conversationId)) continue;
			this.busy.add(source.conversationId);
			const work = this.reconcile(source.conversationId).catch(() => { this.failures.add(source.conversationId); }).finally(() => { this.busy.delete(source.conversationId); this.active.delete(work); });
			this.active.add(work);
		}
	}
	async settled(): Promise<void> { await Promise.all([...this.active]); }
	async close(): Promise<void> { this.closed = true; clearInterval(this.timer); await this.settled(); await Promise.allSettled([...this.lanes.values()]); }
	private async reconcile(id: string): Promise<void> {
		let captured = await this.lane(id, async row => {
			if (!this.initialized.has(id) || this.refresh.has(id)) { this.refresh.add(id); row.needRead = true; await this.save(row); }
			else { const source = this.source(id); if (source.titleRevision !== row.revision || source.title !== row.title) await this.options.registry.updateConversationTitle(id, { title: row.title, revision: row.revision }); }
			this.initialized.add(id); return row;
		});
		if (this.closed || !this.source(id).roomId || captured.retryAt > this.now()) return;
		try {
			if (!captured.initialized || captured.needRead || captured.pending) {
				const event = await this.options.readName(this.source(id).roomId!, AbortSignal.timeout(10_000));
				captured = await this.lane(id, async row => {
					if (row.serial !== captured.serial) return row;
					if (event) {
						parseMatrixNameEvent(event);
						if (!row.seen.includes(event.event_id) && event.sender !== this.options.botUserId) this.rename(row, event.content.name ?? "");
						const own = row.writes.find(item => item.id === event.content[TITLE_STATE_EVENT]);
						if (own && event.sender === this.options.botUserId && event.content.name !== own.name) throw Error("Conflicting own title event");
						this.seen(row, event.event_id); row.knownName = event.content.name ?? "";
						row.lastPrefix ??= /^[●○] /u.exec(row.knownName)?.[0] as Row["lastPrefix"];
					} else row.knownName = "";
					row.needRead = false; row.initialized = true; delete row.pending; await this.save(row); this.refresh.delete(id); this.failures.delete(id); this.baselined.add(id); return row;
				});
			}
			const prepared = await this.lane(id, async row => {
				if (this.closed || !row.initialized || row.needRead || row.pending || row.retryAt > this.now() || this.nextWrite > this.now()) return;
				const prefix = statusPrefix(this.options.runtime().get(id), row.lastPrefix, row.knownName);
				if (prefix && row.lastPrefix !== prefix) { row.lastPrefix = prefix as Row["lastPrefix"]; await this.save(row); }
				const name = prefix + row.title;
				if (name === row.knownName || this.nextWrite > this.now()) return;
				if (row.writes.length >= 4096) throw Error("Title write capacity exhausted");
				const write = { id: randomUUID(), name, revision: row.revision };
				row.writes.push(write); row.pending = write.id; row.retryAt = this.now() + 1000; this.nextWrite = this.now() + 200;
				await this.save(row); return { write, roomId: this.source(id).roomId! };
			});
			if (!prepared || this.closed) return;
			if (this.source(id).roomId !== prepared.roomId) throw Error("Title destination changed before send");
			const eventId = await this.options.writeName(prepared.roomId, prepared.write.name, prepared.write.id, AbortSignal.timeout(10_000));
			if (!/^\$\S{1,254}$/.test(eventId)) throw Error("Invalid title write acknowledgement");
			await this.lane(id, async row => {
				this.seen(row, eventId); row.knownName = prepared.write.name; if (row.pending === prepared.write.id) delete row.pending; await this.save(row);
			});
		} catch (error) {
			this.failures.add(id);
			await this.lane(id, async row => { row.needRead = true; row.retryAt = this.now() + Math.min(3_600_000, Math.max(1000, Number((error as any)?.retryAfterMs) || 5000)); await this.save(row); });
		}
	}
}
