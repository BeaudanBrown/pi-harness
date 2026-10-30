import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { deriveConversationId, hasMatrixBinding } from "../contracts.js";
import { type HostAction, type HostReadAction, type HostRequest, type HostResult } from "../live-workspace-contracts.js";
import type { FrozenHostEffects, FrozenJson, HostApprovalRecord } from "./host-approval-record.js";
import type { HostMutationOwner } from "./host-approval-runtime.js";
import type { HostLifecycle } from "./host-lifecycle.js";
import type { LiveSpacePreview } from "./project-reconciliation.js";
import type { RelayRegistry } from "./registry.js";
import type { ManagedSessionIpcServer } from "./ipc-server.js";
import type { ConversationRetirement, RetirementPlan } from "./conversation-retirement.js";
import type { HostAccountOwner, MembershipRestore } from "./host-account-owner.js";
import { HostControlError } from "./host-control-error.js";
import { HostPreviewStore, staleHostPreview, freezeJsonChunks } from "./host-preview-store.js";

const detached = (value: unknown): FrozenJson => JSON.parse(JSON.stringify(value)) as FrozenJson;
type PreviewAction = Extract<HostReadAction, { operation: "conversation.admin.preview" | "conversation.recover.preview" | "conversation.delete.preview" | "worktree.branch.preview" | "worktree.remove.preview" | "worktree.conversation.cleanup.preview" | "space.reconcile.preview" | "space.cleanup.preview" }>;
type PreviewResult = HostResult<"conversation.delete.preview">;
type Removal = Awaited<ReturnType<HostLifecycle["removalApprovalPreview"]>>;
interface Preview {
	source: PreviewAction; expiresAt: number; targets: PreviewResult["targets"]; activeRuns: PreviewResult["activeRuns"]; blockers: string[];
	retirements?: RetirementPlan[]; removal?: Removal;
	branch?: Awaited<ReturnType<HostLifecycle["branchApprovalPreview"]>>;
	spaces?: LiveSpacePreview;
	recovery?: Awaited<ReturnType<HostLifecycle["manualRecoveryPreview"]>>;
	/** JSON chunks preserve arbitrary Matrix user/event keys without widening approval's private-key grammar. */
	adminJson?: string[];
	warnings?: string[];
}
function adminSnapshot(preview: Preview): Awaited<ReturnType<HostLifecycle["adminApprovalPreview"]>> | undefined {
	return preview.adminJson ? JSON.parse(preview.adminJson.join("")) : undefined;
}
export function isManagedHostPreview(action: HostAction): action is PreviewAction { return action.operation.endsWith(".preview"); }
const stale = staleHostPreview;

/** Private frozen owner data, not additional model-controlled arguments or replay receipts. */
export class ManagedHostMutationOwner implements HostMutationOwner {
	private readonly previews: HostPreviewStore<Preview>;
	private readonly now: () => number;
	constructor(private readonly options: {
		registry: RelayRegistry; lifecycle: HostLifecycle; retirement: ConversationRetirement; server: Pick<ManagedSessionIpcServer, "attachment">;
		account?: Pick<HostAccountOwner, "freezeMembership" | "restoreMembership">;
		activeRun?: (conversationId: string) => Promise<{ runId: string } | undefined>; now?: () => number;
	}) { this.now = options.now ?? Date.now; this.previews = new HostPreviewStore(options.registry.hostId, this.now); }

	private target(conversationId: string): FrozenJson {
		const { registry } = this.options;
		if (registry.retirement(conversationId)) throw new HostControlError("retired", "Conversation is permanently retired");
		const manifest = registry.registeredConversation(conversationId);
		if (!manifest) throw new HostControlError("not_found", "Managed conversation was not found");
		return detached({ conversationId, kind: manifest.kind, generationId: registry.activeGeneration(manifest).generationId,
			placement: manifest.placement ?? null, piSessionId: manifest.piSessionId,
			matrixBinding: hasMatrixBinding(manifest) ? "bound" : "pending",
			roomId: hasMatrixBinding(manifest) ? manifest.roomId : manifest.verifiedBinding?.roomId ?? null,
			attachmentId: this.options.server.attachment(conversationId)?.attachmentId ?? null, window: registry.managedWindow(conversationId),
			launch: registry.launchIdentity(conversationId) ?? null });
	}
	private async activeRuns(ids: string[]): Promise<PreviewResult["activeRuns"]> {
		const attached = [...new Set(ids)].filter((id) => this.options.server.attachment(id));
		if (attached.length > 64) throw new HostControlError("unavailable", "Too many active targets; request a smaller preview");
		return (await Promise.all(attached.map(async (conversationId) => {
			if (!this.options.activeRun) throw new HostControlError("upgrade_required", "Active target run observation is unavailable");
			const run = await this.options.activeRun(conversationId);
			return run ? { conversationId, runId: run.runId } : undefined;
		}))).filter((run): run is PreviewResult["activeRuns"][number] => Boolean(run)).sort((a, b) => a.conversationId.localeCompare(b.conversationId));
	}

