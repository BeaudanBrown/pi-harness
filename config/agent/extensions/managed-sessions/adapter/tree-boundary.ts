import type { SessionBinding } from "./state.js";

export const TREE_ENTRY_TYPE = "managed-session.tree";
export const TREE_NOTICE = "Pi switched branches in this session. Earlier Matrix history is unchanged.";
export interface TreeChange {
	version: "1.0.0"; conversationId: string; sessionId: string; bindingBoundaryEntryId: string;
	operationId: string; phase: "prepared" | "committed" | "cancelled"; oldLeafId: string | null; targetId: string;
}
export interface TreeRecord { id: string; data: TreeChange }
/** Session-local projection metadata, never permission to adopt another session. */
export function treeRecords(entries: readonly unknown[], binding: SessionBinding): TreeRecord[] {
	const result: TreeRecord[] = [];
	for (const value of entries) {
		const entry = value as { id?: unknown; type?: unknown; customType?: unknown; data?: Partial<TreeChange> } | null;
		if (entry?.type !== "custom" || entry.customType !== TREE_ENTRY_TYPE) continue;
		const data = entry.data;
		if (!data || data.sessionId !== binding.sessionId || data.conversationId !== binding.conversationId || data.bindingBoundaryEntryId !== binding.bindingBoundaryEntryId) continue;
		const key = (value: unknown): value is string => typeof value === "string" && /^[^\s\x00-\x1f]{1,128}$/u.test(value);
		if (data.version !== "1.0.0" || !key(entry.id) || !key(data.operationId) || !key(data.targetId) || !(data.oldLeafId === null || key(data.oldLeafId)) ||
			!["prepared", "committed", "cancelled"].includes(String(data.phase)) || Object.keys(data).sort().join(",") !== "bindingBoundaryEntryId,conversationId,oldLeafId,operationId,phase,sessionId,targetId,version") throw Error("Invalid managed tree boundary");
		result.push({ id: entry.id, data: data as TreeChange });
	}
	return result;
}
export function latestTreeChange(entries: readonly unknown[], binding: SessionBinding): TreeRecord | undefined {
	const records = treeRecords(entries, binding); const operations = new Map<string, TreeChange>();
	for (const { data } of records) {
		const previous = operations.get(data.operationId);
		if (previous && (previous.oldLeafId !== data.oldLeafId || previous.targetId !== data.targetId || previous.phase !== "prepared")) throw Error("Conflicting managed tree transition");
		if (!previous && data.phase !== "prepared") throw Error("Managed tree transition has no prepare record");
		operations.set(data.operationId, data);
	}
	return records.at(-1);
}
export function treeBoundaryIndex(entries: readonly unknown[], binding: SessionBinding): number {
	const boundary = treeRecords(entries, binding).filter(row => row.data.phase === "committed").at(-1);
	return boundary ? entries.findIndex(value => (value as { id?: unknown } | null)?.id === boundary.id) : -1;
}
