import { ALOOP_LIFECYCLE_ENTRY_TYPE, parseAloopLifecycleEvent } from "../aloop-lifecycle.js";
import {
	MANAGED_SESSION_PROTOCOL_VERSION,
	MANAGED_SESSION_STATE_VERSION,
	MAX_NDJSON_FRAME_BYTES,
	MAX_PROJECTION_ENTRIES,
	deriveTranscriptEntryId,
} from "../contracts.js";

export const BINDING_ENTRY_TYPE = "managed-session.binding";
export const BINDING_BOUNDARY_ENTRY_TYPE = "managed-session.binding-boundary";
export const UNBOUND_ENTRY_TYPE = "managed-session.unbound";
export const DELIVERY_ENTRY_TYPE = "managed-session.delivery";
export const PROJECTION_ENTRY_TYPE = "managed-session.projection";
export const PROJECTION_DIAGNOSTIC_ENTRY_TYPE = "managed-session.projection-diagnostic";
export const CHECKPOINT_ENTRY_TYPE = "managed-session.checkpoint";

export type AdapterRole = "ordinary_adapter" | "coordinator_adapter";

export interface SessionBinding {
	version: typeof MANAGED_SESSION_STATE_VERSION;
	conversationId: string;
	concept: string;
	sessionId: string;
	bindingBoundaryEntryId: string;
	role: AdapterRole;
}

export interface BindingAttempt {
	version: typeof MANAGED_SESSION_STATE_VERSION;
	creationKey: string;
	concept: string;
	sessionId: string;
	entryKey: string;
}

export interface ProjectionMarker {
	version: typeof MANAGED_SESSION_STATE_VERSION;
	entryId: string;
	piEntryKey: string;
	kind: "local_user" | "assistant_final";
	status: "offered" | "projected" | "blocked";
	reason?: "oversized" | "backfill_limit" | "aloop_private";
}

export interface EligibleTranscriptEntry {
	entryId: string;
	piEntryKey: string;
	kind: "local_user" | "assistant_final";
	body: string;
}

export interface ManagedCheckpointMarker {
	version: typeof MANAGED_SESSION_STATE_VERSION;
	checkpointId: string;
	originDeliveryId: string;
	checkpoint: Record<string, unknown>;
	status: "offered" | "projected";
}

export interface DeliveryMarker {
	version: typeof MANAGED_SESSION_STATE_VERSION;
	deliveryId: string;
	matrixEventId: string;
	kind: "prompt" | "follow_up" | "steer" | "abort";
	status: "accepted" | "expanded" | "reinjecting" | "persisted" | "completed" | "cancelled";
	piEntryId?: string;
	expandedText?: string;
	completionKind?: "extension_command";
}

interface CustomEntry {
	type?: unknown;
	id?: unknown;
	customType?: unknown;
	data?: unknown;
}

function customData(entry: unknown, customType: string): { id: string; data: Record<string, unknown> } | undefined {
	if (typeof entry !== "object" || entry === null) return undefined;
	const candidate = entry as CustomEntry;
	if (candidate.type !== "custom" || candidate.customType !== customType || typeof candidate.id !== "string" ||
		typeof candidate.data !== "object" || candidate.data === null || Array.isArray(candidate.data)) return undefined;
	return { id: candidate.id, data: candidate.data as Record<string, unknown> };
}

function isBinding(value: Record<string, unknown>): boolean {
	return value.version === MANAGED_SESSION_STATE_VERSION &&
		typeof value.conversationId === "string" && /^conv_[a-f0-9]{32}$/.test(value.conversationId) &&
		typeof value.concept === "string" && value.concept.length > 0 && value.concept.length <= 128 &&
		typeof value.sessionId === "string" && typeof value.bindingBoundaryEntryId === "string" &&
		/^entry_[a-f0-9]{32}$/.test(value.bindingBoundaryEntryId) &&
		(value.role === "ordinary_adapter" || value.role === "coordinator_adapter");
}

