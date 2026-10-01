import { randomUUID } from "node:crypto";
import { MANAGED_SESSION_PROTOCOL_VERSION, type ManagedSessionEnvelope } from "../contracts.js";
import { parseHostRunWitness, type HostRunWitness } from "../host-run-contracts.js";
import { deriveGenerationId } from "../v2-contracts.js";
import type { AcceptedAttachment } from "./registry.js";

type Pending = { attachment: AcceptedAttachment; finish(witness: HostRunWitness | null): void };

/** Only nonce-authenticated IPC intake may call confirm. Observations never substitute for a fresh challenge. */
export class HostRunProofs {
	private readonly pending = new Map<string, Pending>();
	private closed = false;
	constructor(private readonly options: {
		attachment(conversationId: string): AcceptedAttachment | undefined;
		capable(conversationId: string): boolean;
		send(envelope: ManagedSessionEnvelope): boolean;
		timeoutMs?: number;
	}) {
		if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 5000)) throw Error("Invalid proof timeout");
	}

	request(conversationId: string): Promise<HostRunWitness | null> {
		if (this.closed || this.pending.size >= 64 || !this.options.capable(conversationId)) return Promise.resolve(null);
		const current = this.options.attachment(conversationId); if (!current) return Promise.resolve(null);
		const attachment = structuredClone(current); const checkId = randomUUID();
		return new Promise((resolve) => {
			const timer = setTimeout(() => finish(null), this.options.timeoutMs ?? 5000);
			const finish = (witness: HostRunWitness | null) => { clearTimeout(timer); this.pending.delete(checkId); resolve(witness); };
			this.pending.set(checkId, { attachment, finish });
			try {
				if (!this.options.send({ protocolVersion: MANAGED_SESSION_PROTOCOL_VERSION, role: "relay", conversationId, messageId: `host-proof-${randomUUID()}`,
					type: "host.run.check", payload: { checkId } })) finish(null);
			} catch { finish(null); }
		});
	}

	confirm(envelope: ManagedSessionEnvelope, attachment: AcceptedAttachment): boolean {
		if (envelope.type !== "host.run.confirm" || envelope.conversationId !== attachment.conversationId) return false;
		const pending = this.pending.get(String(envelope.payload.checkId));
		if (!pending || !sameAttachment(pending.attachment, attachment) || !sameAttachment(attachment, this.options.attachment(attachment.conversationId))) return false;
		let witness: HostRunWitness | null;
		try { witness = envelope.payload.witness === null ? null : parseHostRunWitness(envelope.payload.witness); } catch { return false; }
		if (witness && witness.generationId !== deriveGenerationId(attachment.conversationId, attachment.generation)) return false;
		pending.finish(witness); return true;
	}

	disconnected(attachment: AcceptedAttachment): void {
		for (const pending of this.pending.values()) if (sameAttachment(pending.attachment, attachment)) pending.finish(null);
	}
	close(): void { this.closed = true; for (const pending of this.pending.values()) pending.finish(null); }
}

function sameAttachment(left: AcceptedAttachment, right: AcceptedAttachment | undefined): boolean {
	return Boolean(right && left.attachmentId === right.attachmentId && left.conversationId === right.conversationId && left.generation === right.generation && left.role === right.role);
}
