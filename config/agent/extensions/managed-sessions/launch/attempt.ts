import { open, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { deriveConversationId } from "../contracts.js";
import { parseHostAction, type HostAction } from "../live-workspace-contracts.js";
import { AtomicJsonFile, ensurePrivateDirectory } from "../relay/atomic-json.js";

type CreateAction = Extract<HostAction, { operation: "conversation.create" }>;
interface Attempt {
	version: 1; hostId: string; conversationId: string; createdAt: string;
	phase: "preparing" | "ready"; action: CreateAction;
	source?: { path: string; sessionId: string };
}

async function syncDirectory(path: string): Promise<void> {
	const file = await open(path, "r"); try { await file.sync(); } finally { await file.close(); }
}

/** Durable caller retry identity, not an automatic replay queue or session manager. */
export async function beginLaunchAttempt(directory: string, hostId: string, action: CreateAction, source?: Attempt["source"]) {
	const checked = structuredClone(parseHostAction(action));
	if (checked.operation !== "conversation.create") throw new Error("Invalid launch attempt action");
	const conversationId = deriveConversationId(hostId, checked.creationKey);
	const root = await ensurePrivateDirectory(directory);
	if ((await readdir(root)).length >= 256) throw new Error("Interrupted launch attempts require manual inspection before admitting more work");
	const path = join(root, `${conversationId}.json`);
	const initial: Attempt = { version: 1, hostId, conversationId, createdAt: new Date().toISOString(), phase: "preparing", action: checked, ...(source ? { source: structuredClone(source) } : {}) };
	const encode = (record: Attempt) => {
		const text = JSON.stringify(record, null, 2) + "\n";
		if (Buffer.byteLength(text) > 16 * 1024) throw new Error("Launch recovery record exceeds its bound");
		return text;
	};
	const text = encode(initial), file = await open(path, "wx", 0o600);
	try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
	await syncDirectory(root);
	let readyStarted = false, readyWritten = false;
	return {
		path,
		async ready(next: CreateAction): Promise<void> {
			if (readyStarted) throw new Error("Launch preparation cannot be replayed");
			readyStarted = true;
			const parsed = parseHostAction(next);
			if (parsed.operation !== "conversation.create" || parsed.creationKey !== checked.creationKey || parsed.title !== checked.title ||
				JSON.stringify(parsed.placement) !== JSON.stringify(checked.placement) || (source && !parsed.expectedSessionKey)) throw new Error("Launch retry identity changed before admission");
			const record: Attempt = { ...initial, phase: "ready", action: parsed }; encode(record);
			await new AtomicJsonFile<Attempt>(path, () => record).write(record);
			readyWritten = true;
		},
		/** Only after an exact host open proves durable admission; the host then owns recovery. */
		async complete(): Promise<void> {
			if (!readyWritten) throw new Error("Unadmitted launch preparation requires inspection");
			await unlink(path); await syncDirectory(root);
		},
	};
}
