import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { allowedWorkspace, connect, object, Peer, remoteText, string } from "./wire.js";

export type AdapterConfig = { socket: string; roots: string[] };
type Scope = { ctx: ExtensionContext; file: string; nativeId: string; boundary: string; active: boolean; stopping?: boolean; peer?: Peer; timer?: NodeJS.Timeout; seen: Set<string>; inputs: Set<string>; preflight: Set<string>; settled: Set<string> };
export function interactiveProcess(): boolean {
  const args = process.argv.slice(1);
  return Boolean(process.stdin.isTTY && process.stdout.isTTY) && !args.some(arg => ["--print", "-p", "--no-session"].includes(arg)) && !args.includes("--mode") && !args.some(arg => arg.startsWith("--mode="));
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
    return { socket: string(value.socket), roots: value.roots.map(root => string(root)) };
  };
  const stop = () => {
    if (!current) return;
    current.active = false; clearTimeout(current.timer); current.peer?.close(); current = undefined;
  };
  const valid = (scope: Scope, peer?: Peer): boolean => current === scope && scope.active && (!peer || scope.peer === peer && !peer.socket.destroyed) &&
    scope.ctx.sessionManager.getSessionId() === scope.nativeId && scope.ctx.sessionManager.getSessionFile() === scope.file;
  const status = (scope: Scope, message: string) => { if (valid(scope)) scope.ctx.ui.setStatus("matrix-bridge", message); };
  const activity = async (scope: Scope, peer: Peer) => {
    const idle = scope.ctx.isIdle() && !scope.ctx.hasPendingMessages();
    if (idle) for (const id of scope.inputs) if (!scope.preflight.has(id)) scope.settled.add(id);
    const settled = [...scope.settled].slice(0, 128);
    const view = object(await peer.request("activity", { idle, settled }));
    status(scope, view.syncError || view.error ? "Bridge connected · remote delivery needs attention" : view.room ? "Matrix bridge connected" : "Bridge connected · room setup pending");
    for (const id of settled) { scope.inputs.delete(id); scope.settled.delete(id); }
  };
  const attach = async (scope: Scope, cfg: AdapterConfig): Promise<void> => {
    if (!valid(scope)) return;
    try {
      const peer = await connect(cfg.socket, async (method, params) => {
        if (!valid(scope, peer)) throw Error("Native session changed or bridge disconnected");
        if (method !== "input") throw Error("Unknown native adapter operation");
        const id = string(params.id, 255);
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
        const input = object(JSON.parse(serialized));
        const text = string(input.text, Number.MAX_SAFE_INTEGER), sender = string(input.sender, 255);
        if (!valid(scope, peer) || scope.stopping) throw Error("Input connection changed or native stop is pending");
        if (input.control !== undefined) {
          if (input.control !== "abort" && input.control !== "stop") throw Error("Unknown native control");
          scope.ctx.abort();
          if (input.control === "stop") {
            scope.stopping = true;
            setTimeout(() => { if (valid(scope)) scope.ctx.shutdown(); }, 0);
          }
          return { accepted: true, stopping: scope.stopping === true }; // Requested, not an external-effect completion receipt.
        }
        scope.inputs.add(id); scope.preflight.add(id);
        return await new Promise<{ accepted: boolean }>((resolve, reject) => {
          const timer = setTimeout(() => reject(Error("Native preflight did not settle")), 8000);
          // The callback is a native dispatch/preflight result, never a claim
          // about completion or external tool effects.
          const delivery: NonNullable<Parameters<ExtensionAPI["sendUserMessage"]>[1]> & { preflightResult: (success: boolean) => void; userMessageMetadata: Readonly<Record<string, string>> } = {
            deliverAs: input.deliverAs === "followUp" ? "followUp" : "steer", expandPromptTemplates: true,
            onPromptExpanded: expanded => remoteText(sender, id, expanded),
            userMessageMetadata: { "pi.bridge.event": id, "pi.bridge.sender": sender },
            preflightResult: accepted => { clearTimeout(timer); scope.preflight.delete(id); if (!accepted) scope.inputs.delete(id); resolve({ accepted }); },
            onQueuedMessageRemoved: () => {
              scope.inputs.delete(id); scope.preflight.delete(id); scope.settled.delete(id);
              if (valid(scope) && scope.peer) void scope.peer.request("withdrawn", { id }).catch(() => {});
            },
          };
          try { pi.sendUserMessage(text, delivery); }
          catch (error) { clearTimeout(timer); reject(error); }
        });
      });
      if (!valid(scope)) { peer.close(); return; }
      scope.peer = peer;
      peer.on("close", () => { if (valid(scope)) { scope.peer = undefined; status(scope, "Matrix offline · local Pi available"); } });
      const registration = object(await peer.request("register", { file: scope.file, nativeId: scope.nativeId, boundary: scope.boundary, title: scope.ctx.sessionManager.getSessionName() ?? basename(scope.ctx.cwd), idle: scope.ctx.isIdle(), stopping: scope.stopping === true }));
      if (!valid(scope, peer)) { peer.close(); return; }
      status(scope, registration.room ? "Matrix bridge connected" : "Bridge connected · room setup pending");
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
    if (!eligible()) {
      // An explicitly resumed formerly public file must not leak a worker's
      // new output through the daemon's persisted-history reader either.
      const nativeId = ctx.sessionManager.getSessionId();
      if (ctx.sessionManager.getSessionFile() && ctx.sessionManager.getEntries().some(entry => entry.type === "custom" && entry.customType === "matrix-bridge.boundary" && (entry.data as { nativeId?: unknown })?.nativeId === nativeId)) {
        pi.appendEntry("matrix-bridge.enrollment", { nativeId, enabled: false });
      }
      return;
    }
    try {
      const cfg = config(); if (!cfg) return;
      allowedWorkspace(ctx.cwd, cfg.roots);
      const file = ctx.sessionManager.getSessionFile(); if (!file) return;
      const nativeId = ctx.sessionManager.getSessionId(), enabled = process.env.PI_BRIDGE_LOCAL_ONLY !== "1";
      const entries = ctx.sessionManager.getEntries();
      const enrollment = [...entries].reverse().find(entry => entry.type === "custom" && entry.customType === "matrix-bridge.enrollment" && (entry.data as { nativeId?: unknown })?.nativeId === nativeId);
      if (!enrollment || (enrollment.type === "custom" && (enrollment.data as { enabled?: unknown })?.enabled !== enabled)) pi.appendEntry("matrix-bridge.enrollment", { nativeId, enabled });
      if (!enabled) { ctx.ui.setStatus("matrix-bridge", "Local-only Pi"); return; }
      let boundary = entries.find(entry => entry.type === "custom" && entry.customType === "matrix-bridge.boundary" && (entry.data as { nativeId?: unknown })?.nativeId === nativeId)?.id;
      if (!boundary) { pi.appendEntry("matrix-bridge.boundary", { nativeId }); boundary = ctx.sessionManager.getLeafId() ?? undefined; }
      if (!boundary) throw Error("Native session has no persisted boundary");
      const scope: Scope = { ctx, file, nativeId, boundary, active: true, seen: new Set(), inputs: new Set(), preflight: new Set(), settled: new Set() };
      current = scope; void attach(scope, cfg);
    } catch { ctx.ui.setStatus("matrix-bridge", "Matrix offline · local Pi available"); }
  };
  pi.on("session_start", (_event, ctx) => { start(ctx); });
  pi.on("session_shutdown", () => { stop(); });
}
