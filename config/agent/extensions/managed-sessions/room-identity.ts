import { isIP } from "node:net";

/** Matrix server-name ABNF plus conventional DNS labels; bracketed IPv6 and optional 1–5 digit port. */
function isServerName(value: string): boolean {
	if (value.startsWith("[")) {
		const match = /^\[([^\]]+)\](?::[0-9]{1,5})?$/.exec(value);
		return !!match && !match[1]!.includes("%") && isIP(match[1]!) === 6;
	}
	const match = /^([A-Za-z0-9.-]{1,255})(?::[0-9]{1,5})?$/.exec(value);
	if (!match) return false;
	const hostname = match[1]!.replace(/\.$/, "");
	return hostname.split(".").every(label => label.length <= 63 && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label));
}

/** Bounded Matrix room IDs; controls/whitespace and unpaired surrogates are never accepted. */
export function isMatrixRoomId(value: unknown): value is string {
	if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 255 || /[\s\p{Cc}\uD800-\uDFFF]/u.test(value)) return false;
	if (isDomainlessRoomId(value)) return true;
	const separator = value.indexOf(":");
	return value.startsWith("!") && separator > 1 && isServerName(value.slice(separator + 1));
}

export function isDomainlessRoomId(value: string): boolean {
	return /^![A-Za-z0-9_-]{43}$/.test(value) && Buffer.from(value.slice(1), "base64url").toString("base64url") === value.slice(1);
}
