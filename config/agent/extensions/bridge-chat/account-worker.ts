import { parseAccountAction } from "../managed-sessions/live-workspace-contracts.js";
import { AccountStore, ACCOUNT_REQUEST_EVENT, ACCOUNT_ACK_EVENT, type AccountHost, type AccountRequest } from "./account-store.js";
import { AccountProofError, accountRoomProofs, verifyManagedHierarchy, verifyManagedInvite, type EnsureRoom } from "./account-proof.js";
import { initializeRule, silentRule, type AccountRulePort } from "./account-notifications.js";

export interface AccountMatrixPort {
	joined(roomId: string, signal: AbortSignal): Promise<boolean>;
	state(roomId: string, signal: AbortSignal): Promise<unknown>;
	join(roomId: string, signal: AbortSignal): Promise<void>;
	leave(roomId: string, signal: AbortSignal): Promise<void>;
	forget(roomId: string, signal: AbortSignal): Promise<void>;
	cleanupEligible(action: EnsureRoom, bot: string, owner: string, signal: AbortSignal): Promise<boolean>;
	toDevice(type: string, recipient: string, device: string, txn: string, content: unknown, signal: AbortSignal): Promise<void>;
}
const object = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const events = (v: unknown): unknown[] => { if (!Array.isArray(v) || v.length > 4096) throw Error("Account sync events exceed bounds"); return v; };

