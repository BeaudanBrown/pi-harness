import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { deriveConversationId, deriveDeliveryId, parseManagedSessionEnvelope } from "../config/agent/extensions/managed-sessions/contracts.js";
import { deriveBlobId, deriveInboundBlobId } from "../config/agent/extensions/managed-sessions/v2-contracts.js";
import { BlobSpool } from "../config/agent/extensions/managed-sessions/relay/blob-spool.js";
import { authorizedRoomEvents } from "../config/agent/extensions/managed-sessions/relay/coordinator-router.js";
import { CAPTIONLESS_IMAGE_PROMPT, ManagedImageTransport } from "../config/agent/extensions/managed-sessions/relay/image-media.js";
import { ManagedMatrixClient, ManagedMatrixError } from "../config/agent/extensions/managed-sessions/relay/matrix-client.js";

import { validateImageDecode } from "../config/agent/extensions/managed-sessions/image-validation.js";

const execFileAsync = promisify(execFile);
const config = { homeserver: "https://matrix.example.com", accessToken: "secret", botUserId: "@bot:example.com", operatorUserId: "@operator:example.com" };
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const conversationId = deriveConversationId("host", "media");

function imageEvent(id: string, overrides: Record<string, unknown> = {}) {
	return { event_id: id, origin_server_ts: Date.now(), sender: config.operatorUserId, type: "m.room.message", content: {
		msgtype: "m.image", body: "photo.png", url: "mxc://example.com/media", info: { mimetype: "image/png", size: png.length, w: 1, h: 1 }, ...overrides,
	} };
}
function sync(events: unknown[]) { return { rooms: { join: { "!room:example.com": { state: { events: [{ type: "m.room.member", state_key: config.operatorUserId, content: { membership: "join" } }] }, timeline: { events } } } } }; }

async function temp(t: TestContext): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "managed-media-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	return root;
}

test("authorized managed-room image parsing accepts Element captions and fails closed for foreign, encrypted, and malformed media", () => {
	const events = [imageEvent("$caption", { body: "inspect this", filename: "photo.png" }), imageEvent("$plain"),
		imageEvent("$no-size", { info: { mimetype: "image/png" } }), imageEvent("$bad-size", { info: { mimetype: "image/png", size: "stale" } }),
		{ ...imageEvent("$foreign"), sender: "@other:example.com" }, imageEvent("$encrypted", { url: undefined, file: { url: "mxc://example.com/encrypted" } }),
		imageEvent("$gif", { info: { mimetype: "image/gif", size: 20, w: 1, h: 1 } }), imageEvent("$relation", { "m.relates_to": { rel_type: "m.thread", event_id: "$x" } })];
	assert.deepEqual(authorizedRoomEvents(sync(events), "!room:example.com", new Set([config.operatorUserId]), true).map((event) => event.kind === "image" ? [event.eventId, event.caption] : event.kind), [
		["$caption", "inspect this"], ["$plain", undefined], ["$no-size", undefined], ["$bad-size", undefined],
	]);
});

test("authenticated media download preserves bytes without leaking credentials", async () => {
	const requests: Array<{ path: string; authorization: string | null }> = [];
	const client = new ManagedMatrixClient(config, async (input, init) => {
		requests.push({ path: new URL(String(input)).pathname, authorization: new Headers(init?.headers).get("authorization") });
		return new Response(png, { headers: { "content-type": "image/png", "content-length": String(png.length) } });
	}, ["!room:example.com"], { maxAttempts: 1 });
	assert.deepEqual((await client.downloadMedia("mxc://example.com/media")).bytes, png);
	assert.deepEqual(requests, [{ path: "/_matrix/client/v1/media/download/example.com/media", authorization: "Bearer secret" }]);
	await assert.rejects(() => client.downloadMedia("https://example.com/media"), (error: unknown) => error instanceof ManagedMatrixError && error.code === "invalid_response");
});

