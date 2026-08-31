# ADR 0002: Managed-session domain and contract boundaries

- **Status:** Accepted
- **Date:** 2026-08-31
- **Issue:** [#38](https://github.com/BeaudanBrown/pi-harness/issues/38)
- **Epic:** [#37](https://github.com/BeaudanBrown/pi-harness/issues/37)

## Context

The direct `remote-session` extension combines Matrix polling, Pi adaptation, and conversation state inside every attached Pi process. Managed sessions replace that arrangement with one boot-persistent, host-local relay. Before the relay and adapter can be implemented independently, they need one fail-closed language for lifecycle, IPC, identity, and persistence.

The v1 trust boundary is one configured Unix user and one configured Matrix operator MXID. Matrix credentials belong only to the relay. The adapter must be able to express Pi/session behavior without gaining process, tmux, filesystem, Matrix, or host-wide authority.

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
- **Workspace identity:** A portable tuple of configured root key, immediate-child workspace name, and safe relative cwd. It is resolved and canonicalized by host-owned launcher code; it is not an arbitrary path.
- **Conversation state:** Exactly `starting`, `active`, or `dormant`. Starting means a wake or creation is in progress; active means one attachment is accepted; dormant means no attachment is accepted. There is no archived state or idle timeout.

“Session” alone means a persisted Pi session. “Conversation” means the relay/Matrix concept. “Attachment” means the live association; these terms are not interchangeable.

### Conversation lifecycle

One enabled host owns independent conversations. Creating a project conversation validates a workspace identity, persists Pi first, then binds Matrix. Task objectives arrive only as later user messages; they are never lifecycle metadata, coordinator-generated orientation, or injected prompts. Multiple conversations may use one workspace; conflict avoidance remains the operator’s responsibility.

Stopping durably cancels the current delivery, terminates only the exact managed Pi instance/window, and leaves the conversation dormant. Bridge deletion removes relay, Matrix, and binding metadata only. It does not delete Pi history, a process/window, workspace files, or Git state. The coordinator cannot be deleted. Native `/fork` and `/new` produce unbound sessions. A session switch detaches the old session, then attaches the new session only if that exact session already has a binding.

Normal managed Pi processes occupy dedicated windows in the workspace’s existing root tmux session. The coordinator occupies `default/coordinator`. Project launch uses fixed host-owned `direnv exec <validated-cwd> pi …` arguments. Lifecycle code never uses `tmux send-keys`. The workspace tuple is resolved to exactly one immediate child of its named root before its relative cwd is accepted.

### Host, Matrix, transcript, and recovery invariants

`services.pi-harness.managedSessions.enable` is one atomic feature switch for the relay service, credentials, ordinary adapter, coordinator profile, commands, and tools. A disabled host exposes none of them. Each enabled host has one bot `/sync` connection and one private, peer-UID-checked Unix-socket relay serving many conversations and adapters. The old direct per-Pi Matrix bridge is removed and its state is not imported.

Every room is permanently host-owned. Authorized operator text in a conversation room routes directly to that conversation without a host prefix or last-host routing. Edits, reactions, threads, attachments, voice, other media, and unauthorized senders are ignored. A host Space contains its coordinator room and optional project Spaces; project Space defaults to the workspace name. Conversation names are unique per host and immutable while bound.

After the binding boundary, Matrix-origin user entries map to their original operator events and are not echoed by the bot. Terminal-origin user entries are projected as labelled local-user messages. Persisted final assistant responses and explicit checkpoints are projected. Thinking, tool calls/results, partial assistant output, internal and compaction entries, and pre-binding history are never projected. Projection uses sanitized bounded Markdown plus plain-text fallback, deterministic chunks, and stable transactions.

Dormant text input is durably queued in Matrix event order before a wake is attempted. Unexpected process failure retries accepted-before-persistence deliveries, resumes persisted unfinished deliveries without duplicating the Pi entry, and projects persisted unprojected finals. Explicit stop and abort record durable cancellation and are not recovered. Relay restart allows existing adapters to reconnect before unmatched conversations become dormant. Launch, attachment, and bridge failures retain input for retry and emit concise redacted notices. Only the guaranteed coordinator room is automatically replaced when inaccessible.

### Protocol contract

`config/agent/extensions/managed-sessions/contracts.ts` is the shared normative TypeScript contract. V1 uses one UTF-8 JSON object per LF-terminated frame with a 64 KiB maximum. Every object and payload rejects additional properties. Every envelope carries literal protocol version `1.0.0`, a message ID, role, type, and typed payload. Bound operations also carry the conversation ID; the sole exception is initial `self.bind`, because an unbound persisted Pi session has no conversation identity yet. Relay responses may correlate with `inReplyTo`.

The schema permits only:

- attachment attach/detach and session change;
- input delivery and staged acknowledgement;
- transcript offer and acknowledgement;
- structured checkpoint offer and acknowledgement;
- ordinary self bind/status/confirmed bridge deletion;
- coordinator workspace list and conversation list/status/start/resume/stop/confirmed delete;
- relay attachment acceptance, typed operation results, termination requests, and typed errors.

Role/type combinations are encoded in the union: ordinary adapters cannot construct coordinator lifecycle requests, coordinator deletion is absent, and only the relay can deliver input, acknowledge projection, request termination, or report errors. The relay still authenticates peer UID, attachment nonce, registered conversation role, and request correlation; the claimed schema role grants no authority by itself.

Unknown versions, message types, fields, enum values, invalid role/type combinations, invalid operation shapes, malformed UTF-8/JSON/framing, and oversized frames fail closed. Semantic validation additionally enforces safe workspace identity, input-body rules, staged acknowledgement requirements, and confirmation literals.

### Explicit protocol non-goals

There is no protocol operation or payload field for:

- arbitrary commands, argv, executable paths, shell text, file reads/writes, environment values, PIDs, or caller-selected tmux targets;
- Matrix access tokens, arbitrary Matrix endpoints, arbitrary room sends, media, attachments, edits, reactions, threads, or voice;
- thinking, tools, tool results, partial assistant output, compaction, or internal entries;
- cross-host discovery, migration, room sharing, claims, or process control;
- task objectives or hidden prompt injection;
- importing or interpreting legacy direct-bridge bindings.

The typed workspace identity and relay-selected lifecycle operation are the only placement inputs. Host launcher code maps them to canonical paths and fixed argv.

### Persistence split

Synchronized **conversation manifests** contain only portable logical identity: schema version, conversation kind, owning host key, stable conversation/creation identity, immutable concept, Pi session, Matrix room, binding boundary, creation time, and (for project conversations) workspace identity and optional project Space. They contain no credentials, process observations, pending message bodies, or legacy bridge state.

Host-local **runtime state** contains the lifecycle state, current attachment observation, Matrix cursor, bounded accepted-input records, bounded projection records and transaction IDs, managed tmux observation, and a concise redacted launch error. It is written by atomic replacement in a private host directory. Future storage implementations must fsync/write/rename safely and must never recover from malformed primary state by silently accepting a partial temporary file.

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

Creation keys are durable retry keys supplied by the trusted coordinator adapter, not display names. Matrix event IDs identify inbound deliveries. Persisted Pi entry keys identify transcript entries. The same logical operation therefore derives the same ID after restart, while domains and length framing prevent ambiguous concatenation and cross-purpose reuse. Chunk boundaries must be deterministic before deriving chunk and transaction IDs.

## Consequences

- Relay, ordinary adapter, coordinator adapter, and tests share one small interface while authority remains relay-enforced.
- Unsupported forward changes fail rather than being reinterpreted. Compatible optional additions require a reviewed `1.x` contract strategy; breaking changes require a new explicit protocol/state version and migration decision.
- Synchronized state is portable but cannot resume another host’s managed conversation. Cross-host continuation remains a fresh conversation on that host.
- The old direct bridge is intentionally outside the model and receives no migration path.
- Text and queues are bounded; reaching a bound produces typed backpressure or an error rather than loss.
