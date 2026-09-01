import { Type } from "typebox";
export const MAX_CHECKPOINT_BODY_LENGTH = 6_000;
export const MAX_CHECKPOINT_UTF8_BYTES = 8_000;

const prose = (description: string, maxLength: number) =>
	Type.String({ description, minLength: 1, maxLength });
const requestedCodeFields = {
	codeOrDiffRequested: Type.Optional(
		Type.Literal(true, { description: "Set only when the operator explicitly requested code or a diff." }),
	),
	requestedCodeOrDiff: Type.Optional(prose("Code or diff explicitly requested by the operator.", 1_000)),
};

export const RemoteCheckpointSchema = Type.Union([
	Type.Object(
		{
			kind: Type.Literal("question"),
			decision: prose("The specific decision or answer required from the operator.", 1_200),
			context: Type.Optional(prose("Concise context needed to make the decision.", 1_200)),
			options: Type.Optional(
				Type.Array(prose("One concise option.", 300), { minItems: 1, maxItems: 8 }),
			),
			...requestedCodeFields,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			kind: Type.Literal("blocked"),
			blockerEvidence: prose("Observed evidence showing why work cannot continue.", 2_200),
			requiredIntervention: prose("The exact operator action or information required.", 1_200),
			...requestedCodeFields,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			kind: Type.Literal("issue_complete"),
			issueOrObjective: prose("Completed issue number, title, or objective.", 500),
			implementationSummary: prose("Concise implementation summary without code or diffs.", 1_200),
			verificationEvidence: prose("Tests, checks, and live evidence that passed.", 1_200),
			caveats: prose("Remaining caveats, deferred work, or 'None'.", 800),
			gitCommitState: prose("Commit, push, and working-tree state.", 800),
			approvalRequest: prose("Exact closure or continuation approval requested from the operator.", 600),
			...requestedCodeFields,
		},
		{ additionalProperties: false },
	),
]);

interface RequestedCodeOrDiff {
	codeOrDiffRequested?: true;
	requestedCodeOrDiff?: string;
}

export type RemoteCheckpointInput =
	| ({ kind: "question"; decision: string; context?: string; options?: string[] } & RequestedCodeOrDiff)
	| ({ kind: "blocked"; blockerEvidence: string; requiredIntervention: string } & RequestedCodeOrDiff)
	| ({
			kind: "issue_complete";
			issueOrObjective: string;
			implementationSummary: string;
			verificationEvidence: string;
			caveats: string;
			gitCommitState: string;
			approvalRequest: string;
	  } & RequestedCodeOrDiff);

