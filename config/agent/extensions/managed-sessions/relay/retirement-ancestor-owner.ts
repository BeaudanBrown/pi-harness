import type { LiveHierarchy } from "./live-hierarchy.js";
import type { ManagedMatrixClient } from "./matrix-client.js";
import { parseRetirementRecord, type RetirementRecord } from "./retirement-store.js";
import { verifyRetirementAncestor, type RetirementAncestor } from "./retirement-ancestor.js";

type Matrix = Pick<ManagedMatrixClient, "botUserId" | "operatorUserId" | "assertManagedProvenance" | "assertRoomAuthority" | "spaceChildren" | "joinedMemberIds" | "removeSpaceChild" | "leaveRoom" | "accountJoined">;
type Hierarchy = Pick<LiveHierarchy, "withProjectCleanup" | "hasReferences" | "spaceRetirement" | "fenceSpace" | "completeSpace">;
export interface RetirementAncestorOwnerOptions {
	hostId: string; hostSpace(): string | undefined; matrix: Matrix; hierarchy: Hierarchy;
	retirement(conversationId: string): RetirementRecord | undefined;
	/** Registry bindings as well as any references outside the hierarchy reservation owner. */
	hasReferences(roomId: string): Promise<boolean>;
	operator: {
		/** Read-only confirmation of exact leave+forget; never sends a new mutation. */
		completed(target: RetirementAncestor, signal: AbortSignal): Promise<boolean>;
		/** Exact frozen account/Space operation; false means still pending, never success. */
		leaveAndForget(target: RetirementAncestor, signal: AbortSignal): Promise<boolean>;
	};
}

/** Executes only original ancestor obligations. New Space identities are owned by
 * explicit provisioning, not cleanup. Operator account transport belongs to #112. */
export class RetirementAncestorOwner {
	constructor(private readonly options: RetirementAncestorOwnerOptions) {}
	async run(conversationId: string, effectId: string, signal: AbortSignal): Promise<"done" | "pending" | "blocked"> {
		const first = this.record(conversationId);
		const candidate = first.cleanup?.find((effect) => effect.effectId === effectId);
		if (!first.cleanup) return "done";
		if (!candidate || candidate.kind !== "ancestor" || !("projectKey" in candidate.provenance)) throw Error("Ancestor obligation was not found");
		return this.options.hierarchy.withProjectCleanup(candidate.provenance.projectKey, async (scopeSignal) => {
			const active = AbortSignal.any([signal, scopeSignal]); active.throwIfAborted();
			const record = this.record(conversationId);
			if (!record.cleanup) return "done";
			const effect = record.cleanup.find((item) => item.effectId === effectId);
			if (!effect || effect.kind !== "ancestor") throw Error("Ancestor obligation changed");
			if (effect.phase === "done") return "done";
			const { matrix, hierarchy, operator } = this.options;
			const hostSpace = this.options.hostSpace();
			if (!hostSpace || effect.roomId === hostSpace || effect.botUserId !== matrix.botUserId || effect.operatorUserId !== matrix.operatorUserId) return "blocked";
			const fence = hierarchy.spaceRetirement(effect);
			if (fence === "done") return "done"; // Other original obligations may share the exact retired Space.
			if (fence && !await matrix.accountJoined(effect.roomId, active)) {
				// Lost final leave/completion response: observe completion without repeating an effect
				// whose fresh ownership can no longer be read after departure.
				if (!await operator.completed(effect, active)) return "pending";
				active.throwIfAborted(); return this.finish(effect, hostSpace, active);
			}
			if (effect.spaceKind === "project_space" && !record.cleanup.some((item) => item.kind === "ancestor" && item.spaceKind === "checkout_space" && item.roomId === effect.childRoomId && item.phase === "done")) return "pending";
			const references = async (roomId: string) => hierarchy.hasReferences(roomId, (id) => Boolean(this.options.retirement(id))) || await this.options.hasReferences(roomId);
			// Unlink only the retired child, even if siblings remain. Otherwise two retired
			// siblings would each wait forever for the other's link to disappear. Leaving the
			// ancestor itself still requires fresh emptiness and reference checks below.
			await matrix.assertManagedProvenance(effect.roomId, effect.provenance, active);
			await matrix.assertRoomAuthority(effect.roomId, true, active, { spaceChild: true });
			if (await references(effect.childRoomId)) return "blocked";
			if ((await matrix.spaceChildren(effect.roomId, active)).includes(effect.childRoomId)) {
				active.throwIfAborted(); await matrix.removeSpaceChild(effect.roomId, effect.childRoomId, active);
			}
			const eligible = () => verifyRetirementAncestor({ record, effectId, hostId: this.options.hostId, hostSpace,
				matrix, hasReferences: references, signal: active });
			if (!await eligible()) return "blocked";
			await hierarchy.fenceSpace(effect); // Permanent negative authority precedes account effects.
			if (!await eligible()) return "blocked";
			if (!await operator.leaveAndForget(effect, active)) return "pending";
			if (!await eligible()) return "blocked";
			await matrix.leaveRoom(effect.roomId, active);
			active.throwIfAborted(); return this.finish(effect, hostSpace, active);
		});
	}
	private async finish(effect: RetirementAncestor, hostSpace: string, signal: AbortSignal): Promise<"done" | "blocked"> {
		const { hierarchy, matrix } = this.options;
		if (effect.spaceKind === "project_space") {
			if (!("parentRoomId" in effect.provenance) || effect.provenance.parentRoomId !== hostSpace ||
				hierarchy.hasReferences(effect.roomId, (id) => Boolean(this.options.retirement(id))) || await this.options.hasReferences(effect.roomId)) return "blocked";
			// Remove only the retired project link. The host Space itself is never retired.
			await matrix.assertManagedProvenance(hostSpace, { version: 1, hostId: this.options.hostId, kind: "host_space", creationKey: "host" }, signal);
			await matrix.assertRoomAuthority(hostSpace, true, signal, { spaceChild: true });
			if ((await matrix.spaceChildren(hostSpace, signal)).includes(effect.roomId)) await matrix.removeSpaceChild(hostSpace, effect.roomId, signal);
		}
		signal.throwIfAborted(); await hierarchy.completeSpace(effect); return "done";
	}
	private record(conversationId: string): RetirementRecord {
		const record = this.options.retirement(conversationId);
		if (!record || record.hostId !== this.options.hostId) throw Error("Permanent retirement authority is required");
		return parseRetirementRecord(record);
	}
}
