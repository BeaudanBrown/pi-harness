import { Type } from "typebox";
import { isAbsolute } from "node:path";
import { hostname } from "node:os";
import { object, string } from "./wire.js";

/** Bounded, generated explanation safe for a room; never subprocess output. */
export class TaskFailure extends Error {}
export const TaskWorkspaceSchema = Type.Object({
  branch: Type.String({ minLength: 1, maxLength: 160, description: "New task branch; existing unrelated branches are never adopted." }),
  base_ref: Type.String({ minLength: 1, maxLength: 255, description: "Explicit local base ref; resolved and frozen to a commit before approval." }),
  title: Type.String({ minLength: 1, maxLength: 160, description: "Visible title for the new idle task conversation." }),
  handoff_summary: Type.String({ minLength: 1, maxLength: 6000, description: "Explicit visible plan only. Do not copy hidden history, tool output, credentials or approvals. This does not start execution." }),
}, { additionalProperties: false });
export const CreateProjectSchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 64, description: "New standalone repository name under the configured projects root." }),
  description: Type.String({ minLength: 1, maxLength: 1200, description: "Public README description. No secrets, commands or copied source history." }),
  handoff_summary: Type.String({ minLength: 1, maxLength: 6000, description: "Explicit visible handoff only. The saved child stays idle; no Pi process is launched." }),
}, { additionalProperties: false });
export type ProjectIntent = { name: string; description: string; root: string };
export type TaskIntent = { branch: string; base_ref: string; title: string; handoff_summary: string; project?: ProjectIntent };
export function projectIntent(value: unknown, root: string): TaskIntent {
  const input = object(value);
  if (Object.keys(input).length !== 3 || !["name", "description", "handoff_summary"].every(key => Object.hasOwn(input, key))) throw Error("Project creation accepts only name, description and handoff_summary");
  const name = string(input.name, 64), description = string(input.description, 1200), handoff_summary = string(input.handoff_summary, 6000);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name) || !description.trim() || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(description) || !handoff_summary.trim() || handoff_summary.includes("\0")) throw Error("Invalid project intent");
  return { branch: "main", base_ref: "main", title: name, handoff_summary, project: { name, description, root: taskPath(root) } };
}
export type TaskSource = { key: string; file: string; nativeId: string; cwd: string };
export type TaskPlan = { version: 1; key: string; source: TaskSource; intent: TaskIntent; base: string; common: string; sourceRoot: string; container: string; worktree: string; nativeFile: string; nativeId: string; createdAt?: string };
export type TaskLocalResult = { file: string; nativeId: string; cwd: string; boundary: string };
export type TaskRecord = { plan: TaskPlan; phase: "approval" | "approved" | "creating" | "ready" | "complete" | "declined" | "failed";
  request: { id: string; surface: "local" | "matrix"; expires: number; operator?: string; interaction?: string };
  approval?: { via: "local-ui" | "matrix"; at: number; sender?: string; event?: string };
  child?: string; stage?: string; error?: string };
export type TaskStatus = { key: string; phase: TaskRecord["phase"]; request: string; approvalText: string;
  localReady: boolean; remotePending: boolean; room?: string; file?: string; cwd?: string; error?: string };

export function taskIntent(value: unknown): TaskIntent {
  const input = object(value);
  if (input.project !== undefined) {
    const project = object(input.project);
    const result = projectIntent({ name: project.name, description: project.description, handoff_summary: input.handoff_summary }, taskPath(project.root));
    if (Object.keys(input).length !== 5 || Object.keys(project).length !== 3 || input.branch !== "main" || input.base_ref !== "main" || input.title !== result.title) throw Error("Invalid frozen project intent");
    return result;
  }
  const fields = ["branch", "base_ref", "title", "handoff_summary"];
  if (Object.keys(input).length !== fields.length || fields.some(field => !Object.hasOwn(input, field))) throw Error("Task creation accepts only branch, base_ref, title and handoff_summary");
  const intent = { branch: string(input.branch, 160), base_ref: string(input.base_ref, 255), title: string(input.title, 160), handoff_summary: string(input.handoff_summary, 6000) };
  if (Object.values(intent).some(text => !text.trim() || text.includes("\0")) || /[\s\x00-\x1f\x7f]/.test(intent.branch) || /[\x00-\x1f\x7f]/.test(intent.base_ref) || /[\x00-\x1f\x7f]/.test(intent.title)) throw Error("Invalid task intent");
  return intent;
}
export function taskSource(value: unknown): TaskSource {
  const source = object(value), key = taskKey(source.key), file = taskPath(source.file), cwd = taskPath(source.cwd);
  return { key, file, cwd, nativeId: string(source.nativeId, 128) };
}
export function taskKey(value: unknown): string { const key = string(value, 64); if (!/^[a-f0-9]{64}$/.test(key)) throw Error("Invalid task identity"); return key; }
export function taskPath(value: unknown): string { const path = string(value, 4095); if (!isAbsolute(path) || path.includes("\0")) throw Error("Invalid task path"); return path; }
export function taskPlan(value: unknown): TaskPlan {
  const plan = object(value), source = taskSource(plan.source), intent = taskIntent(plan.intent), base = string(plan.base, 64), nativeId = string(plan.nativeId, 128);
  if (plan.version !== 1 || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(base) || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(nativeId)) throw Error("Invalid frozen task plan");
  const createdAt = intent.project ? string(plan.createdAt, 32) : undefined;
  if (createdAt && (!Number.isFinite(Date.parse(createdAt)) || new Date(createdAt).toISOString() !== createdAt)) throw Error("Invalid project creation timestamp");
  return { version: 1, key: taskKey(plan.key), source, intent, base, nativeId, ...(createdAt ? { createdAt } : {}), common: taskPath(plan.common), sourceRoot: taskPath(plan.sourceRoot), container: taskPath(plan.container), worktree: taskPath(plan.worktree), nativeFile: taskPath(plan.nativeFile) };
}
export function taskApprovalText(plan: TaskPlan): string {
  if (plan.intent.project) return `Create a fresh project on ${hostname()}?\nRepository: ${plan.worktree}\nBranch: main\nInitial commit: Initialize project\nAuthor: Pi Project <pi-project@localhost> (repository-local only)\nREADME.md:\n# ${plan.intent.project.name}\n\n${plan.intent.project.description}\n\nSaved native history: ${plan.nativeFile}\nHandoff:\n${plan.intent.handoff_summary}\n\nNo Pi process, terminal or model turn will start. No remote, push, dependencies or hooks. Matrix room setup is asynchronous. Existing paths are never overwritten.`;
  return `Create an idle task workspace?\nBranch: ${plan.intent.branch}\nBase: ${plan.intent.base_ref} (${plan.base})\nTitle: ${plan.intent.title}\n\n${plan.intent.handoff_summary}\n\nOnly this explicit handoff is copied. The child will not run until a separate human instruction.`;
}