	async preview(source: PreviewAction): Promise<PreviewResult> {
		const preview: Preview = { source: structuredClone(source), expiresAt: this.previews.expiresAt(), targets: [], activeRuns: [], blockers: [] };
		let conversations: string[] = [];
		const coordinatorId = deriveConversationId(this.options.registry.hostId, "coordinator");
		if (source.operation === "worktree.conversation.cleanup.preview" && source.conversationId === coordinatorId) {
			conversations = [coordinatorId]; preview.targets = [{ kind: "conversation", conversationId: coordinatorId }];
			preview.blockers.push("The protected coordinator cannot be retired or included in destructive cleanup");
		} else if (source.operation === "conversation.admin.preview") {
			const admins = await this.options.lifecycle.adminApprovalPreview({ conversationIds: source.conversationIds, ...(source.includeSpaces ? { includeSpaces: true } : {}) });
			preview.adminJson = freezeJsonChunks(admins);
			preview.targets = source.conversationIds.map(conversationId => ({ kind: "conversation", conversationId }));
			for (const room of admins.rooms) if (room.space) preview.targets.push({ kind: "space", roomId: room.roomId });
			preview.warnings = [
				`Grant configured operator ${admins.rooms[0]?.operatorUserId} admin power 100 where needed; preserve higher power. ${admins.rooms.filter(room => room.change).length} of ${admins.rooms.length} rooms/Spaces need an update.`,
				"Preserve other members, permissions and history. This does not remove anyone or grant guests admin access.",
				"Matrix has no conditional power-state writes. Avoid concurrent permission edits: a change between inspection and write could be overwritten. Uncertain writes are never automatically retried.",
			];
		} else if (source.operation === "conversation.recover.preview") {
			preview.recovery = await this.options.lifecycle.manualRecoveryPreview(source.conversationId);
			conversations = [source.conversationId];
			preview.targets = [{ kind: "conversation", conversationId: source.conversationId }];
			preview.warnings = [
				`Mode: ${preview.recovery.mode}. Approval asserts the old Pi was manually closed; this is NOT verified process exit.`,
				`Generation ${preview.recovery.generationId}; old window ${preview.recovery.window.windowId}/${preview.recovery.window.paneId} in ${JSON.stringify(preview.recovery.window.sessionName)}.`,
				`${preview.recovery.observation.unreadableProcesses.length} processes could not be inspected. Approval accepts this uncertainty. No automatic stop or launch.`,
			];
		} else if (source.operation === "conversation.delete.preview") {
			conversations = [...source.conversationIds].sort();
			if (conversations.includes(coordinatorId)) preview.blockers.push("The protected coordinator cannot be retired");
			preview.retirements = conversations.filter(id => id !== coordinatorId).map((id) => this.options.retirement.prepare(id));
			preview.targets = conversations.map((conversationId) => ({ kind: "conversation", conversationId }));
		} else if (source.operation === "worktree.branch.preview") {
			const branch = preview.branch = await this.options.lifecycle.branchApprovalPreview(source); const plan = branch.plan;
			preview.targets = [{ kind: "branch", checkoutId: branch.checkoutId, branch: plan.branch, tip: plan.head, mergeTarget: plan.mergeTarget, mergeCommit: plan.mergeCommit }];
		} else if (source.operation === "worktree.remove.preview" || source.operation === "worktree.conversation.cleanup.preview") {
			const removal = preview.removal = await this.options.lifecycle.removalApprovalPreview(source); const intent = removal.intent;
			preview.targets.push({ kind: "worktree", checkoutId: removal.checkoutId, rootKey: intent.rootKey, workspace: intent.workspace });
			conversations = removal.activeConversations;
			if (!intent.clean) preview.blockers.push("Worktree is dirty"); if (intent.locked) preview.blockers.push("Worktree is locked");
			if (intent.targetConversationId) {
				preview.retirements = [this.options.retirement.prepare(intent.targetConversationId)];
				preview.targets.push({ kind: "conversation", conversationId: intent.targetConversationId });
			}
			if (conversations.some((id) => id !== intent.targetConversationId)) preview.blockers.push("Another active conversation uses this worktree");
			if (intent.mergeTarget && intent.mergeCommit) preview.targets.push({ kind: "branch", checkoutId: removal.checkoutId, branch: intent.branch,
				tip: intent.head, mergeTarget: intent.mergeTarget, mergeCommit: intent.mergeCommit });
		} else {
			const cleanup = source.operation === "space.cleanup.preview";
			preview.spaces = await this.options.lifecycle.spaceApprovalPreview(cleanup, source.operation === "space.reconcile.preview" ? source.conversationIds : undefined);
			preview.blockers.push(...(preview.spaces.blockers ?? []));
			if (!cleanup) (preview.warnings ??= []).push(
				"Reconcile only the frozen conversations and ancestor links. Preserve rooms and history; newly created migration Spaces grant the configured operator admin power 100. Existing Space permissions are not changed.",
				"This changes Matrix organisation only; it does not stop, restart or inspect active Pi runs. An empty activeRuns list is not an idle attestation.");
			const targets = new Map<string, PreviewResult["targets"][number]>();
			for (const id of preview.spaces.selection ?? []) targets.set(id, { kind: "conversation", conversationId: id });
			for (const link of preview.spaces.links) {
				const proof = link.child.provenance;
				targets.set(proof.kind === "conversation" ? proof.conversationId : link.child.roomId, proof.kind === "conversation" ? { kind: "conversation", conversationId: proof.conversationId } : { kind: "space", roomId: link.child.roomId });
				if (!cleanup) targets.set(link.parent.roomId, { kind: "space", roomId: link.parent.roomId });
			}
			for (const item of preview.spaces.migration?.items ?? []) {
				if (item.retired) continue;
				targets.set(item.conversationId, { kind: "conversation", conversationId: item.conversationId });
				if (item.checkout) targets.set(item.checkout.checkoutId, { kind: "worktree", checkoutId: item.checkout.checkoutId,
					rootKey: item.checkout.placement.rootKey, workspace: item.checkout.placement.workspace });
				for (const roomId of [item.checkout?.hostSpace, item.oldProjectSpace, item.targetProjectSpace, item.targetCheckoutSpace]) if (roomId) targets.set(roomId, { kind: "space", roomId });
			}
			for (const saved of preview.spaces.legacyPlacements ?? []) targets.set(saved.hostSpace, { kind: "space", roomId: saved.hostSpace });
			preview.targets = [...targets.values()];
			// Reconciliation does not interrupt Pi; an idle adapter has no active-run witness.
			// Keep runtime evidence requirements for cleanup and runtime-changing operations.
			conversations = cleanup ? preview.targets.flatMap((target) => target.kind === "conversation" ? [target.conversationId] : []) : [];
		}
		preview.activeRuns = await this.activeRuns(conversations);
		return this.previews.save(preview);
	}

