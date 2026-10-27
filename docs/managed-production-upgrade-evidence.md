# Production-baseline compatibility repair (#120 / #121)

## Incident and scope

GRILL's deployed baseline was `c65509a`, not the older merge base of the managed
workspace feature. The feature pin `6924263` omitted four production commits:
`02d1527` (restart-safe Markdown), `d03cf83` (checkpoint prose), `1a21bfa`
(durable receipt/held-input recovery), and `c65509a` (room IDs/provisioning).
A production entry at `/conversations/0/projection/106` had `renderingVersion: 2`;
the feature parser rejected it and the relay reached systemd start-limit-hit.
This was a source-integration omission, not corrupt operator data. Prior isolated
acceptance did not validate this actual deployed baseline.

Operator authorized source repair, regression tests and publication of a new
harness/dotfiles pin, but not host evaluation/builds, restarts or state mutation.
The repair merges the production branch rather than merely allowing unknown
properties. Strict validation and the current independent approval boundary stay.

## Acceptance → evidence

| Acceptance | Implementation / evidence |
|---|---|
| Read previous production state without stripping fields | Restore renderingVersion, frozen bodies, bounds, recoveryKey; synthetic 107-entry production-shape upgrade test |
| Retry uncertain projections with identical transaction/payload | Restore frozen v2 renderer plans and exact legacy renderer; acceptance-before-ack/restart and no-resend tests |
| Preserve new notification and branch behavior | Freeze disposition with rendering; commentary/final/branch-marker tests |
| Retain real disk-persistence receipts and explicit recovery | Merge 1a21bfa; capture verified disk entries before first host tool; buffered append and uncertain retirement receipt tests |
| Retain room validation/provisioning fixes without weakening modern authority | Shared strict room validator, full-create sender proof and exact retained prepared-session recovery; v12/legacy Space and provisioning tests |
| Keep per-call independent approval/tombstone/exact-window ownership | Retain compact managed_host tools, deny legacy model mutations; affected managed suite and review |
| Validate actual failure privately | Old parser reproduced exact error; new compiled parser accepted all 34 conversations and preserved renderingVersion; registry bytes unchanged after each read-only probe |
| Publish exact verified source | All 12 canonical gates and standalone default/relay/account builds passed; exact publication/pin receipts recorded in #120 |

## Merge decisions

- v12 uses the production immutable `/event` read with exact derived event ID,
  matching room, type, state key, content and sender. Missing IDs fail closed.
  Modern sole-creator/co-creator checks remain; v11 uses full create state.
  Only a verified foreign *unbound legacy alias* may be skipped.
- Room syntax validation is shared, retaining production server-name and
  canonical digest checks. Syntax is never ownership authority.
- Existing model lifecycle mutation aliases remain rejected by the relay;
  restoring production internals does not bypass current approved host controls.
- Unregistered retained provisioning intents cannot be resumed through ordinary
  start/create. Explicit confirmed provisioning resume requires the original
  prepared session. An independently approved fork retry may also continue its
  exact frozen construction intent and inherited context; this is not authority
  for ordinary starts or unapproved legacy lifecycle requests. The modern model approval boundary
  still refuses legacy mutation IPC; no new bypass/recovery UI is introduced.
  Registered sessions may never be reconstructed if history is missing. Fault
  injection targets current workspace-resolution phases, not root-ensure.
- The native first-tool origin fix uses verified on-disk persistence, not merely
  a branch entry that the SDK may still be buffering.

## Crash boundaries

| Boundary | Durable authority / retry behavior | Evidence |
|---|---|---|
| Load old registry | Existing bytes/IDs authoritative; strict parser reads without migration/reset | Synthetic production upgrade + private read-only parser probe |
| Freeze plan before Matrix PUT | Version, chunk bytes, transaction IDs and disposition fixed before send | Projection restart tests |
| Matrix accepts before sent receipt | Same transaction and payload retried; sent chunks not resent | Transcript/event/branch/recovery crash tests |
| User event before SDK disk append | No persisted receipt until file proves matching entry; uncertain held input never replayed automatically | Disk buffering and selective recovery tests |
| Retirement reservation before receipt | Reconcile exact reservation read-only after lost reply; no blind replay | Existing production recovery tests |
| Provisioning intent before manifest | Same identity/session/rooms required; missing history fails closed | Exact retained provisioning tests |

## Verification record

Initial direct test command omitted dependency paths and failed at module loading;
corrected focused checks exposed merge-integration failures (not waived). Local
LSP includes an unrelated retained disposable `/tmp` acceptance extension lacking
standalone dependencies. Nix source test compilation is the authoritative type gate.
Affected gates passed 621 managed and 87 bridge tests, zero skips (including
real packaged SDK tests). Paired review then identified two high/current-issue
findings: ordinary start could resume retained provisioning, and v12 immutable
event-ID proof was optional. Both were corrected in one remediation batch with
negative regressions; strict immutable reads and explicit resume are restored.
No findings were deferred. The post-review gate caught a conflict with the
already-approved split-fork retry contract: rejecting ordinary starts also blocked
explicit frozen fork recovery. That path now passes explicit recovery authority
only for a matching, freshly frozen fork intent, preserving the original session
and context; ordinary start remains refused. Final canonical gates and publication
follow below.

Earlier failed checks exposed stale test fixtures (registered conversations with
no session file, removed root-ensure injection points, JSON formatting) and a
real retry interaction: an unnecessary persistence timer could preempt closing
feedback backoff. Fixtures now model valid persisted histories, and agent-end
cancels redundant persistence timers; missing-history refusal has its own test.
Neither assertions nor timeouts were weakened to obtain a pass.

### Final result

All 12 canonical gates passed: 623 managed, 87 bridge, 135 unit, 73 eval-self-test,
6 pi-r and 13+17 package tests; zero skips. Default, relay and bridge-chat
standalone packages built successfully. The final packaged parser accepted all
34 current production conversations; every projection record compared equal and
the production registry bytes remained unchanged. This was a pure read-only
parser invocation, not relay startup or live Matrix acceptance.

Artifacts:
- Review: `.pi/tmp/reviews/2026-10-27T16-46-24-803Z-worktree-2ff5d1b18686-c0f6a788212a/`.
- Final gate/packages: `.pi/tmp/workers/2026-10-27T16-55-50-158Z-production-upgrade-final-canonical-confirmation-924497b6f67b/`.
- Initial post-review gate caught the split-fork interaction; the later focused
  ad-hoc runner lacked packaged launcher setup. The final canonical environment
  includes those launchers and passed all cases without skips or timeout changes.

Only this evidence result was updated after the final gate; executable source is
unchanged. No production registry copy, message content, token or credentials are
included in this evidence or tests. No production service operations, host
configuration evaluation/builds, activation or migration have been performed.
The operator owns the next GRILL rebuild and post-activation health check.
