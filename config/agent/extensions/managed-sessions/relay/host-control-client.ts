import { lstat } from "node:fs/promises";
import { createConnection } from "node:net";
import { dirname } from "node:path";
import { HOST_CONTROL_FRAME_BYTES, HOST_CONTROL_VERSION, parseHostRequest, parseHostResponse, type HostAction, type HostResponse } from "../live-workspace-contracts.js";
import { HostControlError, hostErrorResponse } from "./host-control-error.js";

export async function requestHostControl<O extends HostAction["operation"]>(options: {
	socketPath: string; action: Extract<HostAction, { operation: O }>; requestId: string; timeoutMs?: number;
}): Promise<HostResponse<O>> {
	try {
		let request;
		try {
			options = { ...options, action: structuredClone(options.action) };
			request = parseHostRequest({ version: HOST_CONTROL_VERSION, actor: { kind: "human_local", requestId: options.requestId }, action: options.action });
		}
		catch { throw new HostControlError("invalid_request", "Invalid host control request"); }
		// Resume includes bounded launcher admission plus the 60-second attachment
		// observation. A read/open deadline must not truncate that readiness contract.
		const limit = options.action.operation === "conversation.resume" ? 120_000 : 30_000;
		const timeout = options.timeoutMs ?? limit;
		if (!Number.isInteger(timeout) || timeout < 1 || timeout > limit) throw new HostControlError("invalid_request", "Invalid host control timeout");
		try {
			const directory = await lstat(dirname(options.socketPath)); const socket = await lstat(options.socketPath); const uid = process.getuid?.();
			if (uid === undefined || !directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== uid || (directory.mode & 0o077) !== 0 ||
				!socket.isSocket() || socket.isSymbolicLink() || socket.uid !== uid || (socket.mode & 0o777) !== 0o600)
				throw new HostControlError("forbidden", "Host control endpoint is not private and owned by this user");
		} catch (error) {
			if (error instanceof HostControlError) throw error;
			throw new HostControlError("unavailable", "Managed host controls are unavailable", true);
		}
		const value = await new Promise<unknown>((done, reject) => {
			const socket = createConnection(options.socketPath); let buffer = Buffer.alloc(0); let settled = false;
			const finish = (error?: HostControlError, result?: unknown) => {
				if (settled) return; settled = true; clearTimeout(deadline); socket.destroy();
				if (error) reject(error); else done(result);
			};
			const invalid = () => finish(new HostControlError("failed", "Invalid host control response"));
			const deadline = setTimeout(() => finish(new HostControlError("unavailable", "Host control request timed out", true)), timeout);
			socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
			socket.on("error", () => finish(new HostControlError("unavailable", "Managed host controls are unavailable", true)));
			socket.on("data", (chunk: Buffer) => {
				if (buffer.length + chunk.length > HOST_CONTROL_FRAME_BYTES) { invalid(); return; }
				buffer = Buffer.concat([buffer, chunk]);
			});
			socket.once("end", () => {
				if (!buffer.length) { finish(new HostControlError("unavailable", "Host control connection ended without a response", true)); return; }
				if (buffer.indexOf(10) !== buffer.length - 1) { invalid(); return; }
				try { finish(undefined, JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, -1)))); }
				catch { invalid(); }
			});
			socket.once("close", () => { if (!settled) finish(new HostControlError("unavailable", "Host control connection ended without a response", true)); });
		});
		if (value && typeof value === "object" && "version" in value && typeof value.version === "string" && value.version !== HOST_CONTROL_VERSION)
			throw new HostControlError("upgrade_required", "Unsupported host control response version");
		let response: HostResponse<O>;
		try { response = parseHostResponse(options.action.operation, value); }
		catch { throw new HostControlError("failed", "Invalid host control response"); }
		if (response.requestId !== options.requestId) throw new HostControlError("failed", "Host control response identity mismatch");
		return response;
	} catch (error) { return hostErrorResponse(options.requestId, error); }
}
