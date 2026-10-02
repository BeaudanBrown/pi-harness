import type { HostAction } from "../live-workspace-contracts.js";
import type { ManagedSessionEnvelope } from "../contracts.js";
import type { AcceptedAttachment } from "./registry.js";
import type { ManagedMatrixClient } from "./matrix-client.js";
import type { AcceptedHostInputOrigin } from "./host-run-origin.js";
import type { FrozenHostEffects, HostApprovalRecord, ModelHostRequest } from "./host-approval-record.js";
import { HostApprovalStore } from "./host-approval-store.js";
import { HostApprovalPrompts } from "./host-approval-prompts.js";
import { HostApprovals } from "./host-approvals.js";
import { HostAdapterControls } from "./host-adapter-controls.js";
import { HostDispatcher, type HostReadRequest } from "./host-dispatcher.js";
import type { HostPolicy } from "./host-policy.js";

/** Operation owners freeze and enforce their own preconditions at execution admission. */
export interface HostMutationOwner {
	freeze(request: ModelHostRequest): Promise<FrozenHostEffects>;
	revalidate(record: HostApprovalRecord): Promise<boolean>;
	execute(record: HostApprovalRecord): Promise<unknown>;
}

/** Composition of the existing consent, presentation and authenticated IPC owners. */
export class HostApprovalRuntime {
	readonly dispatcher: HostDispatcher;
	readonly controls: HostAdapterControls;
	private readonly approvals: HostApprovals;
	private readonly prompts: HostApprovalPrompts;
	constructor(private readonly options: {
		hostId: string; protectedConversationId: string; policy: HostPolicy; store: HostApprovalStore;
		operatorUserIds: ReadonlySet<string>;
		notificationDisposition?: () => "silent" | "notify";
		onNotifyingPoll?: (record: HostApprovalRecord) => Promise<void>;
		matrix: Pick<ManagedMatrixClient, "startPoll" | "endPoll" | "memberJoined" | "checkpointPollAnswer">;
		owner: HostMutationOwner;
		read(request: HostReadRequest): Promise<unknown>;
		launch?: (action: Extract<HostAction, { operation: "conversation.open" | "conversation.resume" }>) => Promise<unknown>;
		attachment(conversationId: string): AcceptedAttachment | undefined;
		capable(conversationId: string): boolean;
		send(envelope: ManagedSessionEnvelope): boolean;
		room(conversationId: string): string | undefined;
		acceptedInput(conversationId: string, deliveryId: string): AcceptedHostInputOrigin | undefined;
	}) {
		this.prompts = new HostApprovalPrompts({ matrix: options.matrix, operatorUserIds: options.operatorUserIds,
			confirmLocal: (record, question, signal) => this.controls.confirmLocal(record, question, signal) });
		this.approvals = new HostApprovals({ ...options,
			isLive: (request) => this.controls.isLive(request),
			freeze: (request) => options.owner.freeze(request),
			present: async (record) => {
				const presentation = await this.prompts.present(record);
				try {
					if (record.request.actor.presentation === "matrix_poll" && (record.notificationDisposition ?? "notify") === "notify") await options.onNotifyingPoll?.(record);
					return presentation;
				} catch (error) { await presentation.close().catch(() => undefined); throw error; }
			},
			revalidate: (record) => options.owner.revalidate(record),
			execute: (record) => options.owner.execute(record) });
		this.dispatcher = new HostDispatcher({ ...options, approve: (request) => this.approvals.request(request) });
		this.controls = new HostAdapterControls({ ...options, dispatcher: this.dispatcher, approvals: this.approvals });
	}

	handle(envelope: ManagedSessionEnvelope, attachment: AcceptedAttachment): Promise<ManagedSessionEnvelope | undefined> {
		return this.controls.handle(envelope, attachment);
	}
	vote(input: Parameters<HostApprovalPrompts["vote"]>[0]): Promise<boolean> { return this.prompts.vote(input); }
	disconnected(attachment: AcceptedAttachment): void { this.controls.disconnected(attachment); }
	cancelRun(conversationId: string, runId?: string): void { this.approvals.cancelRun(conversationId, runId); }
	async recoveryAttention(conversationId: string): Promise<{ id: string; stillCurrent: () => boolean } | undefined> {
		const attention = await this.approvals.recoveryAttention(conversationId);
		if (!attention || !this.prompts.isPending(attention.id)) return undefined;
		return { id: attention.id, stillCurrent: () => attention.stillCurrent() && this.prompts.isPending(attention.id) };
	}
	recover(): ReturnType<HostApprovals["recover"]> { return this.approvals.recover(); }
	async close(): Promise<void> {
		this.controls.close();
		await this.approvals.close();
		await this.options.store.close();
	}
}
