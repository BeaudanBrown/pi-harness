import { parseAccountAck } from "../managed-sessions/live-workspace-contracts.js";
import { type MatrixHttp } from "../matrix-shared/http.js";
import { verifyManagedHierarchy, accountRoomProofs, type EnsureRoom } from "./account-proof.js";
import type { AccountMatrixPort } from "./account-worker.js";

/** Owner credentials remain exclusively in the existing bridge transport HTTP client. */
export class AccountMatrix implements AccountMatrixPort {
	constructor(private readonly http: MatrixHttp) { if (http.retry.maxAttempts !== 1) throw Error("Account effects require the owner single-attempt transport"); }
	private room(id: string): string { return `/_matrix/client/v3/rooms/${encodeURIComponent(id)}`; }
	async joined(roomId: string, signal: AbortSignal): Promise<boolean> {
		const result = await this.http.request("GET", "/_matrix/client/v3/joined_rooms", undefined, signal) as { joined_rooms?: unknown };
		if (!Array.isArray(result?.joined_rooms) || result.joined_rooms.length > 10000 || !result.joined_rooms.every(v => typeof v === "string")) throw Error("Invalid account membership observation");
		return result.joined_rooms.includes(roomId);
	}
	state(roomId: string, signal: AbortSignal): Promise<unknown> { return this.http.request("GET", this.room(roomId) + "/state", undefined, signal); }
	async join(roomId: string, signal: AbortSignal): Promise<void> { await this.http.request("POST", this.room(roomId) + "/join", {}, signal); }
	async leave(roomId: string, signal: AbortSignal): Promise<void> { await this.http.request("POST", this.room(roomId) + "/leave", {}, signal); }
	async forget(roomId: string, signal: AbortSignal): Promise<void> {
		// Only a successful acknowledgement proves forget. The Matrix spec does
		// not define 400/403/404 as an already-forgotten success response.
		await this.http.request("POST", this.room(roomId) + "/forget", {}, signal);
	}
	async cleanupEligible(action: EnsureRoom, bot: string, owner: string, signal: AbortSignal): Promise<boolean> {
		const snapshots = new Map<string, unknown>();
		for (const room of accountRoomProofs(action)) snapshots.set(room.roomId, await this.state(room.roomId, signal));
		verifyManagedHierarchy(action, bot, snapshots);
		const target = snapshots.get(action.roomId) as Array<{ type: string; state_key: string; content: Record<string, unknown> }>;
		return !target.some(e => e.type === "m.space.child" && Object.keys(e.content).length > 0 ||
			e.type === "m.room.member" && e.content.membership === "join" && e.state_key !== bot && e.state_key !== owner);
	}
	async toDevice(type: string, recipient: string, device: string, txn: string, content: unknown, signal: AbortSignal): Promise<void> {
		if (type !== "lol.bepis.pi.account.ack.v1") throw Error("Unsupported account transmission");
		await this.http.request("PUT", `/_matrix/client/v3/sendToDevice/${encodeURIComponent(type)}/${encodeURIComponent(txn)}`,
			{ messages: { [recipient]: { [device]: parseAccountAck(content) } } }, signal);
	}
}
