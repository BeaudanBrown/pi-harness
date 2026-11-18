import { MatrixHttp, MatrixError } from "../matrix-shared/http.js";
import { object, string } from "./wire.js";
import type { BridgeStore, RawEvent, Output } from "./store.js";

export class BridgeMatrix {
  constructor(readonly http: MatrixHttp, readonly userId: string, readonly ignored: ReadonlySet<string> = new Set()) {}
  ignoredSender(sender: string): boolean { return sender === this.userId || this.ignored.has(sender); }
  async joined(room: string, sender: string): Promise<boolean> {
    if (this.ignoredSender(sender)) return false;
    try {
      const state = object(await this.http.request("GET", `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/state/m.room.member/${encodeURIComponent(sender)}`, undefined, AbortSignal.timeout(8000)));
      return state.membership === "join";
    } catch (error) { if (error instanceof MatrixError && error.status === 404) return false; throw error; }
  }
  async send(room: string, output: Output): Promise<string> {
    const result = object(await this.http.request("PUT", `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/send/${encodeURIComponent(output.type)}/${output.id}`, output.content, AbortSignal.timeout(8000)));
    return string(result.event_id, 255);
  }
}
function events(room: string, value: unknown): RawEvent[] {
  if (!Array.isArray(value)) throw Error("Malformed Matrix timeline");
  return value.map(item => {
    const event = object(item), id = string(event.event_id, 255);
    if (!id.startsWith("$") || event.room_id !== undefined && event.room_id !== room) throw Error("Foreign or invalid Matrix event identity");
    return { id, room, event };
  });
}
/** Commit each sync once. Never reconstruct missing commands from room history. */
export async function syncIntoStore(matrix: BridgeMatrix, store: BridgeStore, signal?: AbortSignal): Promise<void> {
  const since = store.cursor(), bindings = store.bindings();
  const query = new URLSearchParams({ timeout: "30000", filter: JSON.stringify({ room: { timeline: { limit: 100 } } }) });
  if (since) query.set("since", since);
  const { nextBatch, response } = await matrix.http.sync(query, signal);
  const joined = object(object(object(response).rooms ?? {}).join ?? {}), incoming: RawEvent[] = [], skipped: string[] = [];
  for (const { room, key, file, nativeId, resumePending } of bindings) {
    if (!room || store.enrollmentBlocked(file, nativeId)) continue;
    if (resumePending) skipped.push(key); // An older ledger needs a fresh boundary.
    if (!since || !Object.hasOwn(joined, room)) continue;
    try {
      const timeline = object(object(joined[room]).timeline ?? { events: [] });
      if (timeline.limited === true && !resumePending) skipped.push(key);
      incoming.push(...events(room, timeline.events));
    } catch { if (!skipped.includes(key)) skipped.push(key); } // Reject the whole malformed room interval, never a partial command stream.
  }
  store.intake(nextBatch, incoming, skipped);
}