	private async previewFor(action: Extract<HostAction, { previewId: string }>): Promise<Preview> {
		return this.previews.get(action);
	}
	private async validPreview(preview: Preview, branch = false): Promise<boolean> {
		if (preview.expiresAt <= this.now() || preview.blockers.length) return false;
		if (preview.source.operation === "conversation.admin.preview") {
			const admins = adminSnapshot(preview);
			if (!admins || !isDeepStrictEqual(admins, await this.options.lifecycle.adminApprovalPreview(admins.selection))) return false;
		}
		if (preview.source.operation === "conversation.recover.preview" && (!preview.recovery || !isDeepStrictEqual(preview.recovery, await this.options.lifecycle.manualRecoveryPreview(preview.source.conversationId)))) return false;
		if (preview.branch && (preview.source.operation !== "worktree.branch.preview" || !isDeepStrictEqual(preview.branch, await this.options.lifecycle.branchApprovalPreview(preview.source)))) return false;
		if (preview.retirements && !isDeepStrictEqual(preview.retirements, preview.retirements.map((plan) => this.options.retirement.prepare(plan.conversationId)))) return false;
		if (preview.source.operation === "space.reconcile.preview" || preview.source.operation === "space.cleanup.preview") {
			if (!preview.spaces || !isDeepStrictEqual(preview.spaces, await this.options.lifecycle.spaceApprovalPreview(preview.source.operation === "space.cleanup.preview", preview.source.operation === "space.reconcile.preview" ? preview.source.conversationIds : undefined))) return false;
		}
		if (preview.removal && !isDeepStrictEqual(preview.removal.intent, await this.options.lifecycle.removalApprovalSnapshot(preview.removal.intent.removalKey))) return false;
		// Admin changes and Space reconciliation do not signal or interrupt attached Pi runs.
		// Reconciliation's frozen hierarchy/ownership snapshot was revalidated above.
		if (!branch && !preview.adminJson && preview.source.operation !== "space.reconcile.preview") {
			const ids = preview.removal?.activeConversations ?? preview.targets.filter((target) => target.kind === "conversation").map((target) => target.conversationId);
			if (!isDeepStrictEqual(preview.activeRuns, await this.activeRuns(ids))) return false;
		}
		return true;
	}

