import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

// Native Pi owns execution and durable work. This driver only validates RPC
// boundaries; no model prose, lifecycle notification, or idle event is success.
export function parseHeadlessRequest(args) {
  const epic = args[0]?.match(/^#?([1-9]\d*)$/);
  if (!epic || !Number.isSafeInteger(Number(epic[1]))) throw new Error("Invalid epic");
  const values = { "--max-minutes": 60, "--settlement-minutes": 20, "--max-worker-launches": 20 };
  const seen = new Set();
  for (let i = 1; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    if (!Object.hasOwn(values, key) || seen.has(key) || !/^\d+$/.test(value ?? "")) throw new Error("Invalid option");
    const max = key === "--max-minutes" ? 240 : key === "--settlement-minutes" ? 60 : 20;
    if (Number(value) < 1 || Number(value) > max) throw new Error("Invalid bound");
    seen.add(key); values[key] = Number(value);
  }
  return { epic: Number(epic[1]), command: `/aloop #${epic[1]} ${Object.entries(values).flatMap(([key, value]) => [key, value]).join(" ")}`, timeoutMs: (values["--max-minutes"] + values["--settlement-minutes"] + 2) * 60_000 };
}

export function runHeadless({ launcher, request, cwd = process.cwd(), env = process.env, signal, graceMs = 40_000 }) {
  const invocationId = randomBytes(16).toString("hex");
  const record = (status) => ({ version: 1, invocationId, epic: request.epic, status });
  return new Promise((resolveResult) => {
    let terminal, result, buffer = "", bytes = 0, started = false, settled = false, exited = false;
    let stopTimer, missingTimer;
    const child = spawn(launcher[0], [...launcher.slice(1), "--mode", "rpc", "--no-session"], { cwd, env: { ...env, PI_ALOOP_INVOCATION_ID: invocationId }, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    const send = (command) => { if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.write(`${JSON.stringify(command)}\n`); };
    const finish = (status) => {
      if (result) return;
      result = record(status);
      clearTimeout(deadline); clearTimeout(startup); clearTimeout(missingTimer);
      signal?.removeEventListener("abort", cancel);
      send({ id: "abort", type: "abort" });
      if (settled || !started || status === "startup-failed") child.stdin.end();
      stopTimer = setTimeout(() => {
        if (!exited && child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* already exited */ } }
      }, graceMs);
    };
    const cancel = () => finish("cancelled");
    const deadline = setTimeout(() => finish("driver-timeout"), request.timeoutMs);
    const startup = setTimeout(() => finish("startup-failed"), 30_000);
    child.stdout.setEncoding("utf8");
    child.stderr.resume(); // Never echo provider errors, tool output, or credentials.
    child.stdin.on("error", () => finish("rpc-failed"));
    child.stdout.on("data", (chunk) => {
      bytes += Buffer.byteLength(chunk);
      buffer += chunk;
      if (bytes > 64 * 1024 * 1024 || Buffer.byteLength(buffer) > 1024 * 1024) { buffer = ""; finish("rpc-overflow"); return; }
      while (buffer.includes("\n")) {
        const end = buffer.indexOf("\n"), line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let event;
        try { event = JSON.parse(line); } catch { finish("rpc-malformed"); continue; }
        if (!event || typeof event !== "object" || Array.isArray(event)) { finish("rpc-malformed"); continue; }
        if (result) {
          if (event.type === "agent_settled") { settled = true; child.stdin.end(); }
          if (event.type === "response" && event.id === "abort") send({ id: "stopped", type: "get_state" });
          if (event.type === "response" && event.id === "stopped" && event.success && event.data?.isStreaming === false) child.stdin.end();
          continue;
        }
        if (event.type === "response" && event.id === "commands") {
          if (started) { finish("rpc-malformed"); continue; }
          if (!event.success || !Array.isArray(event.data?.commands) || !event.data.commands.some((command) => command?.name === "aloop" && command.source === "extension")) { finish("unsupported-launcher"); continue; }
          clearTimeout(startup); started = true;
          send({ id: "start", type: "prompt", message: request.command });
        }
        if (event.type === "response" && event.id === "start" && !event.success) finish("startup-failed");
        if (event.type === "message_end" && event.message?.role === "custom" && event.message.customType === "aloop-terminal-outcome") {
          const value = event.message.details;
          if (!started || value?.version !== 1 || value.invocationId !== invocationId || value.epic !== request.epic || !["completed", "incomplete", "decision-required", "cancelled", "budget-exhausted", "startup-failed"].includes(value.status)) { finish("invalid-outcome"); continue; }
          if (terminal && terminal.status !== value.status) { finish("conflicting-outcome"); continue; }
          terminal = value;
          if (settled || value.status === "startup-failed") finish(value.status);
        }
        if (event.type === "agent_settled") {
          settled = true;
          if (result) child.stdin.end();
          else if (terminal) finish(terminal.status);
          else missingTimer = setTimeout(() => finish(terminal?.status ?? "missing-outcome"), 100);
        }
      }
    });
    child.on("error", () => { exited = true; finish("spawn-failed"); });
    child.on("close", (code) => {
      exited = true;
      clearTimeout(deadline); clearTimeout(startup); clearTimeout(stopTimer); clearTimeout(missingTimer);
      signal?.removeEventListener("abort", cancel);
      const final = signal?.aborted ? record("cancelled") : result ?? record("missing-outcome");
      resolveResult(code !== 0 && final.status === "completed" ? record("process-failed") : final);
    });
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    else send({ id: "commands", type: "get_commands" });
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  try {
    const request = parseHeadlessRequest(process.argv.slice(2));
    const launcher = process.env.PI_ALOOP_LAUNCHER;
    if (!launcher || process.platform === "win32") throw new Error("Unsupported launcher");
    const outcome = await runHeadless({ launcher: [launcher], request, signal: controller.signal });
    console.log(JSON.stringify(outcome));
    process.exitCode = outcome.status === "completed" ? 0 : 2;
  } catch { console.log(JSON.stringify({ version: 1, status: "invalid-request" })); process.exitCode = 2; }
}
