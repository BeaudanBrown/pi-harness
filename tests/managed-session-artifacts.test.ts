import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createHash } from "node:crypto";
import { resolveWorkspaceArtifact, artifactChunks } from "../config/agent/extensions/managed-sessions/adapter/artifact-export.js";
import { ManagedArtifactExporter } from "../config/agent/extensions/managed-sessions/relay/artifact-export.js";
import { BlobSpool } from "../config/agent/extensions/managed-sessions/relay/blob-spool.js";
import { ConversationManifestStore } from "../config/agent/extensions/managed-sessions/relay/manifest-store.js";
import { ManagedMatrixClient } from "../config/agent/extensions/managed-sessions/relay/matrix-client.js";
import { RelayRegistry } from "../config/agent/extensions/managed-sessions/relay/registry.js";
import { MANAGED_SESSION_PROTOCOL_VERSION, MANAGED_SESSION_STATE_VERSION, deriveConversationId, deriveTranscriptEntryId, parseManagedSessionEnvelope, type ConversationManifest } from "../config/agent/extensions/managed-sessions/contracts.js";

const hostId = "artifact-host";
const conversationId = deriveConversationId(hostId, "artifact-work");
const roomId = "!artifact:example.com";
const matrixConfig = { homeserver: "https://matrix.example.com", accessToken: "secret", botUserId: "@bot:example.com", operatorUserId: "@operator:example.com" };

async function temporary(t: TestContext): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "managed-artifact-")); t.after(() => rm(root, { recursive: true, force: true })); return root;
}

async function registryFixture(root: string): Promise<{ registry: RelayRegistry; store: ConversationManifestStore }> {
	const store = new ConversationManifestStore(join(root, "manifests"));
	const manifest: ConversationManifest = { schemaVersion: MANAGED_SESSION_STATE_VERSION, kind: "project", conversationId, ownerHostId: hostId,
		creationKey: "artifact-work", concept: "artifact", piSessionId: "artifact-session", roomId,
		placement: { rootKey: "projects", workspace: "workspace", relativeCwd: "sub" },
		bindingBoundaryEntryId: deriveTranscriptEntryId("artifact-session", "boundary"), createdAt: "2026-09-03T00:00:00.000Z" };
	await store.write(manifest); const registry = new RelayRegistry(hostId, join(root, "runtime"), store); await registry.load(); return { registry, store };
}

