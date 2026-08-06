import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	MatrixClient,
	MatrixHttpError,
	matrixConfigFromEnvironment,
	routeMatrixTextEvent,
	type MatrixConfig,
} from "../config/agent/extensions/remote-session/matrix-client.js";
import {
	MAX_CHECKPOINT_BODY_LENGTH,
	createRemoteCheckpoint,
	renderRemoteCheckpoint,
	restoreCheckpointBoundaries,
	validateRemoteCheckpoint,
} from "../config/agent/extensions/remote-session/checkpoint.js";
import remoteSessionExtension, {
	mapRunAnswers,
	recoverInboundTurn,
	restoreRoomBinding,
} from "../config/agent/extensions/remote-session/index.js";
import {
	RemoteSessionStateStore,
	stateRootForSessionDirectory,
} from "../config/agent/extensions/remote-session/state-store.js";

const config: MatrixConfig = {
	homeserver: "https://matrix.example.com",
	accessToken: "secret-access-token",
	botUserId: "@pi-grill:example.com",
	operatorUserId: "@beau:example.com",
	hostName: "grill",
};

function jsonResponse(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json" },
	});
}

test("environment configuration requires the token without echoing its value", () => {
	assert.throws(
		() => matrixConfigFromEnvironment({ PI_MATRIX_ACCESS_TOKEN: "top-secret" }),
		(error: unknown) => error instanceof Error && !error.message.includes("top-secret"),
	);
});

test("environment configuration rejects plaintext Matrix transport", () => {
	assert.throws(
		() =>
			matrixConfigFromEnvironment({
				PI_MATRIX_HOMESERVER: "http://matrix.example.com",
				PI_MATRIX_ACCESS_TOKEN: "secret-access-token",
				PI_MATRIX_BOT_USER_ID: config.botUserId,
				PI_MATRIX_OPERATOR_USER_ID: config.operatorUserId,
				PI_MATRIX_HOSTNAME: config.hostName,
			}),
		/PI_MATRIX_HOMESERVER must use HTTPS/,
	);
});

test("authenticates with a bearer token and returns the bot user id", async () => {
	let authorization: string | null = null;
	const client = new MatrixClient(config, async (input, init) => {
		authorization = new Headers(init?.headers).get("authorization");
		assert.equal(new URL(input.toString()).pathname, "/_matrix/client/v3/account/whoami");
		return jsonResponse({ user_id: config.botUserId });
	});

	assert.equal(await client.authenticatedUserId(), config.botUserId);
	assert.equal(authorization, `Bearer ${config.accessToken}`);
});

test("creates a private joined-history room and invites only the operator", async () => {
	let requestBody: Record<string, unknown> | undefined;
	const client = new MatrixClient(config, async (input, init) => {
		assert.equal(new URL(input.toString()).pathname, "/_matrix/client/v3/createRoom");
		assert.equal(init?.method, "POST");
		requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
		return jsonResponse({ room_id: "!room:example.com" });
	});

	assert.equal(await client.createPrivateRoom("matrix spike"), "!room:example.com");
	assert.equal(requestBody?.visibility, "private");
	assert.equal(requestBody?.preset, "private_chat");
	assert.deepEqual(requestBody?.invite, [config.operatorUserId]);
	assert.deepEqual(requestBody?.creation_content, { "m.federate": false });
	assert.deepEqual(requestBody?.initial_state, [
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
	]);
});

test("sync is restricted to the bound room and extracts text events", async () => {
	const roomId = "!room:example.com";
	const client = new MatrixClient(config, async (input) => {
		const url = new URL(input.toString());
		assert.equal(url.pathname, "/_matrix/client/v3/sync");
		assert.equal(url.searchParams.get("since"), "cursor-1");
		const filter = JSON.parse(String(url.searchParams.get("filter"))) as {
			room: { rooms: string[]; timeline: { types: string[] } };
		};
		assert.deepEqual(filter.room.rooms, [roomId]);
		assert.deepEqual(filter.room.timeline.types, ["m.room.message"]);
		return jsonResponse({
			next_batch: "cursor-2",
			rooms: {
				join: {
					[roomId]: {
						timeline: {
							events: [
								{
									type: "m.room.message",
									event_id: "$event",
									sender: config.operatorUserId,
									content: { msgtype: "m.text", body: "@grill hello" },
								},
								{
									type: "m.room.message",
									event_id: "$reply",
									sender: config.operatorUserId,
									content: {
										msgtype: "m.text",
										body: "yes",
										"m.relates_to": { "m.in_reply_to": { event_id: "$bot-answer" } },
									},
								},
								{
									type: "m.room.message",
									event_id: "$thread",
									sender: config.operatorUserId,
									content: { msgtype: "m.text", body: "ignored", "m.relates_to": { rel_type: "m.thread" } },
								},
								{
									type: "m.room.message",
									event_id: "$edit",
									sender: config.operatorUserId,
									content: { msgtype: "m.text", body: "ignored", "m.relates_to": { rel_type: "m.replace" } },
								},
								{
									type: "m.room.message",
									event_id: "$image",
									sender: config.operatorUserId,
									content: { msgtype: "m.image", body: "ignored" },
								},
							],
						},
					},
				},
			},
		});
	});

	assert.deepEqual(await client.syncRoom(roomId, "cursor-1"), {
		nextBatch: "cursor-2",
		events: [
			{ roomId, eventId: "$event", sender: config.operatorUserId, body: "@grill hello", replyToEventId: undefined },
			{ roomId, eventId: "$reply", sender: config.operatorUserId, body: "yes", replyToEventId: "$bot-answer" },
		],
	});
});

