import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	MatrixClient,
	matrixConfigFromEnvironment,
	routeMatrixTextEvent,
	type MatrixConfig,
} from "./matrix-client.js";

const BINDING_ENTRY_TYPE = "remote-session.binding";

interface RoomBinding {
	version: 1;
	roomId: string;
	conceptName: string;
	since?: string;
}

interface PendingRemoteTurn {
	prompt: string;
}

function isRoomBinding(value: unknown): value is RoomBinding {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<RoomBinding>;
	return (
		candidate.version === 1 &&
		typeof candidate.roomId === "string" &&
		typeof candidate.conceptName === "string" &&
		(candidate.since === undefined || typeof candidate.since === "string")
	);
}

export function restoreRoomBinding(entries: readonly unknown[]): RoomBinding | undefined {
	let binding: RoomBinding | undefined;
	for (const entry of entries) {
		if (typeof entry !== "object" || entry === null) continue;
		const candidate = entry as { type?: unknown; customType?: unknown; data?: unknown };
		if (candidate.type === "custom" && candidate.customType === BINDING_ENTRY_TYPE && isRoomBinding(candidate.data)) {
			binding = candidate.data;
		}
	}
	return binding;
}

function normalizeConceptName(input: string): string | undefined {
	const normalized = input.trim().replace(/\s+/g, " ");
	if (!normalized || normalized.length > 80 || /[\u0000-\u001f\u007f]/.test(normalized)) return undefined;
	return normalized;
}

function contentText(content: string | readonly unknown[]): string | undefined {
	if (typeof content === "string") return content.trim() || undefined;
	const parts: string[] = [];
	for (const block of content) {
		if (typeof block !== "object" || block === null) continue;
		const candidate = block as { type?: unknown; text?: unknown };
		if (candidate.type === "text" && typeof candidate.text === "string" && candidate.text.trim()) {
			parts.push(candidate.text.trim());
		}
	}
	return parts.length > 0 ? parts.join("\n\n") : undefined;
}

function messageText(messages: readonly unknown[], role: "user" | "assistant"): string | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (typeof message !== "object" || message === null) continue;
		const candidate = message as { role?: unknown; content?: unknown };
		if (candidate.role !== role || (typeof candidate.content !== "string" && !Array.isArray(candidate.content))) continue;
		const text = contentText(candidate.content);
		if (text) return text;
	}
	return undefined;
}

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) ctx.ui.notify(message, level);
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted) return resolve();
		const timer = setTimeout(resolve, milliseconds);
		signal.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				resolve();
			},
			{ once: true },
		);
	});
}

