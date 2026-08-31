import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export type JsonParser<T> = (value: unknown) => T;

function isMissing(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function fsyncDirectory(path: string): Promise<void> {
	const directory = await open(path, "r");
	try {
		await directory.sync();
	} finally {
		await directory.close();
	}
}

export async function ensurePrivateDirectory(path: string): Promise<string> {
	const absolute = resolve(path);
	await mkdir(absolute, { recursive: true, mode: 0o700 });
	const info = await lstat(absolute);
	if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Private runtime path is not a directory: ${absolute}`);
	const uid = process.getuid?.();
	if (uid !== undefined && info.uid !== uid) throw new Error(`Private runtime path is owned by another user: ${absolute}`);
	if ((info.mode & 0o077) !== 0) await chmod(absolute, 0o700);
	return absolute;
}

export class AtomicJsonFile<T> {
	readonly path: string;

	constructor(path: string, private readonly parser: JsonParser<T>) {
		this.path = resolve(path);
	}

	async read(): Promise<T | undefined> {
		let text: string;
		try {
			text = await readFile(this.path, "utf8");
		} catch (error) {
			if (isMissing(error)) return undefined;
			throw error;
		}
		let value: unknown;
		try {
			value = JSON.parse(text) as unknown;
		} catch {
			throw new Error(`Malformed durable JSON file: ${this.path}`);
		}
		return this.parser(value);
	}

	async write(value: T): Promise<void> {
		const parsed = this.parser(value);
		const directory = await ensurePrivateDirectory(dirname(this.path));
		const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
		const file = await open(temporary, "wx", 0o600);
		try {
			await file.writeFile(`${JSON.stringify(parsed, null, 2)}\n`, "utf8");
			await file.sync();
		} catch (error) {
			await file.close();
			await rm(temporary, { force: true });
			throw error;
		}
		await file.close();
		try {
			await rename(temporary, this.path);
			await chmod(this.path, 0o600);
			await fsyncDirectory(directory);
		} catch (error) {
			await rm(temporary, { force: true });
			throw error;
		}
	}
}
