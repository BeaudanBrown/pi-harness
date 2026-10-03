# Managed input receipt and selective recovery (#124)

## Receipt authority

Pi 0.85 emits the user `message_end` event **before** `SessionManager.appendMessage`.
Fresh session managers can also buffer entries until an assistant message exists.
A branch entry is not by itself an on-disk receipt. The adapter now schedules a
post-event check, verifies matching correlation in both the current branch and
its session file (including the session header identity), and only then records
and acknowledges persistence. Settlement and checkpoint handling use that same
check. Receipt loss reuses the existing durable marker/acknowledgement retry path.
Historical expansion-only markers are still ambiguous and are never automatically
upgraded by finding matching transcript text.

## Confirmed reset wake

A queued `!new --confirm` may wake a dormant conversation even with no ordinary
input. The attachment receives the reset control, while ordinary input stays
blocked by the generation boundary. An already-created generation transition
remains owned by the existing lifecycle reconciler. The existing frozen reset
cutoff still determines cancellation; post-cutoff input remains for activation.

## Selective recovery

This operation is a **local ordinary Pi command**, not model prompt text or a
coordinator lifecycle operation. In the target attached idle session:

1. Run `/remote recover` to preview its single blocking delivered input, newer
   retained-input count, and confirmation key. Preview does not mutate either store.
2. Obtain operator approval for that exact retirement. Historical completion is
   unknown, regardless of matching transcript text.
3. Run `/remote recover --confirm <preview-key>` in that same session.

The adapter checks idle state before and after both preview and reservation requests, including
Pi queues, pending persistence, active delivery and activity/finalization state.
Only a restored historical `expanded`/`reinjecting` hold is eligible. Persisted
unfinished work, pending controls, generation changes and refresh are rejected.
The key pins the relay queue, session/attachment identity, and local marker.
Changed snapshots require a fresh preview. Inputs arriving after validation are
still preserved: cancellation names exactly one delivery ID.

The explicit local `--confirm` command is the operator approval mechanism on the
trusted Unix-user boundary; it is not exposed as a model tool. The relay requires
a typed confirmation literal and the approved snapshot key for reservation.

Application first appends a **non-terminal local intent**. The relay atomically
rechecks the complete preview snapshot and reserves exactly that delivery with a
durable recovery key; it stays `delivered` to hold successors until local receipt.
Only an authorized reservation permits the local cancellation marker and ordinary
cancelled receipt. Failed revalidation cannot produce a terminal local marker.
No old prompt is injected; no user/assistant history is removed. After an uncertain
reservation reply, reconnect queries reservation status read-only. It finishes a
proven reservation but never reapplies an uncommitted intent with stale authority.
If Pi becomes busy during reservation, the non-terminal intent and reserved head
remain held. Bounded local polling/read-only reconnect reconciliation finalizes
that proven reservation only after fresh verified idleness; neither path reapplies
an uncommitted reservation. A lost final receipt retries that cancellation only.
The relay's atomic receipt
mutation retires exactly that input and releases ordered successors. This is retirement, **not** evidence that the historical task completed.
It does not clear cursors, delete registry entries, blanket-stop, or resend queues.

## Acceptance-to-evidence matrix

| Acceptance | Implementation | Focused evidence |
| --- | --- | --- |
| No pre-append or buffered-entry receipt | Disk/branch verification and later-tick polling; shared fallback | Adapter test with actual pre-append ordering, deliberately unflushed file, then durable append; existing real-SDK suite |
| Dormant confirmed reset can attach without bypassing normal gating | Control-specific wake; transition remains gated | Coordinator test with zero/two post-cutoff inputs; control delivered, ordinary inputs retained |
| Recovery requires preview, unchanged key, idle historical hold | Local command plus authenticated self-scoped read-only preview | Adapter busy-before/during-preview, busy-during-reservation/reconnect, stale rejection and no-mutation preview tests |
| Retire one input, preserve later inputs and history | Non-terminal intent, relay-atomic reservation, local cancellation and receipt | Production relay/client tests: changed queue, pending control and persisted-receipt races, reserved-head fence, exact cancellation and retained successor |
| Interrupted retirement does not replay work | Read-only intent reconciliation, durable marker re-acknowledged on reconnect | Lost reservation/final receipt replies, rejected reservation followed by restart, disk marker restoration, zero injections |

## Crash-boundary matrix

| Boundary | State/side effect | Durable authority and retry |
| --- | --- | --- |
| Before SDK user append / while buffered | Expanded marker, no receipt | Later check cannot find on-disk correlated entry; hold on restart |
| After durable user append | Correlation verified on active branch and file | Local persistence marker precedes receipt; existing restart receipt reconciliation applies |
| During reset wake before activation | Reset queued; ordinary dispatch gated | Existing frozen cutoff/transition identity; reconciler owns created transitions |
| Recovery preview / stale or busy apply | No mutation | New snapshot/key required |
| Local intent before relay reservation | Non-terminal intent only | Failed or unapplied reservation remains held; reconnect queries only, fresh preview/approval required |
| Relay reservation before local cancellation | Exact recovery key durable; delivered head fences successors | Lost reply/restart queries proof, then records local cancellation; persisted acknowledgements are fenced |
| After local cancellation before relay receipt | One local marker appended; old task never replayed | Reconnect resends same delivery cancellation |
| Relay receipt saved, reply lost | One relay input cancelled, successors retained | Idempotent same-status receipt retry |

## Rollout boundary

Implementation/tests do not modify live queues. Push, consuming lock update,
host rebuild, and each live recovery require separate authorization. Rebuild the
owning host (currently **grill**), not an unrelated Matrix server. Deploy the
relay before replacing adapters. Surviving Pi processes still use their original
Nix-store resources; rebuilding alone does not load this command into them.
Busy processes must be left alone. An exact idle adapter may be gracefully exited
and resumed with the new launcher only with rollout approval; do not use `!stop`
as an upgrade mechanism because it cancels queued input. Verify attachment and
preview **one** conversation before approving its retirement, then check queue
progress before proceeding to other rooms.

The reservation adds an optional strict runtime input `recoveryKey`; older strict
readers cannot read it. Deploy the relay before upgraded adapters, and do not
downgrade once a retirement is reserved. Canonical gate and review outcomes are
recorded in the GitHub issue handoff.
