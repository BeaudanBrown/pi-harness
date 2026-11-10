import { chmodSync, lstatSync, mkdirSync, realpathSync, unlinkSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { dirname, join } from "node:path";
import nativeLock from "./session-lock.cjs";
import { BridgeStore, type Binding } from "./store.js";
import { history, offerHistory } from "./history.js";
import { allowedWorkspace, connect, object, Peer, string, type ObjectValue } from "./wire.js";
import { BridgeMatrix, syncIntoStore } from "./matrix.js";
import { BridgeOrganization } from "./organization.js";
import { authorizeInput } from "./input.js";
import { TaskWorkspaces, type TaskRunner } from "./tasks.js";
import { taskKey } from "./task-contract.js";

export type RelayConfig = { hostId: string; stateDirectory: string; socket: string; roots: string[]; operatorUserId?: string; hostSpace?: boolean };
type Attachment = { peer: Peer; idle: boolean; key: string; stopping?: boolean };
const running = new Set<string>();
/** Single daemon, native-session routing and transactional delivery only. */
export class BridgeRelay {
  readonly store: BridgeStore;
  readonly organization?: BridgeOrganization;
  readonly tasks?: TaskWorkspaces;
  private release: () => void;
  private server?: Server;
  private readonly peers = new Set<Peer>();
  private readonly attached = new Map<string, Attachment>();
  private readonly roomWork = new Set<string>();
  private readonly failures = new Map<string, string>();
  private readonly retryAt = new Map<string, number>();
  private readonly stopSignal = new AbortController();
  private interval?: NodeJS.Timeout;
  private syncWork?: Promise<void>;
  private syncError?: string;
  constructor(readonly config: RelayConfig, readonly matrix: BridgeMatrix, private readonly open: (binding: Binding) => Promise<unknown>, taskRunner?: TaskRunner) {
    mkdirSync(config.stateDirectory, { recursive: true, mode: 0o700 });
    const directory = lstatSync(config.stateDirectory);
    if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid!() || (directory.mode & 0o077)) throw Error("Bridge state directory must be private");
    const key = realpathSync(config.stateDirectory);
    if (running.has(key)) throw Error("Bridge is already running in this process");
    const unlock = nativeLock.acquireSessionLock(join(key, "daemon-owner"));
    running.add(key);
    this.release = () => { unlock(); running.delete(key); };
    try { this.store = new BridgeStore(join(key, "bridge.sqlite"), config.hostId); }
    catch (error) { this.release(); throw error; }
    try {
      if (config.operatorUserId) this.organization = new BridgeOrganization(this.store, matrix.http, { hostId: config.hostId, botUserId: matrix.userId, operatorUserId: config.operatorUserId, hostSpace: config.hostSpace });
      if (taskRunner) this.tasks = new TaskWorkspaces(this.store, taskRunner, config, key => this.organization?.status(key).stage !== "ready");
    } catch (error) { this.store.close(); this.release(); throw error; }
  }
  async start(background = true): Promise<void> {
    const directory = dirname(this.config.socket);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid!() || (info.mode & 0o077)) throw Error("Bridge socket directory must be private");
    try {
      const endpoint = lstatSync(this.config.socket);
      if (!endpoint.isSocket() || endpoint.uid !== process.getuid!()) throw Error("Unsafe existing bridge socket");
      // The kernel daemon lock was acquired before touching a stale endpoint.
      unlinkSync(this.config.socket);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    this.server = createServer(socket => {
      if (this.peers.size >= 128) { socket.destroy(); return; }
      let key: string | undefined;
      const peer = new Peer(socket, async (method, params) => {
        if (this.stopSignal.signal.aborted) throw Error("Bridge is stopping");
        if (method === "list") return this.store.bindings().map(binding => this.status(binding));
        if (method === "status") {
          const binding = this.store.binding(string(params.key, 64));
          if (!binding) throw Error("Unknown native binding"); return this.status(binding);
        }
        if (method === "register") {
          const file = realpathSync(string(params.file));
          const metadata = lstatSync(file);
          if (!metadata.isFile() || metadata.nlink !== 1 || metadata.uid !== process.getuid!()) throw Error("Native session must be a user-owned regular file");
          const saved = history(file), nativeId = string(params.nativeId, 128);
          if (saved.id !== nativeId) throw Error("Native session identity mismatch");
          const cwd = allowedWorkspace(saved.cwd, this.config.roots);
          const boundary = string(params.boundary, 128);
          if (!saved.entries.some(entry => entry.id === boundary && entry.type === "custom" && entry.customType === "matrix-bridge.boundary" && entry.data?.nativeId === nativeId)) throw Error("Missing persisted native enrollment boundary");
          // For a genuinely new binding, cut at the current persisted tail.
          // A copied/old native marker is not permission to backfill history.
          // Existing bindings retain their original database boundary.
          const binding = this.store.register({ file, nativeId, cwd, boundary: saved.entries.at(-1)?.id ?? boundary, title: string(params.title, 512) });
          if (key && key !== binding.key) throw Error("A connection cannot switch native sessions");
          if (!key) {
            this.store.disconnect(binding.key);
            this.attached.get(binding.key)?.peer.close();
            key = binding.key; this.attached.set(key, { peer, key, idle: params.idle === true, stopping: params.stopping === true });
          }
          return this.status(binding);
        }
        if (!key || this.attached.get(key)?.peer !== peer) throw Error("Native session registration required");
        if (["task.prepare", "task.publish-approval", "task.confirm-local", "task.status"].includes(method)) {
          if (!this.tasks || this.attached.get(key)?.stopping) throw Error("Task workspace creation is unavailable; local Pi remains available");
          const binding = this.store.binding(key)!;
          if (method === "task.prepare") {
            if (params.surface !== "local" && params.surface !== "matrix") throw Error("Invalid independent approval surface");
            return this.tasks.prepare(binding, params.intent, string(params.call, 512), params.surface);
          }
          if (method === "task.publish-approval") return this.tasks.publishApproval(binding, taskKey(params.key), taskKey(params.request));
          if (method === "task.confirm-local") {
            if (typeof params.accepted !== "boolean") throw Error("A local UI decision is required");
            return this.tasks.confirmLocal(binding, taskKey(params.key), taskKey(params.request), params.accepted);
          }
          return this.tasks.status(binding, taskKey(params.key));
        }
        if (method === "input.read") return this.store.inputChunk(key, string(params.id, 255), Number(params.offset));
        if (method === "image.read") return this.store.imageChunk(key, string(params.id, 255), Number(params.offset));
        if (method === "withdrawn") { this.store.interruptInput(key, string(params.id, 255)); return {}; }
        if (method === "activity") {
          this.attached.get(key)!.idle = params.idle === true;
          if (params.idle === true && Array.isArray(params.settled)) {
            for (const id of params.settled.slice(0, 128)) this.store.settle(key, string(id, 255));
          }
          return this.status(this.store.binding(key)!);
        }
        throw Error("Unknown bridge operation");
      });
      this.peers.add(peer);
      peer.on("close", () => {
        this.peers.delete(peer);
        if (key && this.attached.get(key)?.peer === peer) {
          this.attached.delete(key);
          if (!this.stopSignal.signal.aborted) this.store.disconnect(key);
        }
      });
    });
    await new Promise<void>((resolve, reject) => { this.server!.once("error", reject); this.server!.listen(this.config.socket, () => { chmodSync(this.config.socket, 0o600); resolve(); }); });
    if (background) {
      this.interval = setInterval(() => { void this.pump(); void this.organization?.pump().catch(() => {}); }, 500);
      this.syncWork = this.syncLoop();
    }
  }
  private status(binding: Binding): ObjectValue {
    const current = this.attached.get(binding.key);
    return { ...binding, intakeReady: this.store.cursor() !== undefined, ...(this.organization ? { setup: this.organization.status(binding.key) } : {}), runtime: current ? current.stopping ? "stopping" : current.idle ? "idle" : "running" : "detached", input: this.store.status(binding.key), error: this.failures.get(binding.key) ?? null, syncError: this.syncError ?? null, syncGap: Boolean(binding.room && this.store.progress(`gap:${binding.room}`)) };
  }
  private async syncLoop(): Promise<void> {
    while (!this.stopSignal.signal.aborted) {
      try { await this.syncOnce(); }
      catch { /* Matrix outage is not a local-launch condition. */ }
      if (!this.stopSignal.signal.aborted) await new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); this.stopSignal.signal.removeEventListener("abort", done); resolve(); };
        const timer = setTimeout(done, 1000); this.stopSignal.signal.addEventListener("abort", done, { once: true });
      });
    }
  }
  async syncOnce(): Promise<Array<{ room: string; error: string }>> {
    try {
      const errors = await syncIntoStore(this.matrix, this.store, this.stopSignal.signal);
      this.syncError = errors.length ? `${errors.length} room history interval(s) pending` : undefined;
      return errors;
    } catch (error) { this.syncError = error instanceof Error ? error.message : "Matrix sync failed"; throw error; }
  }
  async pump(): Promise<void> {
    if (this.stopSignal.signal.aborted) return;
    await this.tasks?.pump();
    await Promise.all(this.store.bindings().map(async binding => {
      if (this.roomWork.has(binding.key) || (this.retryAt.get(binding.key) ?? 0) > Date.now()) return;
      this.roomWork.add(binding.key);
      try {
        // Output reads complete native file entries, not transient message_end events.
        let historyReady = true;
        try { offerHistory(this.store, binding); }
        catch (error) { historyReady = false; this.failures.set(binding.key, error instanceof Error ? error.message : "Native history unavailable"); }
        binding = this.store.binding(binding.key)!;
        if (!binding.room) return;
        const gap = this.store.progress(`gap:${binding.room}`);
        for (const input of !gap && historyReady ? this.store.received(binding.key) : []) await authorizeInput(this.store, this.matrix, binding, input, this.stopSignal.signal,
          this.tasks ? (interaction, accepted) => this.tasks!.answer(binding, input, interaction, accepted) : undefined);
        if (historyReady && !gap && binding.enabled && !binding.archived) {
          const input = this.store.nextInput(binding.key);
          if (input?.state === "queued" && input.prompt) {
            if (!await this.matrix.joined(binding.room, input.prompt.sender)) this.store.interruptInput(binding.key, input.id);
            else {
              const attachment = this.attached.get(binding.key);
              if (!attachment && ["status", "abort", "stop"].includes(input.prompt.control ?? "")) {
                this.store.finishInput(binding.key, input.id, "No native adapter is connected. No stop/abort was sent and process exit is not implied. Use local Pi, or !start to open without starting a model turn.");
              } else if (!attachment) {
                allowedWorkspace(binding.cwd, this.config.roots);
                if (input.prompt.control === "start") {
                  const taken = this.store.takeInput(binding.key, input.id);
                  if (taken) try {
                    await this.open(binding);
                    this.store.finishInput(binding.key, input.id, "Local open requested. No model turn was started; a window/helper reply is not a native startup receipt.");
                  } catch (error) { this.store.interruptInput(binding.key, input.id); throw error; }
                } else await this.open(binding); // Actual native writer exclusion is in Pi, never a reservation.
              }
              else if (!attachment.stopping) {
                const taken = this.store.takeInput(binding.key, input.id);
                if (taken) {
                  if (taken.prompt?.control === "abort" || taken.prompt?.control === "stop") this.store.interruptBefore(binding.key, taken.id);
                  try {
                    const receipt = object(await attachment.peer.request("input", { id: taken.id }));
                    if (receipt.stopping === true) attachment.stopping = true;
                    if (receipt.accepted !== true) {
                      if (typeof receipt.message === "string") this.store.finishInput(binding.key, taken.id, string(receipt.message, 4096));
                      else this.store.interruptInput(binding.key, taken.id);
                    }
                  } catch (error) {
                    this.store.interruptInput(binding.key, taken.id); attachment.peer.close(); throw error;
                  }
                }
              }
            }
          }
        }
        for (const input of this.store.unreportedInputs(binding.key)) this.store.offer(binding.key, `uncertain:${input.id}`, () => [{ type: "m.room.message", content: {
          msgtype: "m.notice", body: "Input interrupted: Pi may already have acted on this message. It will not be replayed automatically. You can send a fresh instruction.",
          "m.relates_to": { "m.in_reply_to": { event_id: input.id } }, "m.mentions": {},
        } }]);
        this.store.closeInteractions(binding.key);
        // Archive never suppresses an already executing turn's output.
        if (binding.enabled) for (const output of this.store.outputs(binding.key)) this.store.sent(output.id, await this.matrix.send(binding.room, output));
        this.retryAt.delete(binding.key);
        if (historyReady) this.failures.delete(binding.key);
      } catch (error) {
        this.failures.set(binding.key, error instanceof Error ? error.message : "Bridge delivery failed");
        this.retryAt.set(binding.key, Date.now() + 5000);
      } finally { this.roomWork.delete(binding.key); }
    }));
  }
  async stop(): Promise<void> {
    if (this.stopSignal.signal.aborted) return;
    this.stopSignal.abort(); clearInterval(this.interval);
    for (const key of this.attached.keys()) this.store.disconnect(key);
    for (const peer of this.peers) peer.close();
    await this.organization?.stop();
    await this.tasks?.stop(); // Do not cancel a Git effect merely because the bridge stops.
    await this.syncWork;
    while (this.roomWork.size) await new Promise(resolve => setTimeout(resolve, 10));
    if (this.server) await new Promise<void>(resolve => this.server!.close(() => resolve()));
    this.store.close(); this.release();
    // No Pi/tmux process is stopped, signalled or replaced here.
  }
}
export { connect };
