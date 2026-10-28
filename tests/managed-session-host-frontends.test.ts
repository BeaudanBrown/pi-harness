import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ManagedHostParameters, managedHostAction, managedHostHelp } from "../config/agent/extensions/managed-sessions/host-tool.js";
import { hostCommandAction, roomHostCommand } from "../config/agent/extensions/managed-sessions/host-command.js";
import { HostMatrixCommands } from "../config/agent/extensions/managed-sessions/relay/host-matrix-commands.js";
import { HostDispatcher } from "../config/agent/extensions/managed-sessions/relay/host-dispatcher.js";
import { HostPolicy } from "../config/agent/extensions/managed-sessions/relay/host-policy.js";
import type { ConversationManifest } from "../config/agent/extensions/managed-sessions/contracts.js";
const conversationId = `conv_${"a".repeat(32)}`, protectedId = `conv_${"b".repeat(32)}`;

test("managed host has a flat provider schema and exact operation-specific validation", () => {
	const schema = JSON.stringify(ManagedHostParameters); assert.equal(/anyOf|oneOf/.test(schema), false);
	assert.equal(JSON.parse(schema).additionalProperties, false); assert.deepEqual(ManagedHostParameters.required, ["operation"]);
	assert.equal(managedHostAction({ operation: "help" }), "help"); assert.ok(managedHostHelp().length < 8192);
	assert.deepEqual(managedHostAction({ operation: "conversation.create", creationKey: "new", title: "New room", rootKey: "projects", workspace: "app" }), { operation: "conversation.create", creationKey: "new", title: "New room", placement: { rootKey: "projects", workspace: "app", relativeCwd: "" } });
	for (const value of [{ operation: "help", confirmed: true }, { operation: "host.status", conversationId }, { operation: "conversation.delete", conversationId }, { operation: "conversation.open", conversationId: "title" }, { operation: "host.status", actor: "human_local" }, { operation: "host.status", command: "rm" }]) assert.throws(() => managedHostAction(value));
});

test("terminal and room controls parse arguments without shell evaluation or prompt construction", () => {
	assert.deepEqual(hostCommandAction('conversation create --creation-key one --title "Two words" --root-key projects --workspace app'), { operation: "conversation.create", creationKey: "one", title: "Two words", placement: { rootKey: "projects", workspace: "app", relativeCwd: "" } });
	assert.deepEqual(roomHostCommand("!start", conversationId), { operation: "conversation.resume", conversationId });
	assert.deepEqual(hostCommandAction(`conversation migrate ${conversationId} --confirmed`), { operation: "conversation.migrate", conversationId, confirmed: true });
	assert.throws(() => hostCommandAction(`conversation migrate ${conversationId}`));
	assert.deepEqual(hostCommandAction(`conversation recover preview ${conversationId}`), { operation: "conversation.recover.preview", conversationId });
	const recovery = { operation: "conversation.recover.apply", previewId: `preview_${"1".repeat(32)}`, confirmed: true, operatorClosed: true, acceptIncompleteInspection: true };
	assert.deepEqual(hostCommandAction(`conversation recover apply --preview-id ${recovery.previewId} --confirmed --operator-closed --accept-incomplete-inspection`), recovery);
	assert.deepEqual(managedHostAction(recovery), recovery);
	for (const field of ["confirmed", "operatorClosed", "acceptIncompleteInspection"]) {
		const invalid = { ...recovery } as Record<string, unknown>; delete invalid[field]; assert.throws(() => managedHostAction(invalid));
	}
	assert.deepEqual(roomHostCommand("!close --confirm", conversationId), { operation: "conversation.delete", conversationId, confirmed: true });
	for (const alias of ["delete", "close"]) assert.deepEqual(hostCommandAction(`${alias} ${conversationId} --confirm`), { operation: "conversation.delete", conversationId, confirmed: true });
	for (const text of ["!abort", "!model", "!thinking high", "!compact", "!new", "ordinary task"]) assert.equal(roomHostCommand(text, conversationId), undefined);
	for (const text of ["!start do something", "!close", "!stop --force", "!host conversation open title", "!host host status --request-id forged", '!host conversation create --title "unfinished']) assert.throws(() => roomHostCommand(text, conversationId));
});

test("Matrix never displays a partial bulk preview with an applicable token", async t => {
	const root = await mkdtemp(join(tmpdir(), "host-preview-display-")); t.after(() => rm(root, { recursive: true, force: true }));
	const policy = new HostPolicy(JSON.parse(await readFile("config/agent/managed-host-policy.json", "utf8")));
	const ids = Array.from({ length: 100 }, (_, n) => `conv_${n.toString(16).padStart(32, "0")}`); let text = "";
	const dispatcher = new HostDispatcher({ hostId: "host", protectedConversationId: protectedId, policy, read: async () => ({ previewId: `preview_${"a".repeat(32)}`, expiresAt: new Date(Date.now() + 60000).toISOString(), targets: ids.map(conversationId => ({ kind: "conversation", conversationId })), activeRuns: [], blockers: [] }) });
	const commands = new HostMatrixCommands(join(root, "intake.json"), "host", "@owner:test", dispatcher, async (_id, _manifest, value) => { text = value; }); await commands.load();
	await commands.accept({ conversationId, roomId: "!room:test" } as ConversationManifest, "$bulk", "@owner:test", `!host conversation delete preview --conversation-ids ${ids.join(",")}`);
	assert.match(text, /No partial preview/); assert.equal(text.includes("preview_"), false); await commands.close();
});