const CODE_OR_DIFF =
	/[`()\[\]{}=<>|\\_*~^$]|;\s*$|^\s*(?:diff --git |@@ |(?:\+\+\+|---) [ab]\/|index [0-9a-f]+\.\.[0-9a-f]+|(?:new|deleted) file mode |[+-](?![+-\s])|(?:const|let|var|function|class|interface|type|import|export|def|fn|pub|impl|struct|enum|console\.|curl\b|wget\b|sudo\b|git\b|npm\b|nix\b|bash\b|sh\b|python\b|node\b)|[\w.$]+\s*=)/m;
const CONTROL_CHARACTER = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

function normalizedText(value: unknown, field: string, maxLength: number): string {
	if (typeof value !== "string") throw new Error(`${field} must be a string`);
	const normalized = value.replace(/\r\n?/g, "\n").trim();
	if (!normalized) throw new Error(`${field} must not be empty`);
	if (normalized.length > maxLength) throw new Error(`${field} must be at most ${maxLength} characters`);
	if (CONTROL_CHARACTER.test(normalized)) throw new Error(`${field} contains control characters`);
	return normalized;
}

function normalizedProse(value: unknown, field: string, maxLength: number): string {
	const normalized = normalizedText(value, field, maxLength);
	if (CODE_OR_DIFF.test(normalized)) throw new Error(`${field} must omit code and diffs`);
	return normalized;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
	const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
	if (unexpected.length > 0) throw new Error(`Unexpected checkpoint field: ${unexpected[0]}`);
}

const CODE_REQUEST_KEYS = ["codeOrDiffRequested", "requestedCodeOrDiff"] as const;

function validatedCodeRequest(input: Record<string, unknown>): RequestedCodeOrDiff {
	if (input.codeOrDiffRequested === undefined && input.requestedCodeOrDiff === undefined) return {};
	if (input.codeOrDiffRequested !== true || input.requestedCodeOrDiff === undefined) {
		throw new Error("requestedCodeOrDiff requires codeOrDiffRequested: true after an explicit operator request");
	}
	return {
		codeOrDiffRequested: true,
		requestedCodeOrDiff: normalizedText(input.requestedCodeOrDiff, "requestedCodeOrDiff", 1_000),
	};
}

export function validateRemoteCheckpoint(value: unknown): RemoteCheckpointInput {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("Checkpoint input must be an object");
	}
	const input = value as Record<string, unknown>;
	if (input.kind === "question") {
		exactKeys(input, ["kind", "decision", "context", "options", ...CODE_REQUEST_KEYS]);
		const options = input.options;
		if (options !== undefined && (!Array.isArray(options) || options.length < 1 || options.length > 8)) {
			throw new Error("options must contain 1-8 items");
		}
		return {
			kind: "question",
			decision: normalizedProse(input.decision, "decision", 1_200),
			...(input.context === undefined
				? {}
				: { context: normalizedProse(input.context, "context", 1_200) }),
			...(options === undefined
				? {}
				: { options: options.map((option, index) => normalizedProse(option, `options[${index}]`, 300)) }),
			...validatedCodeRequest(input),
		};
	}
	if (input.kind === "blocked") {
		exactKeys(input, ["kind", "blockerEvidence", "requiredIntervention", ...CODE_REQUEST_KEYS]);
		return {
			kind: "blocked",
			blockerEvidence: normalizedProse(input.blockerEvidence, "blockerEvidence", 2_200),
			requiredIntervention: normalizedProse(input.requiredIntervention, "requiredIntervention", 1_200),
			...validatedCodeRequest(input),
		};
	}
	if (input.kind === "issue_complete") {
		exactKeys(input, [
			"kind",
			"issueOrObjective",
			"implementationSummary",
			"verificationEvidence",
			"caveats",
			"gitCommitState",
			"approvalRequest",
			...CODE_REQUEST_KEYS,
		]);
		return {
			kind: "issue_complete",
			issueOrObjective: normalizedProse(input.issueOrObjective, "issueOrObjective", 500),
			implementationSummary: normalizedProse(input.implementationSummary, "implementationSummary", 1_200),
			verificationEvidence: normalizedProse(input.verificationEvidence, "verificationEvidence", 1_200),
			caveats: normalizedProse(input.caveats, "caveats", 800),
			gitCommitState: normalizedProse(input.gitCommitState, "gitCommitState", 800),
			approvalRequest: normalizedProse(input.approvalRequest, "approvalRequest", 600),
			...validatedCodeRequest(input),
		};
	}
	throw new Error("kind must be question, blocked, or issue_complete");
}

function checkpointFormattedBytes(body: string): number {
	const escaped = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;").replaceAll("'", "&#39;");
	const formatted = body.split(/\n{2,}/).map((paragraph) => `<p>${paragraph.split("\n").map(escaped).join("<br>")}</p>`).join("");
	return Buffer.byteLength(formatted, "utf8");
}

export function renderRemoteCheckpoint(input: RemoteCheckpointInput): string {
	let body: string;
	if (input.kind === "question") {
		body = [
			"❓ Question",
			`Decision required: ${input.decision}`,
			input.context ? `Context: ${input.context}` : undefined,
			input.options ? `Options:\n${input.options.map((option) => `- ${option}`).join("\n")}` : undefined,
			"Reply in this room to continue.",
		]
			.filter((line): line is string => line !== undefined)
			.join("\n\n");
	} else if (input.kind === "blocked") {
		body = [
			"⛔ Blocked",
			`Evidence: ${input.blockerEvidence}`,
			`Required intervention: ${input.requiredIntervention}`,
			"Reply in this room to continue.",
		].join("\n\n");
	} else {
		body = [
			"✅ Issue complete",
			`Issue/objective: ${input.issueOrObjective}`,
			`Implementation: ${input.implementationSummary}`,
			`Verification: ${input.verificationEvidence}`,
			`Caveats: ${input.caveats}`,
			`Git/commit state: ${input.gitCommitState}`,
			`Approval requested: ${input.approvalRequest}`,
		].join("\n\n");
	}
	if (input.codeOrDiffRequested && input.requestedCodeOrDiff) {
		body += `\n\nRequested code/diff:\n${input.requestedCodeOrDiff}`;
	}
	if (body.length > MAX_CHECKPOINT_BODY_LENGTH || Buffer.byteLength(body, "utf8") > MAX_CHECKPOINT_UTF8_BYTES ||
		checkpointFormattedBytes(body) > MAX_CHECKPOINT_UTF8_BYTES) {
		throw new Error("Rendered checkpoint exceeds the single Matrix event limit");
	}
	return body;
}
