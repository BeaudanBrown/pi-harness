# Historical managed-runtime evidence

The managed platform is removed from source/packages by #170, not repaired or
converted in place. [ADR 0002](architecture/decisions/0002-managed-session-contracts.md)
is historical; [ADR 0003](architecture/decisions/0003-matrix-pi-bridge.md) governs
the native replacement. Grill/NAS are **not rebuild-ready** pending #171's
publication/pin handoff and separately approved #172 cutover.

## Preserved diagnostic records

- [Initial real-Matrix bootstrap failure](managed-live-workspaces-live-smoke.md)
  and [production baseline compatibility](managed-production-upgrade-evidence.md).
- [Room-v12 live diagnosis](managed-matrix-v12-recovery.md).
- [Relay performance measurements](managed-relay-performance-plan.md): roughly
  91% of one CPU, 48 registry replacements in ten seconds and six churning
  adapters. Isolated replacement tests are not a live repair receipt.
- [Account scheduling diagnosis](managed-account-scheduling-proposal.md) and
  [release/incident boundary](managed-account-scheduling-release.md): deterministic
  scheduling checks did not establish NAS availability or original-room access.
- [Recovery guarantees / tmux incident](managed-recovery-guarantees.md), #158:
  `session_previous_session` crash evidence and the downstream
  `detach-on-destroy off` workaround remain relevant. Actual deployed
  `window-create-exact` / `window-inspect-exact` failures remain unproven.
- [Attention delivery incident/design](managed-attention-delivery.md), #159:
  repeated outage notices were not fixed by deploying this replacement.

A later read-only investigation found seven unresolved launch admissions and
six unreadable process observations. Absence of attachment or a failed tmux
inspection did not prove process exit. No live registry reset, queue replay,
account repair, cancellation or history replacement was performed. The earlier
NAS refusal remains unresolved: “NAS repair support is unconfirmed. Wait for the
read-only account inspection, check connectivity or upgrade NAS, then obtain a
fresh preview.”

## Removed documentation and recovery limits

48 feature-specific old runbooks/plans/evidence documents were deleted with the
coordinator, control catalogue, repair, permanent retirement/cleanup, generation,
auto-refresh and account platform. Their historical contents and the removed
source/tests remain recoverable from Git baseline
`67ceb087805e3e24b6cf13adffc86e5e7f23c928`, for example:

```sh
git show 67ceb087805e3e24b6cf13adffc86e5e7f23c928:docs/managed-matrix-sessions.md
```

The linked baseline may remain unpublished until separately approved. Local Git
and the preserved recovery backup are authoritative; no publication is implied.
Historical command examples describe those old packages, not today's tools.
Do not run them as a replacement migration procedure.

Preserve real stores, native histories, rooms, uncertain receipts, installed old
closures and backups. Only [offline migration](matrix-pi-migration.md) accepts
independently coherent kernel-read-only snapshots into a distinct destination.
It does not grant old account, terminal, approval or artifact execution authority.
An approved pre-start rollback is not permission to restore stale queues after
new native work or the first runtime writer has crossed that boundary.
