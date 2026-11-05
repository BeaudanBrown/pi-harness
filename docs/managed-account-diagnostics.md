# Account scheduling diagnostics (#156)

Scope: read-only aggregate snapshots from existing host/NAS owners; host status
and NAS owning-process journal reporting; precise original-room repair blockers.
#157 owns cumulative release verification. No new live action, authority store,
external SQLite access, or change to repair/evidence deadlines.

## Acceptance-to-evidence matrix

| Requirement | Change | Executed evidence (passed) |
| --- | --- | --- |
| Due/parked/in-flight and retry/age | Bounded aggregate snapshots, per work class | Host scheduling and NAS scheduling tests: due/backoff/cooldown/in-flight, overdue age and unchanged journal/selection |
| Progress reasons without private data | Fixed enum/count fields only | Host/NAS sentinel tests omit room/user/request/payload/path data; read-model tests reject extra fields, invalid state/counts and oversized class arrays |
| Supported operator surfaces | Conditional host-status capability/field; periodic NAS worker-owned journal snapshot | Read-model old/new response round-trip, existing frontend/CLI tests, NAS periodic callback/in-flight/abort cleanup test |
| Precise repair blockers | Separate absent/stale, unsupported response, supported-but-unverified, terminal | Six missing/unsupported/unverified/stale/terminal-stale/ready cases; no invitations; existing cross-owner repair acceptance |
| Compatibility | Old responses accepted without optional diagnostics; new capability advertised only when owner supplies them | Read-model conditional capability test, old response parse, affected contract/frontend suites; compatibility caveat below |

Snapshots describe local scheduling metadata at the observation time, not NAS
connectivity, fresh remote membership, process exit or approval. Oldest overdue
age is time since the earliest eligible due time, not invented enqueue/queue age.
Progress reason counts may overlap state counts. Records remain preserved.

## Side-effect / interruption boundaries

- Snapshot functions do not select work, rotate cursors, persist hints, or enqueue
  inspections. They cannot authorize transmission or restart a continuation.
- In-flight bookkeeping is ephemeral and cleared in `finally`; restart cannot
  infer an effect result from it. Persisted retry/transaction authority is unchanged.
- NAS diagnostics run within its existing database owner. No second connection,
  database copy, unlocking, service interruption or raw payload logging.
- Missing/stale evidence stays blocked. Previously advertised capability is not
  current authority; terminal evidence never becomes permission to restore.

## Operator surfaces and compatibility

- `managed_host(operation="host.status")` returns optional `accountScheduling`
  only when the account owner is wired, alongside conditional
  `account-scheduling-diagnostics-v1`. No read triggers an inspection or retry.
- NAS emits `managed_account_schedule` at worker startup and every 60 seconds,
  sampled inside the owning process even during in-flight I/O. Read with normal
  service journal tooling, e.g. `journalctl -u pi-chat-transport.service
  --grep=managed_account_schedule --since '10 minutes ago'`. Absence is not a
  zero-work/readiness claim. The reporting timer stops when the worker drains.
- Five fixed classes report mutually exclusive due/parked/blocked/settled/in-flight
  counts. `settled` includes completed or rejected durable requests, not successful
  repair. Separate fixed progress counters can overlap those scheduling counts.
  Cooldown and next-retry durations are local hints; oldest due age is not network
  latency. Legacy missing timing is reported without inventing an enqueue age.
- New readers accept responses without the optional diagnostics. Old strict
  readers cannot be assumed to accept the new capability/field. Refresh host
  frontends with the relay before using this release; publication/rollout remain
  separately approved. NAS wire messages and durable schemas are unchanged here.

Eleven new regressions and **208 affected tests passed**, zero failures/skips,
including all bridge suites and affected frontend, CLI, contracts, scheduling,
read model, membership, orchestration, repair inspection and real cross-owner
acceptance. LSP clean. Evidence:
`.pi/tmp/workers/2026-11-05T05-09-14-486Z-account-diagnostics-affected-b7a2b68d6790/command.log`.
## Review disposition

### Standards

Two medium findings: current-issue loss of the `unsupported_encryption` progress
reason is fixed with a bounded `unsupportedEncryption` counter and host/NAS
regressions. Deployment-only old-reader incompatibility remains explicitly gated:
#157 now tracks coordinated frontend/relay upgrade validation before publication.
No mixed-version compatibility is claimed and no version negotiation is invented.

### Spec

One medium current-issue finding is fixed: the classes schema is now a fixed
five-position tuple, rejecting duplicate/missing classes as well as extras.
Producers already emitted that fixed order; regression assertions now pin it.

Both current-issue fixes were batched. Review:
`.pi/tmp/reviews/2026-11-05T05-10-34-173Z-worktree-5a342cd4d92e-46ea6dab148b/`.
Post-remediation **68 focused tests passed**, zero failures/skips:
`.pi/tmp/workers/2026-11-05T05-14-01-520Z-account-diagnostics-review-remediation-5e252cbe1755/command.log`.
Final `nix run --option builders '' .#verify` passed all 12 canonical gates:
**838 managed / 135 unit / 114 bridge tests**, zero failures/skips/cancellations.
Actual relay/bridge packages built with `nix build --option builders '' --no-link
.#managed-session-relay .#bridge-chat`. LSP and whitespace checks passed. Evidence:
`.pi/tmp/workers/2026-11-05T05-14-55-710Z-account-diagnostics-final-gates-08f28d4f6e6c/command.log`.
Only evidence prose changed afterward. No push, deployment or live acceptance
is implied.
