import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountMatrix } from "../config/agent/extensions/bridge-chat/account-matrix.js";
import { AccountWorker, type AccountMatrixPort } from "../config/agent/extensions/bridge-chat/account-worker.js";
import { AccountStore, accountHosts, ACCOUNT_REQUEST_EVENT } from "../config/agent/extensions/bridge-chat/account-store.js";
import { initializeRule, silentRule, AccountRules, type AccountRulePort } from "../config/agent/extensions/bridge-chat/account-notifications.js";
import { accountRoomProofs, verifyManagedInvite, verifyManagedHierarchy, AccountProofError, type EnsureRoom } from "../config/agent/extensions/bridge-chat/account-proof.js";
import { accountActionIdentity, parseAccountAction, type AccountAction } from "../config/agent/extensions/managed-sessions/live-workspace-contracts.js";
import { MANAGED_PROVENANCE_EVENT } from "../config/agent/extensions/managed-sessions/managed-provenance.js";
import { OwnerMatrix, assistantPolicyFingerprint, validateConfig } from "../config/agent/extensions/bridge-chat/transport.js";
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

test("account-only configuration does not reset assistant policy and sync remains opt-in", async () => {
	const config = validateConfig({ homeserver: "https://matrix.test", ownerUserId: owner, remoteOwnerUserIds: [], roomIds: ["!chat:test"], allJoinedRooms: false, modelSocket: "/private/socket" });
	assert.equal(assistantPolicyFingerprint(config, "secret"), assistantPolicyFingerprint({ ...config, managedAccountHosts: hosts }, "secret"));
	assert.notEqual(assistantPolicyFingerprint(config, "secret"), assistantPolicyFingerprint({ ...config, roomIds: ["!different:test"] }, "secret"));
	const filters: Array<{ room: { timeline: { types: string[] }; state: { types: string[] } } }> = [];
	const matrix = new OwnerMatrix({ homeserver: config.homeserver, accessToken: "secret" }, async url => {
		filters.push(JSON.parse(new URL(String(url)).searchParams.get("filter")!)); return new Response(JSON.stringify({ next_batch: "next" }));
	});
	await matrix.sync("old", [owner], 1); await matrix.sync("old", [owner], 1, undefined, true);
	assert.deepEqual(filters[0].room.timeline.types, ["m.room.message"]); assert.deepEqual(filters[0].room.state.types, []);
	assert.deepEqual(filters[1].room.timeline.types, ["m.room.message", "m.room.member"]);
	assert.throws(() => validateConfig({ ...config, managedAccountHosts: [{ ...hosts[0], botUserId: owner }] }), /Owner cannot/);
});

test("owner account HTTP effects use fixed endpoints and require positive forget acknowledgement", async () => {
	const calls: Array<{ path: string; method: string; body: unknown }> = [];
	let forgetStatus = 200;
	const http = new OwnerMatrix({ homeserver: "https://matrix.test", accessToken: "secret" }, async (url, init) => {
		const path = new URL(String(url)).pathname; calls.push({ path, method: init!.method!, body: init!.body ? JSON.parse(String(init!.body)) : undefined });
		if (path.endsWith("/joined_rooms")) return new Response(JSON.stringify({ joined_rooms: ["!room:test"] }));
		return new Response("{}", { status: path.endsWith("/forget") ? forgetStatus : 200 });
	}).http;
	const port = new AccountMatrix(http), signal = new AbortController().signal;
	assert.equal(await port.joined("!room:test", signal), true);
	await port.join("!room:test", signal); await port.leave("!room:test", signal); await port.forget("!room:test", signal);
	forgetStatus = 404; await assert.rejects(port.forget("!room:test", signal));
	const action = ensure(); const ack = { version: action.version, hostId: action.hostId, requestId: action.requestId, payloadDigest: action.payloadDigest, revision: 1, status: "complete" };
	await port.toDevice("lol.bepis.pi.account.ack.v1", bot, "HOST", "transmission", ack, signal);
	assert.deepEqual(calls.at(-1)!.body, { messages: { [bot]: { HOST: ack } } });
	assert.ok(calls.slice(1, 5).every(c => c.path.startsWith("/_matrix/client/v3/rooms/!room%3Atest/")));
	await assert.rejects(port.toDevice("arbitrary", bot, "HOST", "t", {}, signal));
});

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

