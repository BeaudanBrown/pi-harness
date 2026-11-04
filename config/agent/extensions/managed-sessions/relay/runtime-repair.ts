import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { RelayRegistry } from "./registry.js";
import { HostControlError } from "./host-control-error.js";

export interface RuntimeRepairEvidence {
	/** Digest of validated saved identity/stat and fresh closure observation; no raw paths or PIDs. */
	digest: string;
	closureBasis: "verified_exit" | "operator_attested";
	unreadableCount: number;
}
export interface RuntimeRepairSnapshot {
	target: ReturnType<RelayRegistry["runtimeRepairTarget"]>;
	evidence: RuntimeRepairEvidence;
	heldOperationId?: string;
}
export const runtimeRepairDigest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Shared runtime owner. It never launches, signals, joins, cancels work or releases
 * the durable work hold. The approved orchestration owner supplies consent and
 * decides later queue/membership/open effects. Reload only observes receipts. */
export class RuntimeRepairOwner {
	constructor(private readonly options: {
		registry: RelayRegistry;
		observe: (target: RuntimeRepairSnapshot["target"]) => Promise<RuntimeRepairEvidence>;
	}) {}
	async snapshot(conversationId: string): Promise<RuntimeRepairSnapshot> {
		const target = this.options.registry.runtimeRepairTarget(conversationId);
		const evidence = await this.options.observe(target).catch(() => {
			throw new HostControlError("conflict", "Runtime repair cannot verify saved identity or process closure; inspect the original session and process evidence");
		});
		if (!/^[a-f0-9]{64}$/.test(evidence.digest) || !["verified_exit", "operator_attested"].includes(evidence.closureBasis) ||
			!Number.isInteger(evidence.unreadableCount) || evidence.unreadableCount < 0 || evidence.unreadableCount > 256 ||
			evidence.closureBasis === "verified_exit" && evidence.unreadableCount !== 0)
			throw new HostControlError("conflict", "Malformed runtime repair evidence");
		if (!isDeepStrictEqual(target, this.options.registry.runtimeRepairTarget(conversationId)))
			throw new HostControlError("stale_preview", "Runtime identity changed during inspection");
		const heldOperationId = this.options.registry.heldRuntimeRepairOperation(conversationId);
		return { target, evidence, ...(heldOperationId ? { heldOperationId } : {}) };
	}
	async reconcile(frozen: RuntimeRepairSnapshot, operationId: string, consent: { operatorClosed?: true; acceptIncompleteInspection?: true }): Promise<"reconciled"> {
		const saved = structuredClone(frozen); const { registry } = this.options;
		if (!/^operation_[a-f0-9]{32}$/.test(operationId)) throw new HostControlError("invalid_request", "Invalid repair operation identity");
		if (saved.evidence.closureBasis === "operator_attested" && consent.operatorClosed !== true || saved.evidence.unreadableCount > 0 && consent.acceptIncompleteInspection !== true)
			throw new HostControlError("forbidden", "Runtime repair requires explicit closure and disclosed uncertainty acceptance");
		const prior = registry.runtimeRepairReceipt(saved.target.conversationId, operationId);
		if (prior) {
			if (prior.sourceDigest !== saved.target.sourceDigest || prior.evidenceDigest !== saved.evidence.digest || prior.generationId !== saved.target.generationId || prior.closureBasis !== saved.evidence.closureBasis || prior.unreadableCount !== saved.evidence.unreadableCount)
				throw new HostControlError("stale_preview", "Repair receipt belongs to a different frozen scope");
			// Receipt readback, not replay. No new process or filesystem effects here.
			if (prior.phase === "superseded") throw new HostControlError("stale_preview", "Repair was superseded; inspect the current plan");
			if (prior.phase === "reconciled" || prior.phase === "released") return "reconciled";
		}
		if (!isDeepStrictEqual(await this.snapshot(saved.target.conversationId), prior ? { ...saved, heldOperationId: operationId } : saved))
			throw new HostControlError("stale_preview", "Repair inspection changed; obtain fresh consent");
		await registry.admitRuntimeRepair(saved.target, prior ?? { operationId, generationId: saved.target.generationId,
			sourceDigest: saved.target.sourceDigest, evidenceDigest: saved.evidence.digest, closureBasis: saved.evidence.closureBasis,
			unreadableCount: saved.evidence.unreadableCount, phase: "held", admittedAt: new Date().toISOString() }, saved.heldOperationId);
		// Evidence may change while the durable admission is written. Leave the hold
		// intact on any failure; never turn uncertainty into automatic wake authority.
		if (!isDeepStrictEqual(await this.snapshot(saved.target.conversationId), { ...saved, heldOperationId: operationId }))
			throw new HostControlError("stale_preview", "Repair evidence changed after admission; the durable hold remains");
		await registry.reconcileRuntimeRepair(saved.target, operationId, saved.evidence.digest);
		return "reconciled";
	}
}
