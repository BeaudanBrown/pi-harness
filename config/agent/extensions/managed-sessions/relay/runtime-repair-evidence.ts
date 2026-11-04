import { constants } from "node:fs";
import { open, lstat } from "node:fs/promises";
import { dirname } from "node:path";
import { Check } from "typebox/value";
import { Type } from "typebox";
import { deriveTranscriptEntryId, MANAGED_SESSION_STATE_VERSION, type RegisteredConversation } from "../contracts.js";
import { HostControlError } from "./host-control-error.js";
import { runtimeRepairDigest, type RuntimeRepairEvidence, type RuntimeRepairSnapshot } from "./runtime-repair.js";
import type { ExactWindowClient } from "./exact-window-client.js";

const observationSchema = Type.Object({ conflicts: Type.Boolean(), bootId: Type.String({ pattern: "^[a-f0-9-]{36}$" }),
	unreadableProcesses: Type.Array(Type.String({ pattern: "^[1-9][0-9]{0,19}$" }), { maxItems: 256, uniqueItems: true }) }, { additionalProperties: false });
const conflict = () => new HostControlError("conflict", "Runtime repair cannot verify saved identity or process closure; no observations were cleared");

/** Trusted paths only. Unlike bootstrap this reader never creates, chmods or rewrites history. */
export async function observeRuntimeRepair(options: {
	manifest: RegisteredConversation; target: RuntimeRepairSnapshot["target"]; file: string; cwd: string;
	windows: Pick<ExactWindowClient, "check">;
	observe: (request: object) => Promise<unknown>;
}): Promise<RuntimeRepairEvidence> {
	const { manifest, target, file, cwd } = options;
	const fd = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
	let session: string;
	try {
		const before = await fd.stat({ bigint: true });
		if (!before.isFile() || process.getuid && before.uid !== BigInt(process.getuid())) throw conflict();
		const entries = (await fd.readFile("utf8")).trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
		const header = entries[0];
		const boundaries = entries.filter(e => e.type === "custom" && e.customType === "managed-session.binding-boundary");
		const boundary = boundaries.length === 1 ? boundaries[0] : undefined;
		const data = boundary?.data as Record<string, unknown> | undefined;
		if (header?.type !== "session" || header.id !== manifest.piSessionId || header.cwd !== cwd || typeof boundary?.id !== "string" ||
			data?.version !== MANAGED_SESSION_STATE_VERSION || data.creationKey !== manifest.creationKey || data.concept !== manifest.concept || data.sessionId !== header.id ||
			deriveTranscriptEntryId(manifest.piSessionId, boundary.id) !== manifest.bindingBoundaryEntryId) throw conflict();
		const after = await lstat(file, { bigint: true });
		const statKey = (s: typeof before) => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].map(String);
		if (!after.isFile() || after.isSymbolicLink() || JSON.stringify(statKey(before)) !== JSON.stringify(statKey(after))) throw conflict();
		session = runtimeRepairDigest(statKey(after));
	} catch { throw conflict(); } finally { await fd.close(); }
	const ownership = target.window?.ownership;
	if (ownership && (!ownership.processBootId || ownership.processStartTicks === undefined || await options.windows.check(ownership) !== "gone")) throw conflict();
	const observation = await options.observe({ conversationId: target.conversationId, repairClosure: true, sessionFile: file, sessionDirectory: dirname(file),
		window: target.window ? { sessionName: target.window.sessionName, windowId: target.window.windowId, paneId: target.window.paneId } : null });
	if (!Check(observationSchema, observation) || observation.conflicts) throw conflict();
	// A known exact owner never falls back to attestation when observation is incomplete.
	if (ownership && observation.unreadableProcesses.length) throw conflict();
	return { digest: runtimeRepairDigest({ session, observation }), closureBasis: ownership ? "verified_exit" : "operator_attested",
		unreadableCount: observation.unreadableProcesses.length };
}
