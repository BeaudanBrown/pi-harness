# Account scheduling diagnosis and proposed refactor

Status: operator-approved implementation plan, tracked by epic #153 and children
#154–157. Publication, deployment and live effects remain separately gated.
Separate from #152's implemented, unpublished repair wait correction.

## Evidence

The live Grill journal contained 50 completed `room.ensure` records, three pending
unverified ensures, 12 pending unverified retirements, four inspection requests,
and two expired repair requests now rejected as conflict. These are protocol
records, not queued model prompts. NAS SQL inspection was blocked by its expected
exclusive lock; no NAS queue-size claim can be made from that observation.

A disposable probe drives the real compiled `HostAccountClient`, private temporary
journal, fake clock and zero-latency transport. Fifty synthetic completed ensures
are seeded; one new inspection is deliberately chosen to sort after them. Calling
production `flush()` at the owner's three-second minimum cadence produces:

```
completedEnsureResendsBeforeFreshProbe: 50
freshProbeWaitMs: 150000
networkLatencyMs: 0
```

The assertion that a fresh probe dispatches within 30 seconds fails. Reproduction:
`NODE_PATH="$PWD/.pi-types/node_modules:/nix/store/z36x5vdiqkk6cd0z1w9g4iqc99mr7d4a-pi-managed-session-relay-0.1.0/lib/node_modules" node .pi/tmp/account-scheduling-probe.cjs`
after compiling `tsconfig.test.json` to `.pi/tmp/repair-tests`. The script is a
local diagnostic artifact, not a committed production tool or live-state writer.
This is a deterministic unfavorable placement, not measured average latency.

## Diagnosis

1. `HostAccountClient.flush()` selects one record in request-ID round-robin order.
   Completed ensures and inspections remain eligible every 30 seconds. There is
   no distinction between fresh work, progress on approved work, failure retries
   and background health/departure reconciliation.
2. `HostAccountOwner.start()` runs provisioning, departure handling and one send,
   then unconditionally sleeps three seconds. New requests/acks do not wake it.
   Fifty sends alone consume 150 seconds, before HTTP or provisioning costs.
3. Pending `unverified` work has no outcome-specific retry backoff. It keeps
   competing without proof that the underlying external obligation changed.
4. `freshAck()` accepts only acknowledgements younger than 120 seconds. The sender
   alone can exceed this horizon, so background rotation is not a dependable
   freshness mechanism for an interactive preview.
5. NAS independently selects pending requests by attempt order and processes one
   per worker turn, followed by acknowledgement flushing and a one-second sleep.
   Failed steps can consume the five-second worker timeout; acknowledgements can
   incur a further timeout. Acks should not wait behind a new slow effect. Host
   repair has multiple dependent stages, so delays can compound. These are code
   risks, not a measured decomposition of the live NAS latency.

#152 prevents an unrelated 30-poll cutoff. It does not address this contention or
guarantee that an entire exchange fits within the original five-minute approval.

## Proposed module and seam

Deepen the existing host account delivery module rather than add a queue manager.
Callers durably submit semantic intent and consume evidence; they must not know
flush cadence, retry timing, batch sizes or queue order. Internally centralize
selection, due times, wakeups and retry outcomes in one account-delivery scheduler.
A small interface is `enqueue/observe`, lifecycle `start/close`, and sanitized
`diagnostics`; existing compatibility methods can delegate during migration.
The production Matrix transport and a deterministic delayed/failing test adapter
cross the same seam. Registry/account authority remains with existing owners.
Do not force host JSON storage and NAS SQLite into one generic persistence layer.

## Work packages

1. **Instrument and lock down the failure.** Convert the disposable probe into a
   maintained regression through the delivery interface. Add backlog shape tests
   and read-only diagnostics: due/parked/in-flight counts by class, oldest wait,
   next retry, first/last attempt and ack timings, and reason for ineligibility.
   Never report credentials, message bodies, paths, process IDs or raw payloads.
   NAS diagnostics must be produced by its owning process, not external SQL reads
   or stopping the worker. Poll/transport samples distinguish cause from estimate.
