import { createHash } from "node:crypto";
import { Type, type TSchema } from "typebox";
import { Check } from "typebox/value";
import { MatrixUserIdSchema } from "../contracts.js";
import {
	APPROVAL_LIFETIME_MS, HOST_CONTROL_VERSION, HostRequestSchema, HostActionSchema,
	isHostMutation, parseHostRequest, type HostAction, type HostRequest,
} from "../live-workspace-contracts.js";

export type ModelHostRequest = HostRequest & { actor: Extract<HostRequest["actor"], { kind: "model" }> };
export type FrozenJson = null | boolean | number | string | FrozenJson[] | { [key: string]: FrozenJson };
/** Private owner data is never rendered or accepted as model tool arguments. */
export interface FrozenHostEffects { effects: HostAction[]; preconditions: { [key: string]: FrozenJson } }
export type HostApprovalPhase = "prepared" | "presented" | "approved" | "denied" | "expired" | "cancelled" | "accepted";
export interface HostApprovalRecord {
	version: typeof HOST_CONTROL_VERSION; hostId: string; approvalId: string; payloadDigest: string;
	request: ModelHostRequest; frozen: FrozenHostEffects; createdAt: number; expiresAt: number; phase: HostApprovalPhase;
	presentation?: { kind: "matrix_poll" | "local_dialog"; id: string };
	decision?: { choice: "approve" | "deny"; at: number; voter: { kind: "local" } | { kind: "matrix"; userId: string; eventId: string } };
	acceptedAt?: number;
}

const strict = <T extends Record<string, TSchema>>(fields: T) => Type.Object(fields, { additionalProperties: false });
const timestamp = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER - APPROVAL_LIFETIME_MS });
const schema = strict({
	version: Type.Literal(HOST_CONTROL_VERSION), hostId: Type.String({ minLength: 1, maxLength: 128 }),
	approvalId: Type.String({ pattern: "^approval_[a-f0-9]{32}$" }), payloadDigest: Type.String({ pattern: "^[a-f0-9]{64}$" }),
	request: HostRequestSchema,
	frozen: strict({ effects: Type.Array(HostActionSchema, { minItems: 1, maxItems: 100 }), preconditions: Type.Unknown() }),
	createdAt: timestamp, expiresAt: timestamp,
	phase: Type.Enum(["prepared", "presented", "approved", "denied", "expired", "cancelled", "accepted"]),
	presentation: Type.Optional(strict({ kind: Type.Enum(["matrix_poll", "local_dialog"]), id: Type.String({ minLength: 1, maxLength: 255 }) })),
	decision: Type.Optional(strict({ choice: Type.Enum(["approve", "deny"]), at: timestamp,
		voter: Type.Union([strict({ kind: Type.Literal("local") }), strict({ kind: Type.Literal("matrix"), userId: MatrixUserIdSchema, eventId: Type.String({ pattern: "^\\$\\S{1,254}$" }) })]) })),
	acceptedAt: Type.Optional(timestamp),
});

function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
	return JSON.stringify(value);
}

function validatePrivateJson(value: unknown): void {
	let nodes = 0;
	function visit(item: unknown, depth: number): void {
		if (++nodes > 4096 || depth > 12) throw Error("Approval preconditions exceed structural bounds");
		if (item === null || typeof item === "boolean") return;
		if (typeof item === "number" && Number.isSafeInteger(item)) return;
		if (typeof item === "string" && item.length <= 4096) return;
		if (Array.isArray(item)) { for (const child of item) visit(child, depth + 1); return; }
		if (item && typeof item === "object" && (Object.getPrototypeOf(item) === Object.prototype || Object.getPrototypeOf(item) === null)) {
			for (const [key, child] of Object.entries(item)) {
				if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(key) || ["constructor", "prototype"].includes(key)) throw Error("Invalid approval precondition key");
				visit(child, depth + 1);
			}
			return;
		}
		throw Error("Approval preconditions must be bounded JSON data");
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Approval preconditions must be an object");
	visit(value, 0);
}

export function hostApprovalId(hostId: string, actor: ModelHostRequest["actor"]): string {
	const hash = createHash("sha256").update("pi-managed-sessions:approval:live-v1\0");
	for (const part of [hostId, actor.conversationId, actor.generationId, actor.runId, actor.toolCallId]) hash.update(`${Buffer.byteLength(part, "utf8")}:`).update(part);
	return `approval_${hash.digest("hex").slice(0, 32)}`;
}

export function hostApprovalRequestDigest(request: ModelHostRequest): string {
	const { requestId: _correlation, ...actor } = request.actor;
	return createHash("sha256").update(canonical({ actor, action: request.action })).digest("hex");
}

function payloadDigest(record: Pick<HostApprovalRecord, "hostId" | "request" | "frozen" | "createdAt" | "expiresAt">): string {
	const { requestId: _correlation, ...actor } = record.request.actor;
	return createHash("sha256").update(canonical({ hostId: record.hostId, actor, action: record.request.action, frozen: record.frozen,
		createdAt: record.createdAt, expiresAt: record.expiresAt })).digest("hex");
}

