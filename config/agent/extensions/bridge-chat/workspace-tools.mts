import net from "node:net";
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";

export interface WorkspacePolicy { socket: string; commands: Record<string, string>; }
const path = Type.String({ minLength: 1, maxLength: 4096, description: "Path relative to the approved project. No absolute paths or parent traversal." });
const text = Type.String({ maxLength: 1024 * 1024 });
const params = Type.Union([
	Type.Object({ action: Type.Literal("read"), path }),
	Type.Object({ action: Type.Literal("list"), path }),
	Type.Object({ action: Type.Literal("search"), path, text }),
	Type.Object({ action: Type.Literal("write"), path, text }),
	Type.Object({ action: Type.Literal("edit"), path, old: text, new: text }),
	Type.Object({ action: Type.Literal("mkdir"), path }),
	Type.Object({ action: Type.Literal("rename"), path, destination: path }),
	Type.Object({ action: Type.Literal("delete"), path }),
]);

export function workspaceRequest(socket: string, request: unknown, signal?: AbortSignal): Promise<unknown> {
	const data = JSON.stringify(request) + "\n", limit = 36 * 1024 * 1024;
	if (Buffer.byteLength(data) > limit) return Promise.reject(Error("Workspace request too large"));
	return new Promise((resolve, reject) => {
		const connection = net.createConnection(socket);
		let size = 0, settled = false;
		const chunks: Buffer[] = [];
		const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); connection.destroy(); };
		const fail = () => { if (settled) return; settled = true; cleanup(); reject(Error("Workspace operation interrupted; inspect files or publication status before retrying.")); };
		const abort = () => fail();
		const timer = setTimeout(fail, 370_000);
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) { fail(); return; }
		connection.on("connect", () => connection.write(data));
		connection.on("error", fail);
		connection.on("end", () => { if (!settled) fail(); });
		connection.on("data", chunk => {
			size += chunk.length;
			if (size > limit) { fail(); return; }
			chunks.push(chunk);
			if (chunk[chunk.length - 1] !== 10) return;
			try { const result = JSON.parse(Buffer.concat(chunks).toString("utf8")); settled = true; cleanup(); resolve(result); }
			catch { fail(); }
		});
	});
}

export function workspaceTools(policy: WorkspacePolicy) {
	const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: {} });
	return [defineTool({
		name: "workspace", label: "Project files", description: "Read, list, search, write, edit, create directories, rename or delete files in your approved project. Edit replaces one unique occurrence. Write creates or replaces a text file. Read project instructions first. No host files, shell or hidden control directories are accessible. Use one editor at a time; ordinary host editing is not locked out.",
		parameters: params,
		execute: async (_id, input, signal) => result(await workspaceRequest(policy.socket, input, signal)),
	}), defineTool({
		name: "project_command", label: "Project command",
		description: "Run a host-approved project command (no shell/extra arguments). Available commands: " + JSON.stringify(policy.commands) + ". Follow the project's instructions, but choose the sequence appropriate to the request. Publication needs no second approval when requested. Never blindly retry interrupted publication; inspect status first.",
		parameters: Type.Object({ name: Type.String({ enum: Object.keys(policy.commands) }) }),
		execute: async (_id, input, signal) => {
			if (!Object.hasOwn(policy.commands, input.name)) throw Error("Command not allowed");
			return result(await workspaceRequest(policy.socket, { action: "command", name: input.name }, signal));
		},
	})];
}
