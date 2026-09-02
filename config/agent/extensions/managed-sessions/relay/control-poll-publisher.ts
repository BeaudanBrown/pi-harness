import { deriveMatrixTransactionId, type HostRuntimeState } from "../contracts.js";
import { ManagedMatrixClient } from "./matrix-client.js";
import { RelayRegistry } from "./registry.js";

type RuntimeConversation = HostRuntimeState["conversations"][number];
type PendingControl = RuntimeConversation["pendingControls"][number];
type PollOption = { answerId: string; command: string };

export interface ControlPollPublication {
	conversationId: string;
	roomId: string;
	sourceControl: PendingControl;
	scope: "model" | "thinking";
	prompt: string;
	options: PollOption[];
}

/** Persists the complete Matrix PUT intent and resolves uncertain PUTs with the same transaction. */
export class ControlPollPublisher {
	constructor(
		private readonly registry: RelayRegistry,
		private readonly matrix: ManagedMatrixClient,
		private readonly afterMatrixAcceptance: () => void | Promise<void> = () => undefined,
	) {}

	async publish(publication: ControlPollPublication): Promise<void> {
		const intent = {
			sourceControl: structuredClone(publication.sourceControl),
			scope: publication.scope,
			transactionId: deriveMatrixTransactionId(publication.conversationId, publication.sourceControl.controlId, 0),
			prompt: publication.prompt,
			options: structuredClone(publication.options),
		};
		const state = await this.registry.beginControlPollPublication(publication.conversationId, intent);
		if (state === "active") return;
		await this.publishIntent(publication.conversationId, publication.roomId, intent);
	}

	async reconcile(): Promise<void> {
		for (const { conversationId, intent } of this.registry.publishingControlPolls()) {
			const manifest = this.registry.manifestByConversationId(conversationId);
			if (!manifest) throw new Error("Publishing control poll has no managed conversation");
			await this.publishIntent(conversationId, manifest.roomId, intent);
		}
	}

	private async publishIntent(conversationId: string, roomId: string,
		intent: NonNullable<RuntimeConversation["publishingControlPoll"]>): Promise<void> {
		const pollEventId = await this.matrix.startPoll(roomId, intent.transactionId, intent.prompt,
			intent.options.map((option) => ({ id: option.answerId, text: option.command })), undefined, "stable");
		await this.afterMatrixAcceptance();
		await this.registry.completeControlPollPublication(conversationId, intent.sourceControl.controlId, pollEventId);
	}
}
