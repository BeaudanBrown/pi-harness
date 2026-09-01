import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	retrieveGitHubEpicContext,
	type GitHubEpicContext,
	type GitHubEpicContextOptions,
} from "./github-context.js";

const MARKER_PREFIX = "pi-harness-plan";

export type GitHubIssuePlanItem = {
	key: string;
	title: string;
	body: string;
	labels?: string[];
	blockedBy?: string[];
	parent?: string;
	state?: "open" | "closed";
};

export type GitHubIssuePlan = {
	key: string;
	issues: GitHubIssuePlanItem[];
};

export type MigrationRecord = {
	sourceId: string;
	disposition: "migrate-open" | "migrate-closed" | "omit";
	title: string;
	body: string;
	labels?: string[];
	blockedBy?: string[];
	parent?: string;
	links?: string[];
	proposedDisposition?: string;
	classificationEvidence?: string[];
	omissionApproved?: boolean;
};

export type ReconciliationMismatch = {
	key?: string;
	kind: "marker" | "state" | "title" | "body" | "labels" | "relationship" | "omission";
	expected: unknown;
	actual: unknown;
};

export type MigrationReconciliation = {
	phase: "reconcile";
	passed: boolean;
	mismatches: ReconciliationMismatch[];
};

type GitHubIssueMutation =
	| { op: "ensure_label"; name: string; color?: string; description?: string }
	| { op: "create_issue"; title: string; body: string; labels?: string[] }
	| { op: "update_issue"; number: number; title?: string; body?: string; state?: "open" | "closed" }
	| { op: "comment"; number: number; body: string }
	| { op: "claim_issue"; number: number }
	| { op: "close_issue"; number: number; comment?: string };

const PlanItemSchema = Type.Object({
	key: Type.String({ minLength: 1, description: "Stable plan-local key, used in idempotency markers and dependency edges." }),
	title: Type.String({ minLength: 1, description: "GitHub issue title." }),
	body: Type.String({ description: "GitHub issue body, excluding the generated provenance marker." }),
	labels: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
	blockedBy: Type.Optional(Type.Array(Type.String({ minLength: 1, description: "Plan-local blocker key." }))),
	parent: Type.Optional(Type.String({ minLength: 1, description: "Plan-local parent key for a native GitHub sub-issue relationship." })),
	state: Type.Optional(Type.Union([Type.Literal("open"), Type.Literal("closed")])),
});

const IssuePlanSchema = Type.Object({
	key: Type.String({ minLength: 1, description: "Stable plan key. Changing it changes generated idempotency markers." }),
	issues: Type.Array(PlanItemSchema, { minItems: 1, description: "Issues to create or reconcile by stable marker." }),
});

const MutationSchema = Type.Union([
	Type.Object({
		op: Type.Literal("ensure_label"),
		name: Type.String({ minLength: 1 }),
		color: Type.Optional(Type.String({ description: "Six hexadecimal digits, without #." })),
		description: Type.Optional(Type.String()),
	}),
	Type.Object({
		op: Type.Literal("create_issue"),
		title: Type.String({ minLength: 1 }),
		body: Type.String(),
		labels: Type.Optional(Type.Array(Type.String())),
	}),
	Type.Object({
		op: Type.Literal("update_issue"),
		number: Type.Number({ minimum: 1 }),
		title: Type.Optional(Type.String()),
		body: Type.Optional(Type.String()),
		state: Type.Optional(Type.Union([Type.Literal("open"), Type.Literal("closed")])),
	}),
	Type.Object({
		op: Type.Literal("comment"),
		number: Type.Number({ minimum: 1 }),
		body: Type.String({ minLength: 1 }),
	}),
	Type.Object({
		op: Type.Literal("claim_issue"),
		number: Type.Number({ minimum: 1 }),
	}),
	Type.Object({
		op: Type.Literal("close_issue"),
		number: Type.Number({ minimum: 1 }),
		comment: Type.Optional(Type.String()),
	}),
]);

const BaseParams = {
	repo: Type.Optional(Type.String({ description: "GitHub owner/repository. Defaults to the current checkout remote; any different repository is rejected." })),
	apply: Type.Optional(Type.Boolean({ description: "Persist the mutation after reviewing the default dry run. Defaults to false." })),
};

const MutateParamsSchema = Type.Object({
	...BaseParams,
	mutation: MutationSchema,
});

const PlanParamsSchema = Type.Object({
	...BaseParams,
	plan: IssuePlanSchema,
});

const InspectParamsSchema = Type.Object({
	repo: Type.Optional(Type.String({ description: "GitHub owner/repository. Defaults to the current checkout remote; any different repository is rejected." })),
	number: Type.Optional(Type.Number({ minimum: 1, description: "Issue number to inspect." })),
	marker: Type.Optional(Type.String({ description: "Generated provenance marker to find, for idempotency inspection." })),
	include_body: Type.Optional(Type.Boolean({ description: "Include a body excerpt in the response. Defaults to false." })),
});

const RelationshipParamsSchema = Type.Object({
	...BaseParams,
	op: Type.Union([Type.Literal("add_subissue"), Type.Literal("add_blocker")]),
	parent: Type.Optional(Type.Number({ minimum: 1 })),
	child: Type.Number({ minimum: 1, description: "Child issue number for add_subissue or blocked issue number for add_blocker." }),
	blocker: Type.Optional(Type.Number({ minimum: 1, description: "Blocker issue number for add_blocker." })),
});

const MigrationParamsSchema = Type.Object({
	...BaseParams,
	operation: Type.Union([Type.Literal("dry_run"), Type.Literal("apply_issues"), Type.Literal("apply_relationships"), Type.Literal("reconcile"), Type.Literal("resume"), Type.Literal("cleanup")]),
	manifest_path: Type.String({ description: "Repository-relative migration manifest under .pi/tmp/tk-to-github/." }),
	issue_plan_path: Type.String({ description: "Repository-relative issue plan under .pi/tmp/tk-to-github/." }),
	cursor: Type.Optional(Type.Number({ minimum: 0, description: "Zero-based batch offset. Defaults to zero." })),
	batch_size: Type.Optional(Type.Number({ minimum: 1, maximum: 50, description: "Maximum issues or relationships to process. Defaults to 10." })),
	write_delay_ms: Type.Optional(Type.Number({ minimum: 0, maximum: 10_000, description: "Delay between GitHub writes. Defaults to 750ms." })),
	cleanup_approved: Type.Optional(Type.Boolean({ description: "Must be true only after separate explicit user approval for cleanup apply." })),
});

