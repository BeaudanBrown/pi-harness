import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import type { RelayRegistry } from "./registry.js";
import type { ArchiveSource } from "./archive-store.js";
import type { ExactWindowClient } from "./exact-window-client.js";
import { HostControlError } from "./host-control-error.js";

export const ArchiveClosureReceiptSchema = Type.Object({
	incompleteInspection: Type.Optional(Type.Object({ accepted: Type.Literal(true), unreadableCount: Type.Integer({ minimum: 1, maximum: 256 }), unreadableDigest: Type.String({ pattern: "^[a-f0-9]{64}$" }) }, { additionalProperties: false })),
	basis: Type.Union([Type.Literal("exact_exit"), Type.Literal("operator_attested")]),
	operationId: Type.Optional(Type.String({ pattern: "^operation_[a-f0-9]{32}$" })),
	windowDigest: Type.String({ pattern: "^[a-f0-9]{64}$" }), checkedAt: Type.String({ format: "date-time" }),
	bootId: Type.Optional(Type.String({ pattern: "^[a-f0-9-]{36}$" })),
}, { additionalProperties: false });
export type ArchiveClosure = { window: ReturnType<RelayRegistry["managedWindow"]>; receipt: Static<typeof ArchiveClosureReceiptSchema> };
const observation = Type.Object({ conflicts: Type.Boolean(), bootId: Type.String({ pattern: "^[a-f0-9-]{36}$" }),
	unreadableProcesses: Type.Array(Type.String({ pattern: "^[1-9][0-9]*$", maxLength: 20 }), { maxItems: 256, uniqueItems: true }) }, { additionalProperties: false });
const blocked = (message: string) => new HostControlError("conflict", message);
/** Read-only runtime evidence, never stop/launch/queue cancellation or workspace lookup. */
export class ArchiveRuntimeChecks {
	constructor(private readonly options: { registry: RelayRegistry; attached: (id: string) => boolean;
		exact: Pick<ExactWindowClient, "check" | "inspect">;
		observeLegacy: (id: string, window: ArchiveClosure["window"]) => Promise<unknown> }) {}
	async inspect(source: ArchiveSource, legacyClosure = false, signal?: AbortSignal, acceptIncompleteInspection = false): Promise<ArchiveClosure> {
		if (acceptIncompleteInspection && !legacyClosure) throw blocked("Incomplete inspection acceptance requires legacyClosure");
		signal?.throwIfAborted(); const id = source.conversationId; const registry = this.options.registry;
		const archive = registry.archiveRecord(id);
		if (this.options.attached(id) || !archive && registry.conversationState(id) !== "dormant") throw blocked("Finish and close the running conversation before archiving");
		const window = archive ? registry.archiveClosureWindow(id) : structuredClone(registry.managedWindow(id)); const proof = window?.ownership;
		let basis: ArchiveClosure["receipt"]["basis"]; let bootId: string | undefined;
		let incompleteInspection: ArchiveClosure["receipt"]["incompleteInspection"];
		if (proof?.processBootId && proof.processStartTicks !== undefined) {
			if (await this.options.exact.check(proof) !== "gone" || await this.options.exact.inspect(id)) throw blocked("Exact runtime closure is conflicting or unverified");
			basis = "exact_exit"; bootId = proof.processBootId;
		} else {
			if (!legacyClosure) throw blocked("No exact exit evidence. Request a legacyClosure preview only if the operator can explicitly confirm the old Pi was closed");
			let value: unknown;
			try { value = await this.options.observeLegacy(id, window); } catch { throw blocked("Legacy closure inspection unavailable; no archive admission"); }
			if (!Check(observation, value)) throw blocked("Legacy closure inspection is malformed; no archive admission");
			if (value.conflicts) throw blocked("Legacy closure inspection is conflicting or incomplete: known conflict blocks archival");
			if (value.unreadableProcesses.length) {
				if (!acceptIncompleteInspection) throw blocked(`Legacy closure inspection is conflicting or incomplete: ${value.unreadableProcesses.length} unreadable process environments; explicit incomplete-inspection acceptance is required`);
				incompleteInspection = { accepted: true, unreadableCount: value.unreadableProcesses.length,
					unreadableDigest: createHash("sha256").update(JSON.stringify([value.bootId, [...value.unreadableProcesses].sort()])).digest("hex") };
			}
			basis = "operator_attested"; bootId = value.bootId;
		}
		signal?.throwIfAborted();
		if (this.options.attached(id)) throw blocked("Conversation attached during archive inspection");
		if (archive && !isDeepStrictEqual(window, registry.archiveClosureWindow(id))) throw blocked("Retained archive runtime identity changed during inspection");
		const current = archive ? { source: archive.source, blockers: [] } : registry.archiveCandidate(id, window);
		if (current.blockers.length) throw blocked(current.blockers.join("; "));
		if (!isDeepStrictEqual(current.source, source)) throw blocked("Archive generation or historical identity changed during inspection");
		return { window, receipt: { basis, ...(incompleteInspection ? { incompleteInspection } : {}), windowDigest: createHash("sha256").update(JSON.stringify(window ?? null)).digest("hex"), checkedAt: new Date().toISOString(), ...(bootId ? { bootId } : {}) } };
	}
}
