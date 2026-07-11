import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

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
};

type GitHubIssueMutation =
	| { op: "ensure_label"; name: string; color?: string; description?: string }
	| { op: "create_issue"; title: string; body: string; labels?: string[] }
	| { op: "update_issue"; number: number; title?: string; body?: string; state?: "open" | "closed" }
	| { op: "comment"; number: number; body: string }
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
	operation: Type.Union([Type.Literal("dry_run"), Type.Literal("apply_issues"), Type.Literal("apply_relationships"), Type.Literal("reconcile"), Type.Literal("resume")]),
	manifest_path: Type.String({ description: "Repository-relative migration manifest under .pi/tmp/tk-to-github/." }),
	issue_plan_path: Type.String({ description: "Repository-relative issue plan under .pi/tmp/tk-to-github/." }),
	cursor: Type.Optional(Type.Number({ minimum: 0, description: "Zero-based batch offset. Defaults to zero." })),
	batch_size: Type.Optional(Type.Number({ minimum: 1, maximum: 50, description: "Maximum issues or relationships to process. Defaults to 10." })),
	write_delay_ms: Type.Optional(Type.Number({ minimum: 0, maximum: 10_000, description: "Delay between GitHub writes. Defaults to 750ms." })),
});

const GraphParamsSchema = Type.Object({
	repo: Type.Optional(Type.String({ description: "GitHub owner/repository. Defaults to the current checkout remote; any different repository is rejected." })),
	parent: Type.Number({ minimum: 1, description: "Parent issue whose direct sub-issues are inspected." }),
	ready_label: Type.Optional(Type.String({ description: "Label required for a frontier issue. Defaults to ready-for-agent." })),
});

function compactJson(value: unknown): string {
	return JSON.stringify(value, null, 2);
}

async function run(cwd: string, args: string[]): Promise<string> {
	return await new Promise((resolve, reject) => {
		const child = spawn("gh", args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
		child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0) resolve(stdout.trim());
			else reject(new Error((stderr || stdout || `gh ${args.join(" ")} failed`).trim()));
		});
	});
}