test("reply target verification reads the event sender from the bound room", async () => {
	const client = new MatrixClient(config, async (input) => {
		assert.equal(
			new URL(input.toString()).pathname,
			"/_matrix/client/v3/rooms/!room%3Aexample.com/event/%24bot-answer",
		);
		return jsonResponse({ event_id: "$bot-answer", sender: config.botUserId });
	});
	assert.equal(await client.eventSender("!room:example.com", "$bot-answer"), config.botUserId);
});

test("routing rejects the wrong room, sender, and host prefix", () => {
	const binding = { roomId: "!bound:example.com" };
	const baseEvent = {
		roomId: binding.roomId,
		eventId: "$event",
		sender: config.operatorUserId,
		body: "@grill investigate this",
	};

	assert.deepEqual(routeMatrixTextEvent(baseEvent, binding, config), { kind: "prompt", text: "investigate this" });
	assert.equal(routeMatrixTextEvent({ ...baseEvent, roomId: "!other:example.com" }, binding, config), undefined);
	assert.equal(routeMatrixTextEvent({ ...baseEvent, sender: "@mallory:example.com" }, binding, config), undefined);
	assert.equal(
		routeMatrixTextEvent({ ...baseEvent, sender: "@mallory:example.com", body: "@grill !abort" }, binding, config),
		undefined,
	);
	assert.equal(
		routeMatrixTextEvent({ ...baseEvent, roomId: "!other:example.com", body: "@grill !steer attack" }, binding, config),
		undefined,
	);
	assert.equal(routeMatrixTextEvent({ ...baseEvent, body: "@t480 investigate this" }, binding, config), undefined);
	assert.equal(routeMatrixTextEvent({ ...baseEvent, body: "unaddressed" }, binding, config), undefined);
	assert.deepEqual(routeMatrixTextEvent({ ...baseEvent, body: "@grill !steer redirect" }, binding, config), {
		kind: "steer",
		text: "redirect",
	});
	assert.deepEqual(routeMatrixTextEvent({ ...baseEvent, body: "@grill !abort" }, binding, config), {
		kind: "abort",
		text: "",
	});
	assert.deepEqual(
		routeMatrixTextEvent(
			{ ...baseEvent, body: "> <@pi-grill:example.com> old answer\n\nyes", replyToEventId: "$bot-answer" },
			binding,
			config,
			config.botUserId,
		),
		{ kind: "prompt", text: "yes" },
	);
	assert.equal(
		routeMatrixTextEvent(
			{ ...baseEvent, body: ">not-a-quote\n\nyes", replyToEventId: "$bot-answer" },
			binding,
			config,
			config.botUserId,
		),
		undefined,
	);
	assert.equal(
		routeMatrixTextEvent(
			{ ...baseEvent, body: "> malformed fallback", replyToEventId: "$bot-answer" },
			binding,
			config,
			config.botUserId,
		),
		undefined,
	);
	assert.equal(
		routeMatrixTextEvent(
			{ ...baseEvent, body: "yes", replyToEventId: "$other-answer" },
			binding,
			config,
			"@someone-else:example.com",
		),
		undefined,
	);
});

test("checkpoint schema validates each explicit approval boundary and bounded rendering", () => {
	const question = validateRemoteCheckpoint({
		kind: "question",
		decision: "Should the migration preserve the legacy endpoint?",
		context: "Removing it simplifies the public API.",
		options: ["Preserve it", "Remove it"],
	});
	const blocked = validateRemoteCheckpoint({
		kind: "blocked",
		blockerEvidence: "The deployment host is offline.",
		requiredIntervention: "Bring grill online and confirm SSH access.",
	});
	const complete = validateRemoteCheckpoint({
		kind: "issue_complete",
		issueOrObjective: "#20 explicit checkpoints",
		implementationSummary: "Added intentional Matrix approval boundaries.",
		verificationEvidence: "Unit and integration checks passed.",
		caveats: "Live acceptance remains.",
		gitCommitState: "Committed locally; not pushed.",
		approvalRequest: "Approve closing #20 and continue to the managed-session epic?",
	});

	assert.match(renderRemoteCheckpoint(question), /^❓ Question/);
	assert.match(renderRemoteCheckpoint(blocked), /^⛔ Blocked/);
	assert.match(renderRemoteCheckpoint(complete), /^✅ Issue complete/);
	assert.ok(renderRemoteCheckpoint(complete).length <= MAX_CHECKPOINT_BODY_LENGTH);
	const persisted = createRemoteCheckpoint(complete);
	assert.equal(persisted.version, 1);
	assert.equal(persisted.input.kind, "issue_complete");
	assert.match(persisted.checkpointId, /^[0-9a-f-]{36}$/);
	const stored = {
		...persisted,
		bindingId: "room-checkpoint",
		status: "prepared",
		transactionId: `remote-checkpoint-${persisted.checkpointId}`,
		inboundEventIds: ["$origin"],
	};
	assert.deepEqual(
		restoreCheckpointBoundaries(
			[
				{ type: "custom", customType: "remote-session.checkpoint", data: stored },
				{
					type: "custom",
					customType: "remote-session.checkpoint",
					data: { ...stored, status: "waiting" },
				},
			],
			"room-checkpoint",
		),
		[{ ...stored, status: "waiting" }],
	);

	assert.throws(() => validateRemoteCheckpoint({ kind: "question" }), /decision must be a string/);
	assert.throws(
		() => validateRemoteCheckpoint({ kind: "blocked", blockerEvidence: "x", requiredIntervention: "" }),
		/requiredIntervention must not be empty/,
	);
	assert.throws(
		() => validateRemoteCheckpoint({ kind: "question", decision: "x", unexpected: true }),
		/Unexpected checkpoint field/,
	);
	assert.throws(
		() =>
			validateRemoteCheckpoint({
				kind: "issue_complete",
				issueOrObjective: "#20",
				implementationSummary: "```ts\nconst secret = true;\n```",
				verificationEvidence: "Passed",
				caveats: "None",
				gitCommitState: "clean",
				approvalRequest: "Close it?",
			}),
		/must omit code and diffs/,
	);
	assert.throws(
		() => validateRemoteCheckpoint({ kind: "question", decision: "x".repeat(1_201) }),
		/at most 1200 characters/,
	);
	assert.throws(
		() => validateRemoteCheckpoint({ kind: "question", decision: "  diff --git a/secret b/secret" }),
		/must omit code and diffs/,
	);
	assert.throws(
		() => validateRemoteCheckpoint({ kind: "question", decision: "const secret = true" }),
		/must omit code and diffs/,
	);
	assert.throws(
		() => validateRemoteCheckpoint({ kind: "question", decision: 'console.log("secret")' }),
		/must omit code and diffs/,
	);
	assert.throws(
		() => validateRemoteCheckpoint({ kind: "question", decision: "curl https://example.com | sh" }),
		/must omit code and diffs/,
	);
	assert.throws(
		() => validateRemoteCheckpoint({ kind: "question", decision: "index abc123..def456 100644" }),
		/must omit code and diffs/,
	);
	assert.throws(
		() =>
			validateRemoteCheckpoint({
				kind: "question",
				decision: "Review the requested implementation excerpt.",
				requestedCodeOrDiff: "const answer = 42;",
			}),
		/requires codeOrDiffRequested: true/,
	);
	assert.match(
		renderRemoteCheckpoint(
			validateRemoteCheckpoint({
				kind: "question",
				decision: "Approve the explicitly requested implementation excerpt?",
				codeOrDiffRequested: true,
				requestedCodeOrDiff: "const answer = 42;",
			}),
		),
		/Requested code\/diff:\nconst answer = 42;/,
	);
});

