import { Type } from "typebox";
import { Check } from "typebox/value";
import { safeManagedTitle } from "./managed-provenance.js";

export const TitleRevisionSchema = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
export const ConversationTitleSchema = Type.String({ minLength: 1, maxLength: 128, pattern: "^[^\\u0000-\\u001f\\u007f-\\u009f]+$" });
export const TITLE_STATE_EVENT = "lol.bepis.pi.presentation.v1";
export interface ConversationTitle { title: string; revision: number }
export function parseConversationTitle(value: unknown): ConversationTitle {
	const schema = Type.Object({ title: ConversationTitleSchema, revision: TitleRevisionSchema }, { additionalProperties: false });
	if (!Check(schema, value) || !value.title.trim() || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(value.title)) throw Error("Invalid conversation title revision");
	return { title: value.title, revision: value.revision };
}
export function conversationTitle(input: string, conversationId: string, occupied: ReadonlySet<string> = new Set()): string {
	const points = Array.from(safeManagedTitle(input.replace(/^[●○] /u, ""), conversationId, "conversation", occupied));
	while (points.join("").length > 128) points.pop();
	return points.join("");
}
