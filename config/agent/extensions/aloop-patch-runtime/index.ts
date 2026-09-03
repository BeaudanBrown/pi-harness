import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { writeDurableResult } from "../worker-runner/command-execution.js";

function submissionPath(): string {
	const value = process.env.PI_ALOOP_SUBMISSION_PATH?.trim();
	if (!value || !path.isAbsolute(value)) throw new Error("PI_ALOOP_SUBMISSION_PATH must be an absolute path.");
	return value;
}

export default function registerAloopPatchRuntime(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "aloop_submit_patch_result",
		label: "Submit Aloop Patch Result",
		description: "Persist the targeted patch outcome and terminate this patch-worker turn.",
		promptSnippet: "Finish the targeted correction with aloop_submit_patch_result",
		promptGuidelines: ["Call aloop_submit_patch_result exactly once as the final action. Do not emit final-message JSON."],
		parameters: Type.Object({
			status: Type.Union([Type.Literal("patched"), Type.Literal("no-change"), Type.Literal("incomplete"), Type.Literal("environment-blocked")]),
			summary: Type.String({ minLength: 1 }),
			verification: Type.Array(Type.String()),
			nextAction: Type.String({ minLength: 1 }),
		}),
		async execute(_id, params) {
			const result = { version: 1, submittedAt: new Date().toISOString(), ...params };
			await writeDurableResult(submissionPath(), result);
			return { content: [{ type: "text", text: `Submitted ${params.status} patch result.` }], details: result, terminate: true };
		},
	});
}