export function parseHostApprovalRecord(value: unknown): HostApprovalRecord {
	if (!Check(schema, value)) throw Error("Invalid host approval record");
	const record = value as HostApprovalRecord;
	const request = parseHostRequest(record.request);
	if (request.actor.kind !== "model" || !isHostMutation(request.action) || record.frozen.effects.some((effect) => !isHostMutation(effect))) throw Error("Approval requires model mutation effects");
	for (const action of record.frozen.effects) parseHostRequest({ ...request, action });
	validatePrivateJson(record.frozen.preconditions);
	// This bounds pending consent only; completed outcomes are not stored for replay.
	if (Buffer.byteLength(JSON.stringify({ request: record.request, frozen: record.frozen }), "utf8") > 60 * 1024) throw Error("Host approval frozen input exceeds bounds");
	if (Buffer.byteLength(JSON.stringify(record), "utf8") > 128 * 1024) throw Error("Host approval record exceeds bounds");
	if (record.approvalId !== hostApprovalId(record.hostId, record.request.actor) || record.payloadDigest !== payloadDigest(record) || record.expiresAt !== record.createdAt + APPROVAL_LIFETIME_MS)
		throw Error("Host approval identity or frozen payload changed");
	if (record.presentation && (record.presentation.kind !== request.actor.presentation || !(record.presentation.kind === "matrix_poll" ? /^\$\S{1,254}$/ : /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/).test(record.presentation.id))) throw Error("Approval presentation changed origin or has an invalid receipt");
	if (record.decision && (record.decision.voter.kind === "local") !== (request.actor.presentation === "local_dialog")) throw Error("Approval voter changed presentation origin");
	if (record.phase === "prepared" && record.presentation) throw Error("Prepared approval already has a presentation receipt");
	if (["presented", "approved", "denied", "accepted"].includes(record.phase) && !record.presentation) throw Error("Approval presentation receipt is missing");
	if (record.decision && (record.decision.at < record.createdAt || record.decision.at >= record.expiresAt)) throw Error("Approval decision is outside its original lifetime");
	if (["prepared", "presented"].includes(record.phase) && record.decision) throw Error("Unresolved approval has a decision");
	if (record.phase === "denied" && record.decision?.choice !== "deny") throw Error("Denied approval requires a denial");
	if (["approved", "accepted"].includes(record.phase) && record.decision?.choice !== "approve") throw Error("Approval consent is missing");
	const accepted = record.phase === "accepted";
	if (accepted !== (record.acceptedAt !== undefined)) throw Error("Approval acceptance phase is inconsistent");
	if (record.acceptedAt !== undefined && (record.acceptedAt < record.decision!.at || record.acceptedAt >= record.expiresAt)) throw Error("Approval acceptance is outside its original lifetime");
	return structuredClone(record);
}

const nextPhases: Record<HostApprovalPhase, readonly HostApprovalPhase[]> = {
	prepared: ["presented", "expired", "cancelled"], presented: ["approved", "denied", "expired", "cancelled"],
	approved: ["accepted", "expired", "cancelled"], accepted: [],
	denied: [], expired: [], cancelled: [],
};
type ApprovalTransition = Partial<Pick<HostApprovalRecord, "phase" | "presentation" | "decision" | "acceptedAt">>;

/** Repeated votes cannot rewrite or reuse consumed consent. This is not an execution replay journal. */
export function transitionHostApproval(value: HostApprovalRecord, patch: ApprovalTransition): HostApprovalRecord {
	if (Object.keys(patch).some((key) => !["phase", "presentation", "decision", "acceptedAt"].includes(key))) throw Error("Approval frozen fields cannot be changed");
	const current = parseHostApprovalRecord(value); const next = parseHostApprovalRecord({ ...current, ...structuredClone(patch) });
	if (canonical(current) === canonical(next)) return next;
	if (!nextPhases[current.phase].includes(next.phase)) throw Error("Invalid host approval phase transition");
	for (const key of ["presentation", "decision", "acceptedAt"] as const)
		if (current[key] !== undefined && canonical(current[key]) !== canonical(next[key])) throw Error("Host approval receipt cannot be replaced");
	return next;
}

/** Call only after the authenticated frontend and owner have resolved origin and all effects. */
export function prepareHostApproval(hostId: string, request: ModelHostRequest, frozen: FrozenHostEffects, now: number): HostApprovalRecord {
	parseHostRequest(request); validatePrivateJson(frozen.preconditions);
	const input = structuredClone({ version: HOST_CONTROL_VERSION, hostId, request, frozen, createdAt: now, expiresAt: now + APPROVAL_LIFETIME_MS, phase: "prepared" as const });
	return parseHostApprovalRecord({ ...input, approvalId: hostApprovalId(hostId, request.actor), payloadDigest: payloadDigest(input) });
}
