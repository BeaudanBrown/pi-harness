import { randomUUID } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import { history, offerHistory } from "./history.js";
import type { Interaction } from "./interaction.js";
import { BridgeStore, identity, type Binding, type Input } from "./store.js";
import { allowedWorkspace, string } from "./wire.js";
import { TaskFailure, taskApprovalText, taskIntent, taskPlan, type TaskIntent, type TaskLocalResult, type TaskPlan, type TaskRecord, type TaskSource, type TaskStatus } from "./task-contract.js";

export interface TaskRunner {
  prepare(source: TaskSource, intent: TaskIntent, key: string, nativeId: string): Promise<TaskPlan>;
  create(plan: TaskPlan, progress: (stage: string) => void): Promise<TaskLocalResult>;
}
const notice = (body: string) => [{ type: "m.room.message", content: { msgtype: "m.notice", body, "m.mentions": {} } }];
/** Only approved resource creation. No process ownership, execution queue,
 * coordinator, cleanup or general permission-policy dispatcher. */
export class TaskWorkspaces {
  private readonly jobs = new Map<string, Promise<void>>();
  private readonly common = new Map<string, Promise<void>>();
  private stopped = false;
  constructor(private readonly store: BridgeStore, private readonly runner: TaskRunner,
    private readonly policy: { roots: string[]; operatorUserId?: string }, private readonly setupPending: (key: string) => boolean = () => true,
    private readonly now: () => number = Date.now) {}
  private source(binding: Binding): TaskSource {
    try {
      const saved = history(binding.file);
      if (saved.id !== binding.nativeId || saved.cwd !== binding.cwd || allowedWorkspace(binding.cwd, this.policy.roots) !== binding.cwd) throw Error("Changed source");
      return { key: binding.key, file: binding.file, cwd: binding.cwd, nativeId: binding.nativeId };
    } catch { throw new TaskFailure("Calling native session changed or is unavailable; inspect locally"); }
  }
  private own(binding: Binding, key: string): TaskRecord {
    const record = this.store.task(key); if (!record || record.plan.source.key !== binding.key) throw Error("Task request belongs to another native conversation"); return record;
  }
  status(binding: Binding, key: string): TaskStatus {
    const record = this.own(binding, key), child = record.child ? this.store.binding(record.child) : undefined;
    const completed = record.phase === "ready" || record.phase === "complete"; let localReady = false, error = record.error;
    if (completed) {
      try {
        const saved = history(record.plan.nativeFile);
        localReady = saved.id === record.plan.nativeId && saved.cwd === record.plan.worktree && lstatSync(record.plan.worktree).isDirectory() && realpathSync(record.plan.worktree) === record.plan.worktree;
      } catch { /* Creation is historical; filesystem availability is current. */ }
      if (!localReady) error = "Previously created native history or workspace is missing, moved or corrupt. It was not recreated; inspect locally.";
    }
    return { key, phase: record.phase, request: record.request.id, approvalText: taskApprovalText(record.plan),
      localReady, remotePending: !child?.room || this.setupPending(child.key),
      file: record.plan.nativeFile, cwd: record.plan.worktree, ...(child?.room ? { room: child.room } : {}), ...(error ? { error } : {}) };
  }
  async prepare(binding: Binding, value: unknown, call: string, surface: "local" | "matrix"): Promise<TaskStatus> {
    if (this.stopped || !binding.enabled || surface === "matrix" && binding.archived) throw Error("Task proposal is unavailable for this binding");
    if (surface === "matrix" && !this.policy.operatorUserId) throw Error("Remote task approval requires a configured operator");
    const source = this.source(binding), intent = taskIntent(value), key = identity("task", source.key, JSON.stringify(intent));
    const old = this.store.task(key), nativeId = randomUUID();
    const plan = old?.plan ?? taskPlan(await this.runner.prepare(source, intent, key, nativeId));
    if (plan.key !== key || plan.source.key !== source.key || plan.source.file !== source.file || plan.source.nativeId !== source.nativeId || plan.source.cwd !== source.cwd ||
        JSON.stringify(plan.intent) !== JSON.stringify(intent) || !old && plan.nativeId !== nativeId) throw Error("Task helper returned a different frozen intent");
    this.source(binding); allowedWorkspace(dirname(plan.container), this.policy.roots);
    if (old?.approval?.via === "matrix" && old.approval.sender !== this.policy.operatorUserId && !["ready", "complete"].includes(old.phase)) {
      // A changed operator cannot inherit an uncompleted mutation grant. Its
      // original input receipt remains in the ledger; fresh UI/vote is needed.
      this.store.saveTask({ ...old, approval: undefined, phase: "declined", request: { ...old.request, id: identity("revoked-task-request", old.request.id) } });
    }
    const record = this.store.requestTask({ plan, phase: "approval", request: { id: identity("task-request", key, string(call, 512)), surface,
      expires: this.now() + 15 * 60_000, ...(surface === "matrix" ? { operator: this.policy.operatorUserId! } : {}) } });
    // A repeated approved intent resumes its own creation, not another mutation.
    if (record.approval && ["approved", "creating", "failed"].includes(record.phase)) {
      if (record.phase === "failed") this.store.saveTask({ ...record, phase: "approved", error: undefined });
      void this.run(key);
    }
    return this.status(binding, key);
  }
  publishApproval(binding: Binding, key: string, request: string): TaskStatus {
    this.source(binding); const record = this.own(binding, key);
    if (record.request.operator !== this.policy.operatorUserId || record.request.id !== request) throw new TaskFailure("Task approval authority or request changed");
    // The native caller rechecks its live call after asynchronous preparation.
    // Project its originating user entry BEFORE publishing the new poll, so a
    // later history pump cannot mistake that earlier input for cancellation.
    offerHistory(this.store, binding);
    this.store.publishTaskApproval(key, request, this.now()); return this.status(binding, key);
  }
  async confirmLocal(binding: Binding, key: string, request: string, accepted: boolean): Promise<TaskStatus> {
    this.source(binding); const record = this.own(binding, key);
    if (record.request.id !== request || record.request.surface !== "local") throw Error("Local confirmation is stale or belongs to another approval surface");
    if (!record.approval && !this.store.decideTask(key, request, accepted, { via: "local-ui", at: this.now() })) throw Error("Local confirmation expired or was withdrawn");
    if (accepted) await this.run(key);
    return this.status(binding, key);
  }
  async answer(binding: Binding, input: Input, interaction: Interaction, accepted: boolean): Promise<void> {
    const ignore = () => { this.store.authorize(input.id, undefined); };
    const record = interaction.approval ? this.store.task(interaction.approval) : undefined, sender = input.event.sender;
    if (!record || record.plan.source.key !== binding.key || record.request.interaction !== interaction.id || sender !== this.policy.operatorUserId || record.request.operator !== this.policy.operatorUserId) return ignore();
    try { this.source(binding); } catch { this.store.finishInput(binding.key, input.id, "The source native session is unavailable. No task workspace was created."); return; }
    if (!this.store.decideTask(record.plan.key, record.request.id, accepted, { via: "matrix", sender: String(sender), event: input.id, at: this.now() }, input.id)) return ignore();
    if (accepted) void this.run(record.plan.key);
  }
  run(key: string): Promise<void> {
    const active = this.jobs.get(key); if (active) return active;
    const record = this.store.task(key); if (!record?.approval || !["approved", "creating", "failed"].includes(record.phase) || this.stopped) return Promise.resolve();
    const common = record.plan.common, previous = this.common.get(common) ?? Promise.resolve();
    const work = previous.catch(() => {}).then(async () => {
      if (this.stopped) return;
      const current = this.store.task(key)!;
      try {
        const binding = this.store.binding(current.plan.source.key); if (!binding) throw Error("Missing source");
        this.source(binding); allowedWorkspace(dirname(current.plan.container), this.policy.roots);
        if (current.approval?.via === "matrix" && current.approval.sender !== this.policy.operatorUserId) throw Error("Operator authority changed");
        this.store.saveTask({ ...current, phase: "creating", error: undefined });
        const result = await this.runner.create(current.plan, stage => {
          if (!["container", "branch", "worktree", "session"].includes(stage)) throw Error("Unknown task effect receipt");
          this.store.saveTask({ ...this.store.task(key)!, stage });
        });
        if (result.file !== current.plan.nativeFile || result.nativeId !== current.plan.nativeId || result.cwd !== current.plan.worktree ||
            allowedWorkspace(result.cwd, this.policy.roots) !== result.cwd) throw Error("Task helper changed native identity");
        const saved = history(result.file);
        if (saved.id !== result.nativeId || saved.cwd !== result.cwd || !saved.entries.some(entry => entry.id === result.boundary && entry.type === "custom" && entry.customType === "matrix-bridge.boundary" && entry.data?.nativeId === result.nativeId)) throw Error("Task native boundary is missing");
        const childKey = identity("binding", result.file, result.nativeId);
        const child = this.store.binding(childKey) ?? this.store.register({ ...result, title: current.plan.intent.title, boundary: saved.entries.at(-1)?.id ?? result.boundary });
        this.store.offer(child.key, `task-handoff:${key}`, () => notice(`Task handoff: ${current.plan.intent.title}\n\n${current.plan.intent.handoff_summary}\n\nNo model turn was started. Send a separate fresh instruction when ready.`));
        this.store.offer(binding.key, `task-local:${key}`, () => notice(`Task workspace and native session ready: ${current.plan.intent.title}\nBranch: ${current.plan.intent.branch}\nThe child was created without a model turn. Matrix organization runs independently; its room link will follow.`));
        this.store.saveTask({ ...this.store.task(key)!, phase: "ready", child: child.key, error: undefined });
      } catch (error) {
        const failed = this.store.task(key)!, reason = error instanceof TaskFailure ? error.message : "Local task creation was not confirmed.";
        this.store.saveTask({ ...failed, phase: "failed", error: `${reason} Existing partial resources are retained; inspect locally or retry the exact intent. No force/reset/removal was performed.` });
        this.store.offer(failed.plan.source.key, `task-failed:${key}:${failed.request.id}`, () => notice(`${reason}\nAny owned partial resources were retained; no task execution was started. Inspect locally or retry the exact request.`));
      }
    }).finally(() => { this.jobs.delete(key); if (this.common.get(common) === work) this.common.delete(common); });
    this.jobs.set(key, work); this.common.set(common, work); return work;
  }
  async pump(): Promise<void> {
    if (this.stopped) return;
    for (const record of this.store.tasks(["approval"])) if (record.request.expires < this.now() || record.request.interaction && this.store.interaction(record.request.interaction)?.state !== "active") {
      if (record.request.interaction) this.store.cancelInteractions(record.plan.source.key, record.request.interaction);
      this.store.saveTask({ ...record, phase: "declined" });
    }
    for (const record of this.store.tasks(["approved", "creating"])) { if (this.jobs.size >= 8) break; void this.run(record.plan.key); }
    for (const record of this.store.tasks(["ready"])) {
      const room = record.child ? this.store.binding(record.child)?.room : undefined; if (!room) continue;
      this.store.offer(record.plan.source.key, `task-room:${record.plan.key}`, () => notice(`Task conversation: ${record.plan.intent.title}\nhttps://matrix.to/#/${encodeURIComponent(room)}\nRoom creation is confirmed; grouping/invitation setup may still be pending. Opening the session does not start a model turn.`));
      this.store.saveTask({ ...record, phase: "complete" });
    }
  }
  async stop(): Promise<void> { this.stopped = true; await Promise.all([...this.jobs.values()]); }
}