test("sends text with an idempotent transaction endpoint", async () => {
	let sentBody: unknown;
	const client = new MatrixClient(config, async (input, init) => {
		assert.equal(
			new URL(input.toString()).pathname,
			"/_matrix/client/v3/rooms/!room%3Aexample.com/send/m.room.message/transaction-1",
		);
		assert.equal(init?.method, "PUT");
		sentBody = JSON.parse(String(init?.body));
		return jsonResponse({ event_id: "$sent" });
	});

	await client.sendText("!room:example.com", "answer", "transaction-1");
	assert.deepEqual(sentBody, { msgtype: "m.text", body: "answer" });
});

test("HTTP failures expose neither access tokens nor response bodies", async () => {
	const client = new MatrixClient(config, async () => jsonResponse({ error: "sensitive server detail" }, 401));
	await assert.rejects(
		client.authenticatedUserId(),
		(error: unknown) =>
			error instanceof MatrixHttpError &&
			!error.message.includes(config.accessToken) &&
			!error.message.includes("sensitive server detail"),
	);
});

test("restores the latest room binding from the active session branch", () => {
	assert.deepEqual(
		restoreRoomBinding([
			{ type: "custom", customType: "remote-session.binding", data: { version: 1, roomId: "!old", conceptName: "old" } },
			{ type: "message" },
			{ type: "custom", customType: "remote-session.binding", data: { version: 1, roomId: "!new", conceptName: "new" } },
			{ type: "compaction", summary: "compacted conversation", firstKeptEntryId: "entry-1" },
		]),
		{ version: 1, roomId: "!new", conceptName: "new" },
	);
});

test("inbound recovery distinguishes missing, injected, and answered crash windows", () => {
	const marker = {
		type: "custom",
		customType: "remote-session.inbound",
		data: { version: 1, eventId: "$recover", status: "injecting", prompt: "Remote prompt" },
	};
	const expandedMarker = {
		type: "custom",
		customType: "remote-session.inbound",
		data: { version: 1, eventId: "$recover", status: "expanded", prompt: "Remote prompt" },
	};
	assert.deepEqual(recoverInboundTurn([], "$recover", "Remote prompt"), { state: "missing" });
	assert.deepEqual(recoverInboundTurn([marker], "$recover", "Remote prompt"), { state: "missing" });
	assert.deepEqual(
		recoverInboundTurn(
			[
				marker,
				{ type: "message", message: { role: "user", content: [{ type: "text", text: "later local prompt" }] } },
				{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "local answer" }] } },
			],
			"$recover",
			"Remote prompt",
		),
		{ state: "missing" },
	);
	assert.deepEqual(
		recoverInboundTurn(
			[
				marker,
				expandedMarker,
				{ type: "message", message: { role: "user", content: [{ type: "text", text: "Remote prompt" }] } },
			],
			"$recover",
			"Remote prompt",
		),
		{ state: "injected" },
	);
	assert.deepEqual(
		recoverInboundTurn(
			[
				{ ...marker, data: { ...marker.data, prompt: "/skill:research Matrix" } },
				{
					type: "custom",
					customType: "remote-session.inbound",
					data: {
						version: 1,
						eventId: "$recover",
						status: "expanded",
						prompt: "<skill>expanded skill content</skill>",
					},
				},
				{ type: "message", message: { role: "user", content: [{ type: "text", text: "unrelated local turn" }] } },
				{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "local answer" }] } },
				{
					type: "message",
					message: { role: "user", content: [{ type: "text", text: "<skill>expanded skill content</skill>" }] },
				},
			],
			"$recover",
			"/skill:research Matrix",
		),
		{ state: "injected" },
	);
	assert.deepEqual(
		recoverInboundTurn(
			[
				marker,
				expandedMarker,
				{ type: "message", message: { role: "user", content: [{ type: "text", text: "Remote prompt" }] } },
				{
					type: "message",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "Working" }, { type: "toolCall", name: "bash" }],
					},
				},
			],
			"$recover",
			"Remote prompt",
		),
		{ state: "injected" },
	);
	assert.deepEqual(
		recoverInboundTurn(
			[
				marker,
				expandedMarker,
				{ type: "message", message: { role: "user", content: [{ type: "text", text: "Remote prompt" }] } },
				{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Recovered answer" }] } },
			],
			"$recover",
			"Remote prompt",
		),
		{ state: "answered", answer: "Recovered answer" },
	);
});

