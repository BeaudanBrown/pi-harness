# Probe replies under replay pressure (#132)

## Reproduced failure and scope

The deployed diagnostics reported `unsolicited_handler_failed`, often with
`input.deliver` as the last received type. That is not necessarily the callback
that failed: parsing can advance while an earlier callback awaits a reply.

A local real-socket reproduction now confirms a concrete defect: the relay
serializes ordinary requests, so a slow acknowledgement (disk or Matrix work)
can hold a later `recovery.confirm` or `host.run.confirm` behind it. Probe reply
requests use a shorter timeout than durable operations. Previously, their timeout
escaped the unsolicited callback, destroyed the entire connection, and interrupted
otherwise viable durable work. Reconnection can repeat that sequence.

Both recovery-check and host-run-check repros failed before the fix. This is a
confirmed local defect consistent with the observed outage, not yet proof of the
specific deployed callback. Do not declare the live reconnect loop or missing
reply repaired until live acceptance passes.

## Fix

Only `confirmRecovery` and `confirmHostRun` treat typed `timeout` or
`capacity_reached` errors as an unavailable probe reply. They do not retry,
extend a deadline, clear pending durable requests, launch a model, replay input,
or change attachment admission. The relay's probe owner still controls freshness
and absence of evidence. A reply might already have reached the relay before its
acknowledgement times out; swallowing that timeout grants no additional evidence
or authority. Later fresh probes remain normal, independent requests.

All other errors propagate unchanged. Ordinary RPCs, approval answers and
mutations retain their existing error/uncertainty behavior. Existing expired
request correlations still admit matching late replies and reject mismatches;
their bounded capacity is unchanged.

Diagnostic records now also include the **failed** callback's validated message
type and a fixed category (`timeout`, `capacity_reached`, `other`) when a handler
failure closes a connection. They never include raw error text or bodies.

## Acceptance and interruption evidence

| Criterion / boundary | Evidence |
| --- | --- |
| Short probe timeout cannot tear down queued replay | Real IPC tests block an acknowledgement, expire the probe, then drain both replies on the same attachment |
| Pending request capacity cannot tear down connection | Same tests fill all 256 pending slots; probe is not sent or retried |
| Queue and ownership preserved | Exact attachment ID and queued input snapshots unchanged; replay request count unchanged |
| Lost/late probe acknowledgement | Matching late response is drained without reconnect; no resend of the expired probe |
| No weakened error handling | Non-transient probe errors and ordinary request errors still reject; existing malformed/wrong-correlation/conflicting-attachment tests remain |
| Diagnostic privacy and attribution | One frame batch contains a failing probe and a later input; diagnostics identify the probe without recording either body or exception text |
| Crash during pending work | No new durable writes or retries introduced; existing registry/native receipts remain authoritative |
| Packaging source closure | Compile the recipe-selected relay sources as well as the full repository; no substitute claim for a Nix derivation build |

## Deployment-only acceptance

Publication/pinning, builds, activation and process refresh remain separately
authorized. After deploying both endpoints, inspect attachment stability over
several former failure periods. Verify that preserved queued inputs progress
without duplicate execution and a fresh assistant reply reaches the same Matrix
room. Inspect the original missing reply's receipts before any resend; do not
replay it automatically. If closure persists, use `failedReceivedType` and
`failureCode` to distinguish an unrelated handler failure. Do not reset state,
kill competing numeric tmux IDs, or weaken ownership checks.
