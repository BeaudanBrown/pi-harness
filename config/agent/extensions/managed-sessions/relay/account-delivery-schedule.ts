import type { AccountAction, AccountAck } from "../live-workspace-contracts.js";

/** Scheduling hints are never effect authority; callers supply only eligible work. */
export interface DeliveryTiming { nextAt: number; attempts: number; demand?: true }
export interface SchedulableAccountRecord {
 action: AccountAction; ack?: AccountAck; ackAt?: number; sentAt?: number; delivery?: DeliveryTiming;
}
type Lane = "control" | "interactive" | "ordinary" | "maintenance";
const turns: readonly Lane[] = ["control", "interactive", "interactive", "ordinary", "maintenance"];
export function maintenanceDelay(record: SchedulableAccountRecord): number {
 return 60_000 + Number.parseInt(record.action.requestId.slice(-4), 16) % 15_001;
}
export function deliveryDue(record: SchedulableAccountRecord): number {
 return record.delivery?.nextAt ?? (record.sentAt === undefined ? 0 : record.sentAt + (record.ack?.status === "complete" ? maintenanceDelay(record) : 30_000));
}
function lane(record: SchedulableAccountRecord): Lane {
 if (record.delivery?.demand) return "interactive";
 if (record.ack?.code === "unverified" || record.ack?.status === "complete" || (record.sentAt !== undefined && !record.ack)) return "maintenance";
 const op = record.action.operation;
 if (op === "room.retire" || op === "space.retire" || op === "room.membership.cancel") return "control";
 if (op.startsWith("room.membership.") || op === "coordinator.membership.restore") return "interactive";
 return "ordinary";
}
export function attemptedTiming(record: SchedulableAccountRecord, now: number): DeliveryTiming {
 const attempts = Math.min(8, (record.delivery?.attempts ?? 0) + 1);
 return { attempts, nextAt: now + (record.ack?.status === "complete" ? maintenanceDelay(record) : Math.min(300_000, 30_000 * 2 ** (attempts - 1))) };
}
/** Weighted service prevents completed maintenance or a busy foreground dominating. */
export class AccountDeliverySchedule {
 private turn = 0;
 select<T extends SchedulableAccountRecord>(eligible: readonly T[], now: number): T | undefined {
  const due = eligible.filter(r => deliveryDue(r) <= now).sort((a, b) => (a.sentAt ?? -1) - (b.sentAt ?? -1) || a.action.requestId.localeCompare(b.action.requestId));
  for (let i = 0; i < turns.length; i++) {
   const index = (this.turn + i) % turns.length;
   const record = due.find(r => lane(r) === turns[index]);
   if (record) { this.turn = (index + 1) % turns.length; return record; }
  }
  return undefined;
 }
}
export { DeliveryWake } from "../../matrix-shared/delivery-wake.js";
