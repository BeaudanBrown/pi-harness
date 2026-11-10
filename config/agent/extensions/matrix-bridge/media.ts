import { createHash } from "node:crypto";
import type { ImageInfo } from "./store.js";
import { IMAGE_CHUNK_BYTES, object, string, type Peer } from "./wire.js";

export const CAPTIONLESS_IMAGE_PROMPT = "Please analyze the attached image.";
export function imageInfo(bytes: Buffer): ImageInfo {
  const mimeType = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? "image/png" :
    bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? "image/jpeg" :
    bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP" ? "image/webp" : undefined;
  if (!mimeType) throw Error("Only original JPEG, PNG and WebP images are supported");
  return { mimeType, byteLength: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}
/** Bounded private frames and integrity checks, not a second media spool/protocol. */
export async function readImage(peer: Peer, id: string, value: unknown, valid: () => boolean): Promise<{ data: string; mimeType: string }> {
  const info = object(value), mimeType = string(info.mimeType, 32), digest = string(info.sha256, 64), size = Number(info.byteLength);
  if (!["image/jpeg", "image/png", "image/webp"].includes(mimeType) || !/^[a-f0-9]{64}$/.test(digest) || !Number.isSafeInteger(size) || size < 1) throw Error("Invalid image transfer metadata");
  const parts: Buffer[] = []; let offset = 0;
  while (offset < size) {
    if (!valid()) throw Error("Image transfer was withdrawn or native session changed");
    const chunk = object(await peer.request("image.read", { id, offset }));
    const encoded = string(chunk.data, IMAGE_CHUNK_BYTES * 4 / 3), bytes = Buffer.from(encoded, "base64");
    if (chunk.offset !== offset || !bytes.length || bytes.length > IMAGE_CHUNK_BYTES || bytes.toString("base64") !== encoded || offset + bytes.length > size ||
        chunk.sha256 !== createHash("sha256").update(bytes).digest("hex") || chunk.done !== (offset + bytes.length === size)) throw Error("Image chunk integrity mismatch");
    parts.push(bytes); offset += bytes.length;
  }
  const bytes = Buffer.concat(parts, size), actual = imageInfo(bytes);
  if (!valid() || actual.sha256 !== digest || actual.mimeType !== mimeType) throw Error("Image transfer integrity or native session changed");
  return { data: bytes.toString("base64"), mimeType };
}
