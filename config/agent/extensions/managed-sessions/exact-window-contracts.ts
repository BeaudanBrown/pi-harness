import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { ConversationIdSchema } from "./identity-contracts.js";

/** Private launcher ownership, not public picker metadata or a current Pi liveness proof. */
export const ExactWindowProofSchema = Type.Object({
	conversationId: ConversationIdSchema,
	serverId: Type.String({ pattern: "^[1-9][0-9]{0,19}:[0-9]{1,20}:[a-f0-9]{32}$" }),
	launchId: Type.String({ pattern: "^launch_[a-f0-9]{32}$" }),
	sessionName: Type.String({ pattern: "^[A-Za-z0-9_.-]{1,128}$" }),
	windowId: Type.String({ pattern: "^@[0-9]{1,20}$" }),
	paneId: Type.String({ pattern: "^%[0-9]{1,20}$" }),
	panePid: Type.String({ pattern: "^[1-9][0-9]{0,19}$" }),
}, { additionalProperties: false });
export type ExactWindowProof = Static<typeof ExactWindowProofSchema>;
export function parseExactWindowProof(value: unknown): ExactWindowProof {
	if (!Check(ExactWindowProofSchema, value) || BigInt(value.panePid) > 2147483647n || BigInt(value.serverId.split(":")[0]!) > 2147483647n) throw Error("Exact window ownership is unavailable");
	return structuredClone(value);
}
export function assertExactWindowBinding(conversationId: string, window: { sessionName: string; windowId: string; paneId: string; ownership?: ExactWindowProof }): void {
	if (!window.ownership) return; // Legacy observations carry no authority for exact termination.
	const proof = parseExactWindowProof(window.ownership);
	if (proof.conversationId !== conversationId || proof.sessionName !== window.sessionName || proof.windowId !== window.windowId || proof.paneId !== window.paneId)
		throw Error("Exact window ownership conflicts with its binding");
}
