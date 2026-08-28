import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { isDeepStrictEqual } from "node:util";

export interface RpcUiDialogPolicy {
	request: Record<string, unknown> & { method: "select" | "confirm" | "input" | "editor" };
	response: { value: string } | { confirmed: boolean } | { cancelled: true };
}

export interface RpcUiPolicy {
	schemaVersion: "2.0.0" | "3.0.0";
	dialogs: RpcUiDialogPolicy[];
}

export interface PiRpcEngineOptions {
	command: string;
	args?: string[];
	cwd?: string;
	env?: Record<string, string>;
	commandTimeoutMs?: number;
	promptTimeoutMs?: number;
	runTimeoutMs?: number;
	shutdownGraceMs?: number;
	uiPolicy?: RpcUiPolicy;
}

export interface RpcRecord {
	type: string;
	[key: string]: unknown;
}

export interface RpcDiagnostics {
	commands: RpcRecord[];
	records: RpcRecord[];
	recordedAtMs?: number[];
	stdoutLines: string[];
	stderr: string;
	stderrBytes?: Uint8Array;
	malformedLine: string | null;
	exit: { code: number | null; signal: NodeJS.Signals | null } | null;
}

export interface RpcRunResult {
	settled: true;
	events: RpcRecord[];
	state: unknown;
	messages: unknown[];
	entries: unknown;
	sessionStats: unknown;
	finalAssistantText: string | null;
}

interface PendingRequest {
	command: string;
	resolve: (record: RpcRecord) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

interface EventWaiter {
	afterRecordIndex: number;
	resolve: (index: number) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
	cleanup: () => void;
}

export class RpcEngineError extends Error {
	constructor(message: string, readonly diagnostics: RpcDiagnostics) {
		super(message);
		this.name = "RpcEngineError";
	}
}

export class PiRpcEngine {
	private readonly options: Required<Pick<PiRpcEngineOptions, "commandTimeoutMs" | "promptTimeoutMs" | "runTimeoutMs" | "shutdownGraceMs">> & PiRpcEngineOptions;
	private child: ChildProcessWithoutNullStreams | null = null;
	private childClosed: Promise<void> | null = null;
	private decoder = new StringDecoder("utf8");
	private stdoutBuffer = "";
	private requestSequence = 0;
	private pending = new Map<string, PendingRequest>();
	private eventWaiters = new Set<EventWaiter>();
	private commands: RpcRecord[] = [];
	private records: RpcRecord[] = [];
	private recordTimesMs: number[] = [];
	private recordIndexes = new WeakMap<object, number>();
	private events: RpcRecord[] = [];
	private stdoutLines: string[] = [];
	private stderrChunks: Buffer[] = [];
	private malformedLine: string | null = null;
	private exit: RpcDiagnostics["exit"] = null;
	private failure: RpcEngineError | null = null;
	private wholeRunTimer: NodeJS.Timeout | null = null;
	private stopping = false;

	constructor(options: PiRpcEngineOptions) {
		this.options = {
			commandTimeoutMs: 30_000,
			promptTimeoutMs: 60_000,
			runTimeoutMs: 300_000,
			shutdownGraceMs: 1_000,
			...options,
		};
		if (this.options.uiPolicy && !["2.0.0", "3.0.0"].includes(this.options.uiPolicy.schemaVersion)) {
			throw new Error("Pi RPC UI policy requires scenario schemaVersion 2.0.0 or 3.0.0; migrate the v1 dialog policy");
		}
		for (const dialog of this.options.uiPolicy?.dialogs ?? []) {
			const response = dialog.response;
			const valid = dialog.request.method === "confirm"
				? ("confirmed" in response && typeof response.confirmed === "boolean") || ("cancelled" in response && response.cancelled === true)
				: ("value" in response && typeof response.value === "string") || ("cancelled" in response && response.cancelled === true);
			if (!valid) throw new Error(`Invalid declared response for ${dialog.request.method} extension dialog`);
		}
	}

