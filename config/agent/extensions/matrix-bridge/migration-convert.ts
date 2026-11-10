/** Offline decoder of historical evidence, NOT a legacy runtime/authority reader.
 * Unrecognized/unfrozen effects stay in the byte-exact bundle and report. */
import { createHash } from "node:crypto";
import { isMatrixRoomId } from "../matrix-shared/room-id.js";
import { identity, type Binding, type Output, type Input } from "./store.js";
import type { Grouping, RoomNode } from "./organization.js";
import { object, string } from "./wire.js";
import { canonical, sha256, type Snapshot } from "./migration-files.js";

type Row = Record<string, unknown>;
type Native = { id: string; cwd: string; path: string; file: string; entries: Row[]; tail: string | null };
export type EnrollmentPolicy = { file?: string; disabled: boolean; reason: string };
export type ReportRow = { conversation: string; nativeId?: string; file?: string; room?: string; enabled: boolean; archived: boolean; unattempted: number; uncertain: number; outputs: number; polls: number; findings: string[]; omittedFindings: number };
export type Conversion = {
  bindings: Binding[]; inputs: Input[]; outputs: Output[]; images: Array<{ input: string; path: string; size: number }>;
  progress: Record<string, unknown>; cursor?: string; report: { source: string; findings: string[]; omittedFindings: number; bindings: ReportRow[] };
};
const rows = (value: unknown, maximum = 16384): Row[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maximum) throw Error("Malformed or excessive historical record list");
  return value.map(object);
};
const id = (value: unknown) => string(value, 128);
const conversation = (value: unknown) => { const result = id(value); if (!/^conv_[a-f0-9]{32}$/.test(result)) throw Error("Invalid historical conversation identity"); return result; };
const room = (value: unknown) => { if (!isMatrixRoomId(value)) throw Error("Invalid historical room identity"); return value; };
const optionalRoom = (value: unknown) => value === undefined ? undefined : room(value);
const arrayStrings = (value: unknown) => rows(value).map(value => id(value.piSessionId));
function note(report: ReportRow, text: string): void { if (report.findings.length < 16) report.findings.push(text.slice(0, 240)); else report.omittedFindings++; }
function legacyCursor(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Missing or malformed legacy room cursor");
  const cursor = value as Row, keys = Object.keys(cursor);
  if (cursor.status === "bootstrap" && keys.length === 1) return;
  if (cursor.status === "established" && keys.length === 2 && typeof cursor.since === "string" && cursor.since.length > 0 && cursor.since.length <= 2048 && !cursor.since.includes("\0")) return cursor.since;
  throw Error("Unknown or malformed legacy room cursor; no cutoff may be discarded");
}
function transaction(value: unknown): string {
  const result = string(value, 255);
  if (!/^[A-Za-z0-9._~-]{1,255}$/.test(result)) throw Error("Unsafe original output transaction identity");
  return result;
}
const bindingMarker = (entry: Row): Row | undefined => entry.type === "custom" && entry.customType === "managed-session.binding" ? object(entry.data) : undefined;
function native(snapshot: Snapshot, path: string): Native {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(snapshot.file(path));
  if (!text.endsWith("\n")) throw Error("Incomplete native history; preserved without repair");
  const lines = text.trimEnd().split("\n").map(line => object(JSON.parse(line))), header = lines.shift()!;
  if (header.type !== "session" || header.version !== 3 || !string(header.cwd).startsWith("/")) throw Error("Unsupported native history header");
  const ids = new Set<string>();
  for (const entry of lines) { const key = id(entry.id); if (ids.has(key)) throw Error("Duplicate native entry identity"); ids.add(key); }
  return { id: id(header.id), cwd: string(header.cwd), file: snapshot.original(path), path, entries: lines, tail: lines.length ? id(lines.at(-1)!.id) : null };
}
/** Only payloads frozen by the historical text projection contract are eligible.
 * No renderer, guessed transaction, network poll lookup or old effect executor. */
