import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { BoundAdapterClient } from "../config/agent/extensions/managed-sessions/adapter/client.js";
import { HostLifecycle } from "../config/agent/extensions/managed-sessions/relay/host-lifecycle.js";
import { RelayRegistry } from "../config/agent/extensions/managed-sessions/relay/registry.js";
import { ConversationManifestStore } from "../config/agent/extensions/managed-sessions/relay/manifest-store.js";
import { ManagedMatrixClient } from "../config/agent/extensions/managed-sessions/relay/matrix-client.js";
import { ManagedSessionIpcServer } from "../config/agent/extensions/managed-sessions/relay/ipc-server.js";
import { deriveConversationId, deriveDeliveryId, parseManagedSessionEnvelope, type ManagedSessionEnvelope } from "../config/agent/extensions/managed-sessions/contracts.js";

test("refresh requires coordinator authority and literal confirmation", () => {
	const envelope = { protocolVersion: "1.0.0", messageId: "refresh-test", conversationId: deriveConversationId("host", "coordinator"), role: "coordinator_adapter", type: "lifecycle.request",
		payload: { request: { operation: "conversation.refresh", targetConversationId: deriveConversationId("host", "project"), confirmed: true } } };
	assert.equal(parseManagedSessionEnvelope(envelope).type, "lifecycle.request");
	assert.throws(() => parseManagedSessionEnvelope({ ...envelope, role: "ordinary_adapter" }));
	assert.throws(() => parseManagedSessionEnvelope({ ...envelope, payload: { request: { ...envelope.payload.request, confirmed: false } } }));
});

