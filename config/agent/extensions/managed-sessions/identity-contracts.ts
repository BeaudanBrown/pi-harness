import { Type } from "typebox";

// Shared leaves keep adapter and host-action contracts acyclic. Re-exported by contracts.ts.
export const ConversationIdSchema = Type.String({ pattern: "^conv_[a-f0-9]{32}$" });
export const GenerationIdSchema = Type.String({ pattern: "^generation_[a-f0-9]{32}$" });
export const DeliveryIdSchema = Type.String({ pattern: "^delivery_[a-f0-9]{32}$" });
export const MatrixUserIdSchema = Type.String({ maxLength: 512, pattern: "^@[^\\s:]{1,255}:[^\\s]{1,255}$" });
export const WorkspaceIdentitySchema = Type.Object({
	rootKey: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" }),
	workspace: Type.String({ minLength: 1, maxLength: 128 }),
	relativeCwd: Type.String({ minLength: 0, maxLength: 512 }),
}, { additionalProperties: false });
