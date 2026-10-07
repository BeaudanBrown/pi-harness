import { HOST_CONTROL_VERSION, parseHostResponse, savedSessionKey, type HostConversationSummary, type HostResult } from "../live-workspace-contracts.js";
import type { RuntimeObservation } from "./runtime-observer.js";
import { HostControlError } from "./host-control-error.js";
import { HostInventoryPages } from "./host-inventory-pages.js";
import type { HostReadRequest } from "./host-dispatcher.js";
import type { RegistryConversationMetadata, RelayRegistry } from "./registry.js";
import type { HostLifecycle } from "./host-lifecycle.js";

const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const placementKey = (row: { rootKey: string; workspace: string }) => JSON.stringify([row.rootKey, row.workspace]);

/** Last-known metadata, not authorization or fresh filesystem/Matrix readiness proof. */
export class HostReadModel {
	private readonly pages: HostInventoryPages;
	private readonly cache = new Map<string, { expiresAt: number; rows: unknown[] }>();
	private readonly loading = new Map<string, Promise<unknown[]>>();
	private readonly now: () => number;
	constructor(private readonly options: {
		hostId: string; registry: Pick<RelayRegistry, "conversationMetadata" | "retirement">; matrixReady: () => boolean; accountState?: () => "ready" | "pending" | "unavailable"; accountSetup?: (id: string) => "ready" | "pending" | "notification_setup_uncertain";
		lifecycle?: Pick<HostLifecycle, "workspaceList" | "worktreeInventory">; windowFirstOpen?: boolean; savedSessionOpen?: boolean; savedSessionImport?: boolean; now?: () => number; runtimeObservations?: () => ReadonlyMap<string, RuntimeObservation>;
	}) { this.options = { ...options }; this.now = options.now ?? (() => performance.now()); this.pages = new HostInventoryPages(options.hostId, this.now); }

	async read(request: HostReadRequest): Promise<unknown> {
		const action = request.action;
		switch (action.operation) {
			case "host.status": return { hostId: this.options.hostId, relayState: this.options.matrixReady() ? "ready" : "disconnected",
				capabilities: ["host-control-v1", ...(this.options.windowFirstOpen ? ["window-first-open-v1" as const] : []), ...(this.options.savedSessionOpen ? ["saved-session-open-v1" as const] : []), ...(this.options.savedSessionImport ? ["saved-session-import-v1" as const] : [])], accountState: this.options.accountState?.() ?? "unavailable" } satisfies HostResult<"host.status">;
			case "conversation.list": return this.pages.page(action, this.conversations());
			case "conversation.status": {
				const retired = this.options.registry.retirement(action.conversationId);
				if (retired) throw new HostControlError("retired", `Conversation is permanently retired; cleanup ${!retired.cleanup ? "complete" : retired.cleanup.some((effect) => effect.phase === "blocked") ? "pending (blocked)" : "pending"}`);
				const item = this.conversations().find((row) => row.conversationId === action.conversationId);
				if (!item) throw new HostControlError("not_found", "Conversation was not found");
				return item;
			}
			case "workspace.list": {
				if (!this.options.lifecycle) throw new HostControlError("unavailable", "Workspace inventory is unavailable", true);
				const names = await this.cached("workspaces", () => this.options.lifecycle!.workspaceList());
				const metadata = this.options.registry.conversationMetadata().sort((a, b) => compare(a.conversationId, b.conversationId));
				const groups = new Map<string, RegistryConversationMetadata[]>();
				for (const item of metadata) if (item.placement) {
					const key = placementKey(item.placement); const group = groups.get(key) ?? []; group.push(item); groups.set(key, group);
				}
				const rows = names.map((name): HostResult<"workspace.list">["items"][number] => {
					const group = groups.get(placementKey(name)) ?? [];
					const identities = new Set(group.filter((row) => row.checkoutId && row.projectKey).map((row) => JSON.stringify([row.checkoutId, row.projectKey])));
					const candidate = identities.size === 1 ? group.find((row) => row.checkoutId && row.projectKey) : undefined;
					const known = candidate && group.every((row) => (!row.projectKey || row.projectKey === candidate.projectKey) && (!row.checkoutId || row.checkoutId === candidate.checkoutId)) ? candidate : undefined;
					return { rootKey: name.rootKey, workspace: name.workspace, availability: "available",
						...(known ? { checkoutId: known.checkoutId!, projectKey: known.projectKey!, ...this.displays(known) } : { reconciliationRequired: true }) };
				}).sort((a, b) => compare("checkoutId" in a ? a.checkoutId : placementKey(a), "checkoutId" in b ? b.checkoutId : placementKey(b)));
				if (new Set(rows.map(placementKey)).size !== rows.length) throw new HostControlError("failed", "Duplicate workspace inventory placement");
				return this.pages.page(action, rows);
			}
			case "worktree.list": {
				if (!this.options.lifecycle) throw new HostControlError("unavailable", "Worktree inventory is unavailable", true);
				const rows = await this.cached(`worktrees:${placementKey(action)}`, () => this.options.lifecycle!.worktreeInventory(action.rootKey, action.workspace));
				return this.pages.page(action, [...rows].sort((a, b) => compare(a.checkoutId, b.checkoutId)));
			}
			default: throw new HostControlError("upgrade_required", "This preview requires the corresponding durable lifecycle implementation");
		}
	}

