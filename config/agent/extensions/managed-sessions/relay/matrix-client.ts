import { parseAccountAction, type AccountAction } from "../live-workspace-contracts.js";
import { isDeepStrictEqual } from "node:util";
import { planOperatorAdmin, type AdminRoom, type AdminPowerSnapshot } from "./operator-admin.js";
import { HostControlError } from "./host-control-error.js";
import { isMatrixRoomId } from "../../matrix-shared/room-id.js";
import { isSoleRoomCreator } from "../../matrix-shared/room-creator.js";
import { deriveConversationId, type ConversationManifest } from "../contracts.js";
import { MANAGED_PROVENANCE_EVENT, managedRoomAlias, parseManagedProvenance, safeManagedTitle, type ManagedProvenance } from "../managed-provenance.js";
import { MAX_BLOB_BYTES } from "../v2-contracts.js";
import { MatrixError as ManagedMatrixError, MatrixHttp, MAX_MATRIX_RESPONSE_BYTES, type MatrixRetryOptions } from "../../matrix-shared/http.js";
export { ManagedMatrixError };

/** Never include homeserver response bodies or credential-bearing URLs in IPC errors. */
class ForeignMatrixOwnerError extends ManagedMatrixError {
	constructor() { super("invalid_response", "Matrix room has foreign or ambiguous creators"); }
}
export function describeMatrixFailure(error: ManagedMatrixError): string {
	const reasons = new Set(["Matrix v12 create event does not prove bot ownership", "Matrix room has foreign or ambiguous creators",
		"Matrix bot lacks authority over required room operations", "Matrix room is not bot-owned with the expected type"]);
	return `${error.code}${error.status ? ` (HTTP ${error.status})` : ""}${reasons.has(error.message) ? `: ${error.message}` : ""}`;
}

export interface ManagedMatrixConfig {
	homeserver: string;
	accessToken: string;
	botUserId: string;
	operatorUserId: string;
	ignoredSenderUserIds?: readonly string[];
}

export type ManagedMatrixRetryOptions = MatrixRetryOptions;

type FetchLike = typeof fetch;
type JsonObject = Record<string, unknown>;
const MAX_TYPING_TIMEOUT_MS = 30_000;
const MAX_MESSAGE_BODY_LENGTH = 32_768;
const MAX_POLL_ANSWERS = 20;
const MAX_JOINED_MEMBERS = 4_096;
const MAX_IGNORED_SENDERS = 64;

export function isMatrixUserId(value: unknown): value is string {
	return typeof value === "string" && value.length <= 512 && /^@[^\s:]{1,255}:[^\s]{1,255}$/.test(value);
}

function ignoredSendersFromEnvironment(environment: NodeJS.ProcessEnv): string[] {
	const encoded = environment.PI_MATRIX_IGNORED_SENDER_USER_IDS;
	if (encoded === undefined) return [];
	let parsed: unknown;
	try { parsed = JSON.parse(encoded); } catch { throw new Error("PI_MATRIX_IGNORED_SENDER_USER_IDS must be a JSON array of Matrix user IDs"); }
	if (!Array.isArray(parsed) || parsed.length > MAX_IGNORED_SENDERS || parsed.some((value) => !isMatrixUserId(value)) || new Set(parsed).size !== parsed.length) {
		throw new Error("PI_MATRIX_IGNORED_SENDER_USER_IDS must contain at most 64 unique Matrix user IDs");
	}
	return parsed as string[];
}

export interface MatrixPollAnswer { id: string; text: string }

function boundedText(value: string, field: string, maximum = MAX_MESSAGE_BODY_LENGTH): string {
	if (!value || value.length > maximum || /[\0]/.test(value)) throw new Error(`${field} must be bounded text`);
	return value;
}

function transaction(value: string): string {
	if (!/^[A-Za-z0-9._~-]{1,255}$/.test(value)) throw new Error("Matrix transaction ID is malformed");
	return value;
}

function hasExpectedPollContent(content: JsonObject, pollKey: string, fallbackKey: string): boolean {
	const keys = Object.keys(content);
	if (!keys.includes(pollKey) || !keys.includes(fallbackKey) || keys.some((key) => key !== pollKey && key !== fallbackKey && key !== "m.mentions" && key !== "lol.bepis.pi.notification")) return false;
	const metadata = content["lol.bepis.pi.notification"];
	if (metadata !== undefined) {
		if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return false;
		const notice = metadata as JsonObject;
		if (Object.keys(notice).length !== 2 || notice.version !== 1 || !["notify", "silent"].includes(String(notice.disposition))) return false;
		if (notice.disposition === "silent") {
			const mentions = content["m.mentions"];
			return typeof mentions === "object" && mentions !== null && !Array.isArray(mentions) && Object.keys(mentions).length === 0;
		}
	}
	if (!Object.hasOwn(content, "m.mentions")) return metadata === undefined; // Legacy polls remain resolvable.
	const mentions = content["m.mentions"];
	return typeof mentions === "object" && mentions !== null && !Array.isArray(mentions) &&
		Object.keys(mentions).length === 1 && (mentions as JsonObject).room === true;
}

function requiredString(value: unknown, field: string): string {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ManagedMatrixError("invalid_response", `Matrix response omitted ${field}`);
	const candidate = (value as JsonObject)[field];
	if (typeof candidate !== "string" || candidate.length === 0 || candidate.length > 4_096) throw new ManagedMatrixError("invalid_response", `Matrix response omitted ${field}`);
	return candidate;
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
	const botUserId = value("PI_MATRIX_BOT_USER_ID");
	const operatorUserId = value("PI_MATRIX_OPERATOR_USER_ID");
	const ignoredSenderUserIds = ignoredSendersFromEnvironment(environment);
	if (!isMatrixUserId(botUserId) || !isMatrixUserId(operatorUserId)) throw new Error("Configured Matrix identities must be complete Matrix user IDs");
	if (ignoredSenderUserIds.includes(operatorUserId)) throw new Error("The configured Matrix operator cannot be an ignored sender");
	return { homeserver: homeserver.toString().replace(/\/$/, ""), accessToken, botUserId, operatorUserId, ignoredSenderUserIds };
}

