# NAS account scheduling (#155)

Scope: the existing SQLite account store, worker and its production lifecycle.
#156 owns public diagnostics; #157 owns cumulative release verification. No new
broker, authority store, process, deployment or live repair continuation.

## Acceptance evidence

All rows were exercised by the 181-test broader affected command recorded below.

| Requirement | Implementation | Executed evidence (passed) |
| --- | --- | --- |
| Existing acks precede slow effects | Wakeable serial worker, up to eight due acks / one second before one effect; 25ms batch yield | New real-worker tests with 1/12 queued acks observe delivery before the blocked effect and reserve effect service; `main.ts` calls `run` and awaits it at shutdown |
| Fair bounded retries | Weighted control/interactive/ordinary/maintenance, oldest due first; 30s exponential retry capped at five minutes | New 50-record, sustained-arrival, duplicate-pending/reload and independent-recipient tests |
| Durable retry/idempotency | SQLite due/retry hints written before effect/send; exact outbox transaction retained | New lost-ack, clock-rollback, legacy-schema and before/after-commit fault tests; existing newer-progress/old-completion regression |
| Wake only after committed evidence | Intake wakes worker; changed invite/verification or new repair control expedites dependent pending work | New failed-batch, repeated-inspection and changed-join tests; existing admitted repair/authorize/confirm and cross-owner lost-join acceptance |
| Safety unchanged | Independent sync; original expiry, cancellation, terminal and join-attempt checks remain authority | Existing cancellation-before-repair, departure-during-I/O, expired-admission and uncertain-join/reload tests; all six real cross-owner incident tests |
| Rate limits | Persist transport cooldown; no scheduling metadata grants permission | New persisted 90-second 429/reload test blocks both acks and fresh work until due |

Timing values are scheduling policy, not expanded approval or evidence lifetimes.
A one-second safety tick rechecks expiry/departure protection; it is not permission
to retry parked HTTP work. Existing bounded five-second effect/send signals remain.
Acks get reserved service before each effect; work also receives service under a
continuous ack backlog. No concurrent account effects are introduced.

## Crash boundaries

| Boundary | Durable state / retry |
| --- | --- |
| Intake before cursor | Existing all-or-nothing transaction; wake only after commit; replay coalesces |
| Selection before effect | Persist due and attempt count first; crash backs off, does not invent success |
| Uncertain join | Existing membership-attempt fence remains, never blindly joins again |
| Ack commit before wake | Outbox survives restart and drains before another effect |
| Ack HTTP before delete | Same transaction/payload retained; newer progress cannot be removed by older completion |
| Restart or clock rollback | Persisted future retry remains parked; no resetting all requests to immediately due |
| Cancellation/retirement during HTTP | Existing intake and effect authority fences dominate scheduling hints |

## Evidence and compatibility

`tests/bridge-chat-account-scheduling.test.ts` adds 14 real-SQLite regressions:
50-record selection, sustained arrivals, oldest-due/weighted service, durable
backoff and rollback, lost acknowledgements with independent recipients,
ack-before-effect and bounded ack backlog, wake/abort, 429/reload, duplicate
inspection, changed join evidence, before/after-commit faults, atomic intake
failure and legacy migration. Existing fixtures now explicitly advance retry
clocks or provide the actual observed join event rather than assume immediate
polling. The cross-owner acceptance driver includes joined-state sync events.

Changed authenticated join observations are persisted only as scheduling hints:
they wake pending work once but neither verify a room nor permit a join. Intake
and its hint changes commit together before waking. Identical invites, repeated
pending inspections and duplicate control requests do not reset parked retries.
Within each weighted lane the oldest due time wins, with expiry as a tie-breaker.
Per-effect and per-ack attempt hints persist before network I/O. Acks retain exact
transactions across uncertainty and newer progress survives old completions.

