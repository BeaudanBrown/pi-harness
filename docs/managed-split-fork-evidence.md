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
| Approval to admission | Frozen source generation, base commit, exact summary and target creation identity | Revalidate before effects; no model-action replay | Pending |
| Worktree construction | Existing worktree intent precedes Git effects | Recover only the recorded branch/path/commit | Pending |
| Context/session publication | Fresh session with summary and new binding boundary, atomically published | Never append into a live session; conflicting seed fails closed | Pending |
| Room provisioning | Saved creation/provenance before Matrix effects | Existing idempotent provisioning; unrelated rooms untouched | Pending |
| Summary notice | Frozen silent message with stable transaction identity | Retry exact payload; no repeated context append or target model turn | Pending |
| Registration/launch | Seed durable before input eligibility | No source execution state inherited; plain startup remains idle | Pending |
| Retirement during partial creation | Permanent tombstone wins over positive construction | Never revive target or expand frozen scope | Pending |

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

Host action/approval, creation-intent assembly, Matrix summary delivery, race tests,
issue-boundary review and final canonical gate remain pending. No deployment/live
traffic or native-navigation protocol changes occurred. Focused tests precede
remaining affected package checks and issue-boundary review.
Final canonical gate runs after implementation/review remediation. Deterministic
Pi/IPC/Git/Matrix-port fixtures are not actual Matrix/phone acceptance.
