import { HOST_CONTROL_VERSION, parseHostRequest, parseHostResponse, isHostMutation, type HostResponse } from "../live-workspace-contracts.js";
import { hostApprovalId, hostApprovalRequestDigest, type FrozenHostEffects, type HostApprovalRecord, type ModelHostRequest, prepareHostApproval } from "./host-approval-record.js";
import { HostApprovalStore } from "./host-approval-store.js";
import { HostControlError, hostErrorResponse } from "./host-control-error.js";
import { HostPolicy } from "./host-policy.js";

import type { HostRunWitness } from "../host-run-contracts.js";

type Decision = NonNullable<HostApprovalRecord["decision"]>;
export interface HostApprovalPresentation {
	receipt: NonNullable<HostApprovalRecord["presentation"]>;
	/** Only an authenticated native-dialog response or authorized Matrix vote may resolve this. */
	decision: Promise<Decision>;
	close(): Promise<void>;
}
interface ActiveApproval {
	request: ModelHostRequest; response: Promise<HostResponse>; cancelled?: "cancelled" | "expired";
	cancel(): void; executing: boolean;
}
const uncertain = () => new HostControlError("failed", "Host action outcome is unknown; inspect state before explicitly trying again", false);
function sameCall(a: ModelHostRequest, b: ModelHostRequest): boolean {
	return hostApprovalRequestDigest(a) === hostApprovalRequestDigest(b);
}

/** Pending consent, not a durable execution/replay journal. Mutation execution is attempted once. */
export class HostApprovals {
	private readonly active = new Map<string, ActiveApproval>();
	private readonly now: () => number;
	private closed = false;
	private recovery?: Promise<Array<{ conversationId: string; approvalId: string }>>;
	constructor(private readonly options: {
		hostId: string; protectedConversationId: string; policy: HostPolicy; store: HostApprovalStore;
		operatorUserIds: ReadonlySet<string>;
		notificationDisposition?: () => "silent" | "notify";
		isLive: (request: ModelHostRequest) => Promise<boolean>;
		freeze: (request: ModelHostRequest) => Promise<FrozenHostEffects>;
		present: (record: HostApprovalRecord) => Promise<HostApprovalPresentation>;
		revalidate: (record: HostApprovalRecord) => Promise<boolean>;
		execute: (record: HostApprovalRecord) => Promise<unknown>;
		now?: () => number;
	}) { this.options = { ...options, operatorUserIds: new Set(options.operatorUserIds) }; this.now = options.now ?? Date.now; }

	async request(value: ModelHostRequest): Promise<HostResponse> {
		const request = structuredClone(parseHostRequest(value)) as ModelHostRequest;
		try {
			if (this.closed || this.recovery) throw new HostControlError("unavailable", "Host approvals are stopping or recovering");
			if (request.actor.kind !== "model" || !isHostMutation(request.action)) throw new HostControlError("invalid_request", "Expected a model mutation");
			if (this.options.policy.decide(request, this.options.protectedConversationId) === "forbidden") throw new HostControlError("forbidden", "Host action is forbidden");
			const id = hostApprovalId(this.options.hostId, request.actor);
			let entry = this.active.get(id);
			if (entry && !sameCall(entry.request, request)) throw new HostControlError("conflict", "Active approval has different arguments or origin");
			if (!entry) {
				if (this.active.size >= 64) throw new HostControlError("unavailable", "Too many active host approvals", false);
				let cancel!: () => void; const cancelled = new Promise<void>((resolve) => { cancel = resolve; });
				entry = { request, cancel, executing: false, response: Promise.resolve().then(() => this.run(id, entry!, cancelled)) };
				this.active.set(id, entry);
				void entry.response.finally(() => this.active.delete(id)).catch(() => undefined);
			}
			return { ...structuredClone(await entry.response), requestId: request.actor.requestId };
		} catch (error) { return hostErrorResponse(request.actor.requestId, error); }
	}

