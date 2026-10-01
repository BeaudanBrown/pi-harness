import { createHash, randomUUID } from "node:crypto";
import type { ManagedSessionEnvelope } from "../contracts.js";
import { parseHostRunWitness, type HostRunWitness } from "../host-run-contracts.js";
import type { BoundAdapterClient } from "./client.js";

type Sources = HostRunWitness["sources"];
type Dialog = { controller: AbortController; toolCallId: string };
/** Ephemeral native run/tool identity. Neither model parameters nor saved transcripts establish liveness. */
export class NativeHostRun {
	private run?: { generationId: string; runId: string; tools: Map<string, string>; users: number; overflow: boolean };
	private inherited: Sources = [];
	private detachAbort?: () => void;
	private readonly dialogs = new Map<string, Dialog>();
	private dialogWork: Promise<void> = Promise.resolve();
	private queued?: HostRunWitness;
	private publishing = false;
	constructor(private readonly options: {
		client(): BoundAdapterClient | undefined;
		sources(userMessageCount: number): Sources;
		confirm(question: string, signal: AbortSignal, timeout: number): Promise<boolean>;
	}) {}

	begin(generationId: string, signal?: AbortSignal): void {
		this.end(); this.run = { generationId, runId: `run-${randomUUID()}`, tools: new Map(), users: 0, overflow: false };
		if (signal?.aborted) { this.end(); return; }
		if (signal) { const abort = () => this.end(); signal.addEventListener("abort", abort, { once: true }); this.detachAbort = () => signal.removeEventListener("abort", abort); }
		this.publish();
	}
	userMessage(): void { if (this.run) this.run.users++; }
	toolStart(toolCallId: string): void {
		if (!this.run) return;
		if (this.run.tools.size >= 64) { this.run.overflow = true; return; }
		this.run.tools.set(toolCallId, `tool-${createHash("sha256").update(toolCallId).digest("hex").slice(0, 32)}`); this.publish();
	}
	toolEnd(toolCallId: string): void {
		const id = this.run?.tools.get(toolCallId); this.run?.tools.delete(toolCallId);
		for (const dialog of this.dialogs.values()) if (dialog.toolCallId === id) dialog.controller.abort();
		this.publish();
	}
	end(): void {
		this.detachAbort?.(); this.detachAbort = undefined;
		const witness = this.snapshot(); if (witness) { this.inherited = witness.sources; this.enqueue({ ...witness, phase: "ended", toolCallIds: [] }); }
		this.run = undefined; for (const dialog of this.dialogs.values()) dialog.controller.abort();
	}
	reset(): void { this.end(); this.inherited = []; }
	snapshot(): HostRunWitness | null {
		if (!this.run || this.run.overflow) return null;
		try {
			return parseHostRunWitness({ generationId: this.run.generationId, runId: this.run.runId, phase: "active",
				sources: this.run.users > 32 ? [] : this.run.users ? this.options.sources(this.run.users) : this.inherited,
				toolCallIds: [...this.run.tools.values()] });
		} catch { return null; }
	}
	identity(toolCallId: string): { generationId: string; runId: string; toolCallId: string } | undefined {
		const witness = this.snapshot(); const id = this.run?.tools.get(toolCallId);
		return witness && id ? { generationId: witness.generationId, runId: witness.runId, toolCallId: id } : undefined;
	}
	/** Returns promptly for dialogs so fresh proof requests cannot queue behind UI waits. */
	async receive(envelope: ManagedSessionEnvelope): Promise<boolean> {
		const client = this.options.client(); if (!client?.supports("approval-v1")) return false;
		if (envelope.type === "host.run.check") { await client.confirmHostRun(String(envelope.payload.checkId), this.snapshot()); return true; }
		if (envelope.type === "host.approval.close") { this.dialogs.get(String(envelope.payload.approvalId))?.controller.abort(); return true; }
		if (envelope.type !== "host.approval.show") return false;
		const input = structuredClone(envelope.payload) as { approvalId: string; generationId: string; runId: string; toolCallId: string; question: string; expiresAt: number };
		if (this.dialogs.has(input.approvalId) || this.dialogs.size >= 64) return true;
		const controller = new AbortController(); this.dialogs.set(input.approvalId, { controller, toolCallId: input.toolCallId });
		const matches = () => {
			const witness = this.snapshot();
			return !controller.signal.aborted && this.options.client() === client && witness?.generationId === input.generationId && witness.runId === input.runId &&
				witness.toolCallIds.includes(input.toolCallId) && witness.sources.length > 0 && witness.sources.every((source) => source.kind === "local") && Date.now() < input.expiresAt;
		};
		this.dialogWork = this.dialogWork.then(async () => {
			if (!matches()) return;
			let choice: "approve" | "deny" | "unavailable";
			try { choice = await this.options.confirm(input.question, controller.signal, input.expiresAt - Date.now()) ? "approve" : "deny"; }
			catch { choice = "unavailable"; }
			if (matches()) await client.answerHostApproval({ approvalId: input.approvalId, generationId: input.generationId, runId: input.runId, toolCallId: input.toolCallId, choice });
		}).catch(() => undefined).finally(() => { this.dialogs.delete(input.approvalId); });
		return true;
	}
	private publish(): void { const witness = this.snapshot(); if (witness) this.enqueue(witness); }
	private enqueue(witness: HostRunWitness): void {
		this.queued = witness; if (this.publishing) return;
		this.publishing = true;
		void (async () => {
			try { while (this.queued) { const next = this.queued; this.queued = undefined; const client = this.options.client(); if (client?.supports("approval-v1")) await client.observeHostRun(next).catch(() => undefined); } }
			finally { this.publishing = false; }
		})();
	}
}
