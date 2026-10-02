# Window-first open (#110)

Implementation boundary: the existing lifecycle/launcher owns launch and exact
window validation. Opening does not switch a remote tmux client. Approved frontend
composition (#113), picker interaction (#118/#119), deployment and live acceptance
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

Results will be recorded after focused and canonical checks. No live acceptance
or deployment is authorized by this issue.