	/** Read-only recovery evidence from a fresh live-tool challenge, never saved transcripts. */
	async recoveryAttention(conversationId: string): Promise<{ id: string; stillCurrent: () => boolean } | undefined> {
		for (const [id, entry] of this.active) {
			if (entry.request.actor.conversationId !== conversationId || entry.request.actor.presentation !== "matrix_poll") continue;
			const pending = () => !this.closed && this.active.get(id) === entry && !entry.cancelled && !entry.executing &&
				this.options.store.get(id)?.phase === "presented" && (this.options.store.get(id)?.expiresAt ?? 0) > this.now();
			if (!pending() || !await this.options.isLive(structuredClone(entry.request)).catch(() => false) || !pending()) continue;
			const freshUntil = this.now() + 5_000;
			return { id, stillCurrent: () => this.now() < freshUntil && pending() };
		}
		return undefined;
	}

	/** Called on run end, generation replacement, retirement or loss of the requesting tool. */
	cancelRun(conversationId: string, runId?: string): void {
		for (const entry of this.active.values()) if (!entry.executing && entry.request.actor.conversationId === conversationId && (!runId || entry.request.actor.runId === runId)) {
			entry.cancelled = "cancelled"; entry.cancel();
		}
	}

	/** Observations can revoke consent, but only a fresh challenge can establish liveness. */
	observeRun(conversationId: string, witness: HostRunWitness): void {
		for (const entry of this.active.values()) {
			const actor = entry.request.actor;
			if (!entry.executing && actor.conversationId === conversationId && (witness.phase === "ended"
				? witness.generationId === actor.generationId && witness.runId === actor.runId
				: witness.generationId !== actor.generationId || witness.runId !== actor.runId || !witness.toolCallIds.includes(actor.toolCallId))) { entry.cancelled = "cancelled"; entry.cancel(); }
		}
	}

	/** Returns uncertain calls for a redacted notice. Never calls the mutation executor. */
	recover(): Promise<Array<{ conversationId: string; approvalId: string }>> {
		if (this.closed || this.active.size) return Promise.reject(new HostControlError("busy", "Approval recovery requires quiescent admission"));
		if (this.recovery) return this.recovery;
		const recovery = this.recoverOnce(); this.recovery = recovery;
		void recovery.finally(() => { this.recovery = undefined; }).catch(() => undefined);
		return recovery;
	}
	private async recoverOnce(): Promise<Array<{ conversationId: string; approvalId: string }>> {
		const unknown: Array<{ conversationId: string; approvalId: string }> = [];
		for (const record of this.options.store.list()) {
			if (this.active.has(record.approvalId)) continue;
			if (record.phase === "accepted") unknown.push({ conversationId: record.request.actor.conversationId, approvalId: record.approvalId });
			else if (["prepared", "presented", "approved"].includes(record.phase)) {
				if (record.phase !== "approved" && record.expiresAt > this.now() && await this.options.isLive(record.request).catch(() => false)) continue;
				await this.options.store.transition(record.approvalId, { phase: record.expiresAt <= this.now() ? "expired" : "cancelled" });
			}
			await this.options.store.discard(record.approvalId);
		}
		return unknown;
	}

	async close(): Promise<void> {
		this.closed = true;
		await this.recovery?.catch(() => undefined);
		for (const entry of this.active.values()) if (!entry.executing) { entry.cancelled = "cancelled"; entry.cancel(); }
		await Promise.allSettled([...this.active.values()].map((entry) => entry.response));
	}

