import assert from "node:assert/strict";
import { BridgeMatrix } from "../../../config/agent/extensions/matrix-bridge/matrix.js";
import { MatrixHttp } from "../../../config/agent/extensions/matrix-shared/http.js";

export const BOT = "@bot:example.test", USER = "@friend:example.test", ROOM = "!room:example.test";
export const textEvent = (id: string, body: string, sender = USER) => ({ event_id: id, sender, type: "m.room.message", content: { msgtype: "m.text", body } });
/** Authenticated HTTP boundary only; no homeserver/external-effect receipt. */
export class InteractionHttp {
  readonly sent = new Map<string, { event_id: string; room_id: string; sender: string; type: string; content: Record<string, unknown> }>();
  readonly attempts: string[] = [];
  readonly members = new Set([USER, "@second:example.test"]);
  readonly syncs: unknown[] = [];
  media = Buffer.alloc(0);
  downloads = 0;
  loseType?: string;
  failRoom?: string;
  readonly matrix: BridgeMatrix;
  constructor() {
    this.matrix = new BridgeMatrix(new MatrixHttp({ homeserver: "https://example.test", accessToken: "daemon-only-token" }, this.fetch, { maxAttempts: 1 }), BOT, new Set(["@service:example.test"]));
  }
  private fetch = (async (url: URL | RequestInfo, init?: RequestInit) => {
    const target = new URL(String(url)), path = target.pathname;
    assert.equal(target.origin, "https://example.test"); assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer daemon-only-token");
    if (path.endsWith("/sync")) return Response.json(this.syncs.shift() ?? { next_batch: "sync", rooms: {} });
    if (path.includes("/media/download/")) { this.downloads++; return new Response(new Uint8Array(this.media), { headers: { "content-type": "stale/client-metadata", "content-length": "1" } }); }
    if (path.includes("/state/m.room.member/")) return Response.json({ membership: this.members.has(decodeURIComponent(path.split("/").at(-1)!)) ? "join" : "leave" });
    if (path.includes("/send/")) {
      const parts = path.split("/").map(decodeURIComponent), id = parts.at(-1)!, type = parts.at(-2)!, room = parts[5]!, content = JSON.parse(String(init?.body)) as Record<string, unknown>;
      this.attempts.push(id);
      if (this.failRoom === room) throw Error("room-local send unavailable");
      const old = this.sent.get(id); if (old) assert.deepEqual(content, old.content, "retry changed frozen content");
      const event = old ?? { event_id: `$sent${this.sent.size}`, room_id: room, sender: BOT, type, content }; this.sent.set(id, event);
      if (this.loseType === type) { this.loseType = undefined; throw Error("accepted output but lost acknowledgement"); }
      return Response.json({ event_id: event.event_id });
    }
    throw Error(`Unexpected fixture endpoint ${path}`);
  }) as typeof fetch;
}
