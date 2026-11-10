import { createHash } from "node:crypto";
import { extname } from "node:path";
import { MAX_FILE_BYTES } from "./file-types.js";
import { validateImageDecode } from "./image-validation.js";

type MediaType = "image" | "audio" | "file";
const MIME_BY_EXTENSION: Record<string, string> = {
	".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp",
	".wav": "audio/wav",
	".txt": "text/plain", ".md": "text/markdown", ".csv": "text/csv", ".json": "application/json", ".pdf": "application/pdf", ".zip": "application/zip",
};
const SENSITIVE_FILENAMES = /^(?:id_rsa|id_ed25519|credentials|credentials\.json|secrets?|secrets?\.json|auth\.json)$/i;
const SENSITIVE_EXTENSIONS = new Set([".key", ".pem", ".p12", ".pfx", ".kdbx", ".age", ".gpg"]);
const ALLOWED_EXTENSIONS = new Set(Object.keys(MIME_BY_EXTENSION));

function imageDimensions(data: Buffer, mimeType: string): { width: number; height: number } {
	let width = 0; let height = 0;
	if (mimeType === "image/png" && data.length >= 24 && data.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
		width = data.readUInt32BE(16); height = data.readUInt32BE(20);
	} else if (mimeType === "image/jpeg" && data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) {
		let offset = 2;
		while (offset + 9 < data.length) {
			if (data[offset] !== 0xff) { offset += 1; continue; }
			const marker = data[offset + 1]!; offset += 2;
			if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
			if (offset + 2 > data.length) break;
			const length = data.readUInt16BE(offset);
			if (length < 2 || offset + length > data.length) break;
			if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 7) {
				height = data.readUInt16BE(offset + 3); width = data.readUInt16BE(offset + 5); break;
			}
			offset += length;
		}
	} else if (mimeType === "image/webp" && data.length >= 30 && data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP") {
		const kind = data.subarray(12, 16).toString("ascii");
		if (kind === "VP8X") { width = 1 + data.readUIntLE(24, 3); height = 1 + data.readUIntLE(27, 3); }
		else if (kind === "VP8 " && data.length >= 30 && data[23] === 0x9d && data[24] === 0x01 && data[25] === 0x2a) { width = data.readUInt16LE(26) & 0x3fff; height = data.readUInt16LE(28) & 0x3fff; }
		else if (kind === "VP8L" && data.length >= 25 && data[20] === 0x2f) { const bits = data.readUInt32LE(21); width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1; }
	}
	if (width < 1 || height < 1 || width > 16_384 || height > 16_384 || width * height > 40_000_000) throw new Error("Artifact image is malformed or exceeds dimension limits");
	return { width, height };
}

function assertCompleteContainer(data: Buffer, mimeType: string): void {
	if (mimeType === "image/png") {
		let offset = 8; let idat = false; let ended = false;
		while (offset + 12 <= data.length) { const length = data.readUInt32BE(offset); const end = offset + 12 + length; if (end > data.length) break;
			const kind = data.subarray(offset + 4, offset + 8).toString("ascii"); if (kind === "IDAT") idat = true; if (kind === "IEND" && length === 0) { ended = end === data.length; break; } offset = end; }
		if (!idat || !ended) throw new Error("Artifact image failed bounded decode validation");
	}
	if (mimeType === "image/jpeg" && !(data.length >= 4 && data[0] === 0xff && data[1] === 0xd8 && data.at(-2) === 0xff && data.at(-1) === 0xd9)) throw new Error("Artifact image failed bounded decode validation");
	if (mimeType === "image/webp") { let offset = 12; while (offset + 8 <= data.length) { const length = data.readUInt32LE(offset + 4); offset += 8 + length + (length & 1); }
		if (data.length < 20 || data.readUInt32LE(4) + 8 !== data.length || offset !== data.length) throw new Error("Artifact image failed bounded decode validation"); }
	if (mimeType === "audio/wav") { let offset = 12; let format = false; let samples = false; while (offset + 8 <= data.length) { const kind = data.subarray(offset, offset + 4).toString("ascii"); const length = data.readUInt32LE(offset + 4); offset += 8 + length + (length & 1); if (kind === "fmt ") format = true; if (kind === "data" && length > 0) samples = true; }
		if (data.length < 44 || data.readUInt32LE(4) + 8 !== data.length || offset !== data.length || !format || !samples) throw new Error("Artifact audio failed bounded decode validation"); }
}

async function validateContent(data: Buffer, extension: string, mimeType: string): Promise<{ mediaType: MediaType; width?: number; height?: number }> {
	const starts = (value: string, encoding: BufferEncoding = "ascii") => data.subarray(0, Buffer.byteLength(value, encoding)).equals(Buffer.from(value, encoding));
	if (data.length >= 4 && (starts("\x7fELF", "latin1") || starts("MZ") || ["feedface", "feedfacf", "cefaedfe", "cffaedfe"].includes(data.subarray(0, 4).toString("hex"))) || starts("#!")) {
		throw new Error("Executable artifacts are not exportable");
	}
	if (mimeType.startsWith("image/")) { const result = imageDimensions(data, mimeType); assertCompleteContainer(data, mimeType); await validateImageDecode(data, mimeType); return { mediaType: "image", ...result }; }
	if (mimeType === "audio/wav") {
		if (!(starts("RIFF") && data.subarray(8, 12).toString("ascii") === "WAVE")) throw new Error("Artifact audio content does not match its filename");
		assertCompleteContainer(data, mimeType); return { mediaType: "audio" };
	}
	if (mimeType === "application/pdf" && !starts("%PDF-") || mimeType === "application/zip" && !starts("PK\x03\x04", "latin1")) throw new Error("Artifact content does not match its filename");
	if (mimeType.startsWith("text/") || mimeType === "application/json") {
		let text: string; try { text = new TextDecoder("utf-8", { fatal: true }).decode(data); } catch { throw new Error("Text artifact is not valid UTF-8"); }
		if (/\0|[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) throw new Error("Text artifact contains unsafe control bytes");
		if (mimeType === "application/json") try { JSON.parse(text); } catch { throw new Error("JSON artifact is malformed"); }
	}
	if (!ALLOWED_EXTENSIONS.has(extension)) throw new Error("Artifact type is not in the conservative export allowlist");
	return { mediaType: "file" };
}

/** Stateless chat attachment policy only; not native bridge inbound image policy. */
export async function inspectFileBytes(filename: string, data: Buffer) {
	const extension = extname(filename).toLowerCase();
	if (!filename || filename.length > 255 || filename.startsWith(".") || /[\\/\u0000-\u001f\u007f]/.test(filename) || SENSITIVE_FILENAMES.test(filename) || SENSITIVE_EXTENSIONS.has(extension)) throw new Error("Artifact filename is unsafe or sensitive");
	if (!data.length || data.length > MAX_FILE_BYTES) throw new Error("Artifact must be between 1 byte and 25 MiB");
	if (!ALLOWED_EXTENSIONS.has(extension)) throw new Error("Artifact type is not in the conservative export allowlist");
	const mimeType = MIME_BY_EXTENSION[extension]!;
	const classified = await validateContent(data, extension, mimeType);
	return { filename, mimeType, ...classified, byteLength: data.length, sha256: createHash("sha256").update(data).digest("hex") };
}
