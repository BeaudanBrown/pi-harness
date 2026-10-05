import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { dirname } from "node:path";
import { AtomicJsonFile, ensurePrivateDirectory } from "./atomic-json.js";
import { roomHostCommand } from "../host-command.js";
import { hostControlHelp } from "./host-cli-args.js";
import { HOST_CONTROL_VERSION, type HostActor } from "../live-workspace-contracts.js";
import type { HostDispatcher } from "./host-dispatcher.js";
import type { ConversationManifest } from "../contracts.js";

/** Consumed human Matrix event IDs, not results or model-action replay receipts. */
export class HostMatrixCommands {
	private ids = new Set<string>();
	private lane: Promise<void> = Promise.resolve();
	private loaded = false; private failed = false; private closing = false;
	private readonly active = new Set<Promise<boolean>>();
	private readonly file: AtomicJsonFile<{ version: 1; hostId: string; ids: string[] }>;
	constructor(path: string, private readonly hostId: string, private readonly operator: string, private readonly dispatcher: HostDispatcher,
		private readonly reply: (eventId: string, manifest: ConversationManifest, text: string) => Promise<void>) {
		this.file = new AtomicJsonFile(path, value => {
			const v = value as { version: 1; hostId: string; ids: string[] };
			if (!v || v.version !== 1 || v.hostId !== hostId || Object.keys(v).sort().join() !== "hostId,ids,version" || !Array.isArray(v.ids) || v.ids.length > 8192 || new Set(v.ids).size !== v.ids.length || v.ids.some(id => typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id))) throw Error("Invalid host command intake journal");
			return v;
		});
	}
	async load(): Promise<void> {
		await ensurePrivateDirectory(dirname(this.file.path));
		const stat = await lstat(this.file.path).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
		if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || stat.size > 1024 * 1024)) throw Error("Unsafe host command intake journal");
		this.ids = new Set((await this.file.read())?.ids ?? []); this.loaded = true;
	}
	private async consume(id: string): Promise<boolean> {
		const work = this.lane.then(async () => {
			if (!this.loaded || this.failed) throw Error("Host command intake unavailable");
			if (this.ids.has(id)) return false;
			if (this.ids.size >= 8192) throw Error("Host command intake capacity exhausted; explicit recovery required");
			const ids = new Set(this.ids); ids.add(id);
			try { await this.file.write({ version: 1, hostId: this.hostId, ids: [...ids] }); }
			catch (error) { this.failed = true; throw error; }
			this.ids = ids; return true;
		});
		this.lane = work.then(() => {}, () => {}); return work;
	}
	accept(manifest: ConversationManifest, eventId: string, sender: string, body: string): Promise<boolean> {
		if (this.closing) return Promise.reject(Error("Host commands are stopping"));
		const work = this.acceptOnce(manifest, eventId, sender, body); this.active.add(work);
		void work.then(() => this.active.delete(work), () => this.active.delete(work)); return work;
	}
	private async acceptOnce(manifest: ConversationManifest, eventId: string, sender: string, body: string): Promise<boolean> {
		if (!/^!(?:host|start|stop|close)(?:\s|$)/.test(body.trim())) return false;
		if (sender !== this.operator) return true;
		const id = createHash("sha256").update(JSON.stringify([this.hostId, manifest.roomId, eventId])).digest("hex");
		// A replay after a crash is never permission to retry a human mutation.
		// The absence of a reply is uncertain: inspect, then issue a fresh command.
		if (!await this.consume(id)) return true;
		let action;
		try { action = roomHostCommand(body, manifest.conversationId); }
		catch { await this.reply(eventId, manifest, "Invalid host command. Use !host help; closing requires !close --confirm."); return true; }
		if (!action) return false;
		if (action === "help") { await this.reply(eventId, manifest, `${hostControlHelp().replace("pi-managed-session", "!host")}\nRoom-local: !start, !stop, !close --confirm. No prompt is submitted.`); return true; }
		const actor: HostActor = { kind: "human_matrix", conversationId: manifest.conversationId, requestId: `matrix-${id}`, roomId: manifest.roomId, eventId, senderUserId: sender };
		const result = await this.dispatcher.dispatch({ version: HOST_CONTROL_VERSION, actor, action }, actor);
		const text = JSON.stringify(result);
		await this.reply(eventId, manifest, text.length <= 6000 ? text : "Host request succeeded, but its complete result exceeds the Matrix display bound. No partial preview or apply token is shown. Request a smaller page/preview or inspect through the local CLI; do not repeat a mutation just to retrieve its result.").catch(() => {});
		return true;
	}
	async close(): Promise<void> { this.closing = true; await Promise.allSettled([...this.active]); await this.lane; }
}
