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

New instructions in a shared room require the configured host prefix:

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
other media. It does not turn fallback reply quotations into prompt content.

## Interruption semantics

An accepted Matrix event ID and prompt are recorded before injection. Session
markers also retain the exact post-command/skill/template expansion so recovery
cannot mistake an unrelated later local turn for the remote input. These markers
distinguish accepted, persisted-user, and answered interruption windows.
Reconnect injects an event that stopped before persistence, continues a persisted
unfinished turn without duplicating its user entry, or sends an answer already
present in session history. Replayed sync events are ignored. Each
inbound event also receives a deterministic Matrix transaction ID. If sending
the final answer fails or the process stops after an uncertain send, reconnect
retries the same body with the same transaction ID; Matrix treats that retry
idempotently.

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
