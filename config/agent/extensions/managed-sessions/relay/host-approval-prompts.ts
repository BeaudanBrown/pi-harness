import { deriveMatrixTransactionId } from "../contracts.js";
import { isDeepStrictEqual } from "node:util";
import { parseForkContext } from "../fork-context.js";
import type { HostApprovalRecord } from "./host-approval-record.js";
import type { HostApprovalPresentation } from "./host-approvals.js";
import { HostControlError } from "./host-control-error.js";
import type { ManagedMatrixClient } from "./matrix-client.js";

type Decision = NonNullable<HostApprovalRecord["decision"]>;
interface Poll {
	record: HostApprovalRecord; roomId: string; eventId: string; question: string; settled: boolean;
	resolve: (decision: Decision) => void; abort: AbortController;
}
const answers = [{ id: "approve", text: "Approve" }, { id: "deny", text: "Deny" }] as const;

const actionNames: Record<string, string> = {
	"project.create": "Create a project", "worktree.create": "Create a new checkout",
	"worktree.conversation.create": "Create a new checkout and conversation", "worktree.conversation.fork": "Fork into a new checkout and conversation",
	"conversation.create": "Create a new conversation", "conversation.open": "Open the native session", "conversation.resume": "Resume the native session",
	"conversation.migrate": "Prepare legacy migration or verify manual window closure (no automatic stop or launch)",
	"conversation.admin.apply": "Grant the configured operator admin access to the frozen rooms and Spaces",
	"conversation.recover.apply": "Confirm manual closure and reconcile only the frozen legacy conversation (no automatic stop or launch)",
	"conversation.stop": "Stop the native session", "conversation.refresh": "Refresh the native runtime", "conversation.delete": "Retire the room and native session",
	"conversation.delete.apply": "Retire the selected conversations", "worktree.remove.apply": "Remove the selected checkout",
	"worktree.conversation.cleanup.apply": "Clean up the selected checkout and conversation", "worktree.branch.delete": "Delete the selected branch",
	"space.reconcile.apply": "Reconcile room grouping", "space.cleanup.apply": "Clean up the selected Spaces",
	"coordinator.membership.restore": "Restore coordinator membership",
};
const words = (key: string): string => key.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
// Hide only bookkeeping/confirmation fields, not resource identities or fences.
// The unchanged frozen record and exact poll event still bind each decision.
const bookkeeping = new Set(["operation", "creationKey", "previewId", "confirmed"]);
function describeScope(value: object, operation = ""): string {
	const priority = (key: string) => ["title", "conversationId", "sourceConversationId", "placement", "workspace", "rootKey", "relativeCwd"].indexOf(key);
	return Object.entries(value).filter(([key, item]) => !bookkeeping.has(key) && item !== undefined)
		.sort(([a], [b]) => (priority(a) < 0 ? 100 : priority(a)) - (priority(b) < 0 ? 100 : priority(b)))
		.map(([key, item]): string => {
			if (item !== null && typeof item === "object") {
				if (Array.isArray(item)) return `with ${words(key)} ${item.map(entry => typeof entry === "object" && entry !== null ? describeScope(entry) : JSON.stringify(entry)).join(", ")}`;
				return describeScope(item, operation);
			}
			const quoted = JSON.stringify(item);
			switch (key) {
				case "title": return `called ${quoted}`;
				case "workspace": return operation === "project.create" ? `named ${quoted}` : `${operation.startsWith("worktree.") ? "using source" : "in"} checkout ${quoted}`;
				case "rootKey": return `under workspace root ${quoted}`;
				case "relativeCwd": return item === "" ? "at the checkout root" : `starting in subdirectory ${quoted}`;
				case "conversationId": return `for conversation ${quoted}`;
				case "sourceConversationId": return `from conversation ${quoted}`;
				case "branch": return `on branch ${quoted}`;
				case "baseRef": return `from base reference ${quoted}`;
				case "baseCommit": return `at committed base ${quoted}`;
				case "sourceGenerationId": return `from source generation ${quoted}`;
				case "roomId": return `for room ${quoted}`;
				default: return `with ${words(key)} ${quoted}`;
			}
		}).join(" ");
}
function describeAction(action: Pick<HostApprovalRecord["request"]["action"], "operation">): string {
	const verb = actionNames[action.operation];
	if (!verb) throw new HostControlError("unavailable", "Unsupported approval description", false);
	const scope = describeScope(action, action.operation);
	return `${verb}${scope ? ` ${scope}` : ""}${action.operation === "conversation.create" ? ", with its own Matrix room" : ""}`;
}

