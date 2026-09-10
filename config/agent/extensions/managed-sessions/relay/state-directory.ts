import { randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { ensurePrivateDirectory } from "./atomic-json.js";
import { ConversationManifestStore } from "./manifest-store.js";
import { RelayRegistry } from "./registry.js";

async function exists(path: string): Promise<boolean> {
	try { await lstat(path); return true; }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

async function syncPath(path: string): Promise<void> {
	const handle = await open(path, "r");
	try { await handle.sync(); } finally { await handle.close(); }
}

async function copyPrivateTree(source: string, destination: string): Promise<void> {
	const info = await lstat(source);
	if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile()) || (info.mode & 0o077) !== 0 ||
		(process.getuid && info.uid !== process.getuid())) throw new Error("Legacy relay state must contain only private relay-user files and directories; relocation refused");
	if (info.isDirectory()) {
		await mkdir(destination, { mode: 0o700 });
		for (const name of await readdir(source)) await copyPrivateTree(join(source, name), join(destination, name));
	} else {
		await copyFile(source, destination);
	}
	await syncPath(destination);
}

/** Called only while holding the host relay lock. Never merges two state stores. */
export async function prepareRelayStateDirectory(hostId: string, stateRoot: string, runtimeRoot: string, manifests: ConversationManifestStore): Promise<string> {
	const state = resolve(stateRoot); const runtime = resolve(runtimeRoot);
	if (state === runtime || state.startsWith(`${runtime}${sep}`) || runtime.startsWith(`${state}${sep}`)) {
		throw new Error("Relay persistent state and volatile runtime directories must be separate, non-nested paths");
	}
	if (await exists(state)) {
		await ensurePrivateDirectory(state);
		if (!await exists(join(state, "registry.json"))) throw new Error("Persistent relay state is incomplete; restore the complete backup, do not rebootstrap");
		// A committed destination is authoritative, even if the retained legacy copy
		// is stale. Registry.load validates the complete manifest/runtime pair.
		return state;
	}
	await ensurePrivateDirectory(dirname(state));
	const staging = `${state}.relocating-${randomUUID()}`;
	await mkdir(staging, { mode: 0o700 });
	try {
		const names = ["registry.json", "activities.json", "media-spool", "project-sessions"];
		if (await exists(runtime)) {
			await ensurePrivateDirectory(runtime);
			const present: string[] = [];
			for (const name of names) if (await exists(join(runtime, name))) present.push(name);
			if (present.length && !present.includes("registry.json")) throw new Error("Legacy relay state is incomplete; restore the complete backup before relocation");
			for (const name of present) await copyPrivateTree(join(runtime, name), join(staging, name));
		}
		// Validate copied primary JSON/manifest identities or initialize bootstrap
		// state before publication. Temporary files are never recovery sources.
		await new RelayRegistry(hostId, staging, manifests).load();
		await syncPath(staging);
		await rename(staging, state);
		await syncPath(dirname(state));
		return state;
	} catch (error) {
		await rm(staging, { recursive: true, force: true });
		throw error;
	}
}