function isDelivery(value: Record<string, unknown>): boolean {
	return value.version === MANAGED_SESSION_STATE_VERSION &&
		typeof value.deliveryId === "string" && /^delivery_[a-f0-9]{32}$/.test(value.deliveryId) &&
		typeof value.matrixEventId === "string" &&
		["prompt", "follow_up", "steer", "abort"].includes(String(value.kind)) &&
		["accepted", "expanded", "reinjecting", "persisted", "completed", "cancelled"].includes(String(value.status)) &&
		(value.piEntryId === undefined || (typeof value.piEntryId === "string" && /^entry_[a-f0-9]{32}$/.test(value.piEntryId))) &&
		(value.expandedText === undefined || typeof value.expandedText === "string") &&
		(value.completionKind === undefined || value.completionKind === "extension_command") &&
		(!["expanded", "reinjecting", "persisted", "completed"].includes(String(value.status)) || typeof value.expandedText === "string") &&
		(value.status !== "persisted" || typeof value.piEntryId === "string") &&
		(value.status !== "completed" || typeof value.piEntryId === "string" || value.completionKind === "extension_command") &&
		(value.completionKind !== "extension_command" || (value.status === "completed" && value.piEntryId === undefined));
}

export function restoreSessionBinding(entries: readonly unknown[], sessionId: string, role: AdapterRole): SessionBinding | undefined {
	let binding: SessionBinding | undefined;
	for (const entry of entries) {
		const unbound = customData(entry, UNBOUND_ENTRY_TYPE);
		if (unbound?.data.version === MANAGED_SESSION_STATE_VERSION && unbound.data.sessionId === sessionId) binding = undefined;
		const candidate = customData(entry, BINDING_ENTRY_TYPE);
		if (candidate && isBinding(candidate.data) && candidate.data.sessionId === sessionId) {
			const next = candidate.data as unknown as SessionBinding;
			if (next.role !== role) throw new Error(`Managed-session binding role mismatch for ${sessionId}`);
			if (binding && binding.conversationId !== next.conversationId) throw new Error(`Conflicting managed-session binding for ${sessionId}`);
			binding = next;
		}
	}
	return binding;
}

export function restoreBindingAttempt(entries: readonly unknown[], sessionId: string, concept: string): BindingAttempt | undefined {
	let attempt: BindingAttempt | undefined;
	for (const entry of entries) {
		const unbound = customData(entry, UNBOUND_ENTRY_TYPE);
		if (unbound?.data.version === MANAGED_SESSION_STATE_VERSION && unbound.data.sessionId === sessionId) attempt = undefined;
		const candidate = customData(entry, BINDING_BOUNDARY_ENTRY_TYPE);
		if (!candidate || candidate.data.version !== MANAGED_SESSION_STATE_VERSION || candidate.data.sessionId !== sessionId ||
			candidate.data.concept !== concept || typeof candidate.data.creationKey !== "string") continue;
		attempt = {
			version: MANAGED_SESSION_STATE_VERSION,
			creationKey: candidate.data.creationKey,
			concept,
			sessionId,
			entryKey: candidate.id,
		};
	}
	return attempt;
}

export function restoreDeliveries(entries: readonly unknown[]): Map<string, DeliveryMarker> {
	const deliveries = new Map<string, DeliveryMarker>();
	const rank: Record<DeliveryMarker["status"], number> = { accepted: 0, expanded: 1, reinjecting: 1, persisted: 2, completed: 3, cancelled: 3 };
	for (const entry of entries) {
		if (customData(entry, UNBOUND_ENTRY_TYPE) || customData(entry, BINDING_ENTRY_TYPE)) deliveries.clear();
		const candidate = customData(entry, DELIVERY_ENTRY_TYPE);
		if (!candidate || !isDelivery(candidate.data)) continue;
		const marker = candidate.data as unknown as DeliveryMarker;
		const previous = deliveries.get(marker.deliveryId);
		if (previous) {
			if (previous.matrixEventId !== marker.matrixEventId || previous.kind !== marker.kind || rank[marker.status] < rank[previous.status] ||
				(previous.status === "reinjecting" && marker.status === "expanded") ||
				((previous.status === "completed" || previous.status === "cancelled") && marker.status !== previous.status)) {
				throw new Error(`Conflicting managed-session delivery history ${marker.deliveryId}`);
			}
		}
		deliveries.set(marker.deliveryId, marker);
	}
	return deliveries;
}