test("run answer mapping preserves queued local, follow-up, and steering order", () => {
	const first = { prompt: "first", eventId: "$first" };
	const followUp = { prompt: "follow up", eventId: "$follow-up" };
	const steer = { prompt: "steer", eventId: "$steer" };
	assert.deepEqual(
		mapRunAnswers(
			[
				{ role: "user", content: [{ type: "text", text: "first" }] },
				{ role: "assistant", content: [{ type: "text", text: "First answer" }] },
				{ role: "user", content: [{ type: "text", text: "local queued" }] },
				{ role: "assistant", content: [{ type: "text", text: "Local answer" }] },
				{ role: "user", content: [{ type: "text", text: "follow up" }] },
				{ role: "assistant", content: [{ type: "text", text: "Follow-up answer" }] },
				{ role: "user", content: [{ type: "text", text: "steer" }] },
				{ role: "assistant", content: [{ type: "text", text: "Steered answer" }] },
			],
			[first, undefined, followUp, steer],
		),
		[
			{ turn: first, answer: "First answer" },
			{ turn: followUp, answer: "Follow-up answer" },
			{ turn: steer, answer: "Steered answer" },
		],
	);
	assert.deepEqual(
		mapRunAnswers(
			[
				{ role: "user", content: [{ type: "text", text: "run tool" }] },
				{ role: "assistant", content: [{ type: "text", text: "Earlier planning text" }] },
				{
					role: "assistant",
					content: [{ type: "text", text: "Working" }, { type: "toolCall", name: "bash" }],
				},
			],
			[{ prompt: "run tool", eventId: "$tool" }],
		),
		[{ turn: { prompt: "run tool", eventId: "$tool" }, answer: undefined }],
	);
});

