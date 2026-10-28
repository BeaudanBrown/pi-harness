import { Type, type TSchema } from "typebox";
import { Check } from "typebox/value";
import { HostActionSchema, parseHostAction, type HostAction } from "./live-workspace-contracts.js";

const fields: Record<string, TSchema> = {};
for (const schema of HostActionSchema.anyOf) {
	for (const [key, value] of Object.entries(schema.properties)) {
		if (key === "operation") continue;
		if (key === "placement" && "placement" in schema.properties) Object.assign(fields, schema.properties.placement.properties);
		else fields[key] = value;
	}
}
/** Flat provider schema is discovery only; the exact operation schema remains authority. */
export const ManagedHostParameters = Type.Object({
	operation: Type.String({ enum: ["help", ...HostActionSchema.anyOf.map(s => s.properties.operation.const)] }),
	...Object.fromEntries(Object.entries(fields).map(([key, schema]) => [key, Type.Optional(key === "confirmed" ? Type.Boolean({ enum: [true] }) : schema)])),
}, { additionalProperties: false });

export function managedHostAction(value: unknown): HostAction | "help" {
	if (!Check(ManagedHostParameters, value) || Buffer.byteLength(JSON.stringify(value)) > 60 * 1024) throw Error("Invalid managed_host parameters");
	const action = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
	if (action.operation === "help") {
		if (Object.keys(action).length !== 1) throw Error("Help takes no other parameters");
		return "help";
	}
	if (action.operation === "conversation.create") {
		action.placement = { rootKey: action.rootKey, workspace: action.workspace, relativeCwd: action.relativeCwd ?? "" };
		delete action.rootKey; delete action.workspace; delete action.relativeCwd;
	}
	return parseHostAction(action);
}

export function managedHostHelp(): string {
	return ["managed_host: host-owned workspaces, worktrees and conversations. Exact IDs only; names are display metadata.",
		"Reads/previews are free. Every model mutation needs fresh independent consent, even confirmed=true. Never invoke a shell/CLI to bypass it.",
		"Use a returned previewId for apply; never expand targets. open is window-first; resume waits for ready. delete is permanent retirement, not history/file deletion.",
		"The coordinator cannot be stopped/deleted. No account credentials, arbitrary commands, or model-supplied actor/origin fields.",
		...HostActionSchema.anyOf.map(s => `${s.properties.operation.const}: ${Object.keys(s.properties).filter(k => k !== "operation").flatMap(k => k === "placement" ? ["rootKey", "workspace", "relativeCwd (optional)"] : [k]).join(", ") || "no fields"}`),
		"worktree.conversation.fork: sourceConversationId must be this conversation; rootKey/workspace must match it. Use an explicit committed baseRef and a concise summary. Creates a new room with visible inherited context, idle until the next message. No uncommitted changes or execution state are copied.",
		"conversation.migrate: confirmed two-step legacy recovery, never a stop or launch. First capture exit evidence while the old window still exists; ask the operator to quit Pi and close only that window, then repeat with fresh consent. Ambiguous/absent evidence stays blocked. Use resume only after migration reports ready.",
		"conversation.recover.preview/apply: for already-closed legacy windows only. Preview discloses inspection uncertainty and whether this restores a live identity or resolves only a retired stop obligation. Apply requires fresh independent consent plus operatorClosed=true and acceptIncompleteInspection=true. Never assert closure on the operator's behalf. This records operator attestation, not verified exit; it never stops or launches Pi.",
		"Creation keys are stable caller-chosen identifiers. title is bounded display text. list limit/cursor and preview mergeTarget (except branch.preview) are optional.",
		"Capability/upgrade errors are not permission to use legacy mutation paths. Timeout means inspect before explicitly trying again.",
	].join("\n");
}
