import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { lstatSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative } from "node:path";
import { createConnection, type Socket } from "node:net";

export type ObjectValue = Record<string, unknown>;
export const object = (value: unknown): ObjectValue => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Expected an object");
  return value as ObjectValue;
};
export function string(value: unknown, max = 8192): string {
  if (typeof value !== "string" || !value || Buffer.byteLength(value) > max || value.includes("\0")) throw Error("Invalid string field");
  return value;
}
export const FRAME_BYTES = 64 * 1024;
export function allowedWorkspace(cwd: string, roots: readonly string[]): string {
  const actual = realpathSync(cwd);
  if (!statSync(actual).isDirectory()) throw Error("Workspace is not a directory");
  if (!roots.some(root => {
    try { const suffix = relative(realpathSync(root), actual); return suffix === "" || !suffix.startsWith("..") && !isAbsolute(suffix); }
    catch { return false; }
  })) throw Error("Workspace is outside configured bridge roots");
  return actual;
}
export function remoteText(sender: string, eventId: string, text: string): string {
  return `[Matrix ${JSON.stringify({ sender, eventId })}]\n${text}`;
}

/** One bounded request/reply stream. Pending calls fail on disconnect, never replay. */
export class Peer extends EventEmitter {
  private buffer = Buffer.alloc(0);
  private active = 0;
  private pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  constructor(readonly socket: Socket, private readonly handle: (method: string, params: ObjectValue) => Promise<unknown>) {
    super();
    socket.on("error", () => socket.destroy());
    socket.on("close", () => {
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(Error("Bridge disconnected; request outcome may be uncertain")); }
      this.pending.clear(); this.emit("close");
    });
    socket.on("data", bytes => {
      this.buffer = Buffer.concat([this.buffer, bytes]);
      for (;;) {
        const end = this.buffer.indexOf(10);
        if (end < 0) { if (this.buffer.length > FRAME_BYTES) socket.destroy(); return; }
        if (end > FRAME_BYTES) { socket.destroy(); return; }
        const line = this.buffer.subarray(0, end); this.buffer = this.buffer.subarray(end + 1);
        try { this.receive(object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line)))); }
        catch { socket.destroy(); return; }
      }
    });
  }
  private receive(frame: ObjectValue): void {
    if (frame.v !== 1) throw Error("Unsupported bridge protocol");
    const id = string(frame.id, 128);
    if (frame.method !== undefined) {
      if (++this.active > 64) throw Error("Too many concurrent bridge calls");
      const method = string(frame.method, 64), params = object(frame.params);
      void Promise.resolve().then(() => this.handle(method, params)).then(
        result => this.send({ v: 1, id, result: result ?? null }),
        error => this.send({ v: 1, id, error: error instanceof Error ? error.message.slice(0, 500) : "Bridge request failed" }),
      ).catch(() => this.socket.destroy()).finally(() => { this.active--; });
    } else {
      const pending = this.pending.get(id); if (!pending) return;
      this.pending.delete(id); clearTimeout(pending.timer);
      if (frame.error !== undefined) pending.reject(Error(string(frame.error, 2048)));
      else if (Object.hasOwn(frame, "result")) pending.resolve(frame.result);
      else pending.reject(Error("Malformed bridge response"));
    }
  }
  private send(frame: ObjectValue): void {
    const data = Buffer.from(JSON.stringify(frame) + "\n");
    if (data.length > FRAME_BYTES || this.socket.destroyed || this.socket.writableLength > FRAME_BYTES * 4) throw Error("Bridge socket unavailable or backpressured");
    this.socket.write(data);
  }
  request(method: string, params: ObjectValue, timeoutMs = 10000): Promise<unknown> {
    if (this.pending.size >= 64) return Promise.reject(Error("Bridge request capacity exhausted"));
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => { this.pending.delete(id); reject(Error("Bridge request timed out; outcome may be uncertain")); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ v: 1, id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  close(): void { this.socket.destroy(); }
}
export async function connect(path: string, handle: (method: string, params: ObjectValue) => Promise<unknown>): Promise<Peer> {
  const parent = lstatSync(dirname(path)), endpoint = lstatSync(path);
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077) || parent.uid !== process.getuid!() ||
      !endpoint.isSocket() || (endpoint.mode & 0o077) || endpoint.uid !== process.getuid!()) throw Error("Bridge socket must be private and user-owned");
  const socket = createConnection(path);
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { socket.destroy(); reject(Error("Bridge connect timed out")); }, 2000);
    socket.once("connect", () => { clearTimeout(timeout); resolve(); });
    socket.once("error", error => { clearTimeout(timeout); reject(error); });
  });
  return new Peer(socket, handle);
}
