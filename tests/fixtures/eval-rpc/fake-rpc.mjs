import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

const mode = process.env.FAKE_RPC_MODE ?? "normal";
const decoder = new StringDecoder("utf8");
let buffer = "";
let uiStage = 0;
let declaredConfirmed = false;

if (mode === "shutdown-stderr") {
	process.once("SIGTERM", () => {
		process.stderr.write(Buffer.from([0x73, 0x79, 0x6e, 0x74, 0x68, 0x65, 0x74, 0x69, 0x63, 0x2d, 0xff, 0x0a]));
		setTimeout(() => process.exit(0), 10);
	});
}

function emit(record) {
	process.stdout.write(`${JSON.stringify(record)}\n`);
}

function respond(command, data) {
	emit({ type: "response", id: command.id, command: command.type, success: true, ...(data === undefined ? {} : { data }) });
}

function emitSplitUnicode() {
	const record = Buffer.from(`${JSON.stringify({ type: "unicode_event", text: "alpha\u2028beta\u2029gamma" })}\n`, "utf8");
	const unicodeStart = record.indexOf(Buffer.from("\u2028", "utf8"));
	process.stdout.write(record.subarray(0, unicodeStart + 1));
	setTimeout(() => {
		process.stdout.write(record.subarray(unicodeStart + 1));
		emit({ type: "agent_end", messages: [], willRetry: false });
		emit({ type: "agent_settled" });
	}, 5);
}

function handle(command) {
	switch (command.type) {
		case "prompt":
			if (mode === "prompt-rejected") {
				emit({ type: "response", id: command.id, command: command.type, success: false, error: "synthetic prompt rejected" });
				break;
			}
			if (mode === "stale-settled") emit({ type: "agent_settled", stale: true });
			respond(command);
			emit({ type: "agent_start" });
			if (mode === "command-timeout") {
				const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
				process.stderr.write(`grandchild:${grandchild.pid}\n`);
				emit({ type: "agent_end", messages: [], willRetry: false });
				emit({ type: "agent_settled" });
				break;
			}
			if (mode === "unterminated") {
				process.stdout.end(JSON.stringify({ type: "unterminated_event" }));
				break;
			}
			if (mode === "timeout") {
				const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
				process.stderr.write(`grandchild:${grandchild.pid}\n`);
				break;
			}
			if (mode === "malformed") {
				process.stderr.write("synthetic stderr before malformed record\n");
				setTimeout(() => process.stdout.write("{not-json}\n"), 20);
				break;
			}
			if (mode === "crash" || mode === "crash-child") {
				process.stderr.write("synthetic crash diagnostics\n");
				if (mode === "crash-child") {
					const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
					process.stderr.write(`grandchild:${grandchild.pid}\n`);
				}
				setTimeout(() => process.exit(23), 20);
				break;
			}
			if (mode === "truncated") {
				emit({ type: "message_update", assistantMessageEvent: { type: "done", reason: "length" } });
				emit({ type: "agent_end", messages: [], willRetry: false });
				emit({ type: "agent_settled" });
				break;
			}
			if (mode === "fire-and-forget-ui") {
				for (const method of ["setWorkingMessage", "setWorkingVisible", "setWorkingIndicator", "setHiddenThinkingLabel"]) {
					emit({ type: "extension_ui_request", id: `void-${method}`, method });
				}
				emit({ type: "agent_end", messages: [], willRetry: false });
				emit({ type: "agent_settled" });
				break;
			}
			if (mode === "unknown-ui") {
				emit({ type: "extension_ui_request", id: "unknown-dialog", method: "custom-dialog", title: "Unexpected" });
				break;
			}
			if (mode === "split-unicode") {
				emitSplitUnicode();
				break;
			}
			if (mode === "retry-compaction") {
				emit({ type: "agent_end", messages: [], willRetry: true });
				emit({ type: "auto_retry_start", attempt: 1, maxAttempts: 2, delayMs: 1, errorMessage: "synthetic overload" });
				emit({ type: "compaction_start", reason: "overflow" });
				emit({ type: "compaction_end", reason: "overflow", result: {}, aborted: false, willRetry: true });
				emit({ type: "auto_retry_end", success: true, attempt: 2 });
				emit({ type: "agent_end", messages: [], willRetry: false });
				emit({ type: "agent_settled" });
				break;
			}
			if (mode === "ui") {
				uiStage = 1;
				emit({
					type: "extension_ui_request",
					id: "dialog-declared",
					method: "confirm",
					title: "Approve synthetic action?",
					message: "Only fabricated data is involved.",
				});
				break;
			}
			emit({ type: "agent_end", messages: [], willRetry: false });
			emit({ type: "agent_settled" });
			break;
		case "extension_ui_response":
			if (mode !== "ui") break;
			if (uiStage === 1) {
				declaredConfirmed = command.confirmed === true;
				uiStage = 2;
				emit({ type: "extension_ui_request", id: "dialog-undeclared", method: "input", title: "Unexpected input" });
			} else if (uiStage === 2) {
				emit({ type: "ui_result", declaredConfirmed, undeclaredCancelled: command.cancelled === true });
				emit({ type: "agent_end", messages: [], willRetry: false });
				emit({ type: "agent_settled" });
			}
			break;
		case "get_state":
			if (mode === "command-timeout") break;
			if (process.env.FAKE_RPC_STATE_ERROR) {
				emit({ type: "response", id: command.id, command: command.type, success: false, error: process.env.FAKE_RPC_STATE_ERROR });
				break;
			}
			respond(command, {
				isStreaming: false,
				sessionId: "synthetic-session",
				...(process.env.FAKE_RPC_MODEL_PROVIDER && process.env.FAKE_RPC_MODEL_ID
					? { model: { provider: process.env.FAKE_RPC_MODEL_PROVIDER, id: process.env.FAKE_RPC_MODEL_ID } }
					: {}),
			});
			break;
		case "get_messages":
			respond(command, { messages: [{ role: "assistant", content: "synthetic answer" }] });
			break;
		case "get_entries":
			respond(command, { entries: [{ id: "entry-1" }], leafId: "entry-1" });
			break;
		case "get_session_stats":
			respond(command, { totalMessages: 2 });
			break;
		case "get_last_assistant_text":
			respond(command, { text: "synthetic answer" });
			break;
		default:
			emit({ type: "response", id: command.id, command: command.type, success: false, error: `unsupported ${command.type}` });
	}
}

process.stdin.on("data", (chunk) => {
	buffer += decoder.write(chunk);
	while (true) {
		const newline = buffer.indexOf("\n");
		if (newline === -1) break;
		const line = buffer.slice(0, newline).replace(/\r$/, "");
		buffer = buffer.slice(newline + 1);
		handle(JSON.parse(line));
	}
});