async function ghJson(cwd: string, args: string[]): Promise<any> {
	const output = await run(cwd, args);
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

async function currentRepo(cwd: string, requested?: string): Promise<string> {
	await run(cwd, ["auth", "status"]);
	const detected = await ghJson(cwd, ["repo", "view", "--json", "nameWithOwner"]);
	const repo = String(detected.nameWithOwner ?? "");
	if (!repo.includes("/")) throw new Error("Could not infer owner/repository from the current checkout.");
	if (requested && requested !== repo) {
		throw new Error(`Cross-repository mutation is blocked: current checkout is ${repo}, requested ${requested}.`);
	}
	return repo;
}

export function issueMarker(planKey: string, issueKey: string): string {
	if (!planKey.trim() || !issueKey.trim()) throw new Error("Plan and issue keys must be non-empty.");
	return `<!-- ${MARKER_PREFIX}:${planKey}/${issueKey} -->`;
}

export function bodyWithMarker(planKey: string, item: GitHubIssuePlanItem): string {
	return `${item.body.trim()}\n\n${issueMarker(planKey, item.key)}`;
}

export function migrationIssuePlan(planKey: string, records: MigrationRecord[]): GitHubIssuePlan {
	const migrated = new Set(records.filter((record) => record.disposition !== "omit").map((record) => record.sourceId));
	const plan = {
		key: planKey,
		issues: records
			.filter((record) => record.disposition !== "omit")
			.map((record) => ({
				key: record.sourceId,
				title: record.title,
				body: `${record.body.trim()}\n\n## Migration provenance\n\nMigrated from tk ticket \`${record.sourceId}\`.`,
				labels: record.labels ?? [],
				blockedBy: (record.blockedBy ?? []).filter((id) => migrated.has(id)),
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
}

async function findByMarker(cwd: string, repo: string, marker: string): Promise<any | undefined> {
	const query = `repo:${repo} is:issue in:body "${marker}"`;
	const search = await ghJson(cwd, ["api", "--method", "GET", "search/issues", "-f", `q=${query}`, "-f", "per_page=100"]);
	const matches = (search.items ?? []).filter((item: any) => typeof item.body === "string" && item.body.includes(marker));
	if (matches.length > 1) throw new Error(`Idempotency marker ${marker} matches multiple GitHub issues.`);
	return matches[0];
}

async function mutate(cwd: string, repo: string, mutation: GitHubIssueMutation, apply: boolean): Promise<unknown> {
	const dryRun = { dryRun: true, repo, mutation };
	if (!apply) return dryRun;

	switch (mutation.op) {
		case "ensure_label": {
			const name = nonEmpty(mutation.name, "name");
			const payload = { name, color: normalizedColor(mutation.color), description: mutation.description ?? "" };
			try {
				await ghJson(cwd, ["api", `repos/${repo}/labels/${encodeURIComponent(name)}`]);
				return await ghJsonWithInput(cwd, ["api", "--method", "PATCH", `repos/${repo}/labels/${encodeURIComponent(name)}`], payload);
			} catch (error) {
				if (!String(error).includes("404")) throw error;
				return await ghJsonWithInput(cwd, ["api", "--method", "POST", `repos/${repo}/labels`], payload);
			}
		}
		case "create_issue": {
			const payload = { title: nonEmpty(mutation.title, "title"), body: mutation.body ?? "", labels: mutation.labels ?? [] };
			return await ghJsonWithInput(cwd, ["api", "--method", "POST", `repos/${repo}/issues`], payload);
		}
		case "update_issue": {
			const payload = Object.fromEntries(Object.entries({ title: mutation.title, body: mutation.body, state: mutation.state }).filter(([, value]) => value !== undefined));
			if (Object.keys(payload).length === 0) throw new Error("update_issue requires title, body, or state.");
			return await ghJsonWithInput(cwd, ["api", "--method", "PATCH", `repos/${repo}/issues/${issueNumber(mutation.number)}`], payload);
		}
		case "comment":
			return await ghJsonWithInput(cwd, ["api", "--method", "POST", `repos/${repo}/issues/${issueNumber(mutation.number)}/comments`], { body: nonEmpty(mutation.body, "body") });
		case "close_issue": {
			const closed = await ghJsonWithInput(cwd, ["api", "--method", "PATCH", `repos/${repo}/issues/${issueNumber(mutation.number)}`], { state: "closed" });
			if (mutation.comment?.trim()) await ghJsonWithInput(cwd, ["api", "--method", "POST", `repos/${repo}/issues/${issueNumber(mutation.number)}/comments`], { body: mutation.comment });
			return closed;
		}
	}
}

async function ghJsonWithInput(cwd: string, args: string[], payload: unknown): Promise<any> {
	return await new Promise((resolve, reject) => {
		const child = spawn("gh", [...args, "--input", "-"], { cwd, shell: false, stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
		child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
		child.on("error", reject);
		child.on("close", (code) => {
			if (code !== 0) return reject(new Error((stderr || stdout || `gh ${args.join(" ")} failed`).trim()));
			try { resolve(JSON.parse(stdout)); } catch { reject(new Error(`GitHub CLI returned invalid JSON: ${stdout.slice(0, 500)}`)); }
		});
		child.stdin.end(JSON.stringify(payload));
	});
}

async function publishPlan(cwd: string, repo: string, plan: GitHubIssuePlan, apply: boolean): Promise<unknown> {
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
		const existing = await findByMarker(cwd, repo, marker);
		if (existing) {
			results.push({ key: item.key, number: existing.number, url: existing.html_url, status: "existing" });
			continue;
		}
		const created = await ghJsonWithInput(cwd, ["api", "--method", "POST", `repos/${repo}/issues`], {
			title: item.title,
			body: bodyWithMarker(plan.key, item),
			labels: item.labels ?? [],
		});
		if (item.state === "closed") await ghJsonWithInput(cwd, ["api", "--method", "PATCH", `repos/${repo}/issues/${created.number}`], { state: "closed" });
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

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function migrationArtifactPath(cwd: string, input: string): string {
	if (path.isAbsolute(input)) throw new Error("Migration artifact paths must be repository-relative.");
	const root = path.resolve(cwd, ".pi/tmp/tk-to-github");
	const resolved = path.resolve(cwd, input);
	if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error("Migration artifacts must stay under .pi/tmp/tk-to-github/.");
	return resolved;
}

async function readMigrationPlan(cwd: string, manifestPath: string, issuePlanPath: string): Promise<{ plan: GitHubIssuePlan; outcomePath: string }> {
	const manifest = JSON.parse(await readFile(migrationArtifactPath(cwd, manifestPath), "utf8"));
	if (!manifest || typeof manifest !== "object") throw new Error("Migration manifest must be a JSON object.");
	const plan = JSON.parse(await readFile(migrationArtifactPath(cwd, issuePlanPath), "utf8")) as GitHubIssuePlan;
	validateIssuePlan(plan);
	return { plan, outcomePath: path.join(path.dirname(migrationArtifactPath(cwd, manifestPath)), "github-migration-outcomes.json") };
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

async function rateLimitPause(cwd: string, repo: string, phase: string, completed: number, outcomePath: string, error: unknown): Promise<unknown> {
	let retryAfter: string | undefined;
	try {
		const rate = await ghJson(cwd, ["api", "rate_limit"]);
		const reset = rate.resources?.core?.reset;
		if (typeof reset === "number") retryAfter = new Date(reset * 1000).toISOString();
	} catch { /* secondary limits may also block this read */ }
	return { paused: true, reason: "github-rate-limit", repo, phase, completed, retryAfter, outcomePath: path.relative(cwd, outcomePath), error: String(error) };
}

async function executeMigration(cwd: string, repo: string, params: { operation: "dry_run" | "apply_issues" | "apply_relationships" | "reconcile" | "resume"; manifest_path: string; issue_plan_path: string; cursor?: number; batch_size?: number; write_delay_ms?: number; apply?: boolean }): Promise<unknown> {
	const { plan, outcomePath } = await readMigrationPlan(cwd, params.manifest_path, params.issue_plan_path);
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
					await mutate(cwd, repo, { op: "ensure_label", name: label }, true);
					if (delay) await sleep(delay);
				}
				outcome.labelsInitialized = true;
				await writeOutcome(outcomePath, outcome);
			}
			for (const item of batch) {
				const existing = await findByMarker(cwd, repo, issueMarker(plan.key, item.key));
				const issue = existing ?? await ghJsonWithInput(cwd, ["api", "--method", "POST", `repos/${repo}/issues`], { title: item.title, body: bodyWithMarker(plan.key, item), labels: item.labels ?? [] });
				if (item.state === "closed" && issue.state !== "closed") await ghJsonWithInput(cwd, ["api", "--method", "PATCH", `repos/${repo}/issues/${issue.number}`], { state: "closed" });
				outcome.issues[item.key] = { number: issue.number, url: issue.html_url };
				await writeOutcome(outcomePath, outcome);
				if (delay) await sleep(delay);
			}
		} catch (error) {
			if (isRateLimited(error)) return await rateLimitPause(cwd, repo, "issues", Object.keys(outcome.issues).length, outcomePath, error);
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
				await publishRelationship(cwd, repo, edge.kind === "subissue" ? { op: "add_subissue", parent: other, child } : { op: "add_blocker", child, blocker: other }, true);
				outcome.relationships[`${edge.kind}:${edge.child}:${edge.other}`] = true;
				await writeOutcome(outcomePath, outcome);
				if (delay) await sleep(delay);
			}
		} catch (error) {
			if (isRateLimited(error)) return await rateLimitPause(cwd, repo, "relationships", Object.keys(outcome.relationships).length, outcomePath, error);
			throw error;
		}
		return { phase: "relationships", processed: batch, remaining: edges.length - Object.keys(outcome.relationships).length, nextOperation: Object.keys(outcome.relationships).length < edges.length ? "apply_relationships" : "reconcile", outcomePath: path.relative(cwd, outcomePath) };
	}
	const mismatches: string[] = [];
	for (const item of plan.issues) {
		const expected = outcome.issues[item.key];
		const found = expected ? await findByMarker(cwd, repo, issueMarker(plan.key, item.key)) : undefined;
		if (!expected || !found || expected.number !== found.number) mismatches.push(`${item.key}: missing or mismatched provenance marker`);
		else if (found.state !== (item.state ?? "open")) mismatches.push(`${item.key}: expected ${item.state ?? "open"}, found ${found.state}`);
	}
	if (pendingEdges.length > 0) mismatches.push(`${pendingEdges.length} relationship(s) remain unpublished`);
	return { phase: "reconcile", repo, planKey: plan.key, passed: mismatches.length === 0, mismatches, outcomePath: path.relative(cwd, outcomePath) };
}

async function issueDatabaseId(cwd: string, repo: string, number: number): Promise<number> {
	const issue = await ghJson(cwd, ["api", `repos/${repo}/issues/${issueNumber(number)}`]);
	if (!Number.isInteger(issue.id)) throw new Error(`GitHub issue #${number} did not provide a REST database ID.`);
	return issue.id;
}

async function publishRelationship(cwd: string, repo: string, params: { op: "add_subissue" | "add_blocker"; parent?: number; child: number; blocker?: number }, apply: boolean): Promise<unknown> {
	if (params.op === "add_subissue") {
		const parent = issueNumber(params.parent);
		const child = issueNumber(params.child);
		const childId = await issueDatabaseId(cwd, repo, child);
		if (!apply) return { dryRun: true, repo, op: params.op, parent, child, childDatabaseId: childId };
		const existing = await ghJson(cwd, ["api", `repos/${repo}/issues/${parent}/sub_issues`]);
		if ((existing ?? []).some((issue: any) => issue.id === childId)) return { repo, op: params.op, parent, child, status: "existing" };
		return await ghJsonWithInput(cwd, ["api", "--method", "POST", `repos/${repo}/issues/${parent}/sub_issues`], { sub_issue_id: childId });
	}
	const child = issueNumber(params.child);
	const blocker = issueNumber(params.blocker);
	const blockerId = await issueDatabaseId(cwd, repo, blocker);
	if (!apply) return { dryRun: true, repo, op: params.op, child, blocker, blockerDatabaseId: blockerId };
	const existing = await ghJson(cwd, ["api", `repos/${repo}/issues/${child}/dependencies/blocked_by`]);
	if ((existing ?? []).some((issue: any) => issue.id === blockerId)) return { repo, op: params.op, child, blocker, status: "existing" };
	return await ghJsonWithInput(cwd, ["api", "--method", "POST", `repos/${repo}/issues/${child}/dependencies/blocked_by`], { issue_id: blockerId });
}

export function frontierIssueNumbers(issues: Array<{ number: number; state: string; labels?: Array<{ name?: string }>; assignee?: unknown; issue_dependencies_summary?: { blocked_by?: number } }>, readyLabel = "ready-for-agent"): number[] {
	return issues
		.filter((issue) => issue.state === "open")
		.filter((issue) => (issue.labels ?? []).some((label) => label.name === readyLabel))
		.filter((issue) => !issue.assignee)
		.filter((issue) => (issue.issue_dependencies_summary?.blocked_by ?? 0) === 0)
		.map((issue) => issue.number);
}

async function inspectGraph(cwd: string, repo: string, parent: number, readyLabel: string): Promise<unknown> {
	const children = await ghJson(cwd, ["api", `repos/${repo}/issues/${issueNumber(parent)}/sub_issues`]);
	const issues = await Promise.all((children as any[]).map(async (child) => await ghJson(cwd, ["api", `repos/${repo}/issues/${child.number}`])));
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
		async execute(_id, params: { repo?: string; number?: number; marker?: string; include_body?: boolean }, _signal, _update, ctx: ExtensionContext) {
			if ((params.number === undefined) === (params.marker === undefined)) throw new Error("Provide exactly one of number or marker.");
			const repo = await currentRepo(ctx.cwd, params.repo);
			const result = params.number !== undefined
				? await ghJson(ctx.cwd, ["api", `repos/${repo}/issues/${issueNumber(params.number)}`])
				: await findByMarker(ctx.cwd, repo, nonEmpty(params.marker, "marker"));
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
		async execute(_id, params: { repo?: string; apply?: boolean; mutation: any }, _signal, _update, ctx: ExtensionContext) {
			const repo = await currentRepo(ctx.cwd, params.repo);
			const mutation = asMutation(params.mutation);
			const result = await mutate(ctx.cwd, repo, mutation, params.apply === true);
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
		async execute(_id, params: { repo?: string; apply?: boolean; op: "add_subissue" | "add_blocker"; parent?: number; child: number; blocker?: number }, _signal, _update, ctx: ExtensionContext) {
			const repo = await currentRepo(ctx.cwd, params.repo);
			const result = await publishRelationship(ctx.cwd, repo, params, params.apply === true);
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
		async execute(_id, params: { repo?: string; parent: number; ready_label?: string }, _signal, _update, ctx: ExtensionContext) {
			const repo = await currentRepo(ctx.cwd, params.repo);
			const result = await inspectGraph(ctx.cwd, repo, params.parent, params.ready_label ?? "ready-for-agent");
			return await compactResponse(ctx.cwd, "graph", graphSummary(result), result);
		},
	});

	pi.registerTool({
		name: "github_issue_migration",
		label: "GitHub Issue Migration",
		description: "Execute a validated local tk-to-GitHub manifest in resumable bounded issue and relationship batches; dry-run by default.",
		promptSnippet: "Run a local migration manifest through dry-run, bounded issue batches, relationship batches, and reconciliation.",
		promptGuidelines: ["Keep migration artifacts under .pi/tmp/tk-to-github/.", "Run dry_run first, then use resume with apply true until it reports reconciliation.", "When paused for a rate limit, wait until retryAfter and run resume again; do not change cursors or recreate the plan.", "Never remove .tickets/ with this tool; cleanup requires a separate explicit user approval."],
		parameters: MigrationParamsSchema,
		async execute(_id, params: { repo?: string; apply?: boolean; operation: "dry_run" | "apply_issues" | "apply_relationships" | "reconcile" | "resume"; manifest_path: string; issue_plan_path: string; cursor?: number; batch_size?: number; write_delay_ms?: number }, _signal, _update, ctx: ExtensionContext) {
			const repo = await currentRepo(ctx.cwd, params.repo);
			const result = await executeMigration(ctx.cwd, repo, params);
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
		async execute(_id, params: { repo?: string; apply?: boolean; plan: GitHubIssuePlan }, _signal, _update, ctx: ExtensionContext) {
			const repo = await currentRepo(ctx.cwd, params.repo);
			const result = await publishPlan(ctx.cwd, repo, params.plan, params.apply === true);
			const issues = Array.isArray((result as any)?.issues) ? (result as any).issues : params.plan.issues;
			return await compactResponse(ctx.cwd, "plan", `${params.apply === true ? "Published" : "Dry run"} plan ${params.plan.key}: ${issues.length} issues.`, { repo, apply: params.apply === true, planKey: params.plan.key, result });
		},
	});
}
