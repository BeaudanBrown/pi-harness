import { accountSchedulingDiagnostics, type AccountDiagnosticItem, type AccountSchedulingDiagnostics } from "../../matrix-shared/account-diagnostics.js";
import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { accountActionIdentity, parseAccountAction, parseAccountAck, type AccountAction, type AccountAck } from "../live-workspace-contracts.js";
import { AtomicJsonFile, ensurePrivateDirectory } from "./atomic-json.js";
import { MatrixError } from "../../matrix-shared/http.js";
import { AccountDeliverySchedule, DeliveryWake, accountDeliveryClass, attemptedTiming, deliveryDue, maintenanceDelay, type DeliveryTiming } from "./account-delivery-schedule.js";

type Record = { action: AccountAction; transactionId?: string; sentAt?: number; ack?: AccountAck; ackAt?: number; superseded?: true; cancelled?: true; invitationAttempted?: true; delivery?: DeliveryTiming };
type State = { version: 1; hostId: string; ownerUserId: string; ownerDeviceId: string; records: Record[]; retryAt?: number };
export type AccountActionBody = AccountAction extends infer A ? A extends AccountAction ? Omit<A, "version" | "hostId" | "requestId" | "payloadDigest"> : never : never;
export interface HostAccountTransport {
	sendAccountRequest(ownerUserId: string, ownerDeviceId: string, transactionId: string, action: AccountAction, signal: AbortSignal): Promise<void>;
}
const MAX_BYTES = 8 * 1024 * 1024;
function parse(value: unknown): State {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid host account journal");
	const state = value as State;
	if (Object.keys(state).filter(k => k !== "retryAt").sort().join(",") !== "hostId,ownerDeviceId,ownerUserId,records,version" || state.version !== 1 ||
		typeof state.hostId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(state.hostId) ||
		typeof state.ownerUserId !== "string" || state.ownerUserId.length > 255 || !/^@[^\s:]+:[^\s]+$/.test(state.ownerUserId) ||
		typeof state.ownerDeviceId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(state.ownerDeviceId) ||
		!Array.isArray(state.records) || state.records.length > 4096 || Buffer.byteLength(JSON.stringify(value)) > MAX_BYTES) throw Error("Invalid host account journal");
	if (state.retryAt !== undefined && (!Number.isSafeInteger(state.retryAt) || state.retryAt < 0)) throw Error("Invalid account transport cooldown");
	const ids = new Set<string>();
	for (const record of state.records) {
		if (!record || Object.keys(record).some(k => !["action", "transactionId", "sentAt", "ack", "ackAt", "superseded", "cancelled", "invitationAttempted", "delivery"].includes(k))) throw Error("Invalid host account record");
		if (record.delivery !== undefined) {
			const d = record.delivery;
			if (!d || Object.keys(d).some(k => !["nextAt", "attempts", "demand"].includes(k)) || !Number.isSafeInteger(d.nextAt) || d.nextAt < 0 ||
				!Number.isInteger(d.attempts) || d.attempts < 0 || d.attempts > 8 || (d.demand !== undefined && d.demand !== true)) throw Error("Invalid account delivery timing");
		}
		const action = parseAccountAction(record.action);
		if (action.hostId !== state.hostId || ids.has(action.requestId)) throw Error("Conflicting host account scope"); ids.add(action.requestId);
		if (record.transactionId !== undefined && (typeof record.transactionId !== "string" || !/^pi-account-[a-f0-9-]{36}$/.test(record.transactionId))) throw Error("Invalid account transmission");
		for (const time of [record.sentAt, record.ackAt]) if (time !== undefined && (!Number.isSafeInteger(time) || time < 0)) throw Error("Invalid account observation time");
		if ((record.ack === undefined) !== (record.ackAt === undefined)) throw Error("Incomplete account acknowledgement");
		if (record.invitationAttempted !== undefined && (record.invitationAttempted !== true || action.operation !== "room.membership.restore")) throw Error("Invalid membership invitation attempt");
		if (record.cancelled !== undefined && (record.cancelled !== true || !(action.operation === "room.ensure" && action.kind === "conversation" || action.operation === "room.membership.restore"))) throw Error("Invalid cancelled account ensure");
		if (record.superseded !== undefined && (record.superseded !== true || action.operation !== "room.ensure" || !["coordinator", "conversation"].includes(action.kind) || record.ack?.code !== "departed")) throw Error("Invalid superseded account progress");
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
	private inFlightRequest?: string;
	private readonly schedule = new AccountDeliverySchedule();
	private readonly wake = new DeliveryWake();
	private work?: Promise<void>;
	private membershipAuthority?: (conversationId: string) => boolean;
	private terminalAuthority?: (conversationId: string) => boolean;
	bindMembershipAuthority(check: (conversationId: string) => boolean, isTerminal: (conversationId: string) => boolean = id => !check(id)): void {
		if (this.membershipAuthority) throw Error("Membership authority is already bound");
		this.membershipAuthority = check; this.terminalAuthority = isTerminal;
	}
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
				this.wake.notify();
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
			const known = new Map(state.records.map(r => [r.action.requestId, r]));
			for (const action of actions) {
				if (action.operation === "room.membership.restore" && state.records.some(r => r.action.operation === "room.membership.restore" && r.action.operationId === action.operationId && r.action.requestId !== action.requestId)) throw Error("Membership operation scope changed");
				if ((action.operation === "room.membership.authorize" || action.operation === "room.membership.confirm") && state.records.some(r => r.action.operation === action.operation && r.action.restoreRequestId === action.restoreRequestId && r.action.requestId !== action.requestId)) throw Error("Membership authorization scope changed");
				const old = known.get(action.requestId);
				if (old && !isDeepStrictEqual(old.action, action)) throw Error("Conflicting host account request");
				if (!old) { const record = { action, delivery: { attempts: 0, nextAt: this.now() } }; state.records.push(record); known.set(action.requestId, record); }
				else if (action.operation === "room.membership.inspect" && old.ack?.status === "complete" && old.ackAt !== undefined && this.now() - old.ackAt >= 90_000 &&
					(old.sentAt === undefined || old.sentAt <= old.ackAt) && !old.delivery?.demand) {
					old.delivery = { attempts: old.delivery?.attempts ?? 0, nextAt: this.now(), demand: true };
				}
			}
			return structuredClone(actions);
		});
	}
	async cancelRetired(isRetired: (id: string) => boolean): Promise<void> {
		await this.change(state => {
			for (const r of [...state.records]) if ((r.action.operation === "room.ensure" && r.action.kind === "conversation" || r.action.operation === "room.membership.restore") && r.action.conversationId && isRetired(r.action.conversationId)) {
				r.cancelled = true;
				if (r.action.operation === "room.membership.restore") {
					const body = { version: "1.0.0", hostId: this.state.hostId, operation: "room.membership.cancel", roomId: r.action.roomId, conversationId: r.action.conversationId, operationId: r.action.operationId };
					const action = parseAccountAction({ ...body, ...accountActionIdentity(body) });
					if (!state.records.some(record => record.action.requestId === action.requestId)) state.records.push({ action, delivery: { attempts: 0, nextAt: this.now() } });
				}
			}
		});
	}
	ack(requestId: string): AccountAck | undefined {
		if (!this.loaded || this.failed) return;
		const record = this.state.records.find(r => r.action.requestId === requestId);
		return record?.superseded ? undefined : structuredClone(record?.ack);
	}
	freshAck(requestId: string): AccountAck | undefined {
		const r = this.state.records.find(r => r.action.requestId === requestId);
		return r?.ackAt !== undefined && this.now() >= r.ackAt && this.now() - r.ackAt < 120_000 ? this.ack(requestId) : undefined;
	}
	departed(): AccountAction[] {
		if (!this.loaded || this.failed) return [];
		return this.state.records.filter(r => !r.superseded && !r.cancelled && r.ack?.code === "departed" && r.action.operation === "room.ensure" && r.action.kind === "conversation").map(r => structuredClone(r.action));
	}
	assertOwner(userId: string): void {
		if (!this.loaded || this.failed || this.closed || userId !== this.state.ownerUserId) throw Error("Managed account identity changed");
	}
	ensureIdentity(conversationId: string): Extract<AccountAction, { operation: "room.ensure" }> | undefined {
		if (!this.loaded || this.failed || this.closed) throw Error("Account authority is unavailable");
		const r = this.state.records.find(r => r.action.operation === "room.ensure" && r.action.conversationId === conversationId && !r.cancelled);
		return r?.action.operation === "room.ensure" ? structuredClone(r.action) : undefined;
	}
	private membershipCancelled(r: Record): boolean {
		const a = r.action;
		return Boolean(r.cancelled || a.operation === "room.membership.restore" && this.state.records.some(other => other.action.operation === "room.membership.cancel" &&
			other.action.operationId === a.operationId && other.action.roomId === a.roomId && other.action.conversationId === a.conversationId));
	}
	membershipRequest(operationId: string): Extract<AccountAction, { operation: "room.membership.restore" }> | undefined {
		if (!this.loaded || this.failed || this.closed) throw Error("Account authority is unavailable");
		const r = this.state.records.find(r => r.action.operation === "room.membership.restore" && r.action.operationId === operationId);
		if (r && this.membershipCancelled(r)) throw Error("Membership operation is cancelled; obtain fresh consent");
		return r?.action.operation === "room.membership.restore" ? structuredClone(r.action) : undefined;
	}
	membershipInvitationAttempted(requestId: string): boolean {
		if (!this.loaded || this.failed || this.closed) throw Error("Account authority is unavailable");
		return this.state.records.some(r => r.action.requestId === requestId && r.invitationAttempted && !r.cancelled);
	}
	membershipAuthorization(requestId: string): Extract<AccountAction, { operation: "room.membership.authorize" }> | undefined {
		if (!this.loaded || this.failed || this.closed) throw Error("Account authority is unavailable");
		const action = this.state.records.find(r => r.action.operation === "room.membership.authorize" && r.action.restoreRequestId === requestId)?.action;
		return action?.operation === "room.membership.authorize" ? structuredClone(action) : undefined;
	}
	async beginMembershipInvite(requestId: string): Promise<boolean> {
		return this.change(state => {
			const r = state.records.find(r => r.action.requestId === requestId);
			if (!r || r.action.operation !== "room.membership.restore" || this.membershipCancelled(r) || r.ack?.code !== "admitted" || r.action.expiresAt <= this.now()) throw Error("Membership admission is unavailable");
			if (r.invitationAttempted) return false;
			r.invitationAttempted = true; return true;
		});
	}
	protectsDeparture(conversationId: string, departureEventId: string | undefined): boolean {
		if (!this.loaded || this.failed || this.closed || !departureEventId) return false;
		return this.state.records.some(r => !this.membershipCancelled(r) && r.action.operation === "room.membership.restore" && r.action.conversationId === conversationId &&
			(r.action.membership === "leave" ? r.action.membershipEventId : r.action.departureEventId) === departureEventId && r.action.expiresAt > this.now() &&
			r.ack?.status === "pending" && (r.ack.code === "admitted" || r.ack.code === "join_observed"));
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
				if (ack.membershipRepair && record.action.operation !== "room.membership.inspect" || (ack.code === "admitted" || ack.code === "join_observed") && record.action.operation !== "room.membership.restore") continue;
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
				if (record.action.operation === "room.ensure" && ack.code === "departed" && ack.departureEventId && state.records.some(r => r.action.operation === "room.membership.restore" && r.action.roomId === record.action.roomId &&
					(r.action.membership === "leave" ? r.action.membershipEventId : r.action.departureEventId) === ack.departureEventId && r.ack?.status === "complete")) continue;
				if (record.action.operation === "room.ensure" && record.action.kind === "conversation" && record.ack?.code === "departed" && !record.superseded && ack.code !== "departed") continue;
				if (record.action.operation !== "room.ensure" && record.action.operation !== "room.membership.inspect" && record.ack && record.ack.status !== "pending") continue;
				const progress = !record.ack || !isDeepStrictEqual({ ...record.ack, revision: 0 }, { ...ack, revision: 0 });
				if (progress) record.delivery = { attempts: 0, nextAt: this.now() + (ack.status === "complete" ? maintenanceDelay(record) : 30_000) };
				record.ack = ack; record.ackAt = this.now(); delete record.superseded;
				if ((record.action.operation === "coordinator.membership.restore" || record.action.operation === "room.membership.restore") && ack.status === "complete") {
					const restore = record.action;
					for (const ensure of state.records) if (ensure.action.operation === "room.ensure" && ["coordinator", "conversation"].includes(ensure.action.kind) && ensure.action.roomId === restore.roomId &&
						ensure.ack?.code === "departed" && ensure.ack.departureEventId === (restore.operation === "room.membership.restore" && restore.membership === "leave" ? restore.membershipEventId : restore.departureEventId)) { ensure.superseded = true; }
				}
			}
		});
	}
	/** Local last-known scheduling facts only; never selects, writes or sends. */
	diagnostics(): AccountSchedulingDiagnostics {
		const now = this.now(), cooldown = this.state.retryAt ?? 0;
		const available = this.loaded && !this.closed && !this.failed;
		const eligible = new Set(this.eligible({ ...this.state, retryAt: 0 }).map(r => r.action.requestId));
		const items = this.state.records.map((r): AccountDiagnosticItem => {
			const a = r.action, dueAt = deliveryDue(r);
			const terminal = a.operation === "room.ensure" && a.conversationId && (!this.terminalAuthority || this.terminalAuthority(a.conversationId)) && !(r.cancelled && this.supplemental(r, this.state));
			const state = this.inFlightRequest === a.requestId ? "inFlight" : !available || terminal ? "blocked"
				: !eligible.has(a.requestId) ? r.ack && r.ack.status !== "pending" && !r.cancelled ? "settled" : "blocked"
				: Math.max(cooldown, dueAt) > now ? "parked" : "due";
			return { kind: accountDeliveryClass(r), state, ...(r.delivery || r.sentAt !== undefined ? { dueAt } : { dueAt: now }), progress: r.ack?.code };
		});
		return accountSchedulingDiagnostics(now, !available ? "unavailable" : this.work ? "running" : "idle", cooldown, items);
	}
	/** Lifecycle belongs here; inventory reconciliation must not delay transmission. */
	start(): void {
		if (this.closed) throw Error("Host account authority is unavailable");
		this.work ??= this.pump();
	}
	private supplemental(record: Record, state: State): boolean {
		return state.records.some(negative => (negative.action.operation === "room.retire" || negative.action.operation === "space.retire") && negative.action.roomId === record.action.roomId && negative.ack?.status === "pending" && negative.ack.code === "unverified");
	}
	private membershipParent(record: Record, state: State): Record | undefined {
		const a = record.action;
		return a.operation === "room.membership.restore" ? record : a.operation === "room.membership.authorize" || a.operation === "room.membership.confirm"
			? state.records.find(r => r.action.requestId === a.restoreRequestId && r.action.operation === "room.membership.restore" && r.action.roomId === a.roomId && r.action.conversationId === a.conversationId) : undefined;
	}
	private eligible(state: State): Record[] {
		if ((state.retryAt ?? 0) > this.now()) return [];
		return state.records.filter(r => !r.cancelled || this.supplemental(r, state))
			.filter(r => {
				const a = r.action;
				if (a.operation === "room.ensure" && state.records.some(n => (n.action.operation === "room.retire" || n.action.operation === "space.retire") && n.action.roomId === a.roomId)) return this.supplemental(r, state);
				if (a.operation !== "room.membership.restore" && a.operation !== "room.membership.authorize" && a.operation !== "room.membership.confirm") return true;
				const parent = this.membershipParent(r, state);
				return Boolean(parent?.action.operation === "room.membership.restore" && !this.membershipCancelled(parent) && parent.action.expiresAt > this.now());
			})
			.filter(r => r.action.operation === "room.ensure" || r.action.operation === "room.membership.inspect" || !r.ack || r.ack.status === "pending");
	}
	private async pump(): Promise<void> {
		while (!this.stop.signal.aborted && !this.failed) {
			const start = this.now(); let count = 0;
			for (; count < 8 && !this.stop.signal.aborted && !this.failed; count++) {
				try { if (!await this.flush(this.stop.signal)) break; } catch { /* Persisted attempt bounds retry; uncertain writes poison. */ }
				if (this.now() - start >= 1000) { count++; break; }
			}
			const version = this.wake.version();
			const due = (this.state.retryAt ?? 0) > this.now() ? this.state.retryAt! : this.eligible(this.state).reduce((at, r) => Math.min(at, deliveryDue(r)), Infinity);
			await this.wake.wait(version, count ? 25 : Math.min(30_000, Math.max(25, due - this.now())), this.stop.signal);
		}
	}
	/** One bounded transmission, independent of sync/IPC. Never hold the journal lane over HTTP. */
	async flush(signal: AbortSignal): Promise<boolean> {
		if (this.flushing || this.closed || signal.aborted) return false; this.flushing = true;
		try {
			// The delivery loop is independent of provisioning: reconcile known
			// terminal authority before selection, not on the next inventory tick.
			if (this.terminalAuthority) await this.cancelRetired(id => this.terminalAuthority!(id));
			const candidate = await this.change(state => {
				const record = this.schedule.select(this.eligible(state), this.now(), state.records); if (!record) return;
				record.delivery = attemptedTiming(record, this.now()); record.transactionId ??= `pi-account-${randomUUID()}`; record.sentAt = this.now();
				return structuredClone(record);
			});
			if (!candidate || this.closed || signal.aborted) return false;
			// Selection awaited a durable write. Re-read cancellation/parent scope
			// after that await and re-fence the registry immediately before HTTP.
			const current = this.eligible(this.state).find(r => r.action.requestId === candidate.action.requestId && r.transactionId === candidate.transactionId);
			if (!current) return false;
			if (candidate.action.operation === "room.ensure" && candidate.action.conversationId) {
				const id = candidate.action.conversationId;
				if (!this.terminalAuthority) throw Error("Conversation transmission authority is unavailable");
				if (this.terminalAuthority(id) && !(current.cancelled && this.supplemental(current, this.state))) {
					await this.cancelRetired(value => value === id); return false;
				}
			}
			if (candidate.action.operation === "room.membership.restore" || candidate.action.operation === "room.membership.authorize" || candidate.action.operation === "room.membership.confirm") {
				const action = candidate.action;
				const parent = this.membershipParent(current, this.state);
				if (!this.membershipAuthority) throw Error("Membership transmission authority is unavailable");
				if (!parent || parent.action.operation !== "room.membership.restore" || parent.action.expiresAt <= this.now() || this.membershipCancelled(parent)) return false;
				if (!this.membershipAuthority(action.conversationId)) {
					await this.cancelRetired(id => id === action.conversationId); return false;
				}
			}
			this.inFlightRequest = candidate.action.requestId;
			this.activeSend = this.transport.sendAccountRequest(this.state.ownerUserId, this.state.ownerDeviceId, candidate.transactionId!, candidate.action,
				AbortSignal.any([signal, this.stop.signal, AbortSignal.timeout(10_000)]));
			try { await this.activeSend; }
			catch (error) {
				if (!this.closed && error instanceof MatrixError && error.status === 429) {
					const delay = Number.isSafeInteger(error.retryAfterMs) && error.retryAfterMs! >= 0 ? error.retryAfterMs! : 30_000;
					await this.change(state => { state.retryAt = Math.max(state.retryAt ?? 0, this.now() + Math.max(1000, delay)); });
				}
				throw error;
			}
			await this.change(state => {
				const record = state.records.find(r => r.action.requestId === candidate.action.requestId);
				if (record && record.transactionId === candidate.transactionId) delete record.transactionId;
			});
			return true;
		} finally { this.flushing = false; this.activeSend = undefined; this.inFlightRequest = undefined; }
	}
	async close(): Promise<void> { this.closed = true; this.stop.abort(); await this.activeSend?.catch(() => {}); await this.work; await this.lane; }
}
