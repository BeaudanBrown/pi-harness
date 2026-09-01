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
}

function operatorTextEvents(response: unknown, roomId: string, operatorUserId: string): MatrixTextEvent[] {
	if (typeof response !== "object" || response === null) return [];
	const rooms = (response as { rooms?: unknown }).rooms;
	if (typeof rooms !== "object" || rooms === null) return [];
	const joined = (rooms as { join?: unknown }).join;
	if (typeof joined !== "object" || joined === null) return [];
	const room = (joined as Record<string, unknown>)[roomId];
	if (typeof room !== "object" || room === null) return [];
	const timeline = (room as { timeline?: unknown }).timeline;
	if (typeof timeline !== "object" || timeline === null || !Array.isArray((timeline as { events?: unknown }).events)) return [];
	const result: MatrixTextEvent[] = [];
	for (const value of (timeline as { events: unknown[] }).events) {
		if (typeof value !== "object" || value === null) continue;
		const event = value as { event_id?: unknown; sender?: unknown; type?: unknown; content?: unknown };
		if (event.sender !== operatorUserId || event.type !== "m.room.message" || typeof event.event_id !== "string" ||
			typeof event.content !== "object" || event.content === null) continue;
		const content = event.content as { msgtype?: unknown; body?: unknown; "m.relates_to"?: unknown };
		if (content.msgtype !== "m.text" || typeof content.body !== "string" || content.body.length < 1 ||
			content.body.length > MAX_INPUT_TEXT_LENGTH || content["m.relates_to"] !== undefined) continue;
		result.push({ eventId: event.event_id, body: content.body });
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
				const sync = await this.matrix.sync(runtime?.matrixSince, signal);
				for (const manifest of this.registry.listManifests()) {
					for (const event of operatorTextEvents(sync.response, manifest.roomId, this.matrix.operatorUserId)) await this.accept(manifest, event);
					await this.ensureWake(manifest);
				}
				await this.registry.setMatrixCursor(this.manifest.conversationId, sync.nextBatch);
				failures = 0;
			} catch (error) {
				if (signal.aborted) return;
				failures += 1;
				await new Promise<void>((resolve) => {
					const timer = setTimeout(resolve, Math.min(30_000, 500 * (2 ** Math.min(failures, 6))));
					signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
				});
			}
		}
	}

	private async accept(manifest: ConversationManifest, event: MatrixTextEvent): Promise<void> {
		const deliveryId = deriveDeliveryId(manifest.conversationId, event.eventId);
		await this.registry.recordAcceptedInput(manifest.conversationId, {
			deliveryId, matrixEventId: event.eventId, kind: "prompt", body: event.body, status: "accepted",
		});
		if (this.server.sendToConversation(this.deliveryEnvelope(manifest.conversationId, { deliveryId, matrixEventId: event.eventId, kind: "prompt", body: event.body }))) {
			await this.registry.markInputDelivered(manifest.conversationId, deliveryId);
			return;
		}
	}

	private async ensureWake(manifest: ConversationManifest): Promise<void> {
		if (this.registry.conversationState(manifest.conversationId) === "active") return;
		const pending = this.registry.pendingInputs(manifest.conversationId)
			.find((input) => input.status === "accepted" || input.status === "delivered");
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
					await this.registry.failLaunch(manifest.conversationId);
					await this.notifyLaunchFailure(pending.deliveryId, manifest).catch(() => undefined);
					throw error;
				}
			})().finally(() => { this.launching.delete(manifest.conversationId); });
			this.launching.set(manifest.conversationId, launch);
		}
		await this.launching.get(manifest.conversationId)!.catch(() => undefined);
	}

	private deliveryEnvelope(conversationId: string, input: { deliveryId: string; matrixEventId: string; kind: string; body?: string }): ManagedSessionEnvelope {
		return {
			protocolVersion: MANAGED_SESSION_PROTOCOL_VERSION,
			messageId: `relay-input-${randomUUID()}`,
			conversationId,
			role: "relay",
			type: "input.deliver",
			payload: { deliveryId: input.deliveryId, matrixEventId: input.matrixEventId, kind: "prompt", body: input.body },
		};
	}
}
