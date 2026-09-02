import { randomUUID } from "node:crypto";
import {
	MANAGED_SESSION_PROTOCOL_VERSION,
	MAX_INPUT_TEXT_LENGTH,
	deriveDeliveryId,
	type ConversationManifest,
	type ManagedSessionEnvelope,
} from "../contracts.js";
import { ManagedSessionIpcServer } from "./ipc-server.js";
import { ManagedMatrixClient } from "./matrix-client.js";
import { RelayRegistry } from "./registry.js";

interface MatrixTextEvent {
	eventId: string;
	body: string;
	replyToEventId?: string;
}

export type AuthorizedMatrixRoomEvent =
	| ({ kind: "text" } & MatrixTextEvent)
	| { kind: "poll_response"; eventId: string; pollEventId: string; answerId: string };

const MAX_TIMELINE_EVENTS = 512;
const MAX_INITIAL_EVENT_AGE_MS = 24 * 60 * 60 * 1_000;
const MAX_FUTURE_EVENT_SKEW_MS = 5 * 60 * 1_000;

function stripReplyFallback(body: string): string | undefined {
	if (!body.startsWith(">")) return body;
	const boundary = body.indexOf("\n\n");
	if (boundary === -1) return undefined;
	const quoted = body.slice(0, boundary).split("\n");
	if (!/^> <@[^>\n]+> /.test(quoted[0] ?? "") || quoted.some((line) => !line.startsWith("> "))) return undefined;
	return body.slice(boundary + 2);
}

function inputKind(body: string): { kind: "prompt" | "steer" | "abort"; body?: string } | undefined {
	const text = body.trim();
	if (!text) return undefined;
	if (text === "!abort") return { kind: "abort" };
	if (text === "!steer") return undefined;
	if (text.startsWith("!steer ")) {
		const steering = text.slice(7).trim();
		return steering ? { kind: "steer", body: steering } : undefined;
	}
	return { kind: "prompt", body: text };
}

export function authorizedRoomEvents(response: unknown, roomId: string, operatorUserId: string, hasCursor: boolean, now = Date.now()): AuthorizedMatrixRoomEvent[] {
	if (typeof response !== "object" || response === null) return [];
	const rooms = (response as { rooms?: unknown }).rooms;
	const joined = typeof rooms === "object" && rooms !== null ? (rooms as { join?: unknown }).join : undefined;
	const room = typeof joined === "object" && joined !== null ? (joined as Record<string, unknown>)[roomId] : undefined;
	if (typeof room !== "object" || room === null) return [];
	const roomValue = room as { timeline?: unknown; state?: unknown };
	const stateEvents = typeof roomValue.state === "object" && roomValue.state !== null && Array.isArray((roomValue.state as { events?: unknown }).events) ? (roomValue.state as { events: unknown[] }).events : [];
	const membership = [...stateEvents].reverse().find((value) => typeof value === "object" && value !== null && (value as { type?: unknown }).type === "m.room.member" && (value as { state_key?: unknown }).state_key === operatorUserId) as { content?: unknown } | undefined;
	if (membership && (typeof membership.content !== "object" || membership.content === null || (membership.content as { membership?: unknown }).membership !== "join")) return [];
	const timeline = roomValue.timeline;
	if (typeof timeline !== "object" || timeline === null || !Array.isArray((timeline as { events?: unknown }).events)) return [];
	const timelineValue = timeline as { events: unknown[]; limited?: unknown };
	if (timelineValue.limited === true || timelineValue.events.length > MAX_TIMELINE_EVENTS) throw new Error("Matrix room timeline requires bounded gap recovery before advancing the cursor");
	const result: AuthorizedMatrixRoomEvent[] = []; const seen = new Set<string>();
	for (const value of timelineValue.events) {
		if (typeof value !== "object" || value === null) continue;
		const event = value as { event_id?: unknown; sender?: unknown; type?: unknown; content?: unknown; origin_server_ts?: unknown };
		if (event.sender !== operatorUserId || typeof event.event_id !== "string" || !event.event_id || event.event_id.length > 255 || seen.has(event.event_id) ||
			typeof event.origin_server_ts !== "number" || !Number.isSafeInteger(event.origin_server_ts) || event.origin_server_ts > now + MAX_FUTURE_EVENT_SKEW_MS || (!hasCursor && event.origin_server_ts < now - MAX_INITIAL_EVENT_AGE_MS) ||
			typeof event.content !== "object" || event.content === null || Array.isArray(event.content)) continue;
		const content = event.content as Record<string, unknown>;
		if (event.type === "m.poll.response" || event.type === "org.matrix.msc3381.poll.response") {
			const responseKey = event.type;
			const otherResponseKey = event.type === "m.poll.response" ? "org.matrix.msc3381.poll.response" : "m.poll.response";
			if (content[otherResponseKey] !== undefined) continue;
			const responseContent = content[responseKey] as { answers?: unknown } | undefined;
			const relation = content["m.relates_to"] as { rel_type?: unknown; event_id?: unknown } | undefined;
			if (!responseContent || Object.keys(responseContent).length !== 1 || !Array.isArray(responseContent.answers) || responseContent.answers.length !== 1 ||
				typeof responseContent.answers[0] !== "string" || responseContent.answers[0].length < 1 || responseContent.answers[0].length > 255 ||
				!relation || Object.keys(relation).length !== 2 || relation.rel_type !== "m.reference" || typeof relation.event_id !== "string" ||
				relation.event_id.length < 1 || relation.event_id.length > 255) continue;
			seen.add(event.event_id); result.push({ kind: "poll_response", eventId: event.event_id, pollEventId: relation.event_id, answerId: responseContent.answers[0] });
		} else if (event.type === "m.room.message" && content.msgtype === "m.text" && typeof content.body === "string" && content.body.length > 0 && content.body.length <= MAX_INPUT_TEXT_LENGTH) {
			const relation = content["m.relates_to"];
			if (relation !== undefined) continue; // replies are parsed by the established strict text parser below
			seen.add(event.event_id); result.push({ kind: "text", eventId: event.event_id, body: content.body });
		}
	}
	return result;
}

