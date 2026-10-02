# Window-first open (#110)

Implementation boundary: the existing lifecycle/launcher owns launch and exact
window validation. The existing local-human socket/CLI exposes open/resume under
immutable host policy; model mutations still require approval. Opening does not
switch a remote tmux client. Remaining approved frontend composition (#113), picker interaction (#118/#119), deployment and live acceptance
(#121) remain separate. No automatic failed-pane replacement or mutation replay.

## Acceptance → evidence plan

| Acceptance | Implementation / focused evidence |
| --- | --- |
| Open at window creation; resume at attachment | One launch with separate window/ready promises; slow attachment and concurrent callers |
| Existing active target without restart | Revalidate saved exact proof; disappeared/reused target tests |
| Continue observation after caller leaves | Relay-owned bounded readiness promise; timeout persists error and retains window |
| Manual retry only | Existing retained-dead-pane and lost-create-response tests |
| Conflicting operations and retirement | Hold workspace admission until readiness settles; stop/refresh conflict and retirement race tests |
| Protected coordinator | Dedicated ensure/bootstrap with original session; exact target validation |
| Local outage | Existing typed control-client unavailable tests; no alternate launcher fallback |

## Crash boundaries

| Boundary | Durable authority / retry |
| --- | --- |
| Before launcher invocation | Existing persisted launch identity and nonce; uncertain invocation is not replayed |
| Window created before open response | Persist exact proof before publishing window; revalidate on each open |
| Open response before attachment | Relay continues bounded observation independent of caller; timeout preserves proof and error |
| Retirement during launch | Permanent tombstone rejects stale persistence/admission; never return a retired target |
| Caller retry / relay restart | Reuse verified existing window; fail closed on unknown ownership or unresolved creation |

## Affected verification

- Project fixtures pass concurrent open/resume/start, delayed successful attachment,
  timeout persistence, retained panes, lost creation response, conflict and retirement
  races, target disappearance/reuse, and open over Unix IPC with caller disconnect.
- Coordinator fixtures prove protected default placement, original session-file
  preservation, matching proof reuse without nonce rotation, and bounded resume.
- Packaged managed-session/source gates passed (430 tests, zero skips), including
  real Pi through Unix IPC and disposable tmux with a fake launcher ABI. The
  project trace now asserts exactly one initial window, without a shell placeholder.
- Complete Go launcher suite passed, including actual exact coordinator/project
  creation and guarded kernel stopping in disposable tmux. An existing respawn
  fixture was made deterministic: it now waits for its intended original-exited
  boundary instead of assuming tmux's respawn acknowledgement implies reaping.
- Evidence: `.pi/tmp/workers/2026-10-02T06-06-18-260Z-window-first-affected-verified-eb81f70e2484/`.

This is not picker UI, live phone acceptance, a production launch, deployment,
or nix-dotfiles Nix evaluation/build. Final review/canonical evidence follows.
