export interface MatrixConfig {
	homeserver: string;
	accessToken: string;
	botUserId: string;
	operatorUserId: string;
	hostName: string;
}

export interface MatrixTextEvent {
	roomId: string;
	eventId: string;
	sender: string;
	body: string;
}

export interface MatrixSyncResult {
	nextBatch: string;
	events: MatrixTextEvent[];
}

type FetchLike = typeof fetch;

type JsonRecord = Record<string, unknown>;

export class MatrixHttpError extends Error {
	constructor(method: string, path: string, status: number) {
		super(`Matrix ${method} ${path} returned HTTP ${status}`);
		this.name = "MatrixHttpError";
	}
}

function requiredEnvironmentValue(environment: NodeJS.ProcessEnv, name: string): string {
	const value = environment[name]?.trim();
	if (!value) throw new Error(`${name} is required`);
	return value;
}

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown, field: string): string | undefined {
	if (!isRecord(value)) return undefined;
	const candidate = value[field];
	return typeof candidate === "string" ? candidate : undefined;
}

export function matrixConfigFromEnvironment(environment: NodeJS.ProcessEnv = process.env): MatrixConfig {
	const homeserver = requiredEnvironmentValue(environment, "PI_MATRIX_HOMESERVER");
	const parsedHomeserver = new URL(homeserver);
	if (parsedHomeserver.protocol !== "https:") {
		throw new Error("PI_MATRIX_HOMESERVER must use HTTPS");
	}

	return {
		homeserver: parsedHomeserver.toString().replace(/\/$/, ""),
		accessToken: requiredEnvironmentValue(environment, "PI_MATRIX_ACCESS_TOKEN"),
		botUserId: requiredEnvironmentValue(environment, "PI_MATRIX_BOT_USER_ID"),
		operatorUserId: requiredEnvironmentValue(environment, "PI_MATRIX_OPERATOR_USER_ID"),
		hostName: requiredEnvironmentValue(environment, "PI_MATRIX_HOSTNAME"),
	};
}

export function routeMatrixTextEvent(
	event: MatrixTextEvent,
	binding: { roomId: string },
	config: Pick<MatrixConfig, "operatorUserId" | "hostName">,
): string | undefined {
	if (event.roomId !== binding.roomId || event.sender !== config.operatorUserId) return undefined;

	const prefix = `@${config.hostName}`;
	if (event.body === prefix) return undefined;
	if (!event.body.startsWith(`${prefix} `)) return undefined;

	const text = event.body.slice(prefix.length + 1).trim();
	return text || undefined;
}

export class MatrixClient {
	constructor(
		private readonly config: MatrixConfig,
		private readonly fetchImplementation: FetchLike = fetch,
	) {}

	async authenticatedUserId(signal?: AbortSignal): Promise<string> {
		const payload = await this.request("GET", "/_matrix/client/v3/account/whoami", undefined, signal);
		const userId = stringField(payload, "user_id");
		if (!userId) throw new Error("Matrix whoami response did not contain user_id");
		return userId;
	}

	async createPrivateRoom(conceptName: string, signal?: AbortSignal): Promise<string> {
		const path = "/_matrix/client/v3/createRoom";
		const payload = await this.request(
			"POST",
			path,
			{
				visibility: "private",
				preset: "private_chat",
				name: `pi · ${conceptName}`,
				invite: [this.config.operatorUserId],
				is_direct: false,
				creation_content: { "m.federate": false },
				initial_state: [
					{
						type: "m.room.history_visibility",
						state_key: "",
						content: { history_visibility: "joined" },
					},
					{
						type: "m.room.guest_access",
						state_key: "",
						content: { guest_access: "forbidden" },
					},
				],
			},
			signal,
		);
		const roomId = stringField(payload, "room_id");
		if (!roomId) throw new Error("Matrix createRoom response did not contain room_id");
		return roomId;
	}

	async syncRoom(roomId: string, since: string | undefined, signal?: AbortSignal): Promise<MatrixSyncResult> {
		const filter = {
			presence: { types: [] },
			account_data: { types: [] },
			room: {
				rooms: [roomId],
				account_data: { types: [] },
				ephemeral: { types: [] },
				state: { types: [] },
				timeline: { types: ["m.room.message"], limit: 20 },
			},
		};
		const query = new URLSearchParams({ timeout: "30000", filter: JSON.stringify(filter) });
		if (since) query.set("since", since);

		const payload = await this.request("GET", `/_matrix/client/v3/sync?${query}`, undefined, signal);
		const nextBatch = stringField(payload, "next_batch");
		if (!nextBatch) throw new Error("Matrix sync response did not contain next_batch");

		const events: MatrixTextEvent[] = [];
		const rooms = isRecord(payload) && isRecord(payload.rooms) ? payload.rooms : undefined;
		const joined = rooms && isRecord(rooms.join) ? rooms.join : undefined;
		const joinedRoom = joined && isRecord(joined[roomId]) ? joined[roomId] : undefined;
		const timeline = joinedRoom && isRecord(joinedRoom.timeline) ? joinedRoom.timeline : undefined;
		const timelineEvents = timeline && Array.isArray(timeline.events) ? timeline.events : [];

		for (const event of timelineEvents) {
			if (!isRecord(event) || event.type !== "m.room.message") continue;
			if (!isRecord(event.content) || event.content.msgtype !== "m.text") continue;
			const eventId = stringField(event, "event_id");
			const sender = stringField(event, "sender");
			const body = stringField(event.content, "body");
			if (eventId && sender && body !== undefined) events.push({ roomId, eventId, sender, body });
		}

		return { nextBatch, events };
	}

	async sendText(roomId: string, text: string, transactionId: string, signal?: AbortSignal): Promise<void> {
		const path = `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${encodeURIComponent(transactionId)}`;
		await this.request("PUT", path, { msgtype: "m.text", body: text }, signal);
	}

	private async request(
		method: string,
		path: string,
		body?: JsonRecord,
		signal?: AbortSignal,
	): Promise<unknown> {
		const response = await this.fetchImplementation(new URL(path, this.config.homeserver), {
			method,
			headers: {
				Authorization: `Bearer ${this.config.accessToken}`,
				...(body ? { "Content-Type": "application/json" } : {}),
			},
			body: body ? JSON.stringify(body) : undefined,
			signal,
		});

		if (!response.ok) throw new MatrixHttpError(method, path.split("?")[0], response.status);
		if (response.status === 204) return {};
		return (await response.json()) as unknown;
	}
}