	async start(): Promise<void> {
		if (!(["linux", "darwin"] as string[]).includes(String(process.platform))) {
			throw new Error("Pi RPC evaluation supports only Linux and macOS process-group cleanup");
		}
		if (this.child) throw new Error("Pi RPC engine already started");
		this.stopping = false;
		const child = spawn(this.options.command, this.options.args ?? [], {
			cwd: this.options.cwd,
			env: { ...process.env, ...this.options.env },
			stdio: ["pipe", "pipe", "pipe"],
			detached: true,
		});
		this.child = child;
		this.childClosed = new Promise((resolve) => child.once("close", () => resolve()));
		child.stdout.on("data", (chunk: Buffer) => this.consumeStdout(chunk));
		child.stdout.on("end", () => this.finishStdout());
		child.stderr.on("data", (chunk: Buffer) => {
			this.stderrChunks.push(Buffer.from(chunk));
		});
		const spawned = new Promise<void>((resolve, reject) => {
			child.once("spawn", resolve);
			child.once("error", (error) => {
				this.fail(`RPC process error: ${error.message}`);
				reject(this.failure ?? error);
			});
		});
		child.once("exit", (code, signal) => {
			this.exit = { code, signal };
		});
		child.once("close", (code, signal) => {
			this.exit = { code, signal };
			if (!this.stopping) this.fail(`RPC process exited before shutdown (code=${code}, signal=${signal})`, true);
		});
		this.wholeRunTimer = setTimeout(() => {
			this.fail(`Whole RPC run timed out after ${this.options.runTimeoutMs}ms`, true);
		}, this.options.runTimeoutMs);
		try {
			await spawned;
		} catch (error) {
			if (this.wholeRunTimer) clearTimeout(this.wholeRunTimer);
			this.wholeRunTimer = null;
			throw error;
		}
	}

	async promptAndWait(message: string, signal?: AbortSignal): Promise<RpcRunResult> {
		if (signal?.aborted) {
			this.fail("Prompt cancelled", true);
			throw this.failure;
		}
		let abortDuringAcceptance: (() => void) | null = null;
		const cancellation = signal
			? new Promise<never>((_resolve, reject) => {
				abortDuringAcceptance = () => {
					this.fail("Prompt cancelled", true);
					reject(this.failure ?? new RpcEngineError("Prompt cancelled", this.getDiagnostics()));
				};
				signal.addEventListener("abort", abortDuringAcceptance, { once: true });
			})
			: null;
		let promptResponse: RpcRecord;
		try {
			const request = this.request({ type: "prompt", message });
			promptResponse = cancellation ? await Promise.race([request, cancellation]) : await request;
		} finally {
			if (signal && abortDuringAcceptance) signal.removeEventListener("abort", abortDuringAcceptance);
		}
		const acceptanceRecordIndex = this.recordIndexes.get(promptResponse);
		if (acceptanceRecordIndex === undefined) {
			throw new RpcEngineError("Accepted prompt response is missing its record position", this.getDiagnostics());
		}
		const firstEventIndex = this.events.findIndex((event) =>
			(this.recordIndexes.get(event) ?? -1) > acceptanceRecordIndex);
		const startIndex = firstEventIndex === -1 ? this.events.length : firstEventIndex;
		const settledIndex = await this.waitForSettled(acceptanceRecordIndex, signal);
		const events = this.events.slice(startIndex, settledIndex + 1);
		const [state, messages, entries, sessionStats, finalAssistantText] = await Promise.all([
			this.requestData({ type: "get_state" }),
			this.requestData({ type: "get_messages" }).then((data) => this.objectField(data, "messages") as unknown[]),
			this.requestData({ type: "get_entries" }),
			this.requestData({ type: "get_session_stats" }),
			this.requestData({ type: "get_last_assistant_text" }).then((data) => this.objectField(data, "text") as string | null),
		]);
		return { settled: true, events, state, messages, entries, sessionStats, finalAssistantText };
	}