function describeTarget(target: NonNullable<HostApprovalRecord["frozen"]["targets"]>[number]): string {
	const q = JSON.stringify;
	switch (target.kind) {
		case "conversation": return `Conversation ${q(target.conversationId)}`;
		case "space": return `Space ${q(target.roomId)}`;
		case "worktree": return `Checkout ${q(target.workspace)} under workspace root ${q(target.rootKey)} (identity ${q(target.checkoutId)})`;
		case "branch": return `Branch ${q(target.branch)} in checkout ${q(target.checkoutId)} at commit ${q(target.tip)}, against merge target ${q(target.mergeTarget)} at commit ${q(target.mergeCommit)}`;
	}
}

export function hostApprovalQuestion(record: HostApprovalRecord): string {
	// Scalar quoting plus escaped terminal/bidi controls protects presentation.
	const effects = record.frozen.effects;
	const { operation } = record.request.action;
	let details = operation === "conversation.delete.apply" && effects.every((effect) => effect.operation === "conversation.delete")
		? `Retire these exact conversations?\n${effects.map((effect) => effect.conversationId).join("\n")}`
		: `${describeAction(record.request.action)}?${isDeepStrictEqual(effects, [record.request.action]) ? "" : `\n\nThis will also: ${effects.map(effect => describeAction(effect)).join("; ")}.`}`;
	if (record.request.action.operation === "worktree.conversation.fork") {
		if (!isDeepStrictEqual(effects, [record.request.action])) throw new HostControlError("unavailable", "Fork approval effects changed", false);
		const context = parseForkContext((record.frozen.preconditions.creation as { context?: unknown } | undefined)?.context);
		const { summary, ...scope } = record.request.action;
		if (summary !== context.summary || scope.sourceConversationId !== context.sourceConversationId) throw new HostControlError("unavailable", "Fork approval context changed", false);
		details = `${describeAction(scope)} ${describeScope({ baseCommit: context.baseCommit, sourceGenerationId: context.sourceGenerationId })}?\nNew independent room; inherited summary only; idle until next message` +
			`\n\nInherited summary (context only):\n${summary}\n\nEnd inherited summary.`;
	}
	if (operation === "space.reconcile.apply") {
		const preview = record.frozen.preconditions.preview as { warnings?: string[] } | undefined;
		details += `\n\n${preview?.warnings?.join("\n") || "New migration Spaces grant the configured operator admin power 100; existing room permissions and histories are preserved."}`;
	}
	if (operation === "conversation.recover.apply" || operation === "conversation.admin.apply") {
		const preview = record.frozen.preconditions.preview as { warnings?: string[] } | undefined;
		if (!preview?.warnings?.length) throw new HostControlError("unavailable", "Required uncertainty disclosure is missing");
		details += `\n\n${preview.warnings.join("\n")}`;
	}
	// Bulk retirement already lists these exact conversation targets. Do not
	// repeat them (100 IDs must still fit); other target kinds remain visible.
	const targets = record.frozen.targets?.filter(target => !(operation === "conversation.delete.apply" && target.kind === "conversation" &&
		effects.some(effect => effect.operation === "conversation.delete" && effect.conversationId === target.conversationId)));
	if (targets?.length) details += `\n\nThis affects only the following resources:\n${targets.map(describeTarget).join("\n")}`;
	const question = details
		.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
	if (question.length > 4096) throw new HostControlError("unavailable", "Approval details exceed the display limit; request a smaller explicit action", false);
	return question;
}

