import type { ConversationManifest, HostRuntimeState, ManagedAdapterLiveStatus, SessionGeneration } from "../contracts.js";

type RuntimeConversation = HostRuntimeState["conversations"][number];

function activeGeneration(manifest: ConversationManifest): SessionGeneration | undefined {
	return manifest.generations?.find((generation) => generation.generationId === manifest.activeGenerationId) ?? manifest.generations?.at(-1);
}

export function renderManagedConversationStatus(
	manifest: ConversationManifest,
	runtime: RuntimeConversation,
	live: ManagedAdapterLiveStatus | undefined,
	pendingReconciliation: number,
	currentControlId?: string,
): string {
	const generation = activeGeneration(manifest);
	const requestedModel = manifest.selectedModel ?? generation?.model;
	const requestedThinking = manifest.selectedThinking ?? generation?.thinking;
	const pendingInputs = runtime.pendingInputs.filter((input) => input.status !== "completed" && input.status !== "cancelled").length;
	const checkpoint = runtime.activeCheckpointPoll ?? runtime.publishingCheckpointPoll;
	const lines = [
		`Conversation: ${manifest.concept} (${manifest.kind})`,
		...(manifest.projectDisplayName ? [`Project: ${manifest.projectDisplayName}`] : []),
		...(manifest.checkoutDisplayName ? [`Checkout: ${manifest.checkoutDisplayName}`] : []),
		`State: ${runtime.state}; Pi ${live?.state ?? "unavailable"}; adapter ${runtime.attachment ? "connected" : "disconnected"}`,
		`Generation: ${generation?.ordinal ?? 1}/${manifest.generations?.length ?? 1}`,
		`Model: ${live?.model ?? "unavailable"}`,
		`Saved model: ${manifest.selectedModel ?? "none"}; requested: ${requestedModel ?? "configured default"}`,
		`Model match: ${requestedModel && live?.model ? (requestedModel === live.model ? "yes" : "NO — runtime differs from requested model") : "unknown"}`,
		`Thinking: ${live?.thinking ?? "unavailable"}; saved: ${manifest.selectedThinking ?? "none"}; requested: ${requestedThinking ?? "configured default"}`,
		...(live?.context ? [`Context: ${live.context.usedTokens}/${live.context.limitTokens} tokens`] : []),
		`Queues: ${pendingInputs} input; ${runtime.pendingControls.filter((control) => control.controlId !== currentControlId).length} control`,
		`Checkpoint: ${checkpoint ? "awaiting response" : "none"}`,
		`Project reconciliation pending: ${pendingReconciliation}`,
		...(runtime.lastLaunchError ? [`Latest launch failure: ${runtime.lastLaunchError.code} at ${runtime.lastLaunchError.at}`] : []),
	];
	return lines.join("\n").slice(0, 4_096);
}
