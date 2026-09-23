import { setTimeout as delay } from "node:timers/promises";
import { ManagedMatrixError } from "./matrix-client.js";

/** Keep local IPC alive while Matrix is temporarily unavailable. */
export async function retryMatrixStartup<T>(operation: () => Promise<T>, blocked: () => Promise<void>, signal?: AbortSignal,
	wait: (milliseconds: number, signal?: AbortSignal) => Promise<void> = async (milliseconds, signal) => { await delay(milliseconds, undefined, { signal }); }): Promise<T> {
	let attempt = 0;
	for (;;) {
		signal?.throwIfAborted();
		try { return await operation(); }
		catch (error) {
			if (!(error instanceof ManagedMatrixError) || !error.retryable) throw error;
			await blocked();
			await wait(Math.min(30_000, 1000 * 2 ** Math.min(attempt++, 5)) + Math.floor(Math.random() * 500), signal);
		}
	}
}