/** Presentation only. Live requester and frozen target validation remain the executor's responsibility. */
export class HostApprovalPrompts {
	private readonly polls = new Map<string, Poll>();
	private readonly operators: ReadonlySet<string>;
	constructor(private readonly options: {
		matrix: Pick<ManagedMatrixClient, "startPoll" | "endPoll" | "memberJoined" | "checkpointPollAnswer">;
		operatorUserIds: ReadonlySet<string>;
		/** Must use the current nonce-authenticated attachment and bind the native reply to this exact run/tool. */
		confirmLocal: (record: HostApprovalRecord, question: string, signal: AbortSignal) => Promise<boolean>;
		now?: () => number;
	}) { this.options = { ...options }; this.operators = new Set(options.operatorUserIds); }

	async present(record: HostApprovalRecord): Promise<HostApprovalPresentation> {
		const question = hostApprovalQuestion(record); const now = this.options.now ?? Date.now;
		if (record.expiresAt <= now()) throw new HostControlError("expired", "Approval expired before presentation");
		const abort = new AbortController();
		if (record.request.actor.presentation === "local_dialog") {
			return { receipt: { kind: "local_dialog", id: record.approvalId },
				decision: Promise.resolve().then(() => this.options.confirmLocal(structuredClone(record), question, abort.signal))
					.then((confirmed): Decision => ({ choice: confirmed ? "approve" : "deny", at: now(), voter: { kind: "local" } })),
				close: async () => { abort.abort(); } };
		}
		if (this.polls.size >= 64) throw new HostControlError("unavailable", "Too many active approval polls", false);
		const roomId = record.request.actor.origin.roomId;
		const eventId = record.presentation?.id ?? await this.options.matrix.startPoll(roomId,
			deriveMatrixTransactionId(record.request.actor.conversationId, record.approvalId, 0), question, answers, abort.signal, "unstable", record.notificationDisposition);
		if (this.polls.has(eventId)) throw new HostControlError("conflict", "Approval poll is already active");
		let resolve!: Poll["resolve"]; const decision = new Promise<Decision>((done) => { resolve = done; });
		const poll: Poll = { record: structuredClone(record), roomId, eventId, question, settled: false, resolve, abort };
		this.polls.set(eventId, poll);
		return { receipt: { kind: "matrix_poll", id: eventId }, decision, close: async () => {
			if (this.polls.get(eventId) !== poll) return;
			this.polls.delete(eventId); poll.settled = true; abort.abort();
			await this.options.matrix.endPoll(roomId, deriveMatrixTransactionId(record.request.actor.conversationId, record.approvalId, 1), eventId, "Host approval closed", undefined, "unstable");
		} };
	}

	isPending(approvalId: string): boolean {
		return [...this.polls.values()].some((poll) => poll.record.approvalId === approvalId && !poll.settled && poll.record.expiresAt > (this.options.now ?? Date.now)());
	}

	/** Sender/event fields must come from authenticated Matrix intake, never tool parameters. */
	async vote(input: { conversationId: string; roomId: string; pollEventId: string; answerId: string; senderUserId: string; eventId: string }): Promise<boolean> {
		const poll = this.polls.get(input.pollEventId); const now = this.options.now ?? Date.now;
		if (!poll || poll.settled || poll.record.expiresAt <= now() || input.conversationId !== poll.record.request.actor.conversationId || input.roomId !== poll.roomId ||
			!this.operators.has(input.senderUserId) || !answers.some((answer) => answer.id === input.answerId) || !/^\$\S{1,254}$/.test(input.eventId)) return false;
		if (!await this.options.matrix.memberJoined(poll.roomId, input.senderUserId, poll.abort.signal)) return false;
		const selected = await this.options.matrix.checkpointPollAnswer(poll.roomId, poll.eventId, input.answerId, poll.question, answers, poll.abort.signal);
		if (selected !== answers.find((answer) => answer.id === input.answerId)?.text || poll.settled || this.polls.get(poll.eventId) !== poll || poll.record.expiresAt <= now()) return false;
		poll.settled = true;
		poll.resolve({ choice: input.answerId === "approve" ? "approve" : "deny", at: now(), voter: { kind: "matrix", userId: input.senderUserId, eventId: input.eventId } });
		return true;
	}
}