const signed = (body: Record<string, unknown>): AccountAction => parseAccountAction({ ...body, ...accountActionIdentity(body) });
const machineEvent = (action: AccountAction) => ({ type: ACCOUNT_REQUEST_EVENT, sender: bot, content: action });
const inviteState = () => [{ type: "m.room.member", state_key: owner, sender: bot, content: { membership: "invite" } }];
const leaveBatch = (room: string, event: string) => ({ rooms: { leave: { [room]: { timeline: { events: [{ type: "m.room.member", state_key: owner, sender: owner, event_id: event, content: { membership: "leave" } }] } } } } });
async function workerFixture(t: { after: (fn: () => Promise<void>) => void }, action = ensure()) {
	const file = await filename(t); let store = new AccountStore(file, owner); t.after(async () => store.close());
	const matrixRules = rules(), snapshots = hierarchy(action), joined = new Set<string>();
	const effects: string[] = []; const sent: Array<{ txn: string; content: unknown }> = []; let loseAck = false; let loseLeave = false;
	const port: AccountMatrixPort = {
		joined: async id => joined.has(id), state: async id => { if (!snapshots.has(id)) throw Error("Unavailable"); return snapshots.get(id); },
		join: async id => { effects.push(`join:${id}`); joined.add(id); },
		leave: async id => { effects.push(`leave:${id}`); joined.delete(id); if (loseLeave) throw Error("Reply lost"); },
		forget: async id => { effects.push(`forget:${id}`); }, cleanupEligible: async () => true,
		toDevice: async (type, recipient, device, txn, content) => {
			assert.equal(type, "lol.bepis.pi.account.ack.v1"); assert.equal(recipient, bot); assert.equal(device, "HOST");
			sent.push({ txn, content }); if (loseAck) throw Error("Reply lost");
		},
	};
	let worker = new AccountWorker(store, hosts, owner, port, matrixRules.port);
	const ingest = (a: AccountAction, invite = true) => worker.ingest({ to_device: { events: [machineEvent(a)] }, ...(invite ? { rooms: { invite: { [a.roomId]: { invite_state: { events: inviteState() } } } } } : {}) });
	const step = () => worker.step(new AbortController().signal), flush = () => worker.flush(new AbortController().signal);
	const restart = () => { store.close(); store = new AccountStore(file, owner); worker = new AccountWorker(store, hosts, owner, port, matrixRules.port); worker.ingest({}); };
	return { get store() { return store; }, get worker() { return worker; }, restart, port, matrixRules, effects, sent, joined, ingest, step, flush, setLoseAck: (v: boolean) => { loseAck = v; }, setLoseLeave: (v: boolean) => { loseLeave = v; } };
}

test("failed account batch commits neither partial actions nor unsafe effects before a healthy sync", async t => {
	const f = await workerFixture(t); const action = ensure();
	const malformedRoom = { timeline: { events: Array(4097).fill({}) } };
	assert.throws(() => f.worker.ingest({ to_device: { events: [machineEvent(action)] }, rooms: { join: { [action.roomId]: malformedRoom } } }));
	assert.equal(f.store.get(action.requestId), undefined); assert.equal(f.store.room(action.roomId), undefined);
	await f.step(); assert.equal(f.effects.length, 0);
	f.ingest(action); await f.step(); assert.equal(f.store.get(action.requestId)?.ack?.status, "complete");
});