export function findDeliveredUserEntry(entries: readonly unknown[], deliveryId: string): string | undefined {
	let expandedEntryId: string | undefined;
	for (const entry of entries) {
		const marker = customData(entry, DELIVERY_ENTRY_TYPE);
		if (marker?.data.deliveryId === deliveryId && (marker.data.status === "expanded" || marker.data.status === "reinjecting")) expandedEntryId = marker.id;
	}
	if (!expandedEntryId) return undefined;
	for (const entry of entries) {
		if (typeof entry !== "object" || entry === null) continue;
		const candidate = entry as { type?: unknown; id?: unknown; parentId?: unknown; message?: unknown };
		if (candidate.type !== "message" || candidate.parentId !== expandedEntryId || typeof candidate.id !== "string" ||
			typeof candidate.message !== "object" || candidate.message === null || (candidate.message as { role?: unknown }).role !== "user") continue;
		return candidate.id;
	}
	return undefined;
}

export function restoreCheckpoints(entries: readonly unknown[]): Map<string, ManagedCheckpointMarker> {
	const checkpoints = new Map<string, ManagedCheckpointMarker>();
	for (const entry of entries) {
		if (customData(entry, UNBOUND_ENTRY_TYPE) || customData(entry, BINDING_ENTRY_TYPE)) checkpoints.clear();
		const candidate = customData(entry, CHECKPOINT_ENTRY_TYPE);
		if (!candidate) continue;
		const value = candidate.data;
		if (value.version !== MANAGED_SESSION_STATE_VERSION || typeof value.checkpointId !== "string" ||
			!/^checkpoint-[a-f0-9]{32}$/.test(value.checkpointId) || typeof value.originDeliveryId !== "string" ||
			!/^delivery_[a-f0-9]{32}$/.test(value.originDeliveryId) || typeof value.checkpoint !== "object" || value.checkpoint === null ||
			(value.status !== "offered" && value.status !== "projected")) continue;
		const marker = value as unknown as ManagedCheckpointMarker;
		const previous = checkpoints.get(marker.checkpointId);
		if (previous && (previous.originDeliveryId !== marker.originDeliveryId || JSON.stringify(previous.checkpoint) !== JSON.stringify(marker.checkpoint) ||
			(previous.status === "projected" && marker.status !== "projected"))) throw new Error(`Conflicting managed-session checkpoint history ${marker.checkpointId}`);
		checkpoints.set(marker.checkpointId, marker);
	}
	return checkpoints;
}

export function restoreProjections(entries: readonly unknown[]): Map<string, ProjectionMarker> {
	const projections = new Map<string, ProjectionMarker>();
	for (const entry of entries) {
		if (customData(entry, UNBOUND_ENTRY_TYPE) || customData(entry, BINDING_ENTRY_TYPE)) projections.clear();
		const candidate = customData(entry, PROJECTION_ENTRY_TYPE);
		if (!candidate) continue;
		const value = candidate.data;
		if (value.version !== MANAGED_SESSION_STATE_VERSION || typeof value.entryId !== "string" ||
			!/^entry_[a-f0-9]{32}$/.test(value.entryId) || typeof value.piEntryKey !== "string" ||
			(value.kind !== "local_user" && value.kind !== "assistant_final") ||
			!(["offered", "projected", "blocked"] as unknown[]).includes(value.status) ||
			(value.reason !== undefined && value.reason !== "oversized" && value.reason !== "backfill_limit" && value.reason !== "aloop_private")) continue;
		const marker = value as unknown as ProjectionMarker;
		const previous = projections.get(marker.entryId);
		if (previous && (previous.piEntryKey !== marker.piEntryKey || previous.kind !== marker.kind ||
			(previous.status === "projected" && marker.status !== "projected"))) {
			throw new Error(`Conflicting managed-session projection history ${marker.entryId}`);
		}
		projections.set(marker.entryId, marker);
	}
	return projections;
}

