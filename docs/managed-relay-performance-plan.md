# Managed relay performance and reliability proposal

Status: proposed, not an implementation or deployment authorization. GitHub #132
is the investigation/evidence record; follow-up implementation issues should be
created from the approved scope, not tracked as a second task list here.

## Evidence collected 2026-10-29

Read-only process inspection found the same six conversations observed churning
still loading adapter source without `replyToProbe` (the #132 fix): IHP Roster
staging integration, ihp-roster development, nix-dotfiles development,
bepis-dotfiles development, tabpfn-test development and bookclubs development.
The other nine inspected ordinary Pi processes loaded the fix, including this
conversation. This checks actual process arguments and their immutable Nix
source paths, not merely the current system pin. It is a point-in-time inventory,
not proof that all nine fixed conversations are working end to end.

A previous 20-second observation saw 14 attachment changes across those six
conversations. The current conversation is stable and its operator confirms
Matrix replies arrive. Earlier missing-reply/activity warnings remain a separate
acceptance concern; absence of transport churn does not prove projection health.

A subsequent 10.02-second read-only sample measured:

- Relay PID 3345529: 91.3% of one CPU core.
- 48 observed registry inode replacements, sampled every 50 ms (a lower bound).
- 111.44 MiB of process write characters, including any non-registry writes.
- Registry approximately 2.42 MB, 34 conversations and 1,657 retained inputs.

An isolated process read the registry once into memory, then benchmarked existing
code without writing state or attaching a profiler to production. Twelve measured
iterations per operation after warm-up:

| Operation | Whole fleet mean CPU ms | One representative conversation mean CPU ms |
| --- | ---: | ---: |
| Structured clone | 13.35 | 0.50 |
| `parseHostRuntimeState` | 166.04 | 8.03 |
| Pretty JSON serialization | 15.59 | 0.45 |
| Clone + parse + serialization together | 172.11 | 9.02 |

Individual timings need not sum exactly because runs differ in allocation/GC and
scheduling. The one-conversation case is a scaling comparison, not a ready-made
storage implementation. These are local cost probes, **not a live flamegraph**;
they exclude fsync, registry operation logic and other relay work. At roughly
4.8 registry replacements/second, this path is sufficient to explain much of a
core's consumption, but attribution still needs verification after stabilization.

Benchmark artifact:
`.pi/tmp/workers/2026-10-29T16-11-10-481Z-relay-read-only-cost-probe-324ab99eb98e/`.
The ignored probe script reads live state into memory and prints only aggregate
metrics; it does not retain a copy of messages.

## Mechanism supported by source inspection

1. `adapter/extension.ts:replayAcknowledgements` resends every retained persisted,
   completed or cancelled native delivery marker on each reconnect.
2. `relay/registry.ts:acknowledgeInput` enters the global mutation queue even for
   identical acknowledgements. `mutate` clones the whole fleet for rollback and
   writes the whole registry after a successful operation.
3. `relay/atomic-json.ts:write` calls the full parser, serializes all conversations,
   writes a replacement file, fsyncs it, renames it and fsyncs its directory.
   `parseHostRuntimeState` also clones the fleet for legacy migration checks on
   every parse, including current-format writes.
4. `registry.snapshot()` clones the fleet; several callers use it merely to find
   one conversation/attachment. Polling and projection add further work.
5. Ordinary IPC handlers are awaited serially. Remote Matrix work can therefore
   delay unrelated short-lived replies on the same connection. The fixed adapter
   stops probe timeout/capacity errors from killing the connection, but it does
   not remove the underlying work or upgrade already-running old adapters.

This supports the feedback loop: old adapter reconnects -> receipt replay ->
whole-fleet persistence pressure -> delayed replies -> more old-adapter failures.
It does not establish the precise failing callback of each old process, or rule
out additional activity/projection bottlenecks.

## Proposed order

### 1. Stabilize and establish the baseline

- Preflight the six old processes individually: exact identity, active task,
  queued/persisted input, current native history, and refresh eligibility.
- With independent operator approval for each mutation, refresh eligible idle
  conversations onto the deployed fix. Busy/unsettled conversations wait for a
  safe point; do not force-stop them to make a performance chart look better.
- Do not kill by saved numeric tmux window IDs, clear registry entries, reset
  generations, cancel pending input, or automatically replay historical replies.
- Compare CPU, registry replacement rate, attachment churn and delivery latency
  before/after. Observe at least 15 minutes plus a controlled message/reply in
  each eligible conversation. Use new explicit test messages, not a resend of
  uncertain historical work.
- Expose loaded adapter build/fix status in inventory as advisory metadata, so a
  successful system rebuild cannot be mistaken for a completed process rollout.

### 2. Remove repeated work without changing storage format

First implementation slice, after a deterministic fleet-load fixture exists:

- Recognize an exactly identical acknowledgement **inside serialized ownership
  checks**, before rollback cloning/full persistence. Validate current generation,
  delivery identity, status, Pi entry ID and completion kind; mismatches and
  regressing states must still fail closed.
- Separate state changes from acknowledgement-triggered effects. A duplicate must
  not rewrite state or re-project already completed command feedback. Keep
  delivery reconciliation available so an interrupted send can still recover.
- Split legacy normalization at load from validation of current-format writes.
  Avoid unconditional migration clones on already-normalized state. Do not
  remove schema validation of disk contents or untrusted IPC envelopes.
- Replace whole-fleet snapshots for single-record reads with narrow immutable
  queries. Preserve isolation; never expose mutable internal records.
- Bound acknowledgement concurrency. Do not remove historical replay until a
  reconciliation contract proves which receipts the relay still needs.

Measure after this slice. Keeping one existing JSON store initially avoids
introducing a storage migration while resolving the largest avoidable costs.

### 3. Simplify recovery and work scheduling

Aim for fewer owners and smaller interfaces, not additional wrapper layers:

- A **DeliveryLedger module** owns valid delivery transitions, receipt
  reconciliation and durable deduplication through a small interface. Callers
  should not independently reconstruct those rules from snapshots.
- A **Connection module** owns attachment lifecycle, correlated requests,
  bounded in-flight work, and expiry. Probe expiry is absence of evidence, not
  a request to kill durable delivery. Keep ownership and authorization checks.
- A **Matrix projection module** owns retry, idempotency and durable projection
  status. Slow remote operations should not block receipt/probe processing.
  Use bounded fair scheduling with per-conversation ordering; do not simply
  dispatch every request concurrently.
- Replace blind reconnect receipt bursts with bounded reconciliation of the
  relay's outstanding deliveries, including persisted-but-unfinished work.
  Add protocol negotiation/legacy compatibility tests before changing messages.
- Separate optional typing/presence updates (coalescible) from durable input,
  final-answer and provenance records. Resolve orphaned activity deterministically
  rather than allowing it to block final projection indefinitely. Never label an
  answer "projected" merely because it was queued locally.
- Centralize retry policy by operation category; remove superseded retry paths
  and tests once the new interface tests cover the actual behaviors.

Dependencies stay behind real seams: use local durable storage in fault tests,
real Unix sockets for transport tests, and an injected Matrix adapter for delayed,
failed and uncertain external operations. No new generic workflow manager.

### 4. Change storage only if measurements still justify it

If changed-record writes still scale with total fleet history after step 2, choose
one transactional record-scoped storage approach. Compare a small SQLite-backed
ledger with per-conversation records before committing to a design. Prefer proven
transactions over inventing a custom multi-file journal, and retain a host-wide
mechanism for uniqueness, retirement and generation invariants.

Require explicit schema/version migration, read-only preflight, rollback/support
rules, and crash tests before rollout. Do not casually shard files and lose
atomicity of cross-conversation operations. No Redis, extra daemon, or service
split is proposed to address the current single-process defect.

### 5. Make observability sustainable

Do this alongside the implementation slices, not after another outage:

- Metadata-only counters: active attachments, reconnect causes, expired probes,
  queue depth/oldest age, no-op/changed writes, bytes written, event-loop lag,
  and per-conversation acknowledgement/projection latency.
- Bounded rate-limited diagnostics with suppression counters and periodic
  summaries; replace permanent silence after the first 64 records. Keep a hard
  bound on memory/disk output and never log bodies, credentials or raw errors.
- Separate states in operator output: relay connected, input durably accepted,
  input persisted in Pi, model active, projection pending, reply sent. Attachment
  alone must never be presented as successful message delivery.

## Verification and decision gates

Use synthetic data at the observed 34-conversation/roughly-2.4-MB scale, including
34 simultaneous reconnects, retained terminal receipts, slow Matrix responses,
unknown acknowledgements, process loss and partial writes. Do not commit live
message contents as test fixtures.

Required properties:

- Duplicate terminal acknowledgement: no additional durable write and no duplicate
  external effect, while a previously interrupted delivery remains recoverable.
- Successful changed acknowledgement: durable before success is reported.
- One stalled room cannot indefinitely prevent healthy rooms from accepting input.
- Late/lost replies, full queues and reconnects preserve the same generation,
  native history and exact attachment ownership; no duplicate model dispatch.
- A restart converges on receipts/outbox state without replaying completed tasks.
- Packaging-selected compilation and actual package verification catch missing
  source dependencies before another operator rebuild.

Initial performance targets to validate against baseline (not current guarantees):
under 5% of one core for a synthetic idle fleet, zero receipt writes for a fully
reconciled reconnect, and p95 durable acknowledgement below 250 ms under the
agreed normal-load fixture. Measure Matrix delivery separately from its external
server latency and rate limits. Tighten or revise targets with explicit evidence,
not by weakening durability.

Run focused tests first, then the canonical deterministic gate and package build
once authorized. Live process refresh and any storage migration retain their own
approval gates. Review the complete improvement epic across Standards and Spec
before declaring fleet recovery/performance acceptance complete.

## Recommendation

Start with approved, one-at-a-time adapter rollout and the baseline measurement.
Then implement no-op receipt handling plus parser/snapshot cost reduction. This
is lower risk and better supported by evidence than a wholesale rewrite or a
larger machine. Use those results to decide whether deeper storage changes are
necessary. No live mutation or production code change was made for this plan.
