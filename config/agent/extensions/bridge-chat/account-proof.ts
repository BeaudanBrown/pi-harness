import { MANAGED_PROVENANCE_EVENT, parseManagedProvenance, type ManagedProvenance } from "../managed-sessions/managed-provenance.js";
import type { AccountAction } from "../managed-sessions/live-workspace-contracts.js";
import { isSoleRoomCreator } from "../matrix-shared/room-creator.js";

export type EnsureRoom = Extract<AccountAction, { operation: "room.ensure" }>;
export type AccountRoomProof = { roomId: string; expected: Partial<ManagedProvenance> & { kind: ManagedProvenance["kind"] } };
export class AccountProofError extends Error {
	constructor(readonly code: "unverified" | "unsupported_encryption") { super("Managed account room proof is unavailable or unsupported"); }
}
function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new AccountProofError("unverified");
	return value as Record<string, unknown>;
}
function state(events: unknown): Map<string, Record<string, unknown>> {
	if (!Array.isArray(events) || events.length > 4096) throw new AccountProofError("unverified");
	const result = new Map<string, Record<string, unknown>>();
	for (const raw of events) {
		const e = object(raw); if (typeof e.type !== "string" || typeof e.state_key !== "string" || typeof e.sender !== "string") throw new AccountProofError("unverified");
		const key = JSON.stringify([e.type, e.state_key]); if (result.has(key)) throw new AccountProofError("unverified"); result.set(key, e);
	}
	return result;
}
const key = (type: string, id = "") => JSON.stringify([type, id]);
export function accountRoomProofs(action: EnsureRoom): AccountRoomProof[] {
	const rooms: AccountRoomProof[] = [{ roomId: action.hostSpaceId, expected: { version: 1, hostId: action.hostId, kind: "host_space" } }];
	if (action.archiveRootSpaceId) rooms.push({ roomId: action.archiveRootSpaceId, expected: { version: 1, hostId: action.hostId, kind: "archive_root_space", parentRoomId: action.hostSpaceId } });
	if (action.project) rooms.push({ roomId: action.project.spaceId, expected: { version: 1, hostId: action.hostId, kind: action.archiveRootSpaceId ? "archive_project_space" : "project_space", projectKey: action.project.projectKey, parentRoomId: action.archiveRootSpaceId ?? action.hostSpaceId } });
	if (action.checkout) rooms.push({ roomId: action.checkout.spaceId, expected: { version: 1, hostId: action.hostId, kind: action.archiveRootSpaceId ? "archive_worktree_space" : "worktree_space", projectKey: action.project!.projectKey, checkoutId: action.checkout.checkoutId, parentRoomId: action.project!.spaceId } });
	if (action.kind === "conversation") rooms.push({ roomId: action.roomId, expected: { version: 1, hostId: action.hostId, kind: action.kind, creationKey: action.creationKey,
		conversationId: action.conversationId!, projectKey: action.project!.projectKey, checkoutId: action.checkout!.checkoutId, parentRoomId: action.checkout!.spaceId } });
	if (action.kind === "coordinator") rooms.push({ roomId: action.roomId, expected: { version: 1, hostId: action.hostId, kind: action.kind, creationKey: action.creationKey, conversationId: action.conversationId!, parentRoomId: action.hostSpaceId } });
	if (new Set(rooms.map(r => r.roomId)).size !== rooms.length || rooms.at(-1)?.roomId !== action.roomId) throw new AccountProofError("unverified");
	rooms[rooms.length - 1].expected.creationKey = action.creationKey;
	return rooms;
}
function verifyAvailable(events: Map<string, Record<string, unknown>>, expected: AccountRoomProof, bot: string, complete: boolean): void {
	if (events.has(key("m.room.encryption"))) throw new AccountProofError("unsupported_encryption");
	const creation = events.get(key("m.room.create"));
	if (creation) {
		const content = object(creation.content); const space = expected.expected.kind.endsWith("_space");
		if (!isSoleRoomCreator(creation, bot) || content["m.federate"] !== false || (space ? content.type !== "m.space" : content.type !== undefined)) throw new AccountProofError("unverified");
	} else if (complete) throw new AccountProofError("unverified");
	const joins = events.get(key("m.room.join_rules"));
	if (joins ? object(joins.content).join_rule !== "invite" : complete) throw new AccountProofError("unverified");
	const marker = events.get(key(MANAGED_PROVENANCE_EVENT));
	if (marker) {
		if (marker.sender !== bot) throw new AccountProofError("unverified");
		let proof: ManagedProvenance; try { proof = parseManagedProvenance(marker.content); } catch { throw new AccountProofError("unverified"); }
		if (Object.entries(expected.expected).some(([field, value]) => (proof as Record<string, unknown>)[field] !== value)) throw new AccountProofError("unverified");
	} else if (complete) throw new AccountProofError("unverified");
}
/** Host attestation plus exact inviter, never a room name or limited stripped state alone. */
export function verifyManagedInvite(action: EnsureRoom, bot: string, owner: string, events: unknown): void {
	const target = accountRoomProofs(action).at(-1)!; const snapshot = state(events);
	const invite = snapshot.get(key("m.room.member", owner));
	if (!invite || invite.sender !== bot || object(invite.content).membership !== "invite") throw new AccountProofError("unverified");
	verifyAvailable(snapshot, target, bot, false);
}
/** Ready requires full target and ancestor proof plus exact bot-authored child links. */
export function verifyManagedHierarchy(action: EnsureRoom, bot: string, snapshots: ReadonlyMap<string, unknown>): void {
	const chain = accountRoomProofs(action);
	for (const [index, room] of chain.entries()) {
		const snapshot = state(snapshots.get(room.roomId)); verifyAvailable(snapshot, room, bot, true);
		const child = chain[index + 1]; if (!child) continue;
		const link = snapshot.get(key("m.space.child", child.roomId));
		if (!link || link.sender !== bot) throw new AccountProofError("unverified");
		const via = object(link.content).via;
		if (!Array.isArray(via) || !via.length || !via.every(v => typeof v === "string" && v.length <= 255 && v.length > 0)) throw new AccountProofError("unverified");
	}
}