function textContent(content: unknown, allowThinking: boolean): string | undefined {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return undefined;
	const text: string[] = [];
	for (const block of content) {
		if (typeof block !== "object" || block === null) return undefined;
		const value = block as { type?: unknown; text?: unknown };
		if (value.type === "text" && typeof value.text === "string") text.push(value.text);
		else if (!(allowThinking && value.type === "thinking")) return undefined;
	}
	return text.join("");
}

export function aloopPrivateAssistantEntryKeys(entries: readonly unknown[]): Set<string> {
	const privateEntries = new Set<string>();
	let privateScope = false;
	let terminal = false;
	for (const value of entries) {
		const lifecycle = customData(value, ALOOP_LIFECYCLE_ENTRY_TYPE);
		if (lifecycle) {
			const event = parseAloopLifecycleEvent(lifecycle.data);
			if (!event) continue;
			privateScope = true;
			terminal = event.kind !== "startup" && event.kind !== "recovery" && event.kind !== "checkpoint";
			continue;
		}
		const delivery = customData(value, DELIVERY_ENTRY_TYPE);
		if (delivery?.data.status === "accepted" && privateScope && terminal) {
			privateScope = false;
			terminal = false;
			continue;
		}
		if (!privateScope || typeof value !== "object" || value === null) continue;
		const entry = value as { type?: unknown; id?: unknown; message?: unknown };
		if (entry.type === "message" && typeof entry.id === "string" && typeof entry.message === "object" && entry.message !== null && (entry.message as { role?: unknown }).role === "assistant") privateEntries.add(entry.id);
	}
	return privateEntries;
}

export function eligibleTranscriptEntries(
	entries: readonly unknown[],
	binding: SessionBinding,
	deliveries: ReadonlyMap<string, DeliveryMarker>,
): EligibleTranscriptEntry[] {
	const boundaryIndex = entries.findIndex((entry) =>
		typeof entry === "object" && entry !== null && typeof (entry as { id?: unknown }).id === "string" &&
		persistedEntryId(binding.sessionId, (entry as { id: string }).id) === binding.bindingBoundaryEntryId);
	if (boundaryIndex < 0) throw new Error("Managed-session binding boundary is absent from the Pi branch");
	const branch = entries.slice(boundaryIndex + 1);
	const matrixEntryIds = new Set([...deliveries.values()]
		.filter((delivery) => delivery.status === "persisted" || delivery.status === "completed")
		.map((delivery) => delivery.piEntryId).filter((value): value is string => value !== undefined));
	const pendingMatrixUserParents = new Set(branch.flatMap((value) => {
		const marker = customData(value, DELIVERY_ENTRY_TYPE);
		if (!marker || (marker.data.status !== "expanded" && marker.data.status !== "reinjecting") ||
			typeof marker.data.deliveryId !== "string" || !deliveries.has(marker.data.deliveryId)) return [];
		return [marker.id];
	}));
	const result: EligibleTranscriptEntry[] = [];
	let checkpointBoundary = false;
	for (const value of branch) {
		if (customData(value, CHECKPOINT_ENTRY_TYPE)?.data.status === "offered") { checkpointBoundary = true; continue; }
		if (typeof value !== "object" || value === null) continue;
		const entry = value as { type?: unknown; id?: unknown; parentId?: unknown; message?: unknown };
		if (entry.type !== "message" || typeof entry.id !== "string" || typeof entry.message !== "object" || entry.message === null) continue;
		const message = entry.message as { role?: unknown; content?: unknown; stopReason?: unknown };
		const entryId = persistedEntryId(binding.sessionId, entry.id);
		if (message.role === "user") {
			checkpointBoundary = false;
			if (matrixEntryIds.has(entryId) || (typeof entry.parentId === "string" && pendingMatrixUserParents.has(entry.parentId))) continue;
			const body = textContent(message.content, false);
			if (body) result.push({ entryId, piEntryKey: entry.id, kind: "local_user", body });
			continue;
		}
		if (message.role !== "assistant" || message.stopReason !== "stop" || checkpointBoundary) continue;
		const body = textContent(message.content, true);
		if (body) result.push({ entryId, piEntryKey: entry.id, kind: "assistant_final", body });
	}
	return result;
}

