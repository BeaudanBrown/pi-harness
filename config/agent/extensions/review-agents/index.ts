import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	createExtensionRuntime,
	SessionManager,
	SettingsManager,
	type ExtensionAPI,
	type ExtensionContext,
	type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { resolveAgentProfile } from "../agent-profiles/core.js";
import {
	buildReviewPrompt,
	DEFAULT_REVIEW_MODEL,
	parseReviewModelRef,
	REVIEW_THINKING_LEVEL,
	runReviewTasks,
	validateReviewRequest,
	type ReviewContext,
	type ReviewTask,
} from "./core.js";
const REVIEW_ROOT = ".pi/tmp/reviews";
const MAX_RESULT_BYTES = 24_000;

const ReviewTaskSchema = Type.Object({
	axis: StringEnum(["standards", "spec"] as const, {
		description: "Independent review axis.",
	}),
	instructions: Type.String({
		description: "Complete axis-specific review brief, including standards or spec sources and the requested output format.",
	}),
});

const ReviewAgentsParams = Type.Object({
	fixed_point: Type.String({
		description: "Commit, branch, or tag used as the merge-base comparison point against HEAD.",
	}),
	tasks: Type.Array(ReviewTaskSchema, {
		description: "One or two independent Standards and Spec review tasks. Two tasks run concurrently.",
		minItems: 1,
		maxItems: 2,
	}),
});

type ReviewAgentsParamsType = {
	fixed_point: string;
	tasks: ReviewTask[];
};

type ReviewResult = {
	axis: ReviewTask["axis"];
	text: string;
};

function createReviewResourceLoader(): ResourceLoader {
	const profile = resolveAgentProfile("review-worker");
	return {
		getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => profile.systemPrompt,
		getSystemPromptSource: () => undefined,
		getAppendSystemPrompt: () => [],
		getAppendSystemPromptSources: () => [],
		extendResources: () => {},
		reload: async () => {},
	};
}

function extractAssistantText(session: { messages: unknown[] }): string {
	for (let i = session.messages.length - 1; i >= 0; i--) {
		const message = session.messages[i] as any;
		if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
		const parts = message.content
			.map((part: any) => {
				if (typeof part === "string") return part;
				if (part?.type === "text" && typeof part.text === "string") return part.text;
				return undefined;
			})
			.filter((part: string | undefined): part is string => Boolean(part));
		if (parts.length > 0) return parts.join("\n").trim();
	}
	return "";
}

function truncateResult(value: string): string {
	const bytes = Buffer.byteLength(value, "utf8");
	if (bytes <= MAX_RESULT_BYTES) return value;
	const content = Buffer.from(value, "utf8").subarray(0, MAX_RESULT_BYTES).toString("utf8");
	return `${content}\n\n[Review output truncated: ${bytes - MAX_RESULT_BYTES} bytes omitted.]`;
}

function selectReviewModel(ctx: ExtensionContext) {
	const modelRef = process.env.PI_HARNESS_REVIEW_MODEL?.trim() || DEFAULT_REVIEW_MODEL;
	const parsed = parseReviewModelRef(modelRef);
	if (!parsed) throw new Error(`Invalid review model ${JSON.stringify(modelRef)}; expected provider/model.`);

	const model = ctx.modelRegistry.find(parsed.provider, parsed.id);
	if (!model) throw new Error(`Review model ${modelRef} is not registered.`);
	if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
		throw new Error(`Review model ${modelRef} has no configured authentication.`);
	}
	return model;
}

