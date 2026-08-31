export interface ManagedMatrixConfig {
	homeserver: string;
	accessToken: string;
	botUserId: string;
	operatorUserId: string;
}

export class ManagedMatrixError extends Error {
	constructor(
		readonly code: "cancelled" | "http" | "invalid_response" | "network",
		message: string,
		readonly status?: number,
		readonly retryable = false,
	) {
		super(message);
		this.name = "ManagedMatrixError";
	}
}

type FetchLike = typeof fetch;
type JsonObject = Record<string, unknown>;
const MAX_MATRIX_RESPONSE_BYTES = 4 * 1024 * 1024;

function requiredString(value: unknown, field: string): string {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ManagedMatrixError("invalid_response", `Matrix response omitted ${field}`);
	const candidate = (value as JsonObject)[field];
	if (typeof candidate !== "string" || candidate.length === 0) throw new ManagedMatrixError("invalid_response", `Matrix response omitted ${field}`);
	return candidate;
}

export function managedMatrixConfigFromEnvironment(environment: NodeJS.ProcessEnv = process.env): ManagedMatrixConfig {
	const value = (name: string): string => {
		const result = environment[name]?.trim();
		if (!result) throw new Error(`${name} is required`);
		return result;
	};
	const homeserver = new URL(value("PI_MATRIX_HOMESERVER"));
	if (homeserver.protocol !== "https:" || homeserver.username || homeserver.password || homeserver.search || homeserver.hash) {
		throw new Error("PI_MATRIX_HOMESERVER must be a credential-free HTTPS origin");
	}
	return {
		homeserver: homeserver.toString().replace(/\/$/, ""),
		accessToken: value("PI_MATRIX_ACCESS_TOKEN"),
		botUserId: value("PI_MATRIX_BOT_USER_ID"),
		operatorUserId: value("PI_MATRIX_OPERATOR_USER_ID"),
	};
}

export class ManagedMatrixClient {
	readonly homeserver: string;
	readonly botUserId: string;
	readonly operatorUserId: string;
	readonly #accessToken: string;
	readonly #managedRoomIds: Set<string>;

	constructor(config: ManagedMatrixConfig, private readonly fetchImplementation: FetchLike = fetch, managedRoomIds: Iterable<string> = []) {
		const parsed = new URL(config.homeserver);
		if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
			throw new Error("Matrix homeserver must be a credential-free HTTPS origin");
		}
		this.homeserver = parsed.toString().replace(/\/$/, "");
		this.botUserId = config.botUserId;
		this.operatorUserId = config.operatorUserId;
		this.#accessToken = config.accessToken;
		this.#managedRoomIds = new Set(managedRoomIds);
	}

	async whoami(signal?: AbortSignal): Promise<string> {
		return requiredString(await this.request("GET", "/_matrix/client/v3/account/whoami", undefined, signal), "user_id");
	}

	async sync(since?: string, signal?: AbortSignal): Promise<{ nextBatch: string; response: unknown }> {
		const query = new URLSearchParams({ timeout: "30000" });
		if (since) query.set("since", since);
		const response = await this.request("GET", `/_matrix/client/v3/sync?${query}`, undefined, signal);
		return { nextBatch: requiredString(response, "next_batch"), response };
	}

	async createPrivateRoom(name: string, signal?: AbortSignal): Promise<string> {
		const response = await this.request("POST", "/_matrix/client/v3/createRoom", {
			visibility: "private",
			preset: "private_chat",
			name,
			invite: [this.operatorUserId],
			is_direct: false,
			creation_content: { "m.federate": false },
		}, signal);
		const roomId = requiredString(response, "room_id");
		this.#managedRoomIds.add(roomId);
		return roomId;
	}

	async setRoomName(roomId: string, name: string, signal?: AbortSignal): Promise<void> {
		this.assertManagedRoom(roomId);
		await this.request("PUT", `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.name/`, { name }, signal);
	}

	async sendText(roomId: string, transactionId: string, body: string, formattedBody?: string, signal?: AbortSignal): Promise<string> {
		this.assertManagedRoom(roomId);
		const content: JsonObject = { msgtype: "m.text", body };
		if (formattedBody !== undefined) {
			content.format = "org.matrix.custom.html";
			content.formatted_body = formattedBody;
		}
		const response = await this.request("PUT", `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${encodeURIComponent(transactionId)}`, content, signal);
		return requiredString(response, "event_id");
	}

	async leaveRoom(roomId: string, signal?: AbortSignal): Promise<void> {
		this.assertManagedRoom(roomId);
		await this.request("POST", `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/leave`, {}, signal);
		this.#managedRoomIds.delete(roomId);
	}

	private assertManagedRoom(roomId: string): void {
		if (!this.#managedRoomIds.has(roomId)) throw new ManagedMatrixError("invalid_response", "Matrix room is not owned by this relay");
	}

	private async request(method: string, path: string, body?: JsonObject, signal?: AbortSignal): Promise<unknown> {
		let response: Response;
		try {
			response = await this.fetchImplementation(new URL(path, this.homeserver), {
				method,
				headers: {
					Authorization: `Bearer ${this.#accessToken}`,
					...(body ? { "Content-Type": "application/json" } : {}),
				},
				body: body ? JSON.stringify(body) : undefined,
				signal,
			});
		} catch (error) {
			if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
				throw new ManagedMatrixError("cancelled", "Matrix request was cancelled");
			}
			throw new ManagedMatrixError("network", `Matrix ${method} ${path.split("?")[0]} failed`, undefined, true);
		}
		const safePath = path.split("?")[0];
		if (!response.ok) {
			throw new ManagedMatrixError("http", `Matrix ${method} ${safePath} returned HTTP ${response.status}`, response.status, response.status === 429 || response.status >= 500);
		}
		if (response.status === 204) return {};
		const length = Number(response.headers.get("content-length"));
		if (Number.isFinite(length) && length > MAX_MATRIX_RESPONSE_BYTES) throw new ManagedMatrixError("invalid_response", "Matrix response exceeded the size limit");
		const text = await response.text();
		if (Buffer.byteLength(text, "utf8") > MAX_MATRIX_RESPONSE_BYTES) throw new ManagedMatrixError("invalid_response", "Matrix response exceeded the size limit");
		try {
			return text === "" ? {} : JSON.parse(text) as unknown;
		} catch {
			throw new ManagedMatrixError("invalid_response", `Matrix ${method} ${safePath} returned invalid JSON`);
		}
	}
}
