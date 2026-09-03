import { mkdir, readFile } from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { deterministicCommandSummary, runDurableCommand, writeDurableResult } from "../worker-runner/command-execution.js";

type Command = { argv: string[]; timeoutMs: number };

function requiredPath(name: string): string {
	const value = process.env[name]?.trim();
	if (!value || !path.isAbsolute(value)) throw new Error(`${name} must be an absolute path.`);
	return value;
}

async function readJson(pathname: string): Promise<unknown> {
	return JSON.parse(await readFile(pathname, "utf8"));
}

function feedbackCommand(): Command {
	const raw = process.env.PI_ALOOP_WORKER_FEEDBACK_COMMAND;
	if (!raw) throw new Error("This aloop run has no worker feedback command.");
	const value = JSON.parse(raw) as Partial<Command>;
	if (!Array.isArray(value.argv) || value.argv.length === 0 || value.argv.some((part) => typeof part !== "string" || !part)) {
		throw new Error("The startup worker feedback command is invalid.");
	}
	if (!Number.isSafeInteger(value.timeoutMs) || Number(value.timeoutMs) < 1) throw new Error("The startup worker feedback timeout is invalid.");
	return { argv: value.argv, timeoutMs: Number(value.timeoutMs) };
}

const ResultParams = Type.Object({
	status: Type.Union([
		Type.Literal("candidate-complete"),
		Type.Literal("already-satisfied"),
		Type.Literal("incomplete"),
		Type.Literal("decision-required"),
		Type.Literal("environment-blocked"),
	]),
	summary: Type.String({ minLength: 1 }),
	verification: Type.Array(Type.String()),
	acceptanceCriteria: Type.Array(Type.Object({
		criterion: Type.String({ minLength: 1 }),
		satisfied: Type.Boolean(),
		evidence: Type.String(),
	})),
	discoveredWork: Type.Array(Type.String()),
	nextAction: Type.String({ minLength: 1 }),
});

export default function registerAloopWorkerRuntime(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "aloop_issue_context",
		label: "Aloop Issue Context",
		description: "Read the immutable startup snapshot for this epic and selected child issue.",
		promptSnippet: "Call aloop_issue_context before implementation to inspect the authoritative startup snapshot",
		promptGuidelines: ["Use the selected child in aloop_issue_context as the strict implementation boundary."],
		parameters: Type.Object({}),
		async execute() {
			const context = await readJson(requiredPath("PI_ALOOP_ISSUE_CONTEXT_PATH"));
			return { content: [{ type: "text", text: JSON.stringify(context, null, 2) }], details: context };
		},
	});

	pi.registerTool({
		name: "aloop_worker_feedback",
		label: "Aloop Worker Feedback",
		description: "Run the optional advisory worker feedback command from the startup policy snapshot.",
		promptSnippet: "Use aloop_worker_feedback for project-owned advisory feedback; it is not canonical acceptance",
		promptGuidelines: ["Treat worker feedback as advisory. Do not run canonical or production acceptance commands."],
		parameters: Type.Object({}),
		async execute(_id, _params, signal) {
			const command = feedbackCommand();
			const root = path.join(requiredPath("PI_ALOOP_ATTEMPT_DIRECTORY"), "worker-feedback");
			await mkdir(root, { recursive: true, mode: 0o700 });
			const id = `${Date.now()}-${process.pid}`;
			const result = await runDurableCommand({
				cwd: process.cwd(), command: command.argv, timeoutMs: command.timeoutMs, signal,
				logPath: path.join(root, `${id}.log`), resultPath: path.join(root, `${id}.json`),
			});
			return {
				content: [{ type: "text", text: deterministicCommandSummary("Worker feedback", result) }],
				details: { result, advisory: true },
			};
		},
	});

	pi.registerTool({
		name: "aloop_submit_result",
		label: "Submit Aloop Result",
		description: "Persist the implementation attempt outcome and terminate this worker turn.",
		promptSnippet: "Finish every attempt with aloop_submit_result; do not emit final-message JSON",
		promptGuidelines: ["Call aloop_submit_result exactly once as the final action, including for ambiguity or environment blockers."],
		parameters: ResultParams,
		async execute(_id, params) {
			const result = { version: 1, submittedAt: new Date().toISOString(), ...params };
			await writeDurableResult(requiredPath("PI_ALOOP_SUBMISSION_PATH"), result);
			return { content: [{ type: "text", text: `Submitted ${params.status} aloop result.` }], details: result, terminate: true };
		},
	});
}
