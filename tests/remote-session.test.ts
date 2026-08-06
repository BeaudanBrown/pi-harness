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
import remoteSessionExtension, {
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
		events: [{ roomId, eventId: "$event", sender: config.operatorUserId, body: "@grill hello" }],
	});
});

test("routing rejects the wrong room, sender, and host prefix", () => {
	const binding = { roomId: "!bound:example.com" };
	const baseEvent = {
		roomId: binding.roomId,
		eventId: "$event",
		sender: config.operatorUserId,
		body: "@grill investigate this",
	};

	assert.equal(routeMatrixTextEvent(baseEvent, binding, config), "investigate this");
	assert.equal(routeMatrixTextEvent({ ...baseEvent, roomId: "!other:example.com" }, binding, config), undefined);
	assert.equal(routeMatrixTextEvent({ ...baseEvent, sender: "@mallory:example.com" }, binding, config), undefined);
	assert.equal(routeMatrixTextEvent({ ...baseEvent, body: "@t480 investigate this" }, binding, config), undefined);
	assert.equal(routeMatrixTextEvent({ ...baseEvent, body: "unaddressed" }, binding, config), undefined);
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
	assert.deepEqual(recoverInboundTurn([], "$recover", "Remote prompt"), { state: "missing" });
	assert.deepEqual(recoverInboundTurn([marker], "$recover", "Remote prompt"), { state: "missing" });
	assert.deepEqual(
		recoverInboundTurn(
			[marker, { type: "message", message: { role: "user", content: [{ type: "text", text: "Remote prompt" }] } }],
			"$recover",
			"Remote prompt",
		),
		{ state: "injected" },
	);
	assert.deepEqual(
		recoverInboundTurn(
			[
				marker,
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
				{ type: "message", message: { role: "user", content: [{ type: "text", text: "Remote prompt" }] } },
				{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Recovered answer" }] } },
			],
			"$recover",
			"Remote prompt",
		),
		{ state: "answered", answer: "Recovered answer" },
	);
});

test("operator Matrix turns receive their own final answers without capturing local turns", async () => {
	type Handler = (event: unknown, context: ExtensionContext) => unknown;
	type CommandHandler = (args: string, context: ExtensionContext) => Promise<void>;

	const handlers = new Map<string, Handler>();
	let remoteCommand: CommandHandler | undefined;
	const appendedEntries: Array<{ customType: string; data: unknown }> = [];
	const userMessages: Array<{ text: string; deliverAs: string | undefined }> = [];
	const notifications: string[] = [];
	const statuses: Array<string | undefined> = [];
	const sendAttempts: Array<{ transactionPath: string; body: unknown }> = [];
	let failedSecondAnswer = false;
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
		appendEntry(customType: string, data: unknown) {
			appendedEntries.push({ customType, data });
			sessionBranch.push({ type: "custom", customType, data });
		},
		sendUserMessage(text: string, options?: { deliverAs?: string }) {
			userMessages.push({ text, deliverAs: options?.deliverAs });
			void handlers.get("input")?.(
				{ text, source: "extension", streamingBehavior: options?.deliverAs },
				context,
			);
		},
	} as unknown as ExtensionAPI;

	const sessionRoot = await mkdtemp(join(tmpdir(), "pi-remote-extension-"));
	const context = {
		hasUI: true,
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
			if (body.body === "Second Matrix turn succeeded" && !failedSecondAnswer) {
				failedSecondAnswer = true;
				return jsonResponse({ error: "retry this transaction" }, 503);
			}
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
			{ text: "Reply exactly: Matrix round trip succeeded", deliverAs: "followUp" },
			{ text: "Reply exactly: Second Matrix turn succeeded", deliverAs: "followUp" },
		]);

		await handlers.get("agent_end")?.(
			{
				messages: [
					{ role: "user", content: [{ type: "text", text: "Reply exactly: Matrix round trip succeeded" }] },
					{ role: "assistant", content: [{ type: "text", text: "Local answer with colliding prompt text" }] },
				],
			},
			context,
		);
		assert.equal(sendAttempts.length, 0);

		await handlers.get("before_agent_start")?.({}, context);
		await handlers.get("agent_end")?.(
			{
				messages: [
					{ role: "user", content: [{ type: "text", text: "Reply exactly: Matrix round trip succeeded" }] },
					{ role: "assistant", content: [{ type: "text", text: "Matrix round trip succeeded" }] },
				],
			},
			context,
		);
		await handlers.get("before_agent_start")?.({}, context);
		await handlers.get("agent_end")?.(
			{
				messages: [
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
		await waitFor(
			() => sendAttempts.length === 3 && userMessages.length === 3 && syncCursors.at(-1) === "cursor-crash",
		);
		assert.equal(sendAttempts[1]?.transactionPath, sendAttempts[2]?.transactionPath);
		assert.deepEqual(sendAttempts[2]?.body, { msgtype: "m.text", body: "Second Matrix turn succeeded" });
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
