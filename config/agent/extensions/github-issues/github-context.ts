export type GitHubJsonClient = (endpoint: string) => Promise<unknown>;

export type IssueState = "open" | "closed";

export type IssueContainer = {
	number: number;
	title: string;
	state: IssueState;
};

export type IssueBlocker = IssueContainer;

export type IssueHandoff = {
	id: number;
	author: string | null;
	body: string;
	createdAt: string;
	url: string | null;
};

export type EpicIssueContext = {
	number: number;
	title: string;
	body: string;
	state: IssueState;
	labels: string[];
	assignee: string | null;
	parent: IssueContainer | null;
	container: IssueContainer;
	children: number[];
	blockers: IssueBlocker[];
	recentHandoffs: IssueHandoff[];
};

export type GitHubEpicContext = {
	epic: IssueContainer;
	issues: EpicIssueContext[];
	executableLeaves: number[];
};

export type GitHubEpicContextOptions = {
	commentLimit?: number;
	commentBodyLimit?: number;
};

const MAX_COMMENT_LIMIT = 20;

function asRecord(value: unknown, context: string): Record<string, any> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${context} returned invalid GitHub JSON.`);
	return value as Record<string, any>;
}

function asArray(value: unknown, context: string): any[] {
	if (!Array.isArray(value)) throw new Error(`${context} returned invalid GitHub JSON.`);
	return value;
}

function positiveInteger(value: unknown, context: string): number {
	if (!Number.isInteger(value) || Number(value) < 1) throw new Error(`${context} did not contain a positive issue number.`);
	return Number(value);
}

function issueState(value: unknown): IssueState {
	return value === "closed" ? "closed" : "open";
}

function container(issue: Record<string, any>): IssueContainer {
	return {
		number: positiveInteger(issue.number, "Issue"),
		title: String(issue.title ?? ""),
		state: issueState(issue.state),
	};
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number, field: string): number {
	const result = value ?? fallback;
	if (!Number.isInteger(result) || result < minimum || result > maximum) {
		throw new Error(`${field} must be an integer between ${minimum} and ${maximum}.`);
	}
	return result;
}

function truncate(value: string, limit: number): string {
	return value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 1))}…`;
}

async function paginated(client: GitHubJsonClient, endpoint: string, context: string): Promise<any[]> {
	const items: any[] = [];
	for (let page = 1; ; page += 1) {
		const separator = endpoint.includes("?") ? "&" : "?";
		const batch = asArray(await client(`${endpoint}${separator}per_page=100&page=${page}`), context);
		items.push(...batch);
		if (batch.length < 100) return items;
	}
}

async function recentHandoffs(
	client: GitHubJsonClient,
	issue: Record<string, any>,
	commentLimit: number,
	commentBodyLimit: number,
): Promise<IssueHandoff[]> {
	if (commentLimit === 0 || Number(issue.comments ?? 0) === 0) return [];
	const total = Math.max(0, Number(issue.comments ?? 0));
	const lastPage = Math.max(1, Math.ceil(total / commentLimit));
	const number = positiveInteger(issue.number, "Issue");
	const lastComments = asArray(
		await client(`issues/${number}/comments?per_page=${commentLimit}&page=${lastPage}`),
		`Comments for #${number}`,
	);
	const previousComments = lastComments.length < commentLimit && lastPage > 1
		? asArray(
			await client(`issues/${number}/comments?per_page=${commentLimit}&page=${lastPage - 1}`),
			`Comments for #${number}`,
		)
		: [];
	return [...previousComments, ...lastComments].slice(-commentLimit).map((comment) => ({
		id: Number(comment.id ?? 0),
		author: typeof comment.user?.login === "string" ? comment.user.login : null,
		body: truncate(String(comment.body ?? ""), commentBodyLimit),
		createdAt: String(comment.created_at ?? ""),
		url: typeof comment.html_url === "string" ? comment.html_url : null,
	}));
}

/**
 * Build the read-only, normalized GitHub context consumed by the aloop supervisor.
 * The client must be bound to the current checkout repository by the caller.
 */
export async function retrieveGitHubEpicContext(
	client: GitHubJsonClient,
	epicNumber: number,
	options: GitHubEpicContextOptions = {},
): Promise<GitHubEpicContext> {
	positiveInteger(epicNumber, "Epic");
	const commentLimit = boundedInteger(options.commentLimit, 5, 0, MAX_COMMENT_LIMIT, "commentLimit");
	const commentBodyLimit = boundedInteger(options.commentBodyLimit, 2_000, 1, 20_000, "commentBodyLimit");
	const root = asRecord(await client(`issues/${epicNumber}`), `Issue #${epicNumber}`);
	const epic = container(root);
	const normalized: EpicIssueContext[] = [];
	const visited = new Set<number>();

	const visit = async (rawIssue: Record<string, any>, parent: IssueContainer | null): Promise<void> => {
		const number = positiveInteger(rawIssue.number, "Issue");
		if (visited.has(number)) throw new Error(`GitHub sub-issue graph contains duplicate or cyclic issue #${number}.`);
		visited.add(number);

		const childSummaries = (await paginated(client, `issues/${number}/sub_issues`, `Sub-issues for #${number}`))
			.sort((left, right) => Number(left.number) - Number(right.number));
		const rawBlockers = await paginated(client, `issues/${number}/dependencies/blocked_by`, `Blockers for #${number}`);
		const blockers = rawBlockers.map((blocker) => container(asRecord(blocker, `Blocker for #${number}`)))
			.sort((left, right) => left.number - right.number);

		normalized.push({
			number,
			title: String(rawIssue.title ?? ""),
			body: String(rawIssue.body ?? ""),
			state: issueState(rawIssue.state),
			labels: asArray(rawIssue.labels ?? [], `Labels for #${number}`).map((label) => String(label?.name ?? "")).filter(Boolean),
			assignee: typeof rawIssue.assignee?.login === "string" ? rawIssue.assignee.login : null,
			parent,
			container: epic,
			children: childSummaries.map((child) => positiveInteger(child.number, `Sub-issue of #${number}`)),
			blockers,
			recentHandoffs: await recentHandoffs(client, rawIssue, commentLimit, commentBodyLimit),
		});

		const current = container(rawIssue);
		for (const childSummary of childSummaries) {
			const childNumber = positiveInteger(childSummary.number, `Sub-issue of #${number}`);
			const child = asRecord(await client(`issues/${childNumber}`), `Issue #${childNumber}`);
			await visit(child, current);
		}
	};

	await visit(root, null);
	normalized.sort((left, right) => left.number - right.number);
	const executableLeaves = normalized
		.filter((issue) => issue.number !== epic.number)
		.filter((issue) => issue.state === "open" && issue.children.length === 0)
		.filter((issue) => !issue.blockers.some((blocker) => blocker.state === "open"))
		.map((issue) => issue.number);

	return { epic, issues: normalized, executableLeaves };
}