const GraphParamsSchema = Type.Object({
	repo: Type.Optional(Type.String({ description: "GitHub owner/repository. Defaults to the current checkout remote; any different repository is rejected." })),
	parent: Type.Number({ minimum: 1, description: "Parent issue whose direct sub-issues are inspected." }),
	ready_label: Type.Optional(Type.String({ description: "Label required for a frontier issue. Defaults to ready-for-agent." })),
});

function compactJson(value: unknown): string {
	return JSON.stringify(value, null, 2);
}

export type GitHubCommandOptions = { signal?: AbortSignal; timeoutMs?: number; deadlineMs?: number };
const DEFAULT_GITHUB_COMMAND_TIMEOUT_MS = 30_000;

function commandTimeout(options: GitHubCommandOptions): number {
	const requested = options.timeoutMs ?? DEFAULT_GITHUB_COMMAND_TIMEOUT_MS;
	const remaining = options.deadlineMs === undefined ? requested : Math.min(requested, options.deadlineMs - Date.now());
	if (!Number.isFinite(remaining) || remaining <= 0) throw new Error("GitHub command deadline has expired.");
	return Math.max(1, Math.trunc(remaining));
}

async function run(cwd: string, args: string[], options: GitHubCommandOptions = {}, input?: string): Promise<string> {
	if (process.platform === "win32") throw new Error("GitHub issue tools require POSIX process-group cleanup and are unsupported on Windows.");
	const timeoutMs = commandTimeout(options);
	return await new Promise((resolve, reject) => {
		const child = spawn("gh", args, { cwd, shell: false, detached: true, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		let settled = false;
		const cleanup = () => {
			clearTimeout(timeout);
			options.signal?.removeEventListener("abort", abort);
		};
		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			if (error) reject(error);
			else resolve(stdout.trim());
		};
		const terminate = (error: Error) => {
			if (settled) return;
			try {
				if (child.pid) process.kill(-child.pid, "SIGKILL");
				else child.kill("SIGKILL");
			} catch { /* process group may have exited */ }
			finish(error);
		};
		const abort = () => terminate(new Error(`GitHub command aborted: gh ${args.join(" ")}`));
		const timeout = setTimeout(() => terminate(new Error(`GitHub command timed out after ${timeoutMs}ms: gh ${args.join(" ")}`)), timeoutMs);
		timeout.unref?.();
		options.signal?.addEventListener("abort", abort, { once: true });
		child.stdout!.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
		child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
		child.on("error", (error) => finish(error));
		child.on("close", (code) => code === 0 ? finish() : finish(new Error((stderr || stdout || `gh ${args.join(" ")} failed`).trim())));
		if (input !== undefined) child.stdin!.end(input);
		if (options.signal?.aborted) abort();
	});
}

async function ghJson(cwd: string, args: string[], options: GitHubCommandOptions = {}): Promise<any> {
	const output = await run(cwd, args, options);
	try {
		return JSON.parse(output);
	} catch {
		throw new Error(`GitHub CLI returned invalid JSON for gh ${args.join(" ")}: ${output.slice(0, 500)}`);
	}
}

function nonEmpty(value: string | undefined, field: string): string {
	if (!value?.trim()) throw new Error(`${field} is required.`);
	return value;
}

function issueNumber(value: number | undefined): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw new Error("number must be a positive integer.");
	return value;
}

function normalizedColor(value: string | undefined): string {
	const color = value ?? "0E8A16";
	if (!/^[a-fA-F0-9]{6}$/.test(color)) throw new Error("Label color must be exactly six hexadecimal digits, without #.");
	return color.toUpperCase();
}

async function currentRepo(cwd: string, requested?: string, commandOptions: GitHubCommandOptions = {}): Promise<string> {
	await run(cwd, ["auth", "status"], commandOptions);
	const detected = await ghJson(cwd, ["repo", "view", "--json", "nameWithOwner"], commandOptions);
	const repo = String(detected.nameWithOwner ?? "");
	if (!repo.includes("/")) throw new Error("Could not infer owner/repository from the current checkout.");
	if (requested && requested !== repo) {
		throw new Error(`Cross-repository mutation is blocked: current checkout is ${repo}, requested ${requested}.`);
	}
	return repo;
}

/** Read aloop context only from the repository belonging to the current checkout. */
export async function currentGitHubLogin(cwd: string, requestedRepo?: string, commandOptions: GitHubCommandOptions = {}): Promise<string> {
	await currentRepo(cwd, requestedRepo, commandOptions);
	const user = await ghJson(cwd, ["api", "user"], commandOptions);
	const login = String(user.login ?? "").trim();
	if (!login) throw new Error("Could not determine the authenticated GitHub login.");
	return login;
}

export async function retrieveCurrentRepositoryEpicContext(
	cwd: string,
	epicNumber: number,
	requestedRepo?: string,
	options?: GitHubEpicContextOptions & GitHubCommandOptions,
): Promise<GitHubEpicContext> {
	const repo = await currentRepo(cwd, requestedRepo, options);
	return await retrieveGitHubEpicContext(
		async (endpoint) => await ghJson(cwd, ["api", `repos/${repo}/${endpoint}`], options),
		epicNumber,
		options,
	);
}

export function issueMarker(planKey: string, issueKey: string): string {
	if (!planKey.trim() || !issueKey.trim()) throw new Error("Plan and issue keys must be non-empty.");
	return `<!-- ${MARKER_PREFIX}:${planKey}/${issueKey} -->`;
}

export function bodyWithMarker(planKey: string, item: GitHubIssuePlanItem): string {
	return `${item.body.trim()}\n\n${issueMarker(planKey, item.key)}`;
}

export function migrationIssuePlan(planKey: string, records: MigrationRecord[]): GitHubIssuePlan {
	for (const record of records.filter((candidate) => candidate.disposition === "omit")) {
		if (record.omissionApproved !== true || !record.proposedDisposition?.trim() || !Array.isArray(record.classificationEvidence) || record.classificationEvidence.length === 0 || record.classificationEvidence.some((evidence) => !evidence.trim())) {
			throw new Error(`Omitted migration record ${record.sourceId} requires explicit approval, a proposed disposition, and classification evidence.`);
		}
	}
	const migrated = new Set(records.filter((record) => record.disposition !== "omit").map((record) => record.sourceId));
	const plan = {
		key: planKey,
		issues: records
			.filter((record) => record.disposition !== "omit")
			.map((record) => ({
				key: record.sourceId,
				title: record.title,
				body: `${record.body.trim()}${record.links?.length ? `\n\n## Related tk tickets\n\n${record.links.map((link) => `- \`${link}\``).join("\n")}` : ""}\n\n## Migration provenance\n\nMigrated from tk ticket \`${record.sourceId}\`.`,
				labels: record.labels ?? [],
				blockedBy: (record.blockedBy ?? []).filter((id) => migrated.has(id)),
				parent: record.parent && migrated.has(record.parent) ? record.parent : undefined,
				state: record.disposition === "migrate-closed" ? "closed" as const : "open" as const,
			})),
	};
	validateIssuePlan(plan);
	return plan;
}