	async request(command: RpcRecord, timeoutMs = this.options.commandTimeoutMs): Promise<RpcRecord> {
		if (this.failure) throw this.failure;
		const child = this.child;
		if (!child || child.exitCode !== null || !child.stdin.writable) {
			throw new RpcEngineError("RPC process is not writable", this.getDiagnostics());
		}
		const id = `eval-${++this.requestSequence}`;
		const outgoing = { ...command, id };
		this.commands.push(outgoing);
		return new Promise<RpcRecord>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				const error = new RpcEngineError(`RPC command ${command.type} timed out after ${timeoutMs}ms`, this.getDiagnostics());
				reject(error);
				this.fail(error.message, true);
			}, timeoutMs);
			this.pending.set(id, { command: String(command.type), resolve, reject, timer });
			child.stdin.write(`${JSON.stringify(outgoing)}\n`, (error) => {
				if (error) this.fail(`Failed to write RPC command: ${error.message}`);
			});
		});
	}

	getDiagnostics(): RpcDiagnostics {
		return {
			commands: structuredClone(this.commands),
			records: structuredClone(this.records),
			recordedAtMs: [...this.recordTimesMs],
			stdoutLines: [...this.stdoutLines],
			stderr: Buffer.concat(this.stderrChunks).toString("utf8"),
			stderrBytes: Buffer.concat(this.stderrChunks),
			malformedLine: this.malformedLine,
			exit: this.exit ? { ...this.exit } : null,
		};
	}

	async stop(): Promise<void> {
		if (this.wholeRunTimer) clearTimeout(this.wholeRunTimer);
		this.wholeRunTimer = null;
		const child = this.child;
		if (!child) return;
		this.stopping = true;
		this.rejectOutstanding(new RpcEngineError("RPC engine stopped", this.getDiagnostics()));
		const closed = this.childClosed;
		await this.terminateProcessTree(child);
		if (closed) await closed;
		this.child = null;
		this.childClosed = null;
	}

	private async requestData(command: RpcRecord): Promise<unknown> {
		const response = await this.request(command);
		if (response.success !== true) {
			throw new RpcEngineError(`RPC command ${command.type} failed: ${String(response.error)}`, this.getDiagnostics());
		}
		return response.data;
	}

	private objectField(value: unknown, key: string): unknown {
		if (value === null || typeof value !== "object" || !(key in value)) {
			throw new RpcEngineError(`RPC response data is missing ${key}`, this.getDiagnostics());
		}
		return (value as Record<string, unknown>)[key];
	}

	private waitForSettled(afterRecordIndex: number, signal?: AbortSignal): Promise<number> {
		const existing = this.events.findIndex((event) =>
			event.type === "agent_settled" && (this.recordIndexes.get(event) ?? -1) > afterRecordIndex);
		if (existing !== -1) return Promise.resolve(existing);
		return new Promise<number>((resolve, reject) => {
			let abort: (() => void) | null = null;
			const cleanup = (): void => {
				if (signal && abort) signal.removeEventListener("abort", abort);
			};
			const timer = setTimeout(() => {
				this.eventWaiters.delete(waiter);
				cleanup();
				const error = new RpcEngineError(`Prompt did not settle within ${this.options.promptTimeoutMs}ms`, this.getDiagnostics());
				reject(error);
				this.fail(error.message, true);
			}, this.options.promptTimeoutMs);
			const waiter: EventWaiter = { afterRecordIndex, resolve, reject, timer, cleanup };
			this.eventWaiters.add(waiter);
			if (signal) {
				abort = () => {
					clearTimeout(timer);
					this.eventWaiters.delete(waiter);
					cleanup();
					const error = new RpcEngineError("Prompt cancelled", this.getDiagnostics());
					reject(error);
					this.fail(error.message, true);
				};
				if (signal.aborted) abort();
				else signal.addEventListener("abort", abort, { once: true });
			}
		});
	}

	private consumeStdout(chunk: Buffer): void {
		this.stdoutBuffer += this.decoder.write(chunk);
		while (true) {
			const newline = this.stdoutBuffer.indexOf("\n");
			if (newline === -1) break;
			let line = this.stdoutBuffer.slice(0, newline);
			this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			this.handleLine(line);
		}
	}

	private finishStdout(): void {
		this.stdoutBuffer += this.decoder.end();
		if (this.stdoutBuffer.length > 0) {
			this.malformedLine = this.stdoutBuffer;
			this.stdoutLines.push(this.stdoutBuffer);
			this.stdoutBuffer = "";
			this.fail("Unterminated RPC JSONL record at EOF", true);
		}
	}

	private handleLine(line: string): void {
		this.stdoutLines.push(line);
		let record: RpcRecord;
		try {
			const parsed: unknown = JSON.parse(line);
			if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) || typeof (parsed as RpcRecord).type !== "string") {
				throw new Error("record must be an object with a string type");
			}
			record = parsed as RpcRecord;
		} catch (error) {
			this.malformedLine = line;
			this.fail(`Malformed RPC JSONL record: ${error instanceof Error ? error.message : String(error)}`, true);
			return;
		}
		this.records.push(record);
		this.recordTimesMs.push(Date.now());
		const recordIndex = this.records.length - 1;
		this.recordIndexes.set(record, recordIndex);
		if (record.type === "response") {
			const id = typeof record.id === "string" ? record.id : null;
			const pending = id ? this.pending.get(id) : undefined;
			if (!id || !pending) {
				this.fail(`Uncorrelated RPC response: ${id ?? "missing id"}`, true);
				return;
			}
			this.pending.delete(id);
			clearTimeout(pending.timer);
			if (record.command !== pending.command) {
				pending.reject(new RpcEngineError(`RPC response command mismatch for ${id}`, this.getDiagnostics()));
				this.fail(`RPC response command mismatch for ${id}`, true);
				return;
			}
			if (record.success !== true) {
				pending.reject(new RpcEngineError(`RPC command ${pending.command} failed: ${String(record.error)}`, this.getDiagnostics()));
				return;
			}
			pending.resolve(record);
			return;
		}
		this.events.push(record);
		if (record.type === "extension_ui_request") {
			this.handleExtensionUi(record);
		}
		if (record.type === "agent_settled") {
			const index = this.events.length - 1;
			for (const waiter of [...this.eventWaiters]) {
				if (recordIndex > waiter.afterRecordIndex) {
					clearTimeout(waiter.timer);
					this.eventWaiters.delete(waiter);
					waiter.cleanup();
					waiter.resolve(index);
				}
			}
		}
	}

	private handleExtensionUi(request: RpcRecord): void {
		const method = typeof request.method === "string" ? request.method : "";
		const dialogMethods = ["select", "confirm", "input", "editor"];
		const fireAndForgetMethods = [
			"notify",
			"setStatus",
			"setWidget",
			"setTitle",
			"set_editor_text",
			"setWorkingMessage",
			"setWorkingVisible",
			"setWorkingIndicator",
			"setHiddenThinkingLabel",
		];
		if (fireAndForgetMethods.includes(method)) return;
		if (!dialogMethods.includes(method)) {
			this.fail(`Unsupported extension UI request method: ${method || "missing"}`, true);
			return;
		}
		const { type: _type, id, ...matchable } = request;
		if (typeof id !== "string") {
			this.fail("Extension UI dialog is missing an id", true);
			return;
		}
		const declared = this.options.uiPolicy?.dialogs.find((dialog) => isDeepStrictEqual(dialog.request, matchable));
		const response = declared?.response ?? (method === "confirm" ? { confirmed: false } : { cancelled: true as const });
		this.writeUncorrelated({ type: "extension_ui_response", id, ...response });
	}

	private writeUncorrelated(command: RpcRecord): void {
		const child = this.child;
		if (!child || !child.stdin.writable) {
			this.fail("Cannot write extension UI response because RPC stdin is not writable", true);
			return;
		}
		this.commands.push(command);
		child.stdin.write(`${JSON.stringify(command)}\n`, (error) => {
			if (error) this.fail(`Failed to write RPC extension UI response: ${error.message}`, true);
		});
	}

	private fail(message: string, terminate = false): void {
		if (this.failure) return;
		this.failure = new RpcEngineError(message, this.getDiagnostics());
		this.rejectOutstanding(this.failure);
		if (terminate && this.child) {
			this.writeUncorrelated({ type: "abort", id: `eval-abort-${++this.requestSequence}` });
			void this.terminateProcessTree(this.child);
		}
	}

	private rejectOutstanding(error: Error): void {
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pending.clear();
		for (const waiter of this.eventWaiters) {
			clearTimeout(waiter.timer);
			waiter.cleanup();
			waiter.reject(error);
		}
		this.eventWaiters.clear();
	}

	private async terminateProcessTree(child: ChildProcessWithoutNullStreams): Promise<void> {
		const processGroup = child.pid;
		if (!processGroup) return;
		const signalTree = (signal: NodeJS.Signals): void => {
			try {
				process.kill(-processGroup, signal);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
			}
		};
		const groupIsAlive = (): boolean => {
			try {
				process.kill(-processGroup, 0);
				return true;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
				throw error;
			}
		};

		signalTree("SIGTERM");
		const deadline = Date.now() + this.options.shutdownGraceMs;
		while (groupIsAlive() && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		if (groupIsAlive()) signalTree("SIGKILL");
	}
}
