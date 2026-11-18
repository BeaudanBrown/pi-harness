import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { appendFileSync, chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { BridgeStore } from "../config/agent/extensions/matrix-bridge/store.js";
import { BridgeRelay } from "../config/agent/extensions/matrix-bridge/relay.js";
import { BridgeMatrix } from "../config/agent/extensions/matrix-bridge/matrix.js";
import { MatrixHttp } from "../config/agent/extensions/matrix-shared/http.js";
import { InteractionHttp, ROOM, USER, textEvent } from "./fixtures/matrix-bridge/interaction-http.js";
import { POLL_START, POLL_RESPONSE } from "../config/agent/extensions/matrix-bridge/interaction.js";
import { connect, object, Peer, remoteText } from "../config/agent/extensions/matrix-bridge/wire.js";
import { imageInfo } from "../config/agent/extensions/matrix-bridge/media.js";
import { localTasks } from "../config/agent/extensions/matrix-bridge/local-process.js";

export async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  const end = Date.now() + 8000;
  while (!await check()) { if (Date.now() > end) throw Error("Native bridge test condition timed out"); await new Promise(resolve => setTimeout(resolve, 20)); }
}
export function piProcess(root: string, file: string, extension: string, extra: string[] = [], directories: { cwd?: string; home?: string; log?: string } = {}) {
  const executable = process.env.PI_BRIDGE_TEST_PI;
  assert.ok(executable, "the actual packaged Pi is required; no skipped runtime evidence");
  const home = directories.home ?? join(root, "home"), log = directories.log ?? root; mkdirSync(home, { recursive: true }); mkdirSync(log, { recursive: true });
  // Existing conversation fixture: upstream does not flush custom-only histories.
  if (existsSync(file)) {
    const rows = readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line));
    if (!rows.some(entry => entry.type === "message" || entry.customType === "matrix-bridge.boundary")) {
      appendFileSync(file, JSON.stringify({ type: "message", id: "seed", parentId: rows.at(-1)?.id ?? null, timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text: "Private pre-enrollment fixture" }], api: "bridge-probe-api", provider: "bridge-probe", model: "fake", stopReason: "stop", timestamp: 1, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } }) + "\n");
    }
  }
  const child = spawn(executable, ["--mode", "rpc", "--session", file, "--no-extensions", "--no-skills", "--no-context-files", "--no-builtin-tools", "--extension", extension,
    "--extension", resolve("tests/fixtures/matrix-bridge/native-probe.mjs"), "--provider", "bridge-probe", "--model", "fake", ...extra], {
    cwd: directories.cwd ?? root, env: { HOME: home, PATH: process.env.PATH, TERM: "xterm-256color", PI_CODING_AGENT_DIR: join(home, ".pi"), PI_SESSION_LOCK_DIRECTORY: join(root, "locks"), BRIDGE_PROBE_PERSISTENCE_LOG: join(log, "persistence.jsonl"), BRIDGE_PROBE_MODEL_LOG: join(log, "modelcalls.jsonl") },
  });
  const pending = new Map<string, { resolve: (event: Record<string, unknown>) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  let buffer = "", stderr = "", next = 0;
  const ui: Record<string, unknown>[] = [], queues: Record<string, unknown>[] = [];
  child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-8000); });
  child.stdout.on("data", chunk => {
    buffer += String(chunk);
    for (;;) {
      const end = buffer.indexOf("\n"); if (end < 0) return;
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      let event: Record<string, unknown>; try { event = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      if (event.type === "extension_ui_request" && event.method === "confirm") ui.push(event);
      if (event.type === "queue_update") queues.push(event);
      if (event.type === "response") { const item = pending.get(String(event.id)); if (item) { clearTimeout(item.timer); pending.delete(String(event.id)); item.resolve(event); } }
    }
  });
  const failPending = (error: Error) => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); } pending.clear(); };
  child.once("exit", () => failPending(Error(`Native Pi exited: ${stderr}`)));
  child.once("error", failPending);
  // Idle RPC shutdown may close stdin before the exit event is observed. The
  // next checkpoint rejects normally; an unhandled EPIPE is not test evidence.
  child.stdin.on("error", failPending);
  const send = (type: string, extra: Record<string, unknown> = {}) => new Promise<Record<string, unknown>>((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) { reject(Error(`Native Pi already exited: ${stderr}`)); return; }
    const id = String(++next), timer = setTimeout(() => { pending.delete(id); reject(Error(`Native Pi RPC timed out: ${stderr}`)); }, 10000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ id, type, ...extra }) + "\n", error => { if (error) failPending(error); });
  });
  return { child, send, ui, queues, confirm: (id: unknown, confirmed: boolean) => child.stdin.write(JSON.stringify({ type: "extension_ui_response", id, confirmed }) + "\n"), stop: async () => { if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; } } };
}

