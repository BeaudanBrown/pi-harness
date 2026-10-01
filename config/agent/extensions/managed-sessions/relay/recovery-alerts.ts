import { createHash } from "node:crypto";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { AtomicJsonFile } from "./atomic-json.js";

const text = Type.String({ minLength: 1, maxLength: 512 });
const TargetSchema = Type.Object({ conversationId: text, piSessionId: text, roomId: text }, { additionalProperties: false });
const TicketSchema = Type.Object({ target: TargetSchema, epoch: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }), checked: Type.Boolean() }, { additionalProperties: false });
const AlertSchema = Type.Object({ ticket: TicketSchema, attentionId: text, sourceId: text, body: text, sent: Type.Boolean() }, { additionalProperties: false });
const StateSchema = Type.Object({ version: Type.Literal(1), epoch: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }), down: Type.Boolean(),
	tickets: Type.Array(TicketSchema, { maxItems: 4096 }), alerts: Type.Array(AlertSchema, { maxItems: 4096 }),
}, { additionalProperties: false });
export type RecoveryTarget = Static<typeof TargetSchema>;
export type RecoveryTicket = Static<typeof TicketSchema>;
export type RecoveryAlert = Static<typeof AlertSchema>;
type State = Static<typeof StateSchema>;
function parse(value: unknown): State {
	if (!Check(StateSchema, value)) throw new Error("Invalid recovery alert state");
	if (value.tickets.some((ticket) => ticket.epoch !== value.epoch) ||
		new Set(value.tickets.map((ticket) => ticket.target.conversationId)).size !== value.tickets.length ||
		new Set(value.alerts.map((alert) => `${alert.ticket.epoch}:${alert.ticket.target.conversationId}`)).size !== value.alerts.length ||
		value.alerts.some((alert) => !alert.ticket.checked || alert.ticket.epoch > value.epoch || alert.sourceId !== sourceId(alert.ticket))) {
		throw new Error("Conflicting recovery alert state");
	}
	return value;
}
function sourceId(ticket: RecoveryTicket): string {
	return `recovery:${createHash("sha256").update(JSON.stringify([ticket.epoch, ticket.target.conversationId, ticket.target.piSessionId, ticket.target.roomId])).digest("hex")}`;
}

/** One durable selection per conversation/outage. No session reading or process wake. */
export class RecoveryAlerts {
	private state: State = { version: 1, epoch: 0, down: false, tickets: [], alerts: [] };
	private work: Promise<void> = Promise.resolve();
	private draining?: Promise<void>;
	private readonly file: AtomicJsonFile<State>;
	constructor(path: string, private readonly send: (alert: RecoveryAlert) => Promise<void>) { this.file = new AtomicJsonFile(path, parse); }
	async load(): Promise<void> { this.state = await this.file.read() ?? this.state; }
	async outage(targets: RecoveryTarget[]): Promise<void> {
		await this.mutate((state) => {
			if (state.down) return;
			state.down = true; state.epoch++;
			state.tickets = targets.map((target) => ({ target, epoch: state.epoch, checked: false }));
			// Accepted, uncertain sends survive later epochs. Completed sends cannot recur.
			state.alerts = state.alerts.filter((alert) => !alert.sent);
		});
	}
	async healthy(): Promise<void> { await this.mutate((state) => { state.down = false; }); }
	pending(): RecoveryTicket[] { return this.state.down ? [] : structuredClone(this.state.tickets.filter((ticket) => !ticket.checked)); }

	/** A freshly accepted original checkpoint already occupies the notification slot. */
	async originalAccepted(conversationId: string, piSessionId: string): Promise<void> {
		await this.mutate((state) => {
			const ticket = state.tickets.find((item) => item.target.conversationId === conversationId && item.target.piSessionId === piSessionId);
			if (ticket) ticket.checked = true;
		});
	}
	/** Caller must obtain fresh adapter evidence; absence of an adapter is NOT a null answer. */
	async confirm(ticket: RecoveryTicket, attentionId: string | null, stillCurrent: () => boolean): Promise<void> {
		await this.mutate((state) => {
			const current = state.tickets.find((item) => item.target.conversationId === ticket.target.conversationId);
			if (state.down || state.epoch !== ticket.epoch || !current || current.checked ||
				JSON.stringify(current.target) !== JSON.stringify(ticket.target) || !stillCurrent()) return;
			current.checked = true;
			if (attentionId === null) return;
			if (state.alerts.some((alert) => !alert.sent && alert.attentionId === attentionId &&
				alert.ticket.target.conversationId === ticket.target.conversationId && alert.ticket.target.piSessionId === ticket.target.piSessionId)) return;
			state.alerts.push({ ticket: structuredClone(current), attentionId, sourceId: sourceId(current),
				body: "Connection recovered. This conversation still has a checkpoint awaiting your response.", sent: false });
		});
	}
	/** Frozen payloads are retried, never reclassified using later liveness or expiry. */
	drain(): Promise<void> {
		if (this.draining) return this.draining;
		this.draining = (async () => {
			const rooms = new Map<string, RecoveryAlert[]>();
			for (const alert of this.state.alerts.filter((item) => !item.sent)) {
				const room = rooms.get(alert.ticket.target.conversationId) ?? [];
				room.push(alert); rooms.set(alert.ticket.target.conversationId, room);
			}
			const pending = [...rooms.values()]; let index = 0; let failures = 0;
			await Promise.all(Array.from({ length: Math.min(8, pending.length) }, async () => {
				while (!this.state.down && index < pending.length) {
					for (const alert of pending[index++]!) {
						if (this.state.down) break;
						try {
							await this.send(structuredClone(alert));
							await this.mutate((state) => { const saved = state.alerts.find((item) => item.sourceId === alert.sourceId); if (saved) saved.sent = true; });
						} catch { failures++; break; }
					}
				}
			}));
			if (failures) throw new Error("Recovery alerts retained for retry");
		})().finally(() => { this.draining = undefined; });
		return this.draining;
	}
	async close(): Promise<void> { await this.draining?.catch(() => undefined); await this.work; }
	private mutate(change: (state: State) => void): Promise<void> {
		const next = this.work.then(async () => { const state = structuredClone(this.state); change(state); await this.file.write(state); this.state = state; });
		this.work = next.catch(() => undefined); return next;
	}
}
