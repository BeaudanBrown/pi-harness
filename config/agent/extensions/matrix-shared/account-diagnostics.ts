import { Type, type Static } from "typebox";

export const ACCOUNT_WORK_CLASSES = ["control", "interactive", "ordinary", "maintenance", "acknowledgement"] as const;
export type AccountWorkClass = typeof ACCOUNT_WORK_CLASSES[number];
const count = Type.Integer({ minimum: 0, maximum: 32768 });
const duration = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const progress = Type.Object({ unverified: count, admitted: count, joinObserved: count, conflict: count, departed: count, unsupportedEncryption: count }, { additionalProperties: false });
const row = <T extends AccountWorkClass>(kind: T) => Type.Object({ kind: Type.Literal(kind), due: count, parked: count, blocked: count, settled: count, inFlight: count,
 oldestDueAgeMs: Type.Optional(duration), nextRetryInMs: Type.Optional(duration), progress }, { additionalProperties: false });
export const AccountSchedulingDiagnosticsSchema = Type.Object({ observedAt: duration,
 state: Type.Union([Type.Literal("running"), Type.Literal("idle"), Type.Literal("suspended"), Type.Literal("unavailable")]),
 cooldownMs: duration, classes: Type.Tuple([row("control"), row("interactive"), row("ordinary"), row("maintenance"), row("acknowledgement")]) }, { additionalProperties: false });
export type AccountSchedulingDiagnostics = Static<typeof AccountSchedulingDiagnosticsSchema>;
export type AccountDiagnosticItem = { kind: AccountWorkClass; state: "due" | "parked" | "blocked" | "settled" | "inFlight"; dueAt?: number; progress?: string };
const bounded = (value: number) => Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value)));
/** Aggregate only. No action, identity, payload, path or arbitrary reason text is returned. */
export function accountSchedulingDiagnostics(now: number, state: AccountSchedulingDiagnostics["state"], cooldownUntil: number, items: readonly AccountDiagnosticItem[]): AccountSchedulingDiagnostics {
 const empty = <T extends AccountWorkClass>(kind: T) => ({ kind, due: 0, parked: 0, blocked: 0, settled: 0, inFlight: 0,
  progress: { unverified: 0, admitted: 0, joinObserved: 0, conflict: 0, departed: 0, unsupportedEncryption: 0 } });
 const classes: AccountSchedulingDiagnostics["classes"] = [empty("control"), empty("interactive"), empty("ordinary"), empty("maintenance"), empty("acknowledgement")];
 for (const item of items) {
  const row = classes.find(r => r.kind === item.kind)!; row[item.state]++;
  if (item.state === "due" && item.dueAt !== undefined) row.oldestDueAgeMs = Math.max(row.oldestDueAgeMs ?? 0, bounded(now - item.dueAt));
  if (item.state === "parked" && item.dueAt !== undefined) row.nextRetryInMs = Math.min(row.nextRetryInMs ?? Number.MAX_SAFE_INTEGER, bounded(Math.max(item.dueAt, cooldownUntil) - now));
  switch (item.progress) {
   case "unverified": row.progress.unverified++; break;
   case "admitted": row.progress.admitted++; break;
   case "join_observed": row.progress.joinObserved++; break;
   case "conflict": row.progress.conflict++; break;
   case "departed": row.progress.departed++; break;
   case "unsupported_encryption": row.progress.unsupportedEncryption++; break;
  }
 }
 return { observedAt: bounded(now), state, cooldownMs: bounded(cooldownUntil - now), classes };
}
