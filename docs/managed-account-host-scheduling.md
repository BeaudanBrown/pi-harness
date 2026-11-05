# Host account delivery scheduling (#154)

Part of #153; scope is the host delivery loop. NAS scheduling (#155), public
sanitized diagnostics/precise blockers (#156), and cumulative release acceptance
(#157) are dependent work. #152's original-deadline repair fix remains separate.

## Acceptance / evidence plan

| Criterion | Evidence |
| --- | --- |
| Fresh inspection not behind 50 completed ensures | real HostAccountClient durable-journal regression with fake clock/transport |
| Bounded fairness across control, interactive, ordinary and maintenance | deterministic weighted turn tests and sustained foreground load |
| No three-second idle gap | production client pump, wake-on-enqueue, bounded batch and close tests |
| Repeated unverified work backs off | persisted due-time/attempt hints; duplicate provisioning/acks do not reset backoff |
| Restart and uncertainty preserve authority | old journal compatibility, exact transaction reuse, poison, terminal tests |
| Maintenance keeps audit/departure checks | complete records retained, bounded periodic refresh and explicit stale probe demand |

The host journal remains authoritative. Optional scheduling hints are not consent.
Four classes use turns control, interactive, interactive, ordinary, maintenance;
empty classes are skipped. Selection within a class is oldest eligible attempt
(request identity tie break). Negative fences apply independently of queue order.
Serial sends use batches of at most eight / one second, then a short yield. Retry
base is 30 seconds, exponentially capped at five minutes; completed maintenance
refreshes at 60–75 seconds with deterministic per-request jitter. Demand inspection
only expedites stale completed evidence; repeated unresolved requests cannot reset
retry timing. Evidence TTL is unchanged.

## Crash / concurrency matrix

| Boundary | Rule |
| --- | --- |
| Enqueue before wake | persist first; restart discovers durable work even if wake was lost |
| Selection before HTTP | transaction and next retry persisted atomically; uncertain write poisons writer |
| Lost HTTP response | same transaction reused; no parallel sender or blind new transaction |
| Ack before next turn | authenticated revision persisted before wake; duplicate ack is not progress |
| Process restart | retain hints / derive conservative hints for legacy rows; no new repair continuation |
| Retirement while queued | recheck terminal ownership and parent cancellation before effect |
| Clock rollback | future due timestamps remain not due; never fabricate freshness |
| Close / empty queue | interrupt sleep and transport; no orphan worker or polling spin |

No live mutation, publication or activation is authorized by this implementation.
## Verification and compatibility

The original real-client diagnostic improved from 50 completed resends / 150,000
simulated milliseconds to zero resends / zero simulated wait for a fresh probe.
The committed regression additionally makes all maintenance due before enqueue.
Twelve new scheduling tests cover fairness, backoff, rate limits, restart, stale
inspection demand, batch yield, lost wakeups, close and uncertain-write poison.
Eighteen focused tests passed, including existing host account authority tests.
The broader affected run passed 135 tests before the additional rate-limit case.
Evidence: `.pi/tmp/workers/2026-11-05T01-31-46-402Z-host-delivery-affected-owner-checks-a55a6f008ce1/command.log`
and `.pi/tmp/workers/2026-11-05T01-34-35-555Z-host-delivery-rate-limit-and-repro-a24cef314583/command.log`.

Transport-wide 429 cooldown is durable and also gates newly enqueued work after
restart. Per-record optional delivery hints are strict/bounded and legacy rows
without hints remain readable; old binaries are not promised to read new hints.
Do not downgrade a written journal or clear scheduling fields manually. No wire
protocol change or fresh effect authority is introduced by this host-only slice.
The periodic inventory reconciliation remains in HostAccountOwner, but no longer
owns or blocks the delivery pump. Public queue diagnostics and precise supported-
but-unverified messages remain #156; NAS work/ack pumping remains #155.

## Review disposition

Both review axes found terminal-dispatch and inherited-parent-expiry gaps. Fixed
in one batch: reconcile known registry terminal authority before each selection,
re-read current cancellation after durable selection, re-fence immediately before
HTTP, and require authorize/confirm parents to be matching, uncancelled and
unexpired. Six new tests inject retirement/expiry before selection and during its
write. The existing narrow supplemental-attestation exception remains: only a
persisted NAS `pending / unverified` negative receipt permits sending ensure
metadata to establish cleanup provenance; it grants no rejoin authority.

Initial enrollment may precede a manifest. Membership-repair identity checks and
negative terminal checks are therefore distinct callbacks; missing identity is
not fabricated retirement authority. The existing real hierarchy roundtrip
caught this distinction during remediation and passes again. Its deterministic
manual pump now explicitly suppresses the background pump rather than racing
both clocks. The live-pump batch test observes its scheduled yield, not a file
rename before fsync has completed.

The Standards claim that production never starts/closes the account owner was
rejected with `main.ts:596` (`account?.start`) and shutdown paths at 617/645/685.
No production wiring patch was needed. Review evidence:
`.pi/tmp/reviews/2026-11-05T01-35-49-338Z-worktree-e859ad978b17-684a87f90529/`.

After remediation **142 affected tests passed**, zero failures/skips, and the
original probe still dispatches fresh inspection immediately. There are now
18 new scheduling regressions. Evidence:
`.pi/tmp/workers/2026-11-05T01-48-40-090Z-host-delivery-remediated-affected-ad6e4803fddb/command.log`.
Final `nix run --option builders '' .#verify` passed all 12 canonical gates:
**829 managed / 135 unit / 98 bridge tests**, zero failures/skips. Actual relay
and bridge packages built successfully with `nix build --option builders ''
--no-link .#managed-session-relay .#bridge-chat`. LSP was clean. Final evidence:
`.pi/tmp/workers/2026-11-05T01-50-34-574Z-host-account-scheduling-final-gates-2e086b833199/command.log`.
Only evidence/status prose changed afterward. No deployment or live acceptance
is implied; the remaining epic stages are still open.
