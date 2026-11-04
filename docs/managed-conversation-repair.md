# Unified conversation repair

Implementation epic #146; first slice #147. This document specifies the approved
replacement design, **not a claim that repair execution is available**.
Publication, deployment and live repair each require separate approval.

## Audit and scope

The current dead ends are structural:

- `registry.prepareProjectLaunch` records admission before launcher invocation and
  refuses an unobserved prior launch. This is necessary crash safety, but no
  supported owner reconciles this state for sandbox and epic 644.
- `manual-legacy-recovery` requires a project, a legacy window, no launch and no
  pending lifecycle work. It cannot repair those launch reservations.
- `hostActionPolicy` forbids coordinator manual recovery; lifecycle refresh also
  excludes it. Protection from stop/delete has accidentally become exclusion
  from repair. Coordinator room/session identity must remain protected.
- `queue-cancellation` safely abandons exact future attempts, not prior effects.
  It has its own admission and audit; the new repair owner must reuse those
  invariants rather than label abandoned work completed.
- `HostAccountOwner.freezeMembership` only supports coordinator departure.
  Project leave detection can retire a conversation asynchronously. Repair must
  arbitrate against this independent negative authority, not undo retirement.
- `HostReadModel` exposes last-known runtime/account projections, not current
  operator membership. A room link cannot overcome invite-only membership.

#147 owns a read-only `conversation.repair.inspect` operation, public strict
contract, narrow assessment module and tests. #148 owns durable runtime repair;
#149 owns original-room/account repair; #150 owns approved orchestration and
replacement of overlapping old paths; #151 owns cumulative verification.
Existing mutation semantics are unchanged in #147. No repair apply capability
is advertised by this first slice.

## Target interface and semantics

`conversation.repair.inspect(conversationId)` returns advisory observations,
bounded unfinished-work counts and actionable findings. It returns no approval
token. Attachment is not proof of idle or exact process ownership; absence is
not proof of exit. Unknown account/membership/process evidence remains unknown.
Inspection performs no filesystem, launcher, session or Matrix writes. Terminal
archive/retirement authority is returned without reading historical payloads or
contacting Matrix. It does not make an archived/retired identity resumable.

The later `conversation.repair.preview` selects explicit choices for the exact
conversation: runtime repair/open, queue hold/resume/abandon and membership
preserve/restore. Omitted choices must not enable effects. The frozen plan
contains effect targets, source/session identity, precise queue scope, process
observations and membership/departure evidence. The separately approved apply
executes through one shared repair owner, not recursive calls to public tools.
Unrelated conversations and new inputs cannot be included by an old approval.

Queue hold is a durable dispatch hold, not successful completion. Input arriving
while a repair is admitted stays held for a new explicit decision; approval to
resume a frozen queue does not approve executing newly arrived prompts. Completed
step receipts survive interruption; uncertain steps require observation before
retry. Changed targets require fresh consent. An admitted but incomplete repair
must be inspectable after restart without re-running effects automatically.

Stable conversation, room, saved session and generation identities are preserved.
Runtime facts may be reconciled only after exact exit evidence or explicitly
approved legacy closure attestation with fresh conflict screening. Nonce fencing
alone cannot stop an old process from writing files or executing commands.
A known live conflicting writer always blocks replacement. Monotonic launch
identity must survive clearing stale observations (no ordinal/nonce ABA reuse).
The coordinator uses the same repair module, with an adapter for its trusted
launcher and saved-session location, while stop/delete remain prohibited.

Membership restore targets the original proven-owned room and configured operator.
It requires explicit consent to the observed departure. Ban, foreign ownership,
missing bot authority or unavailable NAS support are actionable external steps,
not permission to create rooms, kick users or overwrite notification preferences.
Independent archive/retirement always wins, including when an old registry backup
is restored. A repair hold must never resurrect an already-retired identity.

## Acceptance to evidence

