import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { DeliveryIdSchema, GenerationIdSchema } from "./identity-contracts.js";

const identifier = Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" });
/** Trusted adapter observation, never a model tool argument. No sender or room authority fields. */
export const HostRunWitnessSchema = Type.Object({
	generationId: GenerationIdSchema, runId: identifier, phase: Type.Enum(["active", "ended"]),
	sources: Type.Array(Type.Union([
		Type.Object({ kind: Type.Literal("local") }, { additionalProperties: false }),
		Type.Object({ kind: Type.Literal("matrix"), deliveryId: DeliveryIdSchema }, { additionalProperties: false }),
	]), { maxItems: 32, uniqueItems: true }),
	toolCallIds: Type.Array(identifier, { maxItems: 64, uniqueItems: true }),
}, { additionalProperties: false });
export type HostRunWitness = Static<typeof HostRunWitnessSchema>;

export function parseHostRunWitness(value: unknown): HostRunWitness {
	if (!Check(HostRunWitnessSchema, value) || Buffer.byteLength(JSON.stringify(value), "utf8") > 16 * 1024) throw Error("Invalid host run witness");
	const witness = value as HostRunWitness;
	if (witness.phase === "ended" && witness.toolCallIds.length !== 0) throw Error("Ended host run still has active tools");
	return structuredClone(witness);
}
