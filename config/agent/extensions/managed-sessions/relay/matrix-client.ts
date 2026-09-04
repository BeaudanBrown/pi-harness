import { MAX_BLOB_BYTES } from "../v2-contracts.js";

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
	async downloadMedia(mxcUrl: string, declaredSize: number, signal?: AbortSignal): Promise<{ bytes: Buffer; mimeType?: string }> {
		if (!Number.isSafeInteger(declaredSize) || declaredSize < 1 || declaredSize > MAX_BLOB_BYTES) throw new ManagedMatrixError("invalid_response", "Matrix media declaration exceeded the size limit");
		let parsed: URL;
		try { parsed = new URL(mxcUrl); } catch { throw new ManagedMatrixError("invalid_response", "Matrix media URL is malformed"); }
		const mediaId = parsed.pathname.slice(1);
		if (parsed.protocol !== "mxc:" || !parsed.host || parsed.username || parsed.password || parsed.search || parsed.hash || !mediaId || mediaId.includes("/")) {
			throw new ManagedMatrixError("invalid_response", "Matrix media URL is malformed");
		}
		const endpoint = `/_matrix/client/v1/media/download/${encodeURIComponent(parsed.host)}/${encodeURIComponent(mediaId)}`;
		let last: ManagedMatrixError | undefined;
		for (let attempt = 0; attempt < this.#retry.maxAttempts; attempt += 1) {
			if (signal?.aborted) throw new ManagedMatrixError("cancelled", "Matrix request was cancelled");
			try {
				const response = await this.fetchImplementation(new URL(endpoint, this.homeserver), { method: "GET", redirect: "error",
					headers: { Authorization: `Bearer ${this.#accessToken}` }, signal });
				if (!response.ok) throw new ManagedMatrixError("http", `Matrix GET /_matrix/client/v1/media/download returned HTTP ${response.status}`,
					response.status, response.status === 429 || response.status >= 500);
				const length = Number(response.headers.get("content-length"));
				if (Number.isFinite(length) && (length !== declaredSize || length > MAX_BLOB_BYTES)) throw new ManagedMatrixError("invalid_response", "Matrix media length disagreed with its declaration");
				if (!response.body) throw new ManagedMatrixError("invalid_response", "Matrix media response had no body");
				const chunks: Buffer[] = []; let total = 0; const reader = response.body.getReader();
				while (true) {
					const item = await reader.read(); if (item.done) break;
					total += item.value.byteLength;
					if (total > declaredSize || total > MAX_BLOB_BYTES) { await reader.cancel(); throw new ManagedMatrixError("invalid_response", "Matrix media stream exceeded its declaration"); }
					chunks.push(Buffer.from(item.value));
				}
				if (total !== declaredSize) throw new ManagedMatrixError("invalid_response", "Matrix media stream was truncated");
				return { bytes: Buffer.concat(chunks, total), mimeType: response.headers.get("content-type") ?? undefined };
			} catch (error) {
				if (error instanceof ManagedMatrixError) last = error;
				else if (signal?.aborted || error instanceof Error && error.name === "AbortError") throw new ManagedMatrixError("cancelled", "Matrix request was cancelled");
				else last = new ManagedMatrixError("network", "Matrix media download failed", undefined, true);
				if (!last.retryable || attempt + 1 >= this.#retry.maxAttempts) throw last;
				const delay = Math.min(this.#retry.maxDelayMs, this.#retry.baseDelayMs * (2 ** attempt));
				await this.#retry.sleep(delay, signal);
			}
		}
		throw last ?? new ManagedMatrixError("network", "Matrix media download failed", undefined, true);
	}
	async pollDialect(roomId: string, eventId: string, signal?: AbortSignal): Promise<"stable" | "unstable" | undefined> {
		this.assertManagedRoom(roomId);
		const response = await this.request("GET", `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/event/${encodeURIComponent(eventId)}`, undefined, signal);
		if (typeof response !== "object" || response === null || Array.isArray(response)) return undefined;
		const event = response as JsonObject;
		if (event.sender !== this.botUserId) return undefined;
		if (event.type === "m.poll.start") return "stable";
		if (event.type === "org.matrix.msc3381.poll.start") return "unstable";
		return undefined;
	}
	async controlPollAnswer(roomId: string, eventId: string, answerId: string, signal?: AbortSignal): Promise<string | undefined> {
		this.assertManagedRoom(roomId);
		const response = await this.request("GET", `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/event/${encodeURIComponent(eventId)}`, undefined, signal);
		if (typeof response !== "object" || response === null || Array.isArray(response)) return undefined;
		const event = response as JsonObject;
		if (event.sender !== this.botUserId || typeof event.content !== "object" || event.content === null || Array.isArray(event.content)) return undefined;
		const stable = event.type === "m.poll.start";
		if (!stable && event.type !== "org.matrix.msc3381.poll.start") return undefined;
		const poll = (event.content as JsonObject)[stable ? "m.poll" : "org.matrix.msc3381.poll.start"];
		if (typeof poll !== "object" || poll === null || Array.isArray(poll)) return undefined;
		const value = poll as JsonObject;
		if (value.kind !== (stable ? "m.disclosed" : "org.matrix.msc3381.poll.disclosed") || value.max_selections !== 1 || !Array.isArray(value.answers) || value.answers.length < 1 || value.answers.length > MAX_POLL_ANSWERS) return undefined;
		let selected: string | undefined; const ids = new Set<string>();
		for (let index = 0; index < value.answers.length; index += 1) {
			const candidate = value.answers[index];
			if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) return undefined;
			const answer = candidate as JsonObject; const id = answer[stable ? "m.id" : "id"];
			const text = answer[stable ? "m.text" : "org.matrix.msc1767.text"];
			const body = stable && Array.isArray(text) && text.length === 1 && typeof text[0] === "object" && text[0] !== null && !Array.isArray(text[0])
				? (text[0] as JsonObject).body : !stable ? text : undefined;
			if (id !== `pi-control-${index}` || ids.has(id) || typeof body !== "string" || body.length < 1 || body.length > 255) return undefined;
			ids.add(id);
			if (id === answerId) selected = body;
		}
		return selected;
	}
	async checkpointPollAnswer(roomId: string, eventId: string, answerId: string, question: string,
		expected: readonly MatrixPollAnswer[], signal?: AbortSignal): Promise<string | undefined> {
		this.assertManagedRoom(roomId);
		const response = await this.request("GET", `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/event/${encodeURIComponent(eventId)}`, undefined, signal);
		if (typeof response !== "object" || response === null || Array.isArray(response)) return undefined;
		const event = response as JsonObject;
		if (event.sender !== this.botUserId || typeof event.content !== "object" || event.content === null || Array.isArray(event.content)) return undefined;
		const stable = event.type === "m.poll.start";
		if (!stable && event.type !== "org.matrix.msc3381.poll.start") return undefined;
		const content = event.content as JsonObject; const pollKey = stable ? "m.poll" : "org.matrix.msc3381.poll.start";
		const fallbackKey = stable ? "m.text" : "org.matrix.msc1767.text";
		if (Object.keys(content).length !== 2 || (stable ? !Array.isArray(content[fallbackKey]) : typeof content[fallbackKey] !== "string") ||
			typeof content[pollKey] !== "object" || content[pollKey] === null || Array.isArray(content[pollKey])) return undefined;
		const poll = content[pollKey] as JsonObject;
		if (Object.keys(poll).length !== 4 || poll.kind !== (stable ? "m.disclosed" : "org.matrix.msc3381.poll.disclosed") || poll.max_selections !== 1 ||
			!Array.isArray(poll.answers) || poll.answers.length !== expected.length || typeof poll.question !== "object" || poll.question === null || Array.isArray(poll.question)) return undefined;
		const questionValue = poll.question as JsonObject; const questionText = questionValue[stable ? "m.text" : "org.matrix.msc1767.text"];
		const questionBody = stable && Array.isArray(questionText) && questionText.length === 1 && typeof questionText[0] === "object" && questionText[0] !== null && !Array.isArray(questionText[0])
			? (questionText[0] as JsonObject).body : !stable ? questionText : undefined;
		if (Object.keys(questionValue).length !== 1 || questionBody !== question) return undefined;
		let selected: string | undefined;
		for (let index = 0; index < expected.length; index += 1) {
			const candidate = poll.answers[index]; const offered = expected[index];
			if (!offered || typeof candidate !== "object" || candidate === null || Array.isArray(candidate) || Object.keys(candidate).length !== 2) return undefined;
			const value = candidate as JsonObject; const text = value[stable ? "m.text" : "org.matrix.msc1767.text"];
			const body = stable && Array.isArray(text) && text.length === 1 && typeof text[0] === "object" && text[0] !== null && !Array.isArray(text[0]) && Object.keys(text[0] as JsonObject).length === 1
				? (text[0] as JsonObject).body : !stable ? text : undefined;
			if (value[stable ? "m.id" : "id"] !== offered.id || body !== offered.text) return undefined;
			if (offered.id === answerId) selected = offered.text;
		}
		return selected;
	}

	async createPrivateSpace(name: string, signal?: AbortSignal): Promise<string> { return this.createRoom(name, true, signal); }
	async createPrivateRoom(name: string, signal?: AbortSignal): Promise<string> { return this.createRoom(name, false, signal); }
	async createPrivateSpaceIdempotent(name: string, aliasLocalpart: string, signal?: AbortSignal): Promise<string> { return this.createRoom(name, true, signal, aliasLocalpart); }
	async createPrivateRoomIdempotent(name: string, aliasLocalpart: string, signal?: AbortSignal): Promise<string> { return this.createRoom(name, false, signal, aliasLocalpart); }
	private async createRoom(name: string, space: boolean, signal?: AbortSignal, aliasLocalpart?: string): Promise<string> {
		if (aliasLocalpart !== undefined && !/^[a-z0-9._=-]{1,128}$/.test(aliasLocalpart)) throw new Error("Matrix room alias localpart is malformed");
		let roomId: string;
		try {
			const response = await this.request("POST", "/_matrix/client/v3/createRoom", { visibility: "private", preset: "private_chat", name,
				invite: [this.operatorUserId], is_direct: false, ...(aliasLocalpart ? { room_alias_name: aliasLocalpart } : {}),
				creation_content: { ...(space ? { type: "m.space" } : {}), "m.federate": false } }, signal);
			roomId = requiredString(response, "room_id");
		} catch (error) {
			if (!aliasLocalpart || !(error instanceof ManagedMatrixError) || !(error.code === "network" || [400, 409].includes(error.status ?? 0))) throw error;
			const server = this.botUserId.slice(this.botUserId.indexOf(":") + 1);
			if (!server || server === this.botUserId) throw new ManagedMatrixError("invalid_response", "Matrix bot ID omitted its server name");
			const resolved = await this.request("GET", `/_matrix/client/v3/directory/room/${encodeURIComponent(`#${aliasLocalpart}:${server}`)}`, undefined, signal);
			roomId = requiredString(resolved, "room_id");
		}
		if (!/^![^\s:]{1,200}:[^\s]{1,200}$/.test(roomId) || roomId.length > 255) throw new ManagedMatrixError("invalid_response", "Matrix response returned a malformed room ID");
		this.#managedRoomIds.add(roomId);
		if (aliasLocalpart) {
			const createEvent = await this.request("GET", `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.create/`, undefined, signal);
			if (typeof createEvent !== "object" || createEvent === null || Array.isArray(createEvent) ||
				((createEvent as JsonObject).creator !== undefined && (createEvent as JsonObject).creator !== this.botUserId) || !await this.memberJoined(roomId, this.botUserId, signal) ||
				(space && (createEvent as JsonObject).type !== "m.space") || (!space && (createEvent as JsonObject).type === "m.space")) {
				this.#managedRoomIds.delete(roomId); throw new ManagedMatrixError("invalid_response", "Matrix idempotent room identity was not bot-owned");
			}
		}
		return roomId;
	}
	async resolvePrivateRoomAlias(aliasLocalpart: string, space: boolean, signal?: AbortSignal): Promise<string | undefined> {
		if (!/^[a-z0-9._=-]{1,128}$/.test(aliasLocalpart)) throw new Error("Matrix room alias localpart is malformed");
		const server = this.botUserId.slice(this.botUserId.indexOf(":") + 1);
		if (!server || server === this.botUserId) throw new ManagedMatrixError("invalid_response", "Matrix bot ID omitted its server name");
		let roomId: string;
		try { roomId = requiredString(await this.request("GET", `/_matrix/client/v3/directory/room/${encodeURIComponent(`#${aliasLocalpart}:${server}`)}`, undefined, signal), "room_id"); }
		catch (error) { if (error instanceof ManagedMatrixError && error.status === 404) return undefined; throw error; }
		if (!/^![^\s:]{1,200}:[^\s]{1,200}$/.test(roomId) || roomId.length > 255) throw new ManagedMatrixError("invalid_response", "Matrix alias returned a malformed room ID");
		this.#managedRoomIds.add(roomId);
		try { await this.assertRoomAuthority(roomId, space, signal); } catch (error) { this.#managedRoomIds.delete(roomId); throw error; }
		return roomId;
	}
	async assertRoomAuthority(roomId: string, space: boolean, signal?: AbortSignal, required: { spaceChild?: boolean; kick?: boolean } = {}): Promise<void> {
		this.assertManagedRoom(roomId);
		const create = await this.request("GET", `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.create/`, undefined, signal);
		const powers = await this.request("GET", `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.power_levels/`, undefined, signal);
		if (typeof create !== "object" || create === null || Array.isArray(create) || typeof powers !== "object" || powers === null || Array.isArray(powers) ||
			((create as JsonObject).creator !== undefined && (create as JsonObject).creator !== this.botUserId) ||
			(space ? (create as JsonObject).type !== "m.space" : (create as JsonObject).type === "m.space") || !await this.memberJoined(roomId, this.botUserId, signal)) {
			throw new ManagedMatrixError("invalid_response", "Matrix room is not bot-owned with the expected type");
		}
		const value = powers as JsonObject; const users = typeof value.users === "object" && value.users !== null && !Array.isArray(value.users) ? value.users as JsonObject : {};
		const events = typeof value.events === "object" && value.events !== null && !Array.isArray(value.events) ? value.events as JsonObject : {};
		const bot = Number(users[this.botUserId] ?? value.users_default ?? 0); const stateDefault = Number(value.state_default ?? 50);
		const thresholds = [stateDefault, ...(required.spaceChild ? [Number(events["m.space.child"] ?? stateDefault)] : []), ...(required.kick ? [Number(value.kick ?? 50)] : [])];
		if (!Number.isFinite(bot) || thresholds.some((threshold) => !Number.isFinite(threshold) || bot < threshold)) {
			throw new ManagedMatrixError("invalid_response", "Matrix bot lacks authority over required room operations");
		}
	}
	async addSpaceChild(spaceId: string, roomId: string, signal?: AbortSignal): Promise<void> {
		this.assertManagedRoom(spaceId); this.assertManagedRoom(roomId); const roomServer = roomId.slice(roomId.lastIndexOf(":") + 1);
		if (!roomServer || roomServer === roomId) throw new ManagedMatrixError("invalid_response", "Matrix room ID omitted its server name");
		await this.request("PUT", `/_matrix/client/v3/rooms/${encodeURIComponent(spaceId)}/state/m.space.child/${encodeURIComponent(roomId)}`, { via: [roomServer], suggested: true }, signal);
	}
	async removeSpaceChild(spaceId: string, roomId: string, signal?: AbortSignal): Promise<void> {
		this.assertManagedRoom(spaceId); this.assertManagedRoom(roomId);
		await this.request("PUT", `/_matrix/client/v3/rooms/${encodeURIComponent(spaceId)}/state/m.space.child/${encodeURIComponent(roomId)}`, {}, signal);
	}
	async spaceChildren(spaceId: string, signal?: AbortSignal): Promise<string[]> {
		this.assertManagedRoom(spaceId); const state = await this.request("GET", `/_matrix/client/v3/rooms/${encodeURIComponent(spaceId)}/state`, undefined, signal);
		if (!Array.isArray(state) || state.length > 4_096) throw new ManagedMatrixError("invalid_response", "Matrix Space state is malformed or too large");
		const children: string[] = [];
		for (const event of state) {
			if (typeof event !== "object" || event === null || Array.isArray(event)) throw new ManagedMatrixError("invalid_response", "Matrix Space state is malformed");
			const value = event as JsonObject; if (value.type !== "m.space.child") continue;
			if (typeof value.state_key !== "string" || !/^![^\s:]{1,200}:[^\s]{1,200}$/.test(value.state_key) || typeof value.content !== "object" || value.content === null || Array.isArray(value.content)) {
				throw new ManagedMatrixError("invalid_response", "Matrix Space child state is malformed");
			}
			if (Array.isArray((value.content as JsonObject).via) && ((value.content as JsonObject).via as unknown[]).length > 0) children.push(value.state_key);
		}
		return [...new Set(children)].sort();
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
	async createMedia(signal?: AbortSignal): Promise<{ contentUri: string; unusedExpiresAt: string }> {
		const response = await this.request("POST", "/_matrix/media/v1/create", {}, signal);
		const contentUri = requiredString(response, "content_uri"); this.parseMxc(contentUri);
		const expiration = typeof response === "object" && response !== null ? Number((response as JsonObject).unused_expires_at) : NaN;
		if (!Number.isSafeInteger(expiration) || expiration <= Date.now() || expiration > Date.now() + 7 * 24 * 60 * 60 * 1_000) throw new ManagedMatrixError("invalid_response", "Matrix media reservation omitted its bounded expiry");
		return { contentUri, unusedExpiresAt: new Date(expiration).toISOString() };
	}
	async uploadMedia(contentUri: string, filename: string, mimeType: string, bytes: Buffer, signal?: AbortSignal): Promise<void> {
		const { serverName, mediaId } = this.parseMxc(contentUri);
		if (!filename || filename.length > 255 || /[\\/\0-\x1f\x7f]/.test(filename)) throw new Error("Matrix media filename is unsafe");
		if (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(mimeType) || bytes.length < 1 || bytes.length > MAX_BLOB_BYTES) throw new Error("Matrix media upload metadata is invalid");
		const path = `/_matrix/media/v3/upload/${encodeURIComponent(serverName)}/${encodeURIComponent(mediaId)}?filename=${encodeURIComponent(filename)}`;
		let last: ManagedMatrixError | undefined;
		for (let attempt = 0; attempt < this.#retry.maxAttempts; attempt += 1) {
			try {
				const response = await this.fetchImplementation(new URL(path, this.homeserver), { method: "PUT", redirect: "error", headers: {
					Authorization: `Bearer ${this.#accessToken}`, "Content-Type": mimeType, "Content-Length": String(bytes.length),
				}, body: new Uint8Array(bytes), signal });
				if (response.ok || response.status === 409) return; // A retry after an uncertain successful PUT cannot overwrite the reserved MXC URI.
				last = new ManagedMatrixError("http", `Matrix PUT /_matrix/media/v3/upload returned HTTP ${response.status}`, response.status, response.status === 429 || response.status >= 500);
			} catch (error) {
				if (error instanceof ManagedMatrixError) last = error;
				else if (signal?.aborted || error instanceof Error && error.name === "AbortError") throw new ManagedMatrixError("cancelled", "Matrix media upload was cancelled");
				else last = new ManagedMatrixError("network", "Matrix media upload failed", undefined, true);
			}
			if (!last.retryable || attempt + 1 >= this.#retry.maxAttempts) throw last;
			await this.#retry.sleep(Math.min(this.#retry.maxDelayMs, this.#retry.baseDelayMs * (2 ** attempt)), signal);
		}
		throw last ?? new ManagedMatrixError("network", "Matrix media upload failed", undefined, true);
	}
	async sendMedia(roomId: string, transactionId: string, value: { contentUri: string; filename: string; mimeType: string; mediaType: "image" | "audio" | "file"; byteLength: number; width?: number; height?: number }, signal?: AbortSignal): Promise<string> {
		this.parseMxc(value.contentUri); boundedText(value.filename, "media filename", 255);
		const info: JsonObject = { mimetype: value.mimeType, size: value.byteLength };
		if (value.mediaType === "image") { info.w = value.width; info.h = value.height; }
		return this.sendEvent(roomId, "m.room.message", transactionId, { msgtype: `m.${value.mediaType}`, body: value.filename,
			filename: value.filename, url: value.contentUri, info }, signal);
	}
	async replaceMessage(roomId: string, transactionId: string, eventId: string, body: string, notice = true, signal?: AbortSignal): Promise<string> {
		boundedText(eventId, "replacement event ID", 255); const msgtype = notice ? "m.notice" : "m.text";
		const replacement = { msgtype, body: boundedText(body, "replacement body") };
		const fallback = `* ${replacement.body.slice(0, MAX_MESSAGE_BODY_LENGTH - 2)}`;
		return this.sendEvent(roomId, "m.room.message", transactionId, { msgtype, body: fallback, "m.new_content": replacement,
			"m.relates_to": { rel_type: "m.replace", event_id: eventId } }, signal);
	}
	async setTyping(roomId: string, typing: boolean, timeoutMs = MAX_TYPING_TIMEOUT_MS, signal?: AbortSignal): Promise<void> {
		this.assertManagedRoom(roomId);
		if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TYPING_TIMEOUT_MS) throw new Error("Typing timeout is out of bounds");
		await this.request("PUT", `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/typing/${encodeURIComponent(this.botUserId)}`,
			typing ? { typing: true, timeout: timeoutMs } : { typing: false }, signal);
	}
	async startPoll(roomId: string, transactionId: string, question: string, answers: readonly MatrixPollAnswer[], signal?: AbortSignal, dialect: "stable" | "unstable" = "unstable"): Promise<string> {
		if (answers.length < 1 || answers.length > MAX_POLL_ANSWERS || new Set(answers.map((answer) => answer.id)).size !== answers.length) throw new Error("Poll answers are malformed or out of bounds");
		const text = boundedText(question, "poll question", 4_096);
		const normalized = answers.map((answer) => ({ id: boundedText(answer.id, "poll answer ID", 255), text: boundedText(answer.text, "poll answer", 1_024) }));
		const fallback = boundedText([text, ...normalized.map((answer, index) => `${index + 1}. ${answer.text}`)].join("\n"), "poll fallback");
		if (dialect === "stable") return this.sendEvent(roomId, "m.poll.start", transactionId, {
			"m.text": [{ mimetype: "text/plain", body: fallback }],
			"m.poll": {
				kind: "m.disclosed", max_selections: 1, question: { "m.text": [{ body: text }] },
				answers: normalized.map((answer) => ({ "m.id": answer.id, "m.text": [{ body: answer.text }] })),
			},
		}, signal);
		return this.sendEvent(roomId, "org.matrix.msc3381.poll.start", transactionId, {
			"org.matrix.msc1767.text": fallback,
			"org.matrix.msc3381.poll.start": {
				kind: "org.matrix.msc3381.poll.disclosed", max_selections: 1, question: { "org.matrix.msc1767.text": text },
				answers: normalized.map((answer) => ({ id: answer.id, "org.matrix.msc1767.text": answer.text })),
			},
		}, signal);
	}
	async endPoll(roomId: string, transactionId: string, pollEventId: string, fallback = "Poll closed", signal?: AbortSignal, dialect: "stable" | "unstable" = "unstable"): Promise<string> {
		boundedText(pollEventId, "poll event ID", 255); const text = boundedText(fallback, "poll end fallback", 1_024);
		const relation = { rel_type: "m.reference", event_id: pollEventId };
		return dialect === "stable"
			? this.sendEvent(roomId, "m.poll.end", transactionId, { "m.relates_to": relation, "m.text": [{ mimetype: "text/plain", body: text }] }, signal)
			: this.sendEvent(roomId, "org.matrix.msc3381.poll.end", transactionId, { "m.relates_to": relation, "org.matrix.msc1767.text": text, "org.matrix.msc3381.poll.end": {} }, signal);
	}
	private async sendEvent(roomId: string, eventType: string, transactionId: string, content: JsonObject, signal?: AbortSignal): Promise<string> {
		this.assertManagedRoom(roomId); transaction(transactionId);
		return requiredString(await this.request("PUT", `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/${encodeURIComponent(eventType)}/${encodeURIComponent(transactionId)}`, content, signal), "event_id");
	}
	async removeRoomMember(roomId: string, userId: string, signal?: AbortSignal): Promise<void> {
		this.assertManagedRoom(roomId); boundedText(userId, "Matrix user ID", 255);
		await this.request("POST", `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/kick`, { user_id: userId, reason: "Obsolete empty managed project Space cleanup" }, signal);
	}
	async leaveRoom(roomId: string, signal?: AbortSignal): Promise<void> { this.assertManagedRoom(roomId); await this.request("POST", `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/leave`, {}, signal); this.#managedRoomIds.delete(roomId); }
	private assertManagedRoom(roomId: string): void { if (!this.#managedRoomIds.has(roomId)) throw new ManagedMatrixError("invalid_response", "Matrix room is not owned by this relay"); }
	private parseMxc(value: string): { serverName: string; mediaId: string } {
		let parsed: URL; try { parsed = new URL(value); } catch { throw new ManagedMatrixError("invalid_response", "Matrix content URI is malformed"); }
		const mediaId = parsed.pathname.slice(1);
		if (parsed.protocol !== "mxc:" || !parsed.host || !mediaId || mediaId.includes("/") || parsed.username || parsed.password || parsed.search || parsed.hash) throw new ManagedMatrixError("invalid_response", "Matrix content URI is malformed");
		return { serverName: parsed.host, mediaId };
	}

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
