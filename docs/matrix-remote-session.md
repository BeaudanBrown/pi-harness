# Matrix remote sessions

The `remote-session` extension binds one private Matrix room to one persistent Pi
conversation. The room represents the conversation concept, not one Pi process
or branch.

## Binding lifecycle

First activation creates and records the room:

```text
/remote on <concept-name>
```

The extension writes versioned binding metadata into the Pi session and into a
sidecar under Pi's synchronized session root. A subsequent `/remote on`, Pi
restart, `pi -c`, resume, compaction, or fork reuses the original room. Supplying
a different concept name to an already-bound conversation fails rather than
creating or renaming a room.

`/remote off` stops the current process from polling without deleting the room
or durable binding. A later `/remote on` reconnects it. Starting or resuming the
bound Pi conversation also reconnects automatically when that host has valid
Matrix runtime configuration.

## Durable sidecar

With Pi's native session layout, state is stored beneath:

```text
~/.pi/agent/sessions/.remote-session/
├── bindings/<binding-id>.json
├── sessions/<session-id>.json
└── hosts/<bot-identity-hash>/<binding-id>.json
```

The synchronized session bind mount means this directory is replicated by
Syncthing. Shared files contain immutable room/concept identity and session to
binding links. Each bot identity has a separate host-state directory containing
its sync cursor, bounded processed-event IDs, and pending outbound retries. A
host never writes another bot's progress file.

No Matrix access token, password, decrypted SOPS environment, or other
credential is written to sidecar state. An accepted prompt and any pending final
answer are retained only until Matrix accepts the answer, then removed. This
small duplication of conversation content closes interruption windows; it has
the same synchronized trust boundary as Pi's session JSONL. Sidecar files and
directories use private user permissions and atomic replacement.

## Matrix input and control

The legacy direct-bridge extension requires the configured host prefix for new
instructions in a shared room:

```text
@grill investigate the failing test
@grill /skill:diagnosing-bugs inspect the current failure
@grill /worker-model status
@grill !steer stop refactoring and preserve the public API
@grill !abort
```

A direct Matrix reply to an event authored by the grill bot infers `@grill`, so
a short reply such as `yes` needs no prefix. The extension verifies the replied
event's sender through the bound room before accepting it. An explicit different
host prefix still wins and is ignored by grill.

Managed relay rooms are different: each room is permanently owned by one host
conversation, so authorized operator text routes directly without any host
prefix. Valid replies to that room's bot use the same sender verification and
fallback stripping; malformed or foreign relations remain ignored.

Idle prompts start immediately. Ordinary input received while Pi is busy queues
as a `followUp`; `!steer` strips its control prefix and queues the remaining text
with Pi's `steer` semantics. Exact `!abort` requests `ctx.abort()` and does not
create a user turn. All controls pass the same room and operator checks as normal
prompts.

The harness carries a narrow compatibility patch for the pinned Pi package so
extension-injected input may opt into Pi's normal command, skill, and prompt
expansion path. The default `sendUserMessage` behavior remains unchanged for
other extensions. Remote extension commands execute as commands rather than LLM
prompts and receive a small Matrix dispatch acknowledgement. Skill input is
expanded by Pi and persisted with the same semantics as interactive input.

Text-only v1 ignores edits, reactions, attachments, thread events, voice, and
other media. A valid reply to an event sent by the configured bot may omit host
addressing; its well-formed Matrix fallback quotation is stripped and only the
operator's unquoted reply becomes prompt content. Missing, inaccessible,
non-bot, malformed-fallback, and other relation targets fail closed.

## Explicit checkpoints

Normal Matrix prompts receive the corresponding final assistant answer, while
thinking, tool activity, and unrelated local turns remain in the Pi terminal and
session. Agents also have one `remote_checkpoint` tool for intentional approval
boundaries:

- `question` states the decision required, with optional concise context and
  options;
- `blocked` states observed blocker evidence and the exact intervention needed;
- `issue_complete` states the issue or objective, implementation summary,
  verification evidence, caveats, Git/commit state, and exact closure or
  continuation approval request.

Checkpoint schemas reject missing, extra, oversized, control-character, and
code-like content in normal prose fields. Rendered Matrix messages are bounded
to 6,000 characters. Code or diffs are accepted only in the dedicated requested
content field when the agent explicitly confirms that the operator asked for it.

The extension records prepared and waiting checkpoint entries in the Pi session,
sends the structured message to the bound room with one transaction ID, and
calls Pi's abort boundary. If the process stops after preparation or an uncertain
send, reconnect retries that same transaction and resolves the originating
inbound turn without resuming it. The current run cannot continue past the tool
call. The next authorized Matrix reply is accepted through the normal inbound path,
persisted as an ordinary Pi user message, and has the same approval authority as
terminal input.

## Interruption semantics

An accepted Matrix event ID and prompt are recorded before injection. Session
markers also retain the exact post-command/skill/template expansion so recovery
cannot mistake an unrelated later local turn for the remote input. These markers
distinguish accepted, persisted-user, and completed interruption windows.
Reconnect injects an event that stopped before persistence or continues a
persisted unfinished turn without duplicating its user entry. A prepared or
waiting checkpoint resolves its originating inbound instead of resuming it, and
suppresses any ordinary final answer from that checkpoint-bound run. Replayed
sync events are ignored. Routine answers, typed command acknowledgements, and
checkpoints have stable Matrix transaction IDs, so reconnect can retry an
uncertain send idempotently.

The bot-specific sync cursor advances after every successful sync, including an
empty timeline, and is written only when the token changes. Events that arrived
while the process was offline are consumed after reconnect without sharing one
host's cursor with another host.

Each host retains at most 2,048 processed event IDs. If all retained events are
still pending and another event would exceed that capacity, polling applies
backpressure without advancing the cursor; it cannot silently drop the event.
Completed entries are pruned as capacity is needed.

Do not run the same Pi session concurrently on multiple hosts. Syncthing session
files and room bindings support continuation, not multi-writer conversation
execution.

## Diagnostics

Use only non-secret state in issue evidence:

```text
/remote status
```

Filesystem checks may list paths and permissions, but do not paste pending
outbound bodies:

```sh
find "$HOME/.pi/agent/sessions/.remote-session" -type f -printf '%m %p\n'
find "$HOME/.pi/agent/sessions" -type f -name '*sync-conflict*' -print
```

A missing room after fork should be diagnosed by checking that both the parent
and fork session IDs have files under `sessions/`, and that their binding ID
exists under `bindings/`. A repeated inbound prompt should be diagnosed against
the bot-specific host file and Matrix event ID without exposing message bodies.