export class ManagedMatrixClient {
	readonly homeserver: string;
	readonly botUserId: string;
	readonly operatorUserId: string;
	readonly ignoredSenderUserIds: ReadonlySet<string>;
	readonly #accessToken: string;
	readonly #managedRoomIds: Set<string>;
	// Reference-only scope, reserved before departure to bound concurrent leaves.
	// Never consulted for operations targeting the departed room itself. Frozen
	// completed cleanup restores only this scope, not mutation scope, on restart.
	readonly #departedRoomReferences = new Set<string>();
	readonly #http: MatrixHttp;
	readonly #retry: Required<MatrixRetryOptions>;
	#sendRetryAt = 0;

	constructor(config: ManagedMatrixConfig, private readonly fetchImplementation: FetchLike = fetch, managedRoomIds: Iterable<string> = [], retry: ManagedMatrixRetryOptions = {}, departedRoomReferences: Iterable<string> = []) {
		const parsed = new URL(config.homeserver);
		if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("Matrix homeserver must be a credential-free HTTPS origin");
		if (!isMatrixUserId(config.botUserId) || !isMatrixUserId(config.operatorUserId) || (config.ignoredSenderUserIds ?? []).length > MAX_IGNORED_SENDERS ||
			(config.ignoredSenderUserIds ?? []).some((value) => !isMatrixUserId(value)) || new Set(config.ignoredSenderUserIds ?? []).size !== (config.ignoredSenderUserIds ?? []).length ||
			(config.ignoredSenderUserIds ?? []).includes(config.operatorUserId)) throw new Error("Managed Matrix sender identities are invalid");
		this.homeserver = parsed.toString().replace(/\/$/, ""); this.botUserId = config.botUserId; this.operatorUserId = config.operatorUserId;
		this.ignoredSenderUserIds = new Set([config.botUserId, ...(config.ignoredSenderUserIds ?? [])]);
		this.#accessToken = config.accessToken; this.#managedRoomIds = new Set(managedRoomIds);
		for (const roomId of departedRoomReferences) {
			this.reserveDepartureReference(roomId); this.#managedRoomIds.delete(roomId);
		}
		this.#http = new MatrixHttp(config, fetchImplementation, retry);
		this.#retry = this.#http.retry;
	}

