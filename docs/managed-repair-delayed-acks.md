# Delayed repair acknowledgements (#152)

## Scope and acceptance

Live evidence: two separately approved repairs stopped at `account_pending` with
no continuation. NAS subsequently acknowledged both as `pending / admitted`.
The correct NAS package was active, with no reported transport errors/restarts.
This does not establish the cause of every transport delay.

Current issue owns the premature live-invocation cutoff, not queue redesign.
Publication, activation and live repair retries require separate approval.

| Acceptance | Evidence |
| --- | --- |
| Acknowledgement after 30 polls can complete within frozen expiry | deterministic mocked-clock production-owner regression |
| Original five-minute deadline remains authoritative | pending acknowledgement at expiry; no further account calls |
| Shutdown does not recreate continuation | close while polling; existing restart/supersession tests |
| No implicit work replay or process launch | durable queue holds and existing orchestration/acceptance tests |

## Crash boundaries

| Boundary | Preserved authority / recovery |
| --- | --- |
| Admission before delayed reply | original receipt and item holds; only current live invocation polls |
| Late reply before original expiry | same operation and expiry; all current/source/terminal checks retained |
| Expiry or close while polling | stop at the next await boundary; sleeps are capped at remaining lifetime; retain receipt/holds and require fresh preview/consent |
| Restart or supersession | no startup replay; old invocation cannot advance new operation |

## Focused evidence and review

The mocked-clock delayed-reply regression failed before the change with actual
`account_pending` versus expected `complete` after 35 polls. The subsequent
production-owner affected suites passed 87 tests, zero failures/skips:
`tsc --project tsconfig.test.json --outDir .pi/tmp/repair-tests`, then Node tests
for conversation-repair, repair-acceptance, membership-repair, runtime-repair and
bridge-chat-account using the repository test dependency environment.
Logs: `.pi/tmp/workers/2026-11-05T00-58-09-203Z-repair-delayed-ack-red-e5786a2ea7af/command.log`
and `.pi/tmp/workers/2026-11-05T00-58-58-831Z-repair-delayed-ack-affected-c8991a7607e9/command.log`.

Paired review: Standards requested actual evidence here (accepted). Spec requested
expiry-bounded sleep (accepted, with an additional just-before-expiry regression)
and cancellation of an unresolved restore promise (justified deferral). Production
`HostAccountOwner` already bounds each Matrix call with its owner shutdown signal
and a ten-second timeout. This change does not detach an in-flight side effect or
claim remote cancellation; it rechecks authority immediately after that await.
A permanently unresolved fake is not the production HTTP port. Propagating a new
per-invocation cancellation API across account ownership is outside this narrow
poll-budget correction. Already issued requests retain their original bounded
uncertainty. No expiry is extended, and no new step begins after expiry/close.

After remediation, all 29 orchestration tests passed, including the new exact
expiry boundary. Final `nix run --option builders '' .#verify` passed all 12 gates:
811 managed / 135 unit / 98 bridge tests, zero failures/skips. Actual relay and
bridge packages built with `nix build --option builders '' --no-link
.#managed-session-relay .#bridge-chat`. LSP was clean. Final gate evidence:
`.pi/tmp/workers/2026-11-05T01-03-13-839Z-repair-delayed-ack-final-gates-9f8b8daffacc/command.log`.
Only evidence prose changed after that gate.

No production state edits, service restarts or live retry. This fixes the proven
premature cutoff, not an assurance that every multi-stage account exchange will
finish within five minutes. Original expired attempts still require fresh consent.
