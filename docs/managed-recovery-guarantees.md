# Recovery guarantees (#158)

> Historical diagnostic record. The runtime and commands below were removed by
> #170; they are not current operating instructions or activation permission.
> Replacement tests do not establish that the deployed incident is repaired.
> See [historical context](legacy-managed-history.md) and the approved migration runbook.

Status: harness implementation verified; **fleet activation pending**. This is an
explicit, consent-gated recovery path, not automatic resurrection of uncertain
processes. See deployment prerequisites below.

The guarantee is recoverability once the host and durable storage are available,
not uninterrupted execution. No attachment is not proof of process exit. A failed
resume must not create a replacement conversation or replay uncertain work.

## Acceptance and evidence matrix

| Requirement | Owner/change | Evidence |
| --- | --- | --- |
| Recovery does not require Matrix/NAS | Explicit runtime-only repair preview, same consent/fencing/hold owner | Offline account tests; public schema/frontend tests |
| Recovery does not require live tmux | Read-only absent-server observation, never treat arbitrary command failure as absence | Disposable-socket and malformed/permission negative tests |
| Unknown launch is actionable | Stable error category and original failure retained | Failed-create/retry lifecycle tests |
| No duplicate writer or silent replay | Existing frozen runtime repair and held queue invariants remain mandatory | Concurrent/stale preview, reboot/reload and queued-input tests |
| Initial server crash is addressed | nix-dotfiles tmux configuration workaround; preserve existing work | Host coredumps show session_previous_session; disposable cleanup regression |
| Harness release readiness | Cumulative Standards/Spec review, canonical gate and production builds | Passed; dispositions below |
| Deployment scope | Managed hosts grill and nas; tmux workaround on configured clients | Both enable managedSessions in nix-dotfiles; input pin and activation pending |

## Crash boundaries

| Boundary | Durable authority | Recovery behavior |
| --- | --- | --- |
| Before window creation | Reserved launch ID, observed=false | Never blindly relaunch; inspect or approved runtime repair |
| Window created, acknowledgement lost | Same reservation and actual process evidence | Adopt only exact matching ownership; otherwise explicit closure evidence |
| tmux exits/crashes | Saved window proof, session, queued work | Inspect processes independently of server availability; absence alone is not closure |
| Repair admission written | Frozen receipt and work hold | Interrupted repair retains hold; fresh preview/consent, never replay approval |
| Runtime reconciled before completion | Runtime receipt and fenced old nonce | Retry reads receipt; preserved work remains held |
| Network unavailable | Local control socket and host-owned state | Runtime-only repair makes no account claims or membership mutations |

Existing nix-dotfiles changes are external work, not permission to reset live
services or edit their working tree. Rebuilding alone is not evidence that an
already-running tmux server loaded new configuration. No live reset, push or
activation is performed as part of development.

## Operator recovery

Use `pi-managed-session host status --json` and require the
`runtime-only-repair-v1` capability. Discover the exact conversation ID with
`conversation list`. From a local terminal:

```sh
pi-managed-session conversation repair preview <conversation-id> --runtime-only --json
pi-managed-session conversation repair apply --preview-id <returned-preview-id> --confirmed --operator-closed --json
pi-managed-session conversation repair inspect <conversation-id> --json
pi-managed-session conversation resume <conversation-id> --json
```

Only assert `--operator-closed` after actually closing the old process. Omit it
when verified exit evidence makes it unnecessary. Add
`--accept-incomplete-inspection` only if the preview discloses unreadable
processes and the operator accepts that uncertainty. A known process conflict
cannot be waived. Repair does not stop processes or restart tmux. If safe process
closure cannot otherwise be established, an explicitly operator-controlled host
reboot is a closure boundary; obtain a fresh preview afterward, never reuse stale
consent. Resume is new intent after repair completion, not replay of held work.

Without `--runtime-only`, original-room/account repair retains its existing
provenance and NAS checks. Runtime-only completion does not mean Matrix access
has been restored. Local retirement/archive authority still wins.

## Evidence and review

- Focused TypeScript build and recovery/lifecycle/frontend/observer suites:
  82 tests passed before final frontend additions and remediation.
- `python3 tests/test_managed_legacy_observe.py`: initial 18 tests passed;
  permission-denied coverage added during review and included in the final gate.
- `nix run .#verify`: passed all deterministic checks, including managed-session,
  module/package contracts and real-Pi integration coverage already in the suite.
  The new failed-relaunch/recovery test uses the real registry/lifecycle owner
  with a fake launcher; it is not a live-fleet fault-injection test.
- `nix build .#default .#managed-session-relay --no-link --print-out-paths`: passed.
- External existing `check-session-cleanup.py` with raw tmux 3.7b: passed with
  `detach-on-destroy off`, preserving server, destination pane and client on an
  isolated disposable socket. No external source was changed.
- Standards review: no findings. Spec review: original-failure retention through
  repair and missing permission-denied test fixed. External crash workaround /
  downstream pin and activation remain deployment-owned prerequisites.

## Rebuild and activation prerequisites

1. Rebuild **grill and nas**, the two configured managed-session hosts. NAS needs
   its host relay/launcher updated; this change does not require a new NAS account
   protocol or bridge migration. Other machines do not need the managed-recovery
   update unless they also enable managedSessions.
2. Make nix-dotfiles consume this harness revision (or explicitly use this local
   checkout as its pi-harness input). The existing GitHub pin will not acquire an
   unpushed local commit. Do not overwrite unrelated working-tree changes there.
3. Include the existing nix-dotfiles `detach-on-destroy off` fix. A rebuild alone
   does not establish that a pre-existing tmux server loaded the setting. Verify
   it or arrange an operator-approved restart/reboot after saving work. This repo
   does not silently change the live shared server.
4. Verify the new capability, then explicitly recover and resume affected
   conversations. No migration or deletion of their histories is required.

These package checks are not a downstream NixOS system build or live acceptance
on either host. Fresh canary close/resume and relay-restart checks after activation
remain required before claiming fleet readiness.

## Limits of this release

This fixes the observed failed-launch dead end and removes account/tmux-server
availability as prerequisites of local runtime repair. It does not promise
recovery from corrupt/missing saved history, unavailable storage, an actively
conflicting writer, exhausted repair audit capacity, or unresolved generation,
poll/artifact and other lifecycle obligations. Those still produce explicit
blockers; a universal destructive reset for those cases is not implemented.
No automatic replay, implicit fresh conversation, or unsafe reservation clearing
is substituted for that missing reset. Issue #158 remains open for the broader
recovery contract and fleet acceptance rather than claiming an unconditional
"always recoverable" system.
