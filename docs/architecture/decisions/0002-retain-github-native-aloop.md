# ADR 0002: Retain the GitHub-native aloop as a secondary workflow

- **Status:** Accepted
- **Date:** 2026-09-01
- **Issue:** [#13](https://github.com/BeaudanBrown/pi-harness/issues/13)
- **Parent:** [#1](https://github.com/BeaudanBrown/pi-harness/issues/1)

## Context

The tk-backed `/aloop` was disabled during the move to GitHub Issues and the curated Matt Pocock skills. The cutover deliberately deferred deciding whether a fresh-agent loop still had value: preserving the old implementation was not sufficient justification.

The skills workflow is now packaged and documented as the normal interactive path. GitHub Issues is the repository's sole durable task source, and the repository has typed GitHub issue operations, recursive epic inspection, isolated worker attempts, and durable handoff conventions. During the cutover work, the fresh-worker pattern proved useful for bounded child-issue implementation while a supervisor retained issue ownership and reviewed the result.

A self-hosted live trial then ran the packaged `/aloop #1` with an actual model. It selected the remaining executable children sequentially, produced clean one-commit changes for #12 and #13, retained complete local artifacts, independently verified the first result, published its structured handoff, and closed #12 before moving to #13. Interrupting the supervisor after the second result also demonstrated that GitHub, Git, and attempt artifacts retained enough evidence to resume. The same trial exposed that a long autonomous supervisor turn needed an explicit wall-clock and worker-count budget rather than relying only on per-worker timeouts.

That observed use supports retaining automation for multi-issue epics, but not promoting it over interactive planning and implementation. The useful part is fresh context plus an independently reviewing supervisor. A second tracker, autonomous scope decisions, preservation of tk behavior, or an indefinitely running invocation would negate the cutover.

## Decision

Retain the GitHub-native `/aloop #<epic>` as an optional **secondary** workflow for executing already-planned multi-issue epics. The interactive skills chain remains primary:

```text
setup-matt-pocock-skills → grill-with-docs → to-spec → to-tickets → implement → code-review
```

Aloop does not replace grilling, specification, ticket decomposition, interactive implementation, or review. It may begin only after those planning activities have produced sufficiently explicit GitHub issues.

### Source of truth and frontier

GitHub Issues is the loop's only task source of truth. It reconstructs work from the open parent/sub-issue graph, native blocker relationships, issue state, structured handoff comments, and Git history. Labels and assignments are advisory metadata, not execution locks. It has no tk dependency, queue database, or dual-write state.

An executable frontier item is an open, unblocked descendant leaf. The supervisor processes one item at a time. Labels and assignments may aid queue visibility but never override graph, blocker, or issue state. Aloop does not use assignment as a lock because agents share one GitHub identity; sequential supervisor execution provides the local concurrency boundary.

### Ownership, handoff, and verification

The supervisor owns every GitHub mutation. Workers cannot use GitHub mutation APIs, push, or fetch. Each full worker starts fresh in the clean epic worktree, derives authoritative scope from an immutable GitHub-backed context snapshot, and remains scoped to one selected issue. Multiple coherent commits and no-change outcomes are valid. Successful candidates must be clean; unsuccessful, missing-submission, timeout, and cancellation state is preserved for supervisor settlement.

After an attempt, the supervisor independently inspects the commit and checks every acceptance criterion. Workers use repository guidance and an optional advisory feedback command for focused checks. At invocation startup the supervisor snapshots the committed `.aloop.json`: one canonical argv command is required, while production integration is optional and runs at its declared issue or epic frequency. Commands have bounded timeouts, durable logs and machine-readable status, and read-only failure diagnosis that cannot override the exit result. Passing receipts bind the commit tree and policy hash and may be reused after restart. A terminating structured submission is evidence, not acceptance; final assistant prose is not a protocol. Mechanical integrity is hard-gated while semantic acceptance and evidence quality remain supervisor judgment. Narrow patch workers are separate settlement subprocesses and cannot access review, communication, GitHub mutation, or supervisor orchestration tools.

Before another worker starts, the supervisor publishes a structured handoff comment on the selected issue. The handoff records attempt type, commit (or contract failure), acceptance assessment, verification, criterion evidence, discovered work, next action, and local artifact location. Interrupted runs are recovered from GitHub comments and Git history; local artifacts are diagnostic only.

### Closing and failure semantics

The supervisor closes a child only after its matching handoff is durable and independent review confirms all acceptance criteria. It closes an epic only when every descendant is closed and review, project verification, and epic-level acceptance evidence all pass.

A dirty successful candidate, unresolved blocker, missing required verification, unavailable independent review, or product/scope ambiguity stops automatic closure for a human decision. There is no semantic retry count or materially-new-approach gate. Every invocation also has an explicit implementation deadline and worker-launch cap. The launch cap is a resource bound, not a retry counter: epic progress comes from descendant issue state while supervisor settlement may continue after worker bounds. Reaching either invocation bound stops the turn and requires an explicit `/aloop` rerun, which reconstructs progress from durable state instead of waiting indefinitely. Each fresh full worker receives generic operating guidance and issue identifiers, then reads decoded prior-handoff and issue evidence through its startup context tool; opaque durable comment markers are never used as prompt context. The loop does not invent corrective scope. Newly discovered work is reported; only the supervisor may create a narrowly necessary follow-up issue.

The operational contract, recovery procedure, and artifact format are specified in [`docs/github-aloop.md`](../../github-aloop.md).

## Consequences

- The skills-based interactive workflow remains the advertised default and the place where work is understood and decomposed.
- Multi-issue epics may use fresh sequential workers without restoring tk or introducing another durable queue.
- GitHub blocker, handoff, verification, and close semantics are explicit and supervisor-owned; labels and assignments remain advisory.
- Aloop remains intentionally conservative: ambiguous or repeatedly failing work returns to a person, and every invocation has finite time and worker-count bounds.
- If practical use no longer demonstrates value, the extension can be removed without migrating state because GitHub and Git already contain all durable progress.
