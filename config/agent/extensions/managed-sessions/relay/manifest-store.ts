import { lstat, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { type ConversationManifest, parseConversationManifest } from "../contracts.js";
import { AtomicJsonFile, ensurePrivateDirectory } from "./atomic-json.js";

const MANIFEST_NAME = /^conv_[a-f0-9]{32}\.json$/;

export class ConversationManifestStore {
	readonly root: string;

	constructor(root: string) {
		this.root = resolve(root);
	}

	async list(): Promise<ConversationManifest[]> {
		await ensurePrivateDirectory(this.root);
		const entries = await readdir(this.root, { withFileTypes: true });
		const manifests: ConversationManifest[] = [];
		for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
			if (!entry.isFile() || !MANIFEST_NAME.test(entry.name)) continue;
			const path = join(this.root, entry.name);
			const info = await lstat(path);
			if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Unsafe conversation manifest: ${path}`);
			const manifest = await new AtomicJsonFile(path, parseConversationManifest).read();
			if (!manifest || `${manifest.conversationId}.json` !== entry.name) throw new Error(`Conversation manifest filename mismatch: ${path}`);
			manifests.push(manifest);
		}
		return manifests;
	}

	async write(manifest: ConversationManifest): Promise<void> {
		const parsed = parseConversationManifest(manifest);
		await new AtomicJsonFile(join(this.root, `${parsed.conversationId}.json`), parseConversationManifest).write(parsed);
	}
}
