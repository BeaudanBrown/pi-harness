# Host approval integration (#108)

## Ownership

The current issue owns production composition of authenticated run proofs, pending
consent, native/Matrix presentation, cancellation, frozen-owner execution and
recovery without mutation replay. The existing policy remains deployment-only.
Unified tool/command ergonomics and remaining frontend aliases are #113; NAS
account execution is #112. No model mutation may reach a legacy bypass while an
owner or frontend remains unavailable. No rollout or live acceptance is authorized.

## Acceptance → evidence plan

| Acceptance | Intended proof |
| --- | --- |
| Freeze exact call and private owner preconditions before asking | Public dispatcher → owner → durable approval store; stale-target fixture |
| Derive native/Matrix origin from authenticated live attachment | Real IPC challenge, accepted-input lookup, mixed/forged-origin refusal |
| Native dialog or origin-room poll, operator-only consent | Native answer correlation and authenticated Matrix vote routing |
| Independent consent, expiry, deny, no broad lock during wait | Existing approval tests plus composed dispatcher lifecycle |
| Cancellation on tool/run end, disconnect and retirement | Production callbacks and cancellation fault injection |
| Restart and response-loss behavior | Unconsumed consent revalidated; consumed attempts discarded, never replayed |
| No automatic model mutation retry or completed receipts | Single executor attempt, ordinary denied/uncertain tool response |

## Crash boundaries

| Boundary | Authority / failure behavior |
| --- | --- |
| Before prompt | Persist immutable effects and original expiry; no executor side effect |
| Poll/dialog published before receipt write | Exact poll identity and saved request; no inferred approval |
| Vote before execution admission | Revalidate frozen owner state and fresh live tool; expiry/cancellation can revoke |
| Consent consumed before executor | Accepted record cannot authorize replay after restart |
| Effect completes before response | Unknown result is reported; operator inspects and makes a fresh explicit call |
| Pending run disappears | Cancel consent and close presentation; do not wake a dormant requester |

## Current integration evidence (not issue completion)

The production relay now composes the approval store, authenticated run frontend,
public dispatcher, native/Matrix presenters, cancellation and shutdown drain before
negotiating approval capability. Matrix intake forwards exact poll votes, and
retirement/disconnect revoke pending consent. Consumed startup records are never
executed again. Core open/resume/stop/delete owners freeze their current target or
retirement plan; unsupported owner translations still return upgrade-required
before asking rather than taking a legacy bypass.

The packaged managed-session gate passed after production composition. A real
Unix-IPC/peer-UID fixture proves native denial leaves the conversation intact and
a new independently approved self-delete commits terminal retirement. Composed
Matrix fixtures prove origin routing, operator-only/duplicate voting, private
precondition redaction, stale target rejection and cancellation. Existing expiry,
response-loss and restart/no-replay tests also passed.

Evidence: `.pi/tmp/workers/2026-10-02T06-53-34-125Z-approval-production-assembly-tests-2fe9e548fdc2/`.
## Approved branch preview extension and remaining owner work

The operator approved an explicit read-only branch preview using an existing
repository workspace, branch and merge target. It does not depend on a deleted
checkout, an expired removal preview or a durable completed-action receipt.
The typed contract, immutable policy, generated CLI, production preview router
and Git launcher now expose it. Branch deletion accepts only a branch preview,
rechecks repository identity and both refs, rejects checked-out/unmerged branches,
and does not replay success when the branch is absent.

Packaged Git tests cover checked-out refusal, fresh preview after checkout removal,
self-merge refusal, changed merge target, fresh replacement preview and absent
branch refusal. Owner fixtures cover preview-kind isolation, expiry, restart
cache loss, private-path redaction, stale tips and whole-bulk validation before
retirement. The final affected gate passed: 435 managed-session tests, zero
skips, and source contracts. Artifact:
`.pi/tmp/workers/2026-10-02T07-45-59-909Z-frozen-owner-branch-preview-verified-d32666e5a45a/`.

Creation/refresh and frozen worktree/bulk retirement translations are assembled;
remaining focused evidence and the final issue review/gate are still required.
Modern Space actions deliberately do **not** call the legacy reconciler: its
cleanup kicks the operator and its two-level hierarchy does not implement live
workspace ownership. A correct live reconciliation/account-cleanup owner remains
unfinished, as does account-backed membership restoration. This is not a claim
that #108, its reconciliation acceptance, or the model-tool frontend is done.
