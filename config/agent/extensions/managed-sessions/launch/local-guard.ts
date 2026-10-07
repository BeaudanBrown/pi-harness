import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { inspectSavedHistory } from "./history.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type HistorySdk = { parseSessionEntries(text: string): readonly unknown[]; CURRENT_SESSION_VERSION: number };

export function isOwnedSessionPath(path: string, root?: string): boolean {
	if (!root) return false;
	const suffix = relative(resolve(root), resolve(path));
	return suffix === "" || (!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith("../"));
}

async function canonicalStorage(path: string): Promise<string> {
	let parent = resolve(path); const suffix: string[] = [];
	for (;;) {
		try { return resolve(await realpath(parent), ...suffix); }
		catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT") || dirname(parent) === parent) throw error;
			const info = await lstat(parent).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
			if (info?.isSymbolicLink()) throw new Error("Dangling storage aliases cannot be opened locally");
			suffix.unshift(basename(parent)); parent = dirname(parent);
		}
	}
}

export async function assertLocalStorage(path: string, root?: string, defaultTree = false): Promise<void> {
	if (!root) return;
	const [storage, owned] = await Promise.all([canonicalStorage(path), canonicalStorage(root)]);
	if (isOwnedSessionPath(storage, owned) || (defaultTree && isOwnedSessionPath(owned, storage))) throw new Error("Local sessions cannot write into host-owned storage");
}

/** Offline pre-open guard; never contacts the relay or constructs a session manager. */
export async function assertLocalHistory(path: string, sdk: HistorySdk, root?: string, allowMissing = false): Promise<void> {
	let canonical: string;
	try { canonical = await realpath(path); }
	catch (error) {
		if (allowMissing && error instanceof Error && "code" in error && error.code === "ENOENT") { await canonicalStorage(path); await assertLocalStorage(path, root); return; }
		throw error;
	}
	if (canonical !== resolve(path) || isOwnedSessionPath(canonical, root ? await canonicalStorage(root) : undefined)) throw new Error("Host-owned or aliased history cannot be opened locally; use managed resume");
	const info = await lstat(canonical);
	if (!info.isFile() || info.nlink !== 1 || (process.getuid && info.uid !== process.getuid())) throw new Error("Saved history is not a private, unaliased user file");
	if (inspectSavedHistory(await readFile(canonical, "utf8"), sdk.parseSessionEntries, sdk.CURRENT_SESSION_VERSION).managedMarkers) {
		throw new Error("Managed history cannot be resumed with pi-local-only; use managed resume");
	}
}

export function registerLocalNavigationGuard(pi: ExtensionAPI, sdk: HistorySdk, root?: string): void {
	pi.on("session_before_switch", async (event, ctx) => {
		try {
			if (event.reason === "resume" && event.targetSessionFile) await assertLocalHistory(event.targetSessionFile, sdk, root);
			else await assertLocalStorage(ctx.sessionManager.getSessionDir(), root);
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : "Local history open refused", "warning");
			return { cancel: true };
		}
	});
	pi.on("session_before_fork", async (_event, ctx) => {
		try { await assertLocalStorage(ctx.sessionManager.getSessionDir(), root); }
		catch (error) { ctx.ui.notify(error instanceof Error ? error.message : "Local fork refused", "warning"); return { cancel: true }; }
	});
}
