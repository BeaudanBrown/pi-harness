import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	MatrixClient,
	matrixConfigFromEnvironment,
	routeMatrixTextEvent,
	type MatrixConfig,
} from "./matrix-client.js";
import {
	RemoteSessionStateStore,
	bindingIdForRoom,
	stateRootForSessionDirectory,
	type DurableRoomBinding,
} from "./state-store.js";

const BINDING_ENTRY_TYPE = "remote-session.binding";
const INBOUND_ENTRY_TYPE = "remote-session.inbound";

interface LegacyRoomBinding {
	version: 1;
	roomId: string;
	conceptName: string;
	since?: string;
}

type StoredRoomBinding = LegacyRoomBinding | DurableRoomBinding;

interface PendingRemoteTurn {
	prompt: string;
	eventId: string;
	transactionId: string;
}

function isStoredRoomBinding(value: unknown): value is StoredRoomBinding {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<StoredRoomBinding>;
	if (typeof candidate.roomId !== "string" || typeof candidate.conceptName !== "string") return false;
	if (candidate.version === 1) {
		const legacy = candidate as Partial<LegacyRoomBinding>;
		return legacy.since === undefined || typeof legacy.since === "string";
	}
	if (candidate.version === 2) {
		return typeof (candidate as Partial<DurableRoomBinding>).bindingId === "string";
	}
	return false;
}

export function restoreRoomBinding(entries: readonly unknown[]): StoredRoomBinding | undefined {
	let binding: StoredRoomBinding | undefined;
	for (const entry of entries) {
		if (typeof entry !== "object" || entry === null) continue;
		const candidate = entry as { type?: unknown; customType?: unknown; data?: unknown };
		if (candidate.type === "custom" && candidate.customType === BINDING_ENTRY_TYPE && isStoredRoomBinding(candidate.data)) {
			binding = candidate.data;
		}
	}
	return binding;
}

function durableBinding(binding: StoredRoomBinding): DurableRoomBinding {
	return binding.version === 2
		? binding
		: {
				version: 2,
				bindingId: bindingIdForRoom(binding.roomId),
				roomId: binding.roomId,
				conceptName: binding.conceptName,
			};
}

