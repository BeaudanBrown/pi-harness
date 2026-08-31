import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	MANAGED_SESSION_PROTOCOL_VERSION,
	deriveConversationId,
	deriveDeliveryId,
	deriveTranscriptEntryId,
	encodeNdjsonEnvelope,
	parseNdjsonEnvelope,
	type ManagedSessionEnvelope,
} from "../config/agent/extensions/managed-sessions/contracts.js";

const pi = process.env.PI_MANAGED_ADAPTER_TEST_PI;
const adapterExtension = process.env.PI_MANAGED_ADAPTER_ORDINARY_EXTENSION;
const conversationId = deriveConversationId("probe-host", "manual-probe");
const deliveryId = deriveDeliveryId(conversationId, "$probe-event");
const normalDeliveryId = deriveDeliveryId(conversationId, "$normal-event");
const nonce = "abcdefghijklmnopqrstuvwxyzABCDEF";

async function rpc(child: ReturnType<typeof spawn>, commands: Array<Record<string, unknown>>): Promise<Array<Record<string, unknown>>> {
	const stdin = child.stdin;
	const stdout = child.stdout;
	const stderrStream = child.stderr;
	if (!stdin || !stdout || !stderrStream) throw new Error("real Pi adapter probe requires piped stdio");
	return new Promise((resolve, reject) => {
		const events: Array<Record<string, unknown>> = [];
		let buffer = "";
		let next = 0;
		let stderr = "";
		const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`real Pi adapter probe timed out: ${stderr}`)); }, 15_000);
		const sendNext = () => {
			if (next === commands.length) stdin.end();
			else stdin.write(`${JSON.stringify(commands[next])}\n`);
		};
		stdout.setEncoding("utf8");
		stderrStream.setEncoding("utf8");
		stdout.on("data", (chunk: string) => {
			buffer += chunk;
			while (buffer.includes("\n")) {
				const newline = buffer.indexOf("\n");
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				if (!line) continue;
				const event = JSON.parse(line) as Record<string, unknown>;
				events.push(event);
				if (event.type === "response" && event.id === commands[next]?.id) { next += 1; sendNext(); }
			}
		});
		stderrStream.on("data", (chunk: string) => { stderr += chunk; });
		child.once("error", (error) => { clearTimeout(timer); reject(error); });
		child.once("close", (code) => {
			clearTimeout(timer);
			code === 0 ? resolve(events) : reject(new Error(`real Pi adapter probe exited ${code}: ${stderr}`));
		});
		sendNext();
	});
}

