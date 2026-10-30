import { performance } from "node:perf_hooks";
import { ManagedSessionEnvelopeSchema } from "./contracts.js";

const reasons = ["peer_closed", "socket_error", "local_shutdown", "peer_check_failed", "invalid_frame", "frame_too_large",
	"wrong_peer", "unexpected_reply", "unsolicited_handler_failed", "request_id_limit", "duplicate_id", "invalid_role",
	"connection_handler_failed", "handler_rejected", "attachment_conflict", "connect_failed", "expired_reply_limit", "managed_detach"] as const;
export type DisconnectReason = typeof reasons[number];
export interface ConnectionDiagnostic {
	side: "adapter" | "relay"; reason: DisconnectReason;
	connectionId?: string; conversationId?: string; attachmentId?: string;
	lastSentType?: string; lastReceivedType?: string; failedReceivedType?: string;
	failureCode?: "timeout" | "capacity_reached" | "other";
	sent?: number; received?: number; pending?: number;
}
export type ConnectionDiagnosticSink = (record: ConnectionDiagnostic) => void;
const messageTypes = new Set<string>(ManagedSessionEnvelopeSchema.anyOf.map(shape => shape.properties.type.const));

/** Diagnostics must never change transport behavior, even when a sink fails. */
export function reportConnectionDiagnostic(sink: ConnectionDiagnosticSink | undefined, record: ConnectionDiagnostic): void {
	try { sink?.(record); } catch { /* No diagnostic failure may interrupt cleanup. */ }
}

/** Fixed allowlist and event-driven rate window; no timers or raw error text.
 * At most `limit` detail records plus one suppression summary per window.
 * Suppression keys are fixed side/reason categories, never conversation IDs. */
export function connectionDiagnosticLogger(write: (line: string) => void, limit = 64,
	options: { windowMs?: number; now?: () => number } = {}): ConnectionDiagnosticSink {
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) throw Error("Invalid diagnostic limit");
	const windowMs = options.windowMs ?? 60_000;
	if (!Number.isSafeInteger(windowMs) || windowMs < 1) throw Error("Invalid diagnostic window");
	const now = options.now ?? (() => performance.now());
	let windowStart = now(); let emitted = 0;
	const suppressed = new Map<string, number>();
	const emit = (record: object) => { try { write(`[managed-connection] ${JSON.stringify(record)}`); } catch { /* Best effort only. */ } };
	return input => {
		if (!["adapter", "relay"].includes(input.side) || !reasons.includes(input.reason)) return;
		const time = now();
		if (time - windowStart >= windowMs) {
			if (suppressed.size) emit({ at: new Date().toISOString(), pid: process.pid, event: "suppressed_connections", counts: Object.fromEntries(suppressed) });
			suppressed.clear(); emitted = 0; windowStart = time;
		}
		if (emitted >= limit) {
			const key = `${input.side}:${input.reason}`;
			suppressed.set(key, Math.min(1_000_000, (suppressed.get(key) ?? 0) + 1));
			return;
		}
		const record: Record<string, string | number> = { at: new Date().toISOString(), pid: process.pid, side: input.side, reason: input.reason };
		for (const [key, pattern] of [
			["connectionId", /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/],
			["conversationId", /^conv_[a-f0-9]{32}$/],
			["attachmentId", /^attachment-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/],
		] as const) { const value = input[key]; if (typeof value === "string" && pattern.test(value)) record[key] = value; }
		if (["timeout", "capacity_reached", "other"].includes(input.failureCode ?? "")) record.failureCode = input.failureCode!;
		for (const key of ["lastSentType", "lastReceivedType", "failedReceivedType"] as const) {
			const value = input[key]; if (typeof value === "string" && messageTypes.has(value)) record[key] = value;
		}
		for (const key of ["sent", "received", "pending"] as const) {
			const value = input[key]; if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) record[key] = Math.min(value, 1_000_000);
		}
		emitted++;
		emit(record);
	};
}
