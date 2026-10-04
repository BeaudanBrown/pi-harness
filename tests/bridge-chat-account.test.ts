import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountStore, accountHosts, ACCOUNT_REQUEST_EVENT } from "../config/agent/extensions/bridge-chat/account-store.js";
import { initializeRule, silentRule, AccountRules, type AccountRulePort } from "../config/agent/extensions/bridge-chat/account-notifications.js";
import { accountRoomProofs, verifyManagedInvite, verifyManagedHierarchy, AccountProofError, type EnsureRoom } from "../config/agent/extensions/bridge-chat/account-proof.js";
import { accountActionIdentity, parseAccountAction } from "../config/agent/extensions/managed-sessions/live-workspace-contracts.js";
import { MANAGED_PROVENANCE_EVENT } from "../config/agent/extensions/managed-sessions/managed-provenance.js";
import { OwnerMatrix } from "../config/agent/extensions/bridge-chat/transport.js";
import { MatrixHttp } from "../config/agent/extensions/matrix-shared/http.js";

const owner = "@owner:test", bot = "@host:test";
const hosts = accountHosts([{ hostId: "host", botUserId: bot, deviceId: "HOST" }]);
function ensure(): EnsureRoom {
	const body = { version: "1.0.0", hostId: "host", operation: "room.ensure", roomId: "!conversation:test", kind: "conversation", creationKey: "new-room",
		hostSpaceId: "!host:test", project: { projectKey: `project_${"a".repeat(32)}`, spaceId: "!project:test" }, checkout: { checkoutId: `checkout_${"a".repeat(32)}`, spaceId: "!checkout:test" },
		conversationId: `conv_${"a".repeat(32)}`, notificationSetup: "new_room" };
	return parseAccountAction({ ...body, ...accountActionIdentity(body) }) as EnsureRoom;
}
async function filename(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-account-")); t.after(() => rm(dir, { recursive: true, force: true })); return join(dir, "account.sqlite");
}
function rules() {
	const saved = new Map<string, unknown>(); let writes = 0; let lose = false;
	const port: AccountRulePort = { read: async id => saved.get(id), put: async (id, payload) => {
		writes++; saved.set(id, { ...(payload as object), rule_id: id, enabled: true, default: false }); if (lose) throw Error("Response lost");
	} };
	return { port, saved, writes: () => writes, lose: () => { lose = true; } };
}

test("managed account intake trusts exact one-to-one host envelope identity and persists before cursor replay", async t => {
	const file = await filename(t); let store = new AccountStore(file, owner);
	try {
		const action = ensure(); const event = { type: ACCOUNT_REQUEST_EVENT, sender: bot, content: action };
		assert.equal(store.ingest([{ ...event, sender: "@fake:test" }, { ...event, content: { ...action, hostId: "foreign" } },
			{ ...event, content: { ...action, endpoint: "/arbitrary" } }, event], hosts), 1);
		assert.deepEqual(store.get(action.requestId), { action, sender: bot });
		store.close(); store = new AccountStore(file, owner); assert.equal(store.ingest([event], hosts), 0);
		assert.throws(() => store.ingest(Array(1025).fill(event), hosts), /bounds/);
		assert.throws(() => accountHosts([...hosts, { hostId: "other", botUserId: bot, deviceId: "OTHER" }]), /one-to-one/);
		assert.throws(() => accountHosts([{ ...hosts[0], deviceId: "*" }]), /configuration/);
		assert.throws(() => accountHosts([{ ...hosts[0], token: "never accepted" }]), /configuration/);
	} finally { store.close(); }
	assert.throws(() => new AccountStore(file, "@replacement:test"), /owner changed/);
});

test("new-room rule initialization is once-only and preserves manual changes, removals and preexisting rules", async t => {
	const file = await filename(t); let store = new AccountStore(file, owner); const matrix = rules(); const { ruleId, payload } = silentRule("!room:test", bot);
	try {
		assert.equal(await initializeRule(store, matrix.port, "!room:test", ruleId, payload), "confirmed");
		matrix.saved.delete(ruleId); store.close(); store = new AccountStore(file, owner);
		assert.equal(await initializeRule(store, matrix.port, "!room:test", ruleId, payload), "confirmed"); assert.equal(matrix.writes(), 1);
		const second = silentRule("!other:test", bot); matrix.saved.set(second.ruleId, { actions: ["notify"], enabled: false });
		assert.equal(await initializeRule(store, matrix.port, "!other:test", second.ruleId, second.payload), "preserved");
		matrix.saved.delete(second.ruleId);
		assert.equal(await initializeRule(store, matrix.port, "!other:test", second.ruleId, second.payload), "preserved"); assert.equal(matrix.writes(), 1);
		assert.throws(() => store.prepareRule("!foreign:test", ruleId, payload), /identity changed/);
		assert.throws(() => store.transitionRule(ruleId, "attempted"), /transition/);
		const conditions = (payload as { conditions: Array<{ kind: string; key: string; value: string }> }).conditions;
		assert.ok(conditions.every(c => c.kind === "event_property_is"), "room/user IDs are literal, never glob patterns");
		assert.equal(conditions[2].key, "content.lol\\.bepis\\.pi\\.notification.disposition");
	} finally { store.close(); }
});