test("media download leaves HTTP framing to fetch rather than interpreting size headers", async () => {
	for (const header of [null, "68", "", "invalid", "-1", "1.5", "9007199254740992", "67"]) {
		const headers: Record<string, string> = { "content-type": "image/png" };
		if (header !== null) headers["content-length"] = header;
		const client = new ManagedMatrixClient(config, async () => new Response(png, { headers }), [], { maxAttempts: 1 });
		assert.deepEqual((await client.downloadMedia("mxc://example.com/media")).bytes, png);
	}
});

test("real fetch body failures and HTTP errors remain download errors", async () => {
	for (const response of [() => new Response("unavailable", { status: 503 }), () => new Response(new ReadableStream({ start(controller) { controller.error(new Error("connection lost")); } }))]) {
		const client = new ManagedMatrixClient(config, async () => response(), [], { maxAttempts: 1 });
		await assert.rejects(() => client.downloadMedia("mxc://example.com/media"), (error: unknown) => error instanceof ManagedMatrixError && ["http", "network"].includes(error.code));
	}
});

test("large inbound bytes survive spool, IPC and restart without changing outbound limits", async (t) => {
	const root = await temp(t);
	const bytes = Buffer.alloc(25 * 1024 * 1024 + 1); png.copy(bytes);
	const matrix = new ManagedMatrixClient(config, async () => new Response(bytes), [], { maxAttempts: 1 });
	const spool = new BlobSpool(join(root, "spool"), { maxBlobBytes: 100, maxTotalBytes: 100 });
	const transport = new ManagedImageTransport(spool, matrix); await transport.initialize(new Set());
	const { image, prompt } = await transport.accept(conversationId, { kind: "image", eventId: "$large", senderUserId: config.operatorUserId,
		mxcUrl: "mxc://example.com/large", declaredMimeType: "image/png", declaredSize: 1, declaredWidth: 100_000, declaredHeight: 100_000 });
	assert.equal(image.byteLength, bytes.length); assert.ok(image.chunkCount > 800);
	const recovered = new BlobSpool(spool.root); await recovered.initialize(new Set([image.blobId]));
	assert.deepEqual(await recovered.read(image), bytes);
	let frames = 0; const digest = createHash("sha256");
	const server = { sendToConversation: (frame: any) => {
		parseManagedSessionEnvelope(frame); frames++;
		if (frame.type === "media.chunk") digest.update(Buffer.from(frame.payload.data, "base64"));
		return true;
	} } as any;
	await transport.deliver(server, conversationId, { deliveryId: deriveDeliveryId(conversationId, "$large"), matrixEventId: "$large", kind: "prompt", body: prompt, media: image });
	assert.equal(frames, image.chunkCount + 1); assert.equal(digest.digest("hex"), image.sha256);
	await assert.rejects(() => recovered.commit(image, bytes), /size/);
	const smallDigest = createHash("sha256").update(png).digest("hex");
	const small = { sha256: smallDigest, mimeType: "image/png", byteLength: png.length, width: 1, height: 1 };
	await spool.commitInbound({ ...small, blobId: deriveInboundBlobId(conversationId, smallDigest) }, png);
	await spool.commit({ ...small, blobId: deriveBlobId(conversationId, smallDigest) }, png);
	assert.notEqual(deriveInboundBlobId(conversationId, smallDigest), deriveBlobId(conversationId, smallDigest), "same incoming/outgoing content has independent metadata and quota accounting");
	const other = Buffer.alloc(png.length); const otherDigest = createHash("sha256").update(other).digest("hex");
	await assert.rejects(() => spool.commit({ ...small, blobId: deriveBlobId(conversationId, otherDigest), sha256: otherDigest }, other), /quota/);
});

