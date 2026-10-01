import { parseHostRunWitness } from "../host-run-contracts.js";
import { parseHostRequest, type HostActor } from "../live-workspace-contracts.js";
import { HostControlError } from "./host-control-error.js";

type ModelActor = Extract<HostActor, { kind: "model" }>;
export interface AcceptedHostInputOrigin {
	deliveryId: string; roomId: string; eventId: string; senderUserId?: string; status: "persisted" | "completed" | "cancelled" | "accepted" | "delivered";
}

/** The caller must obtain the witness from a fresh request to the current nonce-authenticated attachment.
 * Origin authority is looked up in accepted relay input, never supplied by model arguments or the witness.
 */
export function resolveHostRunActor(input: {
	conversationId: string; generationId: string; runId: string; toolCallId: string; requestId: string;
	roomId?: string; witness: unknown; acceptedInput: (deliveryId: string) => AcceptedHostInputOrigin | undefined;
}): ModelActor {
	let witness;
	try { witness = parseHostRunWitness(input.witness); }
	catch { throw new HostControlError("forbidden", "Host requester proof is invalid"); }
	if (witness.phase !== "active" || witness.generationId !== input.generationId || witness.runId !== input.runId || !witness.toolCallIds.includes(input.toolCallId))
		throw new HostControlError("cancelled", "Requesting host tool call is no longer live");
	if (!witness.sources.length) throw new HostControlError("forbidden", "Host request has no unambiguous presentation origin");
	const actor = { kind: "model" as const, conversationId: input.conversationId, generationId: input.generationId,
		runId: input.runId, toolCallId: input.toolCallId, requestId: input.requestId };
	let resolved: ModelActor;
	if (witness.sources.every((source) => source.kind === "local")) resolved = { ...actor, presentation: "local_dialog" };
	else if (witness.sources.every((source) => source.kind === "matrix")) {
		const deliveryIds = witness.sources.map((source) => source.deliveryId);
		const origins = deliveryIds.map((deliveryId) => input.acceptedInput(deliveryId));
		if (!input.roomId || origins.some((origin, index) => !origin || origin.deliveryId !== deliveryIds[index] || origin.roomId !== input.roomId || origin.status !== "persisted" || !origin.senderUserId))
			throw new HostControlError("forbidden", "Host request has no verified accepted Matrix origin");
		// Sources retain adapter-observed input order. Later participants do not confer operator authority:
		// the actor is still a model and every mutation requires its own operator approval.
		const original = origins[0]!;
		resolved = { ...actor, presentation: "matrix_poll", origin: { roomId: original.roomId, eventId: original.eventId, senderUserId: original.senderUserId! } };
	} else throw new HostControlError("forbidden", "Mixed local and Matrix input cannot select an approval route");
	try { parseHostRequest({ version: "1.0.0", actor: resolved, action: { operation: "host.status" } }); }
	catch { throw new HostControlError("forbidden", "Host requester identity is invalid"); }
	return resolved;
}
