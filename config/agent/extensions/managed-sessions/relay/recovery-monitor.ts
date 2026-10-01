import { randomUUID } from "node:crypto";
import { deriveTranscriptEntryId, MANAGED_SESSION_PROTOCOL_VERSION, type ManagedSessionEnvelope } from "../contracts.js";
import { type AcceptedAttachment, RelayRegistry } from "./registry.js";
import { ManagedSessionIpcServer } from "./ipc-server.js";
import { RecoveryAlerts, type RecoveryTicket } from "./recovery-alerts.js";

type Evidence = { ready: boolean; checkpointId: string | null };
type Probe = { conversationId: string; attachmentId: string; finish: (evidence?: Evidence) => void };

/** Queries attached adapters only. Never invokes lifecycle launch, session I/O or a model turn. */
export class RecoveryMonitor {
	private readonly probes = new Map<string, Probe>();
	private timer?: NodeJS.Timeout;
	private running?: Promise<void>;
	private stopped = false;
	constructor(private readonly alerts: RecoveryAlerts, private readonly registry: RelayRegistry,
		private readonly server: ManagedSessionIpcServer, private readonly backlogPending: (conversationId: string) => boolean,
		private readonly diagnostic: (message: string) => void, private readonly timeoutMs = 5_000) {}
	async health(healthy: boolean): Promise<void> {
		if (healthy) await this.alerts.healthy();
		else await this.alerts.outage(this.registry.listManifests().map(({ conversationId, piSessionId, roomId }) => ({ conversationId, piSessionId, roomId })));
	}
	start(): void { this.timer = setInterval(() => { void this.tick().catch(() => this.diagnostic("Recovery attention retained for retry")); }, 5_000); this.timer.unref(); }
	confirm(envelope: ManagedSessionEnvelope, attachment: AcceptedAttachment): void {
		const requestId = String(envelope.payload.requestId);
		const probe = this.probes.get(requestId);
		if (!probe || probe.conversationId !== attachment.conversationId || probe.attachmentId !== attachment.attachmentId) return;
		probe.finish({ ready: envelope.payload.ready === true, checkpointId: envelope.payload.checkpointId as string | null });
	}
	tick(): Promise<void> {
		if (this.stopped) return Promise.resolve();
		if (this.running) return this.running;
		this.running = (async () => {
			const tickets = this.alerts.pending(); let index = 0;
			await Promise.all(Array.from({ length: Math.min(8, tickets.length) }, async () => {
				while (!this.stopped && index < tickets.length) {
					await this.check(tickets[index++]!).catch(() => this.diagnostic("Recovery check retained for retry"));
				}
			}));
			if (!this.stopped) await this.alerts.drain();
		})().finally(() => { this.running = undefined; });
		return this.running;
	}
	private attachmentId(conversationId: string): string | undefined {
		return this.registry.snapshot().conversations.find((item) => item.conversationId === conversationId)?.attachment?.attachmentId;
	}
	private async check(ticket: RecoveryTicket): Promise<void> {
		const { conversationId, piSessionId } = ticket.target;
		const manifest = this.registry.manifestByConversationId(conversationId);
		if (!manifest || manifest.piSessionId !== piSessionId) { await this.alerts.confirm(ticket, null, () => true); return; }
		if (this.backlogPending(conversationId) || !this.server.supports(conversationId, "recovery-attention-v1")) return;
		const attachmentId = this.attachmentId(conversationId);
		if (!attachmentId) return;
		const requestId = `recovery-${randomUUID()}`;
		const evidence = await new Promise<Evidence | undefined>((resolve) => {
			const timer = setTimeout(() => finish(), this.timeoutMs); timer.unref();
			const finish = (value?: Evidence) => { clearTimeout(timer); this.probes.delete(requestId); resolve(value); };
			this.probes.set(requestId, { conversationId, attachmentId, finish });
			if (!this.server.sendToConversation({ protocolVersion: MANAGED_SESSION_PROTOCOL_VERSION, messageId: requestId,
				conversationId, role: "relay", type: "recovery.check", payload: { requestId } })) finish();
		});
		if (!evidence?.ready || this.stopped) return;
		const stillCurrent = () => this.attachmentId(conversationId) === attachmentId &&
			this.server.supports(conversationId, "recovery-attention-v1") &&
			this.registry.manifestByConversationId(conversationId)?.piSessionId === piSessionId &&
			!this.backlogPending(conversationId) && this.checkpointCurrent(ticket, evidence.checkpointId);
		await this.alerts.confirm(ticket, evidence.checkpointId, stillCurrent);
	}
	private checkpointCurrent(ticket: RecoveryTicket, checkpointId: string | null): boolean {
		if (checkpointId === null) return true;
		const { conversationId, piSessionId } = ticket.target;
		const entryId = deriveTranscriptEntryId(piSessionId, `checkpoint:${checkpointId}`);
		const projection = this.registry.snapshot().conversations.find((item) => item.conversationId === conversationId)?.projection.find((item) => item.entryId === entryId && item.kind === "checkpoint");
		if (projection?.status !== "projected" || !projection.originDeliveryId) return false;
		const inputs = this.registry.pendingInputs(conversationId);
		const origin = inputs.findIndex((item) => item.deliveryId === projection.originDeliveryId);
		return origin === inputs.length - 1 && origin >= 0 && inputs[origin]!.status === "completed";
	}
	async close(): Promise<void> {
		this.stopped = true; clearInterval(this.timer);
		for (const probe of [...this.probes.values()]) probe.finish();
		await this.running?.catch(() => undefined); await this.alerts.close();
	}
}
