# Host presentation evidence (#115)

Status: preflight; implementation and verification pending. No deployment or
live-account traffic is authorized. #114 native handoff remains separately approved.

## Ownership

#115 owns host-wide last-known running indicators, shared runtime observations,
two-way mutable titles and detailed status. It does not own native navigation,
automatic enrollment, migration, picker interaction, deployment or live acceptance.
Typing continues to mean model work, not process liveness. Titles never authorize
lifecycle operations or identify a conversation.

## Acceptance-to-evidence matrix

| Acceptance | Implementation boundary | Required evidence |
| --- | --- | --- |
| Reconcile on startup/reconnect/attachment changes and every ten seconds | Coalescing host-owned observer; reusable bounded local snapshot | Fake clock, overlapping triggers, shutdown/drain, exact snapshot costs |
| Running/stopped/unknown remain distinct | Exact source generation/launch/attachment and process/window evidence | Live/dormant/starting/dead retained pane; changed ownership; unavailable observation; stale response |
| Changed-only background state updates | Per-room serialized, rate-limited writer outside prompt/intake lanes | Delayed HTTP, outage/429, independent rooms, no prompt blocking |
| Pi name and manual Matrix name share mutable title | Durable monotonic title revision; negotiated adapter metadata events; Matrix intake before cursor commit | Real Pi name events, restart, duplicate/echo suppression, concurrent rename versus status write |
| Prefix is presentation only | Strip only one harness status prefix; bounded sanitized title and unique human fallback | Unicode/control handling, empty/colliding names, immutable conversation identity |
| Honest detailed status and silent policy | Shared observation used by host reads and `!status`; existing new-room notification disposition | Pending setup/starting/errors/reconciliation, unknown state, untouched manual settings and typing |
| Own host only | Registry-owned identities and frozen exact proofs | Foreign host/window/room ignored; retirement wins |

## Crash-boundary matrix

| Boundary | Saved authority and effect | Required recovery |
| --- | --- | --- |
| Observe local process/window | Frozen host/conversation/generation/launch evidence | Discard observation after ownership changes; unavailable is unknown, never guessed stopped/running |
| Accept title observation | Serialized durable revision plus source identity | Duplicate delivery does not create another revision; initial cached Pi name is not a new rename |
| Save Matrix name intent before HTTP | Exact revision, presentation and own-event correlation | Lost response must not turn an own echo into a manual title change |
| Manual rename while old PUT is in flight | New title revision wins locally | Old acknowledgement cannot advance/restore the old title; reconcile latest accepted title |
| Accept Matrix rename before sync cursor | Durable title and accepted event identity | Restart replay is idempotent; no delayed own event restores an old name |
| Host stops abruptly | No new observation | Last-known indicator may remain stale; no cross-host heartbeat or remote inference |
| Concurrent retirement | Existing tombstone authority | Stop new writes; do not adopt or recreate a retired room |

## Protocol preflight requiring approval

The existing launcher `window-check-exact` returns only `match`, `gone`, or
`changed`. `managed_exact.go` rejects `pane_dead != 0` while parsing an exact
proof, then maps that rejection to `changed`. Thus dead retained panes and changed
ownership are indistinguishable. Mapping both to unknown can leave a dead pane's
last-known running prefix; mapping both to stopped lies about uncertain ownership.
Repeated single-window calls also rescan the tmux inventory for every conversation.
The current host read model separately treats a live attachment as running without
consulting an exact-window observation.

Proposed scoped additions, not implemented or approved yet:

1. A **read-only bounded batch observation** operation in the existing Go launcher,
   with at most 64 frozen exact proofs per request. Reuse one tmux inventory within
   a batch, validate original process/birth and window ownership, and return an
   exactly correlated `running`, `stopped`, or `unknown` result for each proof.
   Preserve all existing exact-check/terminate contracts. No signaling, replacement,
   new daemon, arbitrary tmux target or cross-host discovery. Unsupported/unavailable
   observation is unknown. The host coalesces and reuses the complete snapshot.
2. A **negotiated title metadata capability** between existing adapters and relay:
   explicit native name observations, source identities and monotonic accepted title
   revisions, plus current-title updates back to Pi. Old adapters receive no new
   messages. Initial/restored cached titles are not fresh observations; metadata
   echoes never become human renames. This adds no model host-mutation action and
   no completed model-action receipts or automatic action replay.

The original no-push, no deployment/service restart, no live-account traffic and
no nix-dotfiles evaluation/build restrictions remain. Direct Go tests and harness
verification are permitted; actual client acceptance remains under #121.
