# Account scheduling release verification (#157 / epic #153)

Scope: cumulative deterministic acceptance, compatibility evidence and final
Standards/Spec review from `fab6dee7979e2f30c7aeecb7a73328c3de7c6056` through
#154–157. #152's deadline correction is a separate unpublished prerequisite.
No publication, downstream pin, activation, outage or live repair is authorized.

## Acceptance and crash matrix

| Criterion | Executed evidence before final review |
| --- | --- |
| 50 completed ensures + 3 unverified ensures + 12 unverified retirements | Loaded real JSON/SQLite test completes foreground inspection within 20 serial dispatch turns; initial backlog and cleanup obligations preserved |
| Sustained new traffic / maintenance and cleanup fairness | Loaded test completes joined-state repair, serves completed maintenance and all 12 cleanup obligations under continued new inspections |
| Delayed/lost/out-of-order acknowledgements | Cross-owner lost NAS ack + host redelivery/reload, lost host send/reload, and delayed lower-revision ack tests pass |
| Restart storm bounds | Loaded restart test proves all 3 unverified ensures / 12 unverified retirements stay parked, including just before the 30-second boundary |
| Original approval expiry | Loaded expiry/restart test retains the frozen deadline, sends no late authorization and performs no join |
| Complete repair / no restart continuation | Existing six-incident cross-owner acceptance and restart-no-replay orchestration tests pass; new loaded membership protocol completes without changing expiry |
| Reader and rollback compatibility | Published edb9ede parser executed against new/old status; legacy NAS writer exercised on a disposable migrated database, confirming downgrade rejection without damage |
| Final release confidence | 256 pre-review affected tests, 47 post-remediation focused tests, paired cumulative review, canonical gate and both actual production builds pass |

Crash boundaries retain durable request scope before delivery, same transaction
on uncertain HTTP, newer acknowledgement revisions after old replies, bounded
retries after reload, original membership expiry and existing uncertain-join
fences. Scheduling hints never revive approvals. Diagnostics cannot grant effects.

## Rollout and rollback constraints

- New readers accept old status responses; older strict readers reject the new
  capability/diagnostic field. This is a coordinated upgrade, not mixed-version
  compatibility. Stage matching relay and CLI/tool/frontend resources together;
  refresh existing interactive sessions before invoking host control again.
  A running old frontend must not be treated as compatible merely because its
  binary path was updated. Operator activation and session refresh are explicit.
  Do not activate a relay without a matching usable frontend. If a running Pi
  cannot load the matching immutable resources in place, obtain a separately
  approved history-preserving handoff/restart; do not stop it automatically.
- NAS has the same account wire contract; deployment may be staged independently
  of host protocol consumers, but no repair acceptance is claimed until both
  intended versions are confirmed. Schema migration remains owner-exclusive.
- After the NAS schema migration, an older positional outbox writer is not a
  supported downgrade. Host timing hints likewise are not promised readable by
  old host binaries. Do not automatically roll back a generation, clear journals,
  copy an open database, remove terminal flags or recreate rooms to recover.
  Any rollback requires a separately approved state-aware recovery plan.
- After separately approved publication and operator rebuilds, verify exact
  running package versions/capabilities and sanitized owner diagnostics. Existing
  expired/held repairs require fresh previews and separate per-target approval.
  Queue replay/abandonment remains independently approved. No old approval is
  automatically resumed by this release.

## Cross-owner findings and evidence

The new tests use actual host JSON and NAS SQLite stores/workers with only clock
and Matrix ports faked. A conservative dispatch turn performs one host send, one
NAS effect and one ack flush; production's larger batches are separately covered
by host/NAS lifecycle tests. Turn bounds are deterministic service evidence, not
network latency or a live repair-completion guarantee.

The first loaded cleanup test froze time after enqueueing new parked obligations.
Advancing the fake clock one second per cleanup turn made it pass without changing
production fairness. This was a fixture error, not permission to erase backoff.

A genuine cross-owner gap was reproduced: after an uncertain NAS inspection-ack
send, host redelivery discarded that pending outbox row and regenerated a new
transaction/revision. Intake now drains existing frozen ack bytes/transaction
before interpreting a completed inspection duplicate as fresh demand. The test
also proves fresh demand still recomputes once the uncertain transmission is
successfully drained. No scope, terminal authority or expiry was relaxed.