test("NAS worker initializes before join, verifies readiness, and uses fresh transactions only for intentional redelivery", async t => {
	const f = await workerFixture(t); const action = ensure();
	f.ingest(action); assert.equal(f.effects.length, 0, "durable intake has no HTTP effects");
	const join = f.port.join; f.port.join = async (room, signal) => { assert.equal(f.matrixRules.writes(), 1, "silent rule precedes invitation acceptance"); await join(room, signal); };
	await f.step(); assert.equal(f.store.get(action.requestId)?.ack?.status, "complete"); assert.equal(f.store.room(action.roomId)?.verified, true);
	f.setLoseAck(true); await assert.rejects(f.flush()); const original = f.store.transmission()!;
	f.restart(); f.setLoseAck(false); await f.flush(); assert.equal(f.sent[0].txn, f.sent[1].txn, "uncertain HTTP attempt retains transaction");
	f.ingest(action); await f.flush();
	assert.notEqual(f.sent[2].txn, original.transactionId, "accepted send redelivery must enqueue a new device message");
	assert.deepEqual(f.sent[2].content, f.sent[0].content); assert.deepEqual(f.effects, [`join:${action.roomId}`]); assert.equal(f.matrixRules.writes(), 1);
});

test("pending ack loss cannot remove a newer progress transmission and different recipients make progress", async t => {
	const f = await workerFixture(t); const action = ensure(); f.ingest(action);
	f.store.acknowledge(action.requestId, hosts[0], "pending"); const pending = f.store.transmission()!;
	f.store.acknowledge(action.requestId, hosts[0], "complete"); f.store.transmitted(pending);
	assert.equal(f.store.transmission()?.payload.status, "complete");
	const second = signed({ ...action, roomId: "!other:test", creationKey: "other", conversationId: `conv_${"b".repeat(32)}` }); f.ingest(second);
	f.store.acknowledge(second.requestId, hosts[0], "pending");
	const first = f.store.transmission()!, next = f.store.transmission()!; assert.notEqual(first.requestId, next.requestId);
});

test("account uncertainty does not block room readiness and migration never initializes notification rules", async t => {
	const f = await workerFixture(t); const action = ensure(); f.matrixRules.lose(); f.ingest(action); await f.step();
	assert.equal(f.store.get(action.requestId)?.ack?.status, "notification_setup_uncertain"); assert.equal(f.joined.has(action.roomId), true);
	const preserve = signed({ ...action, notificationSetup: "preserve" }) as EnsureRoom;
	const p = await workerFixture(t, preserve); p.ingest(preserve); await p.step(); assert.equal(p.matrixRules.writes(), 0);
	assert.equal(p.store.get(preserve.requestId)?.ack?.status, "complete");
});

test("retirement fences before leave, survives response loss, and refuses ensure replay", async t => {
	const f = await workerFixture(t); const action = ensure(); f.ingest(action); await f.step();
	const retire = signed({ version: "1.0.0", hostId: "host", operation: "room.retire", roomId: action.roomId, conversationId: action.conversationId, retirementId: `retirement_${"a".repeat(32)}` });
	f.setLoseLeave(true); f.ingest(retire, false); assert.equal(f.store.room(action.roomId)?.retired, true, "intake precedes effects");
	await f.step(); assert.equal(f.store.get(retire.requestId)?.ack?.status, "pending");
	f.restart(); f.setLoseLeave(false); for (let i = 0; i < 3; i++) await f.step(); assert.equal(f.store.get(retire.requestId)?.ack?.status, "complete");
	assert.equal(f.effects.filter(v => v.startsWith("leave:")).length, 1, "already-left recovery does not repeat leave");
	f.ingest(action); await f.step(); assert.equal(f.effects.filter(v => v.startsWith("join:")).length, 1);
});

test("retirement received before ensure cannot cause a join just to obtain cleanup authority", async t => {
	const f = await workerFixture(t); const action = ensure();
	const retire = signed({ version: "1.0.0", hostId: "host", operation: "room.retire", roomId: action.roomId, conversationId: action.conversationId, retirementId: `retirement_${"a".repeat(32)}` });
	f.ingest(retire, false); f.ingest(action); assert.equal(f.store.room(action.roomId)?.retired, true);
	for (let i = 0; i < 3; i++) await f.step();
	assert.equal(f.effects.some(e => e.startsWith("join:")), false);
});