export function hasBackfillDiagnostic(entries: readonly unknown[], binding: SessionBinding, pendingCount: number): boolean {
	return entries.some((entry) => {
		const diagnostic = customData(entry, PROJECTION_DIAGNOSTIC_ENTRY_TYPE)?.data;
		return diagnostic?.version === MANAGED_SESSION_STATE_VERSION &&
			diagnostic.bindingBoundaryEntryId === binding.bindingBoundaryEntryId && diagnostic.pendingCount === pendingCount &&
			diagnostic.limit === MAX_PROJECTION_ENTRIES && diagnostic.reason === "backfill_limit";
	});
}

export function hasProjectionCapacityDiagnostic(entries: readonly unknown[], binding: SessionBinding, entryId: string): boolean {
	return entries.some((entry) => {
		const diagnostic = customData(entry, PROJECTION_DIAGNOSTIC_ENTRY_TYPE)?.data;
		return diagnostic?.version === MANAGED_SESSION_STATE_VERSION &&
			diagnostic.bindingBoundaryEntryId === binding.bindingBoundaryEntryId && diagnostic.entryId === entryId &&
			diagnostic.reason === "capacity_reached";
	});
}

export function transcriptOfferWithinFrame(entry: EligibleTranscriptEntry, binding: SessionBinding): boolean {
	const envelope = {
		protocolVersion: MANAGED_SESSION_PROTOCOL_VERSION,
		messageId: "transcript-00000000-0000-4000-8000-000000000000",
		conversationId: binding.conversationId,
		role: binding.role,
		type: "transcript.offer",
		payload: { ...entry, piSessionId: binding.sessionId },
	};
	return Buffer.byteLength(`${JSON.stringify(envelope)}\n`, "utf8") <= MAX_NDJSON_FRAME_BYTES;
}

export function planTranscriptBackfill(
	entries: readonly unknown[],
	binding: SessionBinding,
	deliveries: ReadonlyMap<string, DeliveryMarker>,
	projections: ReadonlyMap<string, ProjectionMarker>,
): { entries: EligibleTranscriptEntry[]; excessiveCount?: number } {
	const pending = eligibleTranscriptEntries(entries, binding, deliveries)
		.filter((entry) => projections.get(entry.entryId)?.status !== "projected" && projections.get(entry.entryId)?.status !== "blocked");
	if (pending.length > MAX_PROJECTION_ENTRIES) return { entries: [], excessiveCount: pending.length };
	return { entries: pending };
}

export function persistedEntryId(sessionId: string, piEntryKey: string): string {
	return deriveTranscriptEntryId(sessionId, piEntryKey);
}

export function normalizeConcept(input: string): string | undefined {
	const concept = input.trim().replace(/\s+/g, " ");
	return concept && concept.length <= 128 && !/[\u0000-\u001f\u007f]/.test(concept) ? concept : undefined;
}
