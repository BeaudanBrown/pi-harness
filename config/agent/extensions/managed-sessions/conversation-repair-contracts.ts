import { Type, type Static } from "typebox";
import { MatrixRoomIdSchema } from "../matrix-shared/room-id.js";
const stable = (prefix: string) => Type.String({ pattern: `^${prefix}_[a-f0-9]{32}$` });
const strict = <T extends Record<string, import("typebox").TSchema>>(fields: T) => Type.Object(fields, { additionalProperties: false });
export const RepairQueueHoldSchema = strict({ kind: Type.Union([Type.Literal("input"), Type.Literal("control"), Type.Literal("projection")]),
 id: Type.String({ minLength: 1, maxLength: 255 }), operationId: stable("operation") });
export type RepairQueueHold = Static<typeof RepairQueueHoldSchema>;
export const QueueResumptionReceiptSchema = strict({ operationId: stable("operation"), roomId: MatrixRoomIdSchema, sourceDigest: Type.String({ pattern: "^[a-f0-9]{64}$" }),
 at: Type.String({ minLength: 20, maxLength: 35 }), items: Type.Array(strict({ kind: Type.Union([Type.Literal("input"), Type.Literal("control"), Type.Literal("projection")]),
  id: Type.String({ minLength: 1, maxLength: 255 }), priorState: Type.String({ minLength: 1, maxLength: 32 }), digest: Type.String({ pattern: "^[a-f0-9]{64}$" }) }), { minItems: 1, maxItems: 32 }) });
export type QueueResumptionReceipt = Static<typeof QueueResumptionReceiptSchema>;
export const ConversationRepairReceiptSchema = strict({ operationId: stable("operation"), generationId: stable("generation"),
 planDigest: Type.String({ pattern: "^[a-f0-9]{64}$" }), planJson: Type.Array(Type.String({ maxLength: 4096 }), { minItems: 1, maxItems: 32 }),
 runtimeRepair: Type.Boolean(), expiresAt: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
 phase: Type.Union([Type.Literal("held"), Type.Literal("account_pending"), Type.Literal("runtime_pending"), Type.Literal("complete"), Type.Literal("superseded")]),
 admittedAt: Type.String({ minLength: 20, maxLength: 35 }), updatedAt: Type.String({ minLength: 20, maxLength: 35 }),
});
export type ConversationRepairReceipt = Static<typeof ConversationRepairReceiptSchema>;
