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

/** Fixed allowlist, bounded process-local output. No raw errors, frames, paths,
 * bodies, request IDs, nonces or tokens. Unrecognized fields are discarded. */
export function connectionDiagnosticLogger(write: (line: string) => void, limit = 64): ConnectionDiagnosticSink {
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) throw Error("Invalid diagnostic limit");
	let emitted = 0;
	return input => {
		if (emitted >= limit || !["adapter", "relay"].includes(input.side) || !reasons.includes(input.reason)) return;
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
		try { write(`[managed-connection] ${JSON.stringify(record)}`); } catch { /* Best effort only. */ }
	};
}
