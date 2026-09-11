/** Account-local Matrix JSON transport; callers own room policy, cursors and retry safety. */
export interface MatrixRetryOptions {
	maxAttempts?: number;
	baseDelayMs?: number;
	maxDelayMs?: number;
	random?: () => number;
	sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}
export class MatrixError extends Error {
	constructor(readonly code: "cancelled" | "http" | "invalid_response" | "network", message: string,
		readonly status?: number, readonly retryable = false, readonly retryAfterMs?: number) {
		super(message); this.name = "MatrixError";
	}
}
export const MAX_MATRIX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_RETRY_AFTER_MS = 120_000;
export function matrixDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.reject(new MatrixError("cancelled", "Matrix request was cancelled"));
	return new Promise((resolve, reject) => {
		const finish = () => { signal?.removeEventListener("abort", abort); resolve(); };
		const timer = setTimeout(finish, milliseconds);
		const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(new MatrixError("cancelled", "Matrix request was cancelled")); };
		signal?.addEventListener("abort", abort, { once: true });
	});
}
export class MatrixHttp {
	readonly homeserver: string;
	readonly retry: Required<MatrixRetryOptions>;
	readonly #token: string;
	constructor(config: { homeserver: string; accessToken: string }, private readonly fetchImplementation: typeof fetch = fetch, retry: MatrixRetryOptions = {}) {
		const parsed = new URL(config.homeserver);
		if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== "/") throw Error("Matrix homeserver must be a credential-free HTTPS origin");
		if (!config.accessToken || config.accessToken.length > 4096 || /[\s\x00-\x1f\x7f]/.test(config.accessToken)) throw Error("Invalid Matrix credential");
		this.homeserver = parsed.origin; this.#token = config.accessToken;
		this.retry = { maxAttempts: retry.maxAttempts ?? 5, baseDelayMs: retry.baseDelayMs ?? 250, maxDelayMs: retry.maxDelayMs ?? 30000, random: retry.random ?? Math.random, sleep: retry.sleep ?? matrixDelay };
		if (!Number.isSafeInteger(this.retry.maxAttempts) || this.retry.maxAttempts < 1 || this.retry.maxAttempts > 10 ||
			!Number.isFinite(this.retry.baseDelayMs) || !Number.isFinite(this.retry.maxDelayMs) || this.retry.baseDelayMs < 1 ||
			this.retry.maxDelayMs < this.retry.baseDelayMs || this.retry.maxDelayMs > MAX_RETRY_AFTER_MS) throw Error("Invalid Matrix retry policy");
	}
	async sync(query: URLSearchParams, signal?: AbortSignal): Promise<{ nextBatch: string; response: unknown }> {
		const response = await this.request("GET", `/_matrix/client/v3/sync?${query}`, undefined, signal);
		const nextBatch = (response as { next_batch?: unknown } | null)?.next_batch;
		if (typeof nextBatch !== "string" || !nextBatch || nextBatch.length > 16384) throw new MatrixError("invalid_response", "Matrix sync omitted its cursor");
		return { nextBatch, response };
	}
	async request(method: string, path: string, body?: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
		if (!path.startsWith("/_matrix/") || new URL(path, this.homeserver).origin !== this.homeserver) throw Error("Invalid Matrix request path");
		const safePath = path.split("?")[0]; let last: MatrixError | undefined;
		for (let attempt = 0; attempt < this.retry.maxAttempts; attempt++) {
			const deadline = AbortSignal.timeout(45000);
			const boundedSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
			if (boundedSignal.aborted) throw new MatrixError("cancelled", "Matrix request was cancelled");
			try {
				const response = await this.fetchImplementation(new URL(path, this.homeserver), { method, redirect: "error", headers: {
					Authorization: `Bearer ${this.#token}`, ...(body ? { "Content-Type": "application/json" } : {}),
				}, body: body ? JSON.stringify(body) : undefined, signal: boundedSignal });
				const declared = response.headers.get("content-length");
				if (declared !== null && Number(declared) > MAX_MATRIX_RESPONSE_BYTES) {
					await response.body?.cancel().catch(() => {});
					throw new MatrixError("invalid_response", "Matrix response exceeded the size limit");
				}
				const chunks: Uint8Array[] = []; let size = 0;
				if (response.body) {
					const reader = response.body.getReader();
					try {
						while (true) {
							const next = await reader.read(); if (next.done) break;
							boundedSignal.throwIfAborted(); size += next.value.length;
							if (size > MAX_MATRIX_RESPONSE_BYTES) throw new MatrixError("invalid_response", "Matrix response exceeded the size limit");
							chunks.push(next.value);
						}
					} finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
				}
				const text = Buffer.concat(chunks).toString("utf8"); let parsed: unknown = {};
				try { parsed = text === "" ? {} : JSON.parse(text); }
				catch { if (response.ok) throw new MatrixError("invalid_response", `Matrix ${method} ${safePath} returned invalid JSON`); }
				if (response.ok) return parsed;
				const retryAfter = response.status === 429 && typeof parsed === "object" && parsed !== null && Number.isSafeInteger((parsed as Record<string, unknown>).retry_after_ms)
					? Math.min(MAX_RETRY_AFTER_MS, Math.max(0, Number((parsed as Record<string, unknown>).retry_after_ms))) : undefined;
				last = new MatrixError("http", `Matrix ${method} ${safePath} returned HTTP ${response.status}`, response.status, response.status === 429 || response.status >= 500, retryAfter);
			} catch (error) {
				if (error instanceof MatrixError) last = error;
				else if (signal?.aborted || (!deadline.aborted && error instanceof Error && error.name === "AbortError")) throw new MatrixError("cancelled", "Matrix request was cancelled");
				else last = new MatrixError("network", `Matrix ${method} ${safePath} failed`, undefined, true);
			}
			if (!last.retryable || !["GET", "PUT"].includes(method) || attempt + 1 >= this.retry.maxAttempts) throw last;
			const exponential = Math.min(this.retry.maxDelayMs, this.retry.baseDelayMs * 2 ** attempt);
			await this.retry.sleep(Math.max(last.retryAfterMs ?? 0, Math.floor(exponential * (0.5 + Math.max(0, Math.min(1, this.retry.random())) * 0.5))), signal);
		}
		throw last ?? new MatrixError("network", "Matrix request failed", undefined, true);
	}
}
