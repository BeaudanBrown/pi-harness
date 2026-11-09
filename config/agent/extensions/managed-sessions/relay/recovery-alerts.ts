import { createHash } from "node:crypto";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { AtomicJsonFile } from "./atomic-json.js";

const text = Type.String({ minLength: 1, maxLength: 512 });
const TargetSchema = Type.Object({ conversationId: text, piSessionId: text, roomId: text }, { additionalProperties: false });
const TicketSchema = Type.Object({ target: TargetSchema, epoch: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }), checked: Type.Boolean() }, { additionalProperties: false });
const legacyFields = { ticket: TicketSchema, attentionId: text, sourceId: text, body: text, sent: Type.Boolean() };
const LegacyAlertSchema = Type.Object(legacyFields, { additionalProperties: false });
const AlertSchema = Type.Object({ ...legacyFields, attempted: Type.Boolean(), suppressed: Type.Boolean() }, { additionalProperties: false });
const OriginalSchema = Type.Object({ conversationId: text, piSessionId: text, attentionId: text }, { additionalProperties: false });
const HistorySchema = Type.Object({ at: Type.String(), conversationId: text, attentionId: text,
	event: Type.Union([Type.Literal("selected"), Type.Literal("original_owned"), Type.Literal("duplicate_suppressed"), Type.Literal("obsolete_suppressed"), Type.Literal("attempted"), Type.Literal("delivered")]),
}, { additionalProperties: false });
const common = { epoch: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }), down: Type.Boolean(), tickets: Type.Array(TicketSchema, { maxItems: 4096 }) };
const LegacySchema = Type.Object({ version: Type.Literal(1), ...common, alerts: Type.Array(LegacyAlertSchema, { maxItems: 4096 }) }, { additionalProperties: false });
const StateSchema = Type.Object({ version: Type.Literal(2), ...common, alerts: Type.Array(AlertSchema, { maxItems: 4096 }),
	originals: Type.Array(OriginalSchema, { maxItems: 4096 }), history: Type.Array(HistorySchema, { maxItems: 128 }),
}, { additionalProperties: false });
export type RecoveryTarget = Static<typeof TargetSchema>;
export type RecoveryTicket = Static<typeof TicketSchema>;
export type RecoveryAlert = Static<typeof AlertSchema>;
type State = Static<typeof StateSchema>;
export type AttentionEvidence = "current" | "obsolete" | "unknown";
function legacySourceId(ticket: RecoveryTicket): string {
	return `recovery:${createHash("sha256").update(JSON.stringify([ticket.epoch, ticket.target.conversationId, ticket.target.piSessionId, ticket.target.roomId])).digest("hex")}`;
}
function sourceId(ticket: RecoveryTicket, attentionId: string): string {
	return `attention:${createHash("sha256").update(JSON.stringify([ticket.target.conversationId, ticket.target.piSessionId, ticket.target.roomId, attentionId, "recovery"])).digest("hex")}`;
}
function parse(value: unknown): State {
	if (Check(LegacySchema, value)) {
		if (value.alerts.some(alert => alert.sourceId !== legacySourceId(alert.ticket))) throw Error("Conflicting legacy recovery identity");
		// Legacy unsent records may already have reached Matrix. Never re-key or cancel them.
		value = { ...value, version: 2, alerts: value.alerts.map(alert => ({ ...alert, attempted: true, suppressed: false })), originals: [], history: [] };
	}
	if (!Check(StateSchema, value)) throw new Error("Invalid attention delivery state (or receipt capacity exceeded)");
	if (value.tickets.some(ticket => ticket.epoch !== value.epoch) ||
		new Set(value.tickets.map(ticket => ticket.target.conversationId)).size !== value.tickets.length ||
		new Set(value.alerts.map(alert => alert.sourceId)).size !== value.alerts.length ||
		new Set(value.originals.map(item => JSON.stringify(item))).size !== value.originals.length ||
		value.alerts.some(alert => !alert.ticket.checked || alert.ticket.epoch > value.epoch ||
			(alert.sent && !alert.attempted) || (alert.suppressed && alert.attempted) ||
			![sourceId(alert.ticket, alert.attentionId), legacySourceId(alert.ticket)].includes(alert.sourceId))) {
		throw new Error("Conflicting attention delivery state");
	}
	return value;
}

/** Durable attention-delivery policy owner. Transport epochs never own notification identity.
 * The monitor supplies evidence; the projector retains ownership of Matrix transactions.
 * Receipts are bounded and never silently evicted to make a duplicate possible. */
export class RecoveryAlerts {
	private state: State = { version: 2, epoch: 0, down: false, tickets: [], alerts: [], originals: [], history: [] };
	private work: Promise<void> = Promise.resolve();
	private draining?: Promise<void>;
	private readonly file: AtomicJsonFile<State>;
	constructor(path: string, private readonly send: (alert: RecoveryAlert) => Promise<void>, private readonly now = () => new Date().toISOString()) { this.file = new AtomicJsonFile(path, parse); }
	async load(): Promise<void> { this.state = await this.file.read() ?? this.state; }
	async outage(targets: RecoveryTarget[]): Promise<void> {
		await this.mutate(state => {
			if (state.down) return;
			state.down = true; state.epoch++;
			state.tickets = targets.map(target => ({ target, epoch: state.epoch, checked: false }));
		});
	}
	async healthy(): Promise<void> { if (this.state.down) await this.mutate(state => { state.down = false; }); }
	pending(): RecoveryTicket[] { return this.state.down ? [] : structuredClone(this.state.tickets.filter(ticket => !ticket.checked)); }