- Red cross-owner gap and initial fixture evidence:
  `.pi/tmp/workers/2026-11-05T05-50-23-199Z-account-delivery-loaded-acceptance-initial-5d78d74b8c33/command.log`
- Fake-clock-only cleanup correction:
  `.pi/tmp/workers/2026-11-05T05-53-19-407Z-account-delivery-loaded-clock-check-a17aa2bb4492/command.log`
- Loaded checks and executable published-baseline compatibility:
  `.pi/tmp/workers/2026-11-05T05-55-55-248Z-account-delivery-acceptance-and-compatibility-ec43d797f306/command.log`
- Six new loaded regressions plus broader affected checks: **256 passed**, zero
  failures/skips/cancellations:
  `.pi/tmp/workers/2026-11-05T05-58-49-885Z-account-scheduling-epic-affected-313e3a0b1942/command.log`

Compatibility used a `git archive` of published
`edb9ede8143dda4330a7d17c0b42cc8aa2690c84`, compiled in isolated
`.pi/tmp/account-release-legacy`, and `.pi/tmp/account-release-compatibility.cjs`.
Both readers accept old status; the old reader rejects the new capability alone,
new field alone, and both together. Its NAS positional writer rejects the migrated
outbox schema, while the failed transaction preserves the request. Only disposable
fixture databases were accessed; none were copied or read from running services.
These are explicit rollout constraints, not defects waived as compatible.

## Cumulative review and remediation

The completed paired review is preserved at
`.pi/tmp/reviews/2026-11-05T06-01-10-354Z-worktree-4b9b5918f3b0-f91da41106a5/`.
It covers the cumulative #154–157 snapshot from `fab6dee`, including the loaded
acceptance tests and uncertain-ack correction. Standards reported no findings.
Spec reported two medium-severity, current-issue findings, both accepted:

- Negative-authority retries now retain the control lane on host and NAS even
  after `unverified` progress; existing retry backoff remains binding.
- Host same-lane selection now orders by persisted due time, then original
  repair expiry (including authorization/confirmation children), then request ID.
  New requests persist their enqueue due time so sustained arrivals cannot jump
  overdue work indefinitely.

Five regressions cover these corrections. The resumed focused TypeScript build
and 47 scheduling/cross-owner tests passed, with no skips, failures or cancellations:
`.pi/tmp/workers/2026-11-05T08-53-52-088Z-account-scheduling-remediation-8d51dbff0cae/command.log`.
This is the review remediation batch, not a new design or a reason to repeat the
subjective review.

Final verification passed:

- `nix run .#verify` — all 12 deterministic checks passed, including TypeScript,
  managed-session integration, bridge-chat, package and module contracts.
- `nix build .#managed-session-relay .#bridge-chat --no-link` — both actual
  production packages built successfully; no services activated.
- `git diff --cached --check` — clean. LSP reported no cached diagnostics
  (only the Markdown server was running); TypeScript was verified by compilation.

Combined final log:
`.pi/tmp/workers/2026-11-05T08-55-13-742Z-account-scheduling-final-release-gates-409f1a862b02/command.log`.
The remote builder was unavailable; Nix completed the builds locally. Only this
verification record changed afterward, checked with `git diff --check`; no code
changed and the canonical gate was not repeated for that documentation-only edit.
This document is not rollout authorization.

## Live incident boundary

The operator still reports broken Matrix conversations and new conversations on
repeated Pi startup. These are not declared fixed by deterministic acceptance.
Bare interactive `pi` currently intentionally creates a new managed conversation;
explicit saved-session resume is the identity-reuse path. Changing that default
is separate product scope, not an account scheduler correction. Do not use repeated
bare launches to recover an existing identity.

Read-only host inspection during handoff found two `account_pending` repair
receipts without live continuations, two unobserved project launches, and legacy
coordinator ownership. Fresh per-target inspection/consent and coordinated rollout
remain required; no queue replay, automatic repair continuation, conversation
replacement, publication or service activation was performed by this release work.
