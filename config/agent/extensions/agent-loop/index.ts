import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

interface LoopOptions {
	iterations: number;
	ticketId: string;
	allowDirty: boolean;
	timeoutMs: number;
	model?: string;
	verify?: string;
}

interface ChildResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	finalText: string;
	timedOut: boolean;
}

interface ChildUsage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	totalTokens?: number;
}

interface DiffStat {
	additions: number;
	deletions: number;
	binary: number;
}

export type ChildActivity =
	| { kind: "phase"; text: string }
	| { kind: "model"; model: string; contextWindow?: number }
	| { kind: "usage"; usage: ChildUsage }
	| { kind: "tool"; tool: string; summary: string }
	| { kind: "bash"; command: string }
	| { kind: "file"; action: string; path: string }
	| { kind: "assistant"; text: string; usage?: ChildUsage }
	| { kind: "error"; text: string };

interface RunChildHooks {
	onProgress?: (activity: ChildActivity) => void;
}

interface LoopProgress {
	widgetId: string;
	statusId: string;
	lines: string[];
	maxLines: number;
	startedAt: number;
	iteration?: number;
	totalIterations?: number;
	ticketId?: string;
	summary?: string;
	model?: string;
	contextWindow?: number;
	usage?: ChildUsage;
	diff?: DiffStat;
}

interface ProgressUiContext {
	ui: {
		setWidget: (id: string, lines: string[] | undefined) => void;
		setStatus: (id: string, text: string | undefined) => void;
	};
}

interface IterationSummary {
	iteration: number;
	ticket: string;
	commit: string;
	message: string;
	verify: string;
	result: string;
}

export interface TicketMeta {
	id: string;
	title?: string;
	summary?: string;
	name?: string;
	status?: string;
	type?: string;
	priority?: string | number;
	parent?: string;
	deps?: string[];
	created?: string;
}

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const LOOP_CHILD_ENV = "PI_AGENT_LOOP_CHILD";
const LOOP_WIDGET_ID = "agent-loop-progress";
const LOOP_STATUS_ID = "agent-loop";
const MAX_PROGRESS_LINES = 9;

function splitArgs(input: string): string[] {
	const args: string[] = [];
	let current = "";
	let quote: '"' | "'" | null = null;
	let escaped = false;

	for (const ch of input) {
		if (escaped) {
			current += ch;
			escaped = false;
			continue;
		}
		if (ch === "\\" && quote !== "'") {
			escaped = true;
			continue;
		}
		if ((ch === '"' || ch === "'") && quote === null) {
			quote = ch;
			continue;
		}
		if (ch === quote) {
			quote = null;
			continue;
		}
		if (/\s/.test(ch) && quote === null) {
			if (current) args.push(current);
			current = "";
			continue;
		}
		current += ch;
	}
	if (escaped) current += "\\";
	if (current) args.push(current);
	return args;
}

function parseDuration(value: string): number {
	const match = value.match(/^(\d+)(ms|s|m|h)?$/i);
	if (!match) throw new Error(`Invalid timeout: ${value}`);
	const amount = Number(match[1]);
	const unit = (match[2] ?? "m").toLowerCase();
	if (unit === "ms") return amount;
	if (unit === "s") return amount * 1000;
	if (unit === "m") return amount * 60 * 1000;
	if (unit === "h") return amount * 60 * 60 * 1000;
	throw new Error(`Invalid timeout unit: ${unit}`);
}

function parseLoopArgs(raw: string): LoopOptions {
	const args = splitArgs(raw);
	if (args.length < 2) {
		throw new Error("Usage: /aloop <iterations> <ticket-or-epic-id> [--timeout 45m] [--model provider/model] [--verify command] [--allow-dirty]");
	}

	const iterations = Number(args.shift());
	if (!Number.isInteger(iterations) || iterations < 1) {
		throw new Error("Iterations must be a positive integer.");
	}

	const ticketId = args.shift();
	if (!ticketId) throw new Error("Missing ticket or epic id.");

	const options: LoopOptions = {
		iterations,
		ticketId,
		allowDirty: false,
		timeoutMs: DEFAULT_TIMEOUT_MS,
	};

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--allow-dirty") {
			options.allowDirty = true;
		} else if (arg === "--timeout") {
			const value = args[++i];
			if (!value) throw new Error("--timeout requires a value.");
			options.timeoutMs = parseDuration(value);
		} else if (arg === "--model") {
			const value = args[++i];
			if (!value) throw new Error("--model requires a value.");
			options.model = value;
		} else if (arg === "--verify") {
			const value = args[++i];
			if (!value) throw new Error("--verify requires a command.");
			options.verify = value;
		} else {
			throw new Error(`Unknown option: ${arg}`);
		}
	}

	return options;
}