	private displays(item: RegistryConversationMetadata): { projectDisplayName?: string; checkoutDisplayName?: string } {
		return { ...(item.projectDisplayName ? { projectDisplayName: item.projectDisplayName } : {}), ...(item.checkoutDisplayName ? { checkoutDisplayName: item.checkoutDisplayName } : {}) };
	}

	private conversations(): HostConversationSummary[] {
		const observations = this.options.runtimeObservations?.();
		return this.options.registry.conversationMetadata().map((item): HostConversationSummary => {
			const observation = observations?.get(item.conversationId);
			const common = { conversationId: item.conversationId, title: item.title, activeGenerationId: item.activeGenerationId,
				...(item.sessionId ? { sessionKey: savedSessionKey(this.options.hostId, item.sessionId) } : {}),
				runtimeState: observation?.runtimeState ?? "unknown" as const, launchState: observation?.launchState ?? (item.attached ? "attached" as const : "none" as const),
				setupState: !item.matrixBound ? "pending" as const : !this.options.matrixReady() ? "disconnected" as const : this.options.accountSetup?.(item.conversationId) ?? "pending" as const,
				capabilities: ["host-control-v1" as const] };
			const summary: HostConversationSummary = item.kind === "coordinator" ? { ...common, kind: "coordinator" } : {
				...common, kind: "project", ...(item.placement ? { placement: { ...item.placement } } : {}), ...this.displays(item),
				...(item.checkoutId && item.projectKey ? { checkoutId: item.checkoutId, projectKey: item.projectKey }
					: { reconciliationRequired: true, ...(item.projectKey ? { projectKey: item.projectKey } : {}) }),
			};
			parseHostResponse("conversation.status", { version: HOST_CONTROL_VERSION, requestId: "inventory", ok: true, data: summary });
			return summary;
		}).sort((a, b) => compare(a.conversationId, b.conversationId));
	}

	private async cached<T>(key: string, load: () => Promise<T[]>): Promise<T[]> {
		const now = this.now();
		for (const [name, value] of this.cache) if (value.expiresAt <= now) this.cache.delete(name);
		const cached = this.cache.get(key); if (cached) return cached.rows as T[];
		const pending = this.loading.get(key); if (pending) return pending as Promise<T[]>;
		if (this.loading.size >= 4) throw new HostControlError("busy", "Inventory discovery is busy; retry later", true);
		const work = (async () => {
			try {
				const rows = await load();
				if (rows.length > 4_096 || Buffer.byteLength(JSON.stringify(rows)) > 1024 * 1024) throw Error("Inventory capacity exceeded");
				if (this.cache.size >= 16) this.cache.delete(this.cache.keys().next().value!);
				const saved = structuredClone(rows); this.cache.set(key, { expiresAt: this.now() + 30_000, rows: saved }); return saved;
			} catch { throw new HostControlError("unavailable", "Host workspace discovery is unavailable", true); }
		})().finally(() => this.loading.delete(key));
		this.loading.set(key, work); return work;
	}
}
