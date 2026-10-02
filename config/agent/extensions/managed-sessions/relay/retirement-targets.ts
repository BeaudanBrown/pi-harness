import { isDeepStrictEqual } from "node:util";
import { parseManagedProvenance, type ManagedProvenance } from "../managed-provenance.js";
import { hasMatrixBinding, type RegisteredConversation } from "../contracts.js";
import type { RetirementTarget } from "./retirement-store.js";

type Stop = Extract<RetirementTarget, { kind: "stop" }>;
/** Freeze known logical resources offline. No alias lookup, discovery, or emptiness claim. */
export function retirementTargets(input: {
	hostId: string; manifest: RegisteredConversation; stop: Stop;
	operatorUserId: string; botUserId: string; hostSpace?: string;
	ancestorProvenance?(roomId: string): ManagedProvenance | undefined;
}): RetirementTarget[] {
	const { manifest, hostId, operatorUserId, botUserId, hostSpace } = input;
	if (manifest.kind !== "project" || manifest.ownerHostId !== hostId) throw Error("Retirement requires a host-owned project conversation");
	const binding = hasMatrixBinding(manifest) ? manifest : manifest.verifiedBinding;
	const targets: RetirementTarget[] = [structuredClone(input.stop)];
	if (!binding) return targets;
	const { roomId, projectSpace, checkoutSpace } = binding;
	const rooms = [roomId, projectSpace, checkoutSpace, hostSpace].filter((id): id is string => Boolean(id));
	if (new Set(rooms).size !== rooms.length) throw Error("Retirement hierarchy identities conflict");
	targets.push({ kind: "operator_leave_forget", roomId, userId: operatorUserId }, { kind: "bot_leave", roomId, userId: botUserId });
	// Legacy/unresolved ancestors cannot gain ownership merely from their names or aliases.
	if (projectSpace && checkoutSpace && manifest.projectKey && manifest.checkoutId) {
		targets.push({ kind: "ancestor", roomId: checkoutSpace, childRoomId: roomId, spaceKind: "checkout_space", creationKey: manifest.checkoutId,
			operatorUserId, botUserId, provenance: { version: 1, hostId, kind: "worktree_space", creationKey: manifest.checkoutId,
				projectKey: manifest.projectKey, checkoutId: manifest.checkoutId, parentRoomId: projectSpace } });
		if (hostSpace) targets.push({ kind: "ancestor", roomId: projectSpace, childRoomId: checkoutSpace, spaceKind: "project_space", creationKey: manifest.projectKey,
			operatorUserId, botUserId, provenance: { version: 1, hostId, kind: "project_space", creationKey: manifest.projectKey,
				projectKey: manifest.projectKey, parentRoomId: hostSpace } });
	}
	if (input.ancestorProvenance) {
		// Current private hierarchy captures successor creation identities, never remote rediscovery.
		for (const target of targets) if (target.kind === "ancestor") {
			const saved = input.ancestorProvenance(target.roomId);
			if (!saved) return targets.filter((item) => item.kind !== "ancestor");
			const proof = parseManagedProvenance(saved);
			if (!isDeepStrictEqual({ ...proof, creationKey: target.creationKey }, target.provenance)) throw Error("Retirement ancestor identity conflicts with its binding");
			target.creationKey = proof.creationKey; target.provenance = structuredClone(proof);
		}
	}
	return targets;
}
