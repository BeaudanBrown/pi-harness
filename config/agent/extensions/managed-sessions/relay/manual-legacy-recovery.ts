import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { join } from "node:path";
import { lstat } from "node:fs/promises";
import { Check } from "typebox/value";
import { Type } from "typebox";
import { AtomicJsonFile } from "./atomic-json.js";
import { HostControlError } from "./host-control-error.js";
import type { RelayRegistry } from "./registry.js";

const observationSchema = Type.Object({ conflicts: Type.Boolean(), bootId: Type.String({ pattern: "^[a-f0-9-]{36}$" }),
	unreadableProcesses: Type.Array(Type.String({ pattern: "^[1-9][0-9]{0,19}$" }), { maxItems: 256, uniqueItems: true }) }, { additionalProperties: false });
type Window = { sessionName: string; windowId: string; paneId: string; serverId?: string };
export interface ManualRecoverySnapshot {
	conversationId: string; mode: "recover" | "retired_cleanup"; generationId: string; window: Window;
	retirementId?: string; effectId?: string; identityDigest?: string;
	session?: { id: string; ordinal: number; size: string; mtimeNs: string; ino: string };
	observation: { conflicts: boolean; bootId: string; unreadableProcesses: string[] };
}
export interface ManualRecoveryOptions {
	registry: RelayRegistry; sessionDirectory: string;
	attached: (id: string) => boolean;
	invoke: (operation: string, request: object) => Promise<Record<string, unknown>>;
	validateSession: (id: string) => Promise<void>;
}
const conflict = (message: string) => new HostControlError("conflict", message);

/** An observation is only a conflict screen, never proof that an old writer exited. */
export async function manualRecoverySnapshot(options: ManualRecoveryOptions, conversationId: string): Promise<ManualRecoverySnapshot> {
	const { registry } = options;
	if (options.attached(conversationId)) throw conflict("An adapter is attached; manual recovery is blocked");
	const retired = registry.retirement(conversationId);
	let snapshot: Omit<ManualRecoverySnapshot, "observation">;
	if (retired) {
		const stop = retired.cleanup?.find(effect => effect.kind === "stop");
		if (!stop || stop.kind !== "stop" || stop.phase === "done" || !stop.window || stop.window.ownership || stop.unresolvedLaunch || stop.unresolvedBinding)
			throw conflict("No eligible legacy retirement stop obligation exists");
		snapshot = { conversationId, mode: "retired_cleanup", generationId: stop.generationId, retirementId: retired.retirementId, effectId: stop.effectId,
			window: structuredClone(stop.window) };
	} else {
		const manifest = registry.registeredConversation(conversationId);
		if (!manifest || manifest.kind !== "project") throw conflict("Manual recovery requires an existing project conversation");
		const window = registry.managedWindow(conversationId);
		const promotion = registry.promotion(conversationId);
		if (promotion) throw conflict("Finish pending promotion before manual recovery");
		if (!window || window.ownership || registry.launchIdentity(conversationId) || registry.conversationState(conversationId) !== "dormant" ||
			registry.hasGenerationBoundary(conversationId) || registry.isRefreshing(conversationId) || registry.pendingControls(conversationId).length)
			throw conflict("Manual recovery requires a dormant legacy window with no launch or pending lifecycle work");
		const generation = registry.activeGeneration(manifest);
		await options.validateSession(conversationId);
		const path = join(options.sessionDirectory, conversationId, generation.ordinal === 1 ? "session.jsonl" : `generation-${generation.ordinal}.jsonl`);
		const stat = await lstat(path, { bigint: true });
		if (!stat.isFile() || stat.isSymbolicLink()) throw conflict("Saved history is not a regular file");
		snapshot = { conversationId, mode: "recover", generationId: generation.generationId,
			window: structuredClone(window), identityDigest: createHash("sha256").update(JSON.stringify(manifest)).digest("hex"),
			session: { id: generation.piSessionId, ordinal: generation.ordinal, size: String(stat.size), mtimeNs: String(stat.mtimeNs), ino: String(stat.ino) } };
	}
	let observation: Record<string, unknown>;
	try { observation = await options.invoke("window-legacy-observe", { conversationId, window: { sessionName: snapshot.window.sessionName, windowId: snapshot.window.windowId, paneId: snapshot.window.paneId },
		sessionDirectory: join(options.sessionDirectory, conversationId), manualClosure: true }); }
	catch { throw conflict("Manual recovery inspection failed; no metadata was changed"); }
	if (!Check(observationSchema, observation)) throw conflict("Invalid manual recovery observation");
	if (observation.conflicts) throw conflict("A matching process, pane or window still exists; manual recovery is blocked");
	return { ...snapshot, observation };
}

/** Called under lifecycle serialization with a freshly approved frozen snapshot.
 * The receipt records attestation, NOT completion or automatically verified exit.
 * Startup never replays it. Interruption before commit requires fresh consent.
 */
export async function applyManualRecovery(options: ManualRecoveryOptions, frozen: ManualRecoverySnapshot, operationId: string): Promise<void> {
	if (!/^operation_[a-f0-9]{32}$/.test(operationId)) throw conflict("Invalid recovery operation identity");
	const current = await manualRecoverySnapshot(options, frozen.conversationId);
	if (!isDeepStrictEqual(current, frozen)) throw new HostControlError("stale_preview", "Recovery target or inspection changed; obtain a new preview and consent");
	const receipt = { version: 1, closureBasis: "operator_confirmed", statement: "Operator confirms old Pi was closed and accepts disclosed inspection uncertainty",
		operationId, recordedAt: new Date().toISOString(), snapshot: frozen };
	await new AtomicJsonFile(join(options.sessionDirectory, frozen.conversationId, `manual-recovery-${operationId}.json`), value => value).write(receipt);
	// An audit write can yield to attachment/lifecycle work. Recheck before commit.
	if (!isDeepStrictEqual(await manualRecoverySnapshot(options, frozen.conversationId), frozen))
		throw new HostControlError("stale_preview", "Recovery target changed after attestation; no automatic retry is authorized");
	if (frozen.mode === "recover") await options.registry.completeLegacyWindowMigration(frozen.conversationId, frozen.generationId, frozen.window, frozen.identityDigest);
	else await options.registry.markRetirementCleanup(frozen.conversationId, frozen.effectId!, "done");
}