export function validateIssuePlan(plan: GitHubIssuePlan): void {
	if (!plan.key.trim()) throw new Error("Plan key must be non-empty.");
	if (plan.issues.length === 0) throw new Error("Plan must contain at least one issue.");
	const byKey = new Map<string, GitHubIssuePlanItem>();
	for (const item of plan.issues) {
		if (!item.key.trim() || !item.title.trim()) throw new Error("Every plan issue needs a non-empty key and title.");
		if (byKey.has(item.key)) throw new Error(`Duplicate plan issue key: ${item.key}`);
		byKey.set(item.key, item);
	}
	for (const item of plan.issues) {
		for (const blocker of item.blockedBy ?? []) {
			if (!byKey.has(blocker)) throw new Error(`Issue ${item.key} references missing blocker key: ${blocker}`);
		}
		if (item.parent && !byKey.has(item.parent)) throw new Error(`Issue ${item.key} references missing parent key: ${item.parent}`);
		if (item.parent === item.key) throw new Error(`Issue ${item.key} cannot be its own parent.`);
	}
	const visiting = new Set<string>();
	const visited = new Set<string>();
	const visit = (key: string) => {
		if (visited.has(key)) return;
		if (visiting.has(key)) throw new Error(`Plan dependency cycle includes ${key}.`);
		visiting.add(key);
		for (const blocker of byKey.get(key)?.blockedBy ?? []) visit(blocker);
		visiting.delete(key);
		visited.add(key);
	};
	for (const key of byKey.keys()) visit(key);
	for (const key of byKey.keys()) {
		const parentPath = new Set<string>([key]);
		let current = byKey.get(key);
		let depth = 0;
		while (current?.parent) {
			if (parentPath.has(current.parent)) throw new Error(`Plan parent cycle includes ${current.parent}.`);
			parentPath.add(current.parent);
			depth += 1;
			if (depth > 7) throw new Error(`Plan parent hierarchy for ${key} exceeds GitHub's eight-level limit.`);
			current = byKey.get(current.parent);
		}
	}
}

async function findByMarker(cwd: string, repo: string, marker: string, commandOptions: GitHubCommandOptions = {}): Promise<any | undefined> {
	const query = `repo:${repo} is:issue in:body "${marker}"`;
	const matches: any[] = [];
	for (let page = 1; page <= 10; page += 1) {
		const search = await ghJson(cwd, ["api", "--method", "GET", "search/issues", "-f", `q=${query}`, "-f", "per_page=100", "-f", `page=${page}`], commandOptions);
		const items = Array.isArray(search.items) ? search.items : [];
		matches.push(...items.filter((item: any) => typeof item.body === "string" && item.body.includes(marker)));
		if (matches.length > 1) throw new Error(`Idempotency marker ${marker} matches multiple GitHub issues.`);
		if (items.length < 100) return matches[0];
	}
	throw new Error(`Idempotency marker search exceeded GitHub's 1,000-result pagination limit: ${marker}`);
}

async function mutate(cwd: string, repo: string, mutation: GitHubIssueMutation, apply: boolean, commandOptions: GitHubCommandOptions = {}): Promise<unknown> {
	const dryRun = { dryRun: true, repo, mutation };
	if (!apply) return dryRun;

	switch (mutation.op) {
		case "ensure_label": {
			const name = nonEmpty(mutation.name, "name");
			const payload = { name, color: normalizedColor(mutation.color), description: mutation.description ?? "" };
			try {
				await ghJson(cwd, ["api", `repos/${repo}/labels/${encodeURIComponent(name)}`], commandOptions);
				return await ghJsonWithInput(cwd, ["api", "--method", "PATCH", `repos/${repo}/labels/${encodeURIComponent(name)}`], payload, commandOptions);
			} catch (error) {
				if (!String(error).includes("404")) throw error;
				return await ghJsonWithInput(cwd, ["api", "--method", "POST", `repos/${repo}/labels`], payload, commandOptions);
			}
		}
		case "create_issue": {
			const payload = { title: nonEmpty(mutation.title, "title"), body: mutation.body ?? "", labels: mutation.labels ?? [] };
			return await ghJsonWithInput(cwd, ["api", "--method", "POST", `repos/${repo}/issues`], payload, commandOptions);
		}
		case "update_issue": {
			const payload = Object.fromEntries(Object.entries({ title: mutation.title, body: mutation.body, state: mutation.state }).filter(([, value]) => value !== undefined));
			if (Object.keys(payload).length === 0) throw new Error("update_issue requires title, body, or state.");
			return await ghJsonWithInput(cwd, ["api", "--method", "PATCH", `repos/${repo}/issues/${issueNumber(mutation.number)}`], payload, commandOptions);
		}
		case "comment":
			return await ghJsonWithInput(cwd, ["api", "--method", "POST", `repos/${repo}/issues/${issueNumber(mutation.number)}/comments`], { body: nonEmpty(mutation.body, "body") }, commandOptions);
		case "claim_issue": {
			const number = issueNumber(mutation.number);
			const issue = await ghJson(cwd, ["api", `repos/${repo}/issues/${number}`], commandOptions);
			const user = await ghJson(cwd, ["api", "user"], commandOptions);
			const login = nonEmpty(String(user.login ?? ""), "authenticated GitHub login");
			const assignees = Array.isArray(issue.assignees) ? issue.assignees.map((assignee: any) => String(assignee.login ?? "")).filter(Boolean) : [];
			const labels = Array.isArray(issue.labels) ? issue.labels.map((label: any) => String(label.name ?? "")).filter((label: string) => label && label !== "ready-for-agent") : [];
			const hadReadyLabel = Array.isArray(issue.labels) && issue.labels.some((label: any) => label?.name === "ready-for-agent");
			if (assignees.includes(login) && !hadReadyLabel) return { status: "existing", number, assignee: login };
			if (assignees.length > 0 && !assignees.includes(login)) throw new Error(`Issue #${number} is already assigned to ${assignees.join(", ")}.`);
			return await ghJsonWithInput(cwd, ["api", "--method", "PATCH", `repos/${repo}/issues/${number}`], { assignees: [login], labels }, commandOptions);
		}
		case "close_issue": {
			const closed = await ghJsonWithInput(cwd, ["api", "--method", "PATCH", `repos/${repo}/issues/${issueNumber(mutation.number)}`], { state: "closed" }, commandOptions);
			if (mutation.comment?.trim()) await ghJsonWithInput(cwd, ["api", "--method", "POST", `repos/${repo}/issues/${issueNumber(mutation.number)}/comments`], { body: mutation.comment }, commandOptions);
			return closed;
		}
	}
}