export default function remoteSessionExtension(pi: ExtensionAPI): void {
	let binding: RoomBinding | undefined;
	let activeClient: MatrixClient | undefined;
	let pollController: AbortController | undefined;
	let pollPromise: Promise<void> | undefined;
	let activationController: AbortController | undefined;
	let activeRemoteTurn: PendingRemoteTurn | undefined;
	const awaitingRemoteInputs: PendingRemoteTurn[] = [];
	const inputRunQueue: Array<PendingRemoteTurn | undefined> = [];

	function updateStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus("remote-session", pollController && binding ? `remote: ${binding.conceptName}` : undefined);
	}

	async function stopPolling(ctx?: ExtensionContext): Promise<void> {
		activationController?.abort();
		activationController = undefined;
		pollController?.abort();
		try {
			await pollPromise;
		} catch {
			// The polling loop reports non-abort failures itself.
		}
		pollController = undefined;
		pollPromise = undefined;
		activeClient = undefined;
		activeRemoteTurn = undefined;
		awaitingRemoteInputs.length = 0;
		inputRunQueue.length = 0;
		if (ctx) updateStatus(ctx);
	}

	function startPolling(client: MatrixClient, config: MatrixConfig, room: RoomBinding, ctx: ExtensionContext): void {
		const controller = new AbortController();
		pollController = controller;
		activeClient = client;
		updateStatus(ctx);

		pollPromise = (async () => {
			let since = room.since;
			const seenEventIds = new Set<string>();
			while (!controller.signal.aborted) {
				try {
					const result = await client.syncRoom(room.roomId, since, controller.signal);
					if (controller.signal.aborted || pollController !== controller) return;
					since = result.nextBatch;
					if (result.events.length > 0) {
						binding = { ...room, since };
						pi.appendEntry(BINDING_ENTRY_TYPE, binding);
					}
					for (const event of result.events) {
						if (seenEventIds.has(event.eventId)) continue;
						seenEventIds.add(event.eventId);
						const text = routeMatrixTextEvent(event, room, config);
						if (!text) continue;

						const pendingTurn = { prompt: text };
						awaitingRemoteInputs.push(pendingTurn);
						pi.sendUserMessage(text, { deliverAs: "followUp" });
					}
				} catch (error) {
					if (controller.signal.aborted || isAbortError(error)) return;
					notify(ctx, error instanceof Error ? error.message : "Matrix synchronization failed", "error");
					await abortableDelay(2_000, controller.signal);
				}
			}
		})();
	}

	pi.on("session_start", async (_event, ctx) => {
		binding = restoreRoomBinding(ctx.sessionManager.getBranch());
		await stopPolling();
		updateStatus(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		await stopPolling(ctx);
	});

	pi.on("input", (event) => {
		let remoteTurn: PendingRemoteTurn | undefined;
		if (event.source === "extension") {
			const pendingIndex = awaitingRemoteInputs.findIndex((turn) => turn.prompt === event.text);
			if (pendingIndex !== -1) [remoteTurn] = awaitingRemoteInputs.splice(pendingIndex, 1);
		}
		inputRunQueue.push(remoteTurn);
	});

	pi.on("before_agent_start", () => {
		activeRemoteTurn = inputRunQueue.shift();
	});

	pi.on("agent_end", async (event, ctx) => {
		if (!activeRemoteTurn || !activeClient || !binding) return;
		const response = messageText(event.messages, "assistant");
		if (!response) return;
		activeRemoteTurn = undefined;
		try {
			await activeClient.sendText(binding.roomId, response, randomUUID());
		} catch (error) {
			notify(ctx, error instanceof Error ? error.message : "Matrix send failed", "error");
		}
	});

	pi.registerCommand("remote", {
		description: "Connect this Pi session to its private Matrix room",
		handler: async (args, ctx) => {
			const [action, ...rest] = args.trim().split(/\s+/);
			if (!action || action === "status") {
				const state = pollController ? "connected" : "off";
				const room = binding ? `${binding.conceptName} (${binding.roomId})` : "not bound";
				notify(ctx, `Matrix remote: ${state}; room: ${room}`);
				return;
			}

			if (action === "off") {
				await stopPolling(ctx);
				notify(ctx, binding ? `Matrix remote off; room preserved: ${binding.roomId}` : "Matrix remote is off");
				return;
			}

			if (action !== "on") {
				notify(ctx, "Usage: /remote on <concept-name> | /remote off | /remote status", "warning");
				return;
			}

			if (pollController || activationController) {
				notify(ctx, `Matrix remote already connected or connecting: ${binding?.roomId ?? "room pending"}`);
				return;
			}

			let config: MatrixConfig;
			try {
				config = matrixConfigFromEnvironment();
			} catch (error) {
				notify(ctx, error instanceof Error ? error.message : "Matrix configuration is invalid", "error");
				return;
			}

			const controller = new AbortController();
			activationController = controller;
			try {
				const client = new MatrixClient(config);
				const authenticatedUserId = await client.authenticatedUserId(controller.signal);
				if (controller.signal.aborted || activationController !== controller) return;
				if (authenticatedUserId !== config.botUserId) {
					throw new Error(`Expected Matrix bot ${config.botUserId}, authenticated as ${authenticatedUserId}`);
				}

				if (!binding) {
					const conceptName = normalizeConceptName(rest.join(" "));
					if (!conceptName) {
						notify(ctx, "First activation requires a concept name of 1-80 printable characters", "warning");
						return;
					}
					const roomId = await client.createPrivateRoom(conceptName, controller.signal);
					if (controller.signal.aborted || activationController !== controller) return;
					binding = { version: 1, roomId, conceptName };
					pi.appendEntry(BINDING_ENTRY_TYPE, binding);
				}

				if (controller.signal.aborted || activationController !== controller) return;
				activationController = undefined;
				startPolling(client, config, binding, ctx);
				notify(ctx, `Matrix remote connected: ${binding.roomId}`);
			} catch (error) {
				controller.abort();
				if (activationController === controller) activationController = undefined;
				if (!isAbortError(error)) {
					notify(ctx, error instanceof Error ? error.message : "Matrix activation failed", "error");
				}
			}
		},
	});
}
