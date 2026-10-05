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

export function hostApprovalQuestion(record: HostApprovalRecord): string {
	// JSON quoting plus escaped terminal/bidi controls keeps labels from masquerading as instructions.
	const effects = record.frozen.effects;
	let details = record.request.action.operation === "conversation.delete.apply" && effects.every((effect) => effect.operation === "conversation.delete")
		? `${JSON.stringify(record.request.action)}\nDelete these exact conversations:\n${effects.map((effect) => effect.conversationId).join("\n")}`
		: JSON.stringify({ action: record.request.action, effects, ...(record.frozen.targets ? { targets: record.frozen.targets } : {}) });
	if (record.request.action.operation === "worktree.conversation.fork") {
		if (!isDeepStrictEqual(effects, [record.request.action])) throw new HostControlError("unavailable", "Fork approval effects changed", false);
		const context = parseForkContext((record.frozen.preconditions.creation as { context?: unknown } | undefined)?.context);
		details = JSON.stringify({ action: record.request.action, baseCommit: context.baseCommit, sourceGenerationId: context.sourceGenerationId, targetBehavior: "New independent room; inherited summary only; idle until next message" });
	}
	const safe = details.replace(/[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
	const question = `Approve this host mutation?\n${safe}\nApproval: ${record.approvalId}\nExpires: ${new Date(record.expiresAt).toISOString()}`;
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
