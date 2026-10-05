import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { accountActionIdentity, parseAccountAction, parseAccountAck, type AccountAction, type AccountAck } from "../live-workspace-contracts.js";
import { AtomicJsonFile, ensurePrivateDirectory } from "./atomic-json.js";

type Record = { action: AccountAction; transactionId?: string; sentAt?: number; ack?: AccountAck; ackAt?: number; superseded?: true; cancelled?: true };
type State = { version: 1; hostId: string; ownerUserId: string; ownerDeviceId: string; records: Record[] };
export type AccountActionBody = AccountAction extends infer A ? A extends AccountAction ? Omit<A, "version" | "hostId" | "requestId" | "payloadDigest"> : never : never;
export interface HostAccountTransport {
	sendAccountRequest(ownerUserId: string, ownerDeviceId: string, transactionId: string, action: AccountAction, signal: AbortSignal): Promise<void>;
}
const MAX_BYTES = 8 * 1024 * 1024;
function parse(value: unknown): State {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid host account journal");
	const state = value as State;
	if (Object.keys(state).sort().join(",") !== "hostId,ownerDeviceId,ownerUserId,records,version" || state.version !== 1 ||
		typeof state.hostId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(state.hostId) ||
		typeof state.ownerUserId !== "string" || state.ownerUserId.length > 255 || !/^@[^\s:]+:[^\s]+$/.test(state.ownerUserId) ||
		typeof state.ownerDeviceId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(state.ownerDeviceId) ||
		!Array.isArray(state.records) || state.records.length > 4096 || Buffer.byteLength(JSON.stringify(value)) > MAX_BYTES) throw Error("Invalid host account journal");
	const ids = new Set<string>();
	for (const record of state.records) {
		if (!record || Object.keys(record).some(k => !["action", "transactionId", "sentAt", "ack", "ackAt", "superseded", "cancelled"].includes(k))) throw Error("Invalid host account record");
		const action = parseAccountAction(record.action);
		if (action.hostId !== state.hostId || ids.has(action.requestId)) throw Error("Conflicting host account scope"); ids.add(action.requestId);
		if (record.transactionId !== undefined && (typeof record.transactionId !== "string" || !/^pi-account-[a-f0-9-]{36}$/.test(record.transactionId))) throw Error("Invalid account transmission");
		for (const time of [record.sentAt, record.ackAt]) if (time !== undefined && (!Number.isSafeInteger(time) || time < 0)) throw Error("Invalid account observation time");
		if ((record.ack === undefined) !== (record.ackAt === undefined)) throw Error("Incomplete account acknowledgement");
		if (record.cancelled !== undefined && (record.cancelled !== true || action.operation !== "room.ensure" || action.kind !== "conversation")) throw Error("Invalid cancelled account ensure");
		if (record.superseded !== undefined && (record.superseded !== true || action.operation !== "room.ensure" || action.kind !== "coordinator" || record.ack?.code !== "departed")) throw Error("Invalid superseded account progress");
		if (record.ack) {
			const ack = parseAccountAck(record.ack);
			if (ack.requestId !== action.requestId || ack.payloadDigest !== action.payloadDigest || ack.hostId !== action.hostId) throw Error("Account acknowledgement scope mismatch");
		}
	}
	return state;
}
/** Host bot only. This journal contains no owner credential and owns no Pi process. */
export class HostAccountClient {
	private state: State;
	private readonly file: AtomicJsonFile<State>;
	private lane: Promise<unknown> = Promise.resolve();
	private failed = false;
	private loaded = false;
	private flushing = false;
	private closed = false;
	private readonly stop = new AbortController();
	private activeSend?: Promise<void>;
	private after = "";
	private readonly baselineFile: AtomicJsonFile<string[]>;
	private parseBaseline(value: unknown): string[] {
		if (!Array.isArray(value) || value.length > 20000 || value.some(v => typeof v !== "string" || v.length > 300)) throw Error("Invalid account preservation baseline");
		return value;
	}
	private preserved?: Set<string>;
	async initializeBaseline(keys: string[]): Promise<void> {
		const saved = await this.baselineFile.read();
		if (!saved) await this.baselineFile.write(keys);
		this.preserved = new Set(saved ?? keys);
	}
	notificationSetup(kind: string, creationKey: string): "preserve" | "new_room" {
		if (!this.preserved) throw Error("Account preservation baseline is unavailable");
		return ["conversation", "coordinator"].includes(kind) && !this.preserved.has(`${kind}:${creationKey}`) ? "new_room" : "preserve";
	}
	constructor(private readonly directory: string, hostId: string, ownerUserId: string, ownerDeviceId: string, private readonly transport: HostAccountTransport, private readonly now = Date.now) {
		this.baselineFile = new AtomicJsonFile(join(directory, "preserved.json"), value => this.parseBaseline(value));
		this.state = parse({ version: 1, hostId, ownerUserId, ownerDeviceId, records: [] });
		this.file = new AtomicJsonFile(join(directory, "account.json"), parse);
	}
	async load(): Promise<void> {
		await ensurePrivateDirectory(this.directory);
		try { const stat = await lstat(this.file.path); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES * 2) throw Error("Unsafe host account journal"); }
		catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
		const saved = await this.file.read();
		if (saved) {
			if (saved.hostId !== this.state.hostId || saved.ownerUserId !== this.state.ownerUserId || saved.ownerDeviceId !== this.state.ownerDeviceId) throw Error("Host account recipient changed; explicit recovery required");
			this.state = saved;
		}
		this.loaded = true;
	}
	private change<T>(fn: (state: State) => T): Promise<T> {
		const work = this.lane.then(async () => {
			if (!this.loaded || this.failed || this.closed) throw Error("Host account authority is unavailable");
			const next = structuredClone(this.state); const result = fn(next); parse(next);
			if (!isDeepStrictEqual(next, this.state)) {
				try { await this.file.write(next); } catch (error) { this.failed = true; throw error; }
				this.state = next;
			}
			return result;
		});
		this.lane = work.catch(() => {}); return work;
	}
	async request(body: AccountActionBody): Promise<AccountAction> { return (await this.requestMany([body]))[0]; }
	async requestMany(bodies: AccountActionBody[]): Promise<AccountAction[]> {
		if (bodies.length > 4096) throw Error("Account provisioning capacity exhausted");
		const actions = bodies.map(body => { const value = { ...body, version: "1.0.0", hostId: this.state.hostId }; return parseAccountAction({ ...value, ...accountActionIdentity(value) }); });
		return this.change(state => {
			const known = new Map(state.records.map(r => [r.action.requestId, r.action]));
			for (const action of actions) {
				const old = known.get(action.requestId);
				if (old && !isDeepStrictEqual(old, action)) throw Error("Conflicting host account request");
				if (!old) { state.records.push({ action }); known.set(action.requestId, action); }
			}
			return structuredClone(actions);
		});
	}
	async cancelRetired(isRetired: (id: string) => boolean): Promise<void> {
		await this.change(state => { for (const r of state.records) if (r.action.operation === "room.ensure" && r.action.kind === "conversation" && r.action.conversationId && isRetired(r.action.conversationId)) r.cancelled = true; });
	}
	ack(requestId: string): AccountAck | undefined {
		if (!this.loaded || this.failed) return;
		const record = this.state.records.find(r => r.action.requestId === requestId);
		return record?.superseded ? undefined : structuredClone(record?.ack);
	}
	departed(): AccountAction[] {
		if (!this.loaded || this.failed) return [];
		return this.state.records.filter(r => r.ack?.code === "departed" && r.action.operation === "room.ensure" && r.action.kind === "conversation").map(r => structuredClone(r.action));
	}
	setupState(conversationId: string): "ready" | "pending" | "notification_setup_uncertain" {
		if (!this.loaded || this.failed || this.closed) return "pending";
		const record = this.state.records.find(r => r.action.operation === "room.ensure" && r.action.conversationId === conversationId && !r.cancelled && !r.superseded);
		return record?.ack?.status === "complete" ? "ready" : record?.ack?.status === "notification_setup_uncertain" ? "notification_setup_uncertain" : "pending";
	}
	status(): "ready" | "pending" | "unavailable" {
		if (!this.loaded || this.failed) return "unavailable";
		const fresh = this.state.records.filter(r => r.ackAt !== undefined && this.now() >= r.ackAt && this.now() - r.ackAt < 120_000);
		return fresh.length ? "ready" : "pending";
	}
	/** Persist authenticated acks before advancing the host bot's shared sync cursor. */
	async ingest(response: unknown): Promise<void> {
		const events = (response as { to_device?: { events?: unknown } } | null)?.to_device?.events ?? [];
		if (!Array.isArray(events) || events.length > 1024) throw Error("Account acknowledgement intake exceeds bounds");
		const accepted: AccountAck[] = [];
		for (const raw of events) {
			if (!raw || typeof raw !== "object") continue;
			const e = raw as { type?: unknown; sender?: unknown; content?: unknown };
			if (e.type !== "lol.bepis.pi.account.ack.v1" || e.sender !== this.state.ownerUserId) continue;
			try { const ack = parseAccountAck(e.content); if (ack.hostId === this.state.hostId) accepted.push(ack); } catch { /* Untrusted syntax is not authority. */ }
		}
		await this.change(state => {
			for (const ack of accepted) {
				const record = state.records.find(r => r.action.requestId === ack.requestId && r.action.payloadDigest === ack.payloadDigest); if (!record) continue;
				if (record.ack) {
					if (ack.revision < record.ack.revision) continue;
					if (ack.revision === record.ack.revision) {
						if (!isDeepStrictEqual(ack, record.ack)) throw Error("Conflicting account acknowledgement revision");
						if (!record.superseded) record.ackAt = this.now();
						continue;
					}
				}
				if (record.action.operation === "room.ensure" && record.action.kind === "coordinator" && ack.code === "departed") {
					// A legacy unqualified notice cannot undo a departure-specific restore.
					if (!ack.departureEventId || state.records.some(r => r.action.operation === "coordinator.membership.restore" && r.action.roomId === record.action.roomId &&
						r.action.departureEventId === ack.departureEventId && r.ack?.status === "complete")) continue;
				}
				if (record.action.operation === "room.ensure" && record.action.kind === "conversation" && record.ack?.code === "departed" && ack.code !== "departed") continue;
				if (record.action.operation !== "room.ensure" && record.ack && record.ack.status !== "pending") continue;
				record.ack = ack; record.ackAt = this.now(); delete record.superseded;
				if (record.action.operation === "coordinator.membership.restore" && ack.status === "complete") {
					const restore = record.action;
					for (const ensure of state.records) if (ensure.action.operation === "room.ensure" && ensure.action.kind === "coordinator" && ensure.action.roomId === restore.roomId &&
						ensure.ack?.code === "departed" && ensure.ack.departureEventId === restore.departureEventId) { ensure.superseded = true; }
				}
			}
		});
	}
	/** One bounded transmission, independent of sync/IPC. Never hold the journal lane over HTTP. */
	async flush(signal: AbortSignal): Promise<void> {
		if (this.flushing || this.closed) return; this.flushing = true;
		try {
			const candidate = await this.change(state => {
				const eligible = state.records.filter(r => !r.cancelled || state.records.some(negative => negative.action.operation === "room.retire" && negative.action.roomId === r.action.roomId && negative.ack?.status === "pending" && negative.ack.code === "unverified"))
					.filter(r => r.action.operation === "room.ensure" || !r.ack || r.ack.status === "pending")
					.filter(r => !r.sentAt || this.now() - r.sentAt >= 30_000).sort((a, b) => a.action.requestId.localeCompare(b.action.requestId));
				const record = eligible.find(r => r.action.requestId > this.after) ?? eligible[0]; if (!record) return;
				this.after = record.action.requestId; record.transactionId ??= `pi-account-${randomUUID()}`; record.sentAt = this.now();
				return structuredClone(record);
			});
			if (!candidate || this.closed) return;
			this.activeSend = this.transport.sendAccountRequest(this.state.ownerUserId, this.state.ownerDeviceId, candidate.transactionId!, candidate.action,
				AbortSignal.any([signal, this.stop.signal, AbortSignal.timeout(10_000)]));
			await this.activeSend;
			await this.change(state => {
				const record = state.records.find(r => r.action.requestId === candidate.action.requestId);
				if (record && record.transactionId === candidate.transactionId) delete record.transactionId;
			});
		} finally { this.flushing = false; this.activeSend = undefined; }
	}
	async close(): Promise<void> { this.closed = true; this.stop.abort(); await this.activeSend?.catch(() => {}); await this.lane; }
}