test("blob spool is content-addressed, digest verified, private, atomic, and never cleans live recovery state", async (t) => {
	const root = await temp(t); const spool = new BlobSpool(join(root, "spool")); await spool.initialize(new Set());
	const sha256 = createHash("sha256").update(png).digest("hex"); const blobId = deriveBlobId(conversationId, sha256);
	const blob = await spool.commit({ blobId, sha256, mimeType: "image/png", byteLength: png.length, width: 1, height: 1 }, png, 0);
	assert.deepEqual(await spool.read(blob), png);
	assert.equal((await readFile(join(root, "spool", "metadata", `${blobId}.json`), "utf8")).includes(sha256), true);
	await spool.cleanup(new Set([blobId]), 2 * 24 * 60 * 60 * 1_000);
	assert.deepEqual(await spool.read(blob), png, "live recovery blobs survive retention cleanup");
	await assert.rejects(() => spool.remove(blobId, new Set([blobId])), /live recovery/);
	await spool.remove(blobId, new Set());
	assert.equal((await spool.list()).length, 0);
	await assert.rejects(() => spool.commit({ ...blob, sha256: "0".repeat(64) }, png), /digest/);
	const orphan = await spool.commit({ blobId, sha256, mimeType: "image/png", byteLength: png.length, width: 1, height: 1 }, png, 0);
	await new BlobSpool(join(root, "spool")).initialize(new Set(), 1);
	await assert.rejects(() => spool.read(orphan), /unavailable/, "restart cleanup removes committed data with no durable live reference");

	const quota = new BlobSpool(join(root, "quota"), { maxBlobs: 3, maxBlobBytes: 3, maxTotalBytes: 4 }); await quota.initialize(new Set());
	const commit = async (name: string, bytes: Buffer) => { const digest = createHash("sha256").update(bytes).digest("hex");
		return quota.commit({ blobId: deriveBlobId(deriveConversationId("host", name), digest), sha256: digest, mimeType: "image/png", byteLength: bytes.length, width: 1, height: 1 }, bytes); };
	await commit("one", Buffer.from([1, 2, 3]));
	await assert.rejects(() => commit("two", Buffer.from([4, 5])), /quota/, "aggregate byte quota is enforced independently of per-blob bounds");
	await writeFile(join(root, "quota", "metadata", `blob_${"f".repeat(32)}.json`), JSON.stringify({ ...blob, blobId: `blob_${"f".repeat(32)}`, width: 20_000 }));
	await assert.rejects(() => quota.list(), /Malformed/, "persisted spool metadata enforces image dimension bounds");
});

test("blob spool enforces its blob-count quota", async (t) => {
	const root = await temp(t); const spool = new BlobSpool(join(root, "count"), { maxBlobs: 2, maxBlobBytes: 1, maxTotalBytes: 2 }); await spool.initialize(new Set());
	for (let index = 0; index < 2; index += 1) { const bytes = Buffer.from([index]); const digest = createHash("sha256").update(bytes).digest("hex");
		await spool.commit({ blobId: deriveBlobId(deriveConversationId("host", `count-${index}`), digest), sha256: digest, mimeType: "image/png", byteLength: 1, width: 1, height: 1 }, bytes); }
	const bytes = Buffer.from([3]); const digest = createHash("sha256").update(bytes).digest("hex");
	await assert.rejects(() => spool.commit({ blobId: deriveBlobId(conversationId, digest), sha256: digest, mimeType: "image/png", byteLength: 1, width: 1, height: 1 }, bytes), /quota/);
});

test("media chunk contracts reject changed digests and non-canonical or out-of-order-sized payloads", () => {
	const data = Buffer.from("chunk"); const blobId = `blob_${"a".repeat(32)}`; const deliveryId = deriveDeliveryId(conversationId, "$chunk");
	const frame = { protocolVersion: "1.0.0", messageId: "chunk", conversationId, role: "relay", type: "media.chunk",
		payload: { deliveryId, blobId, index: 0, sha256: createHash("sha256").update(data).digest("hex"), data: data.toString("base64") } };
	assert.equal(parseManagedSessionEnvelope(frame).type, "media.chunk");
	assert.throws(() => parseManagedSessionEnvelope({ ...frame, payload: { ...frame.payload, sha256: "0".repeat(64) } }), /digest/);
	assert.throws(() => parseManagedSessionEnvelope({ ...frame, payload: { ...frame.payload, data: `${frame.payload.data}=`, sha256: "0".repeat(64) } }), /schema|canonical/);
});

