import { randomUUID } from "node:crypto";
import { deriveGenerationId, hasMatrixBinding } from "../contracts.js";
import type { RelayRegistry } from "./registry.js";
import type { ManagedSessionIpcServer } from "./ipc-server.js";
import type { ManagedMatrixClient } from "./matrix-client.js";
import type { LiveHierarchy } from "./live-hierarchy.js";
import type { ExactWindowClient } from "./exact-window-client.js";
import { RetirementCleanup } from "./retirement-cleanup.js";
import { RetirementAncestorOwner } from "./retirement-ancestor-owner.js";
import { retirementTargets } from "./retirement-targets.js";
import type { RetirementEffect, RetirementRecord, RetirementTarget } from "./retirement-store.js";

type AccountTarget = Extract<RetirementEffect, { kind: "ancestor" }> | Extract<RetirementEffect, { kind: "operator_leave_forget" | "bot_leave" }>;
export interface RetirementPlan { conversationId: string; targets: RetirementTarget[] }
export interface RetirementAccountPort {
	leaveAndForget(target: AccountTarget, signal: AbortSignal): Promise<boolean>;
	completed(target: AccountTarget, signal: AbortSignal): Promise<boolean>;
}
/** Terminal identity commits before cancellation or cleanup. No caller/process survival required. */
export class ConversationRetirement {
	private readonly cleanup: RetirementCleanup;
	private readonly ancestors?: RetirementAncestorOwner;
	private timer?: NodeJS.Timeout;
	private closed = false;
	constructor(private readonly options: {
		registry: RelayRegistry;
		server: Pick<ManagedSessionIpcServer, "attachment" | "sendToAttachment">;
		matrix: ManagedMatrixClient;
		matrixAuthenticated: () => boolean;
		windows: Pick<ExactWindowClient, "check" | "terminate">;
		hierarchy?: LiveHierarchy;
		account?: RetirementAccountPort;
		cancelApprovals?(conversationId: string): void;
		onFailure?(): void;
	}) {
		const { registry, matrix, hierarchy } = options;
		if (hierarchy) this.ancestors = new RetirementAncestorOwner({ hostId: registry.hostId, matrix, hierarchy,
			hostSpace: () => this.hostSpace(), retirement: (id) => registry.retirement(id), hasReferences: async (roomId) => this.hasReferences(roomId),
			operator: { leaveAndForget: (target, signal) => options.account?.leaveAndForget(target, signal) ?? Promise.resolve(false),
				completed: (target, signal) => options.account?.completed(target, signal) ?? Promise.resolve(false) } });
		this.cleanup = new RetirementCleanup({ authority: registry, execute: (record, effect, signal) => this.execute(record, effect, signal) });
	}
	prepare(conversationId: string): RetirementPlan {
		if (this.closed) throw Error("Retirement owner is closed");
		const { registry, matrix, hierarchy } = this.options;
		const candidate = registry.retirementCandidate(conversationId);
		const targets = retirementTargets({ hostId: registry.hostId, manifest: candidate.manifest, hostSpace: this.hostSpace(),
			operatorUserId: matrix.operatorUserId, botUserId: matrix.botUserId,
			...(hierarchy ? { ancestorProvenance: (roomId: string) => hierarchy.ancestorProvenance(roomId) } : {}),
			stop: { kind: "stop", generationId: candidate.generationId,
				...(candidate.state === "starting" ? { unresolvedLaunch: true as const } : {}),
				...(!hasMatrixBinding(candidate.manifest) && !candidate.manifest.verifiedBinding ? { unresolvedBinding: true as const } : {}),
				...(candidate.attachmentId ? { attachmentId: candidate.attachmentId } : {}), ...(candidate.window ? { window: candidate.window } : {}) } });
		return { conversationId, targets };
	}
	async retire(conversationId: string): Promise<RetirementRecord> {
		if (this.closed) throw Error("Retirement owner is closed");
		const prior = this.options.registry.retirement(conversationId); if (prior) { this.kick(); return prior; }
		return this.retirePrepared(this.prepare(conversationId));
	}
	/** Model approval executes this frozen plan, never a newly expanded discovery. */
	async retirePrepared(plan: RetirementPlan): Promise<RetirementRecord> {
		if (this.closed) throw Error("Retirement owner is closed");
		const { conversationId, targets } = structuredClone(plan); const { registry } = this.options;
		try { return await registry.retireConversation(conversationId, targets); }
		finally {
			// A runtime projection write may fail after terminal authority committed.
			try { if (registry.retirement(conversationId)) this.options.cancelApprovals?.(conversationId); }
			catch { this.options.onFailure?.(); }
			this.kick();
		}
	}
	start(): void {
		if (this.closed || this.timer) return;
		this.kick(); this.timer = setInterval(() => this.kick(), 10_000); this.timer.unref();
	}
	kick(): void {
		if (this.closed) return;
		try { this.cleanup.kick(); } catch { this.options.onFailure?.(); }
	}
	async drain(): Promise<void> { await this.cleanup.drain(); }
	async close(): Promise<void> { this.closed = true; if (this.timer) clearInterval(this.timer); await this.cleanup.close(); }
	private hostSpace(): string | undefined { return this.options.registry.listManifests().find((item) => item.kind === "coordinator")?.hostSpace; }
	private hasReferences(roomId: string): boolean {
		const { registry } = this.options;
		return [...registry.listManifests(), ...registry.localConversations()].some((manifest) => {
			const binding = hasMatrixBinding(manifest) ? manifest : manifest.verifiedBinding;
			return binding && [binding.roomId, binding.projectSpace, binding.checkoutSpace].includes(roomId);
		});
	}
	private async execute(record: RetirementRecord, effect: RetirementEffect, signal: AbortSignal): Promise<"done" | "pending" | "blocked"> {
		signal.throwIfAborted(); const { matrix, account } = this.options;
		if (effect.kind === "stop") return this.stop(record, effect, signal);
		if (!this.options.matrixAuthenticated()) return "pending";
		if (effect.kind === "ancestor") return this.ancestors?.run(record.conversationId, effect.effectId, signal) ?? "blocked";
		if (effect.kind === "operator_leave_forget") {
			if (effect.userId !== matrix.operatorUserId) return "blocked";
			return await account?.leaveAndForget(effect, signal) ? "done" : "pending";
		}
		if (effect.kind === "bot_leave") {
			if (effect.userId !== matrix.botUserId) return "blocked";
			if (!await matrix.accountJoined(effect.roomId, signal)) return "done";
			await matrix.assertRoomAuthority(effect.roomId, false, signal);
			signal.throwIfAborted(); await matrix.leaveRoom(effect.roomId, signal); return "done";
		}
		return "blocked";
	}
	private async stop(record: RetirementRecord, effect: Extract<RetirementEffect, { kind: "stop" }>, signal: AbortSignal): Promise<"done" | "pending" | "blocked"> {
		const { server, windows } = this.options;
		const attachment = server.attachment(record.conversationId);
		if (attachment && (attachment.attachmentId !== effect.attachmentId || deriveGenerationId(record.conversationId, attachment.generation) !== effect.generationId)) return "blocked";
		if (attachment) server.sendToAttachment(attachment, { protocolVersion: "1.0.0", messageId: `retire-${randomUUID()}`,
			conversationId: record.conversationId, role: "relay", type: "termination.request", payload: { reason: "stop" } });
		const proof = effect.window?.ownership;
		if (!proof) return "blocked"; // No inference of process death from a missing socket or legacy marker.
		const before = await windows.check(proof); signal.throwIfAborted();
		if (before === "changed") return "blocked";
		if (before === "match") {
			try { if (!await windows.terminate(proof)) return "blocked"; }
			catch { signal.throwIfAborted(); if (await windows.check(proof) !== "gone") return "blocked"; }
		}
		signal.throwIfAborted();
		// Window disappearance cannot settle a launch/binding continuation that
		// had no final identity at consent. Its owning intent must reconcile it.
		if (effect.unresolvedLaunch || effect.unresolvedBinding) return "blocked";
		return server.attachment(record.conversationId) ? "pending" : "done";
	}
}
