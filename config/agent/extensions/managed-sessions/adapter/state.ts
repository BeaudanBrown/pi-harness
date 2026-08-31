import {
	MANAGED_SESSION_STATE_VERSION,
	deriveTranscriptEntryId,
} from "../contracts.js";

export const BINDING_ENTRY_TYPE = "managed-session.binding";
export const BINDING_BOUNDARY_ENTRY_TYPE = "managed-session.binding-boundary";
export const UNBOUND_ENTRY_TYPE = "managed-session.unbound";
export const DELIVERY_ENTRY_TYPE = "managed-session.delivery";

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

export interface DeliveryMarker {
	version: typeof MANAGED_SESSION_STATE_VERSION;
	deliveryId: string;
	matrixEventId: string;
	kind: "prompt" | "follow_up" | "steer" | "abort";
	status: "accepted" | "expanded" | "persisted" | "completed" | "cancelled";
	piEntryId?: string;
	expandedText?: string;
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
		["accepted", "expanded", "persisted", "completed", "cancelled"].includes(String(value.status)) &&
		(value.piEntryId === undefined || (typeof value.piEntryId === "string" && /^entry_[a-f0-9]{32}$/.test(value.piEntryId))) &&
		(value.expandedText === undefined || typeof value.expandedText === "string") &&
		(!["expanded", "persisted", "completed"].includes(String(value.status)) || typeof value.expandedText === "string") &&
		(!["persisted", "completed"].includes(String(value.status)) || typeof value.piEntryId === "string");
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
	const rank: Record<DeliveryMarker["status"], number> = { accepted: 0, expanded: 1, persisted: 2, completed: 3, cancelled: 3 };
	for (const entry of entries) {
		if (customData(entry, UNBOUND_ENTRY_TYPE) || customData(entry, BINDING_ENTRY_TYPE)) deliveries.clear();
		const candidate = customData(entry, DELIVERY_ENTRY_TYPE);
		if (!candidate || !isDelivery(candidate.data)) continue;
		const marker = candidate.data as unknown as DeliveryMarker;
		const previous = deliveries.get(marker.deliveryId);
		if (previous) {
			if (previous.matrixEventId !== marker.matrixEventId || previous.kind !== marker.kind || rank[marker.status] < rank[previous.status] ||
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
		if (marker?.data.deliveryId === deliveryId && marker.data.status === "expanded") expandedEntryId = marker.id;
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

export function persistedEntryId(sessionId: string, piEntryKey: string): string {
	return deriveTranscriptEntryId(sessionId, piEntryKey);
}

export function normalizeConcept(input: string): string | undefined {
	const concept = input.trim().replace(/\s+/g, " ");
	return concept && concept.length <= 128 && !/[\u0000-\u001f\u007f]/.test(concept) ? concept : undefined;
}