	async sendAccountRequest(ownerUserId: string, ownerDeviceId: string, transactionId: string, action: AccountAction, signal: AbortSignal): Promise<void> {
		if (ownerUserId !== this.operatorUserId || !/^[A-Za-z0-9._:-]{1,128}$/.test(ownerDeviceId) || !/^pi-account-[a-f0-9-]{36}$/.test(transactionId)) throw Error("Invalid account request route");
		await this.request("PUT", `/_matrix/client/v3/sendToDevice/lol.bepis.pi.account.request.v1/${encodeURIComponent(transactionId)}`,
			{ messages: { [ownerUserId]: { [ownerDeviceId]: parseAccountAction(action) } } }, signal);
	}
	async whoami(signal?: AbortSignal): Promise<string> { return requiredString(await this.request("GET", "/_matrix/client/v3/account/whoami", undefined, signal), "user_id"); }
	async sync(since?: string, signal?: AbortSignal): Promise<{ nextBatch: string; response: unknown }> {
		const query = new URLSearchParams({ timeout: "30000" }); if (since) query.set("since", since);
		return this.#http.sync(query, signal);
	}
	/** Recover a complete bounded interval, never merely trust the tail of a limited sync. */
	async recoverSyncTimelines(response: unknown, since: string, nextBatch: string, roomIds: readonly string[], signal?: AbortSignal): Promise<unknown> {
		const result = structuredClone(response);
		const joined = (result as { rooms?: { join?: Record<string, { timeline?: { limited?: boolean; events?: unknown[] } }> } } | null)?.rooms?.join;
		if (!joined || typeof joined !== "object" || Array.isArray(joined)) return result;
		for (const roomId of roomIds) {
			const timeline = joined[roomId]?.timeline;
			if (!timeline || (timeline.limited !== true && !(Array.isArray(timeline.events) && timeline.events.length > 512))) continue;
			const events = await this.recoverRoomInterval(roomId, since, nextBatch, signal);
			// Keep the tail as a completeness check: a successful history response must
			// contain every sync event, including ignored bot/state events.
			const ids = new Set(events.map((event) => (event as JsonObject).event_id));
			if (!Array.isArray(timeline.events) || timeline.events.some((event) => !event || typeof event !== "object" || !ids.has((event as JsonObject).event_id))) {
				throw new ManagedMatrixError("invalid_response", "Matrix gap recovery did not cover the sync timeline; cursor preserved");
			}
			joined[roomId]!.timeline = { limited: false, events };
			if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_MATRIX_RESPONSE_BYTES) {
				throw new ManagedMatrixError("invalid_response", "Matrix recovered sync exceeds the response byte bound; cursor preserved");
			}
		}
		return result;
	}

	private async recoverRoomInterval(roomId: string, since: string, to: string, signal?: AbortSignal): Promise<unknown[]> {
		this.assertManagedRoom(roomId);
		const events: unknown[] = []; const ids = new Set<string>(); const tokens = new Set([since]);
		let bytes = 0;
		let from = since;
		// Matrix explicitly permits /sync next_batch for both from and to:
		// https://spec.matrix.org/v1.16/client-server-api/#get_matrixclientv3roomsroomidmessages
		// Forward pagination to a fixed boundary avoids chasing a moving head.
		for (let page = 0; page < 10; page += 1) {
			const query = new URLSearchParams({ from, to, dir: "f", limit: "100" });
			const value = await this.request("GET", `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages?${query}`, undefined, signal);
			if (!value || typeof value !== "object" || Array.isArray(value)) throw new ManagedMatrixError("invalid_response", "Matrix gap recovery response is malformed; cursor preserved");
			const chunk = (value as JsonObject).chunk; const end = (value as JsonObject).end;
			// Omitted end can also mean history is no longer visible to the bot.
			// Exhaustion alone is not proof that this interval is complete.
			if (end === undefined) throw new ManagedMatrixError("invalid_response", "Matrix gap recovery has no terminal boundary; operator recovery required, cursor preserved");
			if ((value as JsonObject).start !== from || !Array.isArray(chunk) || chunk.length > 100 ||
				typeof end !== "string" || !end || end.length > 4_096) {
				throw new ManagedMatrixError("invalid_response", "Matrix gap recovery page is malformed or oversized; cursor preserved");
			}
			for (const event of chunk) {
				if (!event || typeof event !== "object" || Array.isArray(event) || typeof event.event_id !== "string" || !event.event_id || event.event_id.length > 255 ||
					(event.room_id !== undefined && event.room_id !== roomId) || ids.has(event.event_id)) {
					throw new ManagedMatrixError("invalid_response", "Matrix gap recovery event is malformed, foreign, or repeated; cursor preserved");
				}
				bytes += Buffer.byteLength(JSON.stringify(event), "utf8");
				if (bytes > MAX_MATRIX_RESPONSE_BYTES) throw new ManagedMatrixError("invalid_response", "Matrix gap recovery exceeds the response byte bound; cursor preserved");
				ids.add(event.event_id); events.push(event);
			}
			if (events.length > 512) throw new ManagedMatrixError("invalid_response", "Matrix gap recovery exceeds 512 events; operator recovery required, cursor preserved");
			if (end === to) return events;
			if (tokens.has(end)) throw new ManagedMatrixError("invalid_response", "Matrix gap recovery pagination stalled; cursor preserved");
			tokens.add(end); from = end;
		}
		throw new ManagedMatrixError("invalid_response", "Matrix gap recovery exceeds 10 pages; operator recovery required, cursor preserved");
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
	async joinedMemberIds(roomId: string, signal?: AbortSignal): Promise<ReadonlySet<string>> {
		this.assertManagedRoom(roomId);
		const response = await this.request("GET", `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/joined_members`, undefined, signal);
		if (typeof response !== "object" || response === null || Array.isArray(response) || Object.keys(response).some((key) => key !== "joined")) {
			throw new ManagedMatrixError("invalid_response", "Matrix joined-members response is malformed");
		}
		const joined = (response as JsonObject).joined;
		if (typeof joined !== "object" || joined === null || Array.isArray(joined)) throw new ManagedMatrixError("invalid_response", "Matrix joined-members response is malformed");
		const entries = Object.entries(joined as JsonObject);
		if (entries.length > MAX_JOINED_MEMBERS || entries.some(([userId, profile]) => !isMatrixUserId(userId) || typeof profile !== "object" || profile === null || Array.isArray(profile))) {
			throw new ManagedMatrixError("invalid_response", "Matrix joined-members response is malformed or too large");
		}
		return new Set(entries.map(([userId]) => userId));
	}
	async eventSender(roomId: string, eventId: string, signal?: AbortSignal): Promise<string | undefined> {
		this.assertManagedRoom(roomId); const response = await this.request("GET", `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/event/${encodeURIComponent(eventId)}`, undefined, signal);
		return typeof response === "object" && response !== null && !Array.isArray(response) && typeof (response as JsonObject).sender === "string" ? String((response as JsonObject).sender) : undefined;
	}
	async downloadMedia(mxcUrl: string, signal?: AbortSignal): Promise<{ bytes: Buffer; mimeType?: string }> {
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
				// Matrix metadata is not a transport-integrity declaration. Fetch owns
				// HTTP framing/decompression errors; no harness inbound size policy.
				if (!response.body) throw new ManagedMatrixError("invalid_response", "Matrix media response had no body");
				const bytes = Buffer.from(await response.arrayBuffer());
				return { bytes, mimeType: response.headers.get("content-type") ?? undefined };
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
		if (!hasExpectedPollContent(content, pollKey, fallbackKey) || (stable ? !Array.isArray(content[fallbackKey]) : typeof content[fallbackKey] !== "string") ||
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
	/** New live-workspace objects carry their proof in the atomic create, not a later best-effort write. */
	async ensureManagedRoom(name: string, provenance: ManagedProvenance, signal?: AbortSignal, migrationAdmin = false): Promise<string> {
		const expected = structuredClone(parseManagedProvenance(provenance));
		const alias = managedRoomAlias(expected);
		const space = expected.kind.endsWith("_space");
		if (migrationAdmin && !["project_space", "worktree_space", "archive_root_space", "archive_project_space", "archive_worktree_space"].includes(expected.kind)) throw new Error("Admin creation policy requires a migration Space");
		let roomId = await this.lookupPrivateRoomAlias(alias, signal);
		try {
			if (!roomId) roomId = await this.createRoom(safeManagedTitle(name, alias), space, signal, alias, expected, migrationAdmin);
			this.#managedRoomIds.add(roomId);
			await this.assertManagedProvenance(roomId, expected, signal);
			return roomId;
		} catch (error) { if (roomId) this.#managedRoomIds.delete(roomId); throw error; }
	}

	/** Recovery after an uncertain create is read-only; absence is not proof that no room was created. */
	async recoverManagedAlias(provenance: ManagedProvenance, signal?: AbortSignal): Promise<string | undefined> {
		const expected = parseManagedProvenance(provenance);
		const roomId = await this.lookupPrivateRoomAlias(managedRoomAlias(expected), signal);
		if (roomId) await this.recoverManagedRoom(roomId, expected, signal);
		return roomId;
	}

	/** Read-only recovery from a saved host-owned ID; alias/name changes cannot retarget it. */
	async recoverManagedRoom(roomId: string, provenance: ManagedProvenance, signal?: AbortSignal): Promise<void> {
		if (!isMatrixRoomId(roomId)) throw new Error("Invalid saved managed room ID");
		this.#managedRoomIds.add(roomId);
		try { await this.assertManagedProvenance(roomId, provenance, signal); }
		catch (error) { this.#managedRoomIds.delete(roomId); throw error; }
	}

	/** Only new provisioning may invoke this additive legacy-host upgrade; never bootstrap. */
	async ensureLegacyHostProvenance(hostId: string, coordinator: ConversationManifest, signal?: AbortSignal): Promise<string> {
		if (coordinator.kind !== "coordinator" || coordinator.ownerHostId !== hostId || coordinator.creationKey !== "coordinator" ||
			coordinator.conversationId !== deriveConversationId(hostId, "coordinator") || !coordinator.hostSpace) {
			throw new ManagedMatrixError("invalid_response", "Legacy host Space lacks its saved coordinator binding");
		}
		const roomId = coordinator.hostSpace;
		const expected = parseManagedProvenance({ version: 1, hostId, kind: "host_space", creationKey: "host" });
		const events = await this.privateManagedState(roomId, true, signal);
		const proofs = events.filter((event) => event.type === MANAGED_PROVENANCE_EVENT && event.state_key === "");
		if (proofs.length) {
			this.assertProof(events, expected);
			return roomId;
		}
		// State PUT has no CAS. Do not blindly retry an uncertain write: the next
		// provisioning attempt must read and verify the current proof again.
		if (this.#http.retry.maxAttempts !== 1) throw new Error("Legacy ownership stamping requires one-attempt transport");
		await this.request("PUT", `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/${MANAGED_PROVENANCE_EVENT}/`, expected, signal);
		await this.assertManagedProvenance(roomId, expected, signal);
		return roomId;
	}

	/** Explicit reconciliation only: a saved legacy identity may receive an absent proof,
	 * but an existing proof is never overwritten, even when authored by this bot. */
	async inspectLegacyRoom(roomId: string, space: boolean, signal?: AbortSignal): Promise<ManagedProvenance | undefined> {
		const events = await this.privateManagedState(roomId, space, signal);
		const proofs = events.filter(event => event.type === MANAGED_PROVENANCE_EVENT && event.state_key === "");
		if (!proofs.length) return undefined;
		const proof = parseManagedProvenance(proofs[0]!.content); this.assertProof(events, proof); return structuredClone(proof);
	}
	async inspectLegacyProvenance(roomId: string, provenance: ManagedProvenance, signal?: AbortSignal): Promise<boolean> {
		const expected = parseManagedProvenance(provenance);
		const events = await this.privateManagedState(roomId, expected.kind.endsWith("_space"), signal);
		if (!events.some(event => event.type === MANAGED_PROVENANCE_EVENT && event.state_key === "")) return false;
		this.assertProof(events, expected); return true;
	}
	async ensureLegacyProvenance(roomId: string, provenance: ManagedProvenance, signal?: AbortSignal): Promise<void> {
		const expected = structuredClone(parseManagedProvenance(provenance));
		if (await this.inspectLegacyProvenance(roomId, expected, signal)) return;
		if (this.#http.retry.maxAttempts !== 1) throw new Error("Legacy ownership stamping requires one-attempt transport");
		signal?.throwIfAborted();
		await this.request("PUT", `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/${MANAGED_PROVENANCE_EVENT}/`, expected, signal);
		await this.recoverManagedRoom(roomId, expected, signal);
	}

	/** Saved room IDs remain authoritative when mutable aliases or names change. */
	async assertManagedProvenance(roomId: string, provenance: ManagedProvenance, signal?: AbortSignal): Promise<void> {
		const expected = parseManagedProvenance(provenance);
		this.assertProof(await this.privateManagedState(roomId, expected.kind.endsWith("_space"), signal), expected);
	}
	private assertProof(events: JsonObject[], expected: ManagedProvenance): void {
		const proofs = events.filter((event) => event.type === MANAGED_PROVENANCE_EVENT && event.state_key === "");
		if (proofs.length !== 1 || proofs[0]!.sender !== this.botUserId || !isDeepStrictEqual(proofs[0]!.content, expected)) {
			throw new ManagedMatrixError("invalid_response", "Managed room proof is foreign, contradictory, or encrypted");
		}
	}
	private async privateManagedState(roomId: string, space: boolean, signal?: AbortSignal): Promise<JsonObject[]> {
		await this.assertRoomAuthority(roomId, space, signal, { spaceChild: space, management: true });
		const state = await this.request("GET", `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state`, undefined, signal);
		if (!Array.isArray(state) || state.length > 4096) throw new ManagedMatrixError("invalid_response", "Managed room state is unavailable or oversized");
		const events = state.filter((event): event is JsonObject => typeof event === "object" && event !== null && !Array.isArray(event));
		const creates = events.filter((event) => event.type === "m.room.create" && event.state_key === "");
		const joins = events.filter((event) => event.type === "m.room.join_rules" && event.state_key === "");
		const creation = creates[0]?.content as JsonObject | undefined;
		const joinRules = joins[0]?.content as JsonObject | undefined;
		if (joins.length !== 1 || joinRules?.join_rule !== "invite" || creation?.["m.federate"] !== false || events.length !== state.length || events.some((event) => event.type === "m.room.encryption") ||
			creates.length !== 1 || creates[0]!.sender !== this.botUserId) {
			throw new ManagedMatrixError("invalid_response", "Managed room proof is foreign, contradictory, or encrypted");
		}
		return events;
	}

	async assertOperatorSpaceAdmin(roomId: string, signal?: AbortSignal): Promise<void> {
		const snapshot = await this.operatorAdminSnapshot({ roomId, space: true }, signal);
		if (snapshot.change) throw new ManagedMatrixError("invalid_response", "Migration Space lacks operator admin; use a separately approved admin migration");
	}

	private async migrationSpacePower(signal?: AbortSignal): Promise<JsonObject> {
		const response = await this.request("GET", "/_matrix/client/v3/capabilities", undefined, signal);
		const capabilities = (response as JsonObject)?.capabilities as JsonObject | undefined;
		const versions = capabilities?.["m.room_versions"] as JsonObject | undefined;
		const available = versions?.available as JsonObject | undefined;
		const preferred = versions?.default;
		const version = typeof preferred === "string" && /^(?:[1-9]|10|11|12)$/.test(preferred) && available?.[preferred] === "stable"
			? preferred : available?.["10"] === "stable" ? "10" : undefined;
		if (!version || this.operatorUserId === this.botUserId) throw new ManagedMatrixError("invalid_response", "No supported stable room version for migration Space admin policy");
		return { room_version: version, power_level_content_override: { users: {
			...(version === "12" ? {} : { [this.botUserId]: 100 }), [this.operatorUserId]: 100,
		} } };
	}

	private async createRoom(name: string, space: boolean, signal?: AbortSignal, aliasLocalpart?: string, provenance?: ManagedProvenance, migrationAdmin = false): Promise<string> {
		if (aliasLocalpart !== undefined && !/^[a-z0-9._=-]{1,128}$/.test(aliasLocalpart)) throw new Error("Matrix room alias localpart is malformed");
		const creationPolicy = migrationAdmin ? await this.migrationSpacePower(signal) : {};
		let roomId: string;
		try {
			const response = await this.request("POST", "/_matrix/client/v3/createRoom", { ...creationPolicy, visibility: "private", preset: "private_chat", name,
				invite: [this.operatorUserId], is_direct: false, ...(aliasLocalpart ? { room_alias_name: aliasLocalpart } : {}),
				...(provenance ? { initial_state: [{ type: MANAGED_PROVENANCE_EVENT, state_key: "", content: provenance }] } : {}),
				creation_content: { ...(space ? { type: "m.space" } : {}), "m.federate": false } }, signal);
			roomId = requiredString(response, "room_id");
		} catch (error) {
			if (!aliasLocalpart || !(error instanceof ManagedMatrixError) || !(error.code === "network" || [400, 409].includes(error.status ?? 0))) throw error;
			const server = this.botUserId.slice(this.botUserId.indexOf(":") + 1);
			if (!server || server === this.botUserId) throw new ManagedMatrixError("invalid_response", "Matrix bot ID omitted its server name");
			const resolved = await this.request("GET", `/_matrix/client/v3/directory/room/${encodeURIComponent(`#${aliasLocalpart}:${server}`)}`, undefined, signal);
			roomId = requiredString(resolved, "room_id");
		}
		if (!isMatrixRoomId(roomId)) throw new ManagedMatrixError("invalid_response", "Matrix response returned a malformed room ID");
		this.#managedRoomIds.add(roomId);
		if (aliasLocalpart) {
			const createEvent = await this.request("GET", `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.create/`, undefined, signal);
			if (typeof createEvent !== "object" || createEvent === null || Array.isArray(createEvent) ||
				((createEvent as JsonObject).creator !== undefined && (createEvent as JsonObject).creator !== this.botUserId) || !await this.memberJoined(roomId, this.botUserId, signal) ||
				(space && (createEvent as JsonObject).type !== "m.space") || (!space && (createEvent as JsonObject).type === "m.space")) {
				this.#managedRoomIds.delete(roomId); throw new ManagedMatrixError("invalid_response", "Matrix idempotent room identity was not bot-owned");
			}
			const creation = createEvent as JsonObject;
			// Through v10 the immutable create content names its creator. From v11
			// onward only the full create event's sender proves this identity.
			const legacyCreator = creation.creator === this.botUserId && (creation.room_version === undefined ||
				(typeof creation.room_version === "string" && /^(?:[1-9]|10)$/.test(creation.room_version)));
			if (!legacyCreator) {
				try { await this.assertCreateSender(roomId, creation, signal); }
				catch (error) { this.#managedRoomIds.delete(roomId); throw error; }
			}
		}
		return roomId;
	}
	private async lookupPrivateRoomAlias(aliasLocalpart: string, signal?: AbortSignal): Promise<string | undefined> {
		if (!/^[a-z0-9._=-]{1,128}$/.test(aliasLocalpart)) throw new Error("Matrix room alias localpart is malformed");
		const server = this.botUserId.slice(this.botUserId.indexOf(":") + 1);
		if (!server || server === this.botUserId) throw new ManagedMatrixError("invalid_response", "Matrix bot ID omitted its server name");
		let roomId: string;
		try { roomId = requiredString(await this.request("GET", `/_matrix/client/v3/directory/room/${encodeURIComponent(`#${aliasLocalpart}:${server}`)}`, undefined, signal), "room_id"); }
		catch (error) { if (error instanceof ManagedMatrixError && error.status === 404) return undefined; throw error; }
		if (!isMatrixRoomId(roomId)) throw new ManagedMatrixError("invalid_response", "Matrix alias returned a malformed room ID");
		return roomId;
	}
	async resolvePrivateRoomAlias(aliasLocalpart: string, space: boolean, signal?: AbortSignal): Promise<string | undefined> {
		const roomId = await this.lookupPrivateRoomAlias(aliasLocalpart, signal);
		if (!roomId) return undefined;
		this.#managedRoomIds.add(roomId);
		try { await this.assertRoomAuthority(roomId, space, signal); } catch (error) { this.#managedRoomIds.delete(roomId); throw error; }
		return roomId;
	}
	/** Read-only recovery probe for the pre-host-scoping alias, never a permission bypass for a saved target. */
	async resolveLegacyProjectSpace(projectKey: string, signal?: AbortSignal): Promise<string | undefined> {
		if (!/^project_[a-f0-9]{32}$/.test(projectKey)) throw new Error("Project identity is malformed");
		const roomId = await this.lookupPrivateRoomAlias(`pi-${projectKey.slice("project_".length)}-space`, signal);
		if (!roomId) return undefined;
		let create: unknown;
		try { create = await this.request("GET", `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.create/`, undefined, signal); }
		catch (error) {
			// Only this unbound legacy-room read may encounter another host's private
			// Space. Directory/auth/network failures and bound-target failures propagate.
			if (error instanceof ManagedMatrixError && error.status === 403) return undefined;
			throw error;
		}
		if (typeof create !== "object" || create === null || Array.isArray(create) || (create as JsonObject).type !== "m.space") {
			throw new ManagedMatrixError("invalid_response", "Legacy project alias is not a Matrix Space");
		}
		if ((create as JsonObject).creator !== undefined && (create as JsonObject).creator !== this.botUserId) return undefined;
		if ((create as JsonObject).creator === undefined || ["11", "12"].includes(String((create as JsonObject).room_version))) {
			try { await this.assertCreateSender(roomId, create as JsonObject, signal); }
			catch (error) { if (error instanceof ForeignMatrixOwnerError) return undefined; throw error; }
		}
		this.#managedRoomIds.add(roomId);
		try { await this.assertRoomAuthority(roomId, true, signal, { spaceChild: true }); }
		catch (error) { this.#managedRoomIds.delete(roomId); if (error instanceof ForeignMatrixOwnerError) return undefined; throw error; }
		return roomId;
	}
	private async assertCreateSender(roomId: string, creation: JsonObject, signal?: AbortSignal): Promise<void> {
		let creates: JsonObject[];
		if (creation.room_version === "12") {
			const eventId = `$${roomId.slice(1)}`;
			const event = await this.request("GET", `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/event/${encodeURIComponent(eventId)}`, undefined, signal);
			if (!isMatrixRoomId(roomId) || roomId.includes(":") || !event || typeof event !== "object" || Array.isArray(event) ||
				(event as JsonObject).event_id !== eventId || (event as JsonObject).room_id !== roomId) {
				throw new ManagedMatrixError("invalid_response", "Matrix v12 create event does not prove bot ownership");
			}
			creates = [event as JsonObject];
		} else {
			const state = await this.request("GET", `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state`, undefined, signal);
			creates = Array.isArray(state) && state.length <= 4096 ? state.filter(event => event?.type === "m.room.create" && event?.state_key === "") : [];
		}
		const event = creates[0]!;
		if (creates.length === 1 && typeof event.sender === "string" && event.sender !== this.botUserId &&
			isSoleRoomCreator(event, event.sender) && isDeepStrictEqual(event.content, creation)) throw new ForeignMatrixOwnerError();
		if (creates.length !== 1 || !isSoleRoomCreator(event, this.botUserId) || !isDeepStrictEqual(event.content, creation)) {
			throw new ManagedMatrixError("invalid_response", "Matrix room has foreign or ambiguous creators");
		}
	}
	async assertRoomAuthority(roomId: string, space: boolean, signal?: AbortSignal, required: { spaceChild?: boolean; kick?: boolean; management?: boolean } = {}): Promise<void> {
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
		// v12 creators have immutable infinite power and must not appear in users.
		// Prove the original create sender, not merely a claimed co-creator or PL.
		const creation = create as JsonObject;
		if (creation.room_version !== undefined && (typeof creation.room_version !== "string" || !/^(?:[1-9]|1[0-2])$/.test(creation.room_version))) {
			throw new ManagedMatrixError("invalid_response", "Matrix room version authority is unsupported");
		}
		const creatorPower = creation.room_version === "12";
		if (creatorPower || creation.room_version === "11" || creation.creator === undefined) await this.assertCreateSender(roomId, creation, signal);
		const bot = creatorPower ? Infinity : Number(users[this.botUserId] ?? value.users_default ?? 0); const stateDefault = Number(value.state_default ?? 50);
		const thresholds = [stateDefault, ...(required.management ? [Number(events[MANAGED_PROVENANCE_EVENT] ?? stateDefault)] : []), ...(required.spaceChild ? [Number(events["m.space.child"] ?? stateDefault)] : []), ...(required.kick ? [Number(value.kick ?? 50)] : [])];
		if ((!creatorPower && !Number.isFinite(bot)) || thresholds.some((threshold) => !Number.isFinite(threshold) || bot < threshold)) {
			throw new ManagedMatrixError("invalid_response", "Matrix bot lacks authority over required room operations");
		}
	}
	async operatorAdminSnapshot(target: AdminRoom, signal?: AbortSignal): Promise<AdminPowerSnapshot> {
		await this.assertRoomAuthority(target.roomId, target.space, signal);
		const base = `/_matrix/client/v3/rooms/${encodeURIComponent(target.roomId)}/state/`;
		const creation = await this.request("GET", `${base}m.room.create/`, undefined, signal) as JsonObject;
		const powers = await this.request("GET", `${base}m.room.power_levels/`, undefined, signal);
		const member = await this.request("GET", `${base}m.room.member/${encodeURIComponent(this.operatorUserId)}`, undefined, signal) as JsonObject;
		if (!member || !["join", "invite"].includes(String(member.membership))) throw new HostControlError("conflict", "Operator is neither joined nor invited; admin migration will not restore membership");
		return { ...planOperatorAdmin({ ...target, operatorUserId: this.operatorUserId, botUserId: this.botUserId, creation, powers }),
			operatorMembership: member.membership as "join" | "invite" };
	}
	async applyOperatorAdmin(snapshot: AdminPowerSnapshot, revalidateScope?: () => void): Promise<void> {
		if (this.#http.retry.maxAttempts !== 1) throw new HostControlError("unavailable", "Admin migration requires one-attempt Matrix transport");
		const fresh = await this.operatorAdminSnapshot(snapshot);
		if (!isDeepStrictEqual(fresh, snapshot)) throw new HostControlError("stale_preview", "Room power state changed; obtain a new admin preview and consent");
		if (!snapshot.change) return;
		revalidateScope?.();
		// Matrix has no conditional state PUT. Do not retry an uncertain response.
		await this.request("PUT", `/_matrix/client/v3/rooms/${encodeURIComponent(snapshot.roomId)}/state/m.room.power_levels/`, snapshot.proposed);
		const readback = await this.operatorAdminSnapshot(snapshot);
		if (readback.change || !isDeepStrictEqual(readback.powers, snapshot.proposed) || readback.operatorMembership !== snapshot.operatorMembership)
			throw new HostControlError("conflict", "Admin update readback changed or is uncertain; inspect with a new preview, never blindly retry");
	}

	async addSpaceChild(spaceId: string, roomId: string, signal?: AbortSignal): Promise<void> {
		this.assertManagedRoom(spaceId); this.assertManagedRoom(roomId);
		// Room IDs are opaque (v12 has no server suffix). The owning bot's server
		// participates in these verified rooms and supplies a usable routing hint.
		const roomServer = this.botUserId.slice(this.botUserId.indexOf(":") + 1);
		await this.request("PUT", `/_matrix/client/v3/rooms/${encodeURIComponent(spaceId)}/state/m.space.child/${encodeURIComponent(roomId)}`, { via: [roomServer], suggested: true }, signal);
	}
	async removeSpaceChild(spaceId: string, roomId: string, signal?: AbortSignal): Promise<void> {
		this.assertManagedRoom(spaceId);
		if (!this.#departedRoomReferences.has(roomId)) this.assertManagedRoom(roomId);
		await this.request("PUT", `/_matrix/client/v3/rooms/${encodeURIComponent(spaceId)}/state/m.space.child/${encodeURIComponent(roomId)}`, {}, signal);
	}
	/** Exact state-key snapshot for conservative archive unlink checks. No mutation/adoption. */
	async spaceChildContent(spaceId: string, roomId: string, signal?: AbortSignal): Promise<JsonObject | null> {
		this.assertManagedRoom(spaceId);
		if (!isMatrixRoomId(roomId)) throw Error("Invalid Space child identity");
		const state = await this.request("GET", `/_matrix/client/v3/rooms/${encodeURIComponent(spaceId)}/state`, undefined, signal);
		if (!Array.isArray(state) || state.length > 4096 || state.some(event => !event || typeof event !== "object" || Array.isArray(event) || typeof event.type !== "string" || typeof event.state_key !== "string")) throw Error("Invalid Space state snapshot");
		const matches = state.filter(event => event && typeof event === "object" && event.type === "m.space.child" && event.state_key === roomId);
		if (!matches.length) return null; // Only a successful full-state read establishes absence.
		if (matches.length !== 1) throw Error("Ambiguous Space child state");
		const value = matches[0].content;
		if (typeof value !== "object" || value === null || Array.isArray(value) || Buffer.byteLength(JSON.stringify(value)) > 16384) throw Error("Invalid or oversized Space child state");
		return value as JsonObject;
	}
	async spaceChildren(spaceId: string, signal?: AbortSignal): Promise<string[]> {
		this.assertManagedRoom(spaceId); const state = await this.request("GET", `/_matrix/client/v3/rooms/${encodeURIComponent(spaceId)}/state`, undefined, signal);
		if (!Array.isArray(state) || state.length > 4_096) throw new ManagedMatrixError("invalid_response", "Matrix Space state is malformed or too large");
		const children: string[] = [];
		for (const event of state) {
			if (typeof event !== "object" || event === null || Array.isArray(event)) throw new ManagedMatrixError("invalid_response", "Matrix Space state is malformed");
			const value = event as JsonObject; if (value.type !== "m.space.child") continue;
			if (!isMatrixRoomId(value.state_key) || typeof value.content !== "object" || value.content === null || Array.isArray(value.content)) {
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
	async conversationName(roomId: string, signal?: AbortSignal): Promise<import("./conversation-titles.js").MatrixNameEvent | undefined> {
		this.assertManagedRoom(roomId);
		const state = await this.request("GET", `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state`, undefined, signal);
		if (!Array.isArray(state) || state.length > 4096) throw new ManagedMatrixError("invalid_response", "Room name state is unavailable");
		const names = state.filter(event => event?.type === "m.room.name" && event?.state_key === "");
		if (names.length > 1) throw new ManagedMatrixError("invalid_response", "Room name state is ambiguous");
		return names[0];
	}
	async setConversationName(roomId: string, name: string, writeId: string, signal?: AbortSignal): Promise<string> {
		this.assertManagedRoom(roomId);
		if (this.#http.retry.maxAttempts !== 1) throw new Error("Name reconciliation requires one-attempt transport");
		const result = await this.request("PUT", `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.name/`, { name, "lol.bepis.pi.presentation.v1": writeId,
			"lol.bepis.pi.notification": { version: 1, disposition: "silent" }, "m.mentions": {} }, signal);
		if (!result || typeof result !== "object" || typeof (result as JsonObject).event_id !== "string") throw new ManagedMatrixError("invalid_response", "Room name acknowledgement is unavailable");
		return (result as JsonObject).event_id as string;
	}
	async setRoomName(roomId: string, name: string, signal?: AbortSignal): Promise<void> { this.assertManagedRoom(roomId); await this.request("PUT", `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.name/`, { name }, signal); }
	async sendText(roomId: string, transactionId: string, body: string, formattedBody?: string, signal?: AbortSignal,
		disposition?: "silent" | "notify"): Promise<string> {
		this.assertManagedRoom(roomId); const content: JsonObject = { msgtype: "m.text", body: boundedText(body, "message body") };
		if (disposition) {
			content["lol.bepis.pi.notification"] = { version: 1, disposition };
			content["m.mentions"] = disposition === "notify" ? { room: true } : {};
		}
		if (formattedBody !== undefined) { content.format = "org.matrix.custom.html"; content.formatted_body = boundedText(formattedBody, "formatted message body", MAX_MESSAGE_BODY_LENGTH * 2); }
		return this.sendEvent(roomId, "m.room.message", transactionId, content, signal);
	}
	async sendNotice(roomId: string, transactionId: string, body: string, signal?: AbortSignal, disposition?: "silent"): Promise<string> {
		return this.sendEvent(roomId, "m.room.message", transactionId, { msgtype: "m.notice", body: boundedText(body, "notice body"),
			...(disposition ? { "lol.bepis.pi.notification": { version: 1, disposition }, "m.mentions": {} } : {}) }, signal);
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
	async startPoll(roomId: string, transactionId: string, question: string, answers: readonly MatrixPollAnswer[], signal?: AbortSignal, dialect: "stable" | "unstable" = "unstable", disposition?: "silent" | "notify"): Promise<string> {
		if (answers.length < 1 || answers.length > MAX_POLL_ANSWERS || new Set(answers.map((answer) => answer.id)).size !== answers.length) throw new Error("Poll answers are malformed or out of bounds");
		const text = boundedText(question, "poll question", 4_096);
		const normalized = answers.map((answer) => ({ id: boundedText(answer.id, "poll answer ID", 255), text: boundedText(answer.text, "poll answer", 1_024) }));
		const fallback = boundedText([text, ...normalized.map((answer, index) => `${index + 1}. ${answer.text}`)].join("\n"), "poll fallback");
		if (dialect === "stable") return this.sendEvent(roomId, "m.poll.start", transactionId, {
			"m.mentions": disposition === "silent" ? {} : { room: true },
			...(disposition ? { "lol.bepis.pi.notification": { version: 1, disposition } } : {}),
			"m.text": [{ mimetype: "text/plain", body: fallback }],
			"m.poll": {
				kind: "m.disclosed", max_selections: 1, question: { "m.text": [{ body: text }] },
				answers: normalized.map((answer) => ({ "m.id": answer.id, "m.text": [{ body: answer.text }] })),
			},
		}, signal);
		return this.sendEvent(roomId, "org.matrix.msc3381.poll.start", transactionId, {
			"m.mentions": disposition === "silent" ? {} : { room: true },
			...(disposition ? { "lol.bepis.pi.notification": { version: 1, disposition } } : {}),
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
	/** Authenticated self-membership observation, including after a lost leave response.
	 * Returned room IDs never become discovery or mutation targets. */
	async accountJoined(roomId: string, signal?: AbortSignal): Promise<boolean> {
		if (!isMatrixRoomId(roomId)) throw new ManagedMatrixError("invalid_response", "Invalid self membership target");
		const result = await this.request("GET", "/_matrix/client/v3/joined_rooms", undefined, signal);
		const rooms = result && typeof result === "object" && !Array.isArray(result) ? (result as JsonObject).joined_rooms : undefined;
		if (!Array.isArray(rooms) || rooms.length > 16384 || rooms.some((id) => !isMatrixRoomId(id)) || new Set(rooms).size !== rooms.length)
			throw new ManagedMatrixError("invalid_response", "Matrix self membership is unavailable or oversized");
		const joined = rooms.includes(roomId);
		if (!joined && this.#managedRoomIds.has(roomId)) {
			// Recover an acknowledged or lost-response departure whose durable
			// effect was not yet marked done. Negative observation never grants
			// scope for unrelated rooms, and revocation precedes capacity failure.
			this.#managedRoomIds.delete(roomId);
			this.reserveDepartureReference(roomId);
		}
		return joined;
	}
	async operatorMembershipEvent(roomId: string, signal?: AbortSignal): Promise<{ eventId: string; sender: string; membership: string }> {
		this.assertManagedRoom(roomId);
		const state = await this.request("GET", `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state`, undefined, signal);
		if (!Array.isArray(state)) throw Error("Membership proof unavailable");
		const events = state.filter(e => e && e.type === "m.room.member" && e.state_key === this.operatorUserId);
		const event = events[0];
		if (events.length !== 1 || typeof event.event_id !== "string" || !/^\$\S{1,254}$/.test(event.event_id) || typeof event.sender !== "string" || typeof event.content?.membership !== "string") throw Error("Membership proof unavailable");
		return { eventId: event.event_id, sender: event.sender, membership: event.content.membership };
	}
	async inviteOperator(roomId: string, signal?: AbortSignal): Promise<void> {
		this.assertManagedRoom(roomId); await this.request("POST", `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/invite`, { user_id: this.operatorUserId }, signal);
	}
	async leaveRoom(roomId: string, signal?: AbortSignal): Promise<void> {
		this.assertManagedRoom(roomId);
		// Reserve before awaiting I/O. Failure retains only an already-known
		// reference; it does not revoke the pre-existing mutation scope.
		this.reserveDepartureReference(roomId);
		await this.request("POST", `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/leave`, {}, signal);
		this.#managedRoomIds.delete(roomId);
	}
	private reserveDepartureReference(roomId: string): void {
		if (this.#departedRoomReferences.size >= 16_384 && !this.#departedRoomReferences.has(roomId)) {
			throw new ManagedMatrixError("invalid_response", "Departed room reference capacity reached; restart to recover frozen cleanup");
		}
		this.#departedRoomReferences.add(roomId);
	}
	private assertManagedRoom(roomId: string): void { if (!this.#managedRoomIds.has(roomId)) throw new ManagedMatrixError("invalid_response", "Matrix room is not owned by this relay"); }
	private parseMxc(value: string): { serverName: string; mediaId: string } {
		let parsed: URL; try { parsed = new URL(value); } catch { throw new ManagedMatrixError("invalid_response", "Matrix content URI is malformed"); }
		const mediaId = parsed.pathname.slice(1);
		if (parsed.protocol !== "mxc:" || !parsed.host || !mediaId || mediaId.includes("/") || parsed.username || parsed.password || parsed.search || parsed.hash) throw new ManagedMatrixError("invalid_response", "Matrix content URI is malformed");
		return { serverName: parsed.host, mediaId };
	}

	private async request(method: string, path: string, body?: JsonObject, signal?: AbortSignal): Promise<unknown> {
		const scheduled = this.#retry.maxAttempts === 1;
		const eventSend = method === "PUT" && path.includes("/send/");
		if (scheduled && eventSend && this.#sendRetryAt > Date.now()) throw new ManagedMatrixError("http", "Matrix event sending is cooling down", 429, true, this.#sendRetryAt - Date.now());
		const bounded = scheduled ? AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(10_000)]) : signal;
		try { return await this.#http.request(method, path, body, bounded); }
		catch (error) {
			if (scheduled && eventSend && error instanceof ManagedMatrixError && error.status === 429) this.#sendRetryAt = Math.max(this.#sendRetryAt, Date.now() + Math.max(1_000, error.retryAfterMs ?? 5_000));
			if (scheduled && !signal?.aborted && bounded?.aborted) throw new ManagedMatrixError("network", "Matrix request deadline exceeded", undefined, true);
			throw error;
		}
	}
}