test("workspace artifact resolution confines paths and validates safe content before transfer", async (t) => {
	const root = await temporary(t); const workspace = join(root, "workspace"); const cwd = join(workspace, "sub");
	await mkdir(join(workspace, ".git"), { recursive: true }); await mkdir(join(workspace, "secrets"), { recursive: true }); await mkdir(cwd, { recursive: true });
	await writeFile(join(workspace, "report.json"), JSON.stringify({ ok: true })); await writeFile(join(workspace, ".git", "config"), "secret");
	await writeFile(join(workspace, "pixel.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
	await writeFile(join(root, "outside.txt"), "outside"); await symlink(join(root, "outside.txt"), join(workspace, "link.txt"));
	await writeFile(join(workspace, "program.txt"), Buffer.from("7f454c4602010100", "hex")); await writeFile(join(workspace, "credentials.json"), "{}"); await writeFile(join(workspace, "secrets", "report.txt"), "secret");
	const artifact = await resolveWorkspaceArtifact({ requestedPath: "report.json", cwd, workspacePath: workspace, placement: { rootKey: "projects", workspace: "workspace", relativeCwd: "sub" }, conversationId, toolCallId: "tool-1" });
	assert.equal(artifact.filename, "report.json"); assert.equal(artifact.mimeType, "application/json"); assert.equal(artifact.mediaType, "file");
	assert.equal(artifact.sha256, createHash("sha256").update(artifact.data).digest("hex"));
	const image = await resolveWorkspaceArtifact({ requestedPath: "pixel.png", cwd, workspacePath: workspace, placement: { rootKey: "projects", workspace: "workspace", relativeCwd: "sub" }, conversationId, toolCallId: "tool-image" });
	assert.deepEqual({ mediaType: image.mediaType, mimeType: image.mimeType, width: image.width, height: image.height }, { mediaType: "image", mimeType: "image/png", width: 1, height: 1 });
	for (const path of ["../outside.txt", ".git/config", "link.txt", "program.txt", "credentials.json", "secrets/report.txt"]) await assert.rejects(
		() => resolveWorkspaceArtifact({ requestedPath: path, cwd, workspacePath: workspace, placement: { rootKey: "projects", workspace: "workspace", relativeCwd: "sub" }, conversationId, toolCallId: `reject-${path}` }),
		/relative|hidden|workspace|symlink|Executable|sensitive|allowlist/,
	);
});

test("host-resolved workspace anchoring and bounded parsing reject lookalike roots and malformed media", async (t) => {
	const root = await temporary(t); const workspace = join(root, "workspace"); const cwd = join(workspace, "sub"); const decoy = join(root, "decoy", "workspace", "sub");
	await mkdir(cwd, { recursive: true }); await mkdir(decoy, { recursive: true });
	const malformed = Buffer.alloc(24); Buffer.from("89504e470d0a1a0a", "hex").copy(malformed); malformed.writeUInt32BE(1, 16); malformed.writeUInt32BE(1, 20);
	await writeFile(join(workspace, "broken.png"), malformed); await writeFile(join(decoy, "report.txt"), "outside");
	await assert.rejects(() => resolveWorkspaceArtifact({ requestedPath: "report.txt", cwd: decoy, workspacePath: workspace,
		placement: { rootKey: "projects", workspace: "workspace", relativeCwd: "sub" }, conversationId, toolCallId: "lookalike" }), /host-resolved/);
	await assert.rejects(() => resolveWorkspaceArtifact({ requestedPath: "broken.png", cwd, workspacePath: workspace,
		placement: { rootKey: "projects", workspace: "workspace", relativeCwd: "sub" }, conversationId, toolCallId: "malformed" }), /decode validation/);
});

test("artifact IPC rejects changed chunk digests and unsafe image metadata", () => {
	const data = Buffer.from("chunk"); const uploadId = `upload_${"a".repeat(32)}`; const blobId = `blob_${"b".repeat(32)}`;
	const chunk = { protocolVersion: MANAGED_SESSION_PROTOCOL_VERSION, messageId: "artifact-chunk", conversationId, role: "ordinary_adapter", type: "artifact.chunk",
		payload: { uploadId, blobId, index: 0, sha256: createHash("sha256").update(data).digest("hex"), data: data.toString("base64") } };
	assert.equal(parseManagedSessionEnvelope(chunk).type, "artifact.chunk");
	assert.throws(() => parseManagedSessionEnvelope({ ...chunk, payload: { ...chunk.payload, sha256: "0".repeat(64) } }), /digest/);
	assert.throws(() => parseManagedSessionEnvelope({ ...chunk, type: "artifact.begin", payload: { uploadId, blobId, sha256: "0".repeat(64), filename: "../secret",
		mimeType: "image/png", mediaType: "image", byteLength: 1, chunkCount: 1, width: 1, height: 1 } }), /schema|filename/);
});

test("Matrix artifact events use the image, audio, and generic file message types with safe metadata", async () => {
	const bodies: unknown[] = []; const matrix = new ManagedMatrixClient(matrixConfig, async (_input, init) => { bodies.push(JSON.parse(String(init?.body))); return Response.json({ event_id: `$${bodies.length}` }); }, [roomId], { maxAttempts: 1 });
	await matrix.sendMedia(roomId, "artifact-image", { contentUri: "mxc://example.com/image", filename: "pixel.png", mimeType: "image/png", mediaType: "image", byteLength: 10, width: 1, height: 1 });
	await matrix.sendMedia(roomId, "artifact-audio", { contentUri: "mxc://example.com/audio", filename: "clip.wav", mimeType: "audio/wav", mediaType: "audio", byteLength: 44 });
	await matrix.sendMedia(roomId, "artifact-file", { contentUri: "mxc://example.com/file", filename: "report.pdf", mimeType: "application/pdf", mediaType: "file", byteLength: 100 });
	assert.deepEqual((bodies as Array<any>).map((body) => [body.msgtype, body.info]), [
		["m.image", { mimetype: "image/png", size: 10, w: 1, h: 1 }], ["m.audio", { mimetype: "audio/wav", size: 44 }], ["m.file", { mimetype: "application/pdf", size: 100 }],
	]);
});

test("artifact transfer reservations are bounded before incomplete chunks reach the spool", async (t) => {
	const root = await temporary(t); const { registry } = await registryFixture(root); const spool = new BlobSpool(join(root, "spool")); await spool.initialize(new Set());
	const matrix = new ManagedMatrixClient(matrixConfig, async () => { throw new Error("Matrix must not be contacted for incomplete transfers"); }, [roomId], { maxAttempts: 1 });
	const exporter = new ManagedArtifactExporter(spool, registry, matrix);
	for (let index = 0; index < 2; index += 1) assert.equal(await exporter.begin(conversationId, { uploadId: `upload_${String(index).padStart(32, "a")}`,
		blobId: `blob_${String(index).padStart(32, "b")}`, sha256: String(index).padStart(64, "c"), filename: `file-${index}.txt`, mimeType: "text/plain", mediaType: "file", byteLength: 1, chunkCount: 1 }), "ready");
	await assert.rejects(() => exporter.begin(conversationId, { uploadId: `upload_${"d".repeat(32)}`, blobId: `blob_${"e".repeat(32)}`, sha256: "f".repeat(64),
		filename: "overflow.txt", mimeType: "text/plain", mediaType: "file", byteLength: 1, chunkCount: 1 }), /capacity/);
	assert.equal((await spool.list()).length, 0);
});

test("artifact export persists every side-effect boundary and recovers one stable Matrix event", async (t) => {
	const root = await temporary(t); const workspace = join(root, "workspace"); const cwd = join(workspace, "sub"); await mkdir(cwd, { recursive: true });
	await writeFile(join(workspace, "result.md"), "# Result\n\nBounded output.\n");
	const artifact = await resolveWorkspaceArtifact({ requestedPath: "result.md", cwd, workspacePath: workspace, placement: { rootKey: "projects", workspace: "workspace", relativeCwd: "sub" }, conversationId, toolCallId: "tool-stable" });
	const requests: Array<{ method: string; path: string; body?: unknown }> = []; let failSend = true;
	const matrix = new ManagedMatrixClient(matrixConfig, async (input, init) => {
		const url = new URL(String(input)); requests.push({ method: init?.method ?? "GET", path: url.pathname, body: init?.body });
		if (url.pathname === "/_matrix/media/v1/create") return Response.json({ content_uri: "mxc://example.com/reserved", unused_expires_at: Date.now() + 60_000 });
		if (url.pathname.includes("/_matrix/media/v3/upload/")) return Response.json({});
		if (url.pathname.includes("/send/m.room.message/")) { if (failSend) throw new Error("uncertain send"); return Response.json({ event_id: "$artifact" }); }
		throw new Error(`unexpected ${url.pathname}`);
	}, [roomId], { maxAttempts: 1 });
	let { registry, store } = await registryFixture(root); const spool = new BlobSpool(join(root, "spool")); await spool.initialize(registry.liveMediaBlobIds());
	let exporter = new ManagedArtifactExporter(spool, registry, matrix);
	const descriptor = { uploadId: artifact.uploadId, blobId: artifact.blobId, sha256: artifact.sha256, filename: artifact.filename, mimeType: artifact.mimeType,
		mediaType: artifact.mediaType, byteLength: artifact.byteLength, chunkCount: artifactChunks(artifact.data).length };
	assert.equal(await exporter.begin(conversationId, descriptor), "ready");
	await assert.rejects(async () => { for (const [index, chunk] of artifactChunks(artifact.data).entries()) await exporter.chunk(conversationId, {
		uploadId: artifact.uploadId, blobId: artifact.blobId, index, sha256: createHash("sha256").update(chunk).digest("hex"), data: chunk.toString("base64"),
	}); }, /upload|send|failed/i);
	assert.equal(registry.artifactExports(conversationId)[0]?.artifact.state, "uploaded");
	registry = new RelayRegistry(hostId, join(root, "runtime"), store); await registry.load(); await spool.initialize(registry.liveMediaBlobIds());
	failSend = false; exporter = new ManagedArtifactExporter(spool, registry, matrix); await exporter.reconcile();
	assert.equal(registry.artifactExports(conversationId)[0]?.artifact.state, "sent");
	assert.equal((await spool.list()).length, 0); assert.equal(await exporter.begin(conversationId, descriptor), "sent");
	assert.equal(requests.filter((request) => request.path === "/_matrix/media/v1/create").length, 1);
	assert.equal(requests.filter((request) => request.path.includes("/_matrix/media/v3/upload/")).length, 1);
	const sends = requests.filter((request) => request.path.includes("/send/m.room.message/")); assert.equal(sends.length, 2);
	assert.equal(sends[0]?.path, sends[1]?.path, "uncertain room send retries the stable transaction ID");
	const content = JSON.parse(String(sends[1]?.body));
	assert.deepEqual(content, { msgtype: "m.file", body: "result.md", filename: "result.md", url: "mxc://example.com/reserved",
		info: { mimetype: "text/markdown", size: artifact.byteLength } }, "Matrix receives only bounded media metadata and the MXC URI");
});
