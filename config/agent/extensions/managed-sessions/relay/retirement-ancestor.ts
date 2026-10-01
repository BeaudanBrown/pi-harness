import { parseRetirementRecord, type RetirementRecord, type RetirementEffect } from "./retirement-store.js";
import type { ManagedMatrixClient } from "./matrix-client.js";

export type RetirementAncestor = Extract<RetirementEffect, { kind: "ancestor" }>;
type Matrix = Pick<ManagedMatrixClient, "botUserId" | "operatorUserId" | "assertManagedProvenance" | "assertRoomAuthority" | "spaceChildren" | "joinedMemberIds">;

/** Read-only fresh checks. The effect owner must hold the provisioning/cleanup lock
 * across these checks and its single next external mutation. A positive result is not reusable consent. */
export async function verifyRetirementAncestor(input: {
	record: RetirementRecord; effectId: string; hostId: string; hostSpace: string;
	matrix: Matrix;
	/** Includes live conversation bindings and in-flight/unpublished hierarchy reservations. */
	hasReferences(roomId: string): Promise<boolean>;
	/** Before unlink: only the frozen retired child may remain. Before leave: no children. */
	allowRetiredChild?: boolean;
	signal?: AbortSignal;
}): Promise<RetirementAncestor | undefined> {
	const record = parseRetirementRecord(input.record);
	const effect = record.cleanup?.find((item) => item.effectId === input.effectId);
	if (!effect || effect.kind !== "ancestor" || effect.phase === "done" || record.hostId !== input.hostId || effect.roomId === input.hostSpace ||
		effect.botUserId !== input.matrix.botUserId || effect.operatorUserId !== input.matrix.operatorUserId) return undefined;
	// Never remove a checkout link from its project before that exact child Space's cleanup completed.
	if (effect.spaceKind === "project_space" && !record.cleanup?.some((item) => item.kind === "ancestor" && item.spaceKind === "checkout_space" && item.roomId === effect.childRoomId && item.phase === "done")) return undefined;
	input.signal?.throwIfAborted();
	await input.matrix.assertManagedProvenance(effect.roomId, effect.provenance, input.signal);
	await input.matrix.assertRoomAuthority(effect.roomId, true, input.signal, { spaceChild: true });
	const children = await input.matrix.spaceChildren(effect.roomId, input.signal);
	if (children.some((child) => !input.allowRetiredChild || child !== effect.childRoomId)) return undefined;
	const members = await input.matrix.joinedMemberIds(effect.roomId, input.signal);
	if ([...members].some((userId) => userId !== effect.botUserId && userId !== effect.operatorUserId)) return undefined;
	if (await input.hasReferences(effect.roomId)) return undefined;
	input.signal?.throwIfAborted();
	return structuredClone(effect);
}
