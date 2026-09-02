import { createHash } from "node:crypto";
import { Type, type TSchema } from "typebox";
import { Check, Errors } from "typebox/value";
import { ManagedSessionContractError, parseConversationManifest, parseHostRuntimeState } from "./contracts.js";

export const MANAGED_SESSION_V2_VERSION = "2.0.0" as const;
export const MAX_MEDIA_CHUNK_BYTES = 32 * 1024;
export const MAX_BLOB_BYTES = 25 * 1024 * 1024;
export const MAX_BLOBS = 128;
export const MAX_SPOOL_BYTES = 256 * 1024 * 1024;
const strict = <T extends Record<string, TSchema>>(p: T) => Type.Object(p, { additionalProperties: false });
const id = (p: string) => Type.String({ pattern: `^${p}_[a-f0-9]{32}$` });
const text = (n: number) => Type.String({ minLength: 1, maxLength: n });
const digest = Type.String({ pattern: "^[a-f0-9]{64}$" });
const conversationId = id("conv");
const generationId = id("generation");
const base = { protocolVersion: Type.Literal(MANAGED_SESSION_V2_VERSION), messageId: text(128), conversationId };
const envelope = (role: string, type: string, payload: TSchema) => strict({ ...base, role: Type.Literal(role), type: Type.Literal(type), payload });

const activity = Type.Union([
	envelope("ordinary_adapter", "activity.update", strict({ activityId: id("activity"), revision: Type.Integer({ minimum: 0 }), state: Type.Union([Type.Literal("busy"), Type.Literal("tool")]), toolName: Type.Optional(text(128)) })),
	envelope("ordinary_adapter", "activity.finalize", strict({ activityId: id("activity"), revision: Type.Integer({ minimum: 1 }), run: strict({ inputTokens: Type.Integer({ minimum: 0 }), outputTokens: Type.Integer({ minimum: 0 }) }), context: strict({ usedTokens: Type.Integer({ minimum: 0 }), limitTokens: Type.Integer({ minimum: 1 }) }) })),
]);
const controlName = Type.Union(["help", "status", "model", "thinking", "compact", "new", "stop", "abort", "steer"].map((value) => Type.Literal(value)));
const control = envelope("relay", "control.deliver", strict({ controlId: id("control"), name: controlName, argument: Type.Optional(text(16_000)) }));
const poll = Type.Union([
	envelope("ordinary_adapter", "poll.open", strict({ pollId: id("poll"), question: text(1_200), options: Type.Array(text(300), { minItems: 2, maxItems: 8 }) })),
	envelope("relay", "poll.resolve", strict({ pollId: id("poll"), resolution: Type.Union([strict({ kind: Type.Literal("vote"), optionIndex: Type.Integer({ minimum: 0, maximum: 7 }) }), strict({ kind: Type.Literal("text"), body: text(16_000) })]) })),
]);
const media = Type.Union([
	envelope("relay", "media.begin", strict({ blobId: id("blob"), mediaType: Type.Union([Type.Literal("image")]), mimeType: text(128), byteLength: Type.Integer({ minimum: 1, maximum: MAX_BLOB_BYTES }), sha256: digest, caption: Type.Optional(text(16_000)), chunkCount: Type.Integer({ minimum: 1, maximum: 800 }) })),
	envelope("relay", "media.chunk", strict({ blobId: id("blob"), index: Type.Integer({ minimum: 0, maximum: 799 }), data: Type.String({ minLength: 1, maxLength: 43_692 }) })),
	envelope("ordinary_adapter", "media.export", strict({ uploadId: id("upload"), workspaceArtifactId: text(128), mediaType: Type.Union([Type.Literal("image"), Type.Literal("audio"), Type.Literal("file")]) })),
]);
const generation = Type.Union([
	envelope("relay", "generation.activate", strict({ transitionId: id("transition"), generationId, ordinal: Type.Integer({ minimum: 1 }) })),
	envelope("ordinary_adapter", "generation.new", strict({ transitionId: id("transition"), expectedGenerationId: generationId })),
]);
export const ManagedSessionV2EnvelopeSchema = Type.Union([activity, control, poll, media, generation]);