	async freeze(request: { action: HostAction; actor?: HostRequest["actor"] }): Promise<FrozenHostEffects> {
		const action = request.action;
		if (action.operation === "worktree.conversation.fork" && (!request.actor || request.actor.kind !== "human_local" && request.actor.conversationId !== action.sourceConversationId)) throw new HostControlError("forbidden", "Fork summaries must originate in their source conversation");
		if ("previewId" in action) {
			const preview = await this.previewFor(action);
			if (!await this.validPreview(preview, action.operation === "worktree.branch.delete")) throw stale();
			const effects: HostAction[] = action.operation === "conversation.delete.apply"
				? preview.retirements!.map((plan) => ({ operation: "conversation.delete", conversationId: plan.conversationId, confirmed: true })) : [action];
			return { effects, targets: preview.targets, preconditions: { preview: detached(preview) } };
		}
		switch (action.operation) {
			case "coordinator.membership.restore": {
				if (!this.options.account) throw new HostControlError("upgrade_required", "Account membership owner is unavailable");
				const restore = await this.options.account.freezeMembership();
				return { effects: [action], targets: [{ kind: "conversation", conversationId: restore.conversationId }], preconditions: { restore: detached(restore) } };
			}
			case "conversation.migrate": {
				if (this.options.registry.registeredConversation(action.conversationId)?.kind !== "project") throw new HostControlError("forbidden", "Only project conversations support legacy migration");
				if ((await this.activeRuns([action.conversationId])).length) throw new HostControlError("busy", "Finish the active run before preparing legacy migration");
				return { effects: [action], preconditions: { target: this.target(action.conversationId) } };
			}
			case "conversation.open": case "conversation.resume": case "conversation.stop": case "conversation.refresh":
				if (action.operation === "conversation.refresh" && this.options.registry.manifestByConversationId(action.conversationId)?.kind === "coordinator") throw new HostControlError("upgrade_required", "Coordinator refresh is unavailable");
				return { effects: [action], preconditions: { target: this.target(action.conversationId) } };
			case "project.create": case "conversation.create": case "worktree.create": case "worktree.conversation.create": case "worktree.conversation.fork":
				return { effects: [action], preconditions: { creation: await this.options.lifecycle.freezeCreation(action) } };
			case "conversation.delete":
				return { effects: [action], preconditions: { retirement: detached(this.options.retirement.prepare(action.conversationId)) } };
			default: throw new HostControlError("upgrade_required", "This host mutation owner is not available yet");
		}
	}

	async revalidate(record: HostApprovalRecord): Promise<boolean> {
		try {
			if ("previewId" in record.request.action) return await this.validPreview(record.frozen.preconditions.preview as unknown as Preview, record.request.action.operation === "worktree.branch.delete");
			return isDeepStrictEqual(await this.freeze(record.request), record.frozen);
		} catch { return false; }
	}

	async executeHuman(request: HostRequest): Promise<unknown> {
		if (request.actor.kind === "model") throw new HostControlError("forbidden", "Model mutations require independent consent");
		return this.executeFrozen(request.action, await this.freeze(request), `operation_${randomUUID().replaceAll("-", "")}`);
	}

