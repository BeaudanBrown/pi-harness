import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { ConversationIdSchema, GenerationIdSchema } from "./identity-contracts.js";

export const FORK_CONTEXT_TYPE = "managed-session.fork-context";
export const FORK_SUMMARY_MAX_BYTES = 8192;
export const ForkSummarySchema = Type.String({ minLength: 1, maxLength: 4096 });
export function parseForkSummary(value: unknown): string {
	if (!Check(ForkSummarySchema, value) || !value.trim() || Buffer.byteLength(value, "utf8") > FORK_SUMMARY_MAX_BYTES || /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]|\p{Cf}|\p{Cs}/u.test(value)) throw new Error("Invalid fork context summary");
	return value;
}
export const ForkContextSchema = Type.Object({
	version: Type.Literal(1),
	sourceConversationId: ConversationIdSchema,
	sourceGenerationId: GenerationIdSchema,
	baseCommit: Type.String({ pattern: "^(?:[a-f0-9]{40}|[a-f0-9]{64})$" }),
	summary: ForkSummarySchema,
}, { additionalProperties: false });
export type ForkContext = Static<typeof ForkContextSchema>;

/** Explicit context only: no source-file reads, binding import, or execution port. */
export function parseForkContext(value: unknown): ForkContext {
	if (!Check(ForkContextSchema, value)) {
		throw new Error("Invalid fork context");
	}
	parseForkSummary(value.summary);
	return { version: 1, sourceConversationId: value.sourceConversationId, sourceGenerationId: value.sourceGenerationId,
		baseCommit: value.baseCommit, summary: value.summary };
}

export function forkContextId(value: ForkContext): string {
	const context = parseForkContext(value);
	const hash = createHash("sha256").update("pi-managed-sessions:fork-context:live-v1\0");
	for (const part of [context.sourceConversationId, context.sourceGenerationId, context.baseCommit, context.summary]) hash.update(`${Buffer.byteLength(part, "utf8")}:`).update(part);
	return `fork_context_${hash.digest("hex").slice(0, 32)}`;
}

/** The same literal content is used in Pi and the destination's silent notice. */
export function forkContextText(value: ForkContext): string {
	const context = parseForkContext(value);
	return `Inherited context from ${context.sourceConversationId}\nCommitted base: ${context.baseCommit}\n\n${context.summary}\n\n` +
		"This summary is context only. Uncommitted source changes were not copied. Waiting for your next message; no task has been started.";
}

/** Build a native visible context message, not a user delivery or a prompt. */
export function forkContextEntry(value: ForkContext, parentId: string, timestamp: string) {
	const context = parseForkContext(value);
	if (!/^[A-Za-z0-9._:-]{1,128}$/.test(parentId) || !Number.isFinite(Date.parse(timestamp)) || new Date(timestamp).toISOString() !== timestamp) {
		throw new Error("Invalid fork context boundary");
	}
	const contextId = forkContextId(context);
	return { type: "custom_message" as const, id: contextId, parentId, timestamp,
		customType: FORK_CONTEXT_TYPE, content: forkContextText(context), display: true,
		details: { ...context, contextId } };
}

/** Recovery must recognize the original entry; it must never append another seed. */
export function verifyForkContextEntry(entry: unknown, context: ForkContext, parentId: string): void {
	if (typeof entry !== "object" || entry === null || !("timestamp" in entry) || typeof entry.timestamp !== "string" ||
		!isDeepStrictEqual(entry, forkContextEntry(context, parentId, entry.timestamp))) {
		throw new Error("Fork context conflicts with its persisted seed");
	}
}
