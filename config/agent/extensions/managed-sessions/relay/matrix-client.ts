export interface ManagedMatrixConfig {
	homeserver: string;
	accessToken: string;
	botUserId: string;
	operatorUserId: string;
}

export interface ManagedMatrixRetryOptions {
	maxAttempts?: number;
	baseDelayMs?: number;
	maxDelayMs?: number;
	random?: () => number;
	sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

export class ManagedMatrixError extends Error {
	constructor(
		readonly code: "cancelled" | "http" | "invalid_response" | "network",
		message: string,
		readonly status?: number,
		readonly retryable = false,
		readonly retryAfterMs?: number,
	) {
		super(message);
		this.name = "ManagedMatrixError";
	}
}

type FetchLike = typeof fetch;
type JsonObject = Record<string, unknown>;
const MAX_MATRIX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_RETRY_AFTER_MS = 120_000;
const MAX_TYPING_TIMEOUT_MS = 30_000;
const MAX_MESSAGE_BODY_LENGTH = 32_768;
const MAX_POLL_ANSWERS = 20;

export interface MatrixPollAnswer { id: string; text: string }

function boundedText(value: string, field: string, maximum = MAX_MESSAGE_BODY_LENGTH): string {
	if (!value || value.length > maximum || /[\0]/.test(value)) throw new Error(`${field} must be bounded text`);
	return value;
}

function transaction(value: string): string {
	if (!/^[A-Za-z0-9._~-]{1,255}$/.test(value)) throw new Error("Matrix transaction ID is malformed");
	return value;
}

function requiredString(value: unknown, field: string): string {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ManagedMatrixError("invalid_response", `Matrix response omitted ${field}`);
	const candidate = (value as JsonObject)[field];
	if (typeof candidate !== "string" || candidate.length === 0 || candidate.length > 4_096) throw new ManagedMatrixError("invalid_response", `Matrix response omitted ${field}`);
	return candidate;
}

function defaultSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.reject(new ManagedMatrixError("cancelled", "Matrix request was cancelled"));
	return new Promise((resolve, reject) => {
		const finish = () => { signal?.removeEventListener("abort", abort); resolve(); };
		const timer = setTimeout(finish, milliseconds);
		const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(new ManagedMatrixError("cancelled", "Matrix request was cancelled")); };
		signal?.addEventListener("abort", abort, { once: true });
	});
}

export function managedMatrixConfigFromEnvironment(environment: NodeJS.ProcessEnv = process.env): ManagedMatrixConfig {
	const value = (name: string): string => {
		const result = environment[name]?.trim();
		if (!result) throw new Error(`${name} is required`);
		return result;
	};
	const accessToken = environment.PI_MATRIX_ACCESS_TOKEN;
	if (!accessToken || accessToken.length > 4_096 || /[\0-\x1f\x7f]/.test(accessToken)) throw new Error("PI_MATRIX_ACCESS_TOKEN is required and must be one bounded line");
	const homeserver = new URL(value("PI_MATRIX_HOMESERVER"));
	if (homeserver.protocol !== "https:" || homeserver.username || homeserver.password || homeserver.search || homeserver.hash) {
		throw new Error("PI_MATRIX_HOMESERVER must be a credential-free HTTPS origin");
	}
	return { homeserver: homeserver.toString().replace(/\/$/, ""), accessToken,
		botUserId: value("PI_MATRIX_BOT_USER_ID"), operatorUserId: value("PI_MATRIX_OPERATOR_USER_ID") };
}

export class ManagedMatrixClient {
	readonly homeserver: string;
	readonly botUserId: string;
	readonly operatorUserId: string;
	readonly #accessToken: string;
	readonly #managedRoomIds: Set<string>;
	readonly #retry: Required<Omit<ManagedMatrixRetryOptions, "sleep">> & { sleep: NonNullable<ManagedMatrixRetryOptions["sleep"]> };

