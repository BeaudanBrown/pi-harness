import { Type } from "typebox";
import { Check } from "typebox/value";
import { ConversationIdSchema } from "../identity-contracts.js";
import { parseConversationTitle, type ConversationTitle } from "../title-contracts.js";
import type { BoundAdapterClient } from "./client.js";
export const TITLE_ENTRY = "managed-session.title";
const schema = Type.Object({ version: Type.Literal(1), conversationId: ConversationIdSchema, sessionId: Type.String({ minLength: 1, maxLength: 128 }),
	sequence: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
	accepted: Type.Optional(Type.Object({ title: Type.String({ minLength: 1, maxLength: 128 }), revision: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }) }, { additionalProperties: false })),
	pending: Type.Optional(Type.Object({ sequence: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }), title: Type.String({ maxLength: 4096 }) }, { additionalProperties: false })),
}, { additionalProperties: false });
interface State { version: 1; conversationId: string; sessionId: string; sequence: number; accepted?: ConversationTitle; pending?: { sequence: number; title: string } }
/** Metadata only: setting a name never injects a message or starts a model turn. */
export class AdapterTitleSync {
	private state: State;
	private timer?: NodeJS.Timeout;
	private closed = false;
	private applying = false;
	private capable = false;
	private needRead = false;
	private work?: Promise<void>;
	constructor(private readonly options: {
		conversationId: string; sessionId: string; entries: ReadonlyArray<any>; persist: (state: State) => void;
		client: () => BoundAdapterClient | undefined; valid: () => boolean; currentName: () => string | undefined; setName: (name: string) => void;
	}) {
		this.state = { version: 1, conversationId: options.conversationId, sessionId: options.sessionId, sequence: 0 };
		for (const entry of options.entries) if (entry.type === "custom" && entry.customType === TITLE_ENTRY && entry.data?.conversationId === options.conversationId && entry.data?.sessionId === options.sessionId) {
			if (!Check(schema, entry.data) || entry.data.pending && entry.data.pending.sequence !== entry.data.sequence) throw Error("Invalid native title metadata");
			this.state = structuredClone(entry.data); if (this.state.accepted) parseConversationTitle(this.state.accepted);
		}
	}
	private valid(): boolean { return !this.closed && this.options.valid(); }
	private save(): void { if (!this.valid()) return; try { this.options.persist(structuredClone(this.state)); } catch (error) { this.close(); throw error; } }
	connected(): void {
		if (!this.valid() || !this.options.client()?.supports("title-v1")) return;
		this.capable = true; this.needRead = true;
		this.timer ??= setInterval(() => this.flush(), 5000); this.timer.unref(); this.flush();
	}
	onName(name: string | undefined): void {
		if (!this.valid() || !this.capable || this.applying || (name ?? "") !== (this.options.currentName() ?? "") || name === this.state.accepted?.title && !this.state.pending) return;
		if ((name?.length ?? 0) > 4096 || this.state.sequence >= Number.MAX_SAFE_INTEGER) throw Error("Native title observation capacity exhausted");
		this.state.sequence++; this.state.pending = { sequence: this.state.sequence, title: name ?? "" }; this.save(); this.flush();
	}
	receive(value: ConversationTitle): void {
		if (!this.valid()) return;
		const next = parseConversationTitle(value); const previous = this.state.accepted;
		if (previous && previous.revision > next.revision) return;
		if (previous?.revision === next.revision && previous.title !== next.title) throw Error("Conflicting host title revision");
		if (previous?.revision !== next.revision) { this.state.accepted = next; this.save(); }
		this.apply();
	}
	private apply(): void {
		if (!this.valid() || this.state.pending || !this.state.accepted || this.options.currentName() === this.state.accepted.title) return;
		this.applying = true;
		try { this.options.setName(this.state.accepted.title); } finally { this.applying = false; }
	}
	flush(): void {
		const client = this.options.client();
		if (!this.valid() || !client?.connected || !client.supports("title-v1") || this.work || !this.needRead && !this.state.pending) return;
		const attemptedSequence = this.state.pending?.sequence;
		this.work = (async () => {
			const pending = this.state.pending ? { ...this.state.pending } : undefined;
			const response = await client.title(pending?.sequence, pending?.title);
			if (!this.valid() || this.options.client() !== client) return;
			parseConversationTitle(response); this.needRead = false;
			if (pending && this.state.pending?.sequence === pending.sequence) { delete this.state.pending; this.save(); }
			this.receive(response);
		})().catch(() => undefined).finally(() => { this.work = undefined; if (this.state.pending && this.state.pending.sequence !== attemptedSequence) this.flush(); });
	}
	async settled(): Promise<void> { await this.work; }
	close(): void { this.closed = true; clearInterval(this.timer); }
}
