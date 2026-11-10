import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { allowedWorkspace, connect, hostPath, object, Peer, remoteText, string } from "./wire.js";
import { RemoteCheckpointSchema, renderRemoteCheckpoint, validateRemoteCheckpoint } from "../matrix-shared/checkpoint.js";
import { nativeControlResult, type ControlResult } from "./native-controls.js";
import { nativeControl, type NativeControl } from "./interaction.js";
import { readImage } from "./media.js";

export type AdapterConfig = { socket: string; roots: string[] };
type Scope = { ctx: ExtensionContext; file: string; nativeId: string; boundary: string; active: boolean; epoch: number; registered?: boolean; intakeReady?: boolean; compactionEpoch?: number; controlEpoch?: number; stopping?: boolean; peer?: Peer; timer?: NodeJS.Timeout; seen: Set<string>; inputs: Set<string>; preflight: Set<string>; settled: Set<string> };
export function interactiveProcess(): boolean {
  const args = process.argv.slice(1);
  if (process.env.PI_HARNESS_ENABLE_PI_R === "1" || process.env.PI_HARNESS_ENABLE_AGENTGRAPH === "1" || process.env.PI_HARNESS_AGENT_PROFILE && process.env.PI_HARNESS_AGENT_PROFILE !== "engineering-full") return false;
  return Boolean(process.stdin.isTTY && process.stdout.isTTY) && !args.some((arg, index) =>
    ["--print", "-p", "--no-session"].includes(arg) || arg === "--mode" && args[index + 1] !== "text" || arg.startsWith("--mode=") && arg !== "--mode=text");
}
/** No Matrix HTTP, credentials, subprocess control, or durable runtime registry. */
export function installAdapter(pi: ExtensionAPI, options: { config?: AdapterConfig; interactive?: () => boolean } = {}): void {
  let current: Scope | undefined;
  const eligible = options.interactive ?? interactiveProcess;
  const config = (): AdapterConfig | undefined => {
    if (options.config) return options.config;
    const path = process.env.PI_MATRIX_BRIDGE_UI_CONFIG; if (!path) return undefined;
    const value = object(JSON.parse(readFileSync(path, "utf8")));
    if (!Array.isArray(value.roots)) throw Error("Invalid bridge workspace roots");
    return { socket: hostPath(string(value.socket)), roots: value.roots.map(root => hostPath(string(root))) };
  };
  const stop = () => {
    if (!current) return;
    current.active = false; clearTimeout(current.timer); current.peer?.close(); current = undefined;
  };
  const valid = (scope: Scope, peer?: Peer): boolean => current === scope && scope.active && (!peer || scope.peer === peer && !peer.socket.destroyed) &&
    scope.ctx.sessionManager.getSessionId() === scope.nativeId && scope.ctx.sessionManager.getSessionFile() === scope.file;
  const revoke = (scope: Scope) => { scope.epoch++; scope.controlEpoch = undefined; scope.compactionEpoch = undefined; };
  const status = (scope: Scope, message: string) => { if (valid(scope)) scope.ctx.ui.setStatus("matrix-bridge", message); };
  const remoteStatus = (scope: Scope, view: Record<string, unknown>) => {
    scope.intakeReady = view.intakeReady === true;
    const setup = object(view.setup ?? {});
    status(scope, view.syncError || view.error ? "Bridge connected · remote delivery needs attention" : !view.room ? "Bridge connected · room setup pending" :
      setup.stage && setup.stage !== "ready" ? `Matrix bridge connected · ${string(setup.stage, 16)} setup pending` : "Matrix bridge connected");
  };
  const activity = async (scope: Scope, peer: Peer) => {
    const idle = scope.ctx.isIdle() && !scope.ctx.hasPendingMessages() && scope.compactionEpoch === undefined && scope.controlEpoch === undefined;
    if (idle) for (const id of scope.inputs) if (!scope.preflight.has(id)) scope.settled.add(id);
    const settled = [...scope.settled].slice(0, 128);
    const view = object(await peer.request("activity", { idle, settled }));
    remoteStatus(scope, view);
    for (const id of settled) { scope.inputs.delete(id); scope.settled.delete(id); }
  };
  const attach = async (scope: Scope, cfg: AdapterConfig): Promise<void> => {
    if (!valid(scope)) return;
    try {
      const peer = await connect(cfg.socket, async (method, params) => {
        if (!valid(scope, peer)) throw Error("Native session changed or bridge disconnected");
        if (method !== "input") throw Error("Unknown native adapter operation");
        const id = string(params.id, 255), epoch = scope.epoch;
        // A live adapter also deduplicates across reconnects. The daemon never
        // retries uncertain input; this guard is not an execution receipt.
        if (scope.seen.has(id)) return { accepted: false, duplicate: true };
        scope.seen.add(id); // Reserve before the first await, including a lost/failed preflight.
        let serialized = "";
        for (;;) {
          const chunk = object(await peer.request("input.read", { id, offset: serialized.length }));
          if (typeof chunk.text !== "string" || typeof chunk.done !== "boolean" || !chunk.text.length && !chunk.done) throw Error("Invalid native input chunk");
          serialized += chunk.text;
          if (chunk.done) break;
          if (!valid(scope, peer)) throw Error("Input connection changed before native handoff");
        }
        const input = object(JSON.parse(serialized)); scope.intakeReady = true;
        const text = string(input.text, Number.MAX_SAFE_INTEGER), sender = string(input.sender, 255);
        if (!valid(scope, peer) || scope.stopping) throw Error("Input connection changed or native stop is pending");
        const live = () => valid(scope, peer) && scope.epoch === epoch && !scope.stopping;
        const publishControl = (result: ControlResult) => { if (live()) pi.appendEntry("matrix-bridge.control", { nativeId: scope.nativeId, input: id, sender, result }); };
        if (input.control !== undefined) {
          const command = string(input.control, 32) as NativeControl;
          if (nativeControl(`!${command}`) === "unknown") throw Error("Unknown native control");
          if (!live()) return { accepted: false, message: "Control withdrawn by native abort or session change." };
          if (command === "abort" || command === "stop") {
            publishControl({ message: `${command === "stop" ? "Stop" : "Abort"} requested. This does not undo or prove completion of earlier effects.` });
            revoke(scope); scope.ctx.abort();
            if (command === "stop") {
              scope.stopping = true;
              setTimeout(() => { if (valid(scope)) scope.ctx.shutdown(); }, 0);
            }
            return { accepted: true, stopping: scope.stopping === true };
          }
          if ((scope.compactionEpoch !== undefined || scope.controlEpoch !== undefined) && !["help", "status", "start"].includes(command)) {
            publishControl({ message: "A native control is still pending. Inspect !status or abort before another mutation." }); return { accepted: true };
          }
          const mutation = !["help", "status", "start"].includes(command);
          if (mutation) scope.controlEpoch = epoch; if (command === "compact") scope.compactionEpoch = epoch;
          let pending = false;
          try {
            const result = await nativeControlResult(pi, scope.ctx, command, input.argument === undefined ? undefined : string(input.argument, 4096), live, result => {
              if (scope.compactionEpoch === epoch) scope.compactionEpoch = undefined; publishControl(result);
            });
            if (!live()) throw Error("Native control was withdrawn before result publication");
            pending = result.pending === true; publishControl(result);
            return { accepted: true };
          } finally {
            if (mutation && scope.controlEpoch === epoch) scope.controlEpoch = undefined;
            if (command === "compact" && !pending && scope.compactionEpoch === epoch) scope.compactionEpoch = undefined;
          }
        }
        const question = input.question === undefined ? undefined : string(input.question, 128);
        const questionOpen = () => {
          if (!question) return true;
          const branch = scope.ctx.sessionManager.getBranch(), index = branch.findIndex(entry => entry.id === question && entry.type === "custom" && entry.customType === "matrix-bridge.question" && (entry.data as { nativeId?: unknown })?.nativeId === scope.nativeId);
          return index >= 0 && !branch.slice(index + 1).some(entry => entry.type === "message" && entry.message.role === "user" || entry.type === "custom" && ["matrix-bridge.question", "matrix-bridge.answer"].includes(entry.customType));
        };
        if (!live() || !questionOpen()) return { accepted: false, message: "This question or input is obsolete; no new turn was started." };
        if (input.image && !scope.ctx.model?.input.includes("image")) return { accepted: false, message: "The native model does not support images. The image and caption were not submitted; choose a capable model with !model or resend text." };
        const image = input.image ? await readImage(peer, id, input.image, live) : undefined;
        if (!live() || !questionOpen()) return { accepted: false, message: "Input withdrawn before native dispatch." };
        scope.inputs.add(id); scope.preflight.add(id);
        return await new Promise<{ accepted: boolean }>((resolve, reject) => {
          const timer = setTimeout(() => reject(Error("Native preflight did not settle")), 8000);
          // The callback is a native dispatch/preflight result, never a claim
          // about completion or external tool effects.
          const delivery: NonNullable<Parameters<ExtensionAPI["sendUserMessage"]>[1]> & { preflightResult: (success: boolean) => void; userMessageMetadata: Readonly<Record<string, string>> } = {
            deliverAs: input.deliverAs === "followUp" ? "followUp" : "steer", expandPromptTemplates: !image,
            onPromptExpanded: expanded => {
              if (!live() || !questionOpen() || image && !scope.ctx.model?.input.includes("image")) throw Error("Native question, model or input changed during preflight");
              if (question) pi.appendEntry("matrix-bridge.answer", { nativeId: scope.nativeId, question, input: id });
              return image ? expanded : remoteText(sender, id, expanded);
            },
            userMessageMetadata: { "pi.bridge.event": id, "pi.bridge.sender": sender },
            preflightResult: accepted => { clearTimeout(timer); scope.preflight.delete(id); if (!accepted) scope.inputs.delete(id); resolve({ accepted }); },
            onQueuedMessageRemoved: () => {
              scope.inputs.delete(id); scope.preflight.delete(id); scope.settled.delete(id);
              if (valid(scope) && scope.peer) void scope.peer.request("withdrawn", { id }).catch(() => {});
            },
          };
          try { pi.sendUserMessage(image ? [{ type: "text", text: remoteText(sender, id, text) }, { type: "image", ...image }] : text, delivery); }
          catch (error) { clearTimeout(timer); reject(error); }
        });
      });
      if (!valid(scope)) { peer.close(); return; }
      scope.peer = peer;
      peer.on("close", () => { if (valid(scope) && scope.peer === peer) { revoke(scope); scope.peer = undefined; status(scope, "Matrix offline · local Pi available"); } });
      const registration = object(await peer.request("register", { file: scope.file, nativeId: scope.nativeId, boundary: scope.boundary, title: scope.ctx.sessionManager.getSessionName() ?? basename(scope.ctx.cwd), idle: scope.ctx.isIdle(), stopping: scope.stopping === true }));
      if (!valid(scope, peer)) { peer.close(); return; }
      scope.registered = true; remoteStatus(scope, registration);
      const tick = async (): Promise<void> => {
        if (!valid(scope)) return;
        if (!scope.peer) { await attach(scope, cfg); return; }
        try { await activity(scope, scope.peer); }
        catch { scope.peer?.close(); }
        if (valid(scope)) { scope.timer = setTimeout(() => { void tick(); }, 1000); scope.timer.unref(); }
      };
      scope.timer = setTimeout(() => { void tick(); }, 1000); scope.timer.unref();
    } catch {
      scope.peer?.close();
      if (valid(scope)) {
        status(scope, "Matrix offline · local Pi available");
        scope.timer = setTimeout(() => { void attach(scope, cfg); }, 2000); scope.timer.unref();
      }
    }
  };
  const start = (ctx: ExtensionContext) => {
    stop();
    const localOnly = process.env.PI_BRIDGE_LOCAL_ONLY === "1" || process.env.PI_HARNESS_LOCAL_ONLY === "1";
    if ((!options.interactive && !ctx.hasUI) || !eligible() || localOnly) {
      // An explicitly resumed formerly public file must not leak a worker's
      // new output through the daemon's persisted-history reader either.
      const nativeId = ctx.sessionManager.getSessionId();
      if (ctx.sessionManager.getSessionFile() && ctx.sessionManager.getEntries().some(entry => entry.type === "custom" && entry.customType === "matrix-bridge.boundary" && (entry.data as { nativeId?: unknown })?.nativeId === nativeId)) {
        pi.appendEntry("matrix-bridge.enrollment", { nativeId, enabled: false });
      }
      if (localOnly) ctx.ui.setStatus("matrix-bridge", "Local-only Pi");
      return;
    }
    try {
      const cfg = config(); if (!cfg) return;
      allowedWorkspace(ctx.cwd, cfg.roots);
      const file = ctx.sessionManager.getSessionFile(); if (!file) return;
      const nativeId = ctx.sessionManager.getSessionId(), enabled = true;
      const entries = ctx.sessionManager.getEntries();
      const enrollment = [...entries].reverse().find(entry => entry.type === "custom" && entry.customType === "matrix-bridge.enrollment" && (entry.data as { nativeId?: unknown })?.nativeId === nativeId);
      if (!enrollment || (enrollment.type === "custom" && (enrollment.data as { enabled?: unknown })?.enabled !== enabled)) pi.appendEntry("matrix-bridge.enrollment", { nativeId, enabled });
      let boundary = entries.find(entry => entry.type === "custom" && entry.customType === "matrix-bridge.boundary" && (entry.data as { nativeId?: unknown })?.nativeId === nativeId)?.id;
      if (!boundary) { pi.appendEntry("matrix-bridge.boundary", { nativeId }); boundary = ctx.sessionManager.getLeafId() ?? undefined; }
      if (!boundary) throw Error("Native session has no persisted boundary");
      const scope: Scope = { ctx, file, nativeId, boundary, active: true, epoch: 0, seen: new Set(), inputs: new Set(), preflight: new Set(), settled: new Set() };
      current = scope; void attach(scope, cfg);
    } catch { ctx.ui.setStatus("matrix-bridge", "Matrix offline · local Pi available"); }
  };
  if ((options.config || process.env.PI_MATRIX_BRIDGE_UI_CONFIG) && eligible() && process.env.PI_BRIDGE_LOCAL_ONLY !== "1" && process.env.PI_HARNESS_LOCAL_ONLY !== "1") pi.registerTool({
    name: "remote_checkpoint", label: "Remote Checkpoint", description: "Record a durable question, blocker or completion boundary for this native session's Matrix room, then stop the current run pending fresh input.",
    promptSnippet: "Use only for an intentional question, blocker or issue-completion approval boundary, not routine progress.",
    promptGuidelines: ["Do not mirror routine progress, thinking, tool activity or ordinary terminal answers to Matrix.", "Issue completion needs implementation, verification, caveats, Git state and an exact approval request.", "Omit code and diffs unless explicitly requested by the operator."],
    parameters: RemoteCheckpointSchema,
    execute: async (_callId, params, _signal, _onUpdate, ctx) => {
      const scope = current; if (!scope || !scope.registered || !scope.intakeReady || !valid(scope) || ctx.sessionManager.getSessionId() !== scope.nativeId) throw Error("No registered native Matrix binding yet; local Pi remains available");
      const checkpoint = validateRemoteCheckpoint(params); renderRemoteCheckpoint(checkpoint);
      pi.appendEntry("matrix-bridge.question", { nativeId: scope.nativeId, checkpoint });
      const entry = ctx.sessionManager.getLeafId(); revoke(scope); ctx.abort();
      return { content: [{ type: "text", text: "Checkpoint recorded in native history. Matrix publication is asynchronous; the run is stopped pending fresh input." }], details: { entry, waiting: true } };
    },
  });
  pi.on("session_start", (_event, ctx) => { start(ctx); });
  pi.on("session_shutdown", () => { stop(); });
}
