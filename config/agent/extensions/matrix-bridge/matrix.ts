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
type Gap = { from: string; to: string; tail: string[]; tokens: string[] };
function events(room: string, value: unknown): RawEvent[] {
  if (!Array.isArray(value)) throw Error("Malformed Matrix timeline");
  return value.map(item => {
    const event = object(item), id = string(event.event_id, 255);
    if (!id.startsWith("$") || event.room_id !== undefined && event.room_id !== room) throw Error("Foreign or invalid Matrix event identity");
    return { id, room, event };
  });
}
/** Independent room intake; a broken history interval cannot hold other rooms hostage.
 * Each recovered page is durable before its resume token changes. The global
 * sync cursor moves only when every relevant room covers the whole interval.
 */
export async function syncIntoStore(matrix: BridgeMatrix, store: BridgeStore, signal?: AbortSignal): Promise<Array<{ room: string; error: string }>> {
  const since = store.cursor();
  const query = new URLSearchParams({ timeout: "30000", filter: JSON.stringify({ room: { timeline: { limit: 100 } } }) });
  if (since) query.set("since", since);
  const { nextBatch, response } = await matrix.http.sync(query, signal);
  if (!since) { store.intake(nextBatch, []); return []; } // Establish a live boundary, never backfill room history.
  const joined = object(object(object(response).rooms ?? {}).join ?? {});
  const errors: Array<{ room: string; error: string }> = [];
  let complete = true;
  await Promise.all(store.bindings().filter(binding => binding.room).map(async binding => {
    const room = binding.room!, checkpoint = `room-cursor:${room}`, gapKey = `gap:${room}`;
    try {
      const timeline = object(object(joined[room] ?? {}).timeline ?? { events: [] });
      const tail = events(room, timeline.events ?? []);
      let gap = store.progress<Gap | null>(gapKey);
      let from = store.progress<string>(checkpoint) ?? since;
      if (from === nextBatch && !gap) return;
      if (!gap && timeline.limited === true) {
        gap = { from, to: nextBatch, tail: tail.map(event => event.id), tokens: [from] };
        store.saveProgress(gapKey, gap);
      }
      if (gap) {
        // Bounded work per iteration, not a permanent cap on recoverable history.
        for (let page = 0; page < 4; page++) {
          const params = new URLSearchParams({ from: gap.from, to: gap.to, dir: "f", limit: "100" });
          const result = object(await matrix.http.request("GET", `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/messages?${params}`, undefined, AbortSignal.timeout(8000)));
          const end = string(result.end, 16384);
          if (result.start !== gap.from || !Array.isArray(result.chunk) || result.chunk.length > 100) throw Error("Malformed Matrix history page");
          const pageEvents = events(room, result.chunk);
          if (end !== gap.to && gap.tokens.includes(end)) throw Error("Matrix history pagination stalled");
          // Keep a bounded cycle detector. Repeated event IDs still never dispatch twice.
          gap = { ...gap, from: end, tokens: [...gap.tokens.slice(-31), end] };
          store.intake(since, pageEvents, { [gapKey]: gap });
          if (end === gap.to) {
            if (gap.tail.some(id => !store.knowsEvent(id, room))) throw Error("Matrix history did not cover the sync tail; cursor preserved");
            from = gap.to;
            store.intake(since, [], { [checkpoint]: from, [gapKey]: null });
            gap = null;
            break;
          }
        }
        if (gap || from !== nextBatch) { complete = false; return; }
      } else store.intake(since, tail, { [checkpoint]: nextBatch });
    } catch (error) {
      complete = false;
      errors.push({ room, error: error instanceof Error ? error.message : "Matrix intake failed" });
    }
  }));
  if (complete) store.intake(nextBatch, []);
  return errors;
}
