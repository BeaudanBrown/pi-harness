import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { RelayRegistry } from "./registry.js";
import type { RuntimeRepairOwner, RuntimeRepairSnapshot } from "./runtime-repair.js";
import type { HostAccountOwner } from "./host-account-owner.js";
import type { MembershipRepairPlan } from "./membership-repair.js";
import { freezeJsonChunks, staleHostPreview } from "./host-preview-store.js";
import { HostControlError } from "./host-control-error.js";

export interface ConversationRepairPlan {
 source: ReturnType<RelayRegistry["conversationRepairSource"]>;
 expiresAt: number;
 runtime?: RuntimeRepairSnapshot;
 account?: MembershipRepairPlan;
 blockers: string[];
 warnings: string[];
}
/** One approved repair, not a queue-management wizard. Pending work is preserved,
 * no Pi launcher is invoked, and restart never automatically replays an approval. */
export class ConversationRepairOwner {
 private readonly running = new Map<string, Promise<void>>();
 private readonly stop = new AbortController();
 constructor(private readonly options: { registry: RelayRegistry; runtime: RuntimeRepairOwner; account: Pick<HostAccountOwner, "freezeRoomMembership" | "restoreRoomMembership">; now?: () => number }) {}
 private now(): number { return (this.options.now ?? Date.now)(); }
 async preview(conversationId: string): Promise<ConversationRepairPlan> {
  const { registry } = this.options;
  const source = registry.conversationRepairSource(conversationId);
  const plan: ConversationRepairPlan = { source, expiresAt: this.now() + 300_000, blockers: [], warnings: [
   "Repair preserves pending work and arrivals during repair. It does not replay, abandon or successfully complete that work. Queue decisions remain separate.",
   "No Pi process will be launched or stopped. An existing running session is preserved; repaired dormant sessions remain dormant.",
  ] };
  plan.blockers.push(...registry.conversationRepairObligations(conversationId));
  if (source.runtimeRepair) {
   try {
    plan.runtime = await this.options.runtime.snapshot(conversationId);
    if (plan.runtime.evidence.closureBasis === "operator_attested") plan.warnings.push("Applying requires an explicit attestation that the old Pi process was closed; absence of attachment is not exit proof.");
    if (plan.runtime.evidence.unreadableCount) plan.warnings.push(`${plan.runtime.evidence.unreadableCount} processes were unreadable; applying requires explicit acceptance of that inspection uncertainty.`);
   } catch { plan.blockers.push("Runtime closure evidence is unavailable or conflicting. Inspect the original process and saved session; do not clear launch reservations manually."); }
  }
  try {
   plan.account = await this.options.account.freezeRoomMembership(conversationId);
   if (plan.account.member.membership !== "join" || plan.account.departureEventId) plan.warnings.push(`Reconcile operator access to the original room ${plan.account.identity.roomId}, including invitation/join if needed. No replacement room, unban or notification-policy change is permitted.`);
  }
  catch (error) {
   const message = error instanceof Error ? error.message : "";
   plan.blockers.push(/terminal|not restorable/.test(message) ? "The original room is terminal and cannot be restored; repair cannot create a replacement." :
    /unconfirmed/.test(message) ? "NAS repair support is unconfirmed. Wait for the read-only account inspection, check connectivity or upgrade NAS, then obtain a fresh preview." :
    "Resolve original-room provenance, account permission or current membership evidence externally. Bans and unknown evidence cannot be overridden.");
  }
  if (!isDeepStrictEqual(source, registry.conversationRepairSource(conversationId))) throw staleHostPreview();
  const facts = registry.repairRuntimeFacts(conversationId)!;
  plan.warnings.push("An already running Pi may finish prior work and publish new output during account repair; repair does not stop it or undo prior effects. Pending outputs already observed remain held.");
  plan.warnings.push(`Preserved pending work observed: ${facts.queues.inputs} inputs, ${facts.queues.controls} controls, ${facts.queues.outputs} outputs. No queue-management choice is required.`);
  return plan;
 }
 async valid(plan: ConversationRepairPlan): Promise<boolean> {
  if (this.stop.signal.aborted || plan.expiresAt <= this.now() || plan.blockers.length) return false;
  try {
   if (!isDeepStrictEqual(plan.source, this.options.registry.conversationRepairSource(plan.source.conversationId)) || this.options.registry.conversationRepairObligations(plan.source.conversationId).length) return false;
   if (plan.runtime && !isDeepStrictEqual(plan.runtime, await this.options.runtime.snapshot(plan.source.conversationId))) return false;
   return Boolean(plan.account && isDeepStrictEqual(plan.account, await this.options.account.freezeRoomMembership(plan.source.conversationId)));
  } catch { return false; }
 }
 async apply(plan: ConversationRepairPlan, operationId: string, consent: { operatorClosed?: true; acceptIncompleteInspection?: true }): Promise<void> {
  const frozen = structuredClone(plan);
  if (!await this.valid(frozen)) throw staleHostPreview();
  if (frozen.runtime && (frozen.runtime.evidence.closureBasis === "operator_attested" && consent.operatorClosed !== true || frozen.runtime.evidence.unreadableCount > 0 && consent.acceptIncompleteInspection !== true))
   throw new HostControlError("forbidden", "Explicit process closure and any disclosed inspection uncertainty must be accepted");
  const planJson = freezeJsonChunks(frozen), at = new Date(this.now()).toISOString();
  await this.options.registry.admitConversationRepair(frozen.source, { operationId, generationId: frozen.source.generationId,
   runtimeRepair: Boolean(frozen.runtime), expiresAt: frozen.expiresAt, planJson, planDigest: createHash("sha256").update(planJson.join("")).digest("hex"), phase: "held", admittedAt: at, updatedAt: at });
  // Do not block the Matrix sync/approval intake while waiting for NAS acknowledgements.
  // This live invocation may progress its already-approved bounded effects; startup does not recreate it.
  const work = this.progress(frozen, operationId, consent).catch(() => { /* Durable hold/phase remains; fresh preview exposes recovery obligations. */ });
  this.running.set(operationId, work); void work.finally(() => this.running.delete(operationId));
 }
 private current(plan: ConversationRepairPlan, operationId: string): void {
  this.stop.signal.throwIfAborted();
  const source = this.options.registry.conversationRepairSource(plan.source.conversationId);
  const receipt = this.options.registry.conversationRepairReceipt(plan.source.conversationId);
  if (source.sourceDigest !== plan.source.sourceDigest || source.generationId !== plan.source.generationId || receipt?.operationId !== operationId || plan.expiresAt <= this.now()) throw staleHostPreview();
 }
 private async progress(plan: ConversationRepairPlan, operationId: string, consent: { operatorClosed?: true; acceptIncompleteInspection?: true }): Promise<void> {
  const id = plan.source.conversationId;
  this.current(plan, operationId);
  await this.options.registry.advanceConversationRepair(id, operationId, "account_pending");
  if (plan.account) {
   let ready = false;
   // Account transport is queued independently. Keep this live invocation
   // within its original frozen deadline, not an unrelated thirty-poll budget.
   while (!ready) {
    this.current(plan, operationId);
    try { ready = (await this.options.account.restoreRoomMembership(plan.account, operationId, plan.expiresAt)).setupState === "ready"; }
    catch (error) { if (!(error instanceof Error) || !/unconfirmed/.test(error.message)) throw error; }
    this.current(plan, operationId);
    if (!ready) await new Promise<void>(resolve => { const timer = setTimeout(done, Math.min(1000, Math.max(0, plan.expiresAt - this.now()))); const signal = this.stop.signal;
     function done() { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); }
     signal.addEventListener("abort", done, { once: true }); if (signal.aborted) done(); });
   }
  }
  this.current(plan, operationId);
  await this.options.registry.advanceConversationRepair(id, operationId, "runtime_pending");
  if (plan.runtime) await this.options.runtime.reconcile(plan.runtime, operationId, consent);
  this.current(plan, operationId);
  const access = await this.options.account.freezeRoomMembership(id);
  if (!plan.account || !isDeepStrictEqual(access.identity, plan.account.identity) || access.member.membership !== "join" || access.departureEventId) throw staleHostPreview();
  this.current(plan, operationId);
  await this.options.registry.advanceConversationRepair(id, operationId, "complete");
 }
 isRunning(operationId: string): boolean { return this.running.has(operationId); }
 async drain(): Promise<void> { await Promise.all(this.running.values()); }
 async close(): Promise<void> { this.stop.abort(); await this.drain(); }
}