export function operatorTextEvents(response: unknown, roomId: string, operatorUserId: string, hasCursor: boolean, now = Date.now()): MatrixTextEvent[] {
	if (typeof response !== "object" || response === null) return [];
	const rooms = (response as { rooms?: unknown }).rooms;
	if (typeof rooms !== "object" || rooms === null) return [];
	const joined = (rooms as { join?: unknown }).join;
	if (typeof joined !== "object" || joined === null) return [];
	const room = (joined as Record<string, unknown>)[roomId];
	if (typeof room !== "object" || room === null) return [];
	const roomValue = room as { timeline?: unknown; state?: unknown };
	const stateEvents = typeof roomValue.state === "object" && roomValue.state !== null && Array.isArray((roomValue.state as { events?: unknown }).events)
		? (roomValue.state as { events: unknown[] }).events : [];
	const operatorMembership = [...stateEvents].reverse().find((value) => typeof value === "object" && value !== null &&
		(value as { type?: unknown }).type === "m.room.member" && (value as { state_key?: unknown }).state_key === operatorUserId) as { content?: unknown } | undefined;
	if (operatorMembership && (typeof operatorMembership.content !== "object" || operatorMembership.content === null ||
		(operatorMembership.content as { membership?: unknown }).membership !== "join")) return [];
	const timeline = roomValue.timeline;
	if (typeof timeline !== "object" || timeline === null || !Array.isArray((timeline as { events?: unknown }).events)) return [];
	const timelineValue = timeline as { events: unknown[]; limited?: unknown; prev_batch?: unknown };
	const events = timelineValue.events;
	if (timelineValue.limited === true || events.length > MAX_TIMELINE_EVENTS) throw new Error("Matrix room timeline requires bounded gap recovery before advancing the cursor");
	const result: MatrixTextEvent[] = [];
	for (const value of events) {
		if (typeof value !== "object" || value === null) continue;
		const event = value as { event_id?: unknown; sender?: unknown; type?: unknown; content?: unknown; origin_server_ts?: unknown };
		if (event.sender !== operatorUserId || event.type !== "m.room.message" || typeof event.event_id !== "string" || event.event_id.length > 255 ||
			typeof event.origin_server_ts !== "number" || !Number.isSafeInteger(event.origin_server_ts) || event.origin_server_ts > now + MAX_FUTURE_EVENT_SKEW_MS ||
			(!hasCursor && event.origin_server_ts < now - MAX_INITIAL_EVENT_AGE_MS) ||
			typeof event.content !== "object" || event.content === null) continue;
		const content = event.content as { msgtype?: unknown; body?: unknown; "m.relates_to"?: unknown };
		if (content.msgtype !== "m.text" || typeof content.body !== "string" || content.body.length < 1 || content.body.length > MAX_INPUT_TEXT_LENGTH) continue;
		let replyToEventId: string | undefined;
		if (content["m.relates_to"] !== undefined) {
			const relation = content["m.relates_to"];
			if (typeof relation !== "object" || relation === null || Array.isArray(relation) || Object.keys(relation).length !== 1) continue;
			const reply = (relation as { "m.in_reply_to"?: unknown })["m.in_reply_to"];
			if (typeof reply !== "object" || reply === null || Array.isArray(reply) || Object.keys(reply).length !== 1 ||
				typeof (reply as { event_id?: unknown }).event_id !== "string") continue;
			replyToEventId = String((reply as { event_id: string }).event_id);
		}
		result.push({ eventId: event.event_id, body: content.body, ...(replyToEventId ? { replyToEventId } : {}) });
	}
	return result;
}

