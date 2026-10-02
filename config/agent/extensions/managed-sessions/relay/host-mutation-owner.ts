import { isDeepStrictEqual } from "node:util";
import type { HostAction } from "../live-workspace-contracts.js";
import type { FrozenHostEffects, FrozenJson, HostApprovalRecord, ModelHostRequest } from "./host-approval-record.js";
import type { HostMutationOwner } from "./host-approval-runtime.js";
import type { HostLifecycle } from "./host-lifecycle.js";
import type { RelayRegistry } from "./registry.js";
import type { ManagedSessionIpcServer } from "./ipc-server.js";
import type { ConversationRetirement, RetirementPlan } from "./conversation-retirement.js";
import { HostControlError } from "./host-control-error.js";

const detached = (value: unknown): FrozenJson => JSON.parse(JSON.stringify(value)) as FrozenJson;

/** Private frozen owner data, not additional model-controlled arguments or replay receipts. */
export class ManagedHostMutationOwner implements HostMutationOwner {
	constructor(private readonly options: { registry: RelayRegistry; lifecycle: HostLifecycle; retirement: ConversationRetirement; server: Pick<ManagedSessionIpcServer, "attachment"> }) {}

	private target(conversationId: string): FrozenJson {
		const { registry } = this.options;
		if (registry.retirement(conversationId)) throw new HostControlError("retired", "Conversation is permanently retired");
		const manifest = registry.manifestByConversationId(conversationId);
		if (!manifest) throw new HostControlError("not_found", "Managed conversation was not found");
		return detached({ conversationId, kind: manifest.kind, generationId: registry.activeGeneration(manifest).generationId,
			placement: manifest.placement ?? null, piSessionId: manifest.piSessionId, roomId: manifest.roomId,
			attachmentId: this.options.server.attachment(conversationId)?.attachmentId ?? null, window: registry.managedWindow(conversationId),
			launch: registry.launchIdentity(conversationId) ?? null });
	}

	async freeze(request: ModelHostRequest): Promise<FrozenHostEffects> {
		const action = request.action;
		switch (action.operation) {
			case "conversation.open":
			case "conversation.resume":
			case "conversation.stop":
				return { effects: [action], preconditions: { target: this.target(action.conversationId) } };
			case "conversation.delete":
				return { effects: [action], preconditions: { retirement: detached(this.options.retirement.prepare(action.conversationId)) } };
			default: throw new HostControlError("upgrade_required", "This host mutation owner is not available yet");
		}
	}

	async revalidate(record: HostApprovalRecord): Promise<boolean> {
		try { return isDeepStrictEqual(await this.freeze(record.request), record.frozen); }
		catch { return false; }
	}

	async execute(record: HostApprovalRecord): Promise<unknown> {
		const action = record.request.action;
		if (!isDeepStrictEqual(record.frozen.effects, [action])) throw new HostControlError("stale_preview", "Frozen effects changed");
		if (action.operation === "conversation.delete") {
			const plan = record.frozen.preconditions.retirement as unknown as RetirementPlan;
			if (!plan || plan.conversationId !== action.conversationId) throw new HostControlError("stale_preview", "Frozen retirement target changed");
			// The retirement owner validates the frozen targets at terminal commit;
			// never discover/expand targets again after consent.
			const retired = await this.options.retirement.retirePrepared(plan);
			return { conversationId: action.conversationId, retirementId: retired.retirementId,
				cleanupState: !retired.cleanup ? "complete" : retired.cleanup.some((effect) => effect.phase === "blocked") ? "failed" : "pending" };
		}
		if (!["conversation.open", "conversation.resume", "conversation.stop"].includes(action.operation)) {
			throw new HostControlError("upgrade_required", "This host mutation owner is not available yet");
		}
		const target = action as Extract<HostAction, { operation: "conversation.open" | "conversation.resume" | "conversation.stop" }>;
		// This synchronous recheck and admission have no intervening await. The
		// lifecycle acquires its operation slot and captures its exact stop target.
		if (!isDeepStrictEqual(this.target(target.conversationId), record.frozen.preconditions.target)) throw new HostControlError("stale_preview", "Approved target changed before execution");
		if (target.operation === "conversation.open") return this.options.lifecycle.openConversation(target.conversationId);
		if (target.operation === "conversation.resume") return this.options.lifecycle.resumeConversation(target.conversationId);
		await this.options.lifecycle.request({ protocolVersion: "1.0.0", messageId: record.approvalId,
			conversationId: record.request.actor.conversationId, role: "coordinator_adapter", type: "lifecycle.request",
			payload: { request: { operation: "conversation.stop", targetConversationId: target.conversationId } } });
		return { conversationId: target.conversationId, runtimeState: "stopped" };
	}
}
