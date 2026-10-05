import { parseHostCliArgs } from "./relay/host-cli-args.js";
import type { HostAction } from "./live-workspace-contracts.js";

/** Arguments, not a shell: quotes/escapes only; no expansion, pipes or execution. */
export function hostCommandArgs(text: string): string[] {
	if (Buffer.byteLength(text) > 8192 || /[\u0000-\u001f\u007f]/.test(text)) throw Error("Host command exceeds bounds");
	const args: string[] = []; let word = "", quote = "", escaped = false, started = false;
	for (const c of text) {
		if (escaped) { word += c; escaped = false; started = true; }
		else if (c === "\\" && quote !== "'") { escaped = true; started = true; }
		else if (quote) { if (c === quote) quote = ""; else word += c; }
		else if (c === '"' || c === "'") { quote = c; started = true; }
		else if (c === " ") { if (started) { args.push(word); word = ""; started = false; } }
		else { word += c; started = true; }
	}
	if (escaped || quote) throw Error("Unclosed host command quoting");
	if (started) args.push(word);
	return args;
}
export function hostCommandAction(text: string): HostAction | "help" {
	const args = hostCommandArgs(text);
	if (!args.length || args[0] === "help") { if (args.length > 1) throw Error("Help takes no arguments"); return "help"; }
	// Frontend correlation/format are not command-controlled authority.
	if (args.some(a => a === "--request-id" || a.startsWith("--request-id=") || a === "--json")) throw Error("Host command cannot set transport options");
	const parsed = parseHostCliArgs(args);
	return "help" in parsed ? "help" : parsed.request.action;
}
export function roomHostCommand(body: string, conversationId: string): HostAction | "help" | undefined {
	const text = body.trim();
	if (/^!host(?:\s|$)/.test(text)) return hostCommandAction(text.slice(5).trim());
	if (/^!(?:start|stop|close)(?:\s|$)/.test(text)) {
		if (text === "!start") return { operation: "conversation.resume", conversationId };
		if (text === "!stop") return { operation: "conversation.stop", conversationId };
		if (text === "!close --confirm") return { operation: "conversation.delete", conversationId, confirmed: true };
		throw Error("Use !start, !stop or !close --confirm");
	}
	return undefined;
}