test("coordinator refresh refuses busy, preserves session and queue, and recovers failed same-session relaunch", { timeout: 30_000 }, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-refresh-")); t.after(() => rm(root, { recursive: true, force: true }));
	const workspace = join(root, "workspace"); await mkdir(join(workspace, "sub"), { recursive: true });
	const record = join(root, "launch.json"); const fail = join(root, "fail"); const sessions = join(root, "sessions");
	const launcher = join(root, "launcher");
	await writeFile(launcher, `#!${process.execPath}
const fs = require('node:fs');
const request = JSON.parse(fs.readFileSync(0, 'utf8')); const op = process.argv[3];
const placement = {rootKey:'projects',workspace:'workspace',relativeCwd:'sub'};
let result;
if(op==='workspace-resolve') result={...placement,workspacePath:${JSON.stringify(workspace)},cwd:${JSON.stringify(join(workspace, "sub"))},projectKey:'project_'+ 'a'.repeat(32),projectDisplayName:'workspace',checkoutDisplayName:'workspace'};
else if(op==='root-ensure') result={sessionName:'workspace'};
else if(op==='window-inspect') result={conversationId:request.conversationId,exists:false};
else if(op==='window-create') {
 if(fs.existsSync(${JSON.stringify(fail)})) process.exit(1);
 const env=Object.fromEntries(['ROOT_KEY','WORKSPACE','RELATIVE_CWD','WORKSPACE_PATH'].map(k=>[k,process.env['PI_MANAGED_SESSION_'+k]]));
 fs.writeFileSync(${JSON.stringify(record)},JSON.stringify({conversationId:request.conversationId,nonce:process.env.PI_MANAGED_SESSION_ATTACHMENT_NONCE,env}));
 result={conversationId:request.conversationId,sessionName:'workspace',windowId:'@7',paneId:'%8',...placement,role:'conversation'};
} else if(op==='window-terminate') result={terminated:true}; else process.exit(2);
console.log(JSON.stringify(result));
`, { mode: 0o700 });
	const registry = new RelayRegistry("refresh-host", join(root, "runtime"), new ConversationManifestStore(join(root, "manifests"))); await registry.load();
	let rooms = 0;
	const matrix = new ManagedMatrixClient({ homeserver: "https://matrix.example.com", accessToken: "dummy", botUserId: "@bot:example.com", operatorUserId: "@user:example.com" }, async (input) => {
		const path = new URL(String(input)).pathname;
		if (path.endsWith("/createRoom")) return Response.json({ room_id: `!room${++rooms}:example.com` });
		if (path.includes("/state/m.room.create/")) return Response.json({ creator: "@bot:example.com", ...(decodeURIComponent(path).includes("!room1:") ? { type: "m.space" } : {}) });
		if (path.endsWith("/joined_members")) return Response.json({ joined: { "@user:example.com": {} } });
		if (path.includes("/state/m.room.member/")) return Response.json({ membership: "join" });
		return Response.json({});
	});
	let lifecycle: HostLifecycle;
	const server = new ManagedSessionIpcServer(registry, { runtimeDirectory: join(root, "ipc"), onEnvelope: async (envelope, attachment) => {
		if (envelope.type !== "refresh.result") return undefined;
		lifecycle.acceptRefreshResult(attachment.conversationId, String(envelope.payload.refreshId), String(envelope.payload.status));
		return { protocolVersion: "1.0.0", messageId: "ack-refresh", inReplyTo: envelope.messageId, conversationId: attachment.conversationId,
			role: "relay", type: "self.result", payload: { operation: "refresh.result", status: "ok" } };
	} });
	await server.start(); t.after(() => server.close());
	lifecycle = new HostLifecycle({ hostId: "refresh-host", launcher, projectSessionDirectory: sessions, socketPath: server.socketPath, registry, matrix, server });
	const id = deriveConversationId("refresh-host", "project");
	const request = (operation: string, more: object = {}) => lifecycle.request({ protocolVersion: "1.0.0", messageId: "request", conversationId: deriveConversationId("refresh-host", "coordinator"),
		role: "coordinator_adapter", type: "lifecycle.request", payload: { request: { operation, targetConversationId: id, ...more } } } as ManagedSessionEnvelope);
	let busy = true;
	const clients: BoundAdapterClient[] = []; t.after(async () => { await Promise.all(clients.map((client) => client.close("shutdown"))); });
	async function attach(): Promise<BoundAdapterClient> {
		let launch: { nonce: string; env: object } | undefined;
		for (let attempt = 0; attempt < 300; attempt++) { try { launch = JSON.parse(await readFile(record, "utf8")); break; } catch { await new Promise((resolve) => setTimeout(resolve, 10)); } }
		assert.ok(launch);
		assert.deepEqual(launch.env, { ROOT_KEY: "projects", WORKSPACE: "workspace", RELATIVE_CWD: "sub", WORKSPACE_PATH: workspace });
		const manifest = registry.manifestByConversationId(id)!;
		const client = new BoundAdapterClient({ socketPath: server.socketPath, role: "ordinary_adapter", attachmentNonce: launch.nonce,
			binding: { version: "1.0.0", role: "ordinary_adapter", conversationId: id, sessionId: manifest.piSessionId, concept: manifest.concept, bindingBoundaryEntryId: manifest.bindingBoundaryEntryId },
			onEnvelope: async (envelope) => { if (envelope.type === "refresh.request") { await client.refreshResult(String(envelope.payload.refreshId), busy ? "busy" : "ready"); if (!busy) await client.close("shutdown"); } },
		}); clients.push(client); await client.connect(); return client;
	}
	const attaching = attach();
	await request("conversation.start", { creationKey: "project", concept: "refresh work", placement: { rootKey: "projects", workspace: "workspace", relativeCwd: "sub" } });
	const original = await attaching;
	await registry.updateActiveGenerationModel(id, "scoped/model"); await registry.updateActiveGenerationThinking(id, "high");
	const manifest = registry.manifestByConversationId(id)!; const history = await readFile(join(sessions, id, "session.jsonl"), "utf8");
	await assert.rejects(() => request("conversation.refresh", { confirmed: true }), /busy/); assert.equal(original.connected, true);
	assert.equal(registry.isRefreshing(id), false);
	const queued = { deliveryId: deriveDeliveryId(id, "$queued"), matrixEventId: "$queued", kind: "prompt" as const, body: "preserve me", status: "accepted" as const };
	await registry.recordAcceptedInput(id, queued);
	busy = false; await rm(record); const reattaching = attach();
	assert.equal((await request("conversation.refresh", { confirmed: true })).conversationState, "active"); await reattaching;
	assert.deepEqual(registry.manifestByConversationId(id), manifest); assert.deepEqual(registry.pendingInputs(id), [queued]);
	assert.equal(await readFile(join(sessions, id, "session.jsonl"), "utf8"), history); assert.equal(rooms, 2);
	await writeFile(fail, "fail"); await assert.rejects(() => request("conversation.refresh", { confirmed: true }), /window-create failed/);
	assert.equal(registry.conversationState(id), "dormant"); assert.deepEqual(registry.pendingInputs(id), [queued]);
	await rm(fail); await rm(record); const recovering = attach(); await request("conversation.refresh", { confirmed: true }); await recovering;
	assert.deepEqual(registry.manifestByConversationId(id), manifest); assert.deepEqual(registry.pendingInputs(id), [queued]);
});
