import type { LiveHierarchy, HierarchyLink, HierarchySpaceIdentity } from "./live-hierarchy.js";
import type { ManagedMatrixClient } from "./matrix-client.js";
import type { RelayRegistry } from "./registry.js";
export interface SpaceCleanupAccount {
	leaveAndForget(target: HierarchySpaceIdentity, signal: AbortSignal): Promise<boolean>;
	completed(target: HierarchySpaceIdentity, signal: AbortSignal): Promise<boolean>;
}
/** Call only inside the hierarchy's project-exclusive scope and with frozen consent.
 * Account outages are pending cleanup, never permission to kick or use credentials. */
export class LiveSpaceCleanup {
	constructor(private readonly options: { registry: RelayRegistry; matrix: ManagedMatrixClient; hierarchy: LiveHierarchy; account?: SpaceCleanupAccount }) {}
	identity(link: HierarchyLink): HierarchySpaceIdentity {
		return { roomId: link.child.roomId, provenance: link.child.provenance, operatorUserId: this.options.matrix.operatorUserId, botUserId: this.options.matrix.botUserId };
	}
	async verify(link: HierarchyLink, signal?: AbortSignal): Promise<void> {
		const { matrix } = this.options;
		await matrix.recoverManagedRoom(link.parent.roomId, link.parent.provenance, signal);
		await matrix.recoverManagedRoom(link.child.roomId, link.child.provenance, signal);
		await matrix.assertRoomAuthority(link.parent.roomId, true, signal, { spaceChild: true });
	}
	async empty(link: HierarchyLink, signal?: AbortSignal): Promise<boolean> {
		const { matrix, hierarchy, registry } = this.options; const roomId = link.child.roomId;
		if (!["project_space", "worktree_space"].includes(link.child.provenance.kind) || hierarchy.hasReferences(roomId, id => Boolean(registry.retirement(id) || registry.archiveRecord(id)))) return false;
		if ([...registry.listManifests(), ...registry.localConversations()].some(manifest => {
			const binding = "verifiedBinding" in manifest ? manifest.verifiedBinding : manifest;
			return binding && (binding.projectSpace === roomId || ("checkoutSpace" in binding && binding.checkoutSpace === roomId));
		})) return false;
		await matrix.assertRoomAuthority(roomId, true, signal, { spaceChild: true });
		if ((await matrix.spaceChildren(roomId, signal)).length) return false;
		return [...await matrix.joinedMemberIds(roomId, signal)].every(id => id === matrix.operatorUserId || id === matrix.botUserId);
	}
	async apply(link: HierarchyLink, signal: AbortSignal): Promise<boolean> {
		const { matrix, hierarchy, account } = this.options; const target = this.identity(link);
		if (hierarchy.spaceRetirement(target) === "done") return true;
		if (hierarchy.spaceRetirement(target) === "pending" && !await matrix.accountJoined(target.roomId, signal)) {
			// Departure/parent absence are not fresh emptiness or ownership proof.
			// After a lost leave reply the bot can no longer inspect private current
			// state. Keep cleanup pending; never rejoin or mark it complete by inference.
			return false;
		}
		await this.verify(link, signal); if (!await this.empty(link, signal)) return false;
		await hierarchy.fenceSpace(target);
		if (!account) return false;
		await this.verify(link, signal); if (!await this.empty(link, signal)) return false;
		if (!await account.leaveAndForget(target, signal)) return false;
		await this.verify(link, signal); if (!await this.empty(link, signal)) return false;
		if ((await matrix.spaceChildren(link.parent.roomId, signal)).includes(target.roomId)) await matrix.removeSpaceChild(link.parent.roomId, target.roomId, signal);
		await this.verify(link, signal); if (!await this.empty(link, signal)) return false;
		signal.throwIfAborted(); await matrix.leaveRoom(target.roomId, signal);
		if (await matrix.accountJoined(target.roomId, signal) || !await account.completed(target, signal)) return false;
		await hierarchy.completeSpace(target); return true;
	}
}
