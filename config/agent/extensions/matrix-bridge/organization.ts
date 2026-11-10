import { execFile } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";
import { BRIDGE_ROOM_STAMP, ownedBridgeRoom, roomStamp, type BridgeRoomKind, type BridgeRoomStamp } from "../matrix-shared/bridge-room.js";
import { MatrixError, type MatrixHttp } from "../matrix-shared/http.js";
import { isMatrixRoomId } from "../matrix-shared/room-id.js";
import { isSoleRoomCreator } from "../matrix-shared/room-creator.js";
import { BridgeStore, identity, type Binding } from "./store.js";
import { object, string } from "./wire.js";

export type Grouping = { project: string; checkout: string; projectName: string; checkoutName: string };
export type SetupStatus = { stage: "room" | "grouping" | "invitation" | "ready"; error?: string; grouping?: Grouping; archived?: boolean; archiveRevision?: number };
export type RoomNode = { stamp: BridgeRoomStamp; name: string; operator: string; attempted: boolean; room?: string; inviteAttempted?: boolean; imported?: string };
export type OrganizationConfig = { hostId: string; botUserId: string; operatorUserId: string; hostSpace?: boolean };
const execute = promisify(execFile);

/** Presentation only. No Git command is run for an ordinary non-repository cwd. */
export async function workspaceGrouping(cwd: string): Promise<Grouping> {
  cwd = realpathSync(cwd);
  let directory = cwd, repository = false;
  for (;;) {
    try { lstatSync(join(directory, ".git")); repository = true; break; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw Error("Git grouping metadata is unavailable"); }
    const parent = dirname(directory); if (parent === directory) break; directory = parent;
  }
  if (!repository) return { project: cwd, checkout: cwd, projectName: basename(cwd), checkoutName: basename(cwd) };
  // Git grouping is read-only and receives neither Matrix credentials nor an
  // inherited Git execution/config override. No shell, fetch or hooks.
  const env: NodeJS.ProcessEnv = { HOME: process.env.HOME, PATH: process.env.PATH, LANG: process.env.LANG, GIT_OPTIONAL_LOCKS: "0" };
  try {
    const { stdout } = await execute("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir", "--show-toplevel"], { env, timeout: 3000, maxBuffer: 16384 });
    const paths = stdout.trimEnd().split("\n");
    if (paths.length !== 2 || !paths.every(value => value.startsWith("/"))) throw Error("Invalid Git grouping result");
    const common = realpathSync(paths[0]!), checkout = realpathSync(paths[1]!);
    return { project: common, checkout, projectName: basename(common) === ".git" ? basename(dirname(common)) : basename(common), checkoutName: basename(checkout) };
  } catch { throw Error("Git grouping lookup failed; local Pi and bound-room delivery remain available"); }
}

