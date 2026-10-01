import { chmod, lstat, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { join, resolve } from "node:path";
import { HOST_CONTROL_FRAME_BYTES } from "../live-workspace-contracts.js";
import { ensurePrivateDirectory } from "./atomic-json.js";
import { HostDispatcher } from "./host-dispatcher.js";
import { HostControlError, hostErrorResponse } from "./host-control-error.js";
import type { PeerUidResolver } from "./ipc-server.js";

const MAX_CONNECTIONS = 64;

/** Caller must hold host ownership before start and through close's admitted-work drain. */
export class HostControlServer {
	readonly socketPath: string;
	private server?: Server;
	private startup?: Promise<void>;
	private readonly sockets = new Set<Socket>();
	private readonly work = new Set<Promise<unknown>>();
	private closing = false;
	private closeWork?: Promise<void>;
	private bound?: { ino: number; dev: number };
	private readonly directory: string;
	constructor(private readonly options: { runtimeDirectory: string; expectedUid: number; peerUid: PeerUidResolver; dispatcher: HostDispatcher }) {
		if (!Number.isInteger(options.expectedUid) || options.expectedUid < 0) throw Error("Host controls require an expected peer UID");
		this.options = { ...options }; this.directory = resolve(options.runtimeDirectory);
		this.socketPath = join(this.directory, "control.sock");
	}

	async start(): Promise<void> {
		if (this.startup || this.closing) throw Error("Host controls cannot be started twice");
		this.startup = this.startOnce();
		try { await this.startup; } catch (error) { await this.close(); throw error; }
	}

	private async startOnce(): Promise<void> {
		await ensurePrivateDirectory(this.directory);
		if (this.closing) return;
		try {
			const old = await lstat(this.socketPath);
			if (!old.isSocket() || old.isSymbolicLink() || old.uid !== this.options.expectedUid) throw Error("Refusing to replace an unowned host control path");
			await rm(this.socketPath);
		} catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
		this.server = createServer((socket) => { void this.track(this.accept(socket)).catch(() => socket.destroy()); });
		await new Promise<void>((done, reject) => {
			this.server!.once("error", reject);
			this.server!.listen(this.socketPath, () => { this.server!.off("error", reject); done(); });
		});
		this.bound = await lstat(this.socketPath);
		await chmod(this.socketPath, 0o600);
	}

	close(): Promise<void> { return this.closeWork ??= this.closeOnce(); }
	private async closeOnce(): Promise<void> {
		this.closing = true;
		await this.startup?.catch(() => undefined);
		for (const socket of this.sockets) socket.destroy();
		if (this.server) await new Promise<void>((done) => this.server!.close(() => done()));
		while (this.work.size) await Promise.allSettled([...this.work]);
		if (this.bound) {
			try {
				const current = await lstat(this.socketPath);
				if (current.ino === this.bound.ino && current.dev === this.bound.dev && current.isSocket()) await rm(this.socketPath);
			} catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
		}
	}

	private track<T>(work: Promise<T>): Promise<T> {
		this.work.add(work); void work.finally(() => this.work.delete(work)).catch(() => undefined); return work;
	}

	private reply(socket: Socket, response: unknown): void {
		const deadline = setTimeout(() => socket.destroy(), 5_000); deadline.unref();
		socket.once("close", () => clearTimeout(deadline));
		socket.end(`${JSON.stringify(response)}\n`, () => socket.destroy());
	}

	private async accept(socket: Socket): Promise<void> {
		socket.on("error", () => undefined); socket.pause();
		if (this.closing || this.sockets.size >= MAX_CONNECTIONS) { socket.destroy(); return; }
		this.sockets.add(socket);
		const deadline = setTimeout(() => socket.destroy(), 5_000); deadline.unref();
		socket.once("close", () => { clearTimeout(deadline); this.sockets.delete(socket); });
		let uid: number | undefined;
		try { uid = await this.options.peerUid(socket); } catch { socket.destroy(); return; }
		if (uid !== this.options.expectedUid || this.closing || socket.destroyed) { socket.destroy(); return; }
		let buffer = Buffer.alloc(0); let admitted = false;
		const reject = () => {
			admitted = true; socket.pause(); clearTimeout(deadline);
			this.reply(socket, hostErrorResponse("invalid-request", new HostControlError("invalid_request", "Invalid host control frame")));
		};
		socket.on("data", (chunk: Buffer) => {
			if (admitted || this.closing) return;
			if (buffer.length + chunk.length > HOST_CONTROL_FRAME_BYTES) { reject(); return; }
			buffer = Buffer.concat([buffer, chunk]);
			const newline = buffer.indexOf(10); if (newline < 0) return;
			if (newline !== buffer.length - 1) { reject(); return; }
			let input: unknown;
			try { input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, newline))); }
			catch { reject(); return; }
			admitted = true; socket.pause(); clearTimeout(deadline); buffer = Buffer.alloc(0);
			// The private CLI socket conveys only local-human authority. Model/Matrix
			// requesters must arrive through their separately authenticated frontends.
			const actorId = input && typeof input === "object" && "actor" in input && input.actor && typeof input.actor === "object" && "requestId" in input.actor && typeof input.actor.requestId === "string"
				? input.actor.requestId : "invalid-request";
			void this.track(this.options.dispatcher.dispatch(input, { kind: "human_local", requestId: actorId }).then((response) => {
				if (!socket.destroyed && !this.closing) this.reply(socket, response);
			})).catch(() => socket.destroy());
		});
		socket.on("end", () => { if (!admitted && !this.closing) reject(); });
		socket.resume();
	}
}