The generation-fenced wake primitive from #154 moved unchanged to
`matrix-shared/delivery-wake.ts`, with a compatibility re-export for host callers.
NAS JSON wire messages and approval/evidence deadlines are unchanged. SQLite
adds optional-to-old-data scheduling columns and owner-local cooldown metadata;
legacy data migrates transactionally. **Downgrading the NAS binary after this
schema migration is not supported** (older positional outbox inserts do not
understand the added columns). No database copying/unlocking or live mutation
was used for verification.

Focused checks passed 49 tests; broader affected checks passed **181 tests**,
zero failures/skips/cancellations, including all bridge suites and affected host,
hierarchy, membership, orchestration and real cross-owner repair tests. Evidence:
`.pi/tmp/workers/2026-11-05T04-38-26-537Z-nas-scheduling-broader-affected-88f6c4f928e4/command.log`.
LSP clean. Paired review reported no Spec findings; Standards identified one low
current-issue evidence-matrix wording defect. The matrix above now names the
executed passing checks rather than planned evidence. No code remediation was
needed. Review:
`.pi/tmp/reviews/2026-11-05T04-39-47-257Z-worktree-d91b4f007cde-a86076f9ae1b/`.
Initial final verification was blocked: two unchanged-source canonical attempts each
passed 828/829 managed tests but failed a different variant of the existing
`recovery.check ... behind replay acknowledgements` IPC fixture with `Relay
request timed out`. That fixture configures a 50ms ordinary-request timeout and
is unchanged by #155. Its full file passed three focused runs (16 passes and the
expected local packaged-lock-helper skip each time). This suggests full-suite
load sensitivity, but does not establish the exact timeout phase or justify
ignoring the gate. No tests or runtime deadlines have been loosened.

Logs:
- `.pi/tmp/workers/2026-11-05T04-42-07-409Z-nas-account-scheduling-final-gates-9d4dc9fac6c8/command.log`
- `.pi/tmp/workers/2026-11-05T04-44-52-031Z-nas-final-gate-ipc-timeout-diagnosis-3b8b224aa388/command.log`
- `.pi/tmp/workers/2026-11-05T04-45-36-838Z-nas-account-scheduling-final-gates-confirmation-a0224f291d7e/command.log`

The operator approved test-only diagnosis/stabilization. Injecting a retained
100ms wall-clock delay into the ordinary `self.status` response reproduced all
four variants deterministically at the explicit status assertion, after replay
had passed. This isolates an overly broad 50ms fixture deadline; it does not
identify which ordinary roundtrip timed out in the earlier uninstrumented runs.
The fixture now controls its protocol clock and advances 50ms only for the
intentionally expired probe. The real delayed status response remains as
regression coverage. All existing queue/attachment/late-reply assertions remain;
no runtime code or deadlines changed. The original test's real-time 20ms sleep
is unnecessary and removed.

Red evidence (four failures at ordinary status):
`.pi/tmp/workers/2026-11-05T04-50-40-204Z-nas-ipc-load-regression-red-eea17babf874/command.log`.
Green full IPC file (16 passes, expected local packaged-lock-helper skip):
`.pi/tmp/workers/2026-11-05T04-51-17-311Z-nas-ipc-load-regression-green-1858cdf587a8/command.log`.
This isolated test-only correction does not change the reviewed NAS design;
no subjective re-review was needed.

Final `nix run --option builders '' .#verify` passed all 12 gates: **829 managed /
135 unit / 112 bridge tests**, zero failures/skips/cancellations, including the
packaged IPC helper test omitted from the local focused run. Explicit production
builds passed with `nix build --option builders '' --no-link
.#managed-session-relay .#bridge-chat`. LSP and diff whitespace checks passed.
Final evidence:
`.pi/tmp/workers/2026-11-05T04-52-26-557Z-nas-scheduling-stabilized-final-gates-0d74baa07c00/command.log`.
Only evidence prose changed afterward. No push, deployment or live repair has
occurred. Public diagnostics (#156) and cumulative release verification (#157)
remain separate.
