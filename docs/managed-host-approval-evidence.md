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
## Live Space owner integration

Modern Space actions now use a four-level path in the existing `ProjectReconciler`,
not its legacy two-level migration/cleanup methods. Reconciliation freezes saved
parent/child provenance and account identities, verifies them read-only, and
repairs only missing links under project exclusion. It does not discover/adopt
rooms, create a second migration engine, rename rooms or replay an accepted
model mutation. Legacy adoption remains #117.

Standalone cleanup selects only exactly owned, empty, unreferenced non-host
Spaces without other members. It persists the existing permanent Space fence
before account effects and rechecks scope before mutations. Without the #112
account port it returns pending without unlinking, kicking or leaving. A lost
bot-leave acknowledgement is settled by read-only bot/account completion evidence;
replacement Spaces never become cleanup targets. Membership restoration remains
account-backed dependent work.

| New boundary | Evidence |
| --- | --- |
| New/changed link or account after approval | Frozen owner and reconciler reject stale scope before writes |
| Foreign proof/member or live/unpublished reference | Refusal/empty eligibility; no adoption, kicks or destructive fallback |
| No account port after fence | Durable pending fence; no external cleanup |
| Restart or fresh replacement reservation | Old IDs remain authoritative; replacement links/membership survive |
| Bot leave accepted, reply lost | Restart performs only verified completion bookkeeping, not another leave |
| Worktree base moves after outer validation | Lifecycle admission rechecks the frozen plan before apply |

Affected packaged verification passed: **441 managed-session tests, zero skips**,
and source contracts. Artifact:
`.pi/tmp/workers/2026-10-04T21-47-04-843Z-live-space-approved-owner-affected-a2697d737b43/`.
After the bounded single-pass reference scan and account-identity freezing, the
final 27 focused owner/hierarchy/ancestor tests passed with zero skips:
`.pi/tmp/workers/2026-10-04T21-53-02-827Z-live-space-frozen-account-identity-251ee573ac84/`.
LSP has no errors. These intermediate results do not constitute deployed
Matrix/NAS acceptance or completion of the model-tool frontend.

## Final acceptance and review

Commit `19062da` adds public-dispatcher consent coverage across creation, launch,
refresh, destructive bundles, reconciliation and account-operation families, plus
restart evidence that only live unconsumed consent retains its original expiry.
The affected packaged managed-session/source-contract gate passed:
`.pi/tmp/workers/2026-10-04T22-37-35-712Z-approval-issue-boundary-affected-fea3ec9067f6/`.
Production IPC, native/Matrix origin, denial, cancellation, immutable target,
response-loss and consumed-no-replay evidence is recorded above and in the
corresponding host-approval, host-run and owner tests.

One exhaustive two-axis issue-boundary audit inspected HEAD `19062da` and its
existing #108 foundations and integration:
`.pi/tmp/reviews/2026-10-04T22-39-04-647Z-audit-19062da7a51e-6c3aedfb9680/`.

### Standards

No findings.

### Spec

One medium dependent finding: explicit approved bridge identities are supported
by the presenter but cannot yet be configured in production. Tracked on #120,
whose existing acceptance owns deployment operator/bridge configuration. The
primary configured operator works; other identities remain denied by default.
No current-issue remediation was requested.

### Closure scope

#108 covers the approval mechanism and available frozen operation owners, not
NAS account execution/membership restoration (#112), remaining unified frontend
registration and aliases (#113), legacy adoption (#117), deployment bridge
configuration (#120), or live client acceptance (#121). Unavailable dependent
operations fail closed; account-dependent cleanup retains exact pending authority.
The mandatory cumulative epic review remains outstanding.

### Final verification

Canonical `nix run .#verify` passed at `80d637e`: all 12 groups, including
**443 managed-session tests with zero skips**, TypeScript, schemas, source/module
contracts, integration checks and production package checks. Artifact:
`.pi/tmp/workers/2026-10-04T22-43-35-753Z-host-approval-final-canonical-0c2a40cee40e/`.

#108 is complete within the closure scope above. This final documentation-only
result entry does not change the verified implementation. All changes are locally
committed; nothing was pushed, deployed, activated or migrated.