async function ghJsonWithInput(cwd: string, args: string[], payload: unknown, options: GitHubCommandOptions = {}): Promise<any> {
	const output = await run(cwd, [...args, "--input", "-"], options, JSON.stringify(payload));
	try { return JSON.parse(output); } catch { throw new Error(`GitHub CLI returned invalid JSON: ${output.slice(0, 500)}`); }
}

async function publishPlan(cwd: string, repo: string, plan: GitHubIssuePlan, apply: boolean, commandOptions: GitHubCommandOptions = {}): Promise<unknown> {
	validateIssuePlan(plan);
	const proposed = plan.issues.map((item) => ({
		key: item.key,
		marker: issueMarker(plan.key, item.key),
		title: item.title,
		labels: item.labels ?? [],
		state: item.state ?? "open",
		blockedBy: item.blockedBy ?? [],
	}));
	if (!apply) return { dryRun: true, repo, plan: { key: plan.key, issues: proposed }, note: "Issue creation is dry-run. Blocker relationships are validated but are published by the relationship tooling." };

	const results: Array<{ key: string; number: number; url: string; status: "created" | "existing" }> = [];
	for (const item of plan.issues) {
		const marker = issueMarker(plan.key, item.key);
		const existing = await findByMarker(cwd, repo, marker, commandOptions);
		if (existing) {
			results.push({ key: item.key, number: existing.number, url: existing.html_url, status: "existing" });
			continue;
		}
		const created = await ghJsonWithInput(cwd, ["api", "--method", "POST", `repos/${repo}/issues`], {
			title: item.title,
			body: bodyWithMarker(plan.key, item),
			labels: item.labels ?? [],
		}, commandOptions);
		if (item.state === "closed") await ghJsonWithInput(cwd, ["api", "--method", "PATCH", `repos/${repo}/issues/${created.number}`], { state: "closed" }, commandOptions);
		results.push({ key: item.key, number: created.number, url: created.html_url, status: "created" });
	}
	return { repo, planKey: plan.key, issues: results, deferredBlockedBy: plan.issues.filter((item) => (item.blockedBy?.length ?? 0) > 0).map((item) => ({ key: item.key, blockedBy: item.blockedBy })) };
}

type MigrationOutcome = {
	repo: string;
	planKey: string;
	issues: Record<string, { number: number; url: string }>;
	relationships: Record<string, true>;
	labelsInitialized?: boolean;
};

function isRateLimited(error: unknown): boolean {
	return /secondary rate limit|rate limit exceeded|api rate limit/i.test(String(error));
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(done, ms);
		function done() { signal?.removeEventListener("abort", aborted); resolve(); }
		function aborted() { clearTimeout(timer); signal?.removeEventListener("abort", aborted); reject(new Error("GitHub migration aborted.")); }
		signal?.addEventListener("abort", aborted, { once: true });
		if (signal?.aborted) aborted();
	});
}

function migrationArtifactPath(cwd: string, input: string): string {
	if (path.isAbsolute(input)) throw new Error("Migration artifact paths must be repository-relative.");
	const root = path.resolve(cwd, ".pi/tmp/tk-to-github");
	const resolved = path.resolve(cwd, input);
	if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error("Migration artifacts must stay under .pi/tmp/tk-to-github/.");
	return resolved;
}

async function readMigrationPlan(cwd: string, manifestPath: string, issuePlanPath: string): Promise<{ plan: GitHubIssuePlan; records: MigrationRecord[]; outcomePath: string }> {
	const manifest = JSON.parse(await readFile(migrationArtifactPath(cwd, manifestPath), "utf8"));
	if (!manifest || typeof manifest !== "object" || !Array.isArray(manifest.records)) throw new Error("Migration manifest must contain a records array.");
	const records = manifest.records as MigrationRecord[];
	const plan = JSON.parse(await readFile(migrationArtifactPath(cwd, issuePlanPath), "utf8")) as GitHubIssuePlan;
	validateIssuePlan(plan);
	const expectedPlan = migrationIssuePlan(plan.key, records);
	const canonical = (item: GitHubIssuePlanItem) => ({
		title: item.title,
		body: item.body,
		labels: [...(item.labels ?? [])].sort(),
		blockedBy: [...(item.blockedBy ?? [])].sort(),
		parent: item.parent ?? null,
		state: item.state ?? "open",
	});
	const expectedByKey = new Map(expectedPlan.issues.map((item) => [item.key, canonical(item)]));
	const actualByKey = new Map(plan.issues.map((item) => [item.key, canonical(item)]));
	const missing = [...expectedByKey.keys()].filter((key) => !actualByKey.has(key));
	const unexpected = [...actualByKey.keys()].filter((key) => !expectedByKey.has(key));
	const changed = [...expectedByKey.keys()].filter((key) => actualByKey.has(key) && JSON.stringify(actualByKey.get(key)) !== JSON.stringify(expectedByKey.get(key)));
	if (missing.length > 0 || unexpected.length > 0 || changed.length > 0) {
		throw new Error(`Migration issue plan does not exactly match manifest records (missing: ${missing.join(", ") || "none"}; unexpected: ${unexpected.join(", ") || "none"}; changed: ${changed.join(", ") || "none"}).`);
	}
	return { plan, records, outcomePath: path.join(path.dirname(migrationArtifactPath(cwd, manifestPath)), "github-migration-outcomes.json") };
}

async function readOutcome(outcomePath: string, repo: string, planKey: string): Promise<MigrationOutcome> {
	try {
		const parsed = JSON.parse(await readFile(outcomePath, "utf8")) as MigrationOutcome;
		if (parsed.repo !== repo || parsed.planKey !== planKey || !parsed.issues) throw new Error("Migration outcome belongs to a different repository or plan.");
		return { ...parsed, relationships: parsed.relationships ?? {} };
	} catch (error: any) {
		if (error?.code === "ENOENT") return { repo, planKey, issues: {}, relationships: {} };
		throw error;
	}
}

async function writeOutcome(outcomePath: string, outcome: MigrationOutcome): Promise<void> {
	await writeFile(outcomePath, `${JSON.stringify(outcome, null, 2)}\n`, "utf8");
}

function migrationEdges(plan: GitHubIssuePlan): Array<{ kind: "subissue" | "blocker"; child: string; other: string }> {
	return plan.issues.flatMap((item) => [
		...(item.parent ? [{ kind: "subissue" as const, child: item.key, other: item.parent }] : []),
		...(item.blockedBy ?? []).map((other) => ({ kind: "blocker" as const, child: item.key, other })),
	]);
}