export interface SessionGeneration { generationId: string; ordinal: number; piSessionId: string; bindingBoundaryEntryId: string; createdAt: string; }
export interface ConversationManifestV2 { schemaVersion: typeof MANAGED_SESSION_V2_VERSION; kind: "project" | "coordinator"; conversationId: string; ownerHostId: string; creationKey: string; concept: string; roomId: string; placement?: { rootKey: string; workspace: string; relativeCwd: string }; projectSpace?: string; hostSpace?: string; activeGenerationId: string; generations: SessionGeneration[]; createdAt: string; }
const generationSchema = strict({ generationId, ordinal: Type.Integer({ minimum: 1 }), piSessionId: text(128), bindingBoundaryEntryId: id("entry"), createdAt: text(35) });
export const ConversationManifestV2Schema = strict({ schemaVersion: Type.Literal(MANAGED_SESSION_V2_VERSION), kind: Type.Union([Type.Literal("project"), Type.Literal("coordinator")]), conversationId, ownerHostId: text(128), creationKey: text(128), concept: text(128), roomId: text(255), placement: Type.Optional(strict({ rootKey: text(128), workspace: text(128), relativeCwd: Type.String({ maxLength: 512 }) })), projectSpace: Type.Optional(text(255)), hostSpace: Type.Optional(text(255)), activeGenerationId: generationId, generations: Type.Array(generationSchema, { minItems: 1, maxItems: 256 }), createdAt: text(35) });

function schemaError(schema: TSchema, value: unknown): never { const e = [...Errors(schema, value)][0]; throw new ManagedSessionContractError("malformed", `managed-session v2: ${e?.instancePath || "/"}: ${e?.message || "invalid value"}`); }
export function parseManagedSessionV2Envelope(value: unknown) { if (!Check(ManagedSessionV2EnvelopeSchema, value)) schemaError(ManagedSessionV2EnvelopeSchema, value); const frame = `${JSON.stringify(value)}\n`; if (Buffer.byteLength(frame) > 64 * 1024) throw new ManagedSessionContractError("malformed", "managed-session v2 frame exceeds 65536 bytes"); return value; }
export function parseConversationManifestV2(value: unknown): ConversationManifestV2 { if (!Check(ConversationManifestV2Schema, value)) schemaError(ConversationManifestV2Schema, value); const v = value as ConversationManifestV2; if (v.generations.map(g => g.ordinal).some((n, i) => n !== i + 1) || new Set(v.generations.map(g => g.generationId)).size !== v.generations.length || v.generations.at(-1)?.generationId !== v.activeGenerationId) throw new ManagedSessionContractError("invalid_state", "generation ordinals must be contiguous and only the newest generation may be active"); if ((v.kind === "project") !== (v.placement !== undefined)) throw new ManagedSessionContractError("invalid_state", "project placement and conversation kind disagree"); return v; }
function derive(domain: string, parts: readonly (string | number)[], prefix: string) { const h = createHash("sha256"); h.update(`pi-managed-sessions:${domain}:v2\0`); for (const p of parts) { const s = String(p); h.update(`${Buffer.byteLength(s)}:`); h.update(s); } return `${prefix}_${h.digest("hex").slice(0, 32)}`; }
export const deriveGenerationId = (c: string, ordinal: number) => derive("generation", [c, ordinal], "generation");
export const deriveActivityId = (g: string, span: string) => derive("activity", [g, span], "activity");
export const derivePollId = (g: string, key: string) => derive("poll", [g, key], "poll");
export const deriveBlobId = (c: string, sha256: string) => derive("blob", [c, sha256], "blob");
export const deriveUploadId = (c: string, key: string) => derive("upload", [c, key], "upload");
export const deriveTransitionId = (c: string, from: number, to: number) => derive("transition", [c, from, to], "transition");

export function migrateV1Manifest(value: unknown): ConversationManifestV2 { const old = parseConversationManifest(value); const generationId = deriveGenerationId(old.conversationId, 1); return parseConversationManifestV2({ schemaVersion: MANAGED_SESSION_V2_VERSION, kind: old.kind, conversationId: old.conversationId, ownerHostId: old.ownerHostId, creationKey: old.creationKey, concept: old.concept, roomId: old.roomId, ...(old.placement ? { placement: old.placement } : {}), ...(old.projectSpace ? { projectSpace: old.projectSpace } : {}), ...(old.hostSpace ? { hostSpace: old.hostSpace } : {}), activeGenerationId: generationId, generations: [{ generationId, ordinal: 1, piSessionId: old.piSessionId, bindingBoundaryEntryId: old.bindingBoundaryEntryId, createdAt: old.createdAt }], createdAt: old.createdAt }); }
export function migrateV1Bundle(manifests: unknown[], runtime: unknown) { const oldRuntime = parseHostRuntimeState(runtime); const migrated = manifests.map(migrateV1Manifest); if (migrated.length !== oldRuntime.conversations.length || migrated.some(m => !oldRuntime.conversations.some(r => r.conversationId === m.conversationId))) throw new ManagedSessionContractError("conflict", "v1 migration requires an exact manifest/registry match"); return { manifests: migrated, runtime: { ...oldRuntime, schemaVersion: MANAGED_SESSION_V2_VERSION, conversations: oldRuntime.conversations.map(r => ({ ...r, activeGenerationId: migrated.find(m => m.conversationId === r.conversationId)!.activeGenerationId })) } }; }