export function recoverInboundTurn(
	entries: readonly unknown[],
	eventId: string,
	prompt: string,
): { state: "missing" | "injected" | "answered"; answer?: string } {
	let markerIndex = -1;
	for (let index = 0; index < entries.length; index += 1) {
		const entry = entries[index];
		if (typeof entry !== "object" || entry === null) continue;
		const candidate = entry as { type?: unknown; customType?: unknown; data?: unknown };
		if (candidate.type !== "custom" || candidate.customType !== INBOUND_ENTRY_TYPE) continue;
		if (typeof candidate.data !== "object" || candidate.data === null) continue;
		const data = candidate.data as { eventId?: unknown; status?: unknown };
		if (data.eventId === eventId && data.status === "injecting") markerIndex = index;
	}
	if (markerIndex === -1) return { state: "missing" };

	let sawPrompt = false;
	let answer: string | undefined;
	for (const entry of entries.slice(markerIndex + 1)) {
		if (typeof entry !== "object" || entry === null) continue;
		const candidate = entry as { type?: unknown; message?: unknown };
		if (candidate.type !== "message" || typeof candidate.message !== "object" || candidate.message === null) continue;
		const message = candidate.message as { role?: unknown; content?: unknown };
		if (message.role === "user") {
			if (sawPrompt) break;
			if (typeof message.content !== "string" && !Array.isArray(message.content)) continue;
			sawPrompt = contentText(message.content) === prompt;
			continue;
		}
		if (sawPrompt && message.role === "assistant" && (typeof message.content === "string" || Array.isArray(message.content))) {
			const hasToolCall =
				Array.isArray(message.content) &&
				message.content.some(
					(block) => typeof block === "object" && block !== null && (block as { type?: unknown }).type === "toolCall",
				);
			if (!hasToolCall) answer = contentText(message.content) ?? answer;
		}
	}
	if (answer) return { state: "answered", answer };
	return { state: sawPrompt ? "injected" : "missing" };
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

function messageText(messages: readonly unknown[], role: "assistant"): string | undefined {
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
	let binding: DurableRoomBinding | undefined;
	let stateStore: RemoteSessionStateStore | undefined;
	let currentSessionId: string | undefined;
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

	function configureStore(ctx: ExtensionContext, config: MatrixConfig): RemoteSessionStateStore {
		currentSessionId = ctx.sessionManager.getSessionId();
		stateStore = new RemoteSessionStateStore(
			stateRootForSessionDirectory(ctx.sessionManager.getSessionDir()),
			config.botUserId,
		);
		return stateStore;
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

	async function deliverInbound(turn: PendingRemoteTurn): Promise<void> {
		if (!stateStore || !binding) throw new Error("Remote-session durable binding is unavailable");
		pi.appendEntry(INBOUND_ENTRY_TYPE, {
			version: 1,
			eventId: turn.eventId,
			status: "injecting",
			prompt: turn.prompt,
		});
		awaitingRemoteInputs.push(turn);
		pi.sendUserMessage(turn.prompt, { deliverAs: "followUp" });
		await stateStore.markInboundInjected(binding.bindingId, turn.eventId);
		pi.appendEntry(INBOUND_ENTRY_TYPE, { version: 1, eventId: turn.eventId, status: "injected" });
	}

	async function recoverUnfinishedInbounds(room: DurableRoomBinding, ctx: ExtensionContext): Promise<void> {
		if (!stateStore) return;
		for (const turn of await stateStore.unfinishedInbounds(room.bindingId)) {
			const recovery = recoverInboundTurn(ctx.sessionManager.getBranch(), turn.eventId, turn.prompt);
			if (recovery.state === "answered" && recovery.answer) {
				await stateStore.recordAnswer(room.bindingId, turn.eventId, recovery.answer);
				continue;
			}
			if (recovery.state === "injected") {
				await stateStore.markInboundInjected(room.bindingId, turn.eventId);
				inputRunQueue.push(turn);
				pi.sendMessage(
					{
						customType: "remote-session.resume",
						content: "Continue responding to the preceding remote user message.",
						display: false,
					},
					{ deliverAs: "followUp", triggerTurn: true },
				);
				continue;
			}
			await deliverInbound(turn);
		}
	}

	async function flushPendingOutbounds(client: MatrixClient, room: DurableRoomBinding, ctx: ExtensionContext): Promise<void> {
		if (!stateStore) return;
		for (const pending of await stateStore.pendingOutbounds(room.bindingId)) {
			try {
				await client.sendText(room.roomId, pending.body, pending.transactionId);
				await stateStore.markOutboundSent(room.bindingId, pending.eventId);
			} catch (error) {
				notify(ctx, error instanceof Error ? error.message : "Matrix retry failed", "error");
				return;
			}
		}
	}

	function startPolling(client: MatrixClient, config: MatrixConfig, room: DurableRoomBinding, ctx: ExtensionContext): void {
		if (!stateStore) throw new Error("Remote-session state store is unavailable");
		const store = stateStore;
		const controller = new AbortController();
		pollController = controller;
		activeClient = client;
		updateStatus(ctx);

		pollPromise = (async () => {
			let since = (await store.hostProgress(room.bindingId)).since;
			while (!controller.signal.aborted) {
				try {
					const result = await client.syncRoom(room.roomId, since, controller.signal);
					if (controller.signal.aborted || pollController !== controller) return;
					if (result.events.length === 0) {
						await store.advanceCursor(room.bindingId, result.nextBatch);
						since = result.nextBatch;
						continue;
					}

					const routed = result.events.flatMap((event) => {
						const prompt = routeMatrixTextEvent(event, room, config);
						return prompt ? [{ eventId: event.eventId, prompt }] : [];
					});
					const accepted = await store.acceptSync(room.bindingId, result.nextBatch, routed);
					since = result.nextBatch;
					if (controller.signal.aborted || pollController !== controller) return;
					for (const event of accepted) await deliverInbound(event);
				} catch (error) {
					if (controller.signal.aborted || isAbortError(error)) return;
					notify(ctx, error instanceof Error ? error.message : "Matrix synchronization failed", "error");
					await abortableDelay(2_000, controller.signal);
				}
			}
		})();
	}

	async function connect(config: MatrixConfig, ctx: ExtensionContext): Promise<void> {
		if (!binding || !stateStore) throw new Error("Matrix room is not durably bound");
		const controller = new AbortController();
		activationController = controller;
		try {
			const client = new MatrixClient(config);
			const authenticatedUserId = await client.authenticatedUserId(controller.signal);
			if (controller.signal.aborted || activationController !== controller) return;
			if (authenticatedUserId !== config.botUserId) {
				throw new Error(`Expected Matrix bot ${config.botUserId}, authenticated as ${authenticatedUserId}`);
			}
			await recoverUnfinishedInbounds(binding, ctx);
			await flushPendingOutbounds(client, binding, ctx);
			if (controller.signal.aborted || activationController !== controller) return;
			activationController = undefined;
			startPolling(client, config, binding, ctx);
			notify(ctx, `Matrix remote connected: ${binding.roomId}`);
		} catch (error) {
			controller.abort();
			if (activationController === controller) activationController = undefined;
			if (!isAbortError(error)) throw error;
		}
	}

	pi.on("session_start", async (event, ctx) => {
		await stopPolling();
		const storedBinding = restoreRoomBinding(ctx.sessionManager.getBranch());
		binding = storedBinding ? durableBinding(storedBinding) : undefined;
		currentSessionId = ctx.sessionManager.getSessionId();

		let config: MatrixConfig | undefined;
		try {
			config = matrixConfigFromEnvironment();
		} catch (error) {
			if (binding) notify(ctx, error instanceof Error ? error.message : "Matrix configuration is invalid", "error");
			updateStatus(ctx);
			return;
		}

		const store = configureStore(ctx, config);
		try {
			if (binding) {
				await store.bindSession(currentSessionId, binding);
				if (storedBinding?.version === 1) {
					await store.initializeCursor(binding.bindingId, storedBinding.since);
					pi.appendEntry(BINDING_ENTRY_TYPE, binding);
				}
			} else {
				binding = await store.bindingForSession(currentSessionId);
				if (!binding && event.reason === "fork" && event.previousSessionFile) {
					binding = await store.inheritSessionFromFile(currentSessionId, event.previousSessionFile);
				}
				if (binding) pi.appendEntry(BINDING_ENTRY_TYPE, binding);
			}
			if (binding) await connect(config, ctx);
		} catch (error) {
			notify(ctx, error instanceof Error ? error.message : "Matrix session restoration failed", "error");
		}
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
		if (!activeRemoteTurn || !activeClient || !binding || !stateStore) return;
		const remoteTurn = activeRemoteTurn;
		const response = messageText(event.messages, "assistant");
		if (!response) return;
		activeRemoteTurn = undefined;
		try {
			await stateStore.recordAnswer(binding.bindingId, remoteTurn.eventId, response);
			await activeClient.sendText(binding.roomId, response, remoteTurn.transactionId);
			await stateStore.markOutboundSent(binding.bindingId, remoteTurn.eventId);
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

			const suppliedConcept = rest.length > 0 ? normalizeConceptName(rest.join(" ")) : undefined;
			if (rest.length > 0 && !suppliedConcept) {
				notify(ctx, "Concept name must contain 1-80 printable characters", "warning");
				return;
			}
			if (binding && suppliedConcept && suppliedConcept !== binding.conceptName) {
				notify(ctx, `Matrix room is already bound to concept: ${binding.conceptName}`, "error");
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

			const store = configureStore(ctx, config);
			try {
				if (!binding) {
					if (!suppliedConcept) {
						notify(ctx, "First activation requires a concept name of 1-80 printable characters", "warning");
						return;
					}
					const controller = new AbortController();
					activationController = controller;
					const client = new MatrixClient(config);
					const authenticatedUserId = await client.authenticatedUserId(controller.signal);
					if (controller.signal.aborted || activationController !== controller) return;
					if (authenticatedUserId !== config.botUserId) {
						throw new Error(`Expected Matrix bot ${config.botUserId}, authenticated as ${authenticatedUserId}`);
					}
					const roomId = await client.createPrivateRoom(suppliedConcept, controller.signal);
					if (controller.signal.aborted || activationController !== controller) return;
					binding = {
						version: 2,
						bindingId: bindingIdForRoom(roomId),
						roomId,
						conceptName: suppliedConcept,
					};
					await store.bindSession(currentSessionId ?? ctx.sessionManager.getSessionId(), binding);
					pi.appendEntry(BINDING_ENTRY_TYPE, binding);
					activationController = undefined;
					startPolling(client, config, binding, ctx);
					notify(ctx, `Matrix remote connected: ${binding.roomId}`);
					return;
				}
				await store.bindSession(currentSessionId ?? ctx.sessionManager.getSessionId(), binding);
				await connect(config, ctx);
			} catch (error) {
				activationController?.abort();
				activationController = undefined;
				if (!isAbortError(error)) {
					notify(ctx, error instanceof Error ? error.message : "Matrix activation failed", "error");
				}
			}
		},
	});
}
