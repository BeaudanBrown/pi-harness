# Restart-safe managed-session updates (#93)

## Acceptance and evidence plan

| Acceptance | Implementation | Evidence |
| --- | --- | --- |
| Relay replacement cannot terminate tmux | Host-owned independent shared server; guarded rollout | Disposable systemd/tmux lifecycle probe and evaluated units |
| Interrupted activation cannot strand relay between stop/start | Atomic restart job; activation independent of terminal | Unit and activation command checks |
| Unsafe initial migration preserves sessions | Check server cgroup before any relay stop | Foreign-server rejection probe |
| Compatible adapters survive relay replacement | Existing reconnect/nonce/receipt protocol retained | Production relay/adapter reconnect tests |
| Old session runtime survives GC | Per-process indirect GC roots with lifetime cleanup | Runtime-pin tests |
| Health distinguishes offline from stale healthy observation | Process/socket checks plus fresh sync report | Sync-health tests |
| Protocol compatibility is explicit | Supported baseline, strict unknown-version rejection | Contract tests; compatibility policy below |

## Ownership and update contract

The host owns tmux and activation. The consuming host has restored its original
`nr` (`nh os switch`); the detached activation evidence below describes the #93
implementation, not a current `nr` guarantee. The harness owns relay shutdown, IPC,
reconciliation, and Pi launchers. No new general session manager is introduced.
A host supplies a pre-update guard; a failed guard never stops the old relay.
NixOS does not directly stop/start the relay during switches: a separate
oneshot rollout submits a single restart job after checking the guard. There is
no timer that restarts intentionally stopped units.

A compatible update preserves tmux and Pi PIDs. Existing Pi processes retain
their loaded adapter and runtime; new launches resolve the installed dispatcher.
Refresh remains idle-only. The later [runtime-update amendment](managed-input-runtime-updates.md)
automatically refreshes changed managed project launchers after live idle consent;
manual refresh remains available. Unknown live activity is not permission
to replace a process. Reboot, deliberate server shutdown, and an approved
incompatible upgrade are maintenance, not transparent updates.

## Compatibility policy

The `ae957fa` adapter and this release are the supported initial rolling-update
baseline. No protocol or durable-state shape changes are needed for lifetime
separation. Future changes must retain that wire subset or explicitly declare a
maintenance upgrade; strict parsers must not be relaxed to accept unknown
versions. Persistent schema compatibility is separate from executable revision.
The existing V2 migration remains a separate, explicit breaking operation;
automatic state downgrade is prohibited. Compatibility with arbitrarily old
adapters is not promised.

## Crash-boundary matrix

| Boundary | Before/effect | Recovery |
| --- | --- | --- |
| Rollout guard | Old relay still running; inspect existing server | Failure leaves old relay untouched, rollout reports failure |
| Relay restart request | systemd owns one restart job | Caller death cannot split stop and start |
| IPC disconnect | Durable registry and Pi history retained | Existing adapter reattaches with nonce; no second writer |
| Matrix acceptance | Persist input before cursor | Stable event/delivery IDs deduplicate replay |
| Output publication | Stable transaction before receipt | Retry same transaction; never guess tool completion |
| Activation terminal loss | systemd owns activation process | Journal/result remain independently observable |
| Runtime pin creation | Root before starting runtime | Refuse launch if rooting fails; stale roots prefer retention over loss |

## Verification evidence

- Focused `managed-session-tests` and `module-contracts`: passed, including
  IPC availability before Matrix authentication, bounded startup retry,
  existing relay/adapter recovery suites, and runtime-root lifetime/failure tests.
- Grill full-system derivation evaluation with the local harness override:
  passed; no host system build or activation was performed.
- Disposable systemd/tmux probe runs the production `relay-rollout.sh` through
  a oneshot rollout, destroys the invoking pane after submission, and verifies
  successful replacement with unchanged server/work-pane PIDs. Legacy ownership
  is rejected without killing the foreign server. Passed.
- Real Nix indirect-root probe around an existing immutable Bash child: root
  present during execution, removed after exit. Passed; no garbage collection
  or production process interruption was performed.
- Standards/Spec review: no standards findings; one medium current-issue finding
  requested caller-death integration evidence. Addressed by the production-script
  disposable probe above. Full live NixOS activation remains deployment-only.

## Deployment-only acceptance

Do not switch the live host as part of implementation. Inspect the shared tmux
server's cgroup before first activation. An old server cannot safely be adopted
by pretending its PID belongs to a new unit. If it is not independently owned,
finish current work and explicitly close the old server in a maintenance window.
The rollout guard reports this condition and does not kill it. After migration,
exercise a compatible update from inside tmux and verify unchanged server/Pi
PIDs, relay recovery, and a new Matrix delivery. Nix evaluation alone is not
live deployment evidence.