/** Bounded setup journal in the existing bridge database, not runtime authority. */
export class BridgeOrganization {
  private readonly nodes = new Map<string, Promise<RoomNode>>();
  private readonly invitations = new Map<string, Promise<string | undefined>>();
  private readonly links = new Map<string, Promise<void>>();
  private readonly jobs = new Map<string, Promise<void>>();
  private readonly groups = new Map<string, Promise<void>>();
  private readonly retryAt = new Map<string, number>();
  private readonly signal = new AbortController();
  private readonly server: string;
  constructor(readonly store: BridgeStore, readonly http: MatrixHttp, readonly config: OrganizationConfig,
    private readonly grouping = workspaceGrouping) {
    if (!/^@[^\s:]+:[^\s]+$/.test(config.botUserId) || !/^@[^\s:]+:[^\s]+$/.test(config.operatorUserId) || config.botUserId === config.operatorUserId) throw Error("Invalid bridge organization identities");
    roomStamp({ version: 1, host: config.hostId, node: "0".repeat(64), kind: "host" });
    this.server = config.botUserId.slice(config.botUserId.indexOf(":") + 1);
  }
  status(key: string): SetupStatus {
    const saved = this.store.progress<SetupStatus>(`setup:${key}`) ?? { stage: "room" }, binding = this.store.binding(key);
    return binding && ((saved.archiveRevision ?? 0) !== (binding.archiveRevision ?? 0) || Boolean(saved.archived) !== binding.archived) ? { ...saved, stage: "grouping" } : saved;
  }
  private saveStatus(key: string, status: SetupStatus): void {
    if (!isDeepStrictEqual(this.store.progress(`setup:${key}`), status)) this.store.saveProgress(`setup:${key}`, status);
  }
  private request(method: string, path: string, body?: Record<string, unknown>): Promise<unknown> {
    return this.http.request(method, path, body, AbortSignal.any([this.signal.signal, AbortSignal.timeout(8000)]));
  }
  private nodeKey(stamp: BridgeRoomStamp): string { return `setup-node:${stamp.node}`; }
  private saveNode(node: RoomNode): void { this.store.saveProgress(this.nodeKey(node.stamp), node); }
  private async state(room: string): Promise<unknown[]> {
    const value = await this.request("GET", `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/state`);
    if (!Array.isArray(value) || value.length > 4096) throw Error("Invalid bridge room state");
    return value;
  }
  private owned(node: RoomNode, events: unknown[]): void {
    if (!node.imported) { ownedBridgeRoom(events, this.config.botUserId, node.stamp); return; }
    // Only exact receipts from the one-shot offline import have this exception.
    // Old rooms lack the new creation stamp. The immutable sole creator and
    // room policy must still match; no mutable provenance grants ownership.
    if (node.imported !== this.store.progress("migration-source") || !node.room) throw Error("Invalid imported room receipt");
    const creates = events.map(object).filter(event => event.type === "m.room.create" && event.state_key === "");
    if (creates.length !== 1 || !isSoleRoomCreator(creates[0], this.config.botUserId)) throw Error("Imported room has a foreign or ambiguous creator; original ID retained");
    const content = object(creates[0]!.content);
    if ((node.stamp.kind === "conversation" ? content.type !== undefined : content.type !== "m.space") || content["m.federate"] !== false || events.some(event => object(event).type === "m.room.encryption")) throw Error("Unsupported imported room policy; original ID retained");
    if (node.stamp.kind === "conversation" && this.store.progress(`migration-room-verified:${node.room}`) !== node.imported) this.store.saveProgress(`migration-room-verified:${node.room}`, node.imported);
  }
  private async lookup(alias: string): Promise<string | undefined> {
    try {
      const value = object(await this.request("GET", `/_matrix/client/v3/directory/room/${encodeURIComponent(alias)}`));
      if (!isMatrixRoomId(value.room_id)) throw Error("Invalid setup room identity"); return value.room_id;
    } catch (error) { if (error instanceof MatrixError && error.status === 404) return; throw error; }
  }
  private node(kind: BridgeRoomKind, key: string, name: string, savedRoom?: string): Promise<RoomNode> {
    const stamp: BridgeRoomStamp = { version: 1, host: this.config.hostId, node: identity("room", this.config.hostId, this.config.botUserId, kind, key), kind };
    const active = this.nodes.get(stamp.node); if (active) return active;
    const work = this.ensureNode(stamp, name, savedRoom).finally(() => this.nodes.delete(stamp.node));
    this.nodes.set(stamp.node, work); return work;
  }
  private async ensureNode(stamp: BridgeRoomStamp, name: string, savedRoom?: string): Promise<RoomNode> {
    let node = this.store.progress<RoomNode>(this.nodeKey(stamp));
    if (!node) {
      node = { stamp, name: string(name || stamp.kind, 512), operator: this.config.operatorUserId, attempted: Boolean(savedRoom), ...(savedRoom ? { room: savedRoom } : {}) };
      this.saveNode(node);
    }
    if (!isDeepStrictEqual(node.stamp, stamp) || node.operator !== this.config.operatorUserId || savedRoom && node.room !== savedRoom) throw Error("Frozen setup identity conflict");
    if (!node.room) {
      const localpart = `pi-bridge-${stamp.node}`, alias = `#${localpart}:${this.server}`;
      let room = await this.lookup(alias);
      // A foreign alias is not a durable room receipt. Keep the setup scoped
      // and retryable if the alias is corrected; never adopt by display name.
      if (room) ownedBridgeRoom(await this.state(room), this.config.botUserId, stamp);
      if (!room) {
        if (node.attempted) throw Error("Room creation is uncertain and its alias is unavailable; no duplicate will be created");
        node.attempted = true; this.saveNode(node); // Before POST, including loss of reply.
        try {
          const response = object(await this.request("POST", "/_matrix/client/v3/createRoom", {
            visibility: "private", preset: "private_chat", name: node.name, room_alias_name: localpart,
            creation_content: { "m.federate": false, ...(stamp.kind === "conversation" ? {} : { type: "m.space" }), [BRIDGE_ROOM_STAMP]: stamp },
            initial_state: [{ type: "m.room.history_visibility", state_key: "", content: { history_visibility: "invited" } }],
          }));
          if (!isMatrixRoomId(response.room_id)) throw Error("Invalid setup creation receipt"); room = response.room_id;
        } catch (error) {
          // Only explicit authentication/rate-limit rejection proves no creation.
          if (error instanceof MatrixError && [401, 403, 429].includes(error.status ?? 0)) { node.attempted = false; this.saveNode(node); }
          throw error;
        }
      }
      node.room = room; this.saveNode(node); // Saved ID wins over mutable alias/name.
    }
    this.owned(node, await this.state(node.room));
    return node;
  }
  private invite(node: RoomNode): Promise<string | undefined> {
    const active = this.invitations.get(node.stamp.node); if (active) return active;
    const work = this.ensureInvitation(node).finally(() => this.invitations.delete(node.stamp.node));
    this.invitations.set(node.stamp.node, work); return work;
  }
  private async ensureInvitation(node: RoomNode): Promise<string | undefined> {
    node = this.store.progress<RoomNode>(this.nodeKey(node.stamp))!;
    const events = await this.state(node.room!);
    this.owned(node, events);
    const member = events.map(object).find(event => event.type === "m.room.member" && event.state_key === this.config.operatorUserId);
    const membership = member ? object(member.content).membership : undefined;
    if (membership === "join") return;
    if (membership === "leave" || membership === "ban") return "Operator departed or is banned; automatic invitation suppressed";
    if (membership === "invite") return "Operator invitation pending; account helper is optional";
    if (membership !== undefined) throw Error("Unrecognized operator membership; no invitation sent");
    if (node.imported) return "Imported invitation history is held; no automatic reinvitation or account replay";
    if (node.inviteAttempted) return "Invitation outcome is uncertain; automatic reinvitation suppressed";
    node.inviteAttempted = true; this.saveNode(node);
    try { await this.request("POST", `/_matrix/client/v3/rooms/${encodeURIComponent(node.room!)}/invite`, { user_id: this.config.operatorUserId }); }
    catch (error) {
      if (error instanceof MatrixError && [401, 403, 429].includes(error.status ?? 0)) { node.inviteAttempted = false; this.saveNode(node); }
      throw error;
    }
    return "Operator invitation pending; account helper is optional";
  }
  private async stateContent(room: string, type: string, key: string): Promise<Record<string, unknown>> {
    try { return object(await this.request("GET", `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/state/${type}/${encodeURIComponent(key)}`)); }
    catch (error) { if (error instanceof MatrixError && error.status === 404) return {}; throw error; }
  }
  private link(parent: RoomNode, child: RoomNode, present = true): Promise<void> {
    const key = identity("link", parent.room!, child.room!, String(present));
    const active = this.links.get(key); if (active) return active;
    const work = this.ensureLink(parent, child, present).finally(() => this.links.delete(key));
    this.links.set(key, work); return work;
  }
  private async ensureLink(parent: RoomNode, child: RoomNode, present: boolean): Promise<void> {
    for (const [room, type, key, content] of [
      [parent.room!, "m.space.child", child.room!, { via: [this.server], suggested: true }],
      [child.room!, "m.space.parent", parent.room!, { via: [this.server], canonical: true }],
    ] as const) {
      const current = await this.stateContent(room, type, key);
      const desired = present ? content : {};
      if (!isDeepStrictEqual(current, desired)) await this.request("PUT", `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/state/${type}/${encodeURIComponent(key)}`, desired);
    }
  }
  private async existing(kind: BridgeRoomKind, key: string): Promise<RoomNode | undefined> {
    const saved = this.store.progress<RoomNode>(`setup-node:${identity("room", this.config.hostId, this.config.botUserId, kind, key)}`);
    return saved?.attempted ? this.node(kind, key, saved.name, saved.room) : undefined;
  }
  private async inGroup(key: string, fn: () => Promise<void>): Promise<void> {
    const work = (this.groups.get(key) ?? Promise.resolve()).catch(() => {}).then(fn);
    this.groups.set(key, work);
    try { await work; } finally { if (this.groups.get(key) === work) this.groups.delete(key); }
  }
  /** Each binding has its own work/backoff; this never shares delivery admission. */
  async pump(): Promise<void> {
    if (this.signal.signal.aborted) return;
    for (const binding of this.store.bindings()) {
      if (!binding.enabled || this.jobs.has(binding.key) || this.status(binding.key).stage === "ready" || (this.retryAt.get(binding.key) ?? 0) > Date.now()) continue;
      if (this.jobs.size >= 8) break;
      const job = this.step(binding).catch(error => {
        const old = this.status(binding.key);
        this.saveStatus(binding.key, { ...old, error: error instanceof Error ? error.message.slice(0, 500) : "Room setup pending" });
        this.retryAt.set(binding.key, Date.now() + 5000);
      }).finally(() => this.jobs.delete(binding.key));
      this.jobs.set(binding.key, job);
    }
    await Promise.all(this.jobs.values());
  }
  private async step(binding: Binding): Promise<void> {
    const conversation = await this.node("conversation", binding.key, binding.title, binding.room);
    this.store.setRoom(binding.key, conversation.room!);
    const nodes = [conversation];
    // Invite the conversation independently of grouping; a Git/Space failure
    // cannot prevent someone from joining an otherwise usable room.
    const firstInvite = this.invite(conversation).then(value => value, () => "Operator invitation setup pending");
    let failure: string | undefined;
    let grouping = this.status(binding.key).grouping;
    const save = (value: SetupStatus) => this.saveStatus(binding.key, { ...value, archived: binding.archived, archiveRevision: binding.archiveRevision ?? 0 });
    save({ stage: "grouping", ...(grouping ? { grouping } : {}) });
    try {
      if (conversation.imported) {
        const hold = this.store.progress<string>(`migration-grouping-hold:${binding.key}`);
        if (hold || !grouping || this.config.hostSpace !== false && !this.store.progress(`setup-node:${identity("room", this.config.hostId, this.config.botUserId, "host", this.config.hostId)}`)) throw Error(hold ?? "Original grouping evidence is incomplete; no replacement Spaces will be created");
      }
      if (!grouping && !binding.archived) { grouping = await this.grouping(binding.cwd); save({ stage: "grouping", grouping }); }
      await this.inGroup(grouping?.checkout ?? binding.key, async () => {
        if ((this.store.binding(binding.key)?.archiveRevision ?? 0) !== (binding.archiveRevision ?? 0)) throw Error("Archive policy changed; presentation will reconcile");
        if (binding.archived) {
          const archive = await this.node("archive", this.config.hostId, "Archive"); nodes.push(archive);
          if (this.config.hostSpace !== false) {
            const host = await this.node("host", this.config.hostId, this.config.hostId); nodes.push(host); await this.link(host, archive);
          }
          await this.link(archive, conversation); // Destination before removing any live edge.
          if (grouping) {
            const checkout = await this.existing("checkout", grouping.checkout);
            if (checkout) {
              await this.link(checkout, conversation, false);
              const live = this.store.bindings().some(item => item.enabled && !item.archived && this.status(item.key).grouping?.checkout === grouping!.checkout);
              if (!live) { const project = await this.existing("project", grouping.project); if (project) await this.link(project, checkout, false); }
            }
          }
        } else {
          if (!grouping) throw Error("Live grouping is unavailable");
          const project = await this.node("project", grouping.project, grouping.projectName), checkout = await this.node("checkout", grouping.checkout, grouping.checkoutName);
          nodes.push(project, checkout);
          if (this.config.hostSpace !== false) {
            const host = await this.node("host", this.config.hostId, this.config.hostId); nodes.push(host); await this.link(host, project);
          }
          await this.link(project, checkout); await this.link(checkout, conversation);
          const archive = await this.existing("archive", this.config.hostId);
          if (archive) await this.link(archive, conversation, false);
        }
        // Old archives had nested presentation. Destination now exists; unlink
        // only the exact imported conversation edges, never Spaces/membership.
        for (const saved of this.store.progress<RoomNode[]>(`migration-archive-parents:${binding.key}`) ?? []) {
          const parent = await this.node("checkout", `migration-archive:${saved.room!}`, saved.name, saved.room);
          await this.link(parent, conversation, false);
        }
      });
    } catch (error) { failure = error instanceof Error ? error.message.slice(0, 500) : "Grouping setup pending"; }
    const pending = [await firstInvite, ...await Promise.all(nodes.slice(1).map(node => this.invite(node).catch(() => "Operator invitation setup pending")))].find(Boolean);
    save({ stage: failure ? "grouping" : pending ? "invitation" : "ready", ...(grouping ? { grouping } : {}), ...(failure || pending ? { error: failure ?? pending } : {}) });
    if (failure || pending) this.retryAt.set(binding.key, Date.now() + 5000);
  }
  async stop(): Promise<void> {
    this.signal.abort(); await Promise.allSettled(this.jobs.values());
    await Promise.allSettled([...this.nodes.values(), ...this.invitations.values(), ...this.links.values()]);
  }
}
