# Managed Matrix sessions

Managed sessions are enabled atomically with `services.pi-harness.managedSessions.enable`. One lingered user relay owns the Matrix access token, `/sync`, host Space, coordinator room, project Spaces, room lifecycle, durable queues, and transcript projection. Pi adapters receive only a private peer-UID-checked socket and an attachment nonce. Disabled hosts expose no relay service, adapter, lifecycle/checkpoint tools, status command, socket configuration, or Matrix environment.

## Layout and behavior

The coordinator is the stable, non-deletable `default/coordinator` conversation. Coordinator tools list configured depth-one workspaces and start, resume, stop, or bridge-delete project conversations. A project process runs in a dedicated managed tmux window under its workspace root session. Launch is a fixed host-owned `tmux_project` operation and a trusted `direnv exec <canonical-cwd> pi`; callers cannot supply shell, argv, paths, PIDs, tmux targets, or environment.

Each conversation owns one private Matrix room. The host Space contains the coordinator and optional project Spaces; a workspace name is the default project Space. Ordinary authorized text is an idle prompt or busy follow-up. Typed controls are `!help`, `!status`, `!model [provider/model|filter]`, `!thinking [level]`, `!compact [focus]`, `!new`, `!stop`, `!abort`, and `!steer <text>`; malformed or unknown `!` commands show bounded help and never become prompts. Model and thinking choices are limited to the session's authenticated scope and use single-select polls of at most 20 answers, with provider/filter narrowing for larger catalogues. Model, thinking, compaction, and context-reset controls reject a busy adapter without altering its run. Compaction uses Pi's native history-preserving compactor and reports measured context before and after. Context reset is rejected until the generation transition is available, rather than emulated with model-visible input. A valid reply to a bot event strips Matrix's fallback quotation. Edits, reactions, threads, attachments, voice, media, malformed relations, foreign senders/rooms, stale initial events, and oversized payloads are ignored.

Only persisted transcript entries after the binding boundary are mirrored. Matrix-origin users are not echoed. Terminal-origin users are labelled; final assistant text and explicit `remote_checkpoint` question, blocked, and issue-completion boundaries are projected as bounded sanitized Markdown with plain fallback.

During each complete busy span, the relay maintains Matrix typing and one edited activity card. The card exposes only collapsed tool names and running/completed/error states. At settlement it becomes an unpinned, immutable snapshot with measured duration, model/thinking, generation, balanced context usage, run tokens/turns, tool totals/errors/counts, compactions, and completion outcome; unavailable measurements are omitted. This snapshot is persisted before the final assistant answer is projected. Thinking, arguments, paths, commands, tool output, partial assistant text, reasoning, and internal entries remain local.

Stop cancels unfinished input and terminates only the exact persisted managed window, preserving the room, manifest, Pi history, workspace, and files. Confirmed bridge deletion removes Matrix/relay binding state but preserves Pi history and project state. `/new` and `/fork` stay unbound; exact `/resume` reattaches only a previously bound session.

## Health and recovery

Run as the configured relay user:

```sh
pi-managed-session-status
systemctl --user status pi-managed-session-relay.service
journalctl --user -u pi-managed-session-relay.service --since today
```

The status command fails unless the service is active, its private socket exists, and durable registry JSON is readable. Its JSON output contains only aggregate lifecycle states and cursor presence—not tokens, room IDs, event IDs, message text, paths, or launch errors.

The relay uses bounded exponential backoff with jitter, honors Matrix `retry_after_ms`, and cancels waits on shutdown. Stable Matrix transaction IDs make uncertain transcript, activity-card edit, checkpoint, notice, and command-acknowledgement retries idempotent. Registry writes are private atomic write/fsync/rename operations. After relay restart, adapters may reattach during the reconciliation grace period; unmatched conversations become dormant. Accepted input, expanded input, persisted unfinished turns, checkpoints, and final projections resume from durable identity. Explicit stop/abort cancellation is terminal and is never recovered.

Cursor state is explicit: a fresh relay performs one bootstrap sync, persists its returned cursor, and does not execute retained timeline commands from that bootstrap response. Established state requires a bounded cursor; malformed state and limited/oversized timeline gaps do not advance it. Authentication failures are concise HTTP diagnostics in the user service journal. Do not delete or hand-edit `registry.json`; restore the last known complete synchronized manifests and host-local registry together, or resolve the conflict explicitly. Legacy `.remote-session` files and rooms are never scanned or migrated.

## Token rotation and device revocation

Rotation does not rebuild Pi sessions, recreate rooms, or clear registry/projection state:

1. Create a replacement Matrix login/device for the same configured bot MXID.
2. Atomically replace the SOPS-rendered credential file with exactly one `PI_MATRIX_ACCESS_TOKEN=<new-token>` assignment, owned by the relay user and mode `0400` or `0600`.
3. Restart and verify:

   ```sh
   systemctl --user restart pi-managed-session-relay.service
   pi-managed-session-status
   journalctl --user -u pi-managed-session-relay.service -n 50
   ```

4. Send one message to an existing managed room and confirm its normal projection.
5. Revoke the old Matrix device only after the replacement is healthy.

The launcher reads the credential file on every service start. Never put the token in Nix, shell arguments, tmux, Pi settings/session metadata, issue comments, test fixtures, or diagnostic commands. Errors and bounded diagnostics redact credential-like environment values and never include Matrix response bodies.

## Troubleshooting

- **Service inactive:** inspect the user journal and credential owner/mode. Confirm linger is enabled and network-online is available.
- **HTTP 401/403:** replace or rotate the token and confirm the configured bot MXID did not change.
- **Repeated rate limits/outage:** leave the service running; bounded retry preserves cursor and stable transactions without duplicate turns.
- **Dormant room:** ordinary text queues and wakes the exact persisted session. Dormant steer/abort intentionally do not wake it.
- **Launch failure:** verify the configured workspace root, immediate-child workspace, direnv policy, and `tmux_project` managed operations. Error output is intentionally concise and redacted.
- **Malformed durable state:** stop the service and reconcile the complete manifest/runtime pair; temporary or legacy files are not recovery sources.

## Deferred scope

V1 deliberately excludes cross-host discovery, migration or failover; shared-room claims; media, voice, attachments, edits, reactions, and threads; container/sandbox isolation beyond the service and fixed launcher boundary; automatic project conflict prevention; idle process retirement; and import of legacy direct-bridge rooms or state.