export class CoordinatorRouter {
	private controller?: AbortController;
	private loop?: Promise<void>;
	private readonly launching = new Map<string, Promise<void>>();

	constructor(
		private readonly manifest: ConversationManifest,
		private readonly registry: RelayRegistry,
		private readonly matrix: ManagedMatrixClient,
		private readonly server: ManagedSessionIpcServer,
		private readonly launch: (manifest: ConversationManifest) => Promise<void>,
		private readonly notifyLaunchFailure: (sourceId: string, manifest: ConversationManifest) => Promise<void> = async () => undefined,
		private readonly projectNotice: (sourceId: string, manifest: ConversationManifest, body: string) => Promise<void> = async () => undefined,
		private readonly diagnostic: (message: string) => void = () => undefined,
	) {
		if (manifest.kind !== "coordinator") throw new Error("Coordinator router requires the coordinator manifest");
	}

	start(): void {
		if (this.loop) return;
		this.controller = new AbortController();
		this.loop = this.run(this.controller.signal).finally(() => { this.loop = undefined; });
	}

	async stop(): Promise<void> {
		this.controller?.abort();
		await this.loop?.catch(() => undefined);
	}

	async reconcileWake(): Promise<void> {
		for (const manifest of this.registry.listManifests()) await this.ensureWake(manifest);
	}

	async attachmentReady(conversationId = this.manifest.conversationId): Promise<void> {
		for (const input of this.registry.pendingInputs(conversationId)) {
			if (input.status !== "accepted" && input.status !== "delivered") continue;
			if (this.server.sendToConversation(this.deliveryEnvelope(conversationId, input))) await this.registry.markInputDelivered(conversationId, input.deliveryId);
		}
	}

	private async run(signal: AbortSignal): Promise<void> {
		let failures = 0;
		while (!signal.aborted) {
			try {
				const runtime = this.registry.snapshot().conversations.find((item) => item.conversationId === this.manifest.conversationId);
				if (!runtime) throw new Error("Coordinator Matrix cursor state is unavailable");
				const cursor = runtime.matrixCursor;
				const established = cursor.status === "established";
				const sync = await this.matrix.sync(cursor.status === "established" ? cursor.since : undefined, signal);
				for (const manifest of this.registry.listManifests()) {
					const events = operatorTextEvents(sync.response, manifest.roomId, this.matrix.operatorUserId, established);
					if (established) {
						if (events.length > 0 && await this.matrix.memberJoined(manifest.roomId, this.matrix.operatorUserId, signal)) {
							for (const event of events) await this.accept(manifest, event);
						}
					}
					await this.ensureWake(manifest);
				}
				await this.registry.setMatrixCursor(this.manifest.conversationId, sync.nextBatch);
				failures = 0;
			} catch (error) {
				if (signal.aborted) return;
				failures += 1;
				this.diagnostic(error instanceof Error ? error.message : "Matrix synchronization failed");
				await new Promise<void>((resolve) => {
					const ceiling = Math.min(30_000, 500 * (2 ** Math.min(failures - 1, 6)));
					const timer = setTimeout(resolve, Math.floor(ceiling * (0.5 + Math.random() * 0.5)));
					signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
				});
			}
		}
	}