	constructor(config: ManagedMatrixConfig, private readonly fetchImplementation: FetchLike = fetch, managedRoomIds: Iterable<string> = [], retry: ManagedMatrixRetryOptions = {}) {
		const parsed = new URL(config.homeserver);
		if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("Matrix homeserver must be a credential-free HTTPS origin");
		this.homeserver = parsed.toString().replace(/\/$/, ""); this.botUserId = config.botUserId; this.operatorUserId = config.operatorUserId;
		this.#accessToken = config.accessToken; this.#managedRoomIds = new Set(managedRoomIds);
		this.#retry = { maxAttempts: retry.maxAttempts ?? 5, baseDelayMs: retry.baseDelayMs ?? 250, maxDelayMs: retry.maxDelayMs ?? 30_000,
			random: retry.random ?? Math.random, sleep: retry.sleep ?? defaultSleep };
		if (!Number.isSafeInteger(this.#retry.maxAttempts) || this.#retry.maxAttempts < 1 || this.#retry.maxAttempts > 10 ||
			this.#retry.baseDelayMs < 1 || this.#retry.maxDelayMs < this.#retry.baseDelayMs || this.#retry.maxDelayMs > MAX_RETRY_AFTER_MS) throw new Error("Invalid Matrix retry policy");
	}

	async whoami(signal?: AbortSignal): Promise<string> { return requiredString(await this.request("GET", "/_matrix/client/v3/account/whoami", undefined, signal), "user_id"); }
	async sync(since?: string, signal?: AbortSignal): Promise<{ nextBatch: string; response: unknown }> {
		const query = new URLSearchParams({ timeout: "30000" }); if (since) query.set("since", since);
		const response = await this.request("GET", `/_matrix/client/v3/sync?${query}`, undefined, signal);
		return { nextBatch: requiredString(response, "next_batch"), response };
	}
	async memberJoined(roomId: string, userId: string, signal?: AbortSignal): Promise<boolean> {
		this.assertManagedRoom(roomId);
		try {
			const response = await this.request("GET", `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.member/${encodeURIComponent(userId)}`, undefined, signal);
			return typeof response === "object" && response !== null && !Array.isArray(response) && (response as JsonObject).membership === "join";
		} catch (error) {
			if (error instanceof ManagedMatrixError && (error.status === 403 || error.status === 404)) return false;
			throw error;
		}
	}
	async eventSender(roomId: string, eventId: string, signal?: AbortSignal): Promise<string | undefined> {
		this.assertManagedRoom(roomId); const response = await this.request("GET", `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/event/${encodeURIComponent(eventId)}`, undefined, signal);
		return typeof response === "object" && response !== null && !Array.isArray(response) && typeof (response as JsonObject).sender === "string" ? String((response as JsonObject).sender) : undefined;
	}
	async createPrivateSpace(name: string, signal?: AbortSignal): Promise<string> { return this.createRoom(name, true, signal); }
	async createPrivateRoom(name: string, signal?: AbortSignal): Promise<string> { return this.createRoom(name, false, signal); }
	private async createRoom(name: string, space: boolean, signal?: AbortSignal): Promise<string> {
		const response = await this.request("POST", "/_matrix/client/v3/createRoom", { visibility: "private", preset: "private_chat", name,
			invite: [this.operatorUserId], is_direct: false, creation_content: { ...(space ? { type: "m.space" } : {}), "m.federate": false } }, signal);
		const roomId = requiredString(response, "room_id"); this.#managedRoomIds.add(roomId); return roomId;
	}
	async addSpaceChild(spaceId: string, roomId: string, signal?: AbortSignal): Promise<void> {
		this.assertManagedRoom(spaceId); this.assertManagedRoom(roomId); const roomServer = roomId.slice(roomId.lastIndexOf(":") + 1);
		if (!roomServer || roomServer === roomId) throw new ManagedMatrixError("invalid_response", "Matrix room ID omitted its server name");
		await this.request("PUT", `/_matrix/client/v3/rooms/${encodeURIComponent(spaceId)}/state/m.space.child/${encodeURIComponent(roomId)}`, { via: [roomServer], suggested: true }, signal);
	}
	async roomAccessible(roomId: string, signal?: AbortSignal): Promise<boolean> {
		this.assertManagedRoom(roomId); try { await this.request("GET", `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.create/`, undefined, signal); return true; }
		catch (error) { if (error instanceof ManagedMatrixError && (error.status === 403 || error.status === 404)) return false; throw error; }
	}
	async setRoomName(roomId: string, name: string, signal?: AbortSignal): Promise<void> { this.assertManagedRoom(roomId); await this.request("PUT", `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.name/`, { name }, signal); }
	async sendText(roomId: string, transactionId: string, body: string, formattedBody?: string, signal?: AbortSignal): Promise<string> {
		this.assertManagedRoom(roomId); const content: JsonObject = { msgtype: "m.text", body: boundedText(body, "message body") };
		if (formattedBody !== undefined) { content.format = "org.matrix.custom.html"; content.formatted_body = boundedText(formattedBody, "formatted message body", MAX_MESSAGE_BODY_LENGTH * 2); }
		return this.sendEvent(roomId, "m.room.message", transactionId, content, signal);
	}
	async sendNotice(roomId: string, transactionId: string, body: string, signal?: AbortSignal): Promise<string> {
		return this.sendEvent(roomId, "m.room.message", transactionId, { msgtype: "m.notice", body: boundedText(body, "notice body") }, signal);
	}
	async replaceMessage(roomId: string, transactionId: string, eventId: string, body: string, notice = true, signal?: AbortSignal): Promise<string> {
		boundedText(eventId, "replacement event ID", 255); const msgtype = notice ? "m.notice" : "m.text";
		const replacement = { msgtype, body: boundedText(body, "replacement body") };
		return this.sendEvent(roomId, "m.room.message", transactionId, { ...replacement, "m.new_content": replacement,
			"m.relates_to": { rel_type: "m.replace", event_id: eventId } }, signal);
	}
	async setTyping(roomId: string, typing: boolean, timeoutMs = MAX_TYPING_TIMEOUT_MS, signal?: AbortSignal): Promise<void> {
		this.assertManagedRoom(roomId);
		if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TYPING_TIMEOUT_MS) throw new Error("Typing timeout is out of bounds");
		await this.request("PUT", `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/typing/${encodeURIComponent(this.botUserId)}`,
			typing ? { typing: true, timeout: timeoutMs } : { typing: false }, signal);
	}
	async startPoll(roomId: string, transactionId: string, question: string, answers: readonly MatrixPollAnswer[], signal?: AbortSignal): Promise<string> {
		if (answers.length < 1 || answers.length > MAX_POLL_ANSWERS || new Set(answers.map((answer) => answer.id)).size !== answers.length) throw new Error("Poll answers are malformed or out of bounds");
		const stableAnswers = answers.map((answer) => ({ id: boundedText(answer.id, "poll answer ID", 255), "m.text": boundedText(answer.text, "poll answer", 1_024) }));
		const poll = { question: { "m.text": boundedText(question, "poll question", 4_096) }, kind: "m.poll.disclosed", max_selections: 1, answers: stableAnswers };
		return this.sendEvent(roomId, "m.poll.start", transactionId, { "m.poll.start": poll, "org.matrix.msc3381.poll.start": poll,
			"m.text": question, "org.matrix.msc1767.text": question }, signal);
	}
	async endPoll(roomId: string, transactionId: string, pollEventId: string, fallback = "Poll closed", signal?: AbortSignal): Promise<string> {
		boundedText(pollEventId, "poll event ID", 255); const text = boundedText(fallback, "poll end fallback", 1_024);
		return this.sendEvent(roomId, "m.poll.end", transactionId, { "m.relates_to": { rel_type: "m.reference", event_id: pollEventId },
			"m.poll.end": {}, "org.matrix.msc3381.poll.end": {}, "m.text": text, "org.matrix.msc1767.text": text }, signal);
	}
	private async sendEvent(roomId: string, eventType: string, transactionId: string, content: JsonObject, signal?: AbortSignal): Promise<string> {
		this.assertManagedRoom(roomId); transaction(transactionId);
		return requiredString(await this.request("PUT", `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/${encodeURIComponent(eventType)}/${encodeURIComponent(transactionId)}`, content, signal), "event_id");
	}
	async leaveRoom(roomId: string, signal?: AbortSignal): Promise<void> { this.assertManagedRoom(roomId); await this.request("POST", `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/leave`, {}, signal); this.#managedRoomIds.delete(roomId); }
	private assertManagedRoom(roomId: string): void { if (!this.#managedRoomIds.has(roomId)) throw new ManagedMatrixError("invalid_response", "Matrix room is not owned by this relay"); }

	private async request(method: string, path: string, body?: JsonObject, signal?: AbortSignal): Promise<unknown> {
		const safePath = path.split("?")[0]; let last: ManagedMatrixError | undefined;
		for (let attempt = 0; attempt < this.#retry.maxAttempts; attempt += 1) {
			if (signal?.aborted) throw new ManagedMatrixError("cancelled", "Matrix request was cancelled");
			try {
				const response = await this.fetchImplementation(new URL(path, this.homeserver), { method, headers: { Authorization: `Bearer ${this.#accessToken}`, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined, signal });
				const length = Number(response.headers.get("content-length"));
				if (Number.isFinite(length) && length > MAX_MATRIX_RESPONSE_BYTES) throw new ManagedMatrixError("invalid_response", "Matrix response exceeded the size limit");
				const text = response.status === 204 ? "" : await response.text();
				if (Buffer.byteLength(text, "utf8") > MAX_MATRIX_RESPONSE_BYTES) throw new ManagedMatrixError("invalid_response", "Matrix response exceeded the size limit");
				let parsed: unknown = {};
				try { parsed = text === "" ? {} : JSON.parse(text) as unknown; }
				catch { if (response.ok) throw new ManagedMatrixError("invalid_response", `Matrix ${method} ${safePath} returned invalid JSON`); }
				if (response.ok) return parsed;
				const retryAfter = response.status === 429 && typeof parsed === "object" && parsed !== null && Number.isSafeInteger((parsed as JsonObject).retry_after_ms)
					? Math.min(MAX_RETRY_AFTER_MS, Math.max(0, Number((parsed as JsonObject).retry_after_ms))) : undefined;
				last = new ManagedMatrixError("http", `Matrix ${method} ${safePath} returned HTTP ${response.status}`, response.status, response.status === 429 || response.status >= 500, retryAfter);
			} catch (error) {
				if (error instanceof ManagedMatrixError) last = error;
				else if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw new ManagedMatrixError("cancelled", "Matrix request was cancelled");
				else last = new ManagedMatrixError("network", `Matrix ${method} ${safePath} failed`, undefined, true);
			}
			const retrySafe = method === "GET" || method === "PUT";
			if (!last.retryable || !retrySafe || attempt + 1 >= this.#retry.maxAttempts) throw last;
			const exponential = Math.min(this.#retry.maxDelayMs, this.#retry.baseDelayMs * (2 ** attempt));
			const jittered = Math.floor(exponential * (0.5 + Math.max(0, Math.min(1, this.#retry.random())) * 0.5));
			await this.#retry.sleep(Math.max(last.retryAfterMs ?? 0, jittered), signal);
		}
		throw last ?? new ManagedMatrixError("network", "Matrix request failed", undefined, true);
	}
}
