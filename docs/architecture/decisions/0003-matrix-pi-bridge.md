# ADR 0003: Native Pi with an optional Matrix bridge

- Status: Accepted target; implementation/release evidence is tracked separately
- Issues: [#160](https://github.com/BeaudanBrown/pi-harness/issues/160), [#161](https://github.com/BeaudanBrown/pi-harness/issues/161)
- Supersedes: conflicting **target** requirements in [ADR 0002](0002-managed-session-contracts.md), including its subsequent amendments

## Decision

Pi owns history and execution; tmux owns windows; the bridge owns Matrix routing,
delivery and organization. Ordinary Pi must not depend on bridge, Matrix, NAS,
Git metadata or Space health. An actual native-history/writer conflict remains
an error. Native session APIs, not a second execution manager, determine the
model, thinking, branch, compaction, pending messages and extension dispatch.

### Terms

- **Native session:** one Pi JSONL file and its native header identity. The file's
  canonical path is the local writer-lock key; the path/header pair identifies a
  binding. Missing/corrupt files are not recreated on resume. Copies and forks
  are not automatically adopted as the original binding.
- **Binding:** one host-local association of a native session with one Matrix
  room and a projection start. Resume reuses it. New/fork gets another binding;
  tree navigation does not. Imported old generation histories remain readable.
- **Connection:** a live private-socket connection to a Pi adapter. Disconnection
  is not proof of process exit. Connections and window observations are not
  durable launch authority.
- **Interrupted input:** input potentially handed to Pi whose outcome cannot be
  established. It remains visible and is never automatically replayed. It does
  not lock the conversation or prevent a fresh request.
- **Task setup:** one approved, idempotent branch/worktree/native-session/binding
  creation, with a frozen base commit and visible handoff summary. It is not a
  workflow engine. The child is idle until fresh human instruction.
- **Archive:** reversible organization and disabled remote dispatch/wake, NOT
  execution status, process termination, deletion or irreversible retirement.

### Retained behavior

Automatically enroll persisted human-facing interactive sessions in configured
roots, asynchronously; retain local-only operation and exclude workers/headless
jobs. Any currently joined participant except the bridge bot and exact ignored
service accounts may instruct Pi and answer polls. Invitation is the access
policy; an invitation grants access to the agent's tools, not just read-only chat.

Retain text/replies, polls/questions/native-control choices, JPEG/PNG/WebP input
and captions, useful Pi controls, automatic trusted invitations and
Host → project → checkout → conversation Spaces. No outbound file-export tool
in this iteration. Existing supported unencrypted media is the scope, not new
voice/video/encryption support. Keep original image bytes, authenticated fetch
and transfer integrity; do not add arbitrary harness image-size/pixel caps.

NAS may hold the configured operator's credential for accepting invitations
from exact trusted host bots. It does not authorize Pi execution. Do not
reinvite/rejoin deliberate departures, unban, override notification preferences
or make local work wait for account-side acknowledgement.

Archive retains original room, membership and native/worktree files. Move its
room into a host Archive Space; unlink empty live checkout presentation without
deleting historical Spaces. The picker defaults to live bindings. Already-running
work may finish and project output. New text/votes cannot dispatch while archived.
Preserve queued/uncertain input visibly without replay on restore. Matrix clients
may still show joined archived rooms in All Rooms.

An ordinary development conversation can request a task workspace. Infer its
project, freeze the explicit committed base, and derive a safe absent sibling
path for the new branch. Copy only the explicit visible summary, not uncommitted
files, raw history or approvals. Return local success even if Matrix setup is
pending. Preserve useful partial results; no destructive rollback. Model-requested
workspace/archive mutations require independent per-call operator consent;
joined-member chat/votes do not grant this additional authority. Keep that approval
surface small rather than retaining the generic host-action catalogue.

## Interfaces and persistence

A private local `list`, `open <session-file>` and `status <session-file>` interface
serves picker and remote wake. It discovers saved native sessions/live windows
without requiring Matrix. Open uses fixed argv and one writer seam, never
`send-keys`, caller-selected shell fragments or full-user process inspection.

The adapter interface is session-scoped: register/reconnect, offer eligible
persisted text, receive input/control, report handoff/outcome, and offer a poll
or narrow approved mutation. It has no Matrix token or arbitrary-room send.
Transport frames are bounded; media uses bounded chunks, not unbounded frames.
Native expansion remains native; built-in TUI commands are not assumed to work
through `sendUserMessage`.

One bridge daemon uses one host-local SQLite database. Persist bindings,
sync/intake identity, immutable output and transaction IDs, interaction polls and
bounded task/provisioning progress. Do not sync the database across hosts. Private
scratch locks/window observations are reconstructible, not additional lifecycle
stores. Runtime ownership must be proved at the actual native writer seam,
including switch/fork/reload, crashes and child descriptor inheritance.
The native adapter may synchronously read only its own binding's dispatch policy
from this same database at remote handoff/queue consumption: asynchronous socket
notifications alone cannot fence a concurrent archive commit. Use a fresh read-only
connection with no lock wait; missing, unsafe or unavailable policy rejects remote
input, never ordinary local Pi, an already active run, or local queued input. This
is no second store, write capability or process/launch admission authority.

Persist input before advancing sync. Only queued-before-handoff input can retry
automatically. Commit the potentially-dispatched state before sending to Pi;
a lost receipt means interrupted, not completed and not automatic rerun. Keep
per-room ordering and isolate failed rooms; fresh input bypasses old interrupted
records, not still-queued predecessors. Stable Matrix event IDs deduplicate intake.

Only eligible persisted post-binding local text and completed assistant text
project. Never project thinking, tool payloads, internal entries or pre-binding
history; Matrix-origin input is not echoed. `message_end` precedes persistence
and is not a receipt. Freeze output chunks before send and reuse transaction IDs
and payloads on retry. Exactly-once arbitrary tool effects are not promised.

## Delete rather than layer

Remove coordinator special handling, custom generations, generalized host control,
Git deletion/merge/branch cleanup, permanent archive authority, process-repair
workflows, automatic Pi runtime replacement, account mutation orchestration and
legacy live compatibility. Reuse genuinely small shared Matrix/rendering/retention
primitives. Preserve the independent stateless `!pi` assistant.

The replacement may coexist in SOURCE while slices land, but only one runtime is
shipped at completion. Offline migration preserves original IDs/history and all
uncertain input/output identities. No old/new consumer or native writer overlap.
Backups are not a second authority. After new work, rollback may not restore stale
queues; reconcile receipts or continue locally. Production deployment is separate
from source implementation and requires an approved maintenance scope.

## Acceptance and cost

See [replacement evidence](../../matrix-pi-bridge-evidence.md) for public-interface
scenarios, crash boundaries and release results. Baseline: 21,344 lines in 124
managed-session production files and 45 host operations; related downstream
managed/picker/process production files total 2,601 lines at `09b2f884`.

Budget: target at most 8,000 production lines for the replacement bridge/runtime,
local helper, invitations, task setup and downstream integration, excluding
unchanged shared primitives; 15–25 focused source files where practical, one
bridge daemon/database and no public repair command. This is a review budget,
not permission to drop accepted behavior or cram modules together. Report actual
net changes across both repositories and all moved/shared code. The original
70% estimate is not a release requirement after retained features were clarified.

## Existing issues

#37/#53/#103 retain historical implementation evidence; their conflicting future
manager/generation/archive targets are superseded, not claimed implemented.
#83 contributes worktree constraints, #88/#89 media cases, #129–131 grouping/admin
history, #133 pressure/reconnect evidence and #158/#159 launcher/attention evidence.
Do not silently close these or treat the observed tmux failure as fixed by this
ADR. The old default-launch/repair behavior remains deployed until migration.
