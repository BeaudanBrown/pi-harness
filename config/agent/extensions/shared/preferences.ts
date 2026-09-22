import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function readJsonObject(file: string): Promise<Record<string, unknown>> {
	try {
		const value: unknown = JSON.parse(await readFile(file, "utf8"));
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Expected a JSON object: ${file}`);
		return value as Record<string, unknown>;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw error;
	}
}

// Each extension owns its whole file: no read/modify/write of Pi's shared settings.
// Existing settings remain a read-only fallback until the first preference save.
export async function loadPreference(key: string, agentDir: string): Promise<unknown> {
	try { return JSON.parse(await readFile(join(agentDir, `${key}.json`), "utf8")); }
	catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	return (await readJsonObject(join(agentDir, "settings.json")))[key];
}

export async function savePreference(key: string, value: unknown, agentDir: string): Promise<void> {
	await mkdir(agentDir, { recursive: true });
	const file = join(agentDir, `${key}.json`), temporary = `${file}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
		await rename(temporary, file);
	} finally { await rm(temporary, { force: true }); }
}
