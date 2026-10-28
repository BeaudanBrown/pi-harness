# Offline activity finalization recovery (#120 / #121)

## Report and scope

After rebuilding GRILL to the reconnect-warning release, the operator reported
that a Matrix input reached Pi but its answer never returned, with repeated
`managed-session envelope: /type: must be equal to constant` errors.
Read-only checks showed the relay running without restarts. This conversation's
Pi process still loaded its retained older adapter. No host build, restart,
production-state mutation, packet capture or live-heap inspection was performed.
The exact production in-memory payload was not captured.

## Reproduction and diagnosis

An isolated test using the real adapter/client/projector and a fake Unix relay
reproduced the exact error and absence of final/answer frames: disconnect the
relay, start and finish a turn offline, then reconnect. The initial probe used
the previously verified compiled release, not a modified production runtime:

```
NODE_PATH="$PWD/.pi-types/node_modules:/nix/store/wgmb5sb99myggs6d3727nlmpi3ad7mmm-pi-matrix-markdown-1.0.0/lib/node_modules" \
  node --test --test-name-pattern='offline-only activity' .pi/tmp/offline-final-probe.cjs
```

Red artifact:
`.pi/tmp/workers/2026-10-27T23-57-51-567Z-offline-activity-reconnect-reproduction-df9219edbd6b/`.
One failed test; synthetic notice exactly matched the report and no activity
frames reached the relay. No fixture/dependency failure.

The span revision starts at -1. Ordinary updates first advance it to zero; finals
must have a positive revision. A fully offline turn sends no update, so the old
final freezer produced revision zero. Local envelope validation rejects that
payload before sending; the union's first error misleadingly names `/type`.
The frozen invalid closing record then blocks subsequent final answers and is
retried indefinitely. This concrete mechanism matches the outage history; it is
not a claim that production memory was inspected.

A protocol-version mismatch and malformed transcript text were alternative
possibilities. The reproducer uses one coherent release and synthetic ordinary
text; neither is needed to produce the failure.

## Change and acceptance

Clamp the first frozen final revision to at least one. Already-valid revisions
and immutable uncertain retries are unchanged; no protocol/schema relaxation,
identity reset, input replay, persisted-state repair, or notification suppression.

| Requirement | Evidence |
| --- | --- |
| Offline-only turn reconnects and completes | Real adapter/client/projector regression: final revision 1 and assistant answer offered |
| Later turns are not blocked | Same regression: second distinct turn final and answer both offered |
| Uncertain accepted final remains exact | Existing acceptance-before-ack disconnect regression |
| Closing retry backoff and refresh gating remain | Existing healthy-connection closing-feedback regression |
| Overlap/backlog isolation remains | Existing overlapping settlement, answer ordering and bounded backlog regressions |

Focused checks passed 6/6, zero skips:
`.pi/tmp/workers/2026-10-27T23-58-49-184Z-offline-finalization-focused-regressions-1477947e0024/`.
LSP diagnostics and whitespace checks passed. Actual focused command (the regex
identifies all six tests listed in the acceptance matrix):

```sh
build=$(nix build .#checks.x86_64-linux.typescript-build --option builders '' --option max-jobs 1 --no-link --print-out-paths)
NODE_PATH="$PWD/.pi-types/node_modules:/nix/store/wgmb5sb99myggs6d3727nlmpi3ad7mmm-pi-matrix-markdown-1.0.0/lib/node_modules" \
  node --test --test-name-pattern='completed offline|single-flight overlapping|identical final|closing feedback|new answer remains|closing backlog' "$build/build/tests/managed-session-adapter.test.js"
```

Paired review had no Spec findings; Standards requested a deterministic disconnect
barrier, complete crash-boundary fields and the actual verification command.
All were addressed: the regression now waits for the adapter's offline UI status
rather than sleeping. Reports:
`.pi/tmp/reviews/2026-10-27T23-59-58-781Z-worktree-1f8754bc4d87-bcafb1522ef3/`.

## Crash and concurrency boundaries

| Boundary / state before operation | Side effect and durable write / retry identity | Interruption and retry behavior | Evidence |
| --- | --- | --- | --- |
| Offline span: revision -1, no update sent | Freeze final at revision 1 in memory; send final to relay/projector; identity is activity ID + revision + exact frozen payload | Reconnect drains it; no invalid revision-zero record | `completed offline` regression |
| Final sent, ack not received | Projector persists final state and Matrix projection; adapter retains exact frozen retry identity | Lost ack retries same payload; no new span or counters | `identical final` regression |
| Old final awaiting ack; new run starts | Separate in-memory spans; each final precedes its own durable transcript projection | Old ack cannot consume newer span; pending answers remain ordered | `single-flight overlapping` and `new answer remains` regressions |
| Process exit with in-memory closing state | No durable adapter-final snapshot and no new persistence added; existing durable transcript/projection IDs remain authoritative | Cannot claim heap migration or recreate uncertain final payload; exact-session recovery must preserve durable ledgers | Source inspection and deployment-only boundary, not live recovery evidence |
| Relay replaced; old Pi still loaded | No code replacement in Pi; closing backlog prevents safe automatic refresh | Rebuild alone cannot clear its in-memory bug; explicit safe recovery needed | `closing feedback` refresh-busy regression and source guards |
| Relay rejects/retries while backlog grows | Frozen payloads remain distinct; bounded in-memory feedback does not stop model execution | Backoff retries without changing frozen finals, then drains | `closing feedback` and `closing backlog` regressions |

## Deployment boundary

A stuck closing record also causes automatic idle refresh to report busy.
Therefore do not promise this already-running session will automatically acquire
the fix. Recovery needs a separately agreed, exact-session stop/resume or restart
at a safe boundary, preserving its registered history and room identity. Do not
reset registries, replay input, mutate frozen records, or bulk restart sessions.
Publication/pin receipts are tracked in #120; deployment/runtime recovery must be
confirmed separately. #120/#121 remain open; no successful live recovery is
asserted here.

## Final verification

After review remediation, the six focused tests passed again with zero skips.
`nix run .#verify --option builders '' --option max-jobs 1 -L` passed all 12 gates,
including 626 managed tests (626 passed, zero failures/skips).
`nix build .#default .#managed-session-relay .#bridge-chat --option builders '' --option max-jobs 1 --no-link -L`
also passed. This is package verification, not a host build or activation.
Artifact:
`.pi/tmp/workers/2026-10-28T00-01-39-309Z-offline-finalization-final-verification-e9ee2ca5e94d/`.
All review findings addressed; no deferrals. Only evidence text changed after the
final gate.