test("real Pi binds, expands once, persists provenance, leaves /new and /fork unbound, and reattaches /resume", { timeout: 25_000 }, async (t) => {
	if (!pi || !adapterExtension) return t.skip("packaged Pi adapter probe paths are unavailable");
	const root = await mkdtemp(join(tmpdir(), "pi-managed-real-"));
	const home = join(root, "home");
	const socketPath = join(root, "relay.sock");
	const expandedPath = join(root, "expanded.txt");
	await mkdir(home);
	const frames: ManagedSessionEnvelope[] = [];
	const sockets = new Set<Socket>();
	let sentDelivery = false;
	let forcedReconnect = false;
	let redeliveredAfterReconnect = false;
	const server = createServer((socket) => {
		sockets.add(socket);
		let buffer = Buffer.alloc(0);
		socket.on("close", () => sockets.delete(socket));
		socket.on("data", (chunk) => {
			buffer = Buffer.concat([buffer, chunk]);
			while (buffer.includes(0x0a)) {
				const newline = buffer.indexOf(0x0a);
				const envelope = parseNdjsonEnvelope(buffer.subarray(0, newline + 1));
				buffer = buffer.subarray(newline + 1);
				frames.push(envelope);
				const base = {
					protocolVersion: MANAGED_SESSION_PROTOCOL_VERSION,
					messageId: `relay-${frames.length}`,
					conversationId: envelope.conversationId ?? conversationId,
					role: "relay" as const,
					inReplyTo: envelope.messageId,
				};
				if (envelope.type === "self.bind") {
					socket.write(encodeNdjsonEnvelope({ ...base, type: "self.result", payload: { operation: "self.bind", status: "ok", boundConversationId: conversationId } }));
				} else if (envelope.type === "attachment.attach") {
					socket.write(encodeNdjsonEnvelope({ ...base, type: "attachment.accepted", payload: { attachmentId: `attachment-${frames.length}`, state: "active" } }));
					const delivery: ManagedSessionEnvelope = {
						protocolVersion: MANAGED_SESSION_PROTOCOL_VERSION,
						messageId: sentDelivery ? "deliver-after-reconnect" : "deliver-real",
						conversationId, role: "relay", type: "input.deliver",
						payload: { deliveryId, matrixEventId: "$probe-event", kind: "prompt", body: "/adapter-expanded hello" },
					};
					if (!sentDelivery) {
						sentDelivery = true;
						setTimeout(() => socket.write(encodeNdjsonEnvelope(delivery)), 25);
					} else if (forcedReconnect && !redeliveredAfterReconnect) {
						redeliveredAfterReconnect = true;
						setTimeout(() => socket.write(encodeNdjsonEnvelope(delivery)), 25);
						setTimeout(() => socket.write(encodeNdjsonEnvelope({
							protocolVersion: MANAGED_SESSION_PROTOCOL_VERSION,
							messageId: "deliver-normal", conversationId, role: "relay", type: "input.deliver",
							payload: { deliveryId: normalDeliveryId, matrixEventId: "$normal-event", kind: "prompt", body: "ordinary persisted prompt" },
						})), 100);
					}
				} else if (envelope.type === "input.acknowledge" && envelope.payload.status === "accepted" && !forcedReconnect) {
					forcedReconnect = true;
					socket.destroy();
				}
			}
		});
	});
	await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
	t.after(async () => {
		for (const socket of sockets) socket.destroy();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(root, { recursive: true, force: true });
	});
	const probeExtension = join(root, "probe.ts");
	await writeFile(probeExtension, `
import { appendFileSync } from "node:fs";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
function fakeStream(model) {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    const message = {
      role: "assistant", content: [{ type: "text", text: "probe answer" }], api: model.api,
      provider: model.provider, model: model.id,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop", timestamp: Date.now(),
    };
    stream.push({ type: "start", partial: { ...message, content: [] } });
    stream.push({ type: "text_start", contentIndex: 0, partial: message });
    stream.push({ type: "text_delta", contentIndex: 0, delta: "probe answer", partial: message });
    stream.push({ type: "text_end", contentIndex: 0, content: "probe answer", partial: message });
    stream.push({ type: "done", reason: "stop", message });
    stream.end();
  });
  return stream;
}
export default function (pi) {
  pi.registerProvider("adapter-probe", {
    baseUrl: "https://adapter-probe.invalid", apiKey: "test-key", api: "adapter-probe-api",
    models: [{ id: "fake", name: "Adapter Probe", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 }],
    streamSimple: fakeStream,
  });
  pi.registerCommand("adapter-expanded", { handler: async (args) => appendFileSync(process.env.ADAPTER_EXPANDED_PATH, args.trim() + "\\n") });
  pi.registerCommand("adapter-wait", { handler: async () => new Promise((resolve) => setTimeout(resolve, 600)) });
}
`);
	const sessionDirectory = join(root, "sessions");
	const sessionPath = join(sessionDirectory, "probe.jsonl");
	await mkdir(sessionDirectory);
	await writeFile(sessionPath, [
		{
			type: "session", version: 3, id: "11111111-1111-4111-8111-111111111111",
			timestamp: "2026-08-31T00:00:00.000Z", cwd: root,
		},
		{
			type: "message", id: "abcd1234", parentId: null, timestamp: "2026-08-31T00:00:01.000Z",
			message: { role: "user", content: "seed for fork probe", timestamp: 1788134401000 },
		},
	].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
	const child = spawn(pi, [
		"--mode", "rpc", "--session", sessionPath, "--model", "adapter-probe/fake",
		"--no-extensions", "--extension", adapterExtension, "--extension", probeExtension,
	], {
		cwd: root,
		env: {
			...process.env,
			HOME: home,
			PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
			PI_MANAGED_SESSIONS_SOCKET: socketPath,
			PI_MANAGED_SESSION_ATTACHMENT_NONCE: nonce,
			PI_MANAGED_SESSION_ROOT_KEY: "projects",
			PI_MANAGED_SESSION_WORKSPACE: "probe-workspace",
			PI_MANAGED_SESSION_RELATIVE_CWD: "",
			ADAPTER_EXPANDED_PATH: expandedPath,
		},
		stdio: ["pipe", "pipe", "pipe"],
	});
	const events = await rpc(child, [
		{ id: "commands", type: "get_commands" },
		{ id: "bind", type: "prompt", message: "/remote on real probe" },
		{ id: "wait", type: "prompt", message: "/adapter-wait" },
		{ id: "new", type: "new_session" },
		{ id: "wait-new", type: "prompt", message: "/adapter-wait" },
		{ id: "resume", type: "switch_session", sessionPath },
		{ id: "wait-resume", type: "prompt", message: "/adapter-wait" },
		{ id: "fork", type: "fork", entryId: "abcd1234" },
		{ id: "wait-fork", type: "prompt", message: "/adapter-wait" },
	]);
	const commandResponse = events.find((event) => event.type === "response" && event.id === "commands") as { data?: { commands?: Array<{ name: string }> } } | undefined;
	const commands = commandResponse?.data?.commands?.map((command) => command.name) ?? [];
	assert.ok(commands.includes("remote"));
	assert.equal(commands.some((name) => name.startsWith("remote_session_")), false);
	assert.equal((await readFile(expandedPath, "utf8")).trim(), "hello");
	assert.equal(frames.filter((frame) => frame.type === "self.bind").length, 1);
	assert.equal(frames.filter((frame) => frame.type === "attachment.attach").length, 3, "one reconnect and one exact-session resume must attach; new and fork must remain unbound");
	assert.equal(redeliveredAfterReconnect, true);
	assert.ok(frames.some((frame) => frame.type === "attachment.detach" && frame.payload.reason === "session_change"));
	const lines = (await readFile(sessionPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
	const frameSummary = frames.map((frame) => ({ type: frame.type, deliveryId: frame.payload.deliveryId, status: frame.payload.status }));
	assert.ok(frames.filter((frame) => frame.type === "input.acknowledge").some((frame) => frame.payload.status === "accepted"));
	assert.equal(frames.filter((frame) => frame.type === "input.acknowledge").some((frame) =>
		frame.payload.deliveryId === deliveryId && frame.payload.status === "persisted"), false,
	"extension commands must not claim synthetic user-entry persistence");
	assert.ok(frames.some((frame) => frame.type === "input.acknowledge" &&
		frame.payload.deliveryId === normalDeliveryId && frame.payload.status === "persisted"),
		`frames=${JSON.stringify(frameSummary)} entries=${JSON.stringify(lines)}`);
	assert.ok(frames.every((frame) => !("accessToken" in frame.payload)));

	assert.ok(lines.some((entry) => entry.type === "custom" && entry.customType === "managed-session.binding"));
	assert.ok(lines.some((entry) => entry.type === "custom" && entry.customType === "managed-session.delivery" && (entry.data as { status?: string }).status === "expanded"));
	const normalUser = lines.find((entry) => {
		if (entry.type !== "message" || (entry.message as { role?: string }).role !== "user") return false;
		const content = (entry.message as { content?: unknown }).content;
		return content === "ordinary persisted prompt" || (Array.isArray(content) &&
			content.some((block) => typeof block === "object" && block !== null &&
				(block as { type?: string; text?: string }).type === "text" &&
				(block as { text?: string }).text === "ordinary persisted prompt"));
	});
	assert.equal(typeof normalUser?.id, "string");
	const normalPersisted = lines.find((entry) => entry.type === "custom" && entry.customType === "managed-session.delivery" &&
		(entry.data as { deliveryId?: string; status?: string }).deliveryId === normalDeliveryId &&
		(entry.data as { status?: string }).status === "persisted");
	assert.equal((normalPersisted?.data as { piEntryId?: string }).piEntryId,
		deriveTranscriptEntryId("11111111-1111-4111-8111-111111111111", String(normalUser!.id)));
});