	private async run(id: string, entry: ActiveApproval, cancelled: Promise<void>): Promise<HostResponse> {
		const { request } = entry; let presentation: HostApprovalPresentation | undefined; let timer: ReturnType<typeof setTimeout> | undefined; let ownsConsent = false;
		try {
			let record = this.options.store.get(id);
			if (record && !sameCall(record.request, request)) throw new HostControlError("conflict", "Saved approval has different arguments or origin");
			ownsConsent = Boolean(record);
			if (record?.phase === "accepted") throw uncertain();
			if (record && !["prepared", "presented"].includes(record.phase)) throw new HostControlError("cancelled", "Previous consent cannot be reused; make a new explicit call");
			if (!await this.options.isLive(structuredClone(request))) throw new HostControlError("cancelled", "Requesting tool is no longer live");
			if (!record) record = await this.options.store.prepare(prepareHostApproval(this.options.hostId, request, await this.options.freeze(structuredClone(request)), this.now(), this.options.notificationDisposition?.() ?? "notify"));
			ownsConsent = true;
			for (const effect of record.frozen.effects) if (this.options.policy.decide({ ...request, action: effect }, this.options.protectedConversationId) === "forbidden")
				throw new HostControlError("forbidden", "A frozen effect is forbidden");
			if (entry.cancelled || record.expiresAt <= this.now()) throw new HostControlError(entry.cancelled ?? "expired", "Approval is no longer pending");
			timer = setTimeout(() => { entry.cancelled = "expired"; entry.cancel(); }, Math.max(0, record.expiresAt - this.now())); timer.unref();
			presentation = await this.options.present(structuredClone(record));
			// Attach a handler even if persistence/cancellation prevents awaiting the decision.
			void presentation.decision.catch(() => undefined);
			record = await this.options.store.transition(id, { phase: "presented", presentation: presentation.receipt });
			const decision = await Promise.race([presentation.decision, cancelled.then(() => { throw new HostControlError(entry.cancelled ?? "cancelled", "Approval is no longer pending"); })]);
			if ((decision.voter.kind === "local") !== (request.actor.presentation === "local_dialog")) throw new HostControlError("forbidden", "Approval voter does not match the presentation route");
			if (decision.voter.kind === "matrix" && !this.options.operatorUserIds.has(decision.voter.userId)) throw new HostControlError("forbidden", "Only a configured operator may approve");
			if (entry.cancelled || this.now() >= record.expiresAt) throw new HostControlError(entry.cancelled ?? "expired", "Approval expired or was cancelled");
			record = await this.options.store.transition(id, { phase: decision.choice === "approve" ? "approved" : "denied", decision: { ...decision, at: this.now() } });
			if (decision.choice === "deny") throw new HostControlError("denied", "Denied by operator");
			if (!await this.options.revalidate(structuredClone(record))) throw new HostControlError("stale_preview", "Frozen targets or preconditions changed; make a new explicit call");
			if (!await this.options.isLive(structuredClone(request)) || entry.cancelled) throw new HostControlError("cancelled", "Requesting tool is no longer live");
			if (this.now() >= record.expiresAt) throw new HostControlError("expired", "Approval expired before execution");
			record = await this.options.store.transition(id, { phase: "accepted", acceptedAt: this.now() });
			if (entry.cancelled) throw new HostControlError(entry.cancelled, "Approval was cancelled before execution");
			entry.executing = true; clearTimeout(timer);
			try {
				const data = await this.options.execute(structuredClone(record));
				return parseHostResponse(request.action.operation, { version: HOST_CONTROL_VERSION, requestId: request.actor.requestId, ok: true, data });
			} catch { throw uncertain(); }
		} catch (error) { return hostErrorResponse(request.actor.requestId, error); }
		finally {
			if (timer) clearTimeout(timer);
			await presentation?.close().catch(() => undefined);
			// No retained completed result or automatic execution recovery.
			try {
				const record = ownsConsent ? this.options.store.get(id) : undefined;
				if (record && ["prepared", "presented", "approved"].includes(record.phase)) await this.options.store.transition(id, { phase: entry.cancelled === "expired" ? "expired" : "cancelled" });
				if (record) await this.options.store.discard(id);
			} catch { /* Uncertain cleanup leaves consent consumed; startup never resumes execution. */ }
		}
	}
}
