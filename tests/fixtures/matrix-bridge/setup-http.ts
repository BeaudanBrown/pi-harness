import { MatrixHttp } from "../../../config/agent/extensions/matrix-shared/http.js";
import { BRIDGE_ROOM_STAMP } from "../../../config/agent/extensions/matrix-shared/bridge-room.js";

type Event = { type: string; state_key: string; sender: string; content: Record<string, unknown>; event_id: string };
export const BOT = "@bot:example.test", OWNER = "@owner:example.test";
/** Public HTTP-boundary fixture, not evidence of a real homeserver accepting effects. */
export class SetupHttp {
  readonly rooms = new Map<string, Event[]>();
  readonly aliases = new Map<string, string>();
  readonly calls: Array<{ method: string; path: string; body?: Record<string, unknown>; actor: string }> = [];
  createFailure?: "before" | "after";
  linkFailure = false;
  inviteFailure = false;
  joinFailure = false;
  rejectOnce?: { suffix: string; status: number; retryAfterMs?: number };
  aliasCollision?: string;
  nextSync?: Record<string, unknown>;
  beforeSnapshot?: () => void;
  private serial = 0;
  readonly bot: MatrixHttp;
  readonly owner: MatrixHttp;
  constructor() {
    this.bot = new MatrixHttp({ homeserver: "https://example.test", accessToken: "bot" }, this.fetch, { maxAttempts: 1 });
    this.owner = new MatrixHttp({ homeserver: "https://example.test", accessToken: "owner" }, this.fetch, { maxAttempts: 1 });
  }
  event(type: string, state_key: string, sender: string, content: Record<string, unknown>): Event {
    return { type, state_key, sender, content, event_id: `$event${++this.serial}` };
  }
  set(room: string, type: string, key: string, content: Record<string, unknown>, sender = BOT): void {
    const events = this.rooms.get(room)!;
    this.rooms.set(room, [...events.filter(event => event.type !== type || event.state_key !== key), this.event(type, key, sender, content)]);
  }
  member(room: string, membership: string, sender = OWNER): void { this.set(room, "m.room.member", OWNER, { membership }, sender); }
  kind(room: string): string { return (this.rooms.get(room)!.find(event => event.type === "m.room.create")!.content[BRIDGE_ROOM_STAMP] as { kind: string }).kind; }
  count(path: string, method = "POST"): number { return this.calls.filter(call => call.method === method && call.path.endsWith(path)).length; }
  private fetch = (async (url: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    const target = new URL(String(url)), path = target.pathname, method = init?.method ?? "GET";
    const actor = new Headers(init?.headers).get("Authorization") === "Bearer owner" ? OWNER : BOT;
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    this.calls.push({ method, path, body, actor });
    const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
    if (this.rejectOnce && path.endsWith(this.rejectOnce.suffix)) {
      const rejection = this.rejectOnce; this.rejectOnce = undefined;
      return response({ errcode: rejection.status === 429 ? "M_LIMIT_EXCEEDED" : "M_FORBIDDEN", retry_after_ms: rejection.retryAfterMs }, rejection.status);
    }
    if (path.endsWith("/account/whoami")) return response({ user_id: actor, device_id: "fixture" });
    if (path.endsWith("/createRoom")) {
      const failure = this.createFailure; this.createFailure = undefined;
      if (failure === "before") throw Error("lost before create");
      const room = `!room${++this.serial}:example.test`, alias = `#${body!.room_alias_name}:example.test`;
      if (this.aliases.has(alias)) return response({ errcode: "M_ROOM_IN_USE" }, 400);
      this.rooms.set(room, [this.event("m.room.create", "", actor, { ...(body!.creation_content as object), room_version: "12" }),
        this.event("m.room.member", actor, actor, { membership: "join" }), this.event("m.room.join_rules", "", actor, { join_rule: "invite" })]);
      this.aliases.set(alias, room);
      if (failure === "after") throw Error("lost create acknowledgement");
      return response({ room_id: room });
    }
    if (path.includes("/directory/room/")) {
      const room = this.aliasCollision ?? this.aliases.get(decodeURIComponent(path.split("/directory/room/")[1]!));
      return room ? response({ room_id: room }) : response({ errcode: "M_NOT_FOUND" }, 404);
    }
    if (path.endsWith("/sync")) {
      if (this.nextSync) { const batch = this.nextSync; this.nextSync = undefined; return response(batch); }
      const filter = JSON.parse(target.searchParams.get("filter") ?? "{}") as { room?: { rooms?: string[] } };
      if (filter.room?.rooms) this.beforeSnapshot?.();
      const rooms: Record<string, Record<string, unknown>> = { invite: {}, join: {}, leave: {} };
      for (const [room, events] of this.rooms) {
        if (filter.room?.rooms && !filter.room.rooms.includes(room)) continue;
        const member = events.find(event => event.type === "m.room.member" && event.state_key === actor);
        if (member?.content.membership === "invite") rooms.invite![room] = { invite_state: { events: events.map(({ event_id: _id, ...event }) => event) } };
        else if (member?.content.membership === "join") rooms.join![room] = { state: { events }, timeline: { events: [member], limited: false } };
        else if (member) rooms.leave![room] = { state: { events }, timeline: { events: [member], limited: false } };
      }
      return response({ next_batch: `cursor${++this.serial}`, rooms });
    }
    const parts = path.split("/").map(decodeURIComponent), room = parts[5]!, events = this.rooms.get(room);
    if (!events) return response({ errcode: "M_NOT_FOUND" }, 404);
    if (parts[6] === "invite") {
      this.member(room, "invite", actor);
      if (this.inviteFailure) { this.inviteFailure = false; throw Error("lost invite acknowledgement"); }
      return response({});
    }
    if (parts[6] === "join") {
      this.member(room, "join", actor);
      if (this.joinFailure) { this.joinFailure = false; throw Error("lost join acknowledgement"); }
      return response({ room_id: room });
    }
    if (parts[6] === "state") {
      if (parts.length === 7) return response(events);
      const type = parts[7]!, key = parts[8] ?? "";
      if (method === "PUT") {
        this.set(room, type, key, body!, actor);
        if (this.linkFailure) { this.linkFailure = false; throw Error("lost link acknowledgement"); }
        return response({ event_id: `$state${++this.serial}` });
      }
      const event = events.find(event => event.type === type && event.state_key === key);
      return event ? response(event.content) : response({ errcode: "M_NOT_FOUND" }, 404);
    }
    throw Error(`Unexpected fixture endpoint ${method} ${path}`);
  }) as typeof fetch;
}
