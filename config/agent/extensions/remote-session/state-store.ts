import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export interface DurableRoomBinding {
	version: 2;
	bindingId: string;
	roomId: string;
	conceptName: string;
}

export type InboundKind = "prompt" | "steer" | "abort";

export interface AcceptedInbound {
	eventId: string;
	prompt: string;
	kind?: InboundKind;
	transactionId: string;
}

export interface PendingOutbound {
	eventId: string;
	transactionId: string;
	body: string;
}

export interface HostProgress {
	since?: string;
	processedEventIds: string[];
}

interface SessionLink {
	version: 1;
	sessionId: string;
	bindingId: string;
}

interface EventProgress {
	prompt?: string;
	kind?: InboundKind;
	transactionId: string;
	status: "accepted" | "injected" | "pending" | "sent";
	body?: string;
	outboundKind?: "command_ack";
}

interface HostState {
	version: 1;
	since?: string;
	eventOrder: string[];
	events: Record<string, EventProgress>;
}

const MAX_RETAINED_EVENTS = 2048;
const SAFE_ID = /^[A-Za-z0-9._-]+$/;

function hash(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

export function bindingIdForRoom(roomId: string): string {
	return `room-${hash(roomId).slice(0, 32)}`;
}

function transactionId(bindingId: string, eventId: string): string {
	return `pi-${hash(`${bindingId}\0${eventId}`).slice(0, 48)}`;
}

export function stateRootForSessionDirectory(sessionDirectory: string): string {
	return join(dirname(resolve(sessionDirectory)), ".remote-session");
}

function assertSafeId(value: string, kind: string): void {
	if (!SAFE_ID.test(value)) throw new Error(`Invalid ${kind}`);
}

function isMissing(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function readJson(path: string): Promise<unknown | undefined> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as unknown;
	} catch (error) {
		if (isMissing(error)) return undefined;
		throw error;
	}
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
	await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
	await rename(temporaryPath, path);
}

async function writeJsonExclusive(path: string, value: unknown): Promise<boolean> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	try {
		await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
			mode: 0o600,
			flag: constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
		});
		return true;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "EEXIST") return false;
		throw error;
	}
}

function parseBinding(value: unknown): DurableRoomBinding | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const candidate = value as Partial<DurableRoomBinding>;
	if (
		candidate.version !== 2 ||
		typeof candidate.bindingId !== "string" ||
		typeof candidate.roomId !== "string" ||
		typeof candidate.conceptName !== "string"
	) {
		return undefined;
	}
	assertSafeId(candidate.bindingId, "binding ID");
	return candidate as DurableRoomBinding;
}

function parseSessionLink(value: unknown): SessionLink | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const candidate = value as Partial<SessionLink>;
	if (
		candidate.version !== 1 ||
		typeof candidate.sessionId !== "string" ||
		typeof candidate.bindingId !== "string"
	) {
		return undefined;
	}
	return candidate as SessionLink;
}

function parseHostState(value: unknown): HostState {
	if (value === undefined) return { version: 1, eventOrder: [], events: {} };
	if (typeof value !== "object" || value === null) throw new Error("Invalid remote-session host state");
	const candidate = value as Partial<HostState>;
	if (
		candidate.version !== 1 ||
		(candidate.since !== undefined && typeof candidate.since !== "string") ||
		!Array.isArray(candidate.eventOrder) ||
		!candidate.eventOrder.every((eventId) => typeof eventId === "string") ||
		new Set(candidate.eventOrder).size !== candidate.eventOrder.length ||
		typeof candidate.events !== "object" ||
		candidate.events === null
	) {
		throw new Error("Invalid remote-session host state");
	}
	const events = candidate.events as Record<string, unknown>;
	for (const eventId of candidate.eventOrder) {
		const event = events[eventId];
		if (typeof event !== "object" || event === null) throw new Error("Invalid remote-session host state");
		const progress = event as Partial<EventProgress>;
		if (
			typeof progress.transactionId !== "string" ||
			!["accepted", "injected", "pending", "sent"].includes(progress.status ?? "") ||
			(progress.prompt !== undefined && typeof progress.prompt !== "string") ||
			(progress.kind !== undefined && !["prompt", "steer", "abort"].includes(progress.kind)) ||
			(progress.body !== undefined && typeof progress.body !== "string") ||
			(progress.outboundKind !== undefined && progress.outboundKind !== "command_ack") ||
			((progress.status === "accepted" || progress.status === "injected") && typeof progress.prompt !== "string") ||
			(progress.status === "pending" && typeof progress.body !== "string")
		) {
			throw new Error("Invalid remote-session host state");
		}
	}
	return candidate as HostState;
}

async function sessionIdFromFile(path: string): Promise<string | undefined> {
	const file = await open(path, "r");
	try {
		const buffer = Buffer.alloc(64 * 1024);
		const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
		const firstLine = buffer.subarray(0, bytesRead).toString("utf8").split("\n", 1)[0];
		if (!firstLine) return undefined;
		const header = JSON.parse(firstLine) as { type?: unknown; id?: unknown };
		return header.type === "session" && typeof header.id === "string" ? header.id : undefined;
	} finally {
		await file.close();
	}
}

