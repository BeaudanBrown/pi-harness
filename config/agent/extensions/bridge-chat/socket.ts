import http from "node:http";
import fs from "node:fs";
import { MAX_ANSWER, MAX_QUESTION } from "./limits.js";

export const MODEL_TIMEOUT_MS = 90000;
export const WORKSPACE_TIMEOUT_MS = 600000;
export function createQuestionServer(execute: (question: string, signal: AbortSignal, workspace: boolean) => Promise<string>): http.Server {
	let busy = false;
	const server = http.createServer(async (req, res) => {
		const reject = (status: number) => { if (!res.destroyed && !res.writableEnded) { res.writeHead(status, { "content-type": "application/json", connection: "close" }); res.end('{"error":"unavailable"}'); } };
		if (req.method !== "POST" || req.url !== "/answer") { reject(404); return; }
		if (busy) { reject(503); return; }
		busy = true;
		const controller = new AbortController();
		const expire = () => { controller.abort(); reject(504); req.destroy(); };
		let timer = setTimeout(expire, MODEL_TIMEOUT_MS);
		res.on("close", () => { if (!res.writableEnded) controller.abort(); });
		try {
			const chunks: Buffer[] = []; let size = 0;
			for await (const chunk of req) {
				size += chunk.length; if (size > MAX_QUESTION * 6 + 100) throw Error("Request size");
				chunks.push(Buffer.from(chunk));
			}
			const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			if (!value || ![1, 2].includes(Object.keys(value).length) || Object.keys(value).some(key => !["question", "workspace"].includes(key)) ||
				(Object.hasOwn(value, "workspace") && value.workspace !== true) || typeof value.question !== "string" ||
				!value.question.trim() || Buffer.byteLength(value.question) > MAX_QUESTION) throw Error("Request shape");
			if (value.workspace) { clearTimeout(timer); timer = setTimeout(expire, WORKSPACE_TIMEOUT_MS); }
			const result = await execute(value.question, controller.signal, value.workspace === true);
			if (typeof result !== "string" || !result || Buffer.byteLength(result) > MAX_ANSWER) throw Error("Answer size");
			if (!res.destroyed && !res.writableEnded) { res.writeHead(200, { "content-type": "application/json", connection: "close" }); res.end(JSON.stringify({ answer: result })); }
		} catch { console.error('{"event":"model_request_failed"}'); reject(502); }
		finally { clearTimeout(timer); busy = false; }
	});
	server.headersTimeout = 10000; server.requestTimeout = WORKSPACE_TIMEOUT_MS; server.maxConnections = 4;
	return server;
}
export function listenPrivate(server: http.Server, socketPath: string): void {
	try { fs.unlinkSync(socketPath); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
	server.listen(socketPath, () => { fs.chmodSync(socketPath, 0o660); console.log('{"event":"model_socket_ready","backendVerified":false}'); });
	server.on("error", () => process.exit(1));
	process.on("SIGTERM", () => { server.close(); setTimeout(() => process.exit(0), 1000).unref(); });
}
export function modelAnswer(socketPath: string, question: string, signal?: AbortSignal, workspace = false): Promise<string> {
	const timeout = (workspace ? WORKSPACE_TIMEOUT_MS : MODEL_TIMEOUT_MS) + 5000;
	return new Promise((resolve, reject) => {
		const request = http.request({ socketPath, path: "/answer", method: "POST", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout),
			headers: { "content-type": "application/json" } }, response => {
			let size = 0; const chunks: Buffer[] = [];
			response.on("error", reject);
			response.on("data", chunk => { size += chunk.length; if (size > MAX_ANSWER * 6 + 100) { response.destroy(Error("Response size")); return; } chunks.push(Buffer.from(chunk)); });
			response.on("end", () => {
				try {
					const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
					if (response.statusCode !== 200 || !value || Object.keys(value).length !== 1 || typeof value.answer !== "string" || !value.answer || Buffer.byteLength(value.answer) > MAX_ANSWER) throw Error("Worker unavailable");
					resolve(value.answer);
				} catch { reject(Error("Worker unavailable")); }
			});
		});
		request.on("error", () => reject(Error("Worker unavailable")));
		request.end(JSON.stringify({ question, ...(workspace ? { workspace: true } : {}) }));
	});
}
