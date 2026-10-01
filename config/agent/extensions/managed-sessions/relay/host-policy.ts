import { Type } from "typebox";
import { Check } from "typebox/value";
import {
	HOST_CONTROL_VERSION, HostActionSchema, HostResultSchemas, hostActionPolicy, isHostMutation, parseHostRequest,
} from "../live-workspace-contracts.js";

const entry = Type.Object({
	human: Type.Union([Type.Literal("direct"), Type.Literal("confirmed"), Type.Literal("approval"), Type.Literal("deny")]),
	model: Type.Union([Type.Literal("direct"), Type.Literal("approval"), Type.Literal("deny")]),
}, { additionalProperties: false });
const policySchema = Type.Object({ version: Type.Literal(HOST_CONTROL_VERSION), actions: Type.Record(Type.String(), entry) }, { additionalProperties: false });
export type HostPolicyDecision = "direct" | "approval" | "forbidden";

/** Immutable deployment policy. Requester authentication belongs to the calling frontend. */
export class HostPolicy {
	private readonly actions: Readonly<Record<string, { human: "direct" | "confirmed" | "approval" | "deny"; model: "direct" | "approval" | "deny" }>>;
	constructor(value: unknown) {
		if (!Check(policySchema, value) || Buffer.byteLength(JSON.stringify(value), "utf8") > 64 * 1024) throw Error("Invalid managed host policy");
		const actions = (value as { actions: HostPolicy["actions"] }).actions;
		for (const [operation, policy] of Object.entries(actions)) {
			if (!Object.hasOwn(HostResultSchemas, operation)) throw Error("Unknown managed host policy action");
			const schema = HostActionSchema.anyOf.find((item) => item.properties.operation.const === operation)!;
			// The source schema, not an override, determines whether an operation is a read.
			if (policy.model === "direct" && isHostMutation({ operation: schema.properties.operation.const })) throw Error("Model mutations cannot bypass approval");
			if (policy.human === "confirmed" && !("confirmed" in schema.properties)) throw Error("Action has no explicit confirmation contract");
		}
		this.actions = structuredClone(actions);
	}

	decide(value: unknown, protectedConversationId: string): HostPolicyDecision {
		const { action, actor } = parseHostRequest(value);
		if (hostActionPolicy(action, actor, protectedConversationId) === "forbidden") return "forbidden";
		const configured = this.actions[action.operation];
		// A valid but unclassified action is never an implicit grant.
		if (!configured) return "approval";
		const decision = actor.kind === "model" ? configured.model : configured.human;
		if (decision === "deny") return "forbidden";
		if (actor.kind === "model" && isHostMutation(action)) return "approval";
		if (decision === "confirmed") return "confirmed" in action && action.confirmed ? "direct" : "approval";
		return decision;
	}
}