export class RemoteSessionStateStore {
	readonly root: string;
	private readonly hostKey: string;
	private readonly hostOperations = new Map<string, Promise<void>>();

	constructor(root: string, hostIdentity: string) {
		this.root = resolve(root);
		this.hostKey = hash(hostIdentity).slice(0, 32);
	}

	async bindSession(sessionId: string, binding: DurableRoomBinding): Promise<void> {
		assertSafeId(sessionId, "session ID");
		assertSafeId(binding.bindingId, "binding ID");
		const bindingPath = this.bindingPath(binding.bindingId);
		if (!(await writeJsonExclusive(bindingPath, binding))) {
			const existing = parseBinding(await readJson(bindingPath));
			if (
				!existing ||
				existing.bindingId !== binding.bindingId ||
				existing.roomId !== binding.roomId ||
				existing.conceptName !== binding.conceptName
			) {
				throw new Error(`Conflicting durable Matrix binding ${binding.bindingId}`);
			}
		}

		const sessionPath = this.sessionPath(sessionId);
		const link: SessionLink = { version: 1, sessionId, bindingId: binding.bindingId };
		if (!(await writeJsonExclusive(sessionPath, link))) {
			const existing = parseSessionLink(await readJson(sessionPath));
			if (!existing || existing.bindingId !== binding.bindingId) {
				throw new Error(`Session ${sessionId} is already bound to another Matrix room`);
			}
		}
	}

	async bindingForSession(sessionId: string): Promise<DurableRoomBinding | undefined> {
		assertSafeId(sessionId, "session ID");
		const link = parseSessionLink(await readJson(this.sessionPath(sessionId)));
		if (!link) return undefined;
		const binding = parseBinding(await readJson(this.bindingPath(link.bindingId)));
		if (!binding) throw new Error(`Missing durable Matrix binding ${link.bindingId}`);
		return binding;
	}

	async inheritSession(sessionId: string, parentSessionId: string): Promise<DurableRoomBinding | undefined> {
		const binding = await this.bindingForSession(parentSessionId);
		if (!binding) return undefined;
		await this.bindSession(sessionId, binding);
		return binding;
	}

	async inheritSessionFromFile(sessionId: string, parentSessionFile: string): Promise<DurableRoomBinding | undefined> {
		const parentSessionId = await sessionIdFromFile(parentSessionFile);
		return parentSessionId ? this.inheritSession(sessionId, parentSessionId) : undefined;
	}

	async acceptSync(
		bindingId: string,
		nextBatch: string,
		events: ReadonlyArray<{ eventId: string; prompt: string; kind?: InboundKind }>,
	): Promise<AcceptedInbound[]> {
		return this.withHostState(bindingId, async () => {
			const state = await this.readHostState(bindingId);
			const seenEventIds = new Set(Object.keys(state.events));
			const newEvents = events.filter((event) => {
				if (seenEventIds.has(event.eventId)) return false;
				seenEventIds.add(event.eventId);
				return true;
			});
			this.makeCapacity(state, newEvents.length);
			const accepted: AcceptedInbound[] = [];
			for (const event of newEvents) {
				const stableTransactionId = transactionId(bindingId, event.eventId);
				state.events[event.eventId] = {
					prompt: event.prompt,
					kind: event.kind,
					transactionId: stableTransactionId,
					status: "accepted",
				};
				state.eventOrder.push(event.eventId);
				accepted.push({ ...event, transactionId: stableTransactionId });
			}
			state.since = nextBatch;
			await this.writeHostState(bindingId, state);
			return accepted;
		});
	}

	async advanceCursor(bindingId: string, nextBatch: string): Promise<void> {
		await this.withHostState(bindingId, async () => {
			const state = await this.readHostState(bindingId);
			if (state.since === nextBatch) return;
			state.since = nextBatch;
			await this.writeHostState(bindingId, state);
		});
	}

	async initializeCursor(bindingId: string, since: string | undefined): Promise<void> {
		if (!since) return;
		await this.withHostState(bindingId, async () => {
			const state = await this.readHostState(bindingId);
			if (state.since !== undefined) return;
			state.since = since;
			await this.writeHostState(bindingId, state);
		});
	}

	async hostProgress(bindingId: string): Promise<HostProgress> {
		return this.withHostState(bindingId, async () => {
			const state = await this.readHostState(bindingId);
			return { since: state.since, processedEventIds: [...state.eventOrder] };
		});
	}

	async unfinishedInbounds(bindingId: string): Promise<AcceptedInbound[]> {
		return this.withHostState(bindingId, async () => {
			const state = await this.readHostState(bindingId);
			return state.eventOrder.flatMap((eventId) => {
				const event = state.events[eventId];
				return (event?.status === "accepted" || event?.status === "injected") && event.prompt !== undefined
					? [
							{
								eventId,
								prompt: event.prompt,
								...(event.kind ? { kind: event.kind } : {}),
								transactionId: event.transactionId,
							},
						]
					: [];
			});
		});
	}

