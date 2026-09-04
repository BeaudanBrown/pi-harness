import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { deriveConversationId, deriveDeliveryId, parseManagedSessionEnvelope } from "../config/agent/extensions/managed-sessions/contracts.js";
import { deriveBlobId } from "../config/agent/extensions/managed-sessions/v2-contracts.js";
import { BlobSpool } from "../config/agent/extensions/managed-sessions/relay/blob-spool.js";
import { authorizedRoomEvents } from "../config/agent/extensions/managed-sessions/relay/coordinator-router.js";
import { CAPTIONLESS_IMAGE_PROMPT, ManagedImageTransport } from "../config/agent/extensions/managed-sessions/relay/image-media.js";
import { ManagedMatrixClient, ManagedMatrixError } from "../config/agent/extensions/managed-sessions/relay/matrix-client.js";

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
		{ ...imageEvent("$foreign"), sender: "@other:example.com" }, imageEvent("$encrypted", { url: undefined, file: { url: "mxc://example.com/encrypted" } }),
		imageEvent("$gif", { info: { mimetype: "image/gif", size: 20, w: 1, h: 1 } }), imageEvent("$relation", { "m.relates_to": { rel_type: "m.thread", event_id: "$x" } })];
	assert.deepEqual(authorizedRoomEvents(sync(events), "!room:example.com", new Set([config.operatorUserId]), true).map((event) => event.kind === "image" ? [event.eventId, event.caption] : event.kind), [
		["$caption", "inspect this"], ["$plain", undefined],
	]);
});

test("authenticated media download validates declared and streamed bounds without leaking credentials", async () => {
	const requests: Array<{ path: string; authorization: string | null }> = [];
	const client = new ManagedMatrixClient(config, async (input, init) => {
		requests.push({ path: new URL(String(input)).pathname, authorization: new Headers(init?.headers).get("authorization") });
		return new Response(png, { headers: { "content-type": "image/png", "content-length": String(png.length) } });
	}, ["!room:example.com"], { maxAttempts: 1 });
	assert.deepEqual((await client.downloadMedia("mxc://example.com/media", png.length)).bytes, png);
	assert.deepEqual(requests, [{ path: "/_matrix/client/v1/media/download/example.com/media", authorization: "Bearer secret" }]);
	await assert.rejects(() => client.downloadMedia("https://example.com/media", png.length), (error: unknown) => error instanceof ManagedMatrixError && error.code === "invalid_response");
	await assert.rejects(() => client.downloadMedia("mxc://example.com/media", png.length - 1), /length|stream/);
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

test("image transport validates, normalizes, and creates a stable captioned or neutral delivery", async (t) => {
	const root = await temp(t);
	const matrix = new ManagedMatrixClient(config, async () => new Response(png, { headers: { "content-type": "image/png", "content-length": String(png.length) } }), ["!room:example.com"], { maxAttempts: 1 });
	const transport = new ManagedImageTransport(new BlobSpool(join(root, "spool")), matrix, async (bytes) => Buffer.from(bytes)); await transport.initialize(new Set());
	const base = { kind: "image" as const, eventId: "$image", senderUserId: config.operatorUserId, mxcUrl: "mxc://example.com/media", declaredMimeType: "image/png" as const,
		declaredSize: png.length, declaredWidth: 1, declaredHeight: 1 };
	const neutral = await transport.accept(conversationId, base);
	assert.equal(neutral.prompt, CAPTIONLESS_IMAGE_PROMPT); assert.equal(neutral.image.blobId, deriveBlobId(conversationId, neutral.image.sha256));
	const captioned = await transport.accept(conversationId, { ...base, caption: "inspect this" });
	assert.equal(captioned.prompt, "inspect this"); assert.deepEqual(captioned.image, neutral.image);
	await assert.rejects(() => transport.accept(conversationId, { ...base, declaredWidth: 2 }), /dimensions/);
});

test("production ImageMagick normalization supports JPEG, PNG, and WebP while stripping metadata and flattening animation", async (t) => {
	const magick = process.env.PI_MANAGED_SESSIONS_TEST_IMAGE_NORMALIZER;
	if (!magick) return t.skip("packaged ImageMagick normalizer is unavailable");
	const root = await temp(t); let current = Buffer.alloc(0); let currentMime = "image/png";
	const matrix = new ManagedMatrixClient(config, async () => new Response(current, { headers: { "content-type": currentMime, "content-length": String(current.length) } }), ["!room:example.com"], { maxAttempts: 1 });
	const spool = new BlobSpool(join(root, "spool")); const transport = new ManagedImageTransport(spool, matrix, magick); await transport.initialize(new Set());
	for (const [extension, mime] of [["jpg", "image/jpeg"], ["png", "image/png"], ["webp", "image/webp"]] as const) {
		const source = join(root, `source.${extension}`);
		const generate = extension === "webp" ? ["-size", "2x1", "xc:red", "-size", "2x1", "xc:blue", "-delay", "10", "-loop", "0", "-set", "comment", "private-metadata", source]
			: ["-size", "2x1", "xc:red", "-set", "comment", "private-metadata", source];
		await execFileAsync(magick, generate); current = await readFile(source); currentMime = mime;
		const accepted = await transport.accept(deriveConversationId("host", extension), { kind: "image", eventId: `$${extension}`, senderUserId: config.operatorUserId, mxcUrl: `mxc://example.com/${extension}`,
			declaredMimeType: mime, declaredSize: current.length, declaredWidth: 2, declaredHeight: 1 });
		const metadata = (await spool.list()).find((blob) => blob.blobId === accepted.image.blobId)!;
		const output = join(root, `output.${extension}`); await writeFile(output, await spool.read(metadata));
		const identifyResult: { stdout: string | Buffer } = await execFileAsync(magick, ["identify", "-format", "%n", output]);
		assert.equal(identifyResult.stdout.toString().trim(), "1", `${extension} output has exactly one frame`);
		const verbose = await execFileAsync(magick, ["identify", "-verbose", output]);
		assert.doesNotMatch(verbose.stdout, /private-metadata/);
	}
});
