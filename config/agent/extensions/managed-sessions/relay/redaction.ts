const SECRET_NAME = /(token|password|secret|authorization|cookie|credential)/i;
const BEARER = /Bearer\s+[A-Za-z0-9._~+\/-]+/gi;

export function redactManagedValue(value: unknown, environment: NodeJS.ProcessEnv = process.env): string {
	let text = value instanceof Error ? value.message : String(value);
	text = text.replace(BEARER, "Bearer [REDACTED]");
	for (const [name, secret] of Object.entries(environment)) {
		if (!SECRET_NAME.test(name) || !secret) continue;
		text = text.replaceAll(secret, "[REDACTED]");
	}
	return text.replace(/[\r\n\0]+/g, " ").slice(0, 500);
}
