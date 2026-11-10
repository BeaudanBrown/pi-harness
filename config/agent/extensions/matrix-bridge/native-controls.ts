import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONTROL_HELP, type InteractionSpec, type NativeControl } from "./interaction.js";

export type ControlResult = { message: string; selection?: InteractionSpec; selected?: "model" | "thinking"; pending?: true };
/** Native APIs only. The caller owns session fencing and durable result publication. */
export async function nativeControlResult(pi: ExtensionAPI, ctx: ExtensionContext, name: NativeControl, argument: string | undefined,
  valid: () => boolean, result: (value: ControlResult) => void): Promise<ControlResult> {
  if (!valid()) throw Error("Native session changed before control");
  if (name === "help") return { message: CONTROL_HELP };
  if (name === "start") return { message: "Pi is attached. No model turn was started." };
  if (name === "status") {
    const usage = ctx.getContextUsage();
    return { message: `Pi ${ctx.isIdle() ? "idle" : "busy"}; model ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unavailable"}; thinking ${pi.getThinkingLevel()}; context ${usage?.tokens ?? "unknown"}/${usage?.contextWindow ?? "unknown"}.` };
  }
  if (name === "abort" || name === "stop") throw Error("Abort/stop belong to the adapter's native cancellation path");
  if (!ctx.isIdle() || ctx.hasPendingMessages()) return { message: `Cannot change ${name} while Pi is busy or has queued input. Use !abort first; the run was not altered.` };
  const leaf = ctx.sessionManager.getLeafId();
  const branch = () => valid() && (!leaf || ctx.sessionManager.getBranch().some(entry => entry.id === leaf));
  const ready = () => branch() && ctx.isIdle() && !ctx.hasPendingMessages();
  if (name === "model") {
    const scoped = ctx.scopedModels.length ? new Set(ctx.scopedModels.map(({ model }) => `${model.provider}/${model.id}`)) : undefined;
    const available = ctx.modelRegistry.getAvailable().filter(model => !scoped || scoped.has(`${model.provider}/${model.id}`));
    if (argument?.includes("/")) {
      const selected = available.find(model => `${model.provider}/${model.id}` === argument);
      if (!selected) return { message: "That exact model is unauthenticated or outside this native session's scope." };
      const accepted = await pi.setModel(selected, { preflight: ready });
      if (!valid()) throw Error("Native session changed during model selection; inspect locally before retrying");
      return { message: accepted ? `Model changed to ${argument}.` : "Pi could not authenticate that model; no alternative was selected.", ...(accepted ? { selected: "model" as const } : {}) };
    }
    const models = available.map(model => `${model.provider}/${model.id}`).filter(id => !argument || id.toLowerCase().includes(argument.toLowerCase())).sort();
    if (!models.length) return { message: "No authenticated session-scoped models matched. Use an exact provider/model or another filter." };
    if (models.length > 20 || models.some(id => Buffer.byteLength(id) > 512)) return { message: "Model choices exceed one poll. Narrow with !model FILTER, or specify an exact provider/model." };
    return { message: "Choose a native model.", selection: { kind: "model", question: "Choose an authenticated model for this native session.", options: models } };
  }
  if (name === "thinking") {
    const { getSupportedThinkingLevels } = await import("@earendil-works/pi-ai");
    if (!ready()) throw Error("Native session changed before thinking selection");
    const levels: readonly string[] = ctx.model ? getSupportedThinkingLevels(ctx.model) : ["off"];
    if (!argument) return { message: "Choose a thinking level.", selection: { kind: "thinking", question: "Choose a thinking level supported by the current model.", options: [...levels] } };
    if (!levels.includes(argument)) return { message: `Unsupported thinking level. Available: ${levels.join(", ")}.` };
    pi.setThinkingLevel(argument as Parameters<ExtensionAPI["setThinkingLevel"]>[0]);
    return { message: `Thinking changed to ${pi.getThinkingLevel()}.`, selected: "thinking" };
  }
  if (name === "compact") {
    ctx.compact({ customInstructions: argument, preflight: branch,
      onComplete: () => { if (valid()) result({ message: "Native compaction completed; history remains owned by Pi." }); },
      onError: () => { if (valid()) result({ message: "Native compaction failed. Inspect the local Pi session; it will not be retried automatically." }); },
    });
    return { message: "Native compaction requested, not yet confirmed complete.", pending: true };
  }
  throw Error("Unknown native control");
}