2. **Separate scheduling purposes.** Distinguish negative-authority transmission,
   bounded interactive repair/inspection, ordinary new setup/cleanup and periodic
   reconciliation. Apply cancellation/retirement fences locally immediately; no
   scheduling class is authority to perform an effect. Preserve dependencies and
   exact frozen scopes. Use weighted fairness with aging and earliest-expiry
   selection within live repair work; sustained urgent traffic must not starve
   ordinary work or maintenance. Persist enough retry/due-time hints to avoid a
   restart storm; hints never create/revive authority.
3. **Replace fixed polling with a wakeable bounded pump.** Wake after durable new
   intent or accepted evidence, and sleep only until next due work. Drain a small
   bounded batch with a time budget, yielding to intake. Initially retain serial
   effects/per-room ordering: fix artificial idle gaps before adding concurrency.
   Keep uncertain-write poison, existing transaction IDs and retry idempotency.
   Separate periodic inventory reconciliation from dispatch so provisioning is
   not a mandatory cost before every send. Fence known terminal authority before
   every dispatch regardless of that reconciliation cadence.
4. **Stop treating maintenance as fresh work.** Keep completed records for audit;
   do not delete them or silently abandon cleanup. Refresh completed setup evidence
   on a bounded, jittered maintenance schedule with reserved capacity. Preserve
   departure/retirement detection via sync and reconciliation. Explicit previews
   request/coalesce fresh read-only inspections on demand; stale evidence remains
   blocking until fresh evidence arrives. Back off repeated unverified/network
   failures, honor rate limits, and reawaken on relevant evidence changes. Merely
   seeing a record again in periodic `requestMany` must not reset its retry clock.
5. **Align NAS work and acknowledgement scheduling.** Flush durable acks without
   waiting for the next potentially slow effect; wake on admitted request batches.
   Use bounded work and per-request backoff instead of retrying unchanged external
   obligations every rotation. Keep independent sync intake, transactional cursor
   handling and negative-authority precedence. No blanket parallel joins/invites,
   no automatic recreation of host repair continuations after restart.
6. **Verify, review, publish separately.** Real JSON/SQLite owners with fake clock
   and Matrix transport, then affected suites, paired Standards/Spec review,
   canonical gate and actual packages. Coordinate protocol/metadata versioning
   and rollout before publication. Operator rebuild and per-target repair approval
   remain independent; existing expired attempts are not revived.

## Acceptance and crash matrix

| Case | Required evidence |
| --- | --- |
| 50 completed ensures plus fresh repair/inspection | fresh intent dispatched within a bounded small number of scheduler turns, not after 50 maintenance sends; proposed zero-latency target <=5 simulated seconds |
| 3 unverified ensures + 12 unverified retirements | bounded retries, increasing due times, preserved terminal authority and no starvation |
| sustained interactive arrivals | maintenance and ordinary setup/cleanup get documented reserved service |
| complete original-room repair | actual durable host/NAS owners; delayed/out-of-order/lost replies and load; no expiry extension |
| lost send response | same persisted Matrix transaction reused; no duplicate semantic effect |
| crash after enqueue/before send | pending authorized work recoverable, bounded restart rate |
| crash after ack before scheduling wake | durable ack reloaded; scheduling rederived, no successful-progress loss |
| repair expiry/restart/supersession | no new host continuation or scope expansion; existing original authority never extended |
| retirement while queued or awaiting HTTP | terminal fences win; no resurrected room/identity |
| poison/clock rollback/unknown metadata | fail closed; no retry storm, no fabricated freshness |

Targets are deterministic service guarantees under specified fake transport load,
not promises about arbitrary homeserver outage or network latency. Numerical
budgets, backoff caps and maximum maintenance freshness must be fixed in tests
before implementation; never lengthen evidence TTL simply to make latency pass.

## Alternatives rejected

- Only increase the repair timeout: mitigates a symptom; old maintenance still
  consumes the same capacity.
- Send everything concurrently: risks rate limits, duplicated effects and broken
  ordering without first addressing the avoidable idle delay.
- Delete stuck/completed records: loses audit/cleanup obligations and can weaken
  departure/retirement reconciliation.
- Add another broker, daemon or durable authority store: duplicates existing
  ownership instead of improving locality inside the current account modules.