| Criterion | #147 evidence | Later owner |
| --- | --- | --- |
| Sandbox/epic unobserved launches | assessment fixtures distinguish reservations from dormant/attached | #148 exact process reconciliation and durable launch receipts |
| Coordinator legacy runtime | same assessment for both kinds, no destructive-policy relaxation | #148 protected same-session repair |
| Pi-harness output backlog | counts and explicit queue choice; no cancellation on inspect | #150 audited queue effects |
| Timeline/ihp-update inaccessible originals | membership leave/invite/ban/unknown distinguished from setup cache | #149 original-room consent and account protocol |
| No fabricated readiness | missing runtime/account observations reported, readiness always not verified | #151 live post-apply acceptance |
| No history/payload disclosure or side effects | narrow read adapters, metadata-only exact result schema; read-model integration tests | #148–150 durable owner/reload tests |
| Terminal authority dominates | retired/archive inspection without Matrix or runtime reads | #148–150 commit-time negative-authority checks |
| Frontend/version contract | tool/CLI/policy tests; inspect-only capability when wired | #150 preview/apply and rollout compatibility |

## Crash/uncertainty matrix

| Point | Durable authority / effect | Interruption and retry requirement | Owner |
| --- | --- | --- | --- |
| Inspect | none; metadata and membership GET only | repeat reads; never reuse as consent/exit evidence | #147 |
| Preview / approval wait | expiring frozen preview, separate approval record | changed scope invalidates; no effect admitted yet | #150 |
| Repair admission | exact plan/identity and dispatch hold in durable serialized owner | restart keeps hold; reject competing attach/wake/retirement races conservatively | #148/#150 |
| Closure evidence | birth-aware observation or audited attestation | reobserve after awaits; known conflicts not waivable | #148 |
| Runtime metadata commit | audit and monotonic attachment/launch fencing | uncertain write poisons owner until reload; no blind retry | #148 |
| Queue step | atomic cancellations/hold and exact receipts | retain payloads/prior effects; no fabricated success; scope changes replan | #150 |
| Invite/join | exact provenance/departure intent and stable account request | observe membership/ack before retry; later departure invalidates consent | #149 |
| Launcher call | durable launch reservation before external invocation | reconcile same attempt; never simply clear and repeat after timeout | #148 |
| Verification | attachment, runtime, account observations with distinct status | incomplete readiness stays awaiting observation/external action | #150/#151 |
| Authority rollback | independent archive/retirement fences | deny repair of fenced identity regardless of older runtime intent | #148–151 |

## Verification status

#147 verified on 2026-11-04:

- TypeScript compilation and 28 focused tests passed.
- Affected host/queue/inspection suite: 122 passed, two local packaged-helper
  skips. The initial local command lacked `markdown-it`; rerun used the installed
  Nix dependency path. No product failure was suppressed.
- Standards/Spec reviewed one pinned snapshot. Spec had no findings. Standards'
  medium current-issue finding was fixed: the registry now exposes detached,
  sanitized `repairRuntimeFacts`, not payload-bearing runtime snapshots. Tests
  forbid full snapshot access and verify the precise projection shape.
- Final `nix run .#verify`: all 12 gates passed; 751 managed, 135 unit and 87
  bridge tests passed with zero skips/failures in these canonical suites.
- Actual `nix build --no-link .#managed-session-relay .#bridge-chat` passed
  separately. This does not imply activation or live repairs.
- LSP and Git whitespace checks passed. Only this evidence paragraph changed
  after the final gate; executable sources remain the verified snapshot.

Review artifacts: `.pi/tmp/reviews/2026-11-04T01-13-30-904Z-worktree-5ee05dcf8c17-41524125266a/`.
Final gate log: `.pi/tmp/workers/2026-11-04T01-16-54-252Z-repair-inspection-final-gates-24fb99e59c22/command.log`.

Live conversations are not modified by this slice. The runtime and membership
repair dead ends remain pending #148–150; #151 requires cumulative epic review
and final verification. This evidence is issue-level, not epic acceptance.
