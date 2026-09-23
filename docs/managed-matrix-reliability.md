# Managed Matrix reliability (#94)

## Ownership and behavior

The relay remains a host-local Matrix transport, not a second agent/session
manager. `inbox.json` and `notice-outbox.json` live beside `registry.json` in the
private persistent relay directory. Keep them in the same backups. Do not delete
or synchronize these files across hosts; downgrading to a relay that ignores the
inbox after its cursor advanced can strand messages.

After bounded timeline-gap recovery, the relay filters unsupported and ignored
sender events, then fsyncs candidate events into its inbox **before** advancing
the registry cursor. Membership is checked freshly when the room worker handles
them; inbox persistence does not grant authorization. A batch identity retained
with the queue closes the write-before-cursor crash window. Each room is ordered,
with at most eight room workers; failures retain that room's head for retry.
A failed poll publication cannot block the shared intake loop or another room.
Poll votes remain queued until uncertain publication identities are reconciled.
Bootstrap/gap-recovery limits remain unchanged; an unprovable gap still blocks
cursor advancement rather than silently losing input.

Relay notices freeze conversation, source, session, room and body before any
Matrix PUT. Reset/control completion waits for local durable acceptance, not
remote display. Retries use the frozen content and transaction identity even
across generation changes. Legacy projection conflicts are retained as blocked
notices, logged and isolated from later notices; they are never rewritten or
silently declared sent. Status/help can report a generation transition without
asking an unavailable adapter. A repeated completed control is not dispatched
again.

Production managed Matrix requests use one attempt per operation with a ten-second
JSON request deadline (sync retains its existing long-poll deadline). Durable
owners schedule retries rather than holding a socket/room worker through minutes
of rate-limit sleeps. Event-send 429s establish an account-shared cooldown using
`retry_after_ms`; reads and typing are not blocked by that cooldown. The separate
stateless chat assistant's retry policy is unchanged. Matrix failures retain a
classified, redacted IPC error and do not discard a valid attachment.

Activity cards serialize per conversation, not across the entire host. Shared
activity-file writes are still serialized. New adapters coalesce tool activity
updates over five seconds and retain at most one queued update. Start/final
snapshots remain immediate. Typing means a live agent busy span (including its
tools/compaction), not control handling: controls/slash-command dispatch and an
attachment alone cannot start it. Receiving finalization or losing attachment
clears the live signal without waiting for a card PUT. Server-side typing can
still linger up to its 30-second expiry if the stop request fails.

Both new stores fail closed at 4,096 records or 16 MiB. Inbox jobs are removed
after handling; notice completion receipts remain to deduplicate replay. Capacity
or corrupt state is an operator-visible error, never permission to clear state.
Automatic historical receipt archival is not part of this change.

## Acceptance and crash-boundary evidence

| Boundary / requirement | Evidence |
| --- | --- |
| Inbox write before cursor; same batch replay | durable routing test replays last batch across restart without appending twice |
| Slow room versus healthy room, ordered recovery | failed room retains entries while healthy room progresses; restart drains in original order |
| Notice intent before PUT; generation changes | notice-outbox test freezes payload and original session across failure/restart |
| Reset attached but notification unavailable | lifecycle test completes transition/releases input with all notice sends failing |
| Conflicting old notice | retained blocked record, later notice still sends |
| Shared rate limiting | only first event PUT reaches fake server; other-room PUT cools down while whoami works |
| Transient IPC transport errors | production relay test exercises HTTP 503 and reuses the same attached client |
| Typing and independent activity | activity tests cover generation-only feedback, delayed stops, deadlines and cross-room recovery |

Focused gate: `nix build .#checks.x86_64-linux.managed-session-tests --no-link`.
Final gate: `nix run .#verify`; production relay/default packages must also build.

## Deployment boundary

Update the consuming `pi-harness` lock and rebuild through the existing guarded
rollout. Do not restart shared tmux or force-refresh busy Pi processes. Relay-only
fixes apply on rollout; five-second adapter coalescing needs idle conversation
refresh (or the next normal launch). Existing wire messages remain supported.
No Synapse quota changes or new credentials are required.

Live acceptance remains operator-owned: send messages in two rooms while one has
a pending reset/poll, check `!status`, verify generation completion and input
ordering, and verify that merely composing a message does not trigger bot typing.
Use service logs for `inbox`, `notice`, and classified Matrix errors. Sync health
now means durable intake is current, not that every room or outgoing notice has
finished. Inspect queue counts without displaying contents:

```sh
state="$HOME/.local/state/pi-managed-sessions/relay"
jq '{pending: (.jobs | length)}' "$state/inbox.json"
jq '{pending: ([.notices[] | select(.sent == false and .blocked != true)] | length), blocked: ([.notices[] | select(.blocked == true)] | length)}' "$state/notice-outbox.json"
```

These tests do not prove the deployed homeserver's throughput or erase preexisting
projection conflicts. Preserve conflict records for explicit inspection/recovery;
never reset the registry/cursor to make the symptoms disappear.