	async execute(record: HostApprovalRecord): Promise<unknown> {
		return this.executeFrozen(record.request.action, record.frozen, `operation_${record.approvalId.slice("approval_".length)}`);
	}
	private async executeFrozen(action: HostAction, frozen: FrozenHostEffects, operationId: string): Promise<unknown> {
		if ("previewId" in action) {
			const preview = frozen.preconditions.preview as unknown as Preview;
			if (!await this.validPreview(preview, action.operation === "worktree.branch.delete")) throw stale();
			let pending = false;
			if (action.operation === "conversation.admin.apply") {
				const admins = adminSnapshot(preview); if (!admins) throw stale();
				await this.options.lifecycle.executeAdminApproval(admins, operationId);
			} else if (action.operation === "conversation.recover.apply") {
				if (!preview.recovery) throw stale();
				await this.options.lifecycle.executeManualRecovery(preview.recovery, operationId);
				pending = preview.recovery.mode === "retired_cleanup" && Boolean(this.options.registry.retirement(preview.recovery.conversationId)?.cleanup);
			} else if (action.operation === "conversation.delete.apply") {
				for (const plan of preview.retirements!) await this.options.retirement.retirePrepared(plan);
				pending = true;
			} else if (action.operation === "space.reconcile.apply" || action.operation === "space.cleanup.apply") {
				if (!preview.spaces) throw stale();
				pending = (await this.options.lifecycle.executeSpaceApproval(preview.spaces, action.operation === "space.cleanup.apply")).remaining > 0;
			}
			else if (action.operation === "worktree.branch.delete") await this.options.lifecycle.executeBranchApproval(detached(preview.branch));
			else {
				const bundled = action.operation === "worktree.conversation.cleanup.apply";
				await this.options.lifecycle.executeRemovalApproval(detached(preview.removal!.intent), bundled, bundled ? async (id) => {
					const plan = preview.retirements?.find((item) => item.conversationId === id); if (!plan) throw stale();
					return this.options.retirement.retirePrepared(plan);
				} : undefined);
				pending = bundled;
			}
			return { operationId, cleanupState: pending ? "pending" : "complete" };
		}
		if (!isDeepStrictEqual(frozen.effects, [action])) throw stale();
		if (action.operation === "coordinator.membership.restore") {
			if (!this.options.account) throw new HostControlError("upgrade_required", "Account membership owner is unavailable");
			return this.options.account.restoreMembership(frozen.preconditions.restore as unknown as MembershipRestore);
		}
		if (action.operation === "conversation.delete") {
			const plan = frozen.preconditions.retirement as unknown as RetirementPlan;
			if (!plan || plan.conversationId !== action.conversationId) throw stale();
			const retired = await this.options.retirement.retirePrepared(plan);
			return { conversationId: action.conversationId, retirementId: retired.retirementId,
				cleanupState: !retired.cleanup ? "complete" : retired.cleanup.some((effect) => effect.phase === "blocked") ? "failed" : "pending" };
		}
		if (action.operation === "project.create" || action.operation === "conversation.create" || action.operation === "worktree.create" || action.operation === "worktree.conversation.create" || action.operation === "worktree.conversation.fork") {
			return this.options.lifecycle.executeCreation(action, frozen.preconditions.creation!);
		}
		if (!["conversation.open", "conversation.resume", "conversation.stop", "conversation.refresh", "conversation.migrate"].includes(action.operation)) throw new HostControlError("upgrade_required", "This host mutation owner is not available yet");
		const target = action as Extract<HostAction, { operation: "conversation.open" | "conversation.resume" | "conversation.stop" | "conversation.refresh" | "conversation.migrate" }>;
		// Synchronous target recheck and lifecycle admission have no intervening await.
		if (!isDeepStrictEqual(this.target(target.conversationId), frozen.preconditions.target)) throw stale();
		if (target.operation === "conversation.migrate") return this.options.lifecycle.migrateConversation(target.conversationId);
		if (target.operation === "conversation.open") return this.options.lifecycle.openConversation(target.conversationId, target.expectedGenerationId);
		if (target.operation === "conversation.resume") return this.options.lifecycle.resumeConversation(target.conversationId);
		if (target.operation === "conversation.refresh") {
			const saved = frozen.preconditions.target as { attachmentId: string | null };
			return this.options.lifecycle.refreshApproved(target.conversationId, saved.attachmentId ?? undefined);
		}
		await this.options.lifecycle.stopConversation(target.conversationId);
		return { conversationId: target.conversationId, runtimeState: "stopped" };
	}
}