	/** The original notifying projection owns delivery, even if its acknowledgement is uncertain. */
	async originalAccepted(conversationId: string, piSessionId: string, attentionId?: string): Promise<void> {
		await this.mutate(state => {
			const ticket = state.tickets.find(item => item.target.conversationId === conversationId && item.target.piSessionId === piSessionId);
			if (ticket) ticket.checked = true;
			if (attentionId && !state.originals.some(item => item.conversationId === conversationId && item.piSessionId === piSessionId && item.attentionId === attentionId)) {
				state.originals.push({ conversationId, piSessionId, attentionId });
				this.record(state, conversationId, attentionId, "original_owned");
			}
		});
	}
	/** Fresh adapter evidence is required. Absence of an adapter is not a null answer. */
	async confirm(ticket: RecoveryTicket, attentionId: string | null, stillCurrent: () => boolean): Promise<void> {
		await this.mutate(state => {
			const current = state.tickets.find(item => item.target.conversationId === ticket.target.conversationId);
			if (state.down || state.epoch !== ticket.epoch || !current || current.checked ||
				JSON.stringify(current.target) !== JSON.stringify(ticket.target) || !stillCurrent()) return;
			current.checked = true;
			if (attentionId === null) return;
			const { conversationId, piSessionId } = ticket.target;
			if (state.originals.some(item => item.conversationId === conversationId && item.piSessionId === piSessionId && item.attentionId === attentionId) ||
				state.alerts.some(alert => alert.attentionId === attentionId && alert.ticket.target.conversationId === conversationId && alert.ticket.target.piSessionId === piSessionId)) {
				this.record(state, conversationId, attentionId, "duplicate_suppressed"); return;
			}
			state.alerts.push({ ticket: structuredClone(current), attentionId, sourceId: sourceId(current, attentionId),
				body: "Connection recovered. This conversation still has a question or host approval awaiting your response.", sent: false, attempted: false, suppressed: false });
			this.record(state, conversationId, attentionId, "selected");
		});
	}
	/** Only never-attempted intents can be suppressed; uncertain sends retain frozen identity. */
	drain(evidence?: (alert: RecoveryAlert) => Promise<AttentionEvidence>): Promise<void> {
		if (this.draining) return this.draining;
		this.draining = (async () => {
			const rooms = new Map<string, RecoveryAlert[]>();
			for (const alert of this.state.alerts.filter(item => !item.sent && !item.suppressed)) {
				const room = rooms.get(alert.ticket.target.conversationId) ?? [];
				room.push(alert); rooms.set(alert.ticket.target.conversationId, room);
			}
			const pending = [...rooms.values()]; let index = 0; let failures = 0;
			await Promise.all(Array.from({ length: Math.min(8, pending.length) }, async () => {
				while (!this.state.down && index < pending.length) {
					for (const alert of pending[index++]!) {
						if (this.state.down) break;
						try {
							if (!alert.attempted) {
								const result = evidence ? await evidence(structuredClone(alert)) : "current";
								if (result === "unknown" || this.state.down) break;
								await this.mutate(state => {
									const saved = state.alerts.find(item => item.sourceId === alert.sourceId)!;
									if (result === "obsolete") saved.suppressed = true; else saved.attempted = true;
									this.record(state, alert.ticket.target.conversationId, alert.attentionId, result === "obsolete" ? "obsolete_suppressed" : "attempted");
								});
								if (result === "obsolete") continue;
							}
							const saved = this.state.alerts.find(item => item.sourceId === alert.sourceId)!;
							await this.send(structuredClone(saved));
							await this.mutate(state => {
								state.alerts.find(item => item.sourceId === alert.sourceId)!.sent = true;
								this.record(state, alert.ticket.target.conversationId, alert.attentionId, "delivered");
							});
						} catch { failures++; break; }
					}
				}
			}));
			if (failures) throw new Error("Attention deliveries retained for retry");
		})().finally(() => { this.draining = undefined; });
		return this.draining;
	}
	explain(conversationId: string) {
		return structuredClone({ receipts: this.state.alerts.filter(alert => alert.ticket.target.conversationId === conversationId).slice(-8).map(alert => ({
			attentionId: alert.attentionId, sessionId: alert.ticket.target.piSessionId,
			state: alert.sent ? "delivered" as const : alert.suppressed ? "suppressed" as const : alert.attempted ? "uncertain" as const : "selected" as const,
		})), originals: this.state.originals.filter(item => item.conversationId === conversationId).slice(-8).map(item => ({ attentionId: item.attentionId, sessionId: item.piSessionId })),
			history: this.state.history.filter(item => item.conversationId === conversationId).slice(-16) });
	}
	async close(): Promise<void> { await this.draining?.catch(() => undefined); await this.work; }
	private record(state: State, conversationId: string, attentionId: string, event: Static<typeof HistorySchema>["event"]): void {
		state.history.push({ at: this.now(), conversationId, attentionId, event }); state.history = state.history.slice(-128);
	}
	private mutate(change: (state: State) => void): Promise<void> {
		const next = this.work.then(async () => { const state = structuredClone(this.state); change(state); await this.file.write(state); this.state = state; });
		this.work = next.catch(() => undefined); return next;
	}
}
