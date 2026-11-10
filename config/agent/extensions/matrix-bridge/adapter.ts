import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { allowedWorkspace, connect, hostPath, object, Peer, remoteText, string } from "./wire.js";
import { RemoteCheckpointSchema, renderRemoteCheckpoint, validateRemoteCheckpoint } from "../matrix-shared/checkpoint.js";
import { nativeControlResult, type ControlResult } from "./native-controls.js";
import { nativeControl, type NativeControl } from "./interaction.js";
import { readImage } from "./media.js";
import { dispatchAllowed, type DispatchFence } from "./dispatch-fence.js";
import { TaskWorkspaceSchema, taskKey } from "./task-contract.js";

export type AdapterConfig = { socket: string; roots: string[] };
type Scope = { ctx: ExtensionContext; file: string; nativeId: string; boundary: string; active: boolean; epoch: number; archiveRevision?: number; remoteBlocked?: boolean; dispatchFence?: DispatchFence; registered?: boolean; intakeReady?: boolean; compactionEpoch?: number; controlEpoch?: number; stopping?: boolean; peer?: Peer; timer?: NodeJS.Timeout; seen: Set<string>; inputs: Set<string>; preflight: Set<string>; settled: Set<string> };
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
  const archivePolicy = (scope: Scope, view: Record<string, unknown>) => {
    const revision = Number(view.archiveRevision ?? view.revision ?? 0);
    if (!Number.isSafeInteger(revision) || revision < (scope.archiveRevision ?? 0)) return;
    const blocked = view.archived === true || view.resumePending === true;
    if (scope.archiveRevision !== undefined && (scope.archiveRevision !== revision || scope.remoteBlocked !== blocked)) revoke(scope);
    scope.archiveRevision = revision; scope.remoteBlocked = blocked;
  };
  const remoteStatus = (scope: Scope, view: Record<string, unknown>) => {
    archivePolicy(scope, view);
    if (typeof view.dispatchLedger === "string" && typeof view.key === "string") scope.dispatchFence = { ledger: hostPath(view.dispatchLedger), binding: string(view.key, 64), file: scope.file, nativeId: scope.nativeId };
    scope.intakeReady = view.intakeReady === true;
    const setup = object(view.setup ?? {});
    status(scope, view.archived ? "Archived · local Pi available; existing work may finish" : view.resumePending ? "Restored · fresh Matrix sync pending" : view.syncError || view.error ? "Bridge connected · remote delivery needs attention" : !view.room ? "Bridge connected · room setup pending" :
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
        if (method === "archive-policy") { archivePolicy(scope, params); return {}; }
        if (method !== "input") throw Error("Unknown native adapter operation");
        if (typeof params.archived === "boolean") archivePolicy(scope, params);
        const id = string(params.id, 255), epoch = scope.epoch, revision = scope.archiveRevision ?? 0;
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
        const live = () => valid(scope, peer) && scope.epoch === epoch && !scope.stopping && !scope.remoteBlocked && dispatchAllowed(scope.dispatchFence, revision);
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
          const delivery: NonNullable<Parameters<ExtensionAPI["sendUserMessage"]>[1]> & { preflightResult: (success: boolean) => void; userMessageMetadata: Readonly<Record<string, string>>; queuedPreflight: () => boolean } = {
            deliverAs: input.deliverAs === "followUp" ? "followUp" : "steer", expandPromptTemplates: !image,
            onPromptExpanded: expanded => {
              if (!live() || !questionOpen() || image && !scope.ctx.model?.input.includes("image")) throw Error("Native question, model or input changed during preflight");
              if (question) pi.appendEntry("matrix-bridge.answer", { nativeId: scope.nativeId, question, input: id });
              return image ? expanded : remoteText(sender, id, expanded);
            },
            queuedPreflight: live,
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
      // An imported public file need not have a new bridge boundary marker.
      // Persist the private choice before any worker/local-only work, without
      // requiring the bridge or interpreting old managed custom entries.
      const nativeId = ctx.sessionManager.getSessionId();
      if (ctx.sessionManager.getSessionFile()) {
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
  const toolsAvailable = (options.config || process.env.PI_MATRIX_BRIDGE_UI_CONFIG) && eligible() && process.env.PI_BRIDGE_LOCAL_ONLY !== "1" && process.env.PI_HARNESS_LOCAL_ONLY !== "1";
  if (toolsAvailable) for (const [name, archived] of [["bridge-archive", true], ["bridge-restore", false]] as const) pi.registerCommand(name, {
    description: `${archived ? "Archive" : "Restore"} this Matrix conversation after a native human confirmation; never stop Pi or replay input.`,
    handler: async (_args, ctx) => {
      const scope = current, peer = scope?.peer;
      if (!scope || !peer || !scope.registered || !ctx.hasUI || !valid(scope, peer)) throw Error("No connected native binding; local Pi remains available");
      const epoch = scope.epoch;
      const live = () => valid(scope, peer) && scope.epoch === epoch && ctx.sessionManager.getSessionId() === scope.nativeId;
      const view = object(await peer.request("archive.status", {})); if (!live()) return;
      const accepted = await ctx.ui.confirm(archived ? "Archive this conversation?" : "Restore this conversation?", "History, membership, worktree and running Pi are retained. No stop or replay. Archive hides the default picker entry and disables future remote input. Restore requires a fresh Matrix sync; grouping updates asynchronously. The room may remain visible in All Rooms.");
      if (!accepted || !live()) return;
      remoteStatus(scope, object(await peer.request("archive.set", { archived, revision: Number(view.archiveRevision ?? 0) })));
    },
  });
  if (toolsAvailable) pi.registerTool({
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
  if (toolsAvailable) pi.registerTool({
    name: "create_task_workspace", label: "Create Task Workspace",
    description: "Request a separately approved new Git branch/linked worktree and saved native Pi conversation containing only the explicit handoff. The child remains idle; exact-intent retries reuse the frozen base and owned resources.",
    promptSnippet: "Use for an independently approved task-workspace handoff, never to start task execution.",
    promptGuidelines: ["Use this narrow operation, not a shell or a general host dispatcher, for a model-requested task workspace.",
      "The natural-language request, model claims and ordinary question votes are not approval. Each distinct intent needs a separate local human confirmation or the original configured-operator approval poll.",
      "Do not copy raw history, hidden output, credentials, pending approvals or uncommitted files into the summary. Do not begin work in the child; a later human instruction is separate intent."],
    parameters: TaskWorkspaceSchema,
    execute: async (callId, intent, signal, _onUpdate, ctx) => {
      const scope = current, peer = scope?.peer;
      if (!scope || !peer || !scope.registered || !valid(scope, peer) || ctx.sessionManager.getSessionId() !== scope.nativeId) throw Error("No registered native binding for task creation; local Pi remains available");
      const epoch = scope.epoch, leaf = ctx.sessionManager.getLeafId();
      const live = () => valid(scope, peer) && scope.epoch === epoch && !scope.stopping && !signal?.aborted &&
        (!leaf || ctx.sessionManager.getBranch().some(entry => entry.id === leaf));
      const user = [...ctx.sessionManager.getBranch()].reverse().find(entry => entry.type === "message" && entry.message.role === "user");
      const origin = user?.type === "message" ? user.message as unknown as Record<string, unknown> : {};
      const metadata = object(origin.metadata ?? {});
      const surface = ctx.hasUI && typeof metadata["pi.bridge.event"] !== "string" ? "local" : "matrix";
      let view = object(await peer.request("task.prepare", { intent, call: `${leaf ?? "root"}:${callId}`, surface }, 30000));
      if (!live()) throw Error("Task proposal became stale before local confirmation; no local approval was submitted");
      const key = taskKey(view.key), request = taskKey(view.request);
      pi.appendEntry("matrix-bridge.task-request", { nativeId: scope.nativeId, key, request });
      if (surface === "matrix" && view.phase === "approval") {
        view = object(await peer.request("task.publish-approval", { key, request }));
        if (!live()) throw Error("Native context changed after approval publication. Inspect the original poll rather than assuming cancellation.");
      }
      if (surface === "local" && view.phase === "approval") {
        const accepted = await ctx.ui.confirm("Create task workspace?", `${string(view.approvalText, 8000)}\n\nWorkspace: ${string(view.cwd)}\nNative history: ${string(view.file)}`, { signal });
        if (!live()) throw Error("Local task confirmation was withdrawn before submission");
        // The boolean comes from this native UI callback, never model arguments.
        view = object(await peer.request("task.confirm-local", { key, request, accepted }, 60000));
        if (!live()) throw Error("Native context changed after the decision; an approved creation may still complete. Inspect the original conversation rather than assuming cancellation.");
      }
      const message = view.localReady === true ? `Task workspace and saved native session are ready. No child model turn was started. ${view.remotePending === true ? "Remote setup is pending." : "Remote setup has completed."} Use a separate fresh human instruction in the child when ready.` :
        view.phase === "approval" ? "Task proposal recorded. The configured operator must independently approve the original poll (or reply directly with Approve/Cancel). No task execution was started." :
        view.phase === "declined" ? "Task proposal declined or expired. No creation was dispatched by this decision." :
        typeof view.error === "string" ? string(view.error, 1000) : "Approved creation is still pending; partial resources are preserved. No child model turn was started.";
      revoke(scope); ctx.abort();
      return { content: [{ type: "text", text: message }], details: { ...view, waiting: true } };
    },
  });
  pi.on("session_start", (_event, ctx) => { start(ctx); });
  pi.on("session_shutdown", () => { stop(); });
}
