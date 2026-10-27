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
	"project.create": "Create project", "worktree.create": "Create checkout",
	"worktree.conversation.create": "Create checkout and conversation", "worktree.conversation.fork": "Fork into a new checkout and conversation",
	"conversation.create": "Create conversation", "conversation.open": "Open conversation", "conversation.resume": "Resume conversation",
	"conversation.stop": "Stop conversation", "conversation.refresh": "Refresh conversation runtime", "conversation.delete": "Retire conversation",
	"conversation.delete.apply": "Retire selected conversations", "worktree.remove.apply": "Remove checkout",
	"worktree.conversation.cleanup.apply": "Clean up checkout and conversation", "worktree.branch.delete": "Delete branch",
	"space.reconcile.apply": "Reconcile room grouping", "space.cleanup.apply": "Clean up Spaces",
	"coordinator.membership.restore": "Restore coordinator membership",
};
const fieldNames: Record<string, string> = {
	rootKey: "Workspace root", workspace: "Checkout", relativeCwd: "Subdirectory", creationKey: "Creation reference",
	conversationId: "Conversation", sourceConversationId: "Source conversation", sourceGenerationId: "Source generation",
	baseRef: "Base reference", baseCommit: "Committed base", confirmed: "Explicit confirmation requested",
	previewId: "Frozen preview", roomId: "Room", checkoutId: "Checkout identity",
};
const label = (key: string): string => fieldNames[key] ?? (key[0].toUpperCase() + key.slice(1)).replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().replace(/^./, c => c.toUpperCase());
// Quote scalar labels so newlines/control characters cannot impersonate headings.
// Structure is rendered as labelled lines, never a raw JSON object dump.
function describeFields(value: object, indent = ""): string {
	return Object.entries(value).map(([key, item]) => {
		if (key === "operation") return `${indent}Action: ${actionNames[String(item)] ?? String(item)}`;
		if (item !== null && typeof item === "object") {
			if (Array.isArray(item)) return `${indent}${label(key)}:\n${item.map((entry, i) => typeof entry === "object" && entry !== null
				? `${indent}  ${i + 1}.\n${describeFields(entry, `${indent}    `)}` : `${indent}  ${JSON.stringify(entry)}`).join("\n")}`;
			return `${indent}${label(key)}:\n${describeFields(item, `${indent}  `)}`;
		}
		return `${indent}${label(key)}: ${typeof item === "boolean" ? (item ? "yes" : "no") : JSON.stringify(item)}`;
	}).join("\n");
}

export function hostApprovalQuestion(record: HostApprovalRecord): string {
	// Scalar quoting plus escaped terminal/bidi controls protects presentation.
	const effects = record.frozen.effects;
	const { operation, ...parameters } = record.request.action;
	let details = record.request.action.operation === "conversation.delete.apply" && effects.every((effect) => effect.operation === "conversation.delete")
		? `${describeFields(parameters)}\nDelete these exact conversations:\n${effects.map((effect) => effect.conversationId).join("\n")}`
		: `${describeFields(record.request.action)}${isDeepStrictEqual(effects, [record.request.action]) ? "" : `\n\nExact effects:\n${effects.map(effect => describeFields(effect)).join("\n\n")}`}`;
	if (record.request.action.operation === "conversation.create") details = `Create a new conversation and its Matrix room in the checkout below.\n${details}`;
	if (record.request.action.operation === "worktree.conversation.fork") {
		if (!isDeepStrictEqual(effects, [record.request.action])) throw new HostControlError("unavailable", "Fork approval effects changed", false);
		const context = parseForkContext((record.frozen.preconditions.creation as { context?: unknown } | undefined)?.context);
		const { summary, ...scope } = record.request.action;
		if (summary !== context.summary || scope.sourceConversationId !== context.sourceConversationId) throw new HostControlError("unavailable", "Fork approval context changed", false);
		details = `${describeFields(scope)}\n${describeFields({ baseCommit: context.baseCommit, sourceGenerationId: context.sourceGenerationId })}\nNew independent room; inherited summary only; idle until next message` +
			`\n\nInherited summary (context only):\n${summary}\n\nEnd inherited summary.`;
	}
	// Bulk retirement already lists these exact conversation targets. Do not
	// repeat them (100 IDs must still fit); other target kinds remain visible.
	const targets = record.frozen.targets?.filter(target => !(operation === "conversation.delete.apply" && target.kind === "conversation" &&
		effects.some(effect => effect.operation === "conversation.delete" && effect.conversationId === target.conversationId)));
	if (targets?.length) details += `\n\nFrozen targets:\n${targets.map(target => describeFields(target)).join("\n\n")}`;
	const action = record.request.action;
	const heading = `${actionNames[action.operation] ?? action.operation}${"title" in action ? ` ${JSON.stringify(action.title)}` : ""}`;
	const question = `Approve: ${heading}?\n\n${details}\n\nApproval reference: ${record.approvalId}\nExpires: ${new Date(record.expiresAt).toISOString()}`
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
