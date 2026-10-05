# Matrix split-fork evidence (#125)

Status: implementation in progress; no deployment or live acceptance.

## Scope

Create an independent committed worktree/conversation with explicit inherited
summary context, then stay idle. Source context, files and activity are untouched.
Reuse host creation/approval and exact-resource authority. Native navigation
(#114), titles/status (#115), enrollment/migration/picker and deployment remain
separate. No approval of the native generation-navigation protocol is implied.

## Acceptance-to-evidence matrix

| Acceptance | Intended implementation | Evidence required |
| --- | --- | --- |
| Typed Matrix-origin fork with per-call consent | Existing host action/dispatcher/tool and frozen mutation owner | Real IPC approval, origin, denial and scope-change tests |
| Committed worktree; unchanged source | Existing worktree preview/apply, frozen commit and source generation | Real Git fixture with dirty source, moved refs and collision rejection |
| Independent conversation/session/room | Creation reservation plus fork-specific immutable context seed | Separate identities; no imported bindings/receipts/approvals |
| Visible summary in Pi and Matrix, idle | Native custom-message context entry and silent stable notice | Real Pi context/startup, zero model calls before subsequent input, repeated startup |
| Exact bounded summary consent | Strict bounded context schema, immutable content identity | Unicode/byte bounds, unknown fields, conflicting retries |
| Crash-safe construction | Existing worktree intent and operation-specific initialization state | Faults before/after worktree/session/room/summary writes; no duplicate effects |
| Retirement and no premature input | Canonical retirement fences and pre-registration seed persistence | Source/target retirement races; held input until initialization |
| Destination identity/link | Existing bounded result and frontend surface | Tool/CLI/Matrix format tests |

## Crash-boundary matrix

| Boundary | Before/effect/durable identity | Recovery requirement | Evidence |
| --- | --- | --- | --- |
| Approval to admission | Frozen source generation, base commit, exact summary and target creation identity | Revalidate before effects; no model-action replay | Owner source-origin/generation test; existing per-family approval suite includes fork |
| Worktree construction | Existing worktree intent precedes Git effects | Recover only the recorded branch/path/commit | Real packaged Git fixture retries the same worktree; dirty/staged/untracked source preserved |
| Context/session publication | Fresh session with summary and new binding boundary, atomically published | Never append into a live session; conflicting seed fails closed | Seed helper tests plus injected failure after publication and before registration |
| Room provisioning | Saved creation/provenance before Matrix effects | Existing idempotent provisioning; unrelated rooms untouched | Stateful Matrix-port fixture reuses same rooms across failed construction/retry |
| Summary notice | Frozen silent message with stable transaction identity | Retry exact payload; no repeated context append or target model turn | Pre-registration notice hold survives outbox restart; changed payload/session rejected; repeated request sends once |
| Registration/launch | Seed durable before input eligibility | No source execution state inherited; plain startup remains idle | Actual IPC attachment after seed/notice persistence; empty input queue; genuine Pi SDK startup/reopen stays idle |
| Retirement during partial creation | Permanent tombstone wins over positive construction | Never revive target or expand frozen scope | Target retirement blocks further Git effects; source retirement rejects preparation; late retired-room notice suppressed |

## Context-seed foundation

Implemented a strict summary seed (4096 characters / 8192 UTF-8 bytes), source
conversation/generation and committed-base identity, deterministic content identity,
and one visible native Pi custom-message entry. The existing project-session writer
can atomically publish that seed with a new session/binding boundary; retries verify
the exact existing seed instead of appending or modifying a live session. Ordinary
creation remains unchanged and no frontend yet exposes this path.

Real Pi SDK tests load and reopen the generated session with zero model calls, then
observe exactly one model call after an explicit subsequent prompt. They also verify
one persistent seed and no imported parent-session relationship. Bounds, conflicts,
source/destination separation and refusal to retrofit an existing session are tested.
This is context/publication foundation only, not runtime fork acceptance.

## Verification

Affected packaged managed-session checks passed **468 tests, zero skips**, including
four new seed tests; source contracts passed. Artifact:
`.pi/tmp/workers/2026-10-05T11-46-58-993Z-split-fork-seed-affected-packaged-b81d899cff96/`.
The relay package explicitly includes the new helper. Earlier failures were corrected:
the SDK fixture needed `bindExtensions({})`, and the relay's source-copy allowlist
needed the new module. NAS builder SSH was unavailable; local Nix fallback succeeded.
LSP reports no code errors (an unrelated settings-schema URL returns 404).

## Runtime integration

`worktree.conversation.fork` is now routed through the shared host schema, CLI/tool,
policy and mutation owner. Matrix/model origin must match the source conversation;
source placement/generation and committed base are frozen and rechecked. Approval
shows the exact summary once and the frozen source generation/base, without
truncating oversized requests. Tool help includes the current conversation ID.

Existing worktree intents retain the strict seed but strip it before Git launcher
calls. New session publication includes seed context atomically. A silent frozen
notice is persisted **before** registry registration; its `awaitRegistration:true`
flag prevents a startup gap from silently discarding it. Existing outbox entries
remain unchanged. Target tombstones and source invalidation fence retries; stale
or changed initialization bytes are rejected rather than overwritten.

A new real-Git/actual-IPC test preserves staged, unstaged and untracked source data,
creates a committed-only target, injects failure after seed/notice persistence,
reopens the notice owner and explicitly retries the same creation. It observes one
room, one seed, one launch and one summary notice, with no target pending input.
Exact-window operations are simulated; this is not live tmux/Matrix acceptance.

Review-input checks passed **471 managed tests and 87 bridge tests, zero skips**,
plus source/module contracts:
`.pi/tmp/workers/2026-10-05T12-36-34-572Z-split-fork-review-input-checks-8518d611231b/`.
Six selected routing/retirement/consent tests also passed in
`.pi/tmp/workers/2026-10-05T12-35-57-420Z-split-fork-final-focused-8ded2df6d22a/`;
the broader run includes all real-Pi tests. Fixture failures during development
were missing unused tmux-socket configuration and incorrectly nested exact-launch
placement fields; both were corrected without weakening production validation.

Issue-boundary review and final canonical gate remain pending. No deployment/live
traffic or native-navigation code changes occurred. #114's scoped protocol is now
approved but remains a separate implementation boundary.
Final canonical gate runs after implementation/review remediation. Deterministic
Pi/IPC/Git/Matrix-port fixtures are not actual Matrix/phone acceptance.