test("Matrix command effects do not hold intake and shutdown drains admitted work", async t => {
	const root = await mkdtemp(join(tmpdir(), "host-command-drain-")); t.after(() => rm(root, { recursive: true, force: true }));
	const policy = new HostPolicy(JSON.parse(await readFile("config/agent/managed-host-policy.json", "utf8")));
	let entered!: () => void, release!: () => void; const started = new Promise<void>(resolve => { entered = resolve; }), hold = new Promise<void>(resolve => { release = resolve; });
	const dispatcher = new HostDispatcher({ hostId: "host", protectedConversationId: protectedId, policy, read: async () => ({ hostId: "host", relayState: "ready", accountState: "pending", capabilities: [] }), humanMutation: async () => { entered(); await hold; return { conversationId, runtimeState: "stopped" }; } });
	const commands = new HostMatrixCommands(join(root, "intake.json"), "host", "@owner:test", dispatcher, async () => {}); await commands.load();
	const manifest = { conversationId, roomId: "!room:test" } as ConversationManifest;
	const stopping = commands.accept(manifest, "$stop", "@owner:test", "!stop"); await started;
	assert.equal(await commands.accept({ ...manifest, roomId: "!other:test" }, "$read", "@owner:test", "!host host status"), true);
	let closed = false; const closing = commands.close().then(() => { closed = true; });
	await assert.rejects(commands.accept(manifest, "$late", "@owner:test", "!start"), /stopping/); assert.equal(closed, false);
	release(); await stopping; await closing; assert.equal(closed, true);
});

test("malformed operator commands are consumed before an uncertain help reply", async t => {
	const root = await mkdtemp(join(tmpdir(), "host-invalid-command-")); t.after(() => rm(root, { recursive: true, force: true })); let replies = 0;
	const dispatcher = {} as HostDispatcher; const make = () => new HostMatrixCommands(join(root, "intake.json"), "host", "@owner:test", dispatcher, async () => { replies++; throw Error("reply accepted but response lost"); });
	let commands = make(); await commands.load(); const manifest = { conversationId, roomId: "!room:test" } as ConversationManifest;
	await assert.rejects(commands.accept(manifest, "$invalid", "@owner:test", "!close"), /response lost/); await commands.close();
	commands = make(); await commands.load(); assert.equal(await commands.accept(manifest, "$invalid", "@owner:test", "!close"), true); assert.equal(replies, 1); await commands.close();
});

test("human Matrix host actions authenticate, protect coordinator, consume before effects and never replay uncertainty", async t => {
	const root = await mkdtemp(join(tmpdir(), "host-frontends-")); t.after(() => rm(root, { recursive: true, force: true }));
	const policy = new HostPolicy(JSON.parse(await readFile("config/agent/managed-host-policy.json", "utf8")));
	let effects = 0; const replies: string[] = [];
	const dispatcher = new HostDispatcher({ hostId: "host", protectedConversationId: protectedId, policy, read: async () => ({ hostId: "host", relayState: "ready", accountState: "pending", capabilities: ["host-control-v1"] }), humanMutation: async () => { effects++; throw Error("uncertain effect"); } });
	const file = join(root, "intake.json"); const make = () => new HostMatrixCommands(file, "host", "@owner:test", dispatcher, async (_event, _manifest, text) => { replies.push(text); });
	let commands = make(); await commands.load(); const manifest = { conversationId, roomId: "!room:test" } as ConversationManifest;
	await commands.accept(manifest, "$foreign", "@other:test", "!close --confirm"); assert.equal(effects, 0); assert.equal(replies.length, 0);
	await commands.accept({ ...manifest, conversationId: protectedId }, "$protected", "@owner:test", "!stop"); assert.equal(effects, 0); assert.match(replies.at(-1)!, /forbidden/);
	await commands.accept(manifest, "$once", "@owner:test", "!close --confirm"); assert.equal(effects, 1);
	await commands.close(); commands = make(); await commands.load();
	await commands.accept(manifest, "$once", "@owner:test", "!close --confirm"); assert.equal(effects, 1);
	const journal = JSON.parse(await readFile(file, "utf8")); assert.equal(journal.ids.length, 2); assert.equal(JSON.stringify(journal).includes("uncertain effect"), false);
	await commands.accept(manifest, "$new", "@owner:test", "!close --confirm"); assert.equal(effects, 2, "only a new explicit operator event admits another attempt");
});