async function rateLimitPause(cwd: string, repo: string, phase: string, completed: number, outcomePath: string, error: unknown, commandOptions: GitHubCommandOptions = {}): Promise<unknown> {
	let retryAfter: string | undefined;
	try {
		const rate = await ghJson(cwd, ["api", "rate_limit"], commandOptions);
		const reset = rate.resources?.core?.reset;
		if (typeof reset === "number") retryAfter = new Date(reset * 1000).toISOString();
	} catch { /* secondary limits may also block this read */ }
	return { paused: true, reason: "github-rate-limit", repo, phase, completed, retryAfter, outcomePath: path.relative(cwd, outcomePath), error: String(error) };
}

export async function executeMigration(cwd: string, repo: string, params: { operation: "dry_run" | "apply_issues" | "apply_relationships" | "reconcile" | "resume"; manifest_path: string; issue_plan_path: string; cursor?: number; batch_size?: number; write_delay_ms?: number; apply?: boolean }, commandOptions: GitHubCommandOptions = {}): Promise<unknown> {
	const { plan, records, outcomePath } = await readMigrationPlan(cwd, params.manifest_path, params.issue_plan_path);
	const batchSize = Math.max(1, Math.min(50, Math.trunc(params.batch_size ?? 10)));
	const delay = Math.max(0, Math.min(10_000, Math.trunc(params.write_delay_ms ?? 750)));
	const edges = migrationEdges(plan);
	if (params.operation === "dry_run") return { dryRun: true, repo, planKey: plan.key, issues: plan.issues.length, relationships: edges.length, labels: [...new Set(plan.issues.flatMap((item) => item.labels ?? []))], outcomePath: path.relative(cwd, outcomePath) };
	const outcome = await readOutcome(outcomePath, repo, plan.key);
	const pendingIssues = plan.issues.filter((item) => !outcome.issues[item.key]);
	const pendingEdges = edges.filter((edge) => !outcome.relationships[`${edge.kind}:${edge.child}:${edge.other}`]);
	const operation = params.operation === "resume" ? (pendingIssues.length > 0 ? "apply_issues" : pendingEdges.length > 0 ? "apply_relationships" : "reconcile") : params.operation;
	if (operation === "apply_issues") {
		const batch = pendingIssues.slice(0, batchSize);
		if (!params.apply) return { dryRun: true, phase: "issues", pending: pendingIssues.length, batch: batch.map((item) => item.key), outcomePath: path.relative(cwd, outcomePath) };
		try {
			if (!outcome.labelsInitialized) {
				for (const label of new Set(plan.issues.flatMap((item) => item.labels ?? []))) {
					await mutate(cwd, repo, { op: "ensure_label", name: label }, true, commandOptions);
					if (delay) await sleep(delay, commandOptions.signal);
				}
				outcome.labelsInitialized = true;
				await writeOutcome(outcomePath, outcome);
			}
			for (const item of batch) {
				const existing = await findByMarker(cwd, repo, issueMarker(plan.key, item.key), commandOptions);
				const issue = existing ?? await ghJsonWithInput(cwd, ["api", "--method", "POST", `repos/${repo}/issues`], { title: item.title, body: bodyWithMarker(plan.key, item), labels: item.labels ?? [] }, commandOptions);
				if (item.state === "closed" && issue.state !== "closed") await ghJsonWithInput(cwd, ["api", "--method", "PATCH", `repos/${repo}/issues/${issue.number}`], { state: "closed" }, commandOptions);
				outcome.issues[item.key] = { number: issue.number, url: issue.html_url };
				await writeOutcome(outcomePath, outcome);
				if (delay) await sleep(delay, commandOptions.signal);
			}
		} catch (error) {
			if (isRateLimited(error)) return await rateLimitPause(cwd, repo, "issues", Object.keys(outcome.issues).length, outcomePath, error, commandOptions);
			throw error;
		}
		return { phase: "issues", processed: batch.map((item) => item.key), remaining: plan.issues.length - Object.keys(outcome.issues).length, nextOperation: Object.keys(outcome.issues).length < plan.issues.length ? "apply_issues" : "apply_relationships", outcomePath: path.relative(cwd, outcomePath) };
	}
	if (operation === "apply_relationships") {
		if (pendingIssues.length > 0) throw new Error("Publish every issue before publishing relationships.");
		const batch = pendingEdges.slice(0, batchSize);
		if (!params.apply) return { dryRun: true, phase: "relationships", pending: pendingEdges.length, batch, outcomePath: path.relative(cwd, outcomePath) };
		try {
			for (const edge of batch) {
				const child = outcome.issues[edge.child]!.number;
				const other = outcome.issues[edge.other]!.number;
				await publishRelationship(cwd, repo, edge.kind === "subissue" ? { op: "add_subissue", parent: other, child } : { op: "add_blocker", child, blocker: other }, true, commandOptions);
				outcome.relationships[`${edge.kind}:${edge.child}:${edge.other}`] = true;
				await writeOutcome(outcomePath, outcome);
				if (delay) await sleep(delay, commandOptions.signal);
			}
		} catch (error) {
			if (isRateLimited(error)) return await rateLimitPause(cwd, repo, "relationships", Object.keys(outcome.relationships).length, outcomePath, error, commandOptions);
			throw error;
		}
		return { phase: "relationships", processed: batch, remaining: edges.length - Object.keys(outcome.relationships).length, nextOperation: Object.keys(outcome.relationships).length < edges.length ? "apply_relationships" : "reconcile", outcomePath: path.relative(cwd, outcomePath) };
	}
	const mismatches: ReconciliationMismatch[] = [];
	const liveIssues = new Map<string, any>();
	for (const item of plan.issues) {
		const expected = outcome.issues[item.key];
		const found = expected ? await findByMarker(cwd, repo, issueMarker(plan.key, item.key), commandOptions) : undefined;
		if (!expected || !found || expected.number !== found.number) mismatches.push({ key: item.key, kind: "marker", expected: expected?.number ?? "mapped issue", actual: found?.number ?? null });
		else {
			liveIssues.set(item.key, found);
			if (found.state !== (item.state ?? "open")) mismatches.push({ key: item.key, kind: "state", expected: item.state ?? "open", actual: found.state });
			if (found.title !== item.title) mismatches.push({ key: item.key, kind: "title", expected: item.title, actual: found.title });
			const expectedBody = bodyWithMarker(plan.key, item);
			if (found.body !== expectedBody) mismatches.push({ key: item.key, kind: "body", expected: expectedBody, actual: found.body });
			const expectedLabels = [...(item.labels ?? [])].sort();
			const actualLabels = (Array.isArray(found.labels) ? found.labels : []).map((label: any) => typeof label === "string" ? label : String(label?.name ?? "")).filter(Boolean).sort();
			if (JSON.stringify(actualLabels) !== JSON.stringify(expectedLabels)) mismatches.push({ key: item.key, kind: "labels", expected: expectedLabels, actual: actualLabels });
		}
	}
	for (const record of records.filter((candidate) => candidate.disposition === "omit")) {
		const unexpected = await findByMarker(cwd, repo, issueMarker(plan.key, record.sourceId), commandOptions);
		if (unexpected) mismatches.push({ key: record.sourceId, kind: "omission", expected: "no published GitHub issue", actual: unexpected.number });
	}
	for (const edge of edges) {
		const checkpoint = outcome.relationships[`${edge.kind}:${edge.child}:${edge.other}`] === true;
		if (!checkpoint) {
			mismatches.push({ key: edge.child, kind: "relationship", expected: `${edge.kind}:${edge.other}`, actual: "missing local checkpoint" });
			continue;
		}
		const child = liveIssues.get(edge.child);
		const other = liveIssues.get(edge.other);
		if (!child || !other) continue;
		const ownerNumber = edge.kind === "subissue" ? other.number : child.number;
		const targetId = edge.kind === "subissue" ? child.id : other.id;
		const endpoint = edge.kind === "subissue" ? "sub_issues" : "dependencies/blocked_by";
		const live = await paginatedGitHubArray(cwd, `repos/${repo}/issues/${ownerNumber}/${endpoint}`, commandOptions);
		if (!Array.isArray(live) || !live.some((issue: any) => issue.id === targetId)) {
			mismatches.push({ key: edge.child, kind: "relationship", expected: `${edge.kind}:${edge.other}`, actual: "missing on GitHub" });
		}
	}
	return { phase: "reconcile", repo, planKey: plan.key, passed: mismatches.length === 0, mismatches, outcomePath: path.relative(cwd, outcomePath) };
}