test("operator Matrix turns receive final answers without capturing local turns", async () => {
	type Handler = (event: unknown, context: ExtensionContext) => unknown;
	type CommandHandler = (args: string, context: ExtensionContext) => Promise<void>;

	const handlers = new Map<string, Handler>();
	let remoteCommand: CommandHandler | undefined;
	const appendedEntries: Array<{ customType: string; data: unknown }> = [];
	const userMessages: Array<{
		text: string;
		deliverAs: string | undefined;
		expandPromptTemplates: boolean | undefined;
	}> = [];
	const notifications: string[] = [];
	const statuses: Array<string | undefined> = [];
	const sendAttempts: Array<{ transactionPath: string; body: unknown }> = [];
	let createRoomCount = 0;
	const syncCursors: Array<string | null> = [];
	let sessionId = "roundtrip-session";
	let sessionBranch: unknown[] = [];

	const pi = {
		on(event: string, handler: Handler) {
			handlers.set(event, handler);
		},
		registerCommand(name: string, command: { handler: CommandHandler }) {
			assert.equal(name, "remote");
			remoteCommand = command.handler;
		},
		registerTool() {},
		appendEntry(customType: string, data: unknown) {
			appendedEntries.push({ customType, data });
			sessionBranch.push({ type: "custom", customType, data });
		},
		getCommands() {
			return [];
		},
		sendUserMessage(
			text: string,
			options?: {
				deliverAs?: string;
				expandPromptTemplates?: boolean;
				onPromptExpanded?: (text: string) => void;
			},
		) {
			options?.onPromptExpanded?.(text);
			userMessages.push({
				text,
				deliverAs: options?.deliverAs,
				expandPromptTemplates: options?.expandPromptTemplates,
			});
			void handlers.get("input")?.(
				{ text, source: "extension", streamingBehavior: options?.deliverAs },
				context,
			);
		},
	} as unknown as ExtensionAPI;

	const sessionRoot = await mkdtemp(join(tmpdir(), "pi-remote-extension-"));
	const context = {
		hasUI: true,
		isIdle: () => false,
		abort() {},
		ui: {
			notify(message: string) {
				notifications.push(message);
			},
			setStatus(_key: string, value: string | undefined) {
				statuses.push(value);
			},
		},
		sessionManager: {
			getBranch: () => sessionBranch,
			getSessionId: () => sessionId,
			getSessionDir: () => join(sessionRoot, "--project--"),
		},
	} as unknown as ExtensionContext;

	const environment = {
		PI_MATRIX_HOMESERVER: config.homeserver,
		PI_MATRIX_ACCESS_TOKEN: config.accessToken,
		PI_MATRIX_BOT_USER_ID: config.botUserId,
		PI_MATRIX_OPERATOR_USER_ID: config.operatorUserId,
		PI_MATRIX_HOSTNAME: config.hostName,
	};
	const previousEnvironment = Object.fromEntries(
		Object.keys(environment).map((name) => [name, process.env[name]]),
	) as Record<string, string | undefined>;
	Object.assign(process.env, environment);

	const originalFetch = globalThis.fetch;
	let syncCount = 0;
	globalThis.fetch = async (input, init) => {
		const url = new URL(input.toString());
		if (url.pathname.endsWith("/account/whoami")) return jsonResponse({ user_id: config.botUserId });
		if (url.pathname.endsWith("/createRoom")) {
			createRoomCount += 1;
			return jsonResponse({ room_id: "!roundtrip:example.com" });
		}
		if (url.pathname.endsWith("/sync")) {
			syncCursors.push(url.searchParams.get("since"));
			syncCount += 1;
			if (syncCount === 1) return jsonResponse({ next_batch: "cursor-empty", rooms: { join: {} } });
			if (syncCount <= 3) {
				const prompt =
					syncCount === 2
						? "@grill Reply exactly: Matrix round trip succeeded"
						: "@grill Reply exactly: Second Matrix turn succeeded";
				return jsonResponse({
					next_batch: `cursor-${syncCount - 1}`,
					rooms: {
						join: {
							"!roundtrip:example.com": {
								timeline: {
									events: [
										{
											type: "m.room.message",
											event_id: `$operator-prompt-${syncCount - 1}`,
											sender: config.operatorUserId,
											content: { msgtype: "m.text", body: prompt },
										},
									],
								},
							},
						},
					},
				});
			}
			return new Promise<Response>((_resolve, reject) => {
				const abort = () => {
					const error = new Error("aborted");
					error.name = "AbortError";
					reject(error);
				};
				if (init?.signal?.aborted) abort();
				else init?.signal?.addEventListener("abort", abort, { once: true });
			});
		}
		if (url.pathname.includes("/send/m.room.message/")) {
			const body = JSON.parse(String(init?.body)) as { body?: unknown };
			sendAttempts.push({ transactionPath: url.pathname, body });
			return jsonResponse({ event_id: "$bot-answer" });
		}
		throw new Error(`Unexpected Matrix request: ${url.pathname}`);
	};

	const waitFor = async (predicate: () => boolean): Promise<void> => {
		for (let attempt = 0; attempt < 100; attempt += 1) {
			if (predicate()) return;
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		assert.fail("Timed out waiting for remote-session behavior");
	};

	try {
		remoteSessionExtension(pi);
		assert.ok(remoteCommand);
		await handlers.get("session_start")?.({}, context);
		await handlers.get("input")?.(
			{
				text: "Reply exactly: Matrix round trip succeeded",
				source: "interactive",
				streamingBehavior: undefined,
			},
			context,
		);
		await handlers.get("before_agent_start")?.({}, context);
		await remoteCommand("on matrix round trip", context);
		await waitFor(
			() =>
				userMessages.length === 2 &&
				appendedEntries.filter(
					(entry) =>
						entry.customType === "remote-session.inbound" &&
						typeof entry.data === "object" &&
						entry.data !== null &&
						(entry.data as { status?: unknown }).status === "injected",
				).length === 2,
		);
		assert.equal(syncCursors[1], "cursor-empty");

		assert.deepEqual(
			appendedEntries.filter((entry) => entry.customType === "remote-session.binding"),
			[
				{
					customType: "remote-session.binding",
					data: {
						version: 2,
						bindingId: "room-006d66143d62a95c072f8e8fc50e3254",
						roomId: "!roundtrip:example.com",
						conceptName: "matrix round trip",
					},
				},
			],
		);
		assert.deepEqual(userMessages, [
			{
				text: "Reply exactly: Matrix round trip succeeded",
				deliverAs: "followUp",
				expandPromptTemplates: true,
			},
			{
				text: "Reply exactly: Second Matrix turn succeeded",
				deliverAs: "followUp",
				expandPromptTemplates: true,
			},
		]);

		await handlers.get("agent_end")?.(
			{
				messages: [
					{ role: "user", content: [{ type: "text", text: "Reply exactly: Matrix round trip succeeded" }] },
					{ role: "assistant", content: [{ type: "text", text: "Local answer with colliding prompt text" }] },
					{ role: "user", content: [{ type: "text", text: "Reply exactly: Matrix round trip succeeded" }] },
					{ role: "assistant", content: [{ type: "text", text: "Matrix round trip succeeded" }] },
					{ role: "user", content: [{ type: "text", text: "Reply exactly: Second Matrix turn succeeded" }] },
					{ role: "assistant", content: [{ type: "text", text: "Second Matrix turn succeeded" }] },
				],
			},
			context,
		);
		assert.deepEqual(
			sendAttempts.map((attempt) => attempt.body),
			[
				{ msgtype: "m.text", body: "Matrix round trip succeeded" },
				{ msgtype: "m.text", body: "Second Matrix turn succeeded" },
			],
		);

		await remoteCommand("off", context);
		const externalStore = new RemoteSessionStateStore(
			stateRootForSessionDirectory(join(sessionRoot, "--project--")),
			config.botUserId,
		);
		await externalStore.acceptSync("room-006d66143d62a95c072f8e8fc50e3254", "cursor-crash", [
			{ eventId: "$accepted-before-crash", prompt: "Recover accepted prompt" },
		]);
		await handlers.get("session_start")?.({ reason: "resume" }, context);
		await waitFor(() => userMessages.length === 3 && syncCursors.at(-1) === "cursor-crash");
		assert.equal(sendAttempts.length, 2);
		assert.equal(userMessages.at(-1)?.text, "Recover accepted prompt");
		assert.equal(syncCursors.at(-1), "cursor-crash");

		await handlers.get("before_agent_start")?.({}, context);
		await handlers.get("agent_end")?.(
			{
				messages: [
					{ role: "user", content: [{ type: "text", text: "Recover accepted prompt" }] },
					{ role: "assistant", content: [{ type: "text", text: "Recovered accepted answer" }] },
				],
			},
			context,
		);
		assert.deepEqual(sendAttempts.at(-1)?.body, { msgtype: "m.text", body: "Recovered accepted answer" });
		assert.equal(createRoomCount, 1);

		await remoteCommand("off", context);
		await externalStore.acceptSync("room-006d66143d62a95c072f8e8fc50e3254", "cursor-persisted-answer", [
			{ eventId: "$persisted-answer-crash", prompt: "Persisted answer prompt" },
		]);
		await externalStore.markInboundInjected(
			"room-006d66143d62a95c072f8e8fc50e3254",
			"$persisted-answer-crash",
		);
		sessionBranch.push(
			{
				type: "custom",
				customType: "remote-session.inbound",
				data: {
					version: 1,
					eventId: "$persisted-answer-crash",
					status: "injecting",
					prompt: "Persisted answer prompt",
				},
			},
			{
				type: "custom",
				customType: "remote-session.inbound",
				data: {
					version: 1,
					eventId: "$persisted-answer-crash",
					status: "expanded",
					prompt: "Persisted answer prompt",
				},
			},
			{ type: "message", message: { role: "user", content: [{ type: "text", text: "Persisted answer prompt" }] } },
			{
				type: "message",
				message: { role: "assistant", content: [{ type: "text", text: "Persisted answer recovered" }] },
			},
		);
		await handlers.get("session_start")?.({ reason: "resume" }, context);
		await waitFor(() => sendAttempts.length === 4);
		assert.deepEqual(sendAttempts.at(-1)?.body, { msgtype: "m.text", body: "Persisted answer recovered" });

		await remoteCommand("on conflicting concept", context);
		assert.ok(notifications.some((message) => message.includes("already bound to concept: matrix round trip")));
		await remoteCommand("status", context);
		assert.ok(notifications.some((message) => message.includes("Matrix remote: connected")));
		assert.ok(statuses.includes("remote: matrix round trip"));
		await remoteCommand("off", context);

		await remoteCommand("on matrix round trip", context);
		assert.equal(createRoomCount, 1);
		await remoteCommand("off", context);

		const parentSessionFile = join(sessionRoot, "parent.jsonl");
		await writeFile(
			parentSessionFile,
			`${JSON.stringify({ type: "session", version: 3, id: sessionId, cwd: "/project" })}\n`,
		);
		sessionId = "fork-session";
		sessionBranch = [];
		await handlers.get("session_start")?.(
			{ reason: "fork", previousSessionFile: parentSessionFile },
			context,
		);
		assert.equal(createRoomCount, 1);
		assert.ok(
			appendedEntries.some(
				(entry) =>
					typeof entry.data === "object" &&
					entry.data !== null &&
					(entry.data as { version?: unknown }).version === 2,
			),
		);
		await remoteCommand("off", context);
		assert.equal(statuses.at(-1), undefined);
	} finally {
		globalThis.fetch = originalFetch;
		for (const [name, value] of Object.entries(previousEnvironment)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
});

test("remote input preserves idle, follow-up, steer, abort, command, skill, and reply semantics", async () => {
	type Handler = (event: unknown, context: ExtensionContext) => unknown;
	type CommandHandler = (args: string, context: ExtensionContext) => Promise<void>;
	type CheckpointTool = {
		execute: (
			toolCallId: string,
			params: unknown,
			signal: AbortSignal,
			onUpdate: unknown,
			context: ExtensionContext,
		) => Promise<unknown>;
	};
	const handlers = new Map<string, Handler>();
	let remoteCommand: CommandHandler | undefined;
	let checkpointTool: CheckpointTool | undefined;
	const sentInputs: Array<{
		text: string;
		deliverAs: string | undefined;
		expandPromptTemplates: boolean | undefined;
	}> = [];
	const sentMatrixBodies: string[] = [];
	const sentMatrixTransactions: string[] = [];
	let abortCount = 0;
	let failNextCheckpoint = false;
	const idleStates = [true, false, false, false, true];
	const roomId = "!controls:example.com";
	const bindingId = "room-5f7906db91467e434006d95ef7dccc7e";
	const binding = { version: 2 as const, bindingId, roomId, conceptName: "controls" };
	const sessionId = "control-session";
	const sessionRoot = await mkdtemp(join(tmpdir(), "pi-remote-controls-"));
	const sessionDir = join(sessionRoot, "--project--");
	const branch: unknown[] = [{ type: "custom", customType: "remote-session.binding", data: binding }];

	const context = {
		hasUI: false,
		isIdle: () => idleStates.shift() ?? true,
		abort() {
			abortCount += 1;
		},
		sessionManager: {
			getBranch: () => branch,
			getSessionId: () => sessionId,
			getSessionDir: () => sessionDir,
		},
	} as unknown as ExtensionContext;
	const pi = {
		on(event: string, handler: Handler) {
			handlers.set(event, handler);
		},
		registerCommand(name: string, command: { handler: CommandHandler }) {
			if (name === "remote") remoteCommand = command.handler;
		},
		registerTool(tool: CheckpointTool & { name: string }) {
			if (tool.name === "remote_checkpoint") checkpointTool = tool;
		},
		getCommands() {
			return [{ name: "worker-model", source: "extension" }];
		},
		appendEntry(customType: string, data: unknown) {
			branch.push({ type: "custom", customType, data });
		},
		sendUserMessage(
			text: string,
			options?: {
				deliverAs?: string;
				expandPromptTemplates?: boolean;
				onPromptExpanded?: (text: string) => void;
			},
		) {
			if (!text.startsWith("/worker-model")) {
				const expandedText = text.startsWith("/skill:") ? `<skill>expanded</skill>\n\n${text.split(" ").slice(1).join(" ")}` : text;
				options?.onPromptExpanded?.(expandedText);
			}
			sentInputs.push({
				text,
				deliverAs: options?.deliverAs,
				expandPromptTemplates: options?.expandPromptTemplates,
			});
			if (!text.startsWith("/worker-model")) {
				void handlers.get("input")?.({ text, source: "extension" }, context);
			}
		},
	} as unknown as ExtensionAPI;

	const environment = {
		PI_MATRIX_HOMESERVER: config.homeserver,
		PI_MATRIX_ACCESS_TOKEN: config.accessToken,
		PI_MATRIX_BOT_USER_ID: config.botUserId,
		PI_MATRIX_OPERATOR_USER_ID: config.operatorUserId,
		PI_MATRIX_HOSTNAME: config.hostName,
	};
	const previousEnvironment = Object.fromEntries(
		Object.keys(environment).map((name) => [name, process.env[name]]),
	) as Record<string, string | undefined>;
	Object.assign(process.env, environment);
	const store = new RemoteSessionStateStore(stateRootForSessionDirectory(sessionDir), config.botUserId);
	await store.bindSession(sessionId, binding);

	const originalFetch = globalThis.fetch;
	let syncCount = 0;
	globalThis.fetch = async (input, init) => {
		const url = new URL(input.toString());
		if (url.pathname.endsWith("/account/whoami")) return jsonResponse({ user_id: config.botUserId });
		if (url.pathname.endsWith("/event/%24bot-answer")) {
			return jsonResponse({ event_id: "$bot-answer", sender: config.botUserId });
		}
		if (url.pathname.endsWith("/event/%24missing")) return jsonResponse({ errcode: "M_NOT_FOUND" }, 404);
		if (url.pathname.endsWith("/sync")) {
			syncCount += 1;
			if (syncCount === 1) {
				const event = (eventId: string, body: string, content: Record<string, unknown> = {}) => ({
					type: "m.room.message",
					event_id: eventId,
					sender: config.operatorUserId,
					content: { msgtype: "m.text", body, ...content },
				});
				return jsonResponse({
					next_batch: "control-cursor",
					rooms: {
						join: {
							[roomId]: {
								timeline: {
									events: [
										event("$skill", "@grill /skill:research Matrix APIs"),
										event("$ordinary", "@grill queue this"),
										event("$steer", "@grill !steer redirect now"),
										event("$command", "@grill /worker-model status"),
										event("$abort", "@grill !abort"),
										event("$missing-reply", "must be ignored", {
											"m.relates_to": { "m.in_reply_to": { event_id: "$missing" } },
										}),
										event("$reply", "yes", {
											"m.relates_to": { "m.in_reply_to": { event_id: "$bot-answer" } },
										}),
									],
								},
							},
						},
					},
				});
			}
			return new Promise<Response>((_resolve, reject) => {
				const abort = () => {
					const error = new Error("aborted");
					error.name = "AbortError";
					reject(error);
				};
				if (init?.signal?.aborted) abort();
				else init?.signal?.addEventListener("abort", abort, { once: true });
			});
		}
		if (url.pathname.includes("/send/m.room.message/")) {
			const body = JSON.parse(String(init?.body)) as { body: string };
			sentMatrixBodies.push(body.body);
			sentMatrixTransactions.push(url.pathname);
			if (failNextCheckpoint) {
				failNextCheckpoint = false;
				return jsonResponse({ errcode: "M_UNAVAILABLE" }, 503);
			}
			return jsonResponse({ event_id: "$command-ack" });
		}
		throw new Error(`Unexpected Matrix request: ${url.pathname}`);
	};

	try {
		remoteSessionExtension(pi);
		await handlers.get("session_start")?.({ reason: "resume" }, context);
		for (let attempt = 0; attempt < 100 && sentInputs.length < 5; attempt += 1) {
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		assert.deepEqual(sentInputs, [
			{ text: "/skill:research Matrix APIs", deliverAs: undefined, expandPromptTemplates: true },
			{ text: "queue this", deliverAs: "followUp", expandPromptTemplates: true },
			{ text: "redirect now", deliverAs: "steer", expandPromptTemplates: true },
			{ text: "/worker-model status", deliverAs: "followUp", expandPromptTemplates: true },
			{ text: "yes", deliverAs: undefined, expandPromptTemplates: true },
		]);
		assert.equal(abortCount, 1);
		assert.deepEqual(sentMatrixBodies, ["Command dispatched: /worker-model"]);
		assert.equal((await store.hostProgress(bindingId)).since, "control-cursor");

		await handlers.get("before_agent_start")?.({}, context);
		assert.ok(checkpointTool);
		await checkpointTool.execute(
			"checkpoint-call",
			{
				kind: "issue_complete",
				issueOrObjective: "Issue #20",
				implementationSummary: "Added explicit Matrix approval boundaries.",
				verificationEvidence: "Focused tests passed.",
				caveats: "Live acceptance remains.",
				gitCommitState: "Committed locally; not pushed.",
				approvalRequest: "Approve closure of issue #20?",
			},
			new AbortController().signal,
			undefined,
			context,
		);
		assert.equal(abortCount, 2, "checkpoint must terminate the current run");
		assert.match(sentMatrixBodies.at(-1) ?? "", /^✅ Issue complete/);
		assert.match(sentMatrixBodies.at(-1) ?? "", /Approval requested: Approve closure of issue #20\?/);
		const waitingEntry = branch.find(
			(entry) =>
				typeof entry === "object" &&
				entry !== null &&
				(entry as { customType?: unknown }).customType === "remote-session.checkpoint" &&
				(entry as { data?: { status?: unknown } }).data?.status === "waiting",
		) as { data: Record<string, unknown> } | undefined;
		assert.ok(waitingEntry);
		await handlers.get("agent_end")?.(
			{
				messages: [
					{ role: "user", content: [{ type: "text", text: "<skill>expanded</skill>\n\nMatrix APIs" }] },
					{ role: "assistant", content: [{ type: "text", text: "must not follow the checkpoint" }] },
				],
			},
			context,
		);
		assert.equal(sentMatrixBodies.length, 2, "checkpoint-bound run output must not be mirrored");

		await store.acceptSync(bindingId, "checkpoint-crash-cursor", [
			{ eventId: "$checkpoint-crash", prompt: "approval boundary prompt" },
		]);
		branch.push({
			type: "custom",
			customType: "remote-session.checkpoint",
			data: {
				...waitingEntry.data,
				checkpointId: "prepared-after-crash",
				status: "prepared",
				transactionId: "remote-checkpoint-prepared-after-crash",
				inboundEventIds: ["$checkpoint-crash"],
			},
		});
		await handlers.get("session_start")?.({ reason: "resume" }, context);
		assert.equal(sentMatrixBodies.length, 3, "prepared checkpoint must retry after restart");
		assert.match(sentMatrixTransactions.at(-1) ?? "", /remote-checkpoint-prepared-after-crash$/);
		assert.equal(
			(await store.unfinishedInbounds(bindingId)).some((turn) => turn.eventId === "$checkpoint-crash"),
			false,
			"checkpoint recovery must not continue the originating inbound",
		);
		assert.ok(
			branch.some(
				(entry) =>
					typeof entry === "object" &&
					entry !== null &&
					(entry as { data?: { checkpointId?: unknown; status?: unknown } }).data?.checkpointId ===
						"prepared-after-crash" &&
					(entry as { data?: { status?: unknown } }).data?.status === "waiting",
			),
		);
		await handlers.get("agent_end")?.(
			{ messages: [{ role: "assistant", content: [{ type: "text", text: "routine final answer" }] }] },
			context,
		);
		assert.equal(sentMatrixBodies.length, 3, "agent_end must not mirror routine output after the checkpoint");

		failNextCheckpoint = true;
		await assert.rejects(
			checkpointTool.execute(
				"failed-checkpoint-call",
				{ kind: "question", decision: "Should this failed delivery remain an approval boundary?" },
				new AbortController().signal,
				undefined,
				context,
			),
			/HTTP 503/,
		);
		assert.equal(abortCount, 3, "a failed checkpoint send must still stop the run");
		await remoteCommand?.("off", context);
	} finally {
		globalThis.fetch = originalFetch;
		for (const [name, value] of Object.entries(previousEnvironment)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
});

test("remote off cancels activation before a room can be created", async () => {
	type Handler = (event: unknown, context: ExtensionContext) => unknown;
	type CommandHandler = (args: string, context: ExtensionContext) => Promise<void>;
	const handlers = new Map<string, Handler>();
	let remoteCommand: CommandHandler | undefined;
	let appended = false;
	const requestedPaths: string[] = [];

	const pi = {
		on(event: string, handler: Handler) {
			handlers.set(event, handler);
		},
		registerCommand(_name: string, command: { handler: CommandHandler }) {
			remoteCommand = command.handler;
		},
		registerTool() {},
		appendEntry() {
			appended = true;
		},
		sendUserMessage() {
			assert.fail("Activation cancellation must not inject a prompt");
		},
	} as unknown as ExtensionAPI;
	const sessionRoot = await mkdtemp(join(tmpdir(), "pi-remote-cancel-"));
	const context = {
		hasUI: false,
		sessionManager: {
			getBranch: () => [],
			getSessionId: () => "cancel-session",
			getSessionDir: () => join(sessionRoot, "--project--"),
		},
	} as unknown as ExtensionContext;

	const environment = {
		PI_MATRIX_HOMESERVER: config.homeserver,
		PI_MATRIX_ACCESS_TOKEN: config.accessToken,
		PI_MATRIX_BOT_USER_ID: config.botUserId,
		PI_MATRIX_OPERATOR_USER_ID: config.operatorUserId,
		PI_MATRIX_HOSTNAME: config.hostName,
	};
	const previousEnvironment = Object.fromEntries(
		Object.keys(environment).map((name) => [name, process.env[name]]),
	) as Record<string, string | undefined>;
	Object.assign(process.env, environment);

	const originalFetch = globalThis.fetch;
	let whoamiStarted: (() => void) | undefined;
	const whoamiRequestStarted = new Promise<void>((resolve) => {
		whoamiStarted = resolve;
	});
	globalThis.fetch = async (input, init) => {
		requestedPaths.push(new URL(input.toString()).pathname);
		whoamiStarted?.();
		return new Promise<Response>((_resolve, reject) => {
			const abort = () => {
				const error = new Error("aborted");
				error.name = "AbortError";
				reject(error);
			};
			if (init?.signal?.aborted) abort();
			else init?.signal?.addEventListener("abort", abort, { once: true });
		});
	};

	try {
		remoteSessionExtension(pi);
		assert.ok(remoteCommand);
		await handlers.get("session_start")?.({}, context);
		const activation = remoteCommand("on cancelled room", context);
		await whoamiRequestStarted;
		await remoteCommand("off", context);
		await activation;
		assert.deepEqual(requestedPaths, ["/_matrix/client/v3/account/whoami"]);
		assert.equal(appended, false);
	} finally {
		globalThis.fetch = originalFetch;
		for (const [name, value] of Object.entries(previousEnvironment)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
});