function runCommand(command: string, args: string[], cwd: string): Promise<{ stdout: string; stderr: string; code: number }> {
	return new Promise((resolve) => {
		const proc = spawn(command, args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		proc.stdout.on("data", (chunk: any) => { stdout += chunk.toString(); });
		proc.stderr.on("data", (chunk: any) => { stderr += chunk.toString(); });
		proc.on("error", (error: Error) => resolve({ stdout, stderr: error.message, code: 1 }));
		proc.on("close", (code: number | null) => resolve({ stdout, stderr, code: code ?? 0 }));
	});
}

async function checked(command: string, args: string[], cwd: string): Promise<string> {
	const result = await runCommand(command, args, cwd);
	if (result.code !== 0) {
		throw new Error((result.stderr || result.stdout || `${command} ${args.join(" ")} failed`).trim());
	}
	return result.stdout.trim();
}

async function git(cwd: string, args: string[]): Promise<string> {
	return checked("git", args, cwd);
}

async function tk(cwd: string, args: string[]): Promise<string> {
	return checked("tk", args, cwd);
}

function porcelainPath(line: string): string {
	const raw = line.slice(3).trim();
	const pathPart = raw.includes(" -> ") ? raw.split(" -> ").pop()! : raw;
	return pathPart.replace(/^"|"$/g, "");
}

async function requireCleanWorktree(cwd: string): Promise<void> {
	const status = await git(cwd, ["status", "--porcelain"]);
	const lines = status.split("\n").filter((line) => line.trim());
	if (lines.length === 0) return;
	const unexpected = lines.map(porcelainPath).join("\n");
	throw new Error(`Working tree is dirty. Commit/stash changes first, or pass --allow-dirty to skip cleanliness checks.\n${unexpected}`);
}

function ticketRoot(cwd: string): string | undefined {
	let current = cwd;
	while (true) {
		const candidate = path.join(current, ".tickets");
		if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) return candidate;
		const parent = path.dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

function ticketsFingerprint(cwd: string): string {
	const dir = ticketRoot(cwd);
	if (!dir) return "missing";
	const hash = createHash("sha256");
	const files = fs.readdirSync(dir).filter((name) => name.endsWith(".md")).sort();
	for (const file of files) {
		const fullPath = path.join(dir, file);
		hash.update(file);
		hash.update("\0");
		hash.update(fs.readFileSync(fullPath));
		hash.update("\0");
	}
	return hash.digest("hex");
}

function parseTickets(raw: string): TicketMeta[] {
	const tickets: TicketMeta[] = [];
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		try {
			const parsed = JSON.parse(line) as TicketMeta;
			if (parsed.id) tickets.push(parsed);
		} catch {
			// Ignore non-JSON incidental output.
		}
	}
	return tickets;
}

async function allTickets(cwd: string): Promise<TicketMeta[]> {
	return parseTickets(await tk(cwd, ["query", "."]));
}

function normalizePriority(ticket: TicketMeta): number {
	const parsed = Number(ticket.priority ?? 2);
	return Number.isFinite(parsed) ? parsed : 2;
}

function depsResolved(ticket: TicketMeta, byId: Map<string, TicketMeta>): boolean {
	for (const dep of ticket.deps ?? []) {
		if (byId.get(dep)?.status !== "closed") return false;
	}
	return true;
}

export function hasChildTickets(root: TicketMeta, tickets: TicketMeta[]): boolean {
	return tickets.some((ticket) => ticket.parent === root.id);
}

export function isLoopContainer(root: TicketMeta, tickets: TicketMeta[]): boolean {
	return root.type === "epic" || hasChildTickets(root, tickets);
}

export function descendantTickets(root: TicketMeta, tickets: TicketMeta[]): TicketMeta[] {
	const childrenByParent = new Map<string, TicketMeta[]>();
	for (const ticket of tickets) {
		if (!ticket.parent) continue;
		const children = childrenByParent.get(ticket.parent) ?? [];
		children.push(ticket);
		childrenByParent.set(ticket.parent, children);
	}

	const descendants: TicketMeta[] = [];
	const queue = [...(childrenByParent.get(root.id) ?? [])];
	const seen = new Set<string>();
	while (queue.length > 0) {
		const ticket = queue.shift()!;
		if (seen.has(ticket.id)) continue;
		seen.add(ticket.id);
		descendants.push(ticket);
		queue.push(...(childrenByParent.get(ticket.id) ?? []));
	}
	return descendants;
}

function sortReadyTickets(tickets: TicketMeta[]): TicketMeta[] {
	return [...tickets].sort((a, b) => normalizePriority(a) - normalizePriority(b) || (a.created ?? "").localeCompare(b.created ?? ""));
}

export function actionableTickets(root: TicketMeta, tickets: TicketMeta[]): TicketMeta[] {
	if (!isLoopContainer(root, tickets)) return root.status === "closed" ? [] : [root];
	return descendantTickets(root, tickets)
		.filter((ticket) => ticket.status !== "closed")
		.filter((ticket) => !isLoopContainer(ticket, tickets));
}

function openDescendantTickets(root: TicketMeta, tickets: TicketMeta[]): TicketMeta[] {
	return descendantTickets(root, tickets).filter((ticket) => ticket.status !== "closed");
}

export function pickReadyTicket(root: TicketMeta, tickets: TicketMeta[]): TicketMeta | undefined {
	const byId = new Map(tickets.map((ticket) => [ticket.id, ticket]));
	return sortReadyTickets(actionableTickets(root, tickets).filter((ticket) => depsResolved(ticket, byId)))[0];
}

function formatTicketRef(ticket: TicketMeta): string {
	const title = ticket.title ?? ticket.summary ?? ticket.name;
	return title ? `${ticket.id} ${title}` : ticket.id;
}

export function formatLoopStatus(root: TicketMeta, tickets: TicketMeta[]): string {
	const byId = new Map(tickets.map((ticket) => [ticket.id, ticket]));
	const container = isLoopContainer(root, tickets);
	const descendants = descendantTickets(root, tickets);
	const actionable = actionableTickets(root, tickets);
	const ready = sortReadyTickets(actionable.filter((ticket) => depsResolved(ticket, byId)));
	const blocked = sortReadyTickets(actionable.filter((ticket) => !depsResolved(ticket, byId)));
	const reason = root.type === "epic"
		? "type: epic"
		: container
			? `${descendants.filter((ticket) => ticket.status !== "closed").length} open descendants`
			: "no children";
	const blockedLines = blocked.map((ticket) => {
		const deps = (ticket.deps ?? []).filter((dep) => byId.get(dep)?.status !== "closed");
		return `- ${formatTicketRef(ticket)}${deps.length > 0 ? ` <- ${deps.join(", ")}` : ""}`;
	});

	return [
		`Root: ${formatTicketRef(root)}`,
		`Mode: ${container ? "container" : "leaf"}, because ${reason}`,
		"Ready next:",
		...(ready.length > 0 ? ready.map((ticket) => `- ${formatTicketRef(ticket)}`) : ["(none)"]),
		"Blocked:",
		...(blockedLines.length > 0 ? blockedLines : ["(none)"]),
	].join("\n");
}

function extractTextContent(message: any): string {
	const content = message?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part) => part?.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
}

