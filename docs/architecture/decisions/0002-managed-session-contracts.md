# ADR 0002: Managed-session domain and contract boundaries

- **Status:** Accepted
- **Date:** 2026-08-31
- **Issue:** [#38](https://github.com/BeaudanBrown/pi-harness/issues/38)
- **Epic:** [#37](https://github.com/BeaudanBrown/pi-harness/issues/37)

## Context

The direct `remote-session` extension combines Matrix polling, Pi adaptation, and conversation state inside every attached Pi process. Managed sessions replace that arrangement with one boot-persistent, host-local relay. Before the relay and adapter can be implemented independently, they need one fail-closed language for lifecycle, IPC, identity, and persistence.

The original v1 trust boundary was one configured Unix user and one configured Matrix operator MXID. The V2 amendment makes current room membership authoritative: every currently joined sender has equal managed-conversation authority except the relay bot and a bounded exact configured set of service-account MXIDs. Matrix credentials belong only to the relay. The adapter must be able to express Pi/session behavior without gaining process, tmux, filesystem, Matrix, or host-wide authority.

## Decision

### Ubiquitous language

- **Managed conversation:** One host-owned Matrix room, one persisted Pi session, and zero or one attached Pi process. Its immutable identity and concept name outlive individual processes.
- **Host relay:** The one boot-persistent process on an enabled host that owns Matrix, the conversation registry, delivery queues, transcript projection, and lifecycle coordination.
- **Coordinator:** The guaranteed, non-deletable managed conversation whose adapter has the coordinator capability role. It can request host-wide workspace and conversation lifecycle operations. It is not a task metadata store.
- **Adapter:** Pi-local code that translates between the relay protocol and Pi-native session/input behavior. It has no Matrix client or arbitrary host control.
- **Attachment:** The relay-accepted, nonce-authorized association between one running adapter and one managed conversation. A conversation has at most one accepted attachment; an adapter reconnect does not create a second attachment.
- **Binding boundary:** The durable Pi transcript entry ID recorded when a persisted Pi session becomes bound. Only eligible entries after this boundary may be projected. Forked and new sessions do not inherit it.
- **Delivery:** One authorized Matrix text event accepted for ordered handling by one conversation. Acceptance is durable before adapter injection. A delivery progresses through accepted, delivered, persisted, completed, or cancelled states.
- **Transcript projection:** Idempotent mapping of eligible persisted Pi entries or structured relay events into Matrix transactions. Persisted Pi transcript entries, not ephemeral adapter output, are the ordinary outbound source of truth.
- **Workspace identity:** A portable tuple of configured root key, immediate-child workspace name, and safe relative cwd. It identifies checkout placement and is resolved and canonicalized by host-owned launcher code; it is not an arbitrary path.
- **Project identity:** A host-authoritative stable key and display name. A harness-owned authority wrapper enriches the configured tmux launcher’s canonical workspace result: Git checkouts derive the key from the validated common directory shared by the main checkout and linked worktrees, while non-Git workspaces derive it from their workspace identity. Project identity selects a Matrix project Space, while workspace identity remains the conversation checkout identity.
- **Managed worktree intent:** A private host-local, bounded, idempotent record binding one coordinator request to a canonical Git common directory, explicit existing base ref and commit, new local branch, deterministic sibling checkout, and lifecycle phase. Names never prove ownership without this intent and fresh host validation.
- **Worktree removal preview:** A private stable snapshot of the exact linked checkout registration, local branch tip, cleanliness, lock state, optional explicit merge target, and optional bundled conversation. Confirmation applies only while that identity still matches.
- **Conversation state:** Exactly `starting`, `active`, or `dormant`. Starting means a wake or creation is in progress; active means one attachment is accepted; dormant means no attachment is accepted. There is no archived state or idle timeout.

“Session” alone means a persisted Pi session. “Conversation” means the relay/Matrix concept. “Attachment” means the live association; these terms are not interchangeable.

### Conversation lifecycle

One enabled host owns independent conversations. The lifecycle-only coordinator can inventory a validated Git project's root checkout and linked worktrees and can create a linked worktree independently or before creating its idle conversation. Creation requires an unambiguous existing local branch, remote-tracking ref, or tag and a previously absent valid local branch. The host derives a bounded sibling directory from the main checkout and branch plus a digest; callers cannot select a path. A private intent is durable before Git mutation, and retry reuses only the recorded branch at the recorded base commit and exact registered checkout. Conflicts and moved identities fail closed. Git operations are serialized per common directory and never fetch, push, add remotes, scaffold, or inject a task.

Worktree and conversation removal remain independent. A stable preview precedes removal and records exact Git identity, clean status including untracked and ignored residue, lock state, active bound conversations, and an optional explicit merge target. Independent removal refuses an active managed process and uses ordinary non-force `git worktree remove`; it preserves all conversations and the local branch. Bundled cleanup stops only the selected exact process, removes the clean unlocked linked worktree, then performs existing bridge deletion by conversation identity. Its private phases recover forward if interrupted. Local branch deletion is a later, separately confirmed operation and succeeds only when the unchanged branch is checked out nowhere and is an ancestor of the unchanged explicit merge target. Root checkouts, remote refs, force removal, force deletion, and automatic rollback are unavailable.

Creating a project conversation validates a workspace identity, persists Pi first, then binds Matrix. The coordinator may first request creation of one absent immediate-child workspace: the host launcher records a length-framed workspace-derived durable creation key, initializes only a local Git repository on `main`, and then follows the same empty-session binding path. Private deterministic Matrix aliases and a durable provisioning intent reconcile uncertain Space and room creation responses before later phases continue. It does not accept scaffolding, commands, initial tasks, remotes, or publication. Task objectives arrive only as later user messages; they are never lifecycle metadata, coordinator-generated orientation, or injected prompts. Multiple conversations may use one workspace; conflict avoidance remains the operator’s responsibility. Newly started root-checkout and linked-worktree conversations share the deterministic Space selected by project identity and retain distinct checkout names in their rooms. Existing manifests without project identity are not inferred or reparented during startup. Coordinator-only reconciliation first previews an exact host-resolved plan, then requires the stable plan key and explicit confirmation before writing a private phase intent and moving existing room IDs. Target linking precedes the atomic manifest identity update, and old-parent unlinking follows it, so interruption is forward-recoverable without replacing rooms, sessions, runtime queues, or workspace state. Obsolete-Space cleanup is a separately confirmed operation that accepts only unreferenced, empty, bot-controlled Spaces; worktree removal and room deletion remain independent lifecycle operations.

Stopping durably cancels the current delivery, terminates only the exact managed Pi instance/window, and leaves the conversation dormant. Bridge deletion removes relay, Matrix, and binding metadata only. It does not delete Pi history, a process/window, workspace files, or Git state. The coordinator cannot be deleted. Native `/fork` and `/new` produce unbound sessions. A session switch detaches the old session, then attaches the new session only if that exact session already has a binding.

Normal managed Pi processes occupy dedicated windows in the workspace’s existing root tmux session. The coordinator occupies `default/coordinator`. The relay fixes `TMUX_TMPDIR` to the user's `XDG_RUNTIME_DIR`, and the host launcher rejects a managed invocation that would address a different tmux server. Managed windows carry bounded conversation ID and concept options so the existing interactive `tmux_project` launcher can list and switch to the exact live Pi window without creating a process; dormant conversations have no launcher entry. Project launch uses fixed host-owned `direnv exec <validated-cwd> pi …` arguments. The launcher's `pi` dispatcher enters managed mode only for the exact trusted `project` and `coordinator` roles; an absent role clears managed-only identity and delegates to the ordinary interactive harness because the shared tmux server may propagate the launcher PATH to normal shells, while any other non-empty role fails closed. Lifecycle code never uses `tmux send-keys`. The workspace tuple is resolved to exactly one immediate child of its named root before its relative cwd is accepted, and the host rejects a supplied workspace path that disagrees with that canonical result.

### Host, Matrix, transcript, and recovery invariants

`services.pi-harness.managedSessions.enable` is one atomic feature switch for the relay service, credentials, ordinary adapter, coordinator profile, commands, and tools. A disabled host exposes none of them. Each enabled host has one bot `/sync` connection and one private, peer-UID-checked Unix-socket relay serving many conversations and adapters. The old direct per-Pi Matrix bridge is removed and its state is not imported.

Every room is permanently host-owned. Text from any currently joined, non-ignored sender in a conversation room routes directly to that conversation without a host prefix or last-host routing. The relay bot and configured exact bridge service-account MXIDs are always ignored; no display-name, localpart, wildcard, or application-service namespace heuristic grants or removes authority. Joined bridge puppet identities receive the same authority as other participants. Edits, reactions, threads, attachments, voice, other media, and unauthorized senders are ignored. A host Space contains its coordinator room and project Spaces selected by host-resolved project keys, never by caller-supplied paths, display-name equality, or arbitrary Matrix IDs. The coordinator manifest may retain that host Space ID so an inaccessible coordinator room can be replaced without changing the durable Pi session identity. Conversation names are unique per host and immutable while bound.

After the binding boundary, Matrix-origin user entries map to their original Matrix events and are not echoed by the bot. The accepting sender MXID is persisted before cursor advancement and included in ordinary model-visible input attribution; leading-slash commands preserve Pi's native command/template dispatch, and legacy accepted deliveries without sender metadata remain readable. Terminal-origin user entries are projected as labelled local-user messages. Persisted final assistant responses and explicit checkpoints are projected. Thinking, tool calls/results, partial assistant output, internal and compaction entries, and pre-binding history are never projected. Projection uses sanitized bounded Markdown plus plain-text fallback, deterministic chunks, and stable transactions.

Dormant text input is durably queued in Matrix event order before a wake is attempted. Unexpected process failure retries accepted-before-persistence deliveries, resumes persisted unfinished deliveries without duplicating the Pi entry, and projects persisted unprojected finals. Explicit stop and abort record durable cancellation and are not recovered. Relay restart allows existing adapters to reconnect before unmatched conversations become dormant. Launch, attachment, and bridge failures retain input for retry and emit concise redacted notices. Only the guaranteed coordinator room is automatically replaced when inaccessible.

### Protocol contract

`config/agent/extensions/managed-sessions/contracts.ts` is the shared normative TypeScript contract. V1 uses one UTF-8 JSON object per LF-terminated frame with a 64 KiB maximum. Every object and payload rejects additional properties. Every envelope carries literal protocol version `1.0.0`, a message ID, role, type, and typed payload. Bound operations also carry the conversation ID; the sole exception is initial `self.bind`, because an unbound persisted Pi session has no conversation identity yet. Initial binding carries the process's bounded attachment nonce and host-owned portable workspace placement so the relay can persist the logical project manifest plus only the nonce's one-way verifier before accepting the subsequent attachment. Relay responses may correlate with `inReplyTo`.

The checkpoint tool's model-facing schema is one flat bounded object because llama.cpp constrained decoding emits empty arguments for a root union; strict kind-specific exact-field validation still runs before persistence or relay contact. The protocol schema permits only:

- attachment attach/detach and session change;
- input delivery and staged acknowledgement;
- transcript offer and acknowledgement;
- structured checkpoint offer and acknowledgement;
- ordinary self bind/status/confirmed bridge deletion;
- coordinator workspace/worktree inventory, bounded local-project and linked-worktree creation, preview-key-confirmed worktree/bridge cleanup, separately confirmed merged local-branch deletion, and conversation list/status/start/resume/stop/confirmed delete;
- relay attachment acceptance, typed operation results, termination requests, and typed errors.

Role/type combinations are encoded in the union: ordinary adapters cannot construct coordinator lifecycle requests, coordinator deletion is absent, and only the relay can deliver input, acknowledge projection, request termination, or report errors. The relay still authenticates peer UID, attachment nonce, registered conversation role, and request correlation; the claimed schema role grants no authority by itself.

Unknown versions, message types, fields, enum values, invalid role/type combinations, invalid operation shapes, malformed UTF-8/JSON/framing, and oversized frames fail closed. Semantic validation additionally enforces safe workspace identity, input-body rules, staged acknowledgement requirements, and confirmation literals.

### Explicit protocol non-goals

There is no protocol operation or payload field for:

- arbitrary commands, argv, executable paths, shell text, file reads/writes, environment values, PIDs, caller-selected worktree paths, or caller-selected tmux targets;
- Matrix access tokens, arbitrary Matrix endpoints, arbitrary room sends, media, attachments, edits, reactions, threads, or voice;
- thinking, tools, tool results, partial assistant output, compaction, or internal entries;
- cross-host discovery, migration, room sharing, claims, or process control;
- task objectives or hidden prompt injection;
- importing or interpreting legacy direct-bridge bindings.

The typed workspace identity and relay-selected lifecycle operation are the only placement inputs. Host launcher code maps them to canonical paths and fixed argv.

### Persistence split

Synchronized **conversation manifests** contain only portable logical identity: schema version, conversation kind, owning host key, stable conversation/creation identity, immutable concept, Pi session, Matrix room, binding boundary, creation time, and (for project conversations) workspace identity plus optional stable project identity and project Space for pre-reconciliation compatibility. They contain no credentials, process observations, pending message bodies, or legacy bridge state.

Host-local **runtime state** contains the lifecycle state, current attachment observation, an optional one-way attachment-nonce verifier, Matrix cursor, bounded accepted-input records, bounded projection records and transaction IDs, managed tmux observation, and a concise redacted launch error. Raw attachment nonces are never persisted. Runtime state is written by atomic replacement in a private host directory. Storage implementations must fsync/write/rename safely and must never recover from malformed primary state by silently accepting a partial temporary file.

Parsers reject unsupported versions, extra fields, malformed timestamps and workspace identities, impossible active/dormant attachment combinations, duplicate conversation/delivery/event/projection/transaction identities, host ownership mismatches, and any mismatch between the synchronized manifest set and host-local registry. There is no best-effort merge. Operators must resolve conflicting synchronized state explicitly.

### Stable identity and idempotency

Derivations use SHA-256 with a distinct `pi-managed-sessions:<domain>:v1` prefix and length-framed UTF-8 inputs:

| Identity | Inputs | Form |
| --- | --- | --- |
| Conversation ID | host ID, creation key | `conv_` + 32 hex |
| Matrix delivery ID | conversation ID, Matrix event ID | `delivery_` + 32 hex |
| Pi transcript entry ID | Pi session ID, persisted Pi entry key | `entry_` + 32 hex |
| Transcript chunk ID | entry ID, zero-based chunk index | `chunk_` + 32 hex |
| Matrix transaction ID | conversation ID, source ID, zero-based chunk index | `pi_` + 48 hex |

Creation keys are durable retry keys, not display names. Coordinator-created conversation keys are supplied by the trusted coordinator adapter. Manual ordinary `/remote on` creates its key once, persists it with the binding-boundary attempt before contacting the relay, and reuses that key on retry. Matrix event IDs identify inbound deliveries. Persisted Pi entry keys identify transcript entries. The same logical operation therefore derives the same ID after restart, while domains and length framing prevent ambiguous concatenation and cross-purpose reuse. Chunk boundaries must be deterministic before deriving chunk and transaction IDs.

### V2 rich-interaction and generation amendment

Protocol and durable state version `2.0.0` is the reviewed final breaking boundary. A managed conversation owns one Matrix room and an ordered, append-only list of **session generations**. Exactly the newest generation is Matrix-active; older Pi session files and Matrix history are preserved but cannot receive Matrix input. Context reset atomically appends a generation and switches the active generation identity. Stable activity, poll, blob, upload, and generation-transition identities use length-framed SHA-256 derivations with distinct `v2` domains. Activity edits carry monotonically increasing revisions, and finalization turns the card into a permanent balanced run/context snapshot before the final response is projected.

The epic uses one explicit temporary `1.x` compatibility strategy while vertical feature slices land before the final cutover owned by #63. The relay, adapter, and host state are distributed as one atomic package and may use strict optional projections of reviewed V2 fields under the existing envelope during this staging period; mixed package versions and downgrade are unsupported. Generation IDs already use their final V2 derivation domains. Compatibility manifests retain both active convenience fields and the complete append-only generation history, and the migration validates the synchronized manifest/runtime bundle before preserving that history and metadata in the V2-only shape. Successful exact model and thinking selections are separately persisted as current conversation preferences only after the relay validates the typed result against its pending authorized control; restarts and fresh generations restore both preferences without rewriting prior generations. The host launcher validates and forwards those optional selections to project and coordinator tmux environments. A typed status result supplies only live idle/busy, actual model/thinking, and balanced context usage; the relay composes it with authoritative bounded manifest/runtime fields and projects a redacted status notice, making requested/runtime model mismatches explicit. The compatibility reader does not accept a `2.0.0` store, and the migration output is not activated as the live store until #63 switches all runtime readers and writers together. No later slice may reinterpret or flatten compatibility generation history.

V2 controls are typed operations, never prompt text. Every accepted joined participant has equal control and session-management authority. State-changing controls are accepted only while idle. Adapter-executed controls and slash commands may hold reference-counted ephemeral Matrix typing leases; durable control, input, and activity state remains authoritative and typing itself is not persisted. Control-selection and option-bearing checkpoint polls request a room notification through deterministic `m.mentions` content; participant push settings remain authoritative and poll closures do not notify. A checkpoint's first valid currently joined participant vote or ordinary-text bypass resolves it while later resolutions are invalid. Tool activity may expose only a bounded tool name and state. Arguments, paths, commands, output, partial answers, and reasoning have no contract field.

Media IPC never carries a filesystem path. Inbound images and explicit outbound artifacts use blob/upload identities and bounded begin/chunk operations whose encoded NDJSON frame remains at most 64 KiB. The private host spool permits at most 128 blobs, 25 MiB per blob, and 256 MiB total. A blob is committed only after declared length and SHA-256 verification; incomplete, expired, rejected, and consumed blobs are removed, with cleanup idempotent across restart. Workspace artifact handles are resolved and canonicalized by the host; adapters cannot nominate paths.

V1 synchronized manifests migrate one-way and atomically to generation ordinal 1, preserving conversation, room, Pi session, binding boundary, and creation identities. Registry and complete manifest set must match before migration. A malformed source, partial destination, unknown version, or interrupted migration fails closed with an actionable diagnostic; there is no downgrade or best-effort repair.

Only the fixed host launcher, after validating a configured root, immediate-child workspace, and relative cwd, may grant Pi's run-scoped project approval to a managed process. It neither answers trust for ordinary interactive Pi launches nor writes persistent user trust. Matrix credentials and blob content remain relay-private, and disabled hosts expose none of this surface.

## Consequences

- Relay, ordinary adapter, coordinator adapter, and tests share one small interface while authority remains relay-enforced.
- Unsupported forward changes fail rather than being reinterpreted. Compatible optional additions require a reviewed `1.x` contract strategy; breaking changes require a new explicit protocol/state version and migration decision.
- Synchronized state is portable but cannot resume another host’s managed conversation. Cross-host continuation remains a fresh conversation on that host.
- The old direct bridge is intentionally outside the model and receives no migration path.
- Text and queues are bounded; reaching a bound produces typed backpressure or an error rather than loss.
