# Exact stale-queue abandonment (#145)

Implementation authorization only. Publication, activation and each live cancellation require separate approval.

## Semantics

Cancellation abandons **future dispatch and retries**, not past effects. Persisted input may already have executed; a pending Matrix acknowledgement does not prove absence of delivery. Preserve saved Pi sessions, Matrix history, queued payloads and sent-chunk evidence. Never convert abandonment into successful completion. No launch, stop, retirement, membership change or replay is part of cancellation.

## Acceptance / evidence plan

| Requirement | Implementation boundary | Required evidence |
| --- | --- | --- |
| One exact conversation, frozen item IDs/status/content digests | Feature snapshot + shared preview store | Source/item addition, removal, content/status change and expiry reject |
| Independent human approval | Typed preview/apply + shared mutation owner/policy | Model cannot execute without approval; warnings appear in approval |
| No active or in-flight work | Registry admission and producer activity guards | Attached/generation-transition/poll/refresh/busy writer rejection; deterministic race tests |
| Atomic audited abandonment | Serialized registry writer | All-or-none source revalidation; receipt ties operation to exact items and prior states |
| No future retries, no fake success | Input/control/transcript admission and terminal states | Reoffered IDs stay terminal; queued stale callbacks cannot send; reload preserves terminal state |
| Preserve history and prior effects | Retain payloads/sent evidence; no session/Matrix writes | Partial delivery and persisted-input fixtures; saved-session bytes unchanged |
| Bounded metadata-only preview | IDs, counts, opaque hashes and explicit uncertainty warning | No bodies, arguments or credentials in tool/approval output; bounds fail closed |

## Crash / concurrency evidence plan

| Boundary | Durable state / effect | Required interruption behavior |
| --- | --- | --- |
| Preview / approval | No queue mutation | Expired or changed scope requires new preview and consent |
| Producer already in flight | Activity lease | Cancellation rejected, no partial queue changes |
| Admission waiting behind writer | Frozen source hash | Revalidate after prior writes, not just before enqueueing |
| Commit | One atomic registry write containing tombstones and audit | No success before durable write; ambiguous writes fail closed until owner reload |
| Stale callback after commit | Terminal selected IDs | No dispatch/retry and no conversion to completed |
| Restart | Persisted queue tombstones + receipt | Suppress selected IDs, preserve unrelated/new work |

## Storage, bounds and compatibility

`registry.json` retains cancelled inputs and projections, moves control payloads into `abandonedControls`, and records `queueCancellations` with the approved operation reference, source digest, exact item digests/prior states and explicit uncertainty semantics. Cancellation and audit commit in one serialized atomic write. No automatic audit pruning: at most 32 operations and 1024 retained control payloads per conversation; previews allow at most 32 items. Sent chunks remain sent, pending chunks remain evidence of uncertain delivery; the entry itself becomes cancelled rather than projected.

This is authoritative queue state, not a separate archive/retirement authority. Preserve the current complete registry backup: restoring a **pre-cancellation registry backup also restores its old queue intents**. Existing independent archive/retirement fences remain unchanged. Never use backup restoration as cancellation recovery or authorization to replay work. After an uncertain write, the current owner refuses further activity; reload and inspect durable state before obtaining a new preview/approval if any work remains.

New adapters understand cancelled input/transcript/lifecycle receipts and persist a cancelled/blocked marker rather than inventing success or triggering persisted-input recovery. Upgrade adapters before reopening abandoned conversations. Cancellation is not process-exit attestation and cannot retract prior side effects. Checkpoints, polls, generation/tree transitions, active attachment, refresh and in-flight producers require separate resolution; output artifact deliveries are not in scope.

## Verification status

Pre-review TypeScript build passed. Affected managed-session suite: **696 passed, 48 SDK/package-environment skips, zero failures** (`queue-cancellation-pre-review-affected`). Eleven focused cancellation tests cover preserved payloads/history, persisted inputs, exact scope hashing, serialized source changes, no scope expansion, producer admission, real Matrix-call exclusion, post-commit retries, late receipts, uncertain writes/reload, approval-owner execution and expiry. Adapter coverage verifies distinct cancellation receipts and no recovery turn for explicitly abandoned persisted input.

An initial local lifecycle-fixture failure was caused by the inherited launch model; rerunning with only `PI_MANAGED_SESSION_MODEL` and `PI_MANAGED_SESSION_THINKING` unset passed.

### Standards review

One medium/current-issue finding: advertise the installed capability in `host.status`. Fixed in `host-read-model.ts`, with a capability-output assertion. No other findings. The correction did not change cancellation semantics or require another review.

### Spec review

No verified defects or scope additions. Both axes inspected the same pinned worktree against published baseline `f9a8f195929d7f48a8f983f0a6ac90a17af59691`; reports: `.pi/tmp/reviews/2026-10-31T08-11-19-494Z-worktree-9be44cbbe618-5485cfc39362/`.

### Final gates

`nix run .#verify` passed all 12 deterministic gates: **744 managed-session, 135 unit and 87 bridge tests, zero failures/skips**. Actual `nix build .#managed-session-relay .#bridge-chat --no-link` passed as a separate command, not inferred from TypeScript compilation. Log: `.pi/tmp/workers/2026-10-31T08-13-55-183Z-queue-cancellation-final-gates-499c691cc471/`. The unavailable remote builder fell back to local builds successfully. LSP diagnostics and diff whitespace checks were clean. Only this verification-evidence text was updated after the final gate; no code changes followed it.

Deployment and live cancellation remain separate, unapproved follow-ups. No live registry, session, room, queue or membership was changed during implementation. Coordinator repair, membership restoration, process shutdown and archive acceptance are out of scope.
