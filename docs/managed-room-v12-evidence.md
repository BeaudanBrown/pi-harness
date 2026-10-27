# Room-v12 compatibility remediation (#121)

Operator approved fixing the isolated live-smoke blocker and recovering/retesting
the SAME reserved Space/state. This is current-epic work, not publication, fleet
activation, existing production migration or desktop acceptance authorization.
No production credentials, rooms, shared tmux or services may be touched.

## Acceptance / evidence plan

| Requirement | Change | Evidence |
| --- | --- | --- |
| Legacy and v12 room identifiers | Shared bounded room-ID predicate/schema; replace legacy-only journal, provenance, account and public-control checks | Valid/invalid identifier table; real provisioner legacy/v12 paths |
| v12 bot authority | Recognize creator authority only from authenticated immutable create sender, not numeric power or additional-creator claims | Real Matrix client fixture with no creator power entry; foreign/additional creators rejected |
| Non-routable room IDs | Space child via comes from participating bot's server, never the room hash | Recorded outgoing state request assertions |
| Durable recovery | Existing hostAttempted reservation recovers exact attested alias without recreating host Space | Interrupted provisioner test, actual retained-state retest |
| No weakening of scope | Preserve provenance, private/nonfederated/encryption/type/member gates | Negative fixtures and affected managed/account suites |
| Final verification | Paired review, canonical harness gate and packages | Record outcomes below |

## Crash / external-effect boundaries

| Boundary | Recovery rule | Evidence |
| --- | --- | --- |
| Room created, host ID not committed | Recover existing alias/proof under original host identity; never clear intent or retry create | Durable hostAttempted regression and same-state live retest |
| Host ID persisted, coordinator not created | Continue original coordinator identity; persist attempted flag before create | Provisioner regression |
| Hierarchy link accepted before receipt | Same child/parent IDs and idempotent state event, no room replacement | Existing hierarchy tests plus v12 routing test |
| Account request/join/rules | Existing account worker receipts; trust only provided test bot/device; no policy reset | Live retained account DB and affected account tests |
| Exit or failed test | Stop only owned test processes/private server; retain test room inventory and journals | Live report/cleanup evidence |

Initial source diagnosis includes a correction to the first smoke report: the
real client rejects the v12 ID immediately after create (or during alias recovery),
before the journal commit is reached. The journal and provenance schema defects
are additional independently reproduced blockers, not the only failing layer.

## Verification and review outcomes

- Red regressions: `.pi/tmp/workers/2026-10-27T02-40-24-602Z-room-v12-regressions-red-89528ace3c9a/`;
  valid v12 provenance and real attempted-host alias recovery failed before fixes.
- Focused green: 53 tests, zero skips,
  `.pi/tmp/workers/2026-10-27T02-44-53-356Z-room-v12-focused-green-0492537e8638/`.
- Full affected packaged suites: 570 managed and 87 bridge tests, zero skips;
  updated actual relay/account/module-dispatcher candidates built successfully:
  `.pi/tmp/workers/2026-10-27T02-46-14-462Z-room-v12-affected-and-live-candidates-ba7ac88908d8/`.
- Paired review:
  `.pi/tmp/reviews/2026-10-27T02-48-44-866Z-worktree-c34a01adff61-08db88b272d0/`.
  Accepted all findings: medium/current missing evidence outcomes (this section);
  high/current permissive self-membership and retirement room validation (now
  shared bounded checks); high/current alias-create recovery lacking immutable
  sender verification (now verified before returning or persisting any alias
  result). Added membership, retirement and foreign/co-created alias regressions.
  The authenticated content-only create endpoint is not itself sender proof.
- Real same-state retry is still **pending** at this checkpoint. The original
  failed attempt and retained identity are documented in
  `docs/managed-live-workspaces-live-smoke.md`. No live success is inferred from
  these offline results. Final remediation tests/gate and retry results follow.

