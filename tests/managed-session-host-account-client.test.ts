import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostAccountClient, type AccountActionBody } from "../config/agent/extensions/managed-sessions/relay/host-account-client.js";
import type { AccountAction, AccountAck } from "../config/agent/extensions/managed-sessions/live-workspace-contracts.js";

const owner = "@owner:test";
const body: AccountActionBody = { operation: "room.ensure", kind: "coordinator", roomId: "!coordinator:test", hostSpaceId: "!host:test", creationKey: "coordinator", conversationId: `conv_${"a".repeat(32)}`, notificationSetup: "preserve" };
function ack(action: AccountAction, status: AccountAck["status"] = "complete", extra = {}): AccountAck {
	return { version: action.version, hostId: action.hostId, requestId: action.requestId, payloadDigest: action.payloadDigest, status, ...extra };
}
function event(content: AccountAck, sender = owner): unknown { return { to_device: { events: [{ type: "lol.bepis.pi.account.ack.v1", sender, content }] } }; }
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
	const directory = await mkdtemp(join(tmpdir(), "host-account-")); t.after(() => rm(directory, { recursive: true, force: true }));
	let now = 1000; let fail = false; const sent: Array<{ txn: string; action: AccountAction }> = [];
	const port = { sendAccountRequest: async (user: string, device: string, txn: string, action: AccountAction) => {
		assert.equal(user, owner); assert.equal(device, "NAS");
		const saved = JSON.parse(await readFile(join(directory, "account.json"), "utf8"));
		assert.equal(saved.records.find((r: { action: AccountAction }) => r.action.requestId === action.requestId).transactionId, txn, "attempt persisted before HTTP");
		sent.push({ txn, action }); if (fail) throw Error("Reply lost");
	} };
	let client = new HostAccountClient(directory, "host", owner, "NAS", port, () => now); await client.load();
	t.after(() => client.close());
	return { get client() { return client; }, sent, directory, port, advance: () => { now += 30001; }, fail: (v: boolean) => { fail = v; },
		restart: async () => { await client.close(); client = new HostAccountClient(directory, "host", owner, "NAS", port, () => now); await client.load(); } };
}

test("host persists immutable scope before HTTP, retries uncertain sends exactly, and uses fresh accepted-send redelivery", async t => {
	const f = await fixture(t); const action = await f.client.request(body);
	assert.deepEqual(await f.client.request(body), action); assert.equal(f.sent.length, 0);
	f.fail(true); await assert.rejects(f.client.flush(new AbortController().signal)); const txn = f.sent[0].txn;
	await f.restart(); f.advance(); f.fail(false); await f.client.flush(new AbortController().signal);
	assert.equal(f.sent[1].txn, txn); f.advance(); await f.client.flush(new AbortController().signal);
	assert.notEqual(f.sent[2].txn, txn); assert.deepEqual(f.sent[2].action, action);
	const wrong = new HostAccountClient(f.directory, "host", owner, "OTHER", f.port); await assert.rejects(wrong.load(), /recipient changed/);
	await assert.rejects(f.client.request({ ...body, endpoint: "/arbitrary" } as unknown as AccountActionBody));
});

test("host only accepts authenticated matching acknowledgements and never regresses terminal progress", async t => {
	const f = await fixture(t); const action = await f.client.request({ ...body, kind: "conversation", project: { projectKey: `project_${"a".repeat(32)}`, spaceId: "!project:test" }, checkout: { checkoutId: `checkout_${"a".repeat(32)}`, spaceId: "!checkout:test" } });
	await f.client.ingest(event(ack(action), "@forged:test")); assert.equal(f.client.ack(action.requestId), undefined);
	await f.client.ingest(event({ ...ack(action), payloadDigest: "f".repeat(64) })); assert.equal(f.client.ack(action.requestId), undefined);
	await f.client.ingest(event(ack(action))); assert.equal(f.client.status(), "ready");
	await f.client.ingest(event(ack(action, "pending"))); assert.equal(f.client.ack(action.requestId)?.status, "complete");
	await f.client.ingest(event(ack(action, "rejected", { code: "departed", departureEventId: "$left" })));
	await f.client.ingest(event(ack(action))); assert.equal(f.client.ack(action.requestId)?.code, "departed");
	await f.restart(); assert.equal(f.client.departed()[0].requestId, action.requestId);
});

test("coordinator restore clears only matching departure acknowledgement and delayed old negatives cannot undo it", async t => {
	const f = await fixture(t); const ensure = await f.client.request(body);
	const departure = (id: string) => event(ack(ensure, "rejected", { code: "departed", departureEventId: id }));
	await f.client.ingest(departure("$first"));
	const restore = await f.client.request({ operation: "coordinator.membership.restore", roomId: body.roomId, hostSpaceId: "!host:test", conversationId: `conv_${"a".repeat(32)}`, departureEventId: "$first" });
	await f.client.ingest(event(ack(restore))); assert.equal(f.client.ack(ensure.requestId), undefined);
	await f.restart(); await f.client.ingest(departure("$first")); assert.equal(f.client.ack(ensure.requestId), undefined);
	await f.client.ingest(event(ack(ensure))); assert.equal(f.client.ack(ensure.requestId)?.status, "complete");
	await f.client.ingest(departure("$second")); await f.client.ingest(event(ack(restore)));
	assert.equal(f.client.ack(ensure.requestId)?.departureEventId, "$second");
});

test("completed cleanup is not retransmitted and slow sends do not hold acknowledgement intake", async t => {
	const f = await fixture(t);
	const action = await f.client.request({ operation: "room.retire", roomId: "!retired:test", conversationId: `conv_${"a".repeat(32)}`, retirementId: `retirement_${"a".repeat(32)}` });
	let release!: () => void; let entered!: () => void;
	const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
	f.port.sendAccountRequest = async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); };
	const sending = f.client.flush(new AbortController().signal); await enteredPromise;
	await f.client.ingest(event(ack(action))); release(); await sending;
	f.advance(); await f.client.flush(new AbortController().signal); assert.equal(f.sent.length, 0);
	assert.equal(f.client.ack(action.requestId)?.status, "complete");
});