test("image transport ignores size declarations and preserves original captioned or neutral bytes", async (t) => {
	const root = await temp(t);
	const matrix = new ManagedMatrixClient(config, async () => new Response(png, { headers: { "content-type": "image/png", "content-length": String(png.length) } }), ["!room:example.com"], { maxAttempts: 1 });
	const transport = new ManagedImageTransport(new BlobSpool(join(root, "spool")), matrix); await transport.initialize(new Set());
	const base = { kind: "image" as const, eventId: "$image", senderUserId: config.operatorUserId, mxcUrl: "mxc://example.com/media", declaredMimeType: "image/png" as const,
		declaredSize: png.length, declaredWidth: 1, declaredHeight: 1 };
	const neutral = await transport.accept(conversationId, base);
	assert.equal(neutral.prompt, CAPTIONLESS_IMAGE_PROMPT); assert.equal(neutral.image.blobId, deriveInboundBlobId(conversationId, neutral.image.sha256));
	const captioned = await transport.accept(conversationId, { ...base, caption: "inspect this" });
	assert.equal(captioned.prompt, "inspect this"); assert.deepEqual(captioned.image, neutral.image);
	for (const declaredSize of [undefined, 0, png.length - 1, png.length + 1, 100_000_000]) {
		const accepted = await transport.accept(conversationId, { ...base, declaredSize });
		assert.deepEqual(await transport.spool.read(accepted.image), png);
	}
});

test("inbound format comes from bytes and unsupported content cannot masquerade as PNG", async (t) => {
	const root = await temp(t); let bytes = png;
	const matrix = new ManagedMatrixClient(config, async () => new Response(bytes, { headers: { "content-type": "application/octet-stream" } }), [], { maxAttempts: 1 });
	const transport = new ManagedImageTransport(new BlobSpool(join(root, "spool")), matrix); await transport.initialize(new Set());
	const event = { kind: "image" as const, eventId: "$format", senderUserId: config.operatorUserId, mxcUrl: "mxc://example.com/format", declaredMimeType: "image/jpeg" as const };
	const accepted = await transport.accept(conversationId, event);
	assert.equal(accepted.image.mimeType, "image/png", "actual supported format wins over stale metadata");
	assert.deepEqual(await transport.spool.read(accepted.image), png);
	for (bytes of [Buffer.from("GIF89a"), Buffer.from("<html>not an image</html>"), Buffer.from("arbitrary")]) {
		await assert.rejects(() => transport.accept(conversationId, { ...event, declaredMimeType: "image/png" }), /not a supported/);
	}
});

test("inbound JPEG, PNG and animated WebP retain original bytes and metadata", async (t) => {
	const magick = process.env.PI_MANAGED_SESSIONS_TEST_IMAGE_NORMALIZER;
	if (!magick) return t.skip("packaged ImageMagick normalizer is unavailable");
	const root = await temp(t); let current = Buffer.alloc(0); let currentMime = "image/png";
	const matrix = new ManagedMatrixClient(config, async () => new Response(current, { headers: { "content-type": currentMime, "content-length": String(current.length) } }), ["!room:example.com"], { maxAttempts: 1 });
	const spool = new BlobSpool(join(root, "spool")); const transport = new ManagedImageTransport(spool, matrix); await transport.initialize(new Set());
	for (const [extension, mime] of [["jpg", "image/jpeg"], ["png", "image/png"], ["webp", "image/webp"]] as const) {
		const source = join(root, `source.${extension}`);
		const generate = extension === "webp" ? ["-size", "2x1", "xc:red", "-size", "2x1", "xc:blue", "-delay", "10", "-loop", "0", "-set", "comment", "private-metadata", source]
			: ["-size", "2x1", "xc:red", "-set", "comment", "private-metadata", source];
		await execFileAsync(magick, generate); current = await readFile(source); currentMime = mime;
		await validateImageDecode(current, mime, magick);
		const accepted = await transport.accept(deriveConversationId("host", extension), { kind: "image", eventId: `$${extension}`, senderUserId: config.operatorUserId, mxcUrl: `mxc://example.com/${extension}`,
			declaredMimeType: mime, declaredSize: current.length, declaredWidth: 2, declaredHeight: 1 });
		const metadata = (await spool.list()).find((blob) => blob.blobId === accepted.image.blobId)!;
		assert.deepEqual(await spool.read(metadata), current, "no harness re-encoding, metadata stripping or animation flattening");
	}
});
