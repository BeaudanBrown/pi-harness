import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { MatrixError, type MatrixHttp } from "../matrix-shared/http.js";
import { AccountStore, type RuleProgress } from "./account-store.js";

export interface AccountRulePort {
	read(ruleId: string, signal?: AbortSignal): Promise<unknown | undefined>;
	put(ruleId: string, payload: unknown, signal?: AbortSignal): Promise<void>;
}
export class AccountRules implements AccountRulePort {
	constructor(private readonly http: MatrixHttp) {
		if (http.retry.maxAttempts !== 1) throw Error("Account rule writes require a single-attempt transport");
	}
	private endpoint(id: string): string { return `/_matrix/client/v3/pushrules/global/override/${encodeURIComponent(id)}`; }
	async read(id: string, signal?: AbortSignal): Promise<unknown | undefined> {
		try { return await this.http.request("GET", this.endpoint(id), undefined, signal); }
		catch (error) { if (error instanceof MatrixError && error.status === 404) return; throw error; }
	}
	async put(id: string, payload: unknown, signal?: AbortSignal): Promise<void> {
		if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw Error("Invalid notification rule payload");
		await this.http.request("PUT", this.endpoint(id), payload as Record<string, unknown>, signal);
	}
}

/** Silent managed traffic is suppressed; attention uses native Matrix mentions/defaults.
 * This rule never adds a notify override that could defeat an operator's room mute.
 * Call only for a verified new conversation, never migration, reconnect or resume.
 */
export function silentRule(roomId: string, botUserId: string): { ruleId: string; payload: unknown } {
	const hash = createHash("sha256").update(JSON.stringify([roomId, botUserId])).digest("hex");
	return { ruleId: `pi-managed-silent-${hash}`, payload: {
		conditions: [{ kind: "event_property_is", key: "room_id", value: roomId }, { kind: "event_property_is", key: "sender", value: botUserId },
			{ kind: "event_property_is", key: "content.lol\\.bepis\\.pi\\.notification.disposition", value: "silent" }], actions: ["dont_notify"],
	} };
}
function matchesRule(observed: unknown, progress: RuleProgress): boolean {
	if (!observed || typeof observed !== "object" || Array.isArray(observed)) return false;
	const r = observed as Record<string, unknown>;
	return r.rule_id === progress.ruleId && r.enabled === true && r.default === false &&
		isDeepStrictEqual({ conditions: r.conditions, actions: r.actions }, progress.payload);
}
/** Never replays an attempted PUT, including after process loss or a manual edit/removal. */
export async function initializeRule(store: AccountStore, port: AccountRulePort, roomId: string, ruleId: string, payload: unknown, signal?: AbortSignal): Promise<"confirmed" | "preserved" | "uncertain"> {
	const progress = store.prepareRule(roomId, ruleId, payload);
	if (progress.state === "confirmed" || progress.state === "preserved") return progress.state;
	if (signal?.aborted) throw Error("Account notification setup cancelled");
	if (progress.state === "attempted" || progress.state === "uncertain") {
		try {
			if (matchesRule(await port.read(ruleId, signal), progress)) { store.transitionRule(ruleId, "confirmed"); return "confirmed"; }
		} catch { /* Read unavailability does not grant another write. */ }
		store.transitionRule(ruleId, "uncertain"); return "uncertain";
	}
	if (progress.state !== "unattempted") throw Error("Invalid notification setup state");
	// A failed GET leaves unattempted: there is no authority to overwrite an unknown rule.
	if (await port.read(ruleId, signal) !== undefined) { store.transitionRule(ruleId, "preserved"); return "preserved"; }
	if (signal?.aborted) throw Error("Account notification setup cancelled");
	store.transitionRule(ruleId, "attempted");
	try { await port.put(ruleId, progress.payload, signal); }
	catch { store.transitionRule(ruleId, "uncertain"); return "uncertain"; }
	store.transitionRule(ruleId, "confirmed"); return "confirmed";
}
