import { matrixDelay } from "../../matrix-shared/http.js";
import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { deriveConversationId } from "../contracts.js";
import { accountActionIdentity } from "../live-workspace-contracts.js";
import { HostAccountClient, type AccountActionBody } from "./host-account-client.js";
import type { LiveHierarchy, HierarchySpaceIdentity } from "./live-hierarchy.js";
import type { RelayRegistry } from "./registry.js";
import type { ManagedMatrixClient } from "./matrix-client.js";
import type { ArchiveHierarchy } from "./archive-hierarchy.js";
import type { RetirementAccountPort } from "./conversation-retirement.js";

export type MembershipRestore = { conversationId: string; roomId: string; hostSpaceId: string; departureEventId: string; operatorUserId: string; botUserId: string };
type CleanupTarget = Parameters<RetirementAccountPort["leaveAndForget"]>[0] | HierarchySpaceIdentity;
/** Translates only host-owned identities; never accepts model-provided Matrix targets. */
export class HostAccountOwner {
	private readonly stop = new AbortController();
	private work?: Promise<void>;
	start(retire: (id: string) => Promise<unknown>): void {
		if (this.work) return;
		this.work = (async () => {
			while (!this.stop.signal.aborted) {
				try { await this.provision(); } catch { /* New setup failure does not starve existing cleanup. */ }
				try {
					for (const action of this.client.departed()) {
						if (action.operation !== "room.ensure" || action.kind !== "conversation" || !action.conversationId) continue;
						const manifest = this.registry.manifestByConversationId(action.conversationId);
						if (manifest?.kind === "project" && manifest.roomId === action.roomId) { await retire(action.conversationId); break; }
					}
					await this.client.flush(this.stop.signal);
				} catch { /* Exact pending intents survive; account outages do not stop local Pi. */ }
				await matrixDelay(3000, this.stop.signal).catch(() => {});
			}
		})();
	}
	async close(): Promise<void> { this.stop.abort(); await this.client.close(); await this.work; }
	constructor(readonly client: HostAccountClient, private readonly registry: RelayRegistry, private readonly matrix: ManagedMatrixClient, private readonly hierarchy?: LiveHierarchy, private readonly archives?: Pick<ArchiveHierarchy, "accountBaseline" | "accountInventory">) {}
	async initialize(): Promise<void> {
		await this.client.load();
		await this.client.initializeBaseline([...(this.hierarchy?.accountBaseline() ?? []), ...(this.archives?.accountBaseline() ?? []), ...this.registry.listManifests().map(m => `${m.kind === "coordinator" ? "coordinator" : "conversation"}:${m.creationKey}`)]);
	}
	private coordinator() { return this.registry.manifestByConversationId(deriveConversationId(this.registry.hostId, "coordinator")); }
	async provision(): Promise<void> {
		const coordinator = this.coordinator(); const actions: AccountActionBody[] = [];
		if (coordinator?.hostSpace) {
			actions.push({ operation: "room.ensure", kind: "host_space", roomId: coordinator.hostSpace, hostSpaceId: coordinator.hostSpace, creationKey: "host", notificationSetup: "preserve" });
			actions.push({ operation: "room.ensure", kind: "coordinator", roomId: coordinator.roomId, hostSpaceId: coordinator.hostSpace,
				conversationId: coordinator.conversationId, creationKey: coordinator.creationKey, notificationSetup: this.client.notificationSetup("coordinator", coordinator.creationKey) });
		}
		for (const node of [...this.hierarchy?.accountInventory() ?? [], ...this.archives?.accountInventory() ?? []]) {
			if (!node.roomId || !node.hostSpaceId) continue;
			const proof = node.provenance;
			actions.push({ operation: "room.ensure", kind: proof.kind, roomId: node.roomId, hostSpaceId: node.hostSpaceId, creationKey: proof.creationKey,
				...("archiveRootSpaceId" in node && typeof node.archiveRootSpaceId === "string" ? { archiveRootSpaceId: node.archiveRootSpaceId } : {}),
				...(node.project ? { project: node.project } : {}), ...(node.checkout ? { checkout: node.checkout } : {}),
				...("conversationId" in proof ? { conversationId: proof.conversationId } : {}), notificationSetup: node.preserveNotificationPolicy ? "preserve" : this.client.notificationSetup(proof.kind, proof.creationKey) });
		}
		await this.client.cancelRetired(id => Boolean(this.registry.retirement(id) || this.registry.archiveRecord(id)));
		await this.client.requestMany(actions);
	}
	async freezeMembership(): Promise<MembershipRestore> {
		const coordinator = this.coordinator(); if (!coordinator?.hostSpace) throw Error("Protected coordinator is unavailable");
		const signal = AbortSignal.any([this.stop.signal, AbortSignal.timeout(10000)]);
		await this.matrix.assertManagedProvenance(coordinator.roomId, { version: 1, hostId: this.registry.hostId, kind: "coordinator", creationKey: coordinator.creationKey, conversationId: coordinator.conversationId, parentRoomId: coordinator.hostSpace }, signal);
		const member = await this.matrix.operatorMembershipEvent(coordinator.roomId, signal);
		if (member.membership !== "leave" || member.sender !== this.matrix.operatorUserId) throw Error("Coordinator has no current deliberate operator departure");
		return { conversationId: coordinator.conversationId, roomId: coordinator.roomId, hostSpaceId: coordinator.hostSpace, departureEventId: member.eventId, operatorUserId: this.matrix.operatorUserId, botUserId: this.matrix.botUserId };
	}
	async restoreMembership(plan: MembershipRestore): Promise<{ conversationId: string; setupState: "pending" | "ready" }> {
		if (!isDeepStrictEqual(plan, await this.freezeMembership())) throw Error("Coordinator membership scope changed; obtain fresh consent");
		const action = await this.client.request({ operation: "coordinator.membership.restore", roomId: plan.roomId, conversationId: plan.conversationId, hostSpaceId: plan.hostSpaceId, departureEventId: plan.departureEventId });
		// This is the admitted caller attempt, not background model mutation replay.
		// A lost invitation reply is uncertain; NAS can still observe an accepted invite.
		if (!isDeepStrictEqual(plan, await this.freezeMembership())) throw Error("Coordinator departure changed before invitation");
		await this.matrix.inviteOperator(plan.roomId, AbortSignal.any([this.stop.signal, AbortSignal.timeout(10000)]));
		return { conversationId: plan.conversationId, setupState: this.client.ack(action.requestId)?.status === "complete" ? "ready" : "pending" };
	}
	private cleanup(target: CleanupTarget): AccountActionBody {
		if ("provenance" in target) {
			if (target.operatorUserId !== this.matrix.operatorUserId || target.botUserId !== this.matrix.botUserId || target.provenance.hostId !== this.registry.hostId || !["project_space", "worktree_space"].includes(target.provenance.kind)) throw Error("Account cleanup scope changed");
			const hostSpaceId = this.coordinator()?.hostSpace; if (!hostSpaceId || hostSpaceId === target.roomId) throw Error("Account cleanup host authority unavailable");
			const cleanupId = "effectId" in target ? target.effectId : `cleanup_${createHash("sha256").update(JSON.stringify([this.registry.hostId, target.roomId, target.provenance, target.operatorUserId, target.botUserId])).digest("hex").slice(0, 32)}`;
			return { operation: "space.retire", roomId: target.roomId, hostSpaceId, cleanupId };
		}
		if (target.kind !== "operator_leave_forget" || target.userId !== this.matrix.operatorUserId) throw Error("Account cleanup actor changed");
		const record = this.registry.pendingRetirements().find(r => r.cleanup?.some(e => e.effectId === target.effectId && e.kind === "operator_leave_forget" && e.roomId === target.roomId && e.userId === target.userId));
		if (!record) throw Error("Account cleanup retirement authority unavailable");
		return { operation: "room.retire", roomId: target.roomId, conversationId: record.conversationId, retirementId: record.retirementId };
	}
	async leaveAndForget(target: CleanupTarget, signal: AbortSignal): Promise<boolean> {
		signal.throwIfAborted(); const action = await this.client.request(this.cleanup(target));
		return this.client.ack(action.requestId)?.status === "complete";
	}
	async completed(target: CleanupTarget, signal: AbortSignal): Promise<boolean> {
		signal.throwIfAborted(); const body = { ...this.cleanup(target), version: "1.0.0", hostId: this.registry.hostId };
		return this.client.ack(accountActionIdentity(body).requestId)?.status === "complete";
	}
}