function frozen(projection: Row, chunk: Row, index: number): Record<string, unknown> | undefined {
  if (projection.renderingVersion !== 2 || typeof chunk.body !== "string" || typeof chunk.formattedBody !== "string") return;
  if (!["local_user", "assistant_final", "assistant_commentary", "branch_marker", "notice", "checkpoint"].includes(String(projection.kind))) return;
  const notice = projection.kind === "branch_marker";
  const content: Row = { msgtype: notice ? "m.notice" : "m.text", body: string(chunk.body, 8000) };
  const disposition = notice || projection.disposition === "notify" && index > 0 ? "silent" : projection.disposition ?? (projection.kind === "assistant_commentary" ? "silent" : undefined);
  if (disposition !== undefined) {
    if (disposition !== "silent" && disposition !== "notify") throw Error("Unknown frozen notification disposition");
    content["lol.bepis.pi.notification"] = { version: 1, disposition };
    content["m.mentions"] = disposition === "notify" ? { room: true } : {};
  }
  if (!notice && chunk.formattedBody !== undefined) { content.format = "org.matrix.custom.html"; content.formatted_body = string(chunk.formattedBody, 8000); }
  return content;
}
// Format identity verification only. Output transactions are NEVER synthesized.
export function legacyEntry(nativeId: string, key: string): string {
  const hash = createHash("sha256").update("pi-managed-sessions:pi-transcript-entry:v1\0");
  for (const value of [nativeId, key]) hash.update(`${Buffer.byteLength(value)}:`).update(value);
  return `entry_${hash.digest("hex").slice(0, 32)}`;
}
export function convert(snapshot: Snapshot): Conversion {
  const inventory = snapshot.inventory, source = inventory.source;
  const paths = new Set(inventory.files.map(file => file.path));
  const state = source.roots.find(root => root.role === "state")!.name;
  const manifestsRoot = source.roots.find(root => root.role === "manifests")!.name;
  const read = (name: string) => snapshot.json(`${state}/${name}`);
  const optional = (name: string) => paths.has(`${state}/${name}`) ? read(name) : undefined;
  const registry = read("registry.json");
  if (registry.schemaVersion !== "1.0.0" || registry.hostId !== source.hostId || paths.has(`${state}/v1-to-v2-migration.json`)) throw Error("Unsupported, foreign or partially converted legacy registry");
  if (!inventory.directories.includes(`${state}/retirements`)) throw Error("Retirement directory is missing; absence is not empty authority");
  const archives = optional("archives.json");
  if (!archives) throw Error("Required archive evidence is missing; absence is not empty authority");
  if (archives.version !== 1 || archives.hostId !== source.hostId) throw Error("Invalid archive evidence");
  const presence = optional("archives.json.initialized");
  if (presence && (presence.version !== 1 || presence.hostId !== source.hostId)) throw Error("Foreign archive presence marker");
  const archived = new Map(rows(archives?.records, 4096).map(record => {
    if (record.hostId !== source.hostId || record.version !== 1 || record.phase !== "archiving") throw Error("Foreign or unsupported archive evidence");
    const item = object(record.source); return [conversation(item.conversationId), item];
  }));
  if (archived.size !== rows(archives.records, 4096).length) throw Error("Duplicate archive identity");
  const retired = new Map<string, Row>();
  for (const path of paths) if (path.startsWith(`${state}/retirements/`) && path.endsWith(".json")) {
    const record = snapshot.json(path), key = conversation(record.conversationId);
    if (record.version !== 1 || record.hostId !== source.hostId || path !== `${state}/retirements/${key}.json`) throw Error("Invalid retirement evidence");
    retired.set(key, record);
  }
  const runtime = new Map<string, Row>(), cursors = new Map<string, string | undefined>(), transactions = new Set<string>();
  for (const row of rows(registry.conversations, 4096)) {
    const key = conversation(row.conversationId); if (runtime.has(key)) throw Error("Duplicate runtime conversation");
    if (!["active", "starting", "dormant"].includes(String(row.state)) || !Array.isArray(row.pendingInputs) || !Array.isArray(row.projection)) throw Error("Missing required runtime queue evidence");
    cursors.set(key, legacyCursor(row.matrixCursor));
    // Sent/cancelled/unresolved chunks still own their transaction identities,
    // including records with unavailable native history or disabled bindings.
    for (const projection of rows(row.projection, 4096)) for (const chunk of rows(projection.chunks, 64)) {
      const id = transaction(chunk.transactionId);
      if (transactions.has(id)) throw Error("Duplicate original output transaction identity");
      transactions.add(id);
    }
    runtime.set(key, row);
  }
  const manifests = new Map<string, Row>();
  for (const path of paths) if (path.startsWith(`${manifestsRoot}/`) && /^conv_[a-f0-9]{32}\.json$/.test(path.slice(manifestsRoot.length + 1))) {
    const row = snapshot.json(path), key = conversation(row.conversationId);
    if (row.schemaVersion !== "1.0.0" || row.ownerHostId !== source.hostId || !["project", "coordinator"].includes(String(row.kind)) || path !== `${manifestsRoot}/${key}.json`) throw Error("Invalid or foreign manifest");
    manifests.set(key, row);
  }
  for (const row of rows(registry.localConversations, 4096)) {
    const key = conversation(row.conversationId);
    if (row.version !== 1 || row.ownerHostId !== source.hostId) throw Error("Invalid local enrollment");
    if (!manifests.has(key)) manifests.set(key, row); // Bound manifest wins; raw local evidence remains in backup.
  }
  const result: Conversion = { bindings: [], inputs: [], outputs: [], images: [], progress: {}, report: { source: inventory.digest, findings: [...source.unavailable], omittedFindings: 0, bindings: [] } };
  if (!source.roots.some(root => root.role === "account")) result.report.findings.push("Account-side evidence not included; coordinate its separate frozen backup before cutover");
  result.progress["migration-account"] = { bot: source.botUserId, operator: source.operatorUserId };
  const natives = new Map<string, Native[]>(), damaged: string[] = [];
  for (const path of paths) if (source.roots.some(root => root.role === "native" && path.startsWith(`${root.name}/`)) && path.endsWith(".jsonl")) {
    try { const saved = native(snapshot, path); natives.set(saved.id, [...(natives.get(saved.id) ?? []), saved]); }
    catch { damaged.push(path); result.progress[`migration-file:${identity("file", snapshot.original(path))}`] = { disabled: true, reason: "Damaged historical native file" }; }
  }
  const selected = (nativeId: string): Native | undefined => {
    const files = natives.get(nativeId) ?? [], explicit = source.currentFiles[nativeId];
    return explicit ? files.find(file => file.file === explicit) : files.length === 1 ? files[0] : undefined;
  };
  if (damaged.length) result.report.findings.push(`${damaged.length} damaged native file(s); paths retained in migration-damaged progress and backup`);
  result.progress["migration-damaged"] = damaged;
  const all = new Set([...runtime.keys(), ...manifests.keys(), ...archived.keys(), ...retired.keys()]);
  for (const files of natives.values()) for (const saved of files) for (const entry of saved.entries) {
    const marker = bindingMarker(entry); if (marker?.conversationId) all.add(conversation(marker.conversationId));
  }
  if (all.size > 4096) throw Error("Migration exceeds 4096 conversations; split only at an approved coherent host boundary");
  const hierarchy = optional("live-workspaces/hierarchy.json"), archiveHierarchy = optional("live-workspaces/archive-hierarchy.json");
  for (const value of [hierarchy, archiveHierarchy]) if (value && (value.version !== 1 || value.hostId !== source.hostId)) throw Error("Foreign or unsupported hierarchy journal");
  const hostRooms = new Set([...manifests.values()].flatMap(row => row.hostSpace ? [room(row.hostSpace)] : []));
  for (const node of rows(hierarchy?.nodes)) if (node.kind === "host_space" && node.roomId) hostRooms.add(room(node.roomId));
  if (hostRooms.size > 1) throw Error("Conflicting original host Spaces");
  const node = (kind: RoomNode["stamp"]["kind"], key: string, name: string, roomId: string): RoomNode => {
    const stamp = { version: 1 as const, host: source.hostId, node: identity("room", source.hostId, source.botUserId, kind, key), kind };
    const value: RoomNode = { stamp, name, operator: source.operatorUserId, room: roomId, attempted: true, inviteAttempted: true, imported: inventory.digest };
    const progressKey = `setup-node:${stamp.node}`, previous = result.progress[progressKey];
    if (previous && (previous as RoomNode).room !== roomId) throw Error("Conflicting original hierarchy receipts");
    result.progress[progressKey] = value; return value;
  };
  if (hostRooms.size) node("host", source.hostId, source.hostId, [...hostRooms][0]!);
  const archiveRoots = rows(archiveHierarchy?.nodes).filter(item => object(item.target).kind === "archive_root_space" && item.roomId);
  if (archiveRoots.length > 1) throw Error("Conflicting original Archive Spaces");
  if (archiveRoots.length) node("archive", source.hostId, "Archive", room(archiveRoots[0]!.roomId));
  let position = 0;
  for (const key of [...all].sort()) {
    const manifest = manifests.get(key), row = runtime.get(key), report: ReportRow = { conversation: key, enabled: false, archived: archived.has(key), unattempted: 0, uncertain: 0, outputs: 0, polls: 0, findings: [], omittedFindings: 0 };
    result.report.bindings.push(report);
    const finding = (text: string) => note(report, text);
    if (manifest && (archived.has(key) && (archived.get(key)!.roomId !== manifest.roomId || archived.get(key)!.creationKey !== manifest.creationKey) || retired.has(key) && retired.get(key)!.creationKey !== manifest.creationKey)) throw Error("Conflicting archive/retirement and manifest identities");
    const currentId = manifest ? id(manifest.piSessionId) : undefined;
    const generations = manifest ? rows(manifest.generations, 256) : [];
    if (manifest && (manifest.activeGenerationId === undefined) !== (manifest.generations === undefined)) throw Error("Incomplete generation identity");
    if (generations.length && (generations.at(-1)!.piSessionId !== currentId || generations.at(-1)!.generationId !== manifest!.activeGenerationId || generations.some((item, index) => item.ordinal !== index + 1) || new Set(arrayStrings(generations)).size !== generations.length)) throw Error("Conflicting generation history");
    const transitionId = row?.generationTransition ? object(row.generationTransition).toPiSessionId : undefined;
    const associated = new Set([...(currentId ? [currentId] : []), ...arrayStrings(generations), ...(transitionId ? [id(transitionId)] : [])]);
    for (const [nativeId, files] of natives) if (files.some(saved => saved.entries.some(entry => bindingMarker(entry)?.conversationId === key))) associated.add(nativeId);
    for (const nativeId of associated) {
      const files = natives.get(nativeId) ?? [], saved = selected(nativeId);
      const lastPolicy = saved?.entries.filter(entry => entry.type === "custom" && ["managed-session.binding", "managed-session.unbound", "matrix-bridge.enrollment"].includes(String(entry.customType)) && (object(entry.data).sessionId === nativeId || object(entry.data).nativeId === nativeId)).at(-1);
      const privateChoice = lastPolicy?.customType === "managed-session.unbound" || lastPolicy?.customType === "matrix-bridge.enrollment" && object(lastPolicy.data).enabled === false;
      const disabled = nativeId !== currentId || retired.has(key) || !manifest?.roomId || !row || row.operatorDeparted === true || !saved || Boolean(privateChoice) || manifest.kind === "coordinator";
      const policy: EnrollmentPolicy = { ...(saved ? { file: saved.file } : {}), disabled, reason: disabled ? "Historical, retired, disabled, coordinator or incomplete migration identity; use local Pi without reenrollment" : "Original migrated binding" };
      const policyKey = `migration-native:${nativeId}`, previous = result.progress[policyKey];
      if (previous && canonical(previous) !== canonical(policy)) throw Error("Native identity belongs to conflicting conversations");
      result.progress[policyKey] = policy;
      for (const item of files) result.progress[`migration-file:${identity("file", item.file)}`] = { nativeId, ...policy };
      if (!saved) finding(`Native identity missing or ambiguous: ${nativeId}`);
    }
    if (!manifest || !currentId) { finding("Manifest/current generation missing; no active binding created"); continue; }
    report.nativeId = currentId; report.room = optionalRoom(manifest.roomId);
    const saved = selected(currentId);
    if (!saved) { finding("Original native history unavailable; no replacement created; pending work retained unresolved in backup"); continue; }
    const nativePolicy = result.progress[`migration-native:${currentId}`] as EnrollmentPolicy;
    report.nativeId = currentId; report.file = saved.file;
    report.room = optionalRoom(manifest.roomId);
    report.enabled = !nativePolicy.disabled;
    if (row?.archiveId && !archived.has(key)) { finding("Runtime archive has no matching archive record"); report.enabled = false; nativePolicy.disabled = true; }
    const boundary = id(manifest.bindingBoundaryEntryId);
    const originalBoundary = saved.entries.findIndex(entry => legacyEntry(saved.id, id(entry.id)) === boundary);
    if (originalBoundary < 0) { finding("Original native binding boundary is missing"); report.enabled = false; nativePolicy.disabled = true; }
    const binding: Binding = { key: identity("binding", saved.file, saved.id), file: saved.file, nativeId: saved.id, cwd: saved.cwd, title: String(manifest.title ?? manifest.concept ?? key).slice(0, 512), boundary: saved.tail, archived: report.archived || retired.has(key), enabled: report.enabled, resumePending: true, archiveRevision: 0, ...(report.room ? { room: report.room } : {}) };
    report.archived = binding.archived;
    binding.grouping = Object.fromEntries(["projectSpace", "checkoutSpace", "projectKey", "checkoutId"].flatMap(field => typeof manifest[field] === "string" ? [[field, String(manifest[field])]] : []));
    result.bindings.push(binding);
    if (saved.tail) result.progress[`projection:${binding.key}`] = saved.tail;
    result.progress[`migration-binding:${binding.key}`] = { source: inventory.digest, conversation: key, nativePath: saved.path, nativeSha256: sha256(snapshot.file(saved.path)), originalBoundary: boundary };
    if (binding.room) node("conversation", binding.key, binding.title, binding.room);
    const mapped = source.groupings[key];
    let grouping: Grouping | undefined;
    if (mapped && (saved.cwd === mapped.checkout || saved.cwd.startsWith(`${mapped.checkout}/`)) && manifest.projectSpace && manifest.checkoutSpace) {
      grouping = { ...mapped, projectName: String(manifest.projectDisplayName ?? "Project"), checkoutName: String(manifest.checkoutDisplayName ?? "Checkout") };
      node("project", grouping.project, grouping.projectName, room(manifest.projectSpace));
      node("checkout", grouping.checkout, grouping.checkoutName, room(manifest.checkoutSpace));
    } else finding("Original grouping mapping incomplete; preserve rooms without creating replacement Spaces");
    result.progress[`setup:${binding.key}`] = { stage: "grouping", archived: binding.archived, archiveRevision: 0, ...(grouping ? { grouping } : {}), error: "Imported original rooms; current Matrix accessibility/creator/membership still unverified" };
    if (binding.archived && archived.has(key) && !archiveRoots.length) result.progress[`migration-grouping-hold:${binding.key}`] = "Original Archive evidence is missing; no replacement Archive will be created";
    const oldArchive = rows(archiveHierarchy?.entries, 4096).find(item => object(object(item.plan).source).conversationId === key);
    if (oldArchive) {
      const targets = rows(object(oldArchive.plan).targets), parents = rows(archiveHierarchy?.nodes).filter(item => object(item.target).kind === "archive_worktree_space" && targets.some(target => target.key === object(item.target).key) && item.roomId);
      result.progress[`migration-archive-parents:${binding.key}`] = parents.map(item => node("checkout", `migration-archive:${room(item.roomId)}`, "Historical Archive checkout", room(item.roomId)));
    }
    const inputRows = [...rows(row?.pendingInputs, 2048), ...rows(row?.pendingControls, 2048)];
    for (const input of inputRows) {
      const eventId = string(input.matrixEventId, 255);
      if (!eventId.startsWith("$")) throw Error("Invalid original input event identity");
      const completed = input.status === "completed", cancelled = input.status === "cancelled";
      const nativeAttempt = saved.entries.some(entry => entry.type === "custom" && entry.customType === "managed-session.delivery" && object(entry.data).matrixEventId === eventId);
      const unattempted = input.status === "accepted" && !nativeAttempt;
      const state: Input["state"] = completed ? "settled" : cancelled ? "ignored" : "interrupted";
      result.progress[`migration-input:${eventId}`] = { unattempted, originalStatus: input.status ?? "control-uncertain" };
      const event: Row = { event_id: eventId, type: "m.room.message", sender: input.senderUserId, content: { msgtype: "m.text", body: typeof input.body === "string" ? input.body : "" }, "pi.migration": { original: input, unattempted, conversation: key } };
      if (result.inputs.some(item => item.id === eventId)) throw Error("Conflicting original input event identity");
      result.inputs.push({ id: eventId, binding: binding.key, position: ++position, event, state, held: true, archiveRevision: -1 });
      if (!completed && !cancelled) { if (unattempted) report.unattempted++; else report.uncertain++; }
      if (input.media && !completed && !cancelled) {
        const media = object(input.media), digest = string(media.sha256, 64);
        const blobPath = `${source.roots.find(root => root.role === "state")!.name}/media-spool/data/${digest}.blob`;
        if (!/^[a-f0-9]{64}$/.test(digest) || !paths.has(blobPath)) { finding(`Required inbound media missing: ${eventId}`); continue; }
        const bytes = snapshot.file(blobPath);
        if (bytes.length !== media.byteLength || sha256(bytes) !== digest || !["image/jpeg", "image/png", "image/webp"].includes(String(media.mimeType))) { finding(`Inbound media integrity mismatch: ${eventId}`); continue; }
        result.images.push({ input: eventId, path: blobPath, size: bytes.length });
      }
    }
    for (const projection of rows(row?.projection, 4096)) {
      if (!["offered", "projecting", "projected", "cancelled"].includes(String(projection.status))) throw Error("Unknown legacy projection state");
      const chunks = rows(projection.chunks, 64);
      if (projection.status === "cancelled" || projection.kind === "matrix_user") continue;
      if (!chunks.length && projection.status !== "projected") finding(`Unfrozen output unresolved: ${id(projection.entryId)}`);
      for (const [index, chunk] of chunks.entries()) {
        if (chunk.status === "sent") continue; // No fabricated Matrix event receipt for legacy boolean acknowledgements.
        if (chunk.status !== "pending") throw Error("Unknown projection chunk state");
        const content = frozen(projection, chunk, index);
        if (!content || projection.status === "projected") { finding(`Unresolved output/poll: ${id(projection.entryId)}`); continue; }
        const transactionId = transaction(chunk.transactionId);
        const output = { id: transactionId, binding: binding.key, source: `migration:${id(projection.entryId)}:${id(chunk.chunkId)}`, type: "m.room.message", content };
        if (rows(row?.repairQueueHolds).some(hold => hold.kind === "projection" && hold.id === projection.entryId)) {
          result.progress[`migration-held-output:${transactionId}`] = output;
          finding(`Frozen output remains held by an old queue decision: ${id(projection.entryId)}`);
        } else { result.outputs.push(output); report.outputs++; }
      }
    }
    for (const entry of saved.entries) if (entry.type === "custom" && entry.customType === "managed-session.projection" && object(entry.data).status === "offered" && !rows(row?.projection).some(item => item.entryId === object(entry.data).entryId)) finding(`Native offered output lacks frozen registry evidence: ${id(entry.id)}`);
    for (const entry of saved.entries.slice(originalBoundary + 1)) {
      const message = entry.type === "message" ? object(entry.message) : undefined;
      if (!message || !["user", "assistant"].includes(String(message.role))) continue;
      const represented = saved.entries.some(marker => marker.type === "custom" && ["managed-session.projection", "managed-session.delivery"].includes(String(marker.customType)) && (String(object(marker.data).piEntryKey ?? "").split(":")[0] === entry.id || object(marker.data).piEntryId === legacyEntry(saved.id, id(entry.id)))) || rows(row?.projection).some(item => item.entryId === legacyEntry(saved.id, id(entry.id)));
      if (!represented) finding(`Unclassified native message retained without backfill: ${id(entry.id)}`);
    }
    for (const entry of saved.entries) if (entry.type === "custom" && entry.customType === "managed-session.checkpoint" && object(entry.data).status === "offered") {
      const checkpointId = id(object(entry.data).checkpointId);
      if (!rows(row?.projection).some(item => item.entryId === legacyEntry(saved.id, `checkpoint:${checkpointId}`))) finding(`Unfrozen native checkpoint unresolved: ${checkpointId}`);
    }
    const polls = [row?.publishingControlPoll, row?.activeControlPoll, row?.publishingCheckpointPoll, row?.activeCheckpointPoll, ...rows(row?.closingCheckpointPolls, 64)].filter(value => value != null);
    report.polls = polls.length;
    if (polls.length) finding("Original polls retained inactive; pending publication/closure requires receipt reconciliation, never a resumed control/answer");
    result.progress[`migration-polls:${binding.key}`] = polls;
    result.progress[`migration-legacy:${binding.key}`] = { runtimePath: `${state}/registry.json`, manifest, archive: archived.get(key) ?? null, retirement: retired.get(key) ?? null, projection: row?.projection ?? [], artifacts: row?.artifactExports ?? [] };
    if (rows(row?.artifactExports).some(item => item.state !== "sent")) finding("Historical outbound artifacts retained only in backup; no upload/export authority imported");
    if (!row) finding("Runtime evidence missing; binding disabled");
    if (report.uncertain) finding("Potentially executed inputs are interrupted and will not replay");
    if (report.unattempted) finding("Safely unattempted inputs are held for an explicit fresh instruction, not auto-replayed");
  }
  const inbox = optional("inbox.json");
  if (inbox) {
    if (inbox.version !== 1) throw Error("Unsupported durable inbox");
    if (inbox.lastBatch != null) result.cursor = string(inbox.lastBatch, 4096);
    for (const job of rows(inbox.jobs, 4096)) {
      const binding = result.bindings.find(item => (result.progress[`migration-binding:${item.key}`] as Row).conversation === job.conversationId);
      if (!binding?.room) { result.report.findings.push(`Inbox job without readable binding: ${string(job.id, 128)}`); continue; }
      const response = object(job.response), joined = object(object(response.rooms ?? {}).join ?? {}), timeline = object(object(joined[binding.room] ?? {}).timeline ?? {});
      if (timeline.limited === true) result.report.findings.push(`Unresolved limited inbox interval: ${string(job.id, 128)}`);
      for (const event of rows(timeline.events, 4096)) {
        const eventId = string(event.event_id, 255);
        if (!eventId.startsWith("$")) throw Error("Invalid inbox event identity");
        const existing = result.inputs.find(item => item.id === eventId);
        if (existing) { if (existing.binding !== binding.key) throw Error("Inbox event belongs to conflicting rooms"); existing.event = { ...event, "pi.migration": existing.event["pi.migration"] }; }
        else {
          const unattempted = ![...natives.values()].flat().some(saved => saved.entries.some(entry => entry.type === "custom" && entry.customType === "managed-session.delivery" && object(entry.data).matrixEventId === eventId));
          const content = object(event.content ?? {});
          const relevant = event.sender !== source.botUserId && (event.type === "m.room.message" && ["m.text", "m.image"].includes(String(content.msgtype)) || ["m.poll.response", "org.matrix.msc3381.poll.response"].includes(String(event.type)));
          result.progress[`migration-input:${eventId}`] = { unattempted, inbox: job.id };
          result.inputs.push({ id: eventId, binding: binding.key, position: ++position, event: { ...event, "pi.migration": { unattempted, inbox: job.id } }, state: relevant ? "interrupted" : "ignored", held: true, archiveRevision: -1 });
          const report = result.report.bindings.find(item => item.conversation === job.conversationId)!;
          if (relevant) report[unattempted ? "unattempted" : "uncertain"]++;
          if (content.msgtype === "m.image") {
            note(report, `Inbox image has no proven downloaded media; original event retained: ${eventId}`);
          }
        }
      }
    }
  } else result.report.findings.push("Durable inbox/cursor missing; explicit cutover review required");
  if (!result.cursor && [...cursors.values()].some(cursor => cursor !== undefined)) throw Error("Established legacy room cursors require a coherent global inbox cutoff; no fresh-sync reset is permitted");
  // Preserve each old room's intake cutoff. Recover an older interval under the
  // initial hold before advancing to the first new sync; never skip it merely
  // because another room advanced the old global inbox cursor.
  for (const binding of result.bindings) if (binding.room) {
    const key = (result.progress[`migration-binding:${binding.key}`] as Row).conversation as string;
    const since = cursors.get(key);
    if (since !== undefined) {
      result.progress[`room-cursor:${binding.room}`] = since;
      if (result.cursor && since !== result.cursor) result.progress[`gap:${binding.room}`] = { from: since, to: result.cursor, tail: [], tokens: [since] };
    }
  }
  const outbox = optional("notice-outbox.json");
  if (outbox && outbox.version !== 1) throw Error("Unsupported notice outbox");
  let unresolvedNotices = 0;
  for (const notice of rows(outbox?.notices, 4096)) if (notice.sent !== true) {
    const key = conversation(notice.conversationId), entryId = legacyEntry(id(notice.piSessionId), `notice:${string(notice.sourceId, 4096)}`);
    const projection = rows(runtime.get(key)?.projection).find(item => item.entryId === entryId);
    if (projection && (projection.status === "projected" || rows(projection.chunks, 64).length && rows(projection.chunks, 64).every((chunk, index) => chunk.status === "sent" || frozen(projection, chunk, index)))) continue;
    unresolvedNotices++;
    const report = result.report.bindings.find(item => item.conversation === key);
    if (report) note(report, `Unfrozen notice remains unresolved: ${String(notice.sourceId)}`);
  }
  if (unresolvedNotices) result.report.findings.push(`Notice outbox: ${unresolvedNotices} unfrozen item(s) retained in backup for receipt/materialization review`);
  result.report.omittedFindings = Math.max(0, result.report.findings.length - 64);
  result.report.findings = result.report.findings.slice(0, 64);
  return result;
}