async function captureReviewContext(pi: ExtensionAPI, cwd: string, fixedPoint: string): Promise<ReviewContext> {
	const git = async (args: string[]) => {
		const result = await pi.exec("git", ["-c", "core.pager=cat", ...args], { cwd, timeout: 30_000 });
		if (result.code !== 0) {
			throw new Error(result.stderr.trim() || `git ${args[0] ?? "command"} failed with exit code ${result.code}`);
		}
		return result.stdout;
	};

	const resolvedFixedPoint = (await git(["rev-parse", "--verify", `${fixedPoint}^{commit}`])).trim();
	const comparison = `${fixedPoint}...HEAD`;
	const [diff, commits, changedFilesText] = await Promise.all([
		git(["diff", "--no-ext-diff", "--no-textconv", comparison, "--"]),
		git(["log", "--format=%h %s", `${fixedPoint}..HEAD`, "--"]),
		git(["diff", "--name-only", comparison, "--"]),
	]);
	if (!diff.trim()) throw new Error(`review_agents found no diff for ${comparison}.`);

	const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${resolvedFixedPoint.slice(0, 12)}`;
	const reviewDir = path.resolve(cwd, REVIEW_ROOT, id);
	await mkdir(reviewDir, { recursive: true });
	const diffAbsolutePath = path.join(reviewDir, "diff.patch");
	const commitsAbsolutePath = path.join(reviewDir, "commits.txt");
	await Promise.all([
		writeFile(diffAbsolutePath, diff, "utf8"),
		writeFile(commitsAbsolutePath, commits || "(no commits)\n", "utf8"),
	]);

	return {
		fixedPoint,
		resolvedFixedPoint,
		diffPath: path.relative(cwd, diffAbsolutePath),
		commitsPath: path.relative(cwd, commitsAbsolutePath),
		changedFiles: changedFilesText.split("\n").map((file) => file.trim()).filter(Boolean),
	};
}

async function askReviewer(
	ctx: ExtensionContext,
	model: NonNullable<ExtensionContext["model"]>,
	task: ReviewTask,
	reviewContext: ReviewContext,
	signal: AbortSignal | undefined,
): Promise<ReviewResult> {
	const { session } = await createAgentSession({
		cwd: ctx.cwd,
		model,
		thinkingLevel: REVIEW_THINKING_LEVEL,
		tools: resolveAgentProfile("review-worker").tools,
		sessionManager: SessionManager.inMemory(ctx.cwd),
		settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
		resourceLoader: createReviewResourceLoader(),
	});

	const abortReviewer = () => void session.abort();
	signal?.addEventListener("abort", abortReviewer, { once: true });
	try {
		await session.prompt(buildReviewPrompt(task, reviewContext));
		const text = extractAssistantText(session).trim();
		if (!text) throw new Error(`${task.axis} reviewer returned no text.`);
		return { axis: task.axis, text: truncateResult(text) };
	} finally {
		signal?.removeEventListener("abort", abortReviewer);
		session.dispose();
	}
}

export default function reviewAgentsExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "review_agents",
		label: "Review Agents",
		description: "Run one or two isolated read-only code-review agents against one pinned Git diff. Parallel tasks use the dedicated review model.",
		promptSnippet: "Delegate Standards and Spec code-review axes to isolated read-only review agents using review_agents.",
		promptGuidelines: [
			"Use review_agents for subjective code review instead of run_worker.",
			"Call review_agents once with both Standards and Spec tasks when both axes are available so they run concurrently against the same pinned diff.",
		],
		parameters: ReviewAgentsParams,
		executionMode: "parallel",
		async execute(_toolCallId, params: ReviewAgentsParamsType, signal, onUpdate, ctx) {
			if (process.env.PI_AGENTGRAPH_MODE === "1") {
				throw new Error("review_agents is disabled in AgentGraph restricted mode because its model runs are outside graph provenance.");
			}
			validateReviewRequest(params.fixed_point, params.tasks);
			const model = selectReviewModel(ctx);
			const modelRef = `${model.provider}/${model.id}`;

			onUpdate?.({ content: [{ type: "text", text: `Capturing review context for ${params.fixed_point}...` }], details: {} });
			const reviewContext = await captureReviewContext(pi, ctx.cwd, params.fixed_point);
			let completed = 0;
			const results = await runReviewTasks(params.tasks, async (task) => {
				const result = await askReviewer(ctx, model, task, reviewContext, signal);
				completed += 1;
				onUpdate?.({
					content: [{ type: "text", text: `Review agents: ${completed}/${params.tasks.length} complete` }],
					details: { model: modelRef, completed, total: params.tasks.length },
				});
				return result;
			});

			const text = [
				`review_model: ${modelRef}`,
				`thinking_level: ${REVIEW_THINKING_LEVEL}`,
				`diff: ${reviewContext.diffPath}`,
				`commits: ${reviewContext.commitsPath}`,
				"",
				...results.flatMap((result) => [`## ${result.axis === "standards" ? "Standards" : "Spec"}`, "", result.text, ""]),
			].join("\n").trim();

			return {
				content: [{ type: "text", text }],
				details: {
					model: modelRef,
					thinking_level: REVIEW_THINKING_LEVEL,
					fixed_point: reviewContext.resolvedFixedPoint,
					diff: reviewContext.diffPath,
					commits: reviewContext.commitsPath,
					axes: results.map((result) => result.axis),
				},
			};
		},
	});
}
