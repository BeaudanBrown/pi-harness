import { join, resolve } from "node:path";
import type { ManagedSessionEnvelope } from "../contracts.js";
import { deriveActivityTransactionId } from "../v2-contracts.js";
import { AtomicJsonFile } from "./atomic-json.js";
import { ManagedMatrixClient } from "./matrix-client.js";
import { RelayRegistry, RelayRegistryError } from "./registry.js";

const ACTIVITY_STATE_VERSION = "2.0.0" as const;
const MAX_ACTIVITIES = 4_096;
const TYPING_REFRESH_MS = 20_000;
const INTERRUPTION_GRACE_MS = 10_000;

type ToolState = { name: string; state: "running" | "completed" | "error"; count: number };
type ActivityUpdate = { activityId: string; revision: number; state: "busy" | "tool" | "compaction"; tools?: ToolState[] };
type ActivityFinal = ActivityUpdate & Record<string, unknown> & { outcome: "completed" | "checkpoint" | "cancelled" | "interrupted" | "failed" };
interface DurableActivity { conversationId: string; activityId: string; revision: number; eventId?: string; finalized: boolean; payload: Record<string, unknown>; }
interface ActivityState { schemaVersion: typeof ACTIVITY_STATE_VERSION; activities: DurableActivity[]; }

function parseState(value: unknown): ActivityState {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Malformed activity state");
	const record = value as Record<string, unknown>;
	if (Object.keys(record).some((key) => !["schemaVersion", "activities"].includes(key)) || record.schemaVersion !== ACTIVITY_STATE_VERSION || !Array.isArray(record.activities) || record.activities.length > MAX_ACTIVITIES) throw new Error("Malformed activity state");
	const identities = new Set<string>();
	for (const item of record.activities) {
		if (typeof item !== "object" || item === null || Array.isArray(item)) throw new Error("Malformed activity record");
		const activity = item as Record<string, unknown>;
		if (Object.keys(activity).some((key) => !["conversationId", "activityId", "revision", "eventId", "finalized", "payload"].includes(key)) ||
			typeof activity.conversationId !== "string" || !/^activity_[a-f0-9]{32}$/.test(String(activity.activityId)) || !Number.isSafeInteger(activity.revision) || Number(activity.revision) < 0 ||
			(activity.eventId !== undefined && typeof activity.eventId !== "string") || typeof activity.finalized !== "boolean" || typeof activity.payload !== "object" || activity.payload === null || Array.isArray(activity.payload)) throw new Error("Malformed activity record");
		const identity = `${activity.conversationId}:${activity.activityId}`;
		if (identities.has(identity)) throw new Error("Duplicate activity identity");
		identities.add(identity);
	}
	return value as ActivityState;
}

const title = (outcome: ActivityFinal["outcome"]): string => ({ completed: "Completed", checkpoint: "Waiting at checkpoint", cancelled: "Cancelled", interrupted: "Interrupted", failed: "Failed" })[outcome];
function renderUpdate(payload: ActivityUpdate): string {
	const lines = [payload.state === "compaction" ? "⏳ Compacting context" : "⏳ Working"];
	for (const tool of payload.tools ?? []) lines.push(`${tool.state === "running" ? "●" : tool.state === "error" ? "✕" : "✓"} ${tool.name}${tool.count > 1 ? ` ×${tool.count}` : ""}`);
	return lines.join("\n").slice(0, 8_000);
}
function renderFinal(payload: ActivityFinal): string {
	const lines = [`${payload.outcome === "completed" ? "✓" : payload.outcome === "failed" ? "✕" : "■"} ${title(payload.outcome)}`];
	const duration = payload.durationMs as number | undefined;
	if (duration !== undefined) lines.push(`Duration: ${(duration / 1_000).toFixed(1)}s`);
	const identity = [payload.model, payload.thinking ? `thinking ${payload.thinking}` : undefined, payload.generation ? `generation ${payload.generation}` : undefined].filter(Boolean);
	if (identity.length) lines.push(identity.join(" · "));
	const context = payload.context as { usedTokens: number; remainingTokens: number; limitTokens: number; deltaTokens: number } | undefined;
	if (context) lines.push(`Context: ${context.usedTokens}/${context.limitTokens} used · ${context.remainingTokens} remaining · Δ ${context.deltaTokens >= 0 ? "+" : ""}${context.deltaTokens}`);
	const run = payload.run as { inputTokens: number; outputTokens: number; modelTurns: number } | undefined;
	if (run) lines.push(`Run: ${run.inputTokens} in · ${run.outputTokens} out · ${run.modelTurns} model turn${run.modelTurns === 1 ? "" : "s"}`);
	const tools = payload.tools as { total: number; errors: number; counts: Array<{ name: string; count: number }> } | undefined;
	if (tools) lines.push(`Tools: ${tools.total} total · ${tools.errors} error${tools.errors === 1 ? "" : "s"}${tools.counts.length ? ` · ${tools.counts.map((item) => `${item.name} ${item.count}`).join(", ")}` : ""}`);
	if (payload.compactions !== undefined) lines.push(`Compactions: ${payload.compactions}`);
	return lines.join("\n").slice(0, 16_000);
}

