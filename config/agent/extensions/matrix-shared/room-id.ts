import { Type } from "typebox";

// Legacy opaque localpart:server IDs and v12 SHA-256 reference hashes. Neither
// syntax nor a server suffix proves ownership; callers must still verify state.
// The final lookahead requires the absolute end (JS `$` also matches before LF).
const pattern = "^!(?:[^\\s:\\u0000-\\u001f\\u007f-\\u009f]{1,200}:[^\\s\\u0000-\\u001f\\u007f-\\u009f]{1,200}|[A-Za-z0-9_-]{43})(?![\\s\\S])";
const roomId = new RegExp(pattern);
export const MatrixRoomIdSchema = Type.String({ maxLength: 255, pattern });
export function isMatrixRoomId(value: unknown): value is string {
	return typeof value === "string" && value.length <= 255 && roomId.test(value);
}
