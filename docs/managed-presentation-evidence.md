# Host presentation evidence (#115)

Status: runtime observation, two-way title synchronization and Matrix prefix
writes implemented; paired review and final canonical verification pending. No deployment or
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
| Pi name and manual Matrix name share mutable title | Durable monotonic title revision; negotiated adapter metadata events; Current Matrix state reread after sync wake-up and restart/reconnect | Real Pi name events, restart, duplicate/echo suppression, concurrent rename versus status write |
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
| Sync name wake-up / cursor advancement | Persist dirty wake-up when possible; current room state remains externally durable | Presentation IO failure does not block input; retry in memory and reread current state on restart/reconnect. Accept fetched title/event identity durably before projection, never import stale timeline text |
| Host stops abruptly | No new observation | Last-known indicator may remain stale; no cross-host heartbeat or remote inference |
| Concurrent retirement | Existing tombstone authority | Stop new writes; do not adopt or recreate a retired room |

## Approved protocol preflight

The existing launcher `window-check-exact` returns only `match`, `gone`, or
`changed`. `managed_exact.go` rejects `pane_dead != 0` while parsing an exact
proof, then maps that rejection to `changed`. Thus dead retained panes and changed
ownership are indistinguishable. Mapping both to unknown can leave a dead pane's
last-known running prefix; mapping both to stopped lies about uncertain ownership.
Repeated single-window calls also rescan the tmux inventory for every conversation.
The current host read model separately treats a live attachment as running without
consulting an exact-window observation.

The operator approved these scoped additions; both are implemented:

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

## Runtime-observation implementation and evidence

- Existing Go launcher now implements `window-observe-exact`; legacy check and
  terminate implementations are unchanged. Direct Go suite: **35 tests, zero
  skips**, including genuine disposable tmux/pidfd tests. Synthetic batch cost:
  **one tmux command queue and 64 process probes for 64 proofs**. No model benchmark
  or live Matrix/client acceptance was performed.
  `.pi/tmp/workers/2026-10-05T21-58-10-236Z-exact-observer-go-bc26456ba7f1/`.
- Harness client freezes input, bounds batches and validates complete ordered
  response identities/states. No fallback to legacy authority.
- `HostRuntimeObserver` coalesces startup, registry metadata, reconnect and 10-second
  triggers outside prompt lanes. It captures private metadata only, batches at 64,
  revalidates source generation/launch/window/attachment after observation, discards
  retired or changed sources and expires evidence after 20 seconds. Reads reuse
  the snapshot. Unknown is never converted to stopped or running by guesswork.
- Host read model and connected/dormant `!status` now use process observations;
  detailed status additionally exposes account setup. Matrix names are **not yet
  written** by this slice. No typing or notification-policy changes were made.
- Focused harness checks initially passed **22 tests, zero skips** (before the
  additional detailed-status assertion):
  `.pi/tmp/workers/2026-10-05T22-09-10-027Z-presentation-observer-focused-0754e594c718/`.
  LSP has no code errors; external Go files are outside its active build and were
  checked by the direct Go suite instead.

Affected packaged gate passed **481 managed tests, zero skips**, plus source
contracts (including the added detailed-status assertion):
`.pi/tmp/workers/2026-10-05T22-12-54-810Z-presentation-observer-affected-8bc108718f1c/`.
External launcher implementation is committed at `f4c43cf`. Its Git hook was
bypassed to respect the explicit no nix-dotfiles evaluation/build restriction;
Go formatting, direct Go tests and `git diff --check` passed. No Nix source was
changed in that checkout. Canonical gate and review await the full issue.

## Title and Matrix presentation implementation

- Negotiated `title-v1` metadata uses `title.read`, sequence-bearing `title.observe`,
  and revision-bearing `title.changed`. Existing attachment/session authentication
  binds observations; legacy attachments cannot call or receive these messages.
  Native `managed-session.title` custom entries retain the accepted revision and
  pending sequence across reconnect without treating cached names or copied-session
  metadata as fresh input. Metadata updates invoke neither a prompt nor a model.
- Portable manifests preserve optional paired `title`/`titleRevision` through v1/v2
  migration; `concept` remains the immutable construction label. A private bounded
  title journal serializes accepted observations before portable projection. Missing
  or corrupt journals with existing title authority require explicit recovery,
  never automatic reset. Bounds: 8192 observed event IDs, 4096 name-write records,
  4 MiB per record, positive safe-integer revisions.
- Initial Matrix history is a wake-up, not new title authority. After a current-state
  baseline, the latest incremental human name/event identity is accepted durably
  before cursor advancement, without waiting for an older in-flight name PUT.
  Older events in the same batch and duplicate/own events cannot become fresh
  renames. Startup/reconnect also rereads current state. Failed metadata persistence
  does not freeze prompt intake; current state is reread after recovery. Accepted
  manual changes survive an older in-flight write; unaccepted changes during storage
  failure retain the documented server last-writer limitation.
- Per-conversation admission is independent of network work. At most four workers
  run at once, with one-second per-room and 200-ms shared write admission, changed-only
  PUTs, and persisted retry deadlines. Name PUTs explicitly forbid automatic HTTP
  retries; uncertain results trigger current-state reconciliation before another
  intent. Retired or changed destinations stop fresh sends. In-flight older writes
  cannot roll back a newer durable title. An unobserved concurrent human edit can
  still lose the Matrix server's last-writer race (there is no state CAS); already
  accepted manual/native changes always converge to their newer canonical revision.
- `●` is known running, `○` is stopped/failed. Unknown preserves the durable last
  marker, including across manual renames. A retained failed-launch process is not
  treated as a healthy Pi merely because its shell remains alive. Detailed status
  separates process/launch, account setup and pending title synchronization.
- Name writes carry `lol.bepis.pi.notification` silent disposition and no mentions;
  no notification rules or typing behavior are changed. Existing manual settings
  retain priority. Actual phone unread/badge/banner behavior is still #121 evidence.

Focused title/schema checks passed **24 tests**. Subsequent SDK/IPC/HTTP focused
checks passed **36 tests** with one unrelated lock-helper skip in the unbundled
fixture; the packaged gate below supplies that helper and has no skips.
`.pi/tmp/workers/2026-10-05T22-42-45-005Z-title-sync-focused-6f95f8b38de9/`
`.pi/tmp/workers/2026-10-05T22-52-34-355Z-titles-sdk-ipc-affected-focused-0a58962e8a04/`

Broader affected gate: **500 managed tests, zero skips**, source contracts and
packaged relay/adapter TypeScript passed. This includes real Pi SDK native names
with zero model calls/history prompts, genuine Unix IPC capability enforcement,
fixed HTTP silent payloads, fake-time 429/restart/coalescing, slow-room isolation,
projection failures, stale GET/retirement, uncertain PUT, rename races, last-marker
retention and immutable identity across actual manifest reload/migration.
`.pi/tmp/workers/2026-10-05T23-06-37-054Z-titles-affected-ae4f8b040ab5/`

Additional manual-rename race and initial-history regression checks passed in the
broader packaged gate: **502 managed tests, zero skips**, plus source contracts.
`.pi/tmp/workers/2026-10-05T23-15-55-249Z-titles-manual-race-affected-b68401125be0/`

Remaining: paired issue-boundary review, accepted remediation and final canonical
verification. No #115 completion or live Matrix acceptance is claimed yet.

The original no-push, no deployment/service restart, no live-account traffic and
no nix-dotfiles evaluation/build restrictions remain. Direct Go tests and harness
verification are permitted; actual client acceptance remains under #121.