export class ActivityProjector {
	private readonly file: AtomicJsonFile<ActivityState>;
	private state: ActivityState = { schemaVersion: ACTIVITY_STATE_VERSION, activities: [] };
	private operation: Promise<void> = Promise.resolve();
	private readonly typing = new Map<string, NodeJS.Timeout>();
	private readonly interruptions = new Map<string, NodeJS.Timeout>();
	constructor(runtimeRoot: string, private readonly registry: RelayRegistry, private readonly matrix: ManagedMatrixClient) { this.file = new AtomicJsonFile(join(resolve(runtimeRoot), "activities.json"), parseState); }
	async load(): Promise<void> { this.state = await this.file.read() ?? this.state; for (const item of this.state.activities) if (!item.finalized) this.attachmentDisconnected(item.conversationId); }
	async project(envelope: ManagedSessionEnvelope): Promise<"updated" | "finalized"> {
		return this.serialize(async () => {
			if (!envelope.conversationId || envelope.role !== "ordinary_adapter" || !["activity.update", "activity.finalize"].includes(envelope.type)) throw new RelayRegistryError("permission_denied", "Activity requires an attached ordinary adapter");
			const interruption = this.interruptions.get(envelope.conversationId); if (interruption) clearTimeout(interruption); this.interruptions.delete(envelope.conversationId);
			const manifest = this.registry.manifestByConversationId(envelope.conversationId);
			if (!manifest) throw new RelayRegistryError("not_found", "Managed conversation was not found");
			const payload = envelope.payload as ActivityUpdate | ActivityFinal;
			let item = this.state.activities.find((candidate) => candidate.conversationId === envelope.conversationId && candidate.activityId === payload.activityId);
			if (item?.finalized) {
				if (envelope.type === "activity.finalize" && item.revision === payload.revision && JSON.stringify(item.payload) === JSON.stringify(payload)) return "finalized";
				throw new RelayRegistryError("invalid_state", "Finalized activity cards are immutable");
			}
			if (item && payload.revision < item.revision) throw new RelayRegistryError("invalid_state", "Activity revision moved backwards");
			if (item && payload.revision === item.revision && JSON.stringify(item.payload) !== JSON.stringify(payload)) throw new RelayRegistryError("invalid_state", "Activity revision conflicts with durable content");
			if (!item) {
				if (this.state.activities.length >= MAX_ACTIVITIES) throw new RelayRegistryError("capacity_reached", "Activity history capacity was reached");
				item = { conversationId: envelope.conversationId, activityId: payload.activityId, revision: payload.revision, finalized: false, payload };
				this.state.activities.push(item); await this.file.write(this.state);
			}
			const body = envelope.type === "activity.finalize" ? renderFinal(payload as ActivityFinal) : renderUpdate(payload as ActivityUpdate);
			if (!item.eventId) {
				item.eventId = await this.matrix.sendNotice(manifest.roomId, deriveActivityTransactionId(envelope.conversationId, payload.activityId, 0), body);
			} else if (payload.revision > item.revision || envelope.type === "activity.finalize") {
				await this.matrix.replaceMessage(manifest.roomId, deriveActivityTransactionId(envelope.conversationId, payload.activityId, payload.revision), item.eventId, body);
			}
			item.revision = payload.revision; item.payload = payload; item.finalized = envelope.type === "activity.finalize";
			await this.file.write(this.state);
			if (item.finalized) await this.stopTyping(envelope.conversationId, manifest.roomId); else await this.startTyping(envelope.conversationId, manifest.roomId);
			return item.finalized ? "finalized" : "updated";
		});
	}
	hasUnfinalized(conversationId: string): boolean { return this.state.activities.some((item) => item.conversationId === conversationId && !item.finalized); }
	attachmentDisconnected(conversationId: string): void {
		if (this.interruptions.has(conversationId)) return;
		const timer = setTimeout(() => { this.interruptions.delete(conversationId); void this.interrupt(conversationId).catch(() => undefined); }, INTERRUPTION_GRACE_MS);
		timer.unref(); this.interruptions.set(conversationId, timer);
	}
	async interrupt(conversationId: string): Promise<void> {
		const item = [...this.state.activities].reverse().find((candidate) => candidate.conversationId === conversationId && !candidate.finalized);
		if (!item) return;
		await this.project({ protocolVersion: "1.0.0", messageId: "relay-interrupt", conversationId, role: "ordinary_adapter", type: "activity.finalize", payload: { ...item.payload, revision: item.revision + 1, outcome: "interrupted" } });
	}
	async close(): Promise<void> { for (const timer of this.typing.values()) clearInterval(timer); for (const timer of this.interruptions.values()) clearTimeout(timer); this.typing.clear(); this.interruptions.clear(); }
	private async startTyping(conversationId: string, roomId: string): Promise<void> {
		await this.matrix.setTyping(roomId, true);
		if (this.typing.has(conversationId)) return;
		const timer = setInterval(() => void this.matrix.setTyping(roomId, true).catch(() => undefined), TYPING_REFRESH_MS); timer.unref(); this.typing.set(conversationId, timer);
	}
	private async stopTyping(conversationId: string, roomId: string): Promise<void> { const timer = this.typing.get(conversationId); if (timer) clearInterval(timer); this.typing.delete(conversationId); await this.matrix.setTyping(roomId, false); }
	private serialize<T>(work: () => Promise<T>): Promise<T> { const result = this.operation.then(work, work); this.operation = result.then(() => undefined, () => undefined); return result; }
}
