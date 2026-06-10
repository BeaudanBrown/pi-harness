import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { SessionManager, type SessionInfo } from "@earendil-works/pi-coding-agent";

const MESSAGE_DISPLAY_LENGTH = 100;
const PREVIEW_TEXT_LENGTH = 2400;

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

function truncateStart(text: string, maxLength: number): string {
	const cleaned = cleanInline(text);
	if (cleaned.length <= maxLength) return cleaned;
	if (maxLength <= 1) return "…";
	return `…${cleaned.slice(cleaned.length - maxLength + 1)}`;
}

function recentText(session: SessionInfo): string {
	return truncateStart(session.allMessagesText || session.firstMessage || "No messages", PREVIEW_TEXT_LENGTH);
}

function recentSnippet(session: SessionInfo): string {
	return truncateStart(session.allMessagesText || session.firstMessage || "No messages", MESSAGE_DISPLAY_LENGTH);
}

function buildPreview(session: SessionInfo): string {
	return [
		sessionLabel(session),
		`Modified: ${formatTimestamp(session.modified)}`,
		`Messages: ${session.messageCount}`,
		`CWD: ${session.cwd}`,
		"",
		"First message:",
		session.firstMessage.trim() || "No messages",
		"",
		"Recent text:",
		recentText(session),
		"",
		`Session file: ${session.path}`,
	].join("\n");
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
			const firstMessage = truncate(session.firstMessage || "No messages", MESSAGE_DISPLAY_LENGTH);
			const recent = recentSnippet(session);
			rows.push([rowId, label, modified, firstMessage, recent].join("\t"));
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
  --with-nth='2,3,4,5' \\
  --nth='1,3,4' \\
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
