import { randomUUID } from "node:crypto";
import { MANAGED_SESSION_PROTOCOL_VERSION, type ManagedSessionEnvelope } from "../contracts.js";
import { HOST_CONTROL_VERSION, parseHostAction, type HostActor } from "../live-workspace-contracts.js";
import { parseHostRunWitness } from "../host-run-contracts.js";
import type { AcceptedAttachment } from "./registry.js";
import type { HostDispatcher } from "./host-dispatcher.js";
import type { HostApprovals } from "./host-approvals.js";
import type { HostApprovalRecord, ModelHostRequest } from "./host-approval-record.js";
import { HostControlError, hostErrorResponse } from "./host-control-error.js";
import { resolveHostRunActor, type AcceptedHostInputOrigin } from "./host-run-origin.js";
import { HostRunProofs } from "./host-run-proofs.js";

type ModelActor = Extract<HostActor, { kind: "model" }>;
type Dialog = { attachment: AcceptedAttachment; actor: ModelActor; finish(choice?: boolean): void };
/** Authenticated IPC frontend: caller fields never select human authority or the approval room. */
export class HostAdapterControls {
	readonly proofs: HostRunProofs;
	private readonly dialogs = new Map<string, Dialog>();
	private closed = false;
	constructor(private readonly options: {
		attachment(conversationId: string): AcceptedAttachment | undefined;
		capable(conversationId: string): boolean;
		send(envelope: ManagedSessionEnvelope): boolean;
		room(conversationId: string): string | undefined;
		acceptedInput(conversationId: string, deliveryId: string): AcceptedHostInputOrigin | undefined;
		dispatcher: HostDispatcher;
		approvals: Pick<HostApprovals, "cancelRun" | "observeRun">;
	}) { this.proofs = new HostRunProofs(options); }

	private async actor(input: { conversationId: string; generationId: string; runId: string; toolCallId: string; requestId: string }): Promise<ModelActor> {
		return resolveHostRunActor({ ...input, witness: await this.proofs.request(input.conversationId), roomId: this.options.room(input.conversationId),
			acceptedInput: (deliveryId) => this.options.acceptedInput(input.conversationId, deliveryId) });
	}
	async isLive(request: ModelHostRequest): Promise<boolean> {
		if (this.closed) return false;
		try {
			const actor = await this.actor(request.actor);
			return actor.presentation === request.actor.presentation && (actor.presentation === "local_dialog" ||
				request.actor.presentation === "matrix_poll" && actor.origin.roomId === request.actor.origin.roomId && actor.origin.eventId === request.actor.origin.eventId && actor.origin.senderUserId === request.actor.origin.senderUserId);
		} catch { return false; }
	}

	/** Must be called only after the IPC server validates peer UID, attachment nonce and negotiated capability. */
	async handle(envelope: ManagedSessionEnvelope, attachment: AcceptedAttachment): Promise<ManagedSessionEnvelope | undefined> {
		if (!envelope.type.startsWith("host.")) return undefined;
		const response = (type: string, payload: Record<string, unknown>): ManagedSessionEnvelope => ({ protocolVersion: MANAGED_SESSION_PROTOCOL_VERSION,
			role: "relay", messageId: `host-reply-${randomUUID()}`, conversationId: attachment.conversationId, inReplyTo: envelope.messageId, type, payload });
		if (envelope.type === "host.run.confirm") this.proofs.confirm(envelope, attachment);
		else if (envelope.type === "host.run.observe") this.options.approvals.observeRun(attachment.conversationId, parseHostRunWitness(envelope.payload.witness));
		else if (envelope.type === "host.approval.answer") {
			const dialog = this.dialogs.get(String(envelope.payload.approvalId)); const value = envelope.payload;
			if (dialog && dialog.attachment.attachmentId === attachment.attachmentId && dialog.attachment.conversationId === attachment.conversationId &&
				this.options.attachment(attachment.conversationId)?.attachmentId === attachment.attachmentId &&
				dialog.actor.generationId === value.generationId && dialog.actor.runId === value.runId && dialog.actor.toolCallId === value.toolCallId &&
				(value.choice === "approve" || value.choice === "deny" || value.choice === "unavailable")) dialog.finish(value.choice === "unavailable" ? undefined : value.choice === "approve");
		} else if (envelope.type === "host.request") {
			const action = parseHostAction(envelope.payload.action); const requestId = String(envelope.payload.requestId);
			try {
				if (this.closed) throw new HostControlError("unavailable", "Host approvals are stopping");
				const actor = await this.actor({ conversationId: attachment.conversationId, generationId: String(envelope.payload.generationId),
					runId: String(envelope.payload.runId), toolCallId: String(envelope.payload.toolCallId), requestId });
				return response("host.result", { operation: action.operation, response: await this.options.dispatcher.dispatch({ version: HOST_CONTROL_VERSION, actor, action }, actor) });
			} catch (error) { return response("host.result", { operation: action.operation, response: hostErrorResponse(requestId, error) }); }
		} else return undefined;
		return response("host.acknowledge", {});
	}

	confirmLocal(record: HostApprovalRecord, question: string, signal: AbortSignal): Promise<boolean> {
		const actor = record.request.actor; const attachment = this.options.attachment(actor.conversationId);
		if (this.closed || signal.aborted || !attachment || !this.options.capable(actor.conversationId) || actor.presentation !== "local_dialog" ||
			this.dialogs.has(record.approvalId) || this.dialogs.size >= 64 || record.expiresAt <= Date.now()) return Promise.reject(new HostControlError("cancelled", "Native approval is unavailable"));
		return new Promise((resolve, reject) => {
			const finish = (choice?: boolean) => {
				if (!this.dialogs.delete(record.approvalId)) return;
				clearTimeout(timer); signal.removeEventListener("abort", abort);
				try { this.options.send({ protocolVersion: MANAGED_SESSION_PROTOCOL_VERSION, role: "relay", messageId: `host-close-${randomUUID()}`, conversationId: actor.conversationId,
					type: "host.approval.close", payload: { approvalId: record.approvalId } }); } catch { /* Disconnected UI cannot revive consent. */ }
				if (choice === undefined) reject(new HostControlError("cancelled", "Native approval is no longer pending")); else resolve(choice);
			};
			const abort = () => finish(); const timer = setTimeout(abort, record.expiresAt - Date.now());
			this.dialogs.set(record.approvalId, { attachment: structuredClone(attachment), actor: structuredClone(actor), finish }); signal.addEventListener("abort", abort, { once: true });
			try {
				if (!this.options.send({ protocolVersion: MANAGED_SESSION_PROTOCOL_VERSION, role: "relay", messageId: `host-dialog-${randomUUID()}`, conversationId: actor.conversationId,
					type: "host.approval.show", payload: { approvalId: record.approvalId, generationId: actor.generationId, runId: actor.runId, toolCallId: actor.toolCallId, question, expiresAt: record.expiresAt } })) finish();
			} catch { finish(); }
		});
	}
	disconnected(attachment: AcceptedAttachment): void {
		this.proofs.disconnected(attachment);
		const current = this.options.attachment(attachment.conversationId);
		if (!current || current.attachmentId === attachment.attachmentId) this.options.approvals.cancelRun(attachment.conversationId);
		for (const dialog of this.dialogs.values()) if (dialog.attachment.attachmentId === attachment.attachmentId) dialog.finish();
	}
	close(): void { this.closed = true; this.proofs.close(); for (const dialog of this.dialogs.values()) dialog.finish(); }
}
