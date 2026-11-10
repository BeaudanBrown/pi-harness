import { execFile, spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";
import type { Binding } from "./store.js";
import type { TaskRunner } from "./tasks.js";
import { TaskFailure, taskPlan } from "./task-contract.js";
import { FRAME_BYTES, object, string } from "./wire.js";

const execute = promisify(execFile);
export function localEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const key of ["HOME", "USER", "LOGNAME", "PATH", "SHELL", "TERM", "LANG", "LC_ALL", "XDG_RUNTIME_DIR", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME"]) {
    if (env[key] !== undefined) clean[key] = env[key];
  }
  return clean;
}
export function localOpen(helper: string): (binding: Binding) => Promise<unknown> {
  if (!isAbsolute(helper)) throw Error("The local open helper must be an absolute packaged executable");
  return async binding => {
    const result = await execute(helper, ["open", binding.file, "--expected-id", binding.nativeId], {
      env: localEnvironment(process.env), timeout: 15000, maxBuffer: 65536,
    });
    const value = object(JSON.parse(result.stdout));
    if (value.file !== binding.file || value.id !== binding.nativeId) throw Error("Local open returned a different native identity");
    return value;
  };
}
/** One finite helper invocation, not process/launch authority. Disconnecting a
 * caller is not cancellation of an approved Git effect. Never expose stderr. */
export function localTasks(helper: string): TaskRunner {
  if (!isAbsolute(helper)) throw Error("The task helper must be an absolute packaged executable");
  const invoke = (mode: "prepare" | "create", cwd: string, value: unknown, progress?: (stage: string) => void): Promise<Record<string, unknown>> => {
    const input = JSON.stringify(value); if (Buffer.byteLength(input) > FRAME_BYTES) throw new TaskFailure("Task request exceeds one bounded helper frame");
    return new Promise((resolve, reject) => {
      const child = spawn(helper, [mode], { cwd, env: localEnvironment(process.env), stdio: ["pipe", "pipe", "pipe"] });
      let buffer = "", frames = 0, failure: string | undefined, result: Record<string, unknown> | undefined, broken = false;
      child.stdout.setEncoding("utf8"); child.stderr.resume();
      child.stdout.on("data", (chunk: string) => {
        if (broken) return;
        buffer += chunk;
        if (Buffer.byteLength(buffer) > FRAME_BYTES) { broken = true; buffer = ""; return; }
        for (;;) {
          const end = buffer.indexOf("\n"); if (end < 0) break;
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          try {
            if (++frames > 8) throw Error("Too many frames");
            const frame = object(JSON.parse(line));
            if (frame.stage !== undefined && Object.keys(frame).length === 1 && progress && !result && !failure) progress(string(frame.stage, 16));
            else if (frame.result !== undefined && Object.keys(frame).length === 1 && !result && !failure) result = object(frame.result);
            else if (frame.error !== undefined && Object.keys(frame).length === 1 && !result && !failure) failure = string(frame.error, 500);
            else throw Error("Unexpected helper frame");
          } catch { broken = true; buffer = ""; break; }
        }
      });
      child.once("error", () => reject(new TaskFailure("Local task helper is unavailable; local Pi remains available")));
      child.stdin.on("error", () => { broken = true; });
      child.once("close", code => {
        if (code === 0 && result && !broken && !buffer && !failure) resolve(result);
        else reject(new TaskFailure(!broken && failure ? failure : "Task helper outcome is unconfirmed. Preserve partial resources and retry the exact intent."));
      });
      child.stdin.end(input);
    });
  };
  return {
    prepare: async (source, intent, key, nativeId) => taskPlan(await invoke("prepare", source.cwd, { source, intent, key, nativeId })),
    create: async (plan, progress) => {
      const result = await invoke("create", plan.source.cwd, plan, progress);
      return { file: string(result.file), nativeId: string(result.nativeId, 128), cwd: string(result.cwd), boundary: string(result.boundary, 128) };
    },
  };
}
