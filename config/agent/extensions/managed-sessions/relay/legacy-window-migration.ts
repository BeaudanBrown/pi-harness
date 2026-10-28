import { isDeepStrictEqual } from "node:util";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { ConversationIdSchema } from "../identity-contracts.js";
import type { HostResult } from "../live-workspace-contracts.js";
import { AtomicJsonFile } from "./atomic-json.js";
import { HostControlError } from "./host-control-error.js";
import type { RelayRegistry } from "./registry.js";

const strict = <T extends Record<string, import("typebox").TSchema>>(properties: T) => Type.Object(properties, { additionalProperties: false });
const EvidenceSchema = strict({ bootId: Type.String({ pattern: "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$" }),
	processes: Type.Array(strict({ pid: Type.String({ pattern: "^[1-9][0-9]{0,19}$" }), startTicks: Type.String({ pattern: "^[0-9]{1,20}$" }) }), { minItems: 1, maxItems: 256 }) });
const IntentSchema = strict({ version: Type.Literal(1), conversationId: ConversationIdSchema,
	generationId: Type.String({ pattern: "^generation_[a-f0-9]{32}$" }), sessionId: Type.String({ minLength: 1, maxLength: 512 }),
	window: strict({ sessionName: Type.String({ minLength: 1, maxLength: 128 }), windowId: Type.String({ pattern: "^@[0-9]+$" }), paneId: Type.String({ pattern: "^%[0-9]+$" }) }),
	evidence: EvidenceSchema });
type Intent = Static<typeof IntentSchema>;
function parseIntent(value: unknown): Intent {
	if (!Check(IntentSchema, value)) throw new HostControlError("conflict", "Legacy migration evidence is invalid; manual investigation is required");
	return value;
}
class LegacyOwnershipError extends HostControlError {
	constructor() {
		super("upgrade_required", "Legacy window ownership cannot be used by stop/start. If the old window exists, use confirmed conversation.migrate BEFORE closing it. If already closed, use conversation.recover.preview and separately confirmed apply. Do not delete the conversation or restart tmux.");
	}
}
export function legacyOwnershipError(): HostControlError { return new LegacyOwnershipError(); }
export function wakeFailureNotice(error: unknown): string {
	return error instanceof LegacyOwnershipError
		? `Queued input is preserved, but launch is blocked. ${error.message}`
		: "Managed conversation wake failed; queued input remains available for retry. Use !status to inspect its state before retrying.";
}

/** Called only under the lifecycle workspace lock and explicit per-call consent.
 * A birth observation is exit evidence, NOT authority to adopt or signal a process.
 * The durable witness survives relay restart, but never grants automatic recovery.
 */
export async function migrateLegacyWindow(options: {
	registry: RelayRegistry; conversationId: string; sessionDirectory: string;
	invoke: (operation: string, request: object) => Promise<Record<string, unknown>>;
	validateSession: () => Promise<void>;
}): Promise<HostResult<"conversation.migrate">> {
	const { registry, conversationId } = options;
	const manifest = registry.registeredConversation(conversationId);
	if (!manifest || registry.retirement(conversationId)) throw new HostControlError("not_found", "Live managed conversation was not found");
	if (manifest.kind !== "project") throw new HostControlError("forbidden", "The protected coordinator cannot be migrated by project recovery");
	if (registry.hasGenerationBoundary(conversationId) || registry.isRefreshing(conversationId) || registry.pendingControls(conversationId).length) throw new HostControlError("busy", "Finish the pending control, generation change or refresh before migration");
	const generation = registry.activeGeneration(manifest);
	const window = registry.managedWindow(conversationId);
	const file = new AtomicJsonFile(join(options.sessionDirectory, conversationId, "legacy-window-migration.json"), parseIntent);
	let intent = await file.read();
	if (intent) {
		const stat = await lstat(file.path);
		if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || process.getuid && stat.uid !== process.getuid()) throw new HostControlError("conflict", "Legacy migration evidence must be a private relay-owned file");
		if (intent.conversationId !== conversationId || intent.generationId !== generation.generationId || intent.sessionId !== generation.piSessionId) throw new HostControlError("conflict", "Legacy migration identity changed; manual investigation is required");
	}
	if (window?.ownership) throw new HostControlError("conflict", "This conversation already has exact ownership; use ordinary lifecycle controls");
	if (registry.launchIdentity(conversationId)) throw new HostControlError("conflict", "An exact launch already exists; legacy migration cannot clear it");
	await options.validateSession(); // Never manufacture missing history during recovery.
	if (!window) {
		if (intent) return { conversationId, migrationState: "ready", message: "Legacy metadata was already cleared. Use !start to resume the same conversation; saved history and room are unchanged." };
		throw new HostControlError("conflict", "No legacy window evidence exists; manual investigation is required");
	}
	const sessionFile = join(options.sessionDirectory, conversationId, generation.ordinal === 1 ? "session.jsonl" : `generation-${generation.ordinal}.jsonl`);
	const observe = async (evidence?: Intent["evidence"]) => {
		try { return await options.invoke("window-legacy-observe", { conversationId, window, sessionFile, ...(evidence ? { evidence } : {}) }); }
		catch { throw new HostControlError("conflict", "Cannot verify the legacy window or its process exit. Leave other windows untouched; manual investigation is required. Do not clear registry files."); }
	};
	const awaitingExit: HostResult<"conversation.migrate"> = {
		conversationId, migrationState: "awaiting_exit", message: "Exit evidence saved. Finish any work, quit Pi and close only this conversation's old tmux window, then repeat confirmed conversation.migrate. No process was stopped; do not restart the tmux session/server.",
	};
	if (!intent) {
		const evidence = await observe();
		if (!Check(EvidenceSchema, evidence)) throw new HostControlError("conflict", "Launcher returned invalid legacy exit evidence");
		intent = { version: 1, conversationId, generationId: generation.generationId, sessionId: generation.piSessionId, window, evidence };
		await file.write(intent);
		return awaitingExit; // A second explicit invocation is required even if it exits now.
	} else if (!isDeepStrictEqual(window, intent.window)) throw new HostControlError("conflict", "Legacy window metadata changed; migration remains blocked");
	const observation = await observe(intent.evidence);
	if (Object.keys(observation).length !== 1 || !["running", "gone"].includes(String(observation.state))) throw new HostControlError("conflict", "Launcher returned invalid legacy exit status");
	if (observation.state !== "gone" || registry.conversationState(conversationId) !== "dormant") return awaitingExit;
	try { await registry.completeLegacyWindowMigration(conversationId, generation.generationId, intent.window); }
	catch { throw new HostControlError("conflict", "Legacy migration target changed or remains active; no metadata was cleared. Inspect its status and retry explicitly."); }
	return { conversationId, migrationState: "ready", message: "Verified exit and cleared stale runtime metadata. Use !start to resume the same conversation with exact ownership. Room, history, generation and queued input are preserved." };
}
