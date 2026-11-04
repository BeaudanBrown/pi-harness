import type { HostRepairInspection } from "../live-workspace-contracts.js";
import { hasMatrixBinding } from "../contracts.js";
import { HostControlError } from "./host-control-error.js";
import type { RelayRegistry } from "./registry.js";

type Membership = "join" | "leave" | "invite" | "ban" | "knock" | "unknown";
type Setup = "pending" | "ready" | "notification_setup_uncertain";
export interface RepairRuntimeFacts {
	state: "starting" | "active" | "dormant";
	attached: boolean; legacyWindow: boolean; unobservedLaunch: boolean; repairHeld: boolean;
	queues: { inputs: number; controls: number; outputs: number };
	lifecycleObligations: boolean;
}
/** Read-only seam: no launcher, writer, account request or approval authority.
 * These observations are advisory, not a coherent frozen repair scope or exit proof. */
export class ConversationRepairInspection {
	constructor(private readonly options: {
		registry: Pick<RelayRegistry, "retirement" | "archiveRecord" | "registeredConversation" | "repairRuntimeFacts" | "activeGeneration">;
		matrixReady: () => boolean;
		accountSetup: (id: string) => Setup;
		membership: (roomId: string) => Promise<Membership>;
		repairProgress?: (id: string) => { operationId: string; phase: "held" | "account_pending" | "runtime_pending" | "complete" | "superseded"; live: boolean } | undefined;
	}) {}

	private terminal(conversationId: string): HostRepairInspection | undefined {
		const authority = this.options.registry.retirement(conversationId) ? "retired" : this.options.registry.archiveRecord(conversationId) ? "archived" : undefined;
		return authority ? { conversationId, authority, readiness: "not_verified", findings: [{ code: "terminal_identity",
			nextStep: "This identity cannot be reactivated by repair. Preserve history; inspect its separate archive or retirement cleanup status." }] } : undefined;
	}

	async inspect(conversationId: string): Promise<HostRepairInspection> {
		const { registry } = this.options;
		const terminal = this.terminal(conversationId); if (terminal) return terminal;
		const before = registry.registeredConversation(conversationId);
		if (!before) throw new HostControlError("not_found", "Conversation was not found");
		let membership: Membership = "unknown";
		if (this.options.matrixReady() && hasMatrixBinding(before)) {
			try { membership = await this.options.membership(before.roomId); } catch { /* Unknown is not a join or authority failure waiver. */ }
		}
		// A membership GET can yield to retirement or a binding change. Never project
		// the old room's membership into a newly bound identity.
		const afterTerminal = this.terminal(conversationId); if (afterTerminal) return afterTerminal;
		const manifest = registry.registeredConversation(conversationId);
		if (!manifest) throw new HostControlError("not_found", "Conversation was not found");
		if (!hasMatrixBinding(manifest) || !hasMatrixBinding(before) || manifest.roomId !== before.roomId) membership = "unknown";
		const facts = registry.repairRuntimeFacts(conversationId);
		const runtime = !facts ? "unknown" : facts.repairHeld ? "repair_held" : facts.attached ? "attached" : facts.unobservedLaunch ? "unobserved_launch"
			: facts.legacyWindow ? "legacy_ownership" : facts.state === "starting" ? "starting"
			: facts.state === "dormant" ? "dormant" : "unknown";
		const queues = facts?.queues ?? null;
		const matrixReady = this.options.matrixReady();
		const setupState = !matrixReady ? "disconnected" : !hasMatrixBinding(manifest) ? "pending" : this.options.accountSetup(conversationId);
		const progress = this.options.repairProgress?.(conversationId);
		const findings: HostRepairInspection["findings"] = [];
		const add = (code: HostRepairInspection["findings"][number]["code"], nextStep: string) => findings.push({ code, nextStep });
		if (runtime === "repair_held") {
			add("repair_held", progress ? `Repair phase: ${progress.phase}. ${progress.live ? "The approved bounded invocation is progressing; inspect again." : "No live continuation exists; obtain a fresh conversation.repair.preview and independent approval."} Future queued delivery remains held, not abandoned. Do not bypass with open or legacy recovery.` : "An admitted repair holds future queued delivery. Obtain a fresh conversation.repair.preview and independent approval; do not bypass it with open or legacy recovery.");
		}
		if (runtime === "unknown") add("runtime_unknown", "Obtain fresh process and attachment observations before any runtime repair; missing metadata is not exit proof.");
		if (runtime === "legacy_ownership") add("legacy_ownership", "Inspect the old writer and saved session. Runtime repair requires verified exit or explicit closure attestation with fresh conflict screening.");
		if (runtime === "unobserved_launch") add("unobserved_launch", "Inspect the reserved launch outcome before retrying. Do not clear its reservation or assume an absent attachment means process exit.");
		if (runtime === "starting") add("launch_in_progress", "Observe the admitted launch outcome; do not start another process.");
		if (runtime === "dormant") add("dormant", "No adapter is attached. Obtain fresh process evidence and an approved open/repair plan if you want this conversation running.");
		if (facts?.lifecycleObligations)
			add("lifecycle_obligations", "Inspect pending transitions, polls, checkpoints, exports or refresh before runtime repair; queue abandonment alone cannot resolve them.");
		if (queues && Object.values(queues).some(n => n > 0)) add("queued_work", "Repair preserves queued work without a queue-management choice. Separate conversation.queue.resume.preview/apply or queue.cancel.preview/apply consent is needed only if you want preserved work resumed or abandoned. Counts may include current work; prior effects remain uncertain.");
		if (!matrixReady) add("matrix_disconnected", "Restore Matrix connectivity, then inspect original-room membership again.");
		if (membership === "unknown") add("membership_unknown", "Read the original room's operator membership and bot authority; a saved binding or cached setup result is not access proof.");
		if (membership === "leave") add("membership_restore_required", "Obtain explicit consent to restore access to the original room after verifying ownership and current departure. Do not create a replacement room.");
		if (membership === "invite" || membership === "knock") add("membership_invitation_pending", "Resolve the original room's pending invitation or join request; do not assume the operator has joined.");
		if (membership === "ban") add("membership_banned", "An authorized room administrator must resolve the ban; repair must not bypass it or replace the room.");
		if (setupState === "pending" || setupState === "notification_setup_uncertain") add("account_setup_pending", "Inspect account setup and acknowledgements separately from membership. Preserve manual notification preferences; do not blindly retry uncertain settings writes.");
		return { conversationId, authority: "live", readiness: "not_verified", kind: manifest.kind,
			activeGenerationId: registry.activeGeneration(manifest).generationId, runtime, membership, setupState, queues, findings,
			...(progress ? { repair: { operationId: progress.operationId, phase: progress.phase, continuation: progress.live ? "live" as const : "none" as const } } : {}) };
	}
}