/** Deterministic consumer only; never calls the model socket or assistant store. */
export class AccountWorker {
	private intakeReady = false;
	constructor(private readonly store: AccountStore, private readonly hosts: readonly AccountHost[], private readonly owner: string,
		private readonly matrix: AccountMatrixPort, private readonly rules: AccountRulePort) {}
	/** Persist before the shared cursor. No network effects during intake. */
	ingest(value: unknown, fresh = false): void {
		this.intakeReady = false;
		this.store.intakeBatch(() => this.ingestBatch(value, fresh));
		this.intakeReady = true;
	}
	suspend(): void { this.intakeReady = false; }
	private requireIntake(): void { if (!this.intakeReady) throw Error("Account intake is not reconciled"); }
	private ingestBatch(value: unknown, fresh: boolean): void {
		const batch = object(value), incoming = events(object(batch.to_device).events ?? []);
		this.store.ingest(incoming, this.hosts);
		// Pin authenticated attestations before observing departures in this same batch.
		for (const raw of incoming) {
			const e = object(raw), content = object(e.content); if (typeof content.requestId !== "string") continue;
			if (e.type !== ACCOUNT_REQUEST_EVENT) continue;
			const saved = this.store.get(content.requestId);
			if (!saved || !this.host(saved) || saved.sender !== e.sender || saved.action.operation !== "room.ensure") continue;
			try { if (parseAccountAction(e.content).payloadDigest !== saved.action.payloadDigest) continue; } catch { continue; }
			this.store.pinRoom(saved.action, saved.sender);
		}
		const rooms = object(batch.rooms), invited = object(rooms.invite);
		if (Object.keys(invited).length > 8192) throw Error("Account invitations exceed bounds");
		for (const [roomId, raw] of Object.entries(invited)) {
			const invite = events(object(object(raw).invite_state).events ?? []);
			if (invite.some(v => { const e = object(v); return e.type === "m.room.member" && e.state_key === this.owner && object(e.content).membership === "invite" && this.hosts.some(h => h.botUserId === e.sender); })) this.store.saveInvite(roomId, invite);
		}
		for (const section of [object(rooms.join), object(rooms.leave)]) {
			if (Object.keys(section).length > 10000) throw Error("Account membership observation exceeds bounds");
			for (const [roomId, raw] of Object.entries(section)) {
				if (!this.store.room(roomId)) continue;
				const r = object(raw), membership = [...events(object(r.state).events ?? []), ...events(object(r.timeline).events ?? [])]
					.map(object).filter(e => e.type === "m.room.member" && e.state_key === this.owner);
				for (const e of fresh ? membership.slice(-1) : membership) {
					if (e.sender === this.owner && object(e.content).membership === "leave" && typeof e.event_id === "string") this.store.departed(roomId, e.event_id);
				}
			}
		}
	}
	private host(request: AccountRequest): AccountHost | undefined { return this.hosts.find(h => h.hostId === request.action.hostId && h.botUserId === request.sender); }
	private async verify(action: EnsureRoom, bot: string, signal: AbortSignal): Promise<void> {
		const snapshots = new Map<string, unknown>();
		for (const room of accountRoomProofs(action)) snapshots.set(room.roomId, await this.matrix.state(room.roomId, signal));
		verifyManagedHierarchy(action, bot, snapshots);
	}
	private async ensure(request: AccountRequest, signal: AbortSignal): Promise<"complete" | "notification_setup_uncertain"> {
		const action = request.action; if (action.operation !== "room.ensure") throw Error("Invalid ensure dispatch");
		const saved = this.store.pinRoom(action, request.sender);
		if (saved.departure || saved.retired) throw Error("Account room is suppressed");
		const joined = await this.matrix.joined(action.roomId, signal);
		if (joined) await this.verify(action, request.sender, signal);
		else verifyManagedInvite(action, request.sender, this.owner, this.store.invite(action.roomId));
		this.requireIntake();
		let uncertain = false;
		if (saved.action.notificationSetup === "new_room" && (action.kind === "conversation" || action.kind === "coordinator")) {
			const rule = silentRule(action.roomId, request.sender);
			uncertain = await initializeRule(this.store, this.rules, action.roomId, rule.ruleId, rule.payload, signal) === "uncertain";
		}
		this.requireIntake();
		const current = this.store.room(action.roomId)!;
		if (current.departure || current.retired) throw Error("Account room is suppressed");
		if (!joined) await this.matrix.join(action.roomId, signal);
		await this.verify(action, request.sender, signal);
		if (!await this.matrix.joined(action.roomId, signal)) throw Error("Account join is unconfirmed");
		if (this.store.room(action.roomId)!.departure || this.store.room(action.roomId)!.retired) throw Error("Account room changed during setup");
		this.requireIntake(); this.store.verified(action.roomId);
		return uncertain ? "notification_setup_uncertain" : "complete";
	}
	async step(signal: AbortSignal): Promise<void> {
		if (!this.intakeReady) return;
		const request = this.store.nextRequest(this.hosts); if (!request) return;
		const host = this.host(request); if (!host) return;
		const action = request.action;
		try {
			const room = this.store.room(action.roomId);
			if (action.operation === "room.ensure") {
				if (room?.retired || room?.departure) { this.store.acknowledge(action.requestId, host, "rejected", "departed"); return; }
				this.store.acknowledge(action.requestId, host, await this.ensure(request, signal)); return;
			}
			if (!room || room.sender !== request.sender || room.action.hostId !== action.hostId) throw new AccountProofError("unverified");
			if (!room.verified) {
				// Read-only verification can recover an already joined target; never
				// join a retired identity merely to acquire cleanup authority.
				await this.verify(room.action, request.sender, signal); this.store.verified(action.roomId);
			}
			if (action.operation === "coordinator.membership.restore") {
				if (room.action.kind !== "coordinator" || room.retired || room.action.conversationId !== action.conversationId || room.action.hostSpaceId !== action.hostSpaceId || room.departure !== action.departureEventId) {
					this.store.acknowledge(action.requestId, host, "rejected", "conflict"); return;
				}
				if (!await this.matrix.joined(action.roomId, signal)) {
					verifyManagedInvite(room.action, request.sender, this.owner, this.store.invite(action.roomId));
					if (this.store.room(action.roomId)?.departure !== action.departureEventId) throw Error("Coordinator departure changed");
					this.requireIntake(); await this.matrix.join(action.roomId, signal);
				}
				await this.verify(room.action, request.sender, signal);
				this.requireIntake(); this.store.restored(action.roomId, action.departureEventId, action.requestId, host); return;
			} else {
				if (action.operation === "room.retire" ? room.action.kind !== "conversation" || room.action.conversationId !== action.conversationId : !["project_space", "worktree_space"].includes(room.action.kind) || room.action.hostSpaceId !== action.hostSpaceId) throw new AccountProofError("unverified");
				// Save negative authority before any account effect, independently of bot cleanup.
				this.store.retire(action.roomId);
				if (await this.matrix.joined(action.roomId, signal)) {
					if (action.operation === "space.retire" && !await this.matrix.cleanupEligible(room.action, request.sender, this.owner, signal)) throw new AccountProofError("unverified");
					this.requireIntake(); await this.matrix.leave(action.roomId, signal);
				}
				this.requireIntake(); await this.matrix.forget(action.roomId, signal);
			}
			this.store.acknowledge(action.requestId, host, "complete");
		} catch (error) {
			// A failed room is retried independently. Only explicit unsupported encryption is terminal.
			this.store.acknowledge(action.requestId, host, error instanceof AccountProofError && error.code === "unsupported_encryption" ? "rejected" : "pending",
				error instanceof AccountProofError ? error.code : undefined);
		}
	}
	async flush(signal: AbortSignal): Promise<void> {
		if (!this.intakeReady) return;
		const value = this.store.transmission(this.hosts); if (!value || !this.hosts.some(h => h.botUserId === value.recipient && h.deviceId === value.deviceId && h.hostId === value.payload.hostId)) return;
		await this.matrix.toDevice(ACCOUNT_ACK_EVENT, value.recipient, value.deviceId, value.transactionId, value.payload, signal);
		this.store.transmitted(value);
	}
}
