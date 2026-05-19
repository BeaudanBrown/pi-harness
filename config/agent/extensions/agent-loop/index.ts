import { spawn } from "node:child_process";
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

interface IterationSummary {
	iteration: number;
	ticket: string;
	commit: string;
	message: string;
	verify: string;
	result: string;
}

interface TicketMeta {
	id: string;
	status?: string;
	type?: string;
	priority?: string | number;
	parent?: string;
	deps?: string[];
	created?: string;
}

const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;
const LOOP_CHILD_ENV = "PI_AGENT_LOOP_CHILD";

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

function pickReadyTicket(root: TicketMeta, tickets: TicketMeta[]): TicketMeta | undefined {
	const byId = new Map(tickets.map((ticket) => [ticket.id, ticket]));
	if (root.type !== "epic") {
		return root.status === "closed" || !depsResolved(root, byId) ? undefined : root;
	}

	return tickets
		.filter((ticket) => ticket.parent === root.id)
		.filter((ticket) => ticket.status !== "closed")
		.filter((ticket) => ticket.type !== "epic")
		.filter((ticket) => depsResolved(ticket, byId))
		.sort((a, b) => normalizePriority(a) - normalizePriority(b) || (a.created ?? "").localeCompare(b.created ?? ""))[0];
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
5. If you discover prerequisite work, create/link a tk ticket or dependency instead of silently expanding scope.
6. Add or update tests when appropriate.
7. ${verifyLine}
8. Update tk with concise notes: tk add-note ${selectedTicket.id} "..."
9. Close the selected ticket only if its acceptance criteria are satisfied: tk close ${selectedTicket.id}
10. Commit exactly this iteration's completed work, including code changes and .tickets updates. Use git locally only; never push.

Hard requirements:
- You must leave the worktree clean by committing successful changes.
- You must update tk on every successful or blocked iteration.
- You must not push.
- You must not start a long-running background process that survives your turn.
- If no useful work can proceed, update tk with the blocker and report ALOOP_RESULT: blocked.

Finish your final response with these exact footer lines:
ALOOP_RESULT: continue|stop|blocked
EPIC: ${rootTicket.id}
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

async function runChild(options: LoopOptions, repoRoot: string, rootTicket: TicketMeta, selectedTicket: TicketMeta): Promise<ChildResult> {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-loop-"));
	const promptPath = path.join(tmpDir, "system-prompt.md");
	fs.writeFileSync(promptPath, buildWorkerPrompt(options, repoRoot, rootTicket, selectedTicket), { encoding: "utf-8", mode: 0o600 });

	const args = ["--mode", "json", "-p", "--no-session", "--append-system-prompt", promptPath];
	if (options.model) args.push("--model", options.model);
	args.push(`Task: Run one supervised tk loop iteration. Root ticket: ${rootTicket.id}. Selected ticket: ${selectedTicket.id}.`);

	return await new Promise((resolve) => {
		const invocation = getPiInvocation(args);
		const proc = spawn(invocation.command, invocation.args, {
			cwd: repoRoot,
			shell: false,
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
			proc.kill("SIGTERM");
			const hardKill = setTimeout(() => proc.kill("SIGKILL"), 5000);
			(hardKill as any).unref?.();
		}, options.timeoutMs);
		(timeout as any).unref?.();

		const processLine = (line: string) => {
			if (!line.trim()) return;
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
		proc.stderr.on("data", (chunk: any) => { stderr += chunk.toString(); });
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

async function runLoop(rawArgs: string, ctx: ExtensionCommandContext): Promise<void> {
	const options = parseLoopArgs(rawArgs);
	await tk(ctx.cwd, ["help"]);
	const repoRoot = await git(ctx.cwd, ["rev-parse", "--show-toplevel"]);
	if (!options.allowDirty) await requireCleanWorktree(repoRoot);

	const summaries: IterationSummary[] = [];
	ctx.ui.setStatus("agent-loop", `aloop 0/${options.iterations}`);

	try {
		for (let i = 1; i <= options.iterations; i++) {
			const tickets = await allTickets(repoRoot);
			const root = await ticketById(repoRoot, options.ticketId);
			const selected = pickReadyTicket(root, tickets);
			if (!selected) {
				ctx.ui.notify(`No ready ticket found for ${root.id}. Use tk blocked or tk dep tree ${root.id} for details.`, "info");
				break;
			}

			ctx.ui.setStatus("agent-loop", `aloop ${i}/${options.iterations} ${selected.id}`);
			ctx.ui.setWidget("agent-loop", [`Agent loop iteration ${i}/${options.iterations}`, `Root: ${root.id}`, `Ticket: ${selected.id}`]);

			const beforeHead = await git(repoRoot, ["rev-parse", "HEAD"]);
			const beforeTickets = ticketsFingerprint(repoRoot);
			const child = await runChild(options, repoRoot, root, selected);
			const footer = parseFooter(child.finalText);

			if (child.timedOut) throw new Error(`Iteration ${i} timed out after ${Math.round(options.timeoutMs / 1000)}s.`);
			if (child.exitCode !== 0) {
				throw new Error(`Iteration ${i} child exited ${child.exitCode}.\n${truncate(child.stderr || child.finalText || child.stdout)}`);
			}

			const afterHead = await git(repoRoot, ["rev-parse", "HEAD"]);
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
		ctx.ui.setStatus("agent-loop", undefined);
		ctx.ui.setWidget("agent-loop", undefined);
	}

	ctx.ui.notify(`Agent loop finished.\n${formatSummaries(summaries)}`, "info");
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
7. Make chunks large enough for meaningful commits but small enough for one fresh /aloop worker iteration.
8. End by listing the epic id, child ticket ids, dependency notes, and the exact command the user can run next: /aloop <n> <epic-id>.

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
	const show = await tk(ctx.cwd, ["show", id]);
	let ready = "";
	let blocked = "";
	try { ready = await tk(ctx.cwd, ["ready"]); } catch {}
	try { blocked = await tk(ctx.cwd, ["blocked"]); } catch {}
	ctx.ui.notify(`tk status for ${id}\n\n${truncate(show, 2500)}\n\nReady:\n${ready || "(none)"}\n\nBlocked:\n${blocked || "(none)"}`, "info");
}

export default function registerAgentLoop(pi: ExtensionAPI): void {
	if (process.env[LOOP_CHILD_ENV] === "1") return;

	pi.registerCommand("aloop", {
		description: "Run supervised fresh-agent implementation iterations from tk tickets.",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			try {
				const first = splitArgs(args)[0];
				if (first === "status") return await showStatus(args, ctx);
				return await runLoop(args, ctx);
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