test("uncertain or interrupted per-rule PUTs only reconcile by read and never overwrite absent or changed client settings", async t => {
	for (const outcome of ["accepted", "absent", "changed", "read-failed", "crash-before-http"] as const) {
		const file = await filename(t); let store = new AccountStore(file, owner); const matrix = rules(); const rule = silentRule("!room:test", bot);
		try {
			if (outcome === "crash-before-http") { store.prepareRule("!room:test", rule.ruleId, rule.payload); store.transitionRule(rule.ruleId, "attempted"); }
			else { matrix.lose(); assert.equal(await initializeRule(store, matrix.port, "!room:test", rule.ruleId, rule.payload), "uncertain"); }
			store.close(); store = new AccountStore(file, owner);
			if (outcome === "absent") matrix.saved.clear();
			if (outcome === "changed") matrix.saved.set(rule.ruleId, { actions: ["notify"], enabled: false });
			if (outcome === "read-failed") matrix.port.read = async () => { throw Error("Offline"); };
			assert.equal(await initializeRule(store, matrix.port, "!room:test", rule.ruleId, rule.payload), outcome === "accepted" ? "confirmed" : "uncertain");
			assert.equal(matrix.writes(), outcome === "crash-before-http" ? 0 : 1);
		} finally { store.close(); }
	}
});

test("unknown preexisting rules and cancellation cannot authorize the first write; each rule has independent progress", async t => {
	const store = new AccountStore(await filename(t), owner); const matrix = rules(); const first = silentRule("!one:test", bot), second = silentRule("!two:test", bot);
	try {
		await assert.rejects(initializeRule(store, { ...matrix.port, read: async () => { throw Error("Offline"); } }, "!one:test", first.ruleId, first.payload), /Offline/);
		assert.equal(store.rule(first.ruleId)?.state, "unattempted");
		await assert.rejects(initializeRule(store, matrix.port, "!one:test", first.ruleId, first.payload, AbortSignal.abort()), /cancelled/);
		assert.equal(matrix.writes(), 0);
		await initializeRule(store, matrix.port, "!one:test", first.ruleId, first.payload);
		matrix.lose(); await initializeRule(store, matrix.port, "!two:test", second.ruleId, second.payload);
		assert.equal(store.rule(first.ruleId)?.state, "confirmed"); assert.equal(store.rule(second.ruleId)?.state, "uncertain");
	} finally { store.close(); }
});

test("production owner HTTP rule port cannot automatically retry uncertain PUTs", async t => {
	const store = new AccountStore(await filename(t), owner); const rule = silentRule("!room:test", bot); let writes = 0;
	const matrix = new OwnerMatrix({ homeserver: "https://matrix.test", accessToken: "private" }, async (_url, init) => {
		if (init?.method === "GET") return new Response(JSON.stringify({ errcode: "M_NOT_FOUND" }), { status: 404 });
		writes++; throw Error("Lost response");
	});
	try {
		assert.equal(await initializeRule(store, new AccountRules(matrix.http), "!room:test", rule.ruleId, rule.payload), "uncertain");
		assert.equal(writes, 1);
		assert.throws(() => new AccountRules(new MatrixHttp({ homeserver: "https://matrix.test", accessToken: "private" })), /single-attempt/);
	} finally { store.close(); }
});

function hierarchy(action = ensure()): Map<string, unknown[]> {
	const chain = accountRoomProofs(action); return new Map(chain.map((room, index) => [room.roomId, [
		{ type: "m.room.create", state_key: "", sender: bot, content: { "m.federate": false, ...(room.expected.kind.endsWith("_space") ? { type: "m.space" } : {}) } },
		{ type: "m.room.join_rules", state_key: "", sender: bot, content: { join_rule: "invite" } },
		{ type: MANAGED_PROVENANCE_EVENT, state_key: "", sender: bot, content: { creationKey: "ancestor", ...room.expected } },
		...(chain[index + 1] ? [{ type: "m.space.child", state_key: chain[index + 1].roomId, sender: bot, content: { via: ["test"] } }] : []),
	]]));
}
test("authenticated attestation and exact inviter precede join; full four-level provenance and links precede readiness", () => {
	const action = ensure(), snapshots = hierarchy(action);
	const invite = [{ type: "m.room.member", state_key: owner, sender: bot, content: { membership: "invite" } }];
	verifyManagedInvite(action, bot, owner, invite); verifyManagedHierarchy(action, bot, snapshots);
	assert.throws(() => verifyManagedInvite(action, bot, owner, [{ ...invite[0], sender: "@foreign:test" }]), AccountProofError);
	for (const field of ["sender", "encryption", "parent", "link", "duplicate", "creation", "privacy"] as const) {
		const changed = hierarchy(action); const room = changed.get(action.roomId)! as Array<Record<string, unknown>>;
		if (field === "sender") room[2].sender = "@foreign:test";
		if (field === "parent") (room[2].content as Record<string, unknown>).parentRoomId = "!foreign:test";
		if (field === "encryption") room.push({ type: "m.room.encryption", state_key: "", sender: bot, content: {} });
		if (field === "link") changed.get(action.checkout!.spaceId)!.pop();
		if (field === "duplicate") room.push(room[2]);
		if (field === "creation") room[0].sender = "@foreign:test";
		if (field === "privacy") (room[1].content as Record<string, unknown>).join_rule = "public";
		assert.throws(() => verifyManagedHierarchy(action, bot, changed), (error: unknown) => error instanceof AccountProofError && error.code === (field === "encryption" ? "unsupported_encryption" : "unverified"));
		if (!["link", "duplicate"].includes(field)) assert.throws(() => verifyManagedInvite(action, bot, owner, [...invite, ...room]), AccountProofError);
	}
});
