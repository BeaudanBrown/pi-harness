import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { SessionManager, type SessionInfo } from "@earendil-works/pi-coding-agent";

const DEFAULT_PREVIEW_MESSAGES = 12;
const FIRST_MESSAGE_DISPLAY_LENGTH = 100;

interface PreviewMessageLike {
	role?: string;
	content?: unknown;
	toolName?: string;
	command?: string;
	output?: string;
	summary?: string;
	isError?: boolean;
}

function notify(ctx: ExtensionCommandContext, message: string, type: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) {
		ctx.ui.notify(message, type);
		return;
	}
	const prefix = type === "error" ? "error" : type === "warning" ? "warning" : "info";
	console.error(`/sesh ${prefix}: ${message}`);
}

function formatTimestamp(date: Date): string {
	const pad = (value: number) => value.toString().padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function sessionLabel(session: SessionInfo): string {
	const name = session.name?.trim();
	if (name) return name;
	return session.id.length > 8 ? session.id.slice(0, 8) : session.id;
}

function cleanInline(text: string): string {
	return text.replace(/[\t\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}

function truncate(text: string, maxLength: number): string {
	const cleaned = cleanInline(text);
	if (cleaned.length <= maxLength) return cleaned;
	if (maxLength <= 1) return "…";
	return `${cleaned.slice(0, maxLength - 1)}…`;
}

function contentToText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	const parts: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const record = part as Record<string, unknown>;
		if (record.type === "text" && typeof record.text === "string") {
			parts.push(record.text);
		} else if (record.type === "image") {
			parts.push(`[image${typeof record.mimeType === "string" ? `: ${record.mimeType}` : ""}]`);
		} else if (record.type === "toolCall") {
			parts.push(`[tool call: ${typeof record.name === "string" ? record.name : "unknown"}]`);
		} else if (record.type === "thinking") {
			parts.push(record.redacted ? "[thinking redacted]" : typeof record.thinking === "string" ? record.thinking : "[thinking]");
		}
	}
	return parts.join("\n");
}

function previewBlock(message: PreviewMessageLike): string | undefined {
	const role = message.role ?? "message";
	if (role === "user") {
		const text = contentToText(message.content).trim();
		return text ? `◆ User\n${text}` : undefined;
	}
	if (role === "assistant") {
		const text = contentToText(message.content).trim();
		return text ? `● Assistant\n${text}` : undefined;
	}
	if (role === "bashExecution") {
		const command = message.command?.trim() ?? "";
		const output = message.output?.trim() ?? "";
		if (!command && !output) return undefined;
		return `$ Bash${message.isError ? " [error]" : ""}\n${command}${output ? `\n\n${output}` : ""}`;
	}
	if (role === "compactionSummary" || role === "branchSummary") {
		const summary = (message.summary ?? contentToText(message.content)).trim();
		return summary ? `# ${role === "branchSummary" ? "Branch summary" : "Summary"}\n${summary}` : undefined;
	}
	if (role === "tool" || role === "toolResult") {
		const text = contentToText(message.content).trim();
		return text ? `↳ Tool result${message.toolName ? `: ${message.toolName}` : ""}${message.isError ? " [error]" : ""}\n${text}` : undefined;
	}
	const text = (message.summary ?? contentToText(message.content)).trim();
	return text ? `${role}\n${text}` : undefined;
}

function buildPreview(session: SessionInfo): string {
	try {
		const manager = SessionManager.open(session.path);
		const context = manager.buildSessionContext();
		const messages = context.messages as PreviewMessageLike[];
		const recent = messages.slice(-DEFAULT_PREVIEW_MESSAGES);
		const blocks = recent.map(previewBlock).filter((block): block is string => Boolean(block));
		return [
			sessionLabel(session),
			`Modified: ${formatTimestamp(session.modified)}`,
			`Messages: ${session.messageCount}`,
			`CWD: ${session.cwd}`,
			"",
			blocks.length > 0 ? blocks.join("\n\n") : "No previewable recent messages.",
			"",
			`Session file: ${session.path}`,
		].join("\n");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return [sessionLabel(session), `Modified: ${formatTimestamp(session.modified)}`, "", `Failed to build preview: ${message}`].join("\n");
	}
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function runProcess(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<number | null> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: options.env,
			stdio: "ignore",
		});
		child.on("error", reject);
		child.on("close", (code) => resolve(code));
	});
}

