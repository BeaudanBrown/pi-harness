import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { renderTranscript } from "../matrix-shared/transcript-renderer.js";
import type { Binding, BridgeStore } from "./store.js";

export type NativeEntry = { type: string; id: string; nativeId?: string; customType?: string; data?: Record<string, unknown>; message?: { role: string; content: unknown; stopReason?: string; metadata?: Record<string, unknown> } };
function parseLine(line: string): unknown {
  try { return JSON.parse(line); } catch { throw Error("Malformed completed native history line; history unchanged"); }
}
export function history(file: string): { id: string; cwd: string; entries: NativeEntry[] } {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let bytes: Buffer;
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid!()) throw Error("Native history must be a user-owned regular file");
    bytes = readFileSync(fd); fsyncSync(fd);
  } finally { closeSync(fd); }
  // A writer may be in the middle of an append. Only complete physical lines
  // are eligible, and malformed completed history is never silently repaired.
  const end = bytes.lastIndexOf(10);
  if (end < 0) throw Error("Native history has no complete header");
  const lines = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end)).split("\n").filter(line => line.trim());
  const header = parseLine(lines.shift() ?? "null") as { type?: unknown; id?: unknown; cwd?: unknown; version?: unknown } | null;
  if (!header || header.type !== "session" || typeof header.id !== "string" || typeof header.cwd !== "string" || header.version !== 3) throw Error("Unsupported native session header");
  const ids = new Set<string>();
  const entries = lines.map(line => {
    const value = parseLine(line) as NativeEntry;
    if (!value || typeof value !== "object" || typeof value.id !== "string" || typeof value.type !== "string" || ids.has(value.id)) throw Error("Malformed native history entry");
    ids.add(value.id); return value;
  });
  return { id: header.id, cwd: header.cwd, entries };
}
function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter(part => part && typeof part === "object" && part.type === "text" && typeof part.text === "string").map(part => part.text).join("\n");
}
const observations = new WeakMap<BridgeStore, Map<string, string>>();
export function offerHistory(store: BridgeStore, binding: Binding): void {
  let seen = observations.get(store);
  if (!seen) { seen = new Map(); observations.set(store, seen); }
  const stat = lstatSync(binding.file, { bigint: true });
  if (!stat.isFile() || stat.nlink !== 1n || stat.uid !== BigInt(process.getuid!())) throw Error("Native history file was replaced");
  const signature = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}`;
  if (seen.get(binding.key) === signature) return;
  const saved = history(binding.file);
  if (saved.id !== binding.nativeId || realpathSync(saved.cwd) !== binding.cwd) throw Error("Native session identity changed; projection stopped");
  const boundary = binding.boundary === null ? -1 : saved.entries.findIndex(entry => entry.id === binding.boundary);
  if (binding.boundary !== null && boundary < 0) throw Error("Original projection boundary is missing");
  const last = store.progress<string>(`projection:${binding.key}`);
  const position = last === undefined ? boundary : saved.entries.findIndex(entry => entry.id === last);
  if (position < boundary || last !== undefined && position < 0) throw Error("Persisted projection position is missing");
  let enabled = binding.enabled;
  for (const entry of saved.entries.slice(position + 1)) {
    if (entry.type === "custom" && entry.customType === "matrix-bridge.enrollment" && entry.data?.nativeId === binding.nativeId && typeof entry.data.enabled === "boolean") {
      enabled = entry.data.enabled; store.setEnabled(binding.key, enabled);
    }
    if (!enabled || entry.type !== "message" || !entry.message) continue;
    const { role, content, stopReason } = entry.message;
    const text = textContent(content); if (!text) continue;
    if (role === "user") {
      const eventId = entry.message.metadata?.["pi.bridge.event"], sender = entry.message.metadata?.["pi.bridge.sender"];
      if (typeof eventId === "string" && typeof sender === "string" && store.ownsInput(binding.key, eventId, sender)) continue;
      // Never infer origin from text: locally resubmitted/restored queue text
      // is a fresh local prompt even if it retains a visible Matrix caption.
    } else if (role !== "assistant" || !["stop", "length", "toolUse"].includes(stopReason ?? "")) continue;
    const kind = role === "user" ? "local_user" : "assistant_final";
    store.offer(binding.key, `native:${entry.id}`, () => {
      try {
        return renderTranscript(kind, text).map(chunk => ({ type: "m.room.message", content: { msgtype: "m.text", body: chunk.body, format: "org.matrix.custom.html", formatted_body: chunk.formattedBody, "m.mentions": {} } }));
      } catch {
        // A rendering problem must not wedge later replies. Plain text has no
        // active markup; freeze its chunks before the first Matrix send too.
        const characters = [...(role === "user" ? `Local Pi user:\n\n${text}` : text)];
        const chunks: Array<{ type: string; content: Record<string, unknown> }> = [];
        for (let i = 0; i < characters.length; i += 1500) chunks.push({ type: "m.room.message", content: { msgtype: "m.text", body: characters.slice(i, i + 1500).join(""), "m.mentions": {} } });
        return chunks;
      }
    });
  }
  const lastId = saved.entries.at(-1)?.id;
  if (lastId) store.saveProgress(`projection:${binding.key}`, lastId);
  seen.set(binding.key, signature);
}