/** Destructive cutover boundary used only after explicit approval and a fresh live reconciliation. */
export async function completeMigrationCleanup(cwd: string, options: {
	approved: boolean;
	repo: string;
	manifestPath: string;
	issuePlanPath: string;
	guidancePath?: string;
	commandOptions?: GitHubCommandOptions;
}): Promise<void> {
	if (!options.approved) throw new Error("Migration cleanup requires explicit approval.");
	const reconciliation = await executeMigration(cwd, options.repo, {
		operation: "reconcile",
		manifest_path: options.manifestPath,
		issue_plan_path: options.issuePlanPath,
	}, options.commandOptions);
	if ((reconciliation as MigrationReconciliation).phase !== "reconcile" || !(reconciliation as MigrationReconciliation).passed || (reconciliation as MigrationReconciliation).mismatches.length > 0) {
		throw new Error("Migration cleanup requires a fresh successful reconciliation.");
	}
	const guidance = path.resolve(cwd, options.guidancePath ?? "docs/agents/issue-tracker.md");
	if (guidance !== path.resolve(cwd, "docs/agents/issue-tracker.md")) throw new Error("Migration guidance path must be docs/agents/issue-tracker.md.");
	await rm(path.resolve(cwd, ".tickets"), { recursive: true, force: true });
	await mkdir(path.dirname(guidance), { recursive: true });
	let existing = "";
	try { existing = await readFile(guidance, "utf8"); } catch (error: any) { if (error?.code !== "ENOENT") throw error; }
	const sourceOfTruth = "GitHub Issues are the sole durable task source of truth for this repository.";
	let updated = existing
		.replace(/^.*\btk\b.*(?:authoritative|source of truth).*$/gim, sourceOfTruth)
		.replace(/^.*(?:create|update).+\btk\b.+tickets?.*$/gim, "");
	if (!updated.includes(sourceOfTruth)) updated = `${sourceOfTruth}\n\n${updated}`;
	if (!/^#\s+Issue tracker:\s*GitHub\s*$/im.test(updated)) updated = `# Issue tracker: GitHub\n\n${updated.replace(/^#\s+Issue tracker:.*$/im, "").trim()}\n`;
	await writeFile(guidance, `${updated.trim()}\n`, "utf8");
}

async function paginatedGitHubArray(cwd: string, endpoint: string, commandOptions: GitHubCommandOptions = {}): Promise<any[]> {
	const all: any[] = [];
	for (let page = 1; page <= 100; page += 1) {
		const separator = endpoint.includes("?") ? "&" : "?";
		const batch = await ghJson(cwd, ["api", `${endpoint}${separator}per_page=100&page=${page}`], commandOptions);
		if (!Array.isArray(batch)) throw new Error(`GitHub list endpoint returned a non-array: ${endpoint}`);
		all.push(...batch);
		if (batch.length < 100) return all;
	}
	throw new Error(`GitHub list endpoint exceeded 100 pages: ${endpoint}`);
}

async function issueDatabaseId(cwd: string, repo: string, number: number, commandOptions: GitHubCommandOptions = {}): Promise<number> {
	const issue = await ghJson(cwd, ["api", `repos/${repo}/issues/${issueNumber(number)}`], commandOptions);
	if (!Number.isInteger(issue.id)) throw new Error(`GitHub issue #${number} did not provide a REST database ID.`);
	return issue.id;
}

async function publishRelationship(cwd: string, repo: string, params: { op: "add_subissue" | "add_blocker"; parent?: number; child: number; blocker?: number }, apply: boolean, commandOptions: GitHubCommandOptions = {}): Promise<unknown> {
	if (params.op === "add_subissue") {
		const parent = issueNumber(params.parent);
		const child = issueNumber(params.child);
		const childId = await issueDatabaseId(cwd, repo, child, commandOptions);
		if (!apply) return { dryRun: true, repo, op: params.op, parent, child, childDatabaseId: childId };
		const existing = await paginatedGitHubArray(cwd, `repos/${repo}/issues/${parent}/sub_issues`, commandOptions);
		if ((existing ?? []).some((issue: any) => issue.id === childId)) return { repo, op: params.op, parent, child, status: "existing" };
		return await ghJsonWithInput(cwd, ["api", "--method", "POST", `repos/${repo}/issues/${parent}/sub_issues`], { sub_issue_id: childId }, commandOptions);
	}
	const child = issueNumber(params.child);
	const blocker = issueNumber(params.blocker);
	const blockerId = await issueDatabaseId(cwd, repo, blocker, commandOptions);
	if (!apply) return { dryRun: true, repo, op: params.op, child, blocker, blockerDatabaseId: blockerId };
	const existing = await paginatedGitHubArray(cwd, `repos/${repo}/issues/${child}/dependencies/blocked_by`, commandOptions);
	if ((existing ?? []).some((issue: any) => issue.id === blockerId)) return { repo, op: params.op, child, blocker, status: "existing" };
	return await ghJsonWithInput(cwd, ["api", "--method", "POST", `repos/${repo}/issues/${child}/dependencies/blocked_by`], { issue_id: blockerId }, commandOptions);
}

export function frontierIssueNumbers(issues: Array<{ number: number; state: string; labels?: Array<{ name?: string }>; assignee?: unknown; issue_dependencies_summary?: { blocked_by?: number } }>, readyLabel = "ready-for-agent"): number[] {
	return issues
		.filter((issue) => issue.state === "open")
		.filter((issue) => (issue.labels ?? []).some((label) => label.name === readyLabel))
		.filter((issue) => !issue.assignee)
		.filter((issue) => (issue.issue_dependencies_summary?.blocked_by ?? 0) === 0)
		.map((issue) => issue.number);
}

export async function inspectGraph(cwd: string, repo: string, parent: number, readyLabel: string, commandOptions: GitHubCommandOptions = {}): Promise<unknown> {
	const children = await paginatedGitHubArray(cwd, `repos/${repo}/issues/${issueNumber(parent)}/sub_issues`, commandOptions);
	const issues = await Promise.all((children as any[]).map(async (child) => await ghJson(cwd, ["api", `repos/${repo}/issues/${child.number}`], commandOptions)));
	return {
		repo,
		parent,
		issues: issues.map((issue) => ({ number: issue.number, title: issue.title, state: issue.state, labels: issue.labels, assignee: issue.assignee?.login ?? null, openBlockers: issue.issue_dependencies_summary?.blocked_by ?? 0 })),
		frontier: frontierIssueNumbers(issues, readyLabel),
	};
}

function truncate(value: string, limit = 500): string {
	return value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 1))}…`;
}

async function compactResponse(cwd: string, tool: string, summary: string, raw: unknown): Promise<{ content: Array<{ type: "text"; text: string }>; details: { artifactPath: string } }> {
	const dir = path.join(cwd, ".pi/tmp/github-issues");
	await mkdir(dir, { recursive: true });
	const artifactPath = path.join(dir, `${tool}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
	await writeFile(artifactPath, `${compactJson(raw)}\n`, "utf8");
	const relative = path.relative(cwd, artifactPath);
	return { content: [{ type: "text", text: `${truncate(summary, 3_000)}\nArtifact: ${relative}` }], details: { artifactPath: relative } };
}

