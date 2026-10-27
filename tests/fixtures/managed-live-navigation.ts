import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Test-only project extension: native public APIs, never edits session/relay stores. */
export default function (pi: ExtensionAPI) {
	pi.on("tool_call", (event, ctx) => {
		if (event.toolName === "read" && typeof event.input.path === "string" &&
			resolve(ctx.cwd, event.input.path) === join(ctx.cwd, "README.md")) return;
		if (event.toolName === "managed_host" &&
			["help", "conversation.list", "conversation.status", "conversation.create", "worktree.conversation.fork"].includes(String(event.input.operation))) return;
		return { block: true, reason: "Isolated acceptance allows only README reading and the selected host-tool scenarios. Do not use other tools." };
	});
	pi.registerCommand("acceptance-nav", {
		description: "Isolated test driver for native guards and tree navigation",
		handler: async (args, ctx) => {
			if (!/^(guards|tree:[a-zA-Z0-9_-]+)$/.test(args)) throw new Error("Invalid acceptance command");
			await ctx.waitForIdle();
			const before = ctx.sessionManager.getSessionId();
			const entries = ctx.sessionManager.getEntries();
			const results: unknown[] = [];
			if (args === "guards") {
				const user = entries.find(entry => entry.type === "message" && entry.message.role === "user");
				if (!user) throw new Error("No test user entry");
				results.push(await ctx.newSession());
				results.push(await ctx.fork(user.id));
				results.push(await ctx.switchSession(join(ctx.cwd, "nonexistent-acceptance-session.jsonl")));
			} else {
				const target = args.slice(5);
				if (!entries.some(entry => entry.id === target && entry.type === "message" && entry.message.role === "assistant")) throw new Error("Unknown assistant target");
				results.push(await ctx.navigateTree(target, { summarize: false }));
			}
			writeFileSync(join(process.env.PI_CODING_AGENT_DIR!, `acceptance-${args.replace(":", "-")}.json`),
				JSON.stringify({ before, after: ctx.sessionManager.getSessionId(), results }), { mode: 0o600 });
		},
	});
}