test("departure is durable negative authority; foreign kicks do not retire and Space leave never cascades", async t => {
	const f = await workerFixture(t); const action = ensure(); f.ingest(action); await f.step();
	const foreign = leaveBatch(action.roomId, "$kick"); foreign.rooms.leave[action.roomId].timeline.events[0].sender = "@foreign:test";
	f.worker.ingest(foreign); assert.equal(f.store.room(action.roomId)?.retired, false);
	f.worker.ingest(leaveBatch(action.roomId, "$left")); assert.equal(f.store.room(action.roomId)?.retired, true);
	await f.step(); assert.equal(f.store.get(action.requestId)?.ack?.code, "departed");
	const project = signed({ version: "1.0.0", hostId: "host", operation: "room.ensure", roomId: action.project!.spaceId, kind: "project_space", creationKey: "ancestor", hostSpaceId: action.hostSpaceId, project: action.project, notificationSetup: "preserve" }) as EnsureRoom;
	f.store.pinRoom(project, bot); f.store.verified(project.roomId); f.worker.ingest(leaveBatch(project.roomId, "$space-left"));
	assert.equal(f.store.room(project.roomId)?.retired, false); assert.equal(f.effects.filter(e => e.startsWith("leave:")).length, 0);
});

test("departures after a trusted invitation but before attestation persist without joining or touching unrelated rooms", async t => {
	const f = await workerFixture(t); const action = ensure();
	f.worker.ingest({ rooms: { invite: { [action.roomId]: { invite_state: { events: [{ type: "m.room.member", sender: bot, state_key: owner, content: { membership: "invite" } }] } } } } });
	f.worker.ingest(leaveBatch(action.roomId, "$before-attestation")); f.restart();
	f.worker.ingest(leaveBatch(action.roomId, "$latest-before-attestation"));
	f.worker.ingest(leaveBatch("!unrelated:test", "$unrelated")); assert.equal(f.store.tracksMembership("!unrelated:test"), false);
	f.ingest(action); await f.step();
	assert.equal(f.store.room(action.roomId)?.retired, true); assert.equal(f.store.room(action.roomId)?.departure, "$latest-before-attestation");
	assert.equal(f.effects.some(e => e.startsWith("join:")), false); assert.equal(f.matrixRules.writes(), 0);
});

test("coordinator restoration is bound to one departure; replay cannot clear a later leave", async t => {
	const { project: _project, checkout: _checkout, ...base } = ensure();
	const action = signed({ ...base, kind: "coordinator", roomId: "!coordinator:test" }) as EnsureRoom;
	const f = await workerFixture(t, action); f.ingest(action); await f.step();
	f.joined.delete(action.roomId); f.worker.ingest(leaveBatch(action.roomId, "$first"));
	await f.step(); const firstRevision = f.store.get(action.requestId)!.ack!.revision;
	f.ingest(action); assert.equal(f.store.get(action.requestId)!.ack!.revision, firstRevision, "identical redelivery keeps the progress revision");
	const restore = (event: string) => signed({ version: "1.0.0", hostId: "host", operation: "coordinator.membership.restore", roomId: action.roomId, hostSpaceId: action.hostSpaceId, conversationId: action.conversationId, departureEventId: event });
	const first = restore("$first"); f.ingest(first); for (let i = 0; i < 3; i++) await f.step();
	assert.equal(f.store.get(first.requestId)?.ack?.status, "complete"); assert.equal(f.store.room(action.roomId)?.departure, undefined);
	f.restart(); f.worker.ingest(leaveBatch(action.roomId, "$first")); assert.equal(f.store.room(action.roomId)?.departure, undefined, "old sync replay does not undo completed restoration");
	f.joined.delete(action.roomId); f.worker.ingest(leaveBatch(action.roomId, "$second")); f.ingest(first); await f.step();
	assert.equal(f.store.room(action.roomId)?.departure, "$second"); assert.equal(f.joined.has(action.roomId), false);
	const second = restore("$second"); assert.notEqual(first.requestId, second.requestId); f.ingest(second); for (let i = 0; i < 3; i++) await f.step();
	assert.equal(f.store.get(second.requestId)?.ack?.status, "complete");
	f.ingest(action); await f.step(); assert.ok(f.store.get(action.requestId)!.ack!.revision > firstRevision, "ack invalidation and restart retain a monotonic high-water mark"); assert.equal(f.store.room(action.roomId)?.retired, false);
	assert.throws(() => signed({ ...second, departureEventId: undefined }));
});