	private async accept(manifest: ConversationManifest, event: MatrixTextEvent): Promise<void> {
		let body = event.body;
		if (event.replyToEventId) {
			const sender = await this.matrix.eventSender(manifest.roomId, event.replyToEventId).catch(() => undefined);
			if (sender !== this.matrix.botUserId) return;
			const stripped = stripReplyFallback(body);
			if (stripped === undefined) return;
			body = stripped;
		}
		const input = inputKind(body);
		if (!input) return;
		const state = this.registry.conversationState(manifest.conversationId);
		if (state === "dormant" && (input.kind === "steer" || input.kind === "abort")) {
			await this.projectNotice(event.eventId, manifest, input.kind === "steer"
				? "No active run to steer; managed conversation remains dormant."
				: "No active run to abort; managed conversation remains dormant.");
			return;
		}
		const deliveryId = deriveDeliveryId(manifest.conversationId, event.eventId);
		await this.registry.recordAcceptedInput(manifest.conversationId, {
			deliveryId, matrixEventId: event.eventId, kind: input.kind, ...(input.body ? { body: input.body } : {}), status: "accepted",
		});
		const recordedState = this.registry.conversationState(manifest.conversationId);
		if (recordedState === "starting" && input.kind === "abort") {
			if (this.launching.has(manifest.conversationId)) {
				await this.registry.cancelPendingInputsExcept(manifest.conversationId, deliveryId);
				return;
			}
			await this.registry.cancelPendingInputs(manifest.conversationId);
			await this.registry.failLaunch(manifest.conversationId);
			await this.projectNotice(event.eventId, manifest, "No active run to abort; managed conversation remains dormant.");
			return;
		}
		if (recordedState === "active" && input.kind === "abort") await this.registry.cancelPendingInputs(manifest.conversationId);
		if (this.server.sendToConversation(this.deliveryEnvelope(manifest.conversationId, {
			deliveryId, matrixEventId: event.eventId, kind: input.kind, ...(input.body ? { body: input.body } : {}),
		}))) await this.registry.markInputDelivered(manifest.conversationId, deliveryId);
		else if (recordedState === "dormant") await this.registry.beginLaunch(manifest.conversationId);
	}

	private async ensureWake(manifest: ConversationManifest): Promise<void> {
		if (this.registry.conversationState(manifest.conversationId) === "active") return;
		const pending = this.registry.pendingInputs(manifest.conversationId)
			.find((input) => input.status === "accepted" || input.status === "delivered" || input.status === "persisted");
		if (!pending) return;
		if (!this.launching.has(manifest.conversationId)) {
			const launch = (async () => {
				await this.registry.beginLaunch(manifest.conversationId);
				try {
					await this.launch(manifest);
					for (let attempt = 0; attempt < 100 && this.registry.conversationState(manifest.conversationId) !== "active"; attempt += 1) {
						await new Promise((resolve) => setTimeout(resolve, 100));
					}
					if (this.registry.conversationState(manifest.conversationId) !== "active") throw new Error("Managed conversation attachment timed out");
				} catch (error) {
					const message = error instanceof Error ? error.message : "Managed conversation launch failed";
					this.diagnostic(message);
					await this.registry.recordLaunchError(manifest.conversationId, "launch_failed", message);
					await this.registry.failLaunch(manifest.conversationId);
					const queuedAbort = this.registry.pendingInputs(manifest.conversationId)
						.find((input) => input.kind === "abort" && (input.status === "accepted" || input.status === "delivered"));
					if (queuedAbort) {
						await this.registry.cancelPendingInputs(manifest.conversationId);
						await this.projectNotice(queuedAbort.matrixEventId, manifest, "No active run to abort; managed conversation remains dormant.").catch(() => undefined);
					} else await this.notifyLaunchFailure(pending.deliveryId, manifest).catch(() => undefined);
				}
			})().finally(() => { this.launching.delete(manifest.conversationId); });
			this.launching.set(manifest.conversationId, launch);
		}
		// Wake runs independently so later Matrix controls can cancel or steer queued input while attachment is pending.
	}

	private deliveryEnvelope(conversationId: string, input: { deliveryId: string; matrixEventId: string; kind: string; body?: string }): ManagedSessionEnvelope {
		return {
			protocolVersion: MANAGED_SESSION_PROTOCOL_VERSION,
			messageId: `relay-input-${randomUUID()}`,
			conversationId,
			role: "relay",
			type: "input.deliver",
			payload: { deliveryId: input.deliveryId, matrixEventId: input.matrixEventId, kind: input.kind, ...(input.body ? { body: input.body } : {}) },
		};
	}
}
