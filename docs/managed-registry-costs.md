# Registry hot-path implementation (#134)

This is the first code slice of #133 and the proposal in
[managed-relay-performance-plan.md](managed-relay-performance-plan.md), not a
claim of completed fleet recovery. #135 owns sustainable observability, #136
owns bounded reconnect reconciliation/scheduling, #137 owns separately approved
rollout/live acceptance, and #138 owns two pre-existing verification failures.
Storage format, delivery order, transport authorization and deployment are unchanged.

## Changes and acceptance evidence

| Acceptance | Implementation | Focused evidence |
| --- | --- | --- |
| Identical committed receipt causes no registry write | Synchronous read-only receipt planning runs inside the existing serialized mutation queue, before rollback cloning | 34-conversation/2176-receipt synthetic replay: zero writes and unchanged inode/state |
| No speculative success | A duplicate cannot inspect an earlier transition until its write settles | Held first write fails; second receipt waits, re-evaluates restored state, commits successfully and survives reload |
| Validation cannot be bypassed | Retirement, cancellation, Pi-entry identity, status, completion kind and projection checks precede no-op selection | Queued cancel/retirement reject stale receipts; changed entry identity rejects; ordinary/extension completion identities cannot be interchanged |
| Missing provenance still repaired | Same status is not sufficient: missing matrix-user projection requires a write | Missing-projection fixture repairs once, then becomes a no-op |
| Strict current/legacy state handling | Compile the repository-owned TypeBox runtime schema once, retain semantic checks and error reporting; clone for default migration only when legacy fields are absent | Existing runtime/manifest/permission/projection contract tests, malformed nested data and non-mutating legacy normalization tests |
| Reads do not copy unrelated histories | `conversationSnapshot(id)` returns a detached copy with existing snapshot observation semantics | Mutation of returned row cannot affect registry; clone spy sees one conversation, not fleet |
| Packaging imports remain resolvable | Add `typebox/compile` mapping for shared TS, relay and bridge-chat compilation | Both recipe-selected source trees compile with existing local dependencies; actual Nix builds still pending |

The compiled validator uses a static repository-owned schema, never a schema
provided by IPC or stored data. It replaces interpretation, not validation. Full
semantic validation still runs on every changed-state write. Current-format
parsing no longer allocates a migration clone simply to discover no migration is
needed. Legacy normalization still returns a validated migrated value without
mutating its input.

The no-op branch is not a new transaction manager. It is a synchronous preflight
on the existing serialized writer; changed operations retain rollback capture,
validation, atomic replacement and observer behavior. No-op receipts skip both
write and observer recomputation. This does not suppress independently durable
post-receipt effects: an interrupted command notice may still need its existing
idempotent outbox reconciliation. Optimizing those retries belongs to #136.
A terminal completed receipt without a Pi entry cannot later gain one: this would
reclassify a completed command and invent provenance. Legacy terminal records
without that evidence fail closed rather than being silently backfilled.

## Interruption and concurrency matrix

| Point | Required result |
| --- | --- |
| Prior write is pending but in-memory fields already match | Queue the duplicate; do not acknowledge speculative durability |
| Prior write fails | Restore state; the next receipt must apply and write, not short-circuit |
| Prior write succeeds, its reply is lost | Exact duplicate succeeds without another registry write |
| State matches but matrix-origin provenance is absent | Validate and repair provenance durably before success |
| Cancel/reset/retirement commits before receipt planning | Current state/negative authority wins; reject stale progress |
| Failure after commit but before another external effect | Keep existing effect/outbox retry behavior and transaction identity |
| Observer throws after changed-state commit | Existing observer isolation remains; it cannot roll back authority |

## Measurements

The test uses synthetic data, not copied Matrix messages. Its 34 conversations
contain 64 completed receipts each and approximately 2.39 MB of compact JSON.
The pre-change implementation fails on the **first** repeated acknowledgement
because it writes the registry. Afterward all 2176 acknowledgements perform zero
writes in approximately 56–61 ms total CPU across focused runs. These tests assert
write counts, identity, state and durability, not a fragile wall-clock threshold.

A separate read-only benchmark compares the old and new parser on the same live
fleet snapshot held in memory (12 iterations after warm-up, no state writes):

- Before: 162.05 ms mean CPU per runtime parse.
- After: 17.50 ms mean CPU per runtime parse (about 9.3x lower).
- Preliminary isolated shape-validation comparison: interpreted 139.56 ms vs
  compiled 11.66 ms. That comparison motivated the static compiled validator.

These are local computation measurements, not a production CPU profile or a
claim that deployed relay CPU has already fallen. Changed mutations still
serialize and persist the whole registry. Storage migration remains conditional
on post-rollout evidence and separate authorization.

## Verification status

- Full repository TypeScript compiles; LSP diagnostics clean.
- Final focused registry/contracts/recovery/routing/Matrix/projection checks:
  90 pass, no failures or skips.
- Final full managed suite: 629 pass, 2 fail, 48 packaged/environment skips. Both failures
  reproduce with the preserved pre-change build and are tracked in #138. This is
  **not** a green canonical gate.
- Relay and bridge-chat recipe-selected source compilation pass using existing
  local dependencies. These checks are not actual Nix derivation builds.
- Canonical Nix verification, package builds, activation, adapter refreshes and
  live performance/message-delivery acceptance were not run; authorization and
  baseline failure resolution remain required.

Standards review found no issues. Spec review identified asymmetric completion-
kind validation; the missing direction is now rejected and regression-tested.
Final evidence artifacts and counts are recorded in GitHub #134. Do not
clear registry history or queued messages to improve any benchmark.
