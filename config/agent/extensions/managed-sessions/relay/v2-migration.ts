import { randomUUID } from "node:crypto";
import { lstat, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { MANAGED_SESSION_STATE_VERSION } from "../contracts.js";
import { MANAGED_SESSION_V2_VERSION, migrateV1Bundle } from "../v2-contracts.js";
import { ensurePrivateDirectory } from "./atomic-json.js";

const MANIFEST_NAME = /^conv_[a-f0-9]{32}\.json$/;
const MARKER_NAME = "v1-to-v2-migration.json";

async function readJson(path: string): Promise<unknown> {
	try { return JSON.parse(await readFile(path, "utf8")) as unknown; }
	catch (error) { throw new Error(`Managed-session migration cannot read valid JSON at ${path}: ${error instanceof Error ? error.message : "invalid JSON"}`); }
}

async function syncDirectory(path: string): Promise<void> {
	const directory = await open(path, "r");
	try { await directory.sync(); } finally { await directory.close(); }
}

async function durableWrite(path: string, value: unknown): Promise<string> {
	const directory = await ensurePrivateDirectory(dirname(path));
	const temporary = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.migration`);
	const file = await open(temporary, "wx", 0o600);
	try { await file.writeFile(`${JSON.stringify(value, null, 2)}\n`); await file.sync(); }
	finally { await file.close(); }
	return temporary;
}

/**
 * Performs the reviewed one-way store conversion. The marker deliberately
 * remains after any interrupted commit: startup must fail closed rather than
 * guessing which side of the multi-file transaction is authoritative.
 */
export async function migrateManagedSessionStoresV1ToV2(runtimeFile: string, manifestRoot: string): Promise<void> {
	const registryPath = resolve(runtimeFile);
	const root = await ensurePrivateDirectory(manifestRoot);
	const markerPath = join(dirname(registryPath), MARKER_NAME);
	try { await lstat(markerPath); throw new Error(`Interrupted managed-session v1-to-v2 migration detected at ${markerPath}; restore the complete v1 backup or the complete v2 destination`); }
	catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }

	const runtime = await readJson(registryPath);
	const runtimeVersion = (runtime as { schemaVersion?: unknown } | null)?.schemaVersion;
	const entries = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isFile() && MANIFEST_NAME.test(entry.name)).sort((a, b) => a.name.localeCompare(b.name));
	const manifests = await Promise.all(entries.map((entry) => readJson(join(root, entry.name))));
	const versions = new Set(manifests.map((value) => (value as { schemaVersion?: unknown } | null)?.schemaVersion));
	if (runtimeVersion === MANAGED_SESSION_V2_VERSION && (versions.size === 0 || (versions.size === 1 && versions.has(MANAGED_SESSION_V2_VERSION)))) throw new Error("Managed-session state is already v2; downgrade and repeated migration are forbidden");
	if (runtimeVersion !== MANAGED_SESSION_STATE_VERSION || [...versions].some((version) => version !== MANAGED_SESSION_STATE_VERSION)) throw new Error("Managed-session migration found an unknown or partially migrated manifest/registry version");

	const migrated = migrateV1Bundle(manifests, runtime);
	const stagedManifests = await Promise.all(migrated.manifests.map(async (manifest) => ({
		target: join(root, `${manifest.conversationId}.json`), temporary: await durableWrite(join(root, `${manifest.conversationId}.json`), manifest),
	})));
	const stagedRuntime = await durableWrite(registryPath, migrated.runtime);
	const markerTemporary = await durableWrite(markerPath, { operation: "managed-session-v1-to-v2", sourceVersion: MANAGED_SESSION_STATE_VERSION, destinationVersion: MANAGED_SESSION_V2_VERSION, conversations: migrated.manifests.map((item) => item.conversationId) });
	await rename(markerTemporary, markerPath);
	await syncDirectory(dirname(markerPath));
	try {
		for (const item of stagedManifests) await rename(item.temporary, item.target);
		await syncDirectory(root);
		await rename(stagedRuntime, registryPath);
		await syncDirectory(dirname(registryPath));
		await rm(markerPath);
		await syncDirectory(dirname(markerPath));
	} catch (error) {
		throw new Error(`Managed-session v1-to-v2 migration was interrupted; marker retained at ${markerPath}: ${error instanceof Error ? error.message : "commit failed"}`);
	}
}