function issueSummary(issue: any, includeBody = false): string {
	if (!issue) return "No matching GitHub issue found.";
	const lines = [`#${issue.number ?? "?"} ${truncate(String(issue.title ?? "(untitled)"), 180)}`, `State: ${issue.state ?? "unknown"}`, issue.html_url ? `URL: ${issue.html_url}` : undefined].filter(Boolean);
	if (includeBody && typeof issue.body === "string") lines.push(`Body: ${truncate(issue.body, 2_000)}`);
	return lines.join("\n");
}

function mutationSummary(mutation: GitHubIssueMutation, apply: boolean, result: any): string {
	const mode = apply ? "Applied" : "Dry run";
	if (mutation.op === "ensure_label") return `${mode}: ${result?.status === "existing" ? "label already existed" : "ensure label"} ${mutation.name}.`;
	if (mutation.op === "comment") return `${mode}: comment on #${mutation.number}.`;
	if (mutation.op === "claim_issue") return `${mode}: claim #${mutation.number} for the authenticated GitHub user and remove ready-for-agent.`;
	if (mutation.op === "close_issue") return `${mode}: close #${mutation.number}.`;
	const issue = result?.number ? ` #${result.number}${result.html_url ? ` (${result.html_url})` : ""}` : mutation.op === "create_issue" ? ` ${mutation.title}` : ` #${mutation.number}`;
	return `${mode}: ${mutation.op.replaceAll("_", " ")}${issue}.`;
}

