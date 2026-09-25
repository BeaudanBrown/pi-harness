export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_REPLY_FILES = 4;
export interface FileRef {
	id: string; filename: string; mimeType: string; mediaType: "file" | "image" | "audio";
	byteLength: number; sha256: string; width?: number; height?: number;
}
export type ChatReply = string | { text: string; files: FileRef[] };
export function fileRefs(value: unknown): FileRef[] {
	if (!Array.isArray(value) || value.length > MAX_REPLY_FILES) throw Error("Invalid files");
	const ids = new Set<string>();
	return value.map(raw => {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw Error("Invalid file");
		const f = raw as FileRef;
		if (Object.keys(f).some(k => !["id", "filename", "mimeType", "mediaType", "byteLength", "sha256", "width", "height"].includes(k)) ||
			typeof f.id !== "string" || !/^[a-f0-9]{32}$/.test(f.id) || ids.has(f.id) ||
			typeof f.filename !== "string" || !f.filename || f.filename.length > 255 || f.filename.startsWith(".") || /[\\/\x00-\x1f\x7f]/.test(f.filename) ||
			typeof f.mimeType !== "string" || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(f.mimeType) || f.mimeType.length > 100 ||
			!["file", "image", "audio"].includes(f.mediaType) || !Number.isSafeInteger(f.byteLength) || f.byteLength < 1 || f.byteLength > MAX_FILE_BYTES ||
			typeof f.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(f.sha256) ||
			[f.width, f.height].some(n => n !== undefined && (!Number.isSafeInteger(n) || n < 1 || n > 16384))) throw Error("Invalid file");
		ids.add(f.id); return f;
	});
}