	async markInboundInjected(bindingId: string, eventId: string): Promise<void> {
		await this.withHostState(bindingId, async () => {
			const state = await this.readHostState(bindingId);
			const event = state.events[eventId];
			if (!event) throw new Error(`Unknown Matrix event ${eventId}`);
			if (event.status === "accepted") event.status = "injected";
			await this.writeHostState(bindingId, state);
		});
	}

	async markInboundHandled(bindingId: string, eventId: string): Promise<void> {
		await this.withHostState(bindingId, async () => {
			const state = await this.readHostState(bindingId);
			const event = state.events[eventId];
			if (!event) throw new Error(`Unknown Matrix event ${eventId}`);
			event.status = "sent";
			delete event.prompt;
			delete event.body;
			delete event.outboundKind;
			await this.writeHostState(bindingId, state);
		});
	}

	async markCheckpointInboundsHandled(bindingId: string, eventIds: readonly string[]): Promise<void> {
		if (eventIds.length === 0) return;
		await this.withHostState(bindingId, async () => {
			const state = await this.readHostState(bindingId);
			let changed = false;
			for (const eventId of eventIds) {
				const event = state.events[eventId];
				if (!event) continue;
				event.status = "sent";
				delete event.prompt;
				delete event.body;
				delete event.outboundKind;
				changed = true;
			}
			if (changed) await this.writeHostState(bindingId, state);
		});
	}

	async recordAnswer(
		bindingId: string,
		eventId: string,
		body: string,
		outboundKind?: "command_ack",
	): Promise<void> {
		await this.withHostState(bindingId, async () => {
			const state = await this.readHostState(bindingId);
			const event = state.events[eventId];
			if (!event) throw new Error(`Unknown Matrix event ${eventId}`);
			event.body = body;
			event.outboundKind = outboundKind;
			event.status = "pending";
			await this.writeHostState(bindingId, state);
		});
	}

	async discardLegacyRoutineOutbounds(bindingId: string): Promise<void> {
		await this.withHostState(bindingId, async () => {
			const state = await this.readHostState(bindingId);
			let changed = false;
			for (const event of Object.values(state.events)) {
				if (event.status !== "pending" || event.outboundKind === "command_ack") continue;
				event.status = "sent";
				delete event.prompt;
				delete event.body;
				delete event.outboundKind;
				changed = true;
			}
			if (changed) await this.writeHostState(bindingId, state);
		});
	}

	async pendingOutbounds(bindingId: string): Promise<PendingOutbound[]> {
		return this.withHostState(bindingId, async () => {
			const state = await this.readHostState(bindingId);
			return state.eventOrder.flatMap((eventId) => {
				const event = state.events[eventId];
				return event?.status === "pending" && event.body !== undefined
					? [{ eventId, transactionId: event.transactionId, body: event.body }]
					: [];
			});
		});
	}

	async markOutboundSent(bindingId: string, eventId: string): Promise<void> {
		await this.withHostState(bindingId, async () => {
			const state = await this.readHostState(bindingId);
			const event = state.events[eventId];
			if (!event) throw new Error(`Unknown Matrix event ${eventId}`);
			event.status = "sent";
			delete event.prompt;
			delete event.body;
			delete event.outboundKind;
			await this.writeHostState(bindingId, state);
		});
	}

	private bindingPath(bindingId: string): string {
		assertSafeId(bindingId, "binding ID");
		return join(this.root, "bindings", `${bindingId}.json`);
	}

	private sessionPath(sessionId: string): string {
		assertSafeId(sessionId, "session ID");
		return join(this.root, "sessions", `${sessionId}.json`);
	}

	private hostPath(bindingId: string): string {
		assertSafeId(bindingId, "binding ID");
		return join(this.root, "hosts", this.hostKey, `${bindingId}.json`);
	}

	private async withHostState<T>(bindingId: string, operation: () => Promise<T>): Promise<T> {
		const previous = this.hostOperations.get(bindingId) ?? Promise.resolve();
		const current = previous.catch(() => undefined).then(operation);
		this.hostOperations.set(
			bindingId,
			current.then(
				() => undefined,
				() => undefined,
			),
		);
		return current;
	}

	private async readHostState(bindingId: string): Promise<HostState> {
		return parseHostState(await readJson(this.hostPath(bindingId)));
	}

	private async writeHostState(bindingId: string, state: HostState): Promise<void> {
		await writeJsonAtomic(this.hostPath(bindingId), state);
	}

	private makeCapacity(state: HostState, incomingEvents: number): void {
		while (state.eventOrder.length + incomingEvents > MAX_RETAINED_EVENTS) {
			const removableIndex = state.eventOrder.findIndex((eventId) => state.events[eventId]?.status === "sent");
			if (removableIndex === -1) {
				throw new Error(`Remote-session event capacity ${MAX_RETAINED_EVENTS} reached; complete pending turns before polling`);
			}
			const [eventId] = state.eventOrder.splice(removableIndex, 1);
			if (eventId) delete state.events[eventId];
		}
	}
}