function parseFooter(text: string): Record<string, string> {
	const fields: Record<string, string> = {};
	for (const line of text.split("\n")) {
		const match = line.match(/^([A-Z_]+):\s*(.*)$/);
		if (match) fields[match[1]!.toLowerCase()] = match[2]!.trim();
	}
	return fields;
}

function truncate(value: string, max = 4000): string {
	if (value.length <= max) return value;
	return `${value.slice(0, max)}\n...[truncated ${value.length - max} chars]`;
}

function compactOneLine(value: string, max = 110): string {
	const cleaned = value.replace(/\s+/g, " ").trim();
	if (cleaned.length <= max) return cleaned;
	return `${cleaned.slice(0, Math.max(0, max - 3))}...`;
}

function redactProgress(value: string): string {
	return value
		.replace(/(authorization\s*:\s*bearer\s+)[^\s"']+/gi, "$1[redacted]")
		.replace(/\b(api[_-]?key|token|password|secret)\s*=\s*[^\s"']+/gi, "$1=[redacted]")
		.replace(/\b(api[_-]?key|token|password|secret)\s*:\s*[^\s"']+/gi, "$1: [redacted]");
}

function progressLine(value: string): string {
	return compactOneLine(redactProgress(value));
}

export function createLoopProgress(maxLines = MAX_PROGRESS_LINES, contextWindow?: number): LoopProgress {
	return {
		widgetId: LOOP_WIDGET_ID,
		statusId: LOOP_STATUS_ID,
		lines: [],
		maxLines,
		startedAt: Date.now(),
		contextWindow,
	};
}

function formatElapsed(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function usageTotal(usage: ChildUsage | undefined): number | undefined {
	if (!usage) return undefined;
	return usage.totalTokens ?? [usage.input, usage.output, usage.cacheRead, usage.cacheWrite].reduce<number>((sum, value) => sum + (value ?? 0), 0);
}

function formatDiffStat(diff: DiffStat): string {
	const base = `diff +${diff.additions}/-${diff.deletions}`;
	return diff.binary > 0 ? `${base} bin ${diff.binary}` : base;
}

function renderProgressHeader(progress: LoopProgress): string {
	const parts = ["aloop"];
	if (progress.iteration && progress.totalIterations) parts.push(`${progress.iteration}/${progress.totalIterations}`);
	if (progress.ticketId) parts.push(progress.ticketId);
	if (progress.summary) parts.push(progress.summary);
	parts.push(formatElapsed(Date.now() - progress.startedAt));
	const total = usageTotal(progress.usage);
	if (total && progress.contextWindow) parts.push(`ctx ${Math.round((total / progress.contextWindow) * 100)}%`);
	if (progress.diff) parts.push(formatDiffStat(progress.diff));
	return progressLine(parts.join(" "));
}

function renderLoopProgress(ctx: ProgressUiContext, progress: LoopProgress): void {
	const header = renderProgressHeader(progress);
	ctx.ui.setStatus(progress.statusId, header);
	ctx.ui.setWidget(progress.widgetId, [header, ...progress.lines.slice(-progress.maxLines)]);
}

export function pushLoopProgress(ctx: ProgressUiContext, progress: LoopProgress, line: string): void {
	const cleaned = progressLine(line);
	if (!cleaned) return;
	if (progress.lines.slice(-5).includes(cleaned)) return;
	progress.lines = [...progress.lines, cleaned].slice(-progress.maxLines);
	renderLoopProgress(ctx, progress);
}

function setLoopStatus(ctx: ProgressUiContext, progress: LoopProgress, text: string | undefined): void {
	ctx.ui.setStatus(progress.statusId, text);
}

function setProgressTicket(progress: LoopProgress, iteration: number, totalIterations: number, ticket: TicketMeta, summary?: string): void {
	progress.iteration = iteration;
	progress.totalIterations = totalIterations;
	progress.ticketId = ticket.id;
	progress.summary = summary ?? ticketSummary(ticket);
	progress.diff = undefined;
}

function ticketSummary(ticket: TicketMeta): string | undefined {
	return shortTicketSummary(ticket.title ?? ticket.summary ?? ticket.name);
}

export function shortTicketSummary(title: string | undefined): string | undefined {
	const cleaned = title?.replace(/\s+/g, " ").trim();
	if (!cleaned) return undefined;
	return cleaned.split(" ").slice(0, 4).join(" ");
}

export function titleFromTkShow(raw: string): string | undefined {
	let inFrontmatter = false;
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (trimmed === "---") {
			inFrontmatter = !inFrontmatter;
			continue;
		}
		if (inFrontmatter || !trimmed) continue;
		const heading = trimmed.match(/^#\s+(.+)$/);
		if (heading) return heading[1]!.trim();
		const field = trimmed.match(/^title:\s*(.+)$/i);
		if (field) return field[1]!.trim();
		return trimmed;
	}
	return undefined;
}

async function ticketDisplaySummary(cwd: string, ticket: TicketMeta): Promise<string | undefined> {
	const fromQuery = ticketSummary(ticket);
	if (fromQuery) return fromQuery;
	try {
		return shortTicketSummary(titleFromTkShow(await tk(cwd, ["show", ticket.id])));
	} catch {
		return undefined;
	}
}

export function parseDiffNumstat(raw: string): DiffStat | undefined {
	let additions = 0;
	let deletions = 0;
	let binary = 0;
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		const [added, deleted] = line.split("\t");
		if (added === "-" || deleted === "-") {
			binary += 1;
			continue;
		}
		const add = Number(added);
		const del = Number(deleted);
		if (Number.isFinite(add)) additions += add;
		if (Number.isFinite(del)) deletions += del;
	}
	return additions || deletions || binary ? { additions, deletions, binary } : undefined;
}

async function committedDiffStat(cwd: string, before: string, after: string): Promise<DiffStat | undefined> {
	return parseDiffNumstat(await git(cwd, ["diff", "--numstat", before, after]));
}

function clearLoopProgress(ctx: ProgressUiContext, progress: LoopProgress): void {
	ctx.ui.setStatus(progress.statusId, undefined);
	ctx.ui.setWidget(progress.widgetId, undefined);
}

function summarizeValue(value: unknown): string {
	if (typeof value === "string") return value;
	if (value === undefined || value === null) return "";
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function emptyObject(value: unknown): boolean {
	return value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0;
}

function meaningfulSummary(value: string): string {
	const trimmed = value.trim();
	return trimmed === "{}" || trimmed === "[]" ? "" : trimmed;
}

function eventType(event: any): string {
	return String(event?.type ?? event?.event ?? event?.kind ?? "");
}

function eventToolName(event: any): string | undefined {
	const candidate = event?.toolName ?? event?.tool_name ?? event?.tool?.name ?? event?.toolCall?.name ?? event?.call?.name ?? event?.name;
	return typeof candidate === "string" && candidate ? candidate : undefined;
}

function eventInput(event: any): any {
	return event?.input ?? event?.args ?? event?.arguments ?? event?.tool?.input ?? event?.toolCall?.input ?? event?.call?.input ?? {};
}

function inputPath(input: any): string {
	return summarizeValue(input?.path ?? input?.file ?? input?.filePath ?? input?.file_path ?? input?.target ?? input?.targetPath);
}

function isToolEvent(event: any): boolean {
	const type = eventType(event).toLowerCase();
	const status = String(event?.status ?? event?.state ?? "").toLowerCase();
	if (!eventToolName(event)) return false;
	if (["result", "end", "finish", "finished", "complete", "completed", "delta", "update", "output"].some((part) => type.includes(part))) return false;
	if (["result", "end", "finish", "finished", "complete", "completed"].includes(status)) return false;
	return type.includes("tool") || type.includes("call") || type === "";
}

function numberField(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function usageFromMessage(message: any): ChildUsage | undefined {
	const usage = message?.usage;
	if (!usage) return undefined;
	const result: ChildUsage = {
		input: numberField(usage.input),
		output: numberField(usage.output),
		cacheRead: numberField(usage.cacheRead),
		cacheWrite: numberField(usage.cacheWrite),
		totalTokens: numberField(usage.totalTokens),
	};
	return Object.values(result).some((value) => value !== undefined) ? result : undefined;
}

export function childActivityFromJsonEvent(event: any): ChildActivity | undefined {
	const type = eventType(event).toLowerCase();
	if (type === "model_select" && event?.model) {
		return {
			kind: "model",
			model: String(event.model.id ?? event.model.name ?? event.model.model ?? "model"),
			contextWindow: numberField(event.model.contextWindow),
		};
	}
	if (type === "message_end" && event?.message?.role === "assistant") {
		return { kind: "assistant", text: "final response received", usage: usageFromMessage(event.message) };
	}

	if (!isToolEvent(event)) return undefined;
	const tool = eventToolName(event)!;
	const input = eventInput(event);
	const lowerTool = tool.toLowerCase();

	if (lowerTool === "bash" || lowerTool === "shell") {
		if (input?.command === undefined && input?.cmd === undefined && emptyObject(input)) return undefined;
		const command = meaningfulSummary(summarizeValue(input?.command ?? input?.cmd ?? input));
		return command ? { kind: "bash", command } : undefined;
	}

	if (["read", "edit", "write"].includes(lowerTool) || lowerTool.includes("file")) {
		const file = inputPath(input);
		if (file) return { kind: "file", action: lowerTool, path: file };
	}

	const fallbackPath = inputPath(input);
	const summary = meaningfulSummary(summarizeValue(input?.command ?? (fallbackPath || input)));
	return summary ? { kind: "tool", tool, summary } : undefined;
}

export function formatChildActivity(activity: ChildActivity): string {
	if (activity.kind === "phase") return `> ${activity.text}`;
	if (activity.kind === "model") return `> model: ${activity.model}`;
	if (activity.kind === "usage") return `> usage received`;
	if (activity.kind === "bash") return `> bash: ${activity.command}`;
	if (activity.kind === "file") return `> ${activity.action}: ${activity.path}`;
	if (activity.kind === "tool") return activity.summary ? `> ${activity.tool}: ${activity.summary}` : `> ${activity.tool}`;
	if (activity.kind === "assistant") return `> child: ${activity.text}`;
	return `> error: ${activity.text}`;
}

function applyChildProgress(ctx: ProgressUiContext, progress: LoopProgress, activity: ChildActivity): void {
	if (activity.kind === "model") {
		progress.model = activity.model;
		progress.contextWindow = activity.contextWindow ?? progress.contextWindow;
		renderLoopProgress(ctx, progress);
		return;
	}
	if (activity.kind === "usage") {
		progress.usage = activity.usage;
		renderLoopProgress(ctx, progress);
		return;
	}
	if (activity.kind === "assistant") {
		if (activity.usage) progress.usage = activity.usage;
		renderLoopProgress(ctx, progress);
		return;
	}
	pushLoopProgress(ctx, progress, formatChildActivity(activity));
}

export function parseChildProgressLine(line: string): ChildActivity | undefined {
	if (!line.trim()) return undefined;
	try {
		return childActivityFromJsonEvent(JSON.parse(line));
	} catch {
		return undefined;
	}
}

function buildWorkerPrompt(options: LoopOptions, repoRoot: string, rootTicket: TicketMeta, selectedTicket: TicketMeta): string {
	const verifyLine = options.verify
		? `Run this verification command unless a narrower failing-focused check is necessary first: ${options.verify}`
		: "Run the most relevant focused tests or verification for the selected ticket. If repository instructions define a canonical gate, prefer that gate when practical.";

	return `You are an autonomous implementation worker running one iteration of a supervised agent loop.

Repository root: ${repoRoot}
Loop root ticket: ${rootTicket.id} (${rootTicket.type ?? "unknown"})
Selected ticket for this iteration: ${selectedTicket.id}

This project uses tk, a git-backed ticket system. tk tickets are the source of truth for this loop. Run tk help if you need command details.

Your job in this single iteration:
1. Read the loop root ticket with: tk show ${rootTicket.id}
2. Read the selected ticket with: tk show ${selectedTicket.id}
3. Start the selected ticket if it is open: tk start ${selectedTicket.id}
4. Implement only the selected ticket. Do not broaden scope to sibling tickets.
5. If you discover additional work, capture it in tk instead of silently expanding scope:
   - If it is required for this ticket to be correct, create/link a prerequisite ticket or dependency and block if needed.
   - If it is valuable follow-up but not required now, create a small linked ticket under the loop root when appropriate.
   - If it is speculative, add a concise note rather than growing the plan.
6. Add or update tests when appropriate.
7. ${verifyLine}
8. Update tk with concise notes: tk add-note ${selectedTicket.id} "..."
9. Before closing, review whether any discovered follow-up work should be captured as linked tk tickets or notes.
10. Close the selected ticket only if its acceptance criteria are satisfied: tk close ${selectedTicket.id}
11. If the loop root is an epic and this closes the final open descendant under ${rootTicket.id}, verify the epic acceptance criteria and add a concise closeout note. The supervisor may close the root epic after validation.
12. Commit exactly this iteration's completed work, including code changes and .tickets updates. Use git locally only; never push.

Hard requirements:
- You must leave the worktree clean by committing successful changes.
- You must update tk on every successful or blocked iteration.
- New tickets must be small, actionable, linked to the current/root ticket, and clearly marked as prerequisite or follow-up.
- You must not push.
- You must not start a long-running background process that survives your turn.
- If no useful work can proceed, update tk with the blocker and report ALOOP_RESULT: blocked.

Finish your final response with these exact footer lines:
ALOOP_RESULT: continue|stop|blocked
LOOP_ROOT: ${rootTicket.id}
TICKET: ${selectedTicket.id}
COMMIT: <new commit hash, or none>
VERIFY: <commands run and pass/fail result>
TK_UPDATED: yes|no
MESSAGE: <one-line handoff for the supervisor and next agent>`;
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	if (currentScript && fs.existsSync(currentScript) && /\.(mjs|cjs|js)$/i.test(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	return { command: "pi", args };
}

function signalChildGroup(proc: ChildProcess, signal: NodeJS.Signals): void {
	if (!proc.pid) return;
	try {
		process.kill(-proc.pid, signal);
	} catch {
		try { proc.kill(signal); } catch { /* best effort */ }
	}
}

function maybeStopRepoDevEnvironment(repoRoot: string): void {
	const wrapper = path.join(repoRoot, "bin", "in-env");
	if (!fs.existsSync(wrapper)) return;
	try {
		spawn("bash", [wrapper, "dev-stop"], { cwd: repoRoot, shell: false, stdio: "ignore", detached: true }).unref();
	} catch {
		// Timeout cleanup is best effort; the supervisor still reports the failure.
	}
}

async function runChild(options: LoopOptions, repoRoot: string, rootTicket: TicketMeta, selectedTicket: TicketMeta, hooks: RunChildHooks = {}): Promise<ChildResult> {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-loop-"));
	const promptPath = path.join(tmpDir, "system-prompt.md");
	fs.writeFileSync(promptPath, buildWorkerPrompt(options, repoRoot, rootTicket, selectedTicket), { encoding: "utf-8", mode: 0o600 });

	const args = ["--mode", "json", "-p", "--no-session", "--append-system-prompt", promptPath];
	if (options.model) args.push("--model", options.model);
	args.push(`Task: Run one supervised tk loop iteration. Root ticket: ${rootTicket.id}. Selected ticket: ${selectedTicket.id}.`);

	return await new Promise((resolve) => {
		const invocation = getPiInvocation(args);
		hooks.onProgress?.({ kind: "phase", text: `spawning child for ${selectedTicket.id}` });
		const proc = spawn(invocation.command, invocation.args, {
			cwd: repoRoot,
			shell: false,
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, [LOOP_CHILD_ENV]: "1" },
		});
		let stdout = "";
		let stderr = "";
		let buffer = "";
		let finalText = "";
		let settled = false;
		let timedOut = false;

		const timeout = setTimeout(() => {
			timedOut = true;
			signalChildGroup(proc, "SIGTERM");
			maybeStopRepoDevEnvironment(repoRoot);
			const hardKill = setTimeout(() => signalChildGroup(proc, "SIGKILL"), 5000);
			(hardKill as any).unref?.();
		}, options.timeoutMs);
		(timeout as any).unref?.();

		const processLine = (line: string) => {
			if (!line.trim()) return;
			const activity = parseChildProgressLine(line);
			if (activity) hooks.onProgress?.(activity);
			try {
				const event = JSON.parse(line);
				if (event.type === "message_end" && event.message?.role === "assistant") {
					const text = extractTextContent(event.message);
					if (text.trim()) finalText = text.trim();
				}
			} catch {
				// JSON mode can still include incidental non-JSON output from extensions.
			}
		};

		proc.stdout.on("data", (chunk: any) => {
			const text = chunk.toString();
			stdout += text;
			buffer += text;
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) processLine(line);
		});
		proc.stderr.on("data", (chunk: any) => {
			const text = chunk.toString();
			stderr += text;
			const firstLine = text.split("\n").find((line: string) => line.trim());
			if (firstLine) hooks.onProgress?.({ kind: "error", text: firstLine });
		});
		proc.on("error", (error: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			fs.rmSync(tmpDir, { recursive: true, force: true });
			resolve({ exitCode: 1, stdout, stderr: `${stderr}\n${error.message}`, finalText, timedOut });
		});
		proc.on("close", (code: number | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			if (buffer.trim()) processLine(buffer);
			fs.rmSync(tmpDir, { recursive: true, force: true });
			resolve({ exitCode: code ?? 0, stdout, stderr, finalText, timedOut });
		});
	});
}

function formatSummaries(summaries: IterationSummary[]): string {
	if (summaries.length === 0) return "No iterations completed.";
	return summaries
		.map((item) => `${item.iteration}. ${item.ticket} ${item.commit.slice(0, 12)} ${item.result} - ${item.message || item.verify}`)
		.join("\n");
}

async function ticketById(cwd: string, id: string): Promise<TicketMeta> {
	const tickets = await allTickets(cwd);
	const exact = tickets.find((ticket) => ticket.id === id);
	if (exact) return exact;
	const matches = tickets.filter((ticket) => ticket.id.includes(id));
	if (matches.length === 1) return matches[0]!;
	if (matches.length > 1) throw new Error(`Ambiguous ticket id '${id}' matches: ${matches.map((ticket) => ticket.id).join(", ")}`);
	throw new Error(`Ticket not found: ${id}`);
}

async function finalizeRootEpicIfComplete(cwd: string, root: TicketMeta, selected: TicketMeta): Promise<string | undefined> {
	if (root.type !== "epic") return undefined;

	const tickets = await allTickets(cwd);
	const updatedRoot = tickets.find((ticket) => ticket.id === root.id) ?? root;
	if (updatedRoot.status === "closed" || openDescendantTickets(updatedRoot, tickets).length > 0) return undefined;

	await tk(cwd, ["add-note", updatedRoot.id, `All descendant tickets are closed; closing epic after ${selected.id}.`]);
	await tk(cwd, ["close", updatedRoot.id]);
	await git(cwd, ["add", ".tickets"]);
	await git(cwd, ["commit", "-m", `Close completed epic ${updatedRoot.id}`]);
	return await git(cwd, ["rev-parse", "HEAD"]);
}

function buildLoopSummaryPrompt(root: TicketMeta, options: LoopOptions, summaries: IterationSummary[]): string {
	return `The supervised /aloop command has finished for root ticket ${root.id}.

Requested iterations: ${options.iterations}
Completed iterations: ${summaries.length}

Iteration results:
${formatSummaries(summaries)}

Please summarize for the user what the loop accomplished, which tickets changed, verification results, notable blockers or risks, and the recommended next step. Keep it concise and grounded in the iteration results.`;
}

async function runLoop(rawArgs: string, ctx: ExtensionCommandContext, pi?: ExtensionAPI): Promise<void> {
	const options = parseLoopArgs(rawArgs);
	await tk(ctx.cwd, ["help"]);
	const repoRoot = await git(ctx.cwd, ["rev-parse", "--show-toplevel"]);
	if (!options.allowDirty) await requireCleanWorktree(repoRoot);

	let root = await ticketById(repoRoot, options.ticketId);
	const initialTickets = await allTickets(repoRoot);
	const structuralContainer = root.type !== "epic" && hasChildTickets(root, initialTickets);
	const summaries: IterationSummary[] = [];
	const progress = createLoopProgress(MAX_PROGRESS_LINES, ctx.model?.contextWindow);
	setLoopStatus(ctx, progress, `aloop 0/${options.iterations}`);
	pushLoopProgress(ctx, progress, `> starting ${options.iterations} iteration(s) for ${options.ticketId}`);
	if (structuralContainer) {
		const message = `${root.id} is type: ${root.type ?? "unknown"} but has children; treating it as a loop container.`;
		ctx.ui.notify(message, "warning");
		pushLoopProgress(ctx, progress, `> warning: ${message}`);
	}

	try {
		for (let i = 1; i <= options.iterations; i++) {
			const tickets = await allTickets(repoRoot);
			root = await ticketById(repoRoot, options.ticketId);
			const selected = pickReadyTicket(root, tickets);
			if (!selected) {
				ctx.ui.notify(`No ready ticket found for ${root.id}. Use tk blocked or tk dep tree ${root.id} for details.`, "info");
				break;
			}

			const summary = await ticketDisplaySummary(repoRoot, selected);
			setProgressTicket(progress, i, options.iterations, selected, summary);
			setLoopStatus(ctx, progress, `aloop ${i}/${options.iterations} ${selected.id}`);
			pushLoopProgress(ctx, progress, root.id === selected.id ? `> selected: ${selected.id}` : `> selected: ${selected.id} from ${root.id}`);

			const beforeHead = await git(repoRoot, ["rev-parse", "HEAD"]);
			const beforeTickets = ticketsFingerprint(repoRoot);
			const child = await runChild(options, repoRoot, root, selected, {
				onProgress: (activity) => applyChildProgress(ctx, progress, activity),
			});
			pushLoopProgress(ctx, progress, `> validate: checking ${selected.id}`);
			const footer = parseFooter(child.finalText);

			if (child.timedOut) throw new Error(`Iteration ${i} timed out after ${Math.round(options.timeoutMs / 1000)}s.`);
			if (child.exitCode !== 0) {
				throw new Error(`Iteration ${i} child exited ${child.exitCode}.\n${truncate(child.stderr || child.finalText || child.stdout)}`);
			}

			let afterHead = await git(repoRoot, ["rev-parse", "HEAD"]);
			const afterTickets = ticketsFingerprint(repoRoot);
			const result = footer.aloop_result ?? "continue";
			const tkUpdated = footer.tk_updated?.toLowerCase();
			const updatedTicket = await ticketById(repoRoot, selected.id);

			if (result === "blocked") {
				if (!options.allowDirty) await requireCleanWorktree(repoRoot);
				ctx.ui.notify(`Agent loop blocked on ${selected.id}: ${footer.message || "see tk notes"}`, "warning");
				break;
			}

			if (afterHead === beforeHead) {
				throw new Error(`Iteration ${i} did not create a commit. Final response:\n${truncate(child.finalText)}`);
			}
			if (afterTickets === beforeTickets || tkUpdated === "no") {
				throw new Error(`Iteration ${i} did not update tk tickets.`);
			}
			if (updatedTicket.status !== "closed") {
				throw new Error(`Iteration ${i} did not close selected ticket ${selected.id}.`);
			}
			if (!options.allowDirty) await requireCleanWorktree(repoRoot);
			const epicCloseCommit = await finalizeRootEpicIfComplete(repoRoot, root, selected);
			if (epicCloseCommit) {
				afterHead = epicCloseCommit;
				pushLoopProgress(ctx, progress, `> closed epic: ${root.id} ${afterHead.slice(0, 12)}`);
			}
			if (!options.allowDirty) await requireCleanWorktree(repoRoot);
			progress.diff = await committedDiffStat(repoRoot, beforeHead, afterHead);
			renderLoopProgress(ctx, progress);
			pushLoopProgress(ctx, progress, `> done: ${selected.id} ${afterHead.slice(0, 12)}`);

			summaries.push({
				iteration: i,
				ticket: selected.id,
				commit: afterHead,
				message: footer.message ?? "",
				verify: footer.verify ?? "verification not reported",
				result,
			});

			if (result === "stop") break;
		}
	} finally {
		clearLoopProgress(ctx, progress);
	}

	ctx.ui.notify(`Agent loop finished.\n${formatSummaries(summaries)}`, "info");
	pi?.sendUserMessage(buildLoopSummaryPrompt(root, options, summaries));
}

function buildPlanPrompt(rawArgs: string): string {
	const args = splitArgs(rawArgs);
	const mode = args[0] === "create" ? "create" : "clarify";
	const idea = mode === "create" ? args.slice(1).join(" ") : rawArgs.trim();
	const createNow = mode === "create";

	return `You are running /aplan, a tk-backed planning and specification workflow for future /aloop implementation.

Rough user request:
${idea || "(No request text supplied. Ask the user for the goal.)"}

This project uses tk, a git-backed ticket system. Use tk as the durable source of truth for plans and implementation chunks. Run tk help before creating or updating tickets if you are unsure.

Planning workflow:
1. Inspect project guidance and docs first: AGENTS.md, README.md, docs, CONTEXT.md, ADRs, and existing .tickets when present.
2. Cross-reference the code enough to ground terminology and feasibility.
3. Challenge fuzzy language. Prefer concrete scenarios, edge cases, cardinality, state transitions, deletion behavior, migration concerns, and success criteria.
4. Ask high-leverage clarification questions before creating tickets unless the user explicitly provided enough detail or invoked create mode.
5. Capture shared language, decisions, non-goals, risks, verification strategy, and chunk boundaries.
6. Create one tk epic for the whole unit of work and child tk tickets for implementation chunks. Use --parent for children, --design for decisions/approach, --acceptance for done criteria, and tk dep for ordering dependencies.
7. For nested plans, use type: epic for any container users should pass to /aloop; use feature, task, bug, or chore for leaf implementation tickets. If a ticket gains children later, either convert it to epic or expect /aloop to treat it as a structural container.
8. Commit the ticket plan after creating or materially updating tickets: stage only .tickets changes and commit them with a message like "plan <feature> tickets". Do not include unrelated dirty work in that commit.
9. After committing the ticket plan, check git status --short. If there are any remaining dirty changes, stop and ask the user what to do with them before suggesting /aloop, because /aloop expects a clean worktree unless --allow-dirty is explicitly used.
10. Treat the epic as a container: once the final descendant is closed, verify the epic acceptance criteria, add a closeout note, and close the epic.
11. Make chunks large enough for meaningful commits but small enough for one fresh /aloop worker iteration.
12. End by listing the epic id, child ticket ids, dependency notes, the ticket-plan commit hash, whether the worktree is clean, and the exact command the user can run next: /aloop <n> <epic-id>.

${createNow ? "The user requested create mode. If enough information is present, create the tk epic and child tickets now; otherwise ask only the blocking questions." : "Do not create tickets yet if important product/domain decisions are unclear. Ask concise clarification questions first, then create tickets after the user answers."}`;
}

async function startPlanning(rawArgs: string, pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	await tk(ctx.cwd, ["help"]);
	await ctx.waitForIdle();
	pi.sendUserMessage(buildPlanPrompt(rawArgs));
}

async function showStatus(rawArgs: string, ctx: ExtensionCommandContext): Promise<void> {
	const args = splitArgs(rawArgs);
	const id = args[1] ?? args[0];
	if (!id) throw new Error("Usage: /aloop status <ticket-or-epic-id>");
	const repoRoot = await git(ctx.cwd, ["rev-parse", "--show-toplevel"]);
	const root = await ticketById(repoRoot, id);
	const tickets = await allTickets(repoRoot);
	const show = await tk(ctx.cwd, ["show", root.id]);
	ctx.ui.notify(`tk status for ${root.id}\n\n${formatLoopStatus(root, tickets)}\n\n${truncate(show, 2500)}`, "info");
}

export default function registerAgentLoop(pi: ExtensionAPI): void {
	if (process.env[LOOP_CHILD_ENV] === "1") return;

	pi.registerCommand("aloop", {
		description: "Run supervised fresh-agent implementation iterations from tk tickets.",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			try {
				const first = splitArgs(args)[0];
				if (first === "status") return await showStatus(args, ctx);
				return await runLoop(args, ctx, pi);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("aplan", {
		description: "Clarify a larger task and create a tk epic with loop-ready child tickets.",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			try {
				await startPlanning(args, pi, ctx);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}
