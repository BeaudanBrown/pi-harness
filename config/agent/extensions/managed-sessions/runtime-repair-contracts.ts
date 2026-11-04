import { Type, type Static } from "typebox";

const digest = Type.String({ pattern: "^[a-f0-9]{64}$" });
const time = Type.String({ format: "date-time" });
export const RuntimeRepairReceiptSchema = Type.Object({
	operationId: Type.String({ pattern: "^operation_[a-f0-9]{32}$" }),
	generationId: Type.String({ pattern: "^generation_[a-f0-9]{32}$" }),
	sourceDigest: digest, evidenceDigest: digest,
	closureBasis: Type.Union([Type.Literal("verified_exit"), Type.Literal("operator_attested")]),
	unreadableCount: Type.Integer({ minimum: 0, maximum: 256 }),
	phase: Type.Union([Type.Literal("held"), Type.Literal("reconciled"), Type.Literal("released"), Type.Literal("superseded")]),
	admittedAt: time, reconciledAt: Type.Optional(time), releasedAt: Type.Optional(time), supersededAt: Type.Optional(time),
}, { additionalProperties: false });
export type RuntimeRepairReceipt = Static<typeof RuntimeRepairReceiptSchema>;