async function runSesh(_args: string | undefined, ctx: ExtensionCommandContext): Promise<void> {
	if (!process.env.TMUX) {
		notify(ctx, "/sesh requires tmux because it uses tmux display-popup + fzf.", "warning");
		return;
	}

	const fzfPath = process.env.PI_HARNESS_FZF ?? "fzf";
	const tmuxPath = process.env.PI_HARNESS_TMUX ?? "tmux";
	const sessions = (await SessionManager.list(ctx.cwd)).sort((a, b) => b.modified.getTime() - a.modified.getTime());
	if (sessions.length === 0) {
		notify(ctx, "No sessions found for this project.", "info");
		return;
	}

	const tempDir = await mkdtemp(path.join(tmpdir(), "pi-sesh-"));
	try {
		const previewsDir = path.join(tempDir, "previews");
		await mkdir(previewsDir);

		const rowToSession = new Map<string, SessionInfo>();
		const rows: string[] = [];
		for (const [index, session] of sessions.entries()) {
			const rowId = String(index + 1).padStart(4, "0");
			rowToSession.set(rowId, session);
			const label = cleanInline(sessionLabel(session));
			const modified = formatTimestamp(session.modified);
			const firstMessage = truncate(session.firstMessage || "No messages", FIRST_MESSAGE_DISPLAY_LENGTH);
			const hiddenSearchText = cleanInline(`${session.name ?? ""} ${session.id} ${session.firstMessage ?? ""}`);
			rows.push([rowId, label, modified, firstMessage, hiddenSearchText].join("\t"));
			await writeFile(path.join(previewsDir, `${rowId}.txt`), buildPreview(session), "utf8");
		}

		await writeFile(path.join(tempDir, "rows.tsv"), `${rows.join("\n")}\n`, "utf8");
		await writeFile(path.join(tempDir, "selected.tsv"), "", "utf8");

		const scriptPath = path.join(tempDir, "run-fzf.sh");
		const script = `#!/usr/bin/env bash
set -euo pipefail
cd ${shellQuote(tempDir)}

# Keep /sesh deterministic. User defaults such as --height=40% make fzf
# render as a small nested window inside the tmux popup instead of filling it.
unset FZF_DEFAULT_OPTS
unset FZF_DEFAULT_OPTS_FILE

status=0
${shellQuote(fzfPath)} \\
  --ansi \\
  --height='100%' \\
  --border='none' \\
  --delimiter=$'\t' \\
  --with-nth='2,3,4' \\
  --nth='2,4,5' \\
  --preview='cat previews/{1}.txt' \\
  --preview-window='right:60%:wrap' \\
  --prompt='sesh> ' \\
  < rows.tsv > selected.tsv || status=$?
if [ "$status" -eq 1 ] || [ "$status" -eq 130 ]; then
  : > selected.tsv
  exit 0
fi
exit "$status"
`;
		await writeFile(scriptPath, script, { encoding: "utf8", mode: 0o700 });

		const code = await runProcess(tmuxPath, ["display-popup", "-E", "-w", "90%", "-h", "80%", "--", scriptPath], {
			env: process.env,
		});
		if (code !== 0) {
			notify(ctx, `/sesh failed to launch tmux/fzf popup (exit ${code ?? "unknown"}).`, "error");
			return;
		}

		const selected = (await readFile(path.join(tempDir, "selected.tsv"), "utf8")).trim();
		if (!selected) return;
		const selectedRowId = selected.split("\t", 1)[0];
		const session = rowToSession.get(selectedRowId);
		if (!session) {
			notify(ctx, "Selected session was not recognized.", "error");
			return;
		}

		const result = await ctx.switchSession(session.path);
		if (result.cancelled) {
			notify(ctx, "Session switch cancelled.", "info");
		}
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
}

export default function seshExtension(pi: ExtensionAPI): void {
	pi.registerCommand("sesh", {
		description: "Pick a current-project session with tmux popup + fzf",
		handler: runSesh,
	});
}