The shared room-ID predicate rejects C0/C1 controls, whitespace, malformed hash
length/alphabet and oversized values while preserving legacy IDs. v12 routing
uses the participating bot's full server name (including port), not an opaque
room suffix. Both relay and independent account worker reject additional creators
and unreviewed room-version authority; valid legacy room behavior is retained.
Through v10 the authenticated immutable create content's required creator is
sufficient identity evidence; v11/v12 or absent creator content requires the full
create event sender. v12 creator power does not depend on a users power entry.

## Same-state live results

1. `.pi/tmp/workers/2026-10-27T03-01-28-013Z-room-v12-same-state-live-recovery-b80a4daf8390/`:
   recovered the original host Space, created/linked its coordinator room and
   reached relay/account ready. The runner then timed out because it expected an
   idle coordinator to launch without requesting open. This was a fixture
   expectation error, not another Matrix compatibility failure. No state reset.
2. `.pi/tmp/workers/2026-10-27T03-04-47-514Z-room-v12-live-explicit-open-continuation-acf87982713b/`:
   **PASS** after explicitly opening through the public human-local interface.
   Real native coordinator and project Pi attached on the private tmux server;
   project creation used the disposable Git checkout. Exact-window open succeeded
   and a stale generation was refused. The live host/project/checkout/conversation
   topology had exactly five test rooms, including the original host Space, and
   the dedicated owner automatically joined all five.
3. `.pi/tmp/workers/2026-10-27T03-07-06-365Z-room-v12-live-account-ack-restart-5736bbd62450/`:
   **PASS** on a bounded restart with no create/open operation. Both coordinator
   and project account setup acknowledgements became ready, preserving the exact
   five-room set, account database, journals and generations. This distinguishes
   membership alone from completed account readiness.

Reports are `.pi/tmp/live-smoke-{recovery,continuation,account-settle}-report.json`.
The private local root remains `/tmp/pi-live-smoke-2dsA99`. All test processes were
stopped and temporary credential copies removed. A final filesystem check found tmux's
stale socket pathname: a bounded connect returned ECONNREFUSED, then the exact
current-user-owned socket inode was unlinked. No listening server remained.
Five disposable Matrix rooms
and original test credentials are retained; no production rooms/accounts,
shared tmux/services, server settings, fleet lock or model credentials were used.

Still untested live: model commentary/final generation, native split/fork/tree
and approval UX, retirement/migration, desktop/Element X notifications, and actual
host service activation. This bounded smoke is not full #121/epic acceptance.

## Verification follow-up

The first review-remediation run exposed unnecessarily requiring full sender
state from pre-v11 fixtures that already supplied their immutable creator field.
The implementation now respects both versioned forms without relaxing v11/v12
checks. That run also had a gap-recovery timing assertion failure; the unchanged
gap test passed on the next full run. No assertion was removed or test skipped.
Post-remediation suites passed **572 managed / 87 bridge, zero skips**, with
updated candidate packages:
`.pi/tmp/workers/2026-10-27T02-58-06-607Z-room-v12-reviewed-compatibility-checks-2cb776467711/`.
The final gate will also exercise explicit v11 collision coverage and require
sender proof for v11/absent creator in the general authority path. These final
checks do not change the v12 path exercised by the successful live smoke.

## Final gate and handoff

All 12 canonical harness gates, default/relay/account production packages,
seven owning-repo source checks, six syntax-only Nix parses and 46 unchanged
picker wire fixtures against the current production TypeBox schemas passed:
`.pi/tmp/workers/2026-10-27T03-13-14-085Z-room-v12-final-gate-7849bc38ceca/`.
Managed 572 / bridge 87 / package 13+17 tests passed with zero skips. LSP reported
no TypeScript errors; existing external Go workspace warnings are unrelated and
no Go source changed in this remediation. Only evidence prose changed afterward.

Runtime fix: `4415c7ce683a3af2f666e3d8f1c3f3ea3d9c099b`. The owning dotfiles
requested source pin and source assertion were advanced to this revision, still
local/unpublished with the old actual fleet lock intentionally unchanged. This
is not a resolved/deployable fleet configuration. No push occurred.

#120 remains open for publication/actual lock integration; #121 remains open for
broader client/behavior acceptance. The approved v12 compatibility remediation
and bounded same-state live recovery are complete, not the whole epic.