function graphSummary(result: any): string {
	const issues = Array.isArray(result?.issues) ? result.issues : [];
	const shown = issues.slice(0, 10).map((issue: any) => `- #${issue.number} ${truncate(String(issue.title ?? "(untitled)"), 100)} — ${issue.state}, blockers ${issue.openBlockers}`).join("\n");
	return [`Parent: #${result?.parent ?? "?"}`, `Children: ${issues.length}`, `Frontier: ${(result?.frontier ?? []).map((number: number) => `#${number}`).join(", ") || "none"}`, shown, issues.length > 10 ? `… ${issues.length - 10} more child issues in artifact.` : undefined].filter(Boolean).join("\n");
}

function batchSummary(result: any): string {
	if (result?.phase === "cleanup") return result.dryRun ? "Dry run: cleanup will perform fresh live reconciliation and requires explicit apply approval." : "Cleanup completed after fresh live reconciliation.";
	if (result?.paused) return `Paused for GitHub rate limit during ${result.phase}; completed ${result.completed}. Retry after: ${result.retryAfter ?? "unknown"}.`;
	if (result?.phase) return `${result.phase}: processed ${Array.isArray(result.processed) ? result.processed.length : 0}; remaining ${result.remaining ?? 0}; next: ${result.nextOperation ?? "none"}.`;
	if (result?.dryRun) return `Dry run: ${result.issues ?? result.pending ?? 0} issues, ${result.relationships ?? 0} relationships.`;
	return "GitHub operation completed.";
}

function asMutation(value: any): GitHubIssueMutation {
	return value as GitHubIssueMutation;
}

export default function registerGitHubIssues(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "github_issue_inspect",
		label: "GitHub Issue Inspect",
		description: "Inspect one current-repository GitHub issue or find an issue by generated provenance marker.",
		promptSnippet: "Inspect GitHub issue details or a generated issue marker without mutating the tracker.",
		promptGuidelines: ["Use github_issue_inspect before mutating a generated issue plan or when verifying a source marker."],
		parameters: InspectParamsSchema,
		async execute(_id, params: { repo?: string; number?: number; marker?: string; include_body?: boolean }, signal, _update, ctx: ExtensionContext) {
			if ((params.number === undefined) === (params.marker === undefined)) throw new Error("Provide exactly one of number or marker.");
			const commandOptions = { signal };
			const repo = await currentRepo(ctx.cwd, params.repo, commandOptions);
			const result = params.number !== undefined
				? await ghJson(ctx.cwd, ["api", `repos/${repo}/issues/${issueNumber(params.number)}`], commandOptions)
				: await findByMarker(ctx.cwd, repo, nonEmpty(params.marker, "marker"), commandOptions);
			return await compactResponse(ctx.cwd, "inspect", issueSummary(result, params.include_body === true), result ?? { found: false, repo });
		},
	});

	pi.registerTool({
		name: "github_issue_mutate",
		label: "GitHub Issue Mutate",
		description: "Dry-run-first, typed GitHub label and issue mutations scoped to the current checkout repository.",
		promptSnippet: "Mutate current-repository GitHub labels or issues through typed dry-run-first operations.",
		promptGuidelines: ["Call with apply false first, review the result, then repeat with apply true only after approval.", "Never use this tool for a repository other than the current checkout."],
		parameters: MutateParamsSchema,
		async execute(_id, params: { repo?: string; apply?: boolean; mutation: any }, signal, _update, ctx: ExtensionContext) {
			const commandOptions = { signal };
			const repo = await currentRepo(ctx.cwd, params.repo, commandOptions);
			const mutation = asMutation(params.mutation);
			const result = await mutate(ctx.cwd, repo, mutation, params.apply === true, commandOptions);
			return await compactResponse(ctx.cwd, "mutate", mutationSummary(mutation, params.apply === true, result), { repo, apply: params.apply === true, mutation, result });
		},
	});

	pi.registerTool({
		name: "github_issue_relationship",
		label: "GitHub Issue Relationship",
		description: "Dry-run-first native GitHub sub-issue and blocker mutations scoped to the current checkout repository.",
		promptSnippet: "Create native GitHub sub-issue or blocker links using issue numbers; database IDs are resolved internally.",
		promptGuidelines: ["Call with apply false first, then apply true only after reviewing the relationship.", "Use native relationships rather than body-text conventions when the repository supports them."],
		parameters: RelationshipParamsSchema,
		async execute(_id, params: { repo?: string; apply?: boolean; op: "add_subissue" | "add_blocker"; parent?: number; child: number; blocker?: number }, signal, _update, ctx: ExtensionContext) {
			const commandOptions = { signal };
			const repo = await currentRepo(ctx.cwd, params.repo, commandOptions);
			const result = await publishRelationship(ctx.cwd, repo, params, params.apply === true, commandOptions);
			const relation = params.op === "add_subissue" ? `#${params.child} as sub-issue of #${params.parent}` : `#${params.blocker} blocks #${params.child}`;
			const status = (result as any)?.status === "existing" ? "already exists" : params.apply === true ? "applied" : "dry run";
			return await compactResponse(ctx.cwd, "relationship", `${status}: ${relation}.`, { repo, apply: params.apply === true, params, result });
		},
	});

	pi.registerTool({
		name: "github_issue_graph",
		label: "GitHub Issue Graph",
		description: "Inspect a parent issue's direct sub-issues and return the ready, unassigned, unblocked frontier.",
		promptSnippet: "Inspect a GitHub issue subtree and select ready-for-agent, unassigned issues with no open blockers.",
		promptGuidelines: ["Use github_issue_graph to choose manual implementation work from the GitHub frontier."],
		parameters: GraphParamsSchema,
		async execute(_id, params: { repo?: string; parent: number; ready_label?: string }, signal, _update, ctx: ExtensionContext) {
			const commandOptions = { signal };
			const repo = await currentRepo(ctx.cwd, params.repo, commandOptions);
			const result = await inspectGraph(ctx.cwd, repo, params.parent, params.ready_label ?? "ready-for-agent", commandOptions);
			return await compactResponse(ctx.cwd, "graph", graphSummary(result), result);
		},
	});

	pi.registerTool({
		name: "github_issue_migration",
		label: "GitHub Issue Migration",
		description: "Execute or explicitly clean up a validated tk-to-GitHub migration with fresh live reconciliation; dry-run by default.",
		promptSnippet: "Run a local migration manifest through dry-run, bounded issue batches, relationship batches, and reconciliation.",
		promptGuidelines: ["Keep migration artifacts under .pi/tmp/tk-to-github/.", "Run dry_run first, then use resume with apply true until it reports reconciliation.", "When paused for a rate limit, wait until retryAfter and run resume again; do not change cursors or recreate the plan.", "Use cleanup only after separate explicit user approval: dry-run it first, review, then apply; cleanup performs a fresh live reconciliation before removing .tickets/."],
		parameters: MigrationParamsSchema,
		async execute(_id, params: { repo?: string; apply?: boolean; operation: "dry_run" | "apply_issues" | "apply_relationships" | "reconcile" | "resume" | "cleanup"; manifest_path: string; issue_plan_path: string; cursor?: number; batch_size?: number; write_delay_ms?: number; cleanup_approved?: boolean }, signal, _update, ctx: ExtensionContext) {
			const repo = await currentRepo(ctx.cwd, params.repo, { signal });
			let result: unknown;
			if (params.operation === "cleanup") {
				if (params.apply !== true) result = { dryRun: true, phase: "cleanup", repo, note: "Apply only after explicit approval; apply performs a fresh live reconciliation before cleanup." };
				else {
					if (params.cleanup_approved !== true) throw new Error("Cleanup apply requires cleanup_approved=true after separate explicit user approval.");
					await completeMigrationCleanup(ctx.cwd, { approved: params.cleanup_approved, repo, manifestPath: params.manifest_path, issuePlanPath: params.issue_plan_path, commandOptions: { signal } });
					result = { phase: "cleanup", repo, removed: ".tickets", guidance: "docs/agents/issue-tracker.md" };
				}
			} else result = await executeMigration(ctx.cwd, repo, params as Parameters<typeof executeMigration>[2], { signal });
			return await compactResponse(ctx.cwd, "migration", batchSummary(result), { repo, operation: params.operation, apply: params.apply === true, result });
		},
	});

	pi.registerTool({
		name: "github_issue_plan",
		label: "GitHub Issue Plan",
		description: "Validate and publish a declarative GitHub issue graph with stable idempotency markers; dry-run by default.",
		promptSnippet: "Validate or publish a declarative GitHub issue plan with stable idempotency markers and dry-run first.",
		promptGuidelines: ["Validate the full plan with apply false before publishing.", "Use stable plan and issue keys so interrupted runs can resume without duplicate issues.", "Blocker edges are validated here; relationship publication is a separate operation."],
		parameters: PlanParamsSchema,
		async execute(_id, params: { repo?: string; apply?: boolean; plan: GitHubIssuePlan }, signal, _update, ctx: ExtensionContext) {
			const repo = await currentRepo(ctx.cwd, params.repo, { signal });
			const result = await publishPlan(ctx.cwd, repo, params.plan, params.apply === true, { signal });
			const issues = Array.isArray((result as any)?.issues) ? (result as any).issues : params.plan.issues;
			return await compactResponse(ctx.cwd, "plan", `${params.apply === true ? "Published" : "Dry run"} plan ${params.plan.key}: ${issues.length} issues.`, { repo, apply: params.apply === true, planKey: params.plan.key, result });
		},
	});
}
