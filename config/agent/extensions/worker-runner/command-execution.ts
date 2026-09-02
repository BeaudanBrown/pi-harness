import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import * as path from "node:path";

export type DurableCommandResult = {
	version: 1;
	command: string[];
	cwd: string;
	startedAt: string;
	finishedAt: string;
	code: number | null;
	signal: NodeJS.Signals | null;
	durationMs: number;
	timedOut: boolean;
	cancelled: boolean;
	spawnError?: string;
	stdout: string;
	stderr: string;
	logPath: string;
};

const MAX_CAPTURE_BYTES = 5 * 1024 * 1024;
const DEFAULT_SHUTDOWN_GRACE_MS = 2_000;

export function shellDisplay(command: string[]): string {
	return command.map((part) => (part.match(/^[A-Za-z0-9_./:=@+-]+$/) ? part : JSON.stringify(part))).join(" ");
}

function truncateTail(value: string, maxBytes: number): string {
	const bytes = Buffer.byteLength(value, "utf8");
	if (bytes <= maxBytes) return value;
	return Buffer.from(value, "utf8").subarray(bytes - maxBytes).toString("utf8");
}

function appendBounded(current: string, chunk: Buffer): string {
	return truncateTail(current + chunk.toString(), MAX_CAPTURE_BYTES);
}

export function balancedLogExcerpt(value: string, maxBytes: number): string {
	const bytes = Buffer.from(value, "utf8");
	if (bytes.length <= maxBytes) return value;
	const marker = Buffer.from(`\n\n[${bytes.length - maxBytes} middle bytes omitted]\n\n`, "utf8");
	const available = Math.max(0, maxBytes - marker.length);
	const headBytes = Math.ceil(available / 2);
	const tailBytes = Math.floor(available / 2);
	return Buffer.concat([bytes.subarray(0, headBytes), marker, bytes.subarray(bytes.length - tailBytes)]).toString("utf8");
}

export function deterministicCommandSummary(name: string, result: Pick<DurableCommandResult, "timedOut" | "cancelled" | "code" | "stdout" | "stderr">, maxBytes = 8_000): string {
	const status = result.cancelled ? "cancelled" : result.timedOut ? "timed out" : result.code === 0 ? "passed" : `failed with exit code ${result.code ?? "unknown"}`;
	const excerpt = balancedLogExcerpt([result.stdout, result.stderr].filter(Boolean).join("\n"), maxBytes);
	return [`${name}: ${status}.`, excerpt ? `Relevant output:\n${excerpt}` : undefined].filter(Boolean).join("\n\n");
}

async function terminateProcessGroup(pid: number, graceMs: number): Promise<void> {
	const signal = (name: NodeJS.Signals) => {
		try { process.kill(-pid, name); } catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
		}
	};
	const alive = () => {
		try { process.kill(-pid, 0); return true; } catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
			throw error;
		}
	};
	signal("SIGTERM");
	const deadline = Date.now() + graceMs;
	while (alive() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
	if (alive()) {
		signal("SIGKILL");
		const killDeadline = Date.now() + graceMs;
		while (alive() && Date.now() < killDeadline) await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

async function atomicJson(pathname: string, value: unknown): Promise<void> {
	await mkdir(path.dirname(pathname), { recursive: true, mode: 0o700 });
	const temporary = `${pathname}.tmp-${process.pid}-${Date.now()}`;
	await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	await rename(temporary, pathname);
}

export async function runDurableCommand(options: {
	cwd: string;
	command: string[];
	logPath: string;
	resultPath: string;
	timeoutMs: number;
	signal?: AbortSignal;
	shutdownGraceMs?: number;
}): Promise<DurableCommandResult> {
	if (process.platform !== "linux" && process.platform !== "darwin") throw new Error("Durable command execution requires process-group cleanup on Linux or macOS.");
	if (options.command.length === 0 || options.command.some((part) => !part)) throw new Error("Command must be a non-empty argv array.");
	await mkdir(path.dirname(options.logPath), { recursive: true, mode: 0o700 });
	const log = createWriteStream(options.logPath, { encoding: "utf8", flags: "wx", mode: 0o600 });
	await new Promise<void>((resolve, reject) => {
		log.once("open", () => resolve());
		log.once("error", reject);
	});
	const started = Date.now();
	const startedAt = new Date(started).toISOString();
	let stdout = "";
	let stderr = "";
	let timedOut = false;
	let cancelled = options.signal?.aborted === true;
	let stopping: Promise<void> | null = null;
	log.write(`$ ${shellDisplay(options.command)}\ncwd: ${options.cwd}\nstarted: ${startedAt}\n\n`);

	const result = await new Promise<DurableCommandResult>((resolve) => {
		if (cancelled) {
			const finishedAt = new Date().toISOString();
			log.end(() => resolve({ version: 1, command: options.command, cwd: options.cwd, startedAt, finishedAt, code: null, signal: null, durationMs: Date.now() - started, timedOut, cancelled, stdout, stderr, logPath: options.logPath }));
			return;
		}
		const child = spawn(options.command[0]!, options.command.slice(1), {
			cwd: options.cwd,
			env: process.env,
			stdio: ["ignore", "pipe", "pipe"],
			detached: true,
		});
		let settled = false;
		const stop = (reason: "timeout" | "cancelled") => {
			if (!child.pid || stopping) return;
			timedOut = reason === "timeout";
			cancelled = reason === "cancelled";
			stopping = terminateProcessGroup(child.pid, options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS);
		};
		const timer = setTimeout(() => stop("timeout"), options.timeoutMs);
		const abort = () => stop("cancelled");
		options.signal?.addEventListener("abort", abort, { once: true });
		child.stdout.on("data", (chunk: Buffer) => { stdout = appendBounded(stdout, chunk); log.write(chunk); });
		child.stderr.on("data", (chunk: Buffer) => { stderr = appendBounded(stderr, chunk); log.write(chunk); });
		const finish = async (code: number | null, signal: NodeJS.Signals | null, spawnError?: string) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", abort);
			// A successful process may detach descendants with redirected stdio and
			// exit before them. Own the complete group for every outcome, not only
			// timeout/cancellation, so no command can outlive its durable result.
			if (!stopping && child.pid) stopping = terminateProcessGroup(child.pid, options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS);
			await stopping;
			const finishedAt = new Date().toISOString();
			const durationMs = Date.now() - started;
			log.write(`\n\nfinished: ${finishedAt}\nexit_code: ${code ?? "null"}\nsignal: ${signal ?? "none"}\nduration_ms: ${durationMs}\ntimed_out: ${timedOut}\ncancelled: ${cancelled}\n`);
			await new Promise<void>((done) => log.end(done));
			resolve({ version: 1, command: options.command, cwd: options.cwd, startedAt, finishedAt, code, signal, durationMs, timedOut, cancelled, ...(spawnError ? { spawnError } : {}), stdout, stderr, logPath: options.logPath });
		};
		child.once("error", (error) => void finish(null, null, error.message));
		child.once("close", (code, signal) => void finish(code, signal));
	});
	await atomicJson(options.resultPath, result);
	return result;
}

export async function writeDurableResult(pathname: string, value: unknown): Promise<void> {
	await atomicJson(pathname, value);
}
