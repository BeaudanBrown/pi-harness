import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { allowedWorkspace, connect, hostPath, object, Peer, remoteText, string } from "./wire.js";
import { nativeControlResult, type ControlResult } from "./native-controls.js";
import { interactionSpec, nativeControl, type NativeControl } from "./interaction.js";
import { readImage } from "./media.js";
import { CreateProjectSchema, TaskWorkspaceSchema, taskKey } from "./task-contract.js";
import { cancelAloop } from "../aloop/lifecycle.js";

export type AdapterConfig = { socket: string; roots: string[] };
type Scope = { ctx: ExtensionContext; file: string; nativeId: string; boundary: string; active: boolean; epoch: number; registered?: boolean; controlPending?: boolean; peer?: Peer; timer?: NodeJS.Timeout; seen: Set<string> };
export function interactiveProcess(): boolean {
  const args = process.argv.slice(1);
  if (process.env.PI_HARNESS_ENABLE_PI_R === "1" || process.env.PI_HARNESS_ENABLE_AGENTGRAPH === "1" || process.env.PI_HARNESS_AGENT_PROFILE && process.env.PI_HARNESS_AGENT_PROFILE !== "engineering-full") return false;
  return Boolean(process.stdin.isTTY && process.stdout.isTTY) && !args.some((arg, index) =>
    ["--print", "-p", "--no-session"].includes(arg) || arg === "--mode" && args[index + 1] !== "text" || arg.startsWith("--mode=") && arg !== "--mode=text");
}
/** Pi owns execution. This adapter submits idle custom messages, never native queue entries. */
export function installAdapter(pi: ExtensionAPI, options: { config?: AdapterConfig; interactive?: () => boolean } = {}): void {
  let current: Scope | undefined;
  let pendingStart: NodeJS.Timeout | undefined;
  const eligible = options.interactive ?? interactiveProcess;
  const config = (): AdapterConfig | undefined => {
    if (options.config) return options.config;
    const path = process.env.PI_MATRIX_BRIDGE_UI_CONFIG; if (!path) return undefined;
    const value = object(JSON.parse(readFileSync(path, "utf8")));
    if (!Array.isArray(value.roots)) throw Error("Invalid bridge workspace roots");
    return { socket: hostPath(string(value.socket)), roots: value.roots.map(root => hostPath(string(root))) };
  };
  const stop = () => {
    clearTimeout(pendingStart); pendingStart = undefined;
    if (!current) return;
    current.active = false; clearTimeout(current.timer); current.peer?.close(); current = undefined;
  };
  const valid = (scope: Scope, peer?: Peer): boolean => current === scope && scope.active && (!peer || scope.peer === peer && !peer.socket.destroyed) &&
    scope.ctx.sessionManager.getSessionId() === scope.nativeId && scope.ctx.sessionManager.getSessionFile() === scope.file;
  const idle = (scope: Scope) => scope.ctx.isIdle() && !scope.ctx.hasPendingMessages() && !scope.controlPending;
  const status = (scope: Scope, message: string) => { if (valid(scope)) scope.ctx.ui.setStatus("matrix-bridge", message); };
  const remoteStatus = (scope: Scope, view: Record<string, unknown>) => {
    status(scope, view.syncError ? "Matrix sync failed · new messages delayed" : view.error ? "Matrix delivery problem in this room" : view.intakeReady !== true ? "Matrix connected · fresh sync pending; input not yet enabled" : !view.room ? "Bridge connected · room setup pending" : view.archived ? "Matrix connected · archived (organization only)" : "Matrix bridge connected");
  };
  const attach = async (scope: Scope, cfg: AdapterConfig): Promise<void> => {
    if (!valid(scope)) return;
    try {
      const peer = await connect(cfg.socket, async (method, params) => {
        if (!valid(scope, peer)) throw Error("Native session changed or bridge disconnected");
        if (method !== "input") throw Error("Unknown native adapter operation");
        const ids = Array.isArray(params.ids) ? params.ids.map(id => string(id, 255)) : [string(params.id, 255)];
        if (!ids.length || ids.length > 100 || ids.some(id => scope.seen.has(id))) return { accepted: false, message: "Duplicate or invalid handoff; nothing was retried." };
        ids.forEach(id => scope.seen.add(id));
        const epoch = scope.epoch;
        const live = () => valid(scope, peer) && scope.epoch === epoch;
        const inputs: Array<Record<string, unknown>> = [];
        for (const id of ids) {
          let serialized = "";
          for (;;) {
            const chunk = object(await peer.request("input.read", { id, offset: serialized.length }));
            if (typeof chunk.text !== "string" || typeof chunk.done !== "boolean" || !chunk.text.length && !chunk.done) throw Error("Invalid native input chunk");
            serialized += chunk.text;
            if (!live()) throw Error("Input connection changed before native handoff");
            if (chunk.done) break;
          }
          inputs.push(object(JSON.parse(serialized)));
        }
        const first = inputs[0]!, id = ids[0]!, sender = string(first.sender, 255);
        if (first.control !== undefined) {
          if (inputs.length !== 1) throw Error("Controls cannot be batched");
          const command = string(first.control, 32) as NativeControl;
          if (nativeControl(`!${command}`) === "unknown") throw Error("Unknown native control");
          const publish = async (result: ControlResult) => {
            if (!valid(scope, peer)) throw Error("Control outcome unknown after disconnect; inspect status before retrying");
            // A saved idle handoff may contain no assistant messages. Do not
            // depend on upstream flushing custom entries to publish a result.
            await peer.request("control.result", { id, sender, result });
          };
          if (command === "abort") {
            await publish({ message: "Abort requested. This does not undo or prove completion of earlier effects." });
            scope.epoch++; cancelAloop(scope.nativeId); scope.ctx.abort();
            return { accepted: true };
          }
          const mutation = !["help", "status"].includes(command);
          if (mutation && !idle(scope)) { await publish({ message: "Pi is busy or a control is pending. Retry when idle; nothing was changed." }); return { accepted: true }; }
          if (mutation) scope.controlPending = true;
          let pending = false;
          try {
            const result = await nativeControlResult(pi, scope.ctx, command, first.argument === undefined ? undefined : string(first.argument, 4096), () => valid(scope, peer), result => {
              scope.controlPending = false; void publish(result).catch(() => peer.close());
            });
            pending = result.pending === true; await publish(result);
            return { accepted: true };
          } finally { if (mutation && !pending) scope.controlPending = false; }
        }
        const defer = () => {
          ids.forEach(id => scope.seen.delete(id));
          return { accepted: false, deferred: true }; // Definitively not submitted; still bridge-owned input.
        };
        if (!idle(scope)) return defer();
        const content: (TextContent | ImageContent)[] = [];
        const events: Array<{ id: string; sender: string }> = [];
        for (const [index, input] of inputs.entries()) {
          if (input.control !== undefined) throw Error("Controls cannot be batched with chat");
          const sender = string(input.sender, 255), id = ids[index]!;
          if (input.image && !scope.ctx.model?.input.includes("image")) return { accepted: false, message: "The current model does not support images. The batch was not submitted; choose a capable model or resend text." };
          const image = input.image ? await readImage(peer, id, input.image, live) : undefined;
          content.push({ type: "text", text: remoteText(sender, id, string(input.text, Number.MAX_SAFE_INTEGER)) });
          if (image) content.push({ type: "image", ...image });
          events.push({ id, sender });
        }
        if (!live()) return { accepted: false, message: "Session changed before handoff. The batch was not submitted." };
        if (!idle(scope)) return defer();
        // The extension API is fire-and-forget. This acknowledges submission,
        // not model execution. Only persisted custom-message provenance settles
        // delivery; a lost/failed handoff is never retried automatically.
        pi.sendMessage({ customType: "matrix-bridge.input", content, display: true, details: { nativeId: scope.nativeId, events } }, { triggerTurn: true });
        return { accepted: true };
      });
      if (!valid(scope)) { peer.close(); return; }
      scope.peer = peer;
      peer.on("close", () => { if (valid(scope) && scope.peer === peer) { scope.epoch++; scope.registered = false; scope.peer = undefined; status(scope, "Matrix offline · local Pi available"); } });
      const registration = object(await peer.request("register", { protocol: 2, file: scope.file, nativeId: scope.nativeId, boundary: scope.boundary, title: scope.ctx.sessionManager.getSessionName() ?? basename(scope.ctx.cwd), idle: idle(scope) }));
      if (!valid(scope, peer)) { peer.close(); return; }
      scope.registered = true; remoteStatus(scope, registration);
      const tick = async (): Promise<void> => {
        if (!valid(scope)) return;
        if (!scope.peer) { await attach(scope, cfg); return; }
        try { remoteStatus(scope, object(await scope.peer.request("activity", { idle: idle(scope) }))); }
        catch { scope.peer?.close(); }
        if (valid(scope)) { scope.timer = setTimeout(() => { void tick(); }, 1000); scope.timer.unref(); }
      };
      scope.timer = setTimeout(() => { void tick(); }, 1000); scope.timer.unref();
    } catch {
      scope.peer?.close();
      if (valid(scope)) {
        status(scope, "Matrix offline or another adapter is connected · local Pi available");
        scope.timer = setTimeout(() => { void attach(scope, cfg); }, 2000); scope.timer.unref();
      }
    }
  };
  const start = (ctx: ExtensionContext) => {
    stop();
    const localOnly = process.env.PI_BRIDGE_LOCAL_ONLY === "1" || process.env.PI_HARNESS_LOCAL_ONLY === "1";
    if ((!options.interactive && !ctx.hasUI) || !eligible() || localOnly) {
      if (ctx.sessionManager.getSessionFile()) pi.appendEntry("matrix-bridge.enrollment", { nativeId: ctx.sessionManager.getSessionId(), enabled: false });
      if (localOnly) ctx.ui.setStatus("matrix-bridge", "Local-only Pi");
      return;
    }
    try {
      const cfg = config(); if (!cfg) return;
      allowedWorkspace(ctx.cwd, cfg.roots);
      const file = ctx.sessionManager.getSessionFile(); if (!file) return;
      // Empty sessions are intentionally not forced onto disk by the bridge.
      if (!existsSync(file)) {
        pendingStart = setTimeout(() => start(ctx), 1000); pendingStart.unref(); return;
      }
      const nativeId = ctx.sessionManager.getSessionId();
      const entries = ctx.sessionManager.getEntries();
      const enrollment = [...entries].reverse().find(entry => entry.type === "custom" && entry.customType === "matrix-bridge.enrollment" && (entry.data as { nativeId?: unknown })?.nativeId === nativeId);
      if (!enrollment || enrollment.type === "custom" && (enrollment.data as { enabled?: unknown })?.enabled !== true) pi.appendEntry("matrix-bridge.enrollment", { nativeId, enabled: true });
      let boundary = entries.find(entry => entry.type === "custom" && entry.customType === "matrix-bridge.boundary" && (entry.data as { nativeId?: unknown })?.nativeId === nativeId)?.id;
      if (!boundary) { pi.appendEntry("matrix-bridge.boundary", { nativeId }); boundary = ctx.sessionManager.getLeafId() ?? undefined; }
      if (!boundary) throw Error("Native session has no enrollment boundary");
      const scope: Scope = { ctx, file, nativeId, boundary, active: true, epoch: 0, seen: new Set() };
      current = scope; void attach(scope, cfg);
    } catch { ctx.ui.setStatus("matrix-bridge", "Matrix offline · local Pi available"); }
  };
  const toolsAvailable = (options.config || process.env.PI_MATRIX_BRIDGE_UI_CONFIG) && eligible() && process.env.PI_BRIDGE_LOCAL_ONLY !== "1" && process.env.PI_HARNESS_LOCAL_ONLY !== "1";
  if (toolsAvailable) for (const [name, archived] of [["bridge-archive", true], ["bridge-restore", false]] as const) pi.registerCommand(name, {
    description: `${archived ? "Archive" : "Restore"} this Matrix conversation's organization; no execution or access changes.`,
    handler: async (_args, ctx) => {
      const scope = current, peer = scope?.peer;
      if (!scope || !peer || !scope.registered || !ctx.hasUI || !valid(scope, peer)) throw Error("No connected native binding; local Pi remains available");
      const view = object(await peer.request("archive.status", {}));
      const accepted = await ctx.ui.confirm(archived ? "Archive this conversation?" : "Restore this conversation?", "Only picker and Space organization change. This room can still instruct connected Pi. History, membership, worktree and running Pi are retained.");
      if (accepted && valid(scope, peer)) remoteStatus(scope, object(await peer.request("archive.set", { archived, revision: Number(view.archiveRevision ?? 0) })));
    },
  });
  if (toolsAvailable) pi.registerTool({
    name: "ask_user", label: "Ask User", description: "Publish a question or choice poll to this session's Matrix room. First eligible answer wins. Other conversation is not blocked; this is not an approval mechanism.",
    promptSnippet: "Ask a human a question in Matrix. Completion and blocker reports belong in ordinary assistant text.",
    promptGuidelines: ["Finish your response with the question; do not add a redundant closing message.", "Ordinary answers never authorize independent project/worktree creation."],
    parameters: Type.Object({ question: Type.String({ minLength: 1, maxLength: 8000 }), options: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 1024 }), { minItems: 1, maxItems: 20 })) }),
    execute: async (_callId, params, _signal, _onUpdate, ctx) => {
      const scope = current;
      if (!scope?.peer || !scope.registered || !valid(scope, scope.peer) || ctx.sessionManager.getSessionId() !== scope.nativeId) throw Error("No connected Matrix session. Ask in ordinary terminal text instead.");
      const question = interactionSpec({ kind: "question", ...params });
      pi.appendEntry("matrix-bridge.question", { nativeId: scope.nativeId, question });
      return { content: [{ type: "text", text: "Question recorded for asynchronous Matrix publication. Other input remains eligible; answers are not approvals." }], details: {}, terminate: true };
    },
  });
  if (toolsAvailable) for (const fresh of [false, true]) pi.registerTool({
    name: fresh ? "create_project" : "create_task_workspace", label: fresh ? "Create Project" : "Create Task Workspace",
    description: fresh ? "Request an independently approved fresh standalone Git repository, README and initial main commit, saved idle native session and asynchronous Matrix room. No process, model turn, remote, push or dependencies." : "Request an independently approved new Git branch/linked worktree and saved idle native conversation containing only the explicit handoff. No child execution.",
    promptSnippet: "Propose an independently approved idle handoff, never start task execution.",
    promptGuidelines: ["Each distinct intent requires a separate native human confirmation or configured-operator approval poll. Ordinary chat and question polls are not approval.", "Do not copy raw history, credentials, pending approvals or uncommitted files. A later human instruction starts child work."],
    parameters: fresh ? CreateProjectSchema : TaskWorkspaceSchema,
    execute: async (callId, intent, signal, _onUpdate, ctx) => {
      const scope = current, peer = scope?.peer;
      if (!scope || !peer || !scope.registered || !valid(scope, peer) || ctx.sessionManager.getSessionId() !== scope.nativeId) throw Error("No registered native binding for task creation; local Pi remains available");
      const epoch = scope.epoch, leaf = ctx.sessionManager.getLeafId();
      const live = () => valid(scope, peer) && scope.epoch === epoch && !signal?.aborted && (!leaf || ctx.sessionManager.getBranch().some(entry => entry.id === leaf));
      const origin = [...ctx.sessionManager.getBranch()].reverse().find(entry => entry.type === "message" && entry.message.role === "user" || entry.type === "custom_message" && entry.customType === "matrix-bridge.input");
      const metadata = origin?.type === "message" ? object((origin.message as unknown as Record<string, unknown>).metadata ?? {}) : {};
      const surface = ctx.hasUI && origin?.type !== "custom_message" && typeof metadata["pi.bridge.event"] !== "string" ? "local" : "matrix";
      let view = object(await peer.request(fresh ? "project.prepare" : "task.prepare", { intent, call: `${leaf ?? "root"}:${callId}`, surface }, 30000));
      if (!live()) throw Error("Task proposal became stale before confirmation; no local approval was submitted");
      const key = taskKey(view.key), request = taskKey(view.request);
      pi.appendEntry("matrix-bridge.task-request", { nativeId: scope.nativeId, key, request });
      if (surface === "matrix" && view.phase === "approval") {
        view = object(await peer.request("task.publish-approval", { key, request }));
        if (!live()) throw Error("Native context changed after approval publication. Inspect the original poll rather than assuming cancellation.");
      }
      if (surface === "local" && view.phase === "approval") {
        const accepted = await ctx.ui.confirm(fresh ? "Create fresh project?" : "Create task workspace?", `${string(view.approvalText, 8000)}\n\nWorkspace: ${string(view.cwd)}\nNative history: ${string(view.file)}`, { signal });
        if (!live()) throw Error("Local task confirmation was withdrawn before submission");
        view = object(await peer.request("task.confirm-local", { key, request, accepted }, 60000));
        if (!live()) throw Error("Native context changed after the decision; approved creation may still complete. Inspect the original conversation.");
      }
      const message = view.localReady === true ? "Creation and saved idle native session are ready. No child model turn was started. Open locally when ready." :
        view.phase === "approval" ? "Proposal recorded. The configured operator must independently approve the original poll. No child execution was started." :
        view.phase === "declined" ? "Proposal declined or expired. No creation was dispatched by this decision." :
        typeof view.error === "string" ? string(view.error, 1000) : "Approved creation is pending; partial resources are preserved. No child model turn was started.";
      return { content: [{ type: "text", text: message }], details: view, terminate: true };
    },
  });
  pi.on("agent_start", () => {
    const scope = current;
    if (scope?.peer && valid(scope, scope.peer)) void scope.peer.request("activity", { idle: false }).catch(() => scope.peer?.close());
  });
  pi.on("agent_settled", event => {
    const scope = current;
    if (event.aborted && scope?.peer && valid(scope, scope.peer)) {
      scope.epoch++;
      void scope.peer.request("hold", {}).catch(() => scope.peer?.close());
    }
  });
  pi.on("session_start", (_event, ctx) => { start(ctx); });
  pi.on("session_shutdown", () => { stop(); });
}
