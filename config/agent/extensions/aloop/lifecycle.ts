import { createHash, randomUUID } from "node:crypto";

// Retain the serialized history label; it is not a managed-runtime capability.
export const ALOOP_LIFECYCLE_ENTRY_TYPE = "aloop-managed-lifecycle";
export const MAX_ALOOP_LIFECYCLE_BODY = 1_600;
export type AloopLifecycleKind = "startup" | "startup-failure" | "attempt-settled" | "checkpoint" | "bounded-stop" | "cancelled" | "epic-ready" | "recovery";
export type AloopLifecycleEvent = {
	version: 1; scopeSessionId: string; lifecycleId: string; kind: AloopLifecycleKind;
	epic: number; issue?: number; body: string; timestamp: string;
};

export function sanitizeAloopLifecycleText(body: string): string {
	const commands: string[] = [];
	const protectedBody = body.replace(/\/aloop(?:-[a-z-]+)?(?=\s|$)/g, (command) => { commands.push(command); return `ALOOPCOMMAND${commands.length - 1}`; });
	const redacted = protectedBody
		.replace(/<!--[\s\S]*?-->/g, "•")
		.replace(/pi-aloop-[A-Za-z0-9_:-]+/gi, "•")
		.replace(/(?:receipt|artifact|handoff)[-_][A-Za-z0-9_:-]+/gi, "•")
		.replace(/file:\/\/[^\s<>"']+/gi, "•")
		.replace(/\.pi[\\/]tmp(?:[\\/][^\s<>"']*)?/gi, "•")
		.replace(/(?:verify-[a-f0-9-]+|spool-[A-Za-z0-9_-]+)/gi, "•")
		.replace(/~[A-Za-z0-9._-]*[\\/][^\s<>"']+/g, "•")
		.replace(/[A-Za-z]:[\\/][^\s<>"']+/g, "•")
		.replace(/\\{1,2}[^\s<>"']+/g, "•")
		.replace(/(^|[^A-Za-z0-9_\/])\/(?!\/)[^\s<>"']+/g, "$1•");
	return redacted.replace(/ALOOPCOMMAND(\d+)/g, (_match, index) => commands[Number(index)] ?? "command");
}
export function sanitizeAloopCheckpointText(body: string): string {
	return sanitizeAloopLifecycleText(body).replace(/(^|[\s('"`])(?:\.{1,2}[\\/]|[A-Za-z0-9._-]+[\\/])(?:[A-Za-z0-9._-]+[\\/])*[A-Za-z0-9._-]+/gm, "$1•");
}
export function createAloopLifecycleEvent(kind: AloopLifecycleKind, epic: number, body: string, issue?: number, scopeSessionId = "standalone"): AloopLifecycleEvent {
	if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(scopeSessionId) || !Number.isSafeInteger(epic) || epic < 1 || (issue !== undefined && (!Number.isSafeInteger(issue) || issue < 1))) throw new Error("Aloop lifecycle issue identity is invalid");
	const normalized = sanitizeAloopLifecycleText(body.trim());
	if (!normalized || normalized.length > MAX_ALOOP_LIFECYCLE_BODY) throw new Error("Aloop lifecycle body is invalid or oversized");
	const timestamp = new Date().toISOString();
	const lifecycleId = `aloop_${createHash("sha256").update(`${kind}\0${epic}\0${issue ?? ""}\0${timestamp}\0${randomUUID()}`).digest("hex").slice(0, 32)}`;
	return { version: 1, scopeSessionId, lifecycleId, kind, epic, ...(issue === undefined ? {} : { issue }), body: normalized, timestamp };
}

export function parseAloopLifecycleEvent(value: unknown): AloopLifecycleEvent | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const event = value as Record<string, unknown>;
	if (Object.keys(event).some(key => !["version", "scopeSessionId", "lifecycleId", "kind", "epic", "issue", "body", "timestamp"].includes(key)) ||
		event.version !== 1 || typeof event.scopeSessionId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(event.scopeSessionId) || typeof event.lifecycleId !== "string" || !/^aloop_[a-f0-9]{32}$/.test(event.lifecycleId) ||
		!(["startup", "startup-failure", "attempt-settled", "checkpoint", "bounded-stop", "cancelled", "epic-ready", "recovery"] as unknown[]).includes(event.kind) ||
		!Number.isSafeInteger(event.epic) || Number(event.epic) < 1 ||
		(event.issue !== undefined && (!Number.isSafeInteger(event.issue) || Number(event.issue) < 1)) ||
		typeof event.body !== "string" || !event.body.trim() || event.body.length > MAX_ALOOP_LIFECYCLE_BODY || sanitizeAloopLifecycleText(event.body) !== event.body ||
		typeof event.timestamp !== "string" || event.timestamp.length < 20 || event.timestamp.length > 35) return undefined;
	return event as AloopLifecycleEvent;
}

// In-process native-session hooks only. No persistence, host operations, effects
// or lifecycle projection. The adapter owns checkpoint eligibility and fencing.
const checkpoints = new Map<string, (toolCallId: string, checkpoint: Record<string, unknown>) => Promise<void>>();
const aborts = new Map<string, () => void>();
export function registerAloopCheckpointDelegate(scope: string, delegate: (toolCallId: string, checkpoint: Record<string, unknown>) => Promise<void>): () => void {
	checkpoints.set(scope, delegate);
	return () => { if (checkpoints.get(scope) === delegate) checkpoints.delete(scope); };
}
export async function delegateAloopCheckpoint(scope: string, call: string, checkpoint: Record<string, unknown>): Promise<boolean> {
	const delegate = checkpoints.get(scope);
	if (!delegate) return false;
	await delegate(call, checkpoint); return true;
}
export function registerAloopAbortDelegate(scope: string, delegate: () => void): () => void {
	aborts.set(scope, delegate);
	return () => { if (aborts.get(scope) === delegate) aborts.delete(scope); };
}
export function cancelAloop(scope: string): boolean {
	const delegate = aborts.get(scope);
	if (!delegate) return false;
	delegate(); return true;
}
