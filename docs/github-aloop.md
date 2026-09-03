# GitHub-native aloop

`/aloop #<epic>` supervises a GitHub epic from one clean worktree. GitHub
Issues are the sole durable task source: the parent/sub-issue graph, native
blockers, issue state, and structured handoff comments describe what remains.
Labels and assignments are advisory metadata. Git history describes what was implemented. There is no separate
loop database, queue file, or session state to restore.

## Prepare and start

1. Grill the proposed outcome with the repository's planning workflow until its
   scope and acceptance criteria are explicit.
2. Create an open GitHub epic, then create fully specified child issues with
   native sub-issue and blocker relationships. Use `ready-for-agent` only as an
   optional prioritization hint for fully specified, unblocked work.
3. Create or enter a dedicated worktree and branch for the epic. For example,
   using names appropriate to the repository:

   ```bash
   git worktree add -b <epic-branch> <worktree-path> <base-ref>
   cd <worktree-path>
   git status --short
   ```

   The status output must be empty. `/aloop` and every implementation worker
   refuse to start from a dirty worktree.
4. Start the packaged Pi from that worktree. Invoke the epic only while Pi is
   idle; `/aloop` rejects startup during another active turn rather than waiting
   without a bound:

   ```text
   pi
   /aloop #<epic-number>
   ```

   Each invocation defaults to a 60-minute implementation deadline and at most 20 fresh
   worker launches. Use `--max-minutes <1-240>` and
   `--max-worker-launches <1-20>` to choose explicit resource bounds for that
   invocation, for example
   `/aloop #123 --max-minutes 120 --max-worker-launches 20`.

   Worker launches are not retry counts. Epic progress is reported as closed
   descendants out of total descendants. A new issue starts with no retry;
   only a remediation launched after an unsuccessful handoff receives that
   issue's next retry number.

The command retrieves the complete descendant graph, recent structured
handoffs, and recent Git history. An executable issue is an open, unblocked
descendant leaf. Labels and assignments may help queue visibility, but the live
GitHub dependency graph determines aloop selection.

## Supervisor and worker responsibilities

The current Pi session is the **supervisor**. It:

- selects one executable leaf at a time, regardless of advisory labels or assignments;
- launches fresh implementation or remediation workers sequentially;
- independently checks worker evidence against every selected-issue acceptance
  criterion;
- owns all GitHub comments, relationships, state changes, and any narrowly
  necessary corrective issues; and
- decides whether to accept, remediate, or stop for a human decision.

A **worker** is a fresh, bounded Pi JSON-mode process using the declarative
`aloop-implementation` profile. It inherits the supervisor's active model and
runs at medium thinking. The generic prompt contains only the epic/child IDs
and operating rules. `aloop_issue_context` exposes the immutable startup
snapshot containing the issue bodies, relationships, decisions, issue base
commit, and prior handoff state. The selected child remains the strict scope.
Workers may use LSP, focused diagnostics, independent review, research,
browser (through the packaged `playwright-browser` skill and `pi-playwright`
CLI), diagram, architecture, Nix, and read-only GitHub tools, but cannot
mutate GitHub, push, fetch, contact the operator, or run supervisor acceptance.

Every attempt starts clean. Candidate-complete and already-satisfied outcomes
must finish clean; incomplete, decision-required, environment-blocked,
timeout, cancellation, process-failure, and missing-submission outcomes retain
the exact Git state for supervisor settlement. Multiple coherent commits and
no-change outcomes are valid. The terminating `aloop_submit_result` tool writes
`candidate-complete`, `already-satisfied`, `incomplete`, `decision-required`,
or `environment-blocked` evidence directly to the attempt directory. A missing
submission adds reconstruction work but never discards commits or prevents the
supervisor from accepting valid work. Worker submissions remain claims: the
supervisor independently reviews and verifies the cumulative issue state.

Targeted settlement corrections use a separate fresh `aloop-patch` process at
medium thinking. It receives only the narrow correction, source/edit/LSP and
focused diagnostic tools, commits coherent changes, and terminates through
`aloop_submit_patch_result`. It has no review, web, GitHub, Matrix, browser,
architecture, canonical-verification, or nested implementation-orchestration
tools; `run_worker` remains available only for bounded command diagnosis. Patch launches
are sequential supervisor settlement work and do not consume the full-worker
time or 20-launch counters; they cannot be started to evade an expired
implementation budget.

Workers never run in parallel in one supervisor session. The supervisor must
publish the current attempt's handoff before launching another worker. While a
full worker is active, the tool emits elapsed-time heartbeats and caps that full
worker at the smaller of its requested timeout and the invocation's remaining
time. A targeted patch must start before the implementation deadline, but once
started it is settlement work governed by its own command timeout.

The whole supervisor turn is also bounded. Reaching either the hard deadline or
the worker-launch cap stops that invocation; it never waits indefinitely or
silently starts unlimited workers. This launch cap is a resource guard and does
not represent retries or epic size. GitHub CLI subprocesses have their own
30-second timeout and honor turn cancellation, including during initial graph
retrieval. Their timeout cleanup terminates the complete POSIX process group;
GitHub issue tooling is therefore explicitly unsupported on Windows rather than
leaving descendant processes unbounded. Run `/aloop` again to reconstruct
durable state and continue. A
settled supervisor turn cannot launch another worker without that explicit
restart.

## Durable handoffs and issue closure

After every attempt, including unsuccessful and contract-violating attempts,
the supervisor prepares a structured handoff. Preparation stores the exact
comment bytes in the private local spool and returns a short handoff ID. The
supervisor passes only that ID to `aloop_publish_handoff`, first with
`dry_run=true` and then with `dry_run=false`; publication is idempotent and never
requires model copy/paste of the encoded marker. A handoff records:

- implementation or remediation attempt type;
- commit, or the absence of a valid commit;
- the supervisor verification receipt ID for accepted attempts;
- supervisor acceptance result and approach;
- whether the approach was materially new;
- verification and acceptance-criteria assessment;
- discovered work and the next action; and
- the local attempt artifact directory.

Only a correctly encoded handoff on its matching issue counts. An accepted
handoff must reference the receipt ID returned by `aloop_supervisor_verify`.
The repository commits a `.aloop.json` policy containing a required
`canonicalCommand`, an optional advisory `workerFeedbackCommand`, optional
`patchWorkerModel` (defaulting to Terra when available, then the active model), and optional
phase-aware `productionIntegration`. Every command is an explicit argv array,
not an implicit shell string, and has a configurable timeout that defaults to 30
minutes. The supervisor snapshots the committed policy when `/aloop` starts;
later worktree edits cannot replace the invocation's gates. It executes commands
serially, preserves full logs and machine-readable results, and requests bounded
read-only diagnosis on failure without letting that diagnosis determine pass or
fail. Issue-frequency production integration runs with child acceptance;
epic-frequency integration runs at the epic closure gate.
Verification is permitted only after a matching pending worker attempt has
returned its commit. Preparation accepts only immutable receipt bytes bound to
the exact issue, artifact, commit tree, and policy hash. A matching successful
receipt can be reused after restart. Receipt validation confirms that HEAD and the
complete worktree (including untracked files) are still identical.
Commit all intended sources before verification: Git-backed Nix flakes omit
untracked files, so a check run while eventual source files are untracked is
invalid even if its command exits successfully. The supervisor closes a child only after that handoff is durable and its
acceptance criteria pass independent review. Hard gates enforce commit,
verification, receipt, publication, blocker, and closure integrity; acceptance
wording and evidence quality remain the supervisor's semantic judgment rather
than a punctuation-sensitive protocol. `aloop_close_accepted_issue` is also dry-run-first. Once GitHub reports
the issue closed, the exact published handoff and bound receipt ID provide a
durable idempotency key, so an interrupted closure can be retried after a
session restart without closing twice.

Two consecutive unsuccessful attempts without a materially new approach stop
the loop for an explicit user decision. Material product, architecture, or
scope ambiguity also causes a human-decision stop; the supervisor does not
guess. A materially different remediation may proceed after the user or new
evidence establishes the approach.

Before closing the epic, the supervisor requires all descendants to be closed,
review evidence for every descendant, passing project verification evidence,
and evidence for every epic acceptance criterion. It then reports completed
children and commits, verification, discovered or deferred work, and whether
the epic closed or stopped at a human boundary.

## Project verification policy

Each repository declares its required canonical command and any optional
worker-feedback or production-integration phase in `.aloop.json`. See the
packaged `aloop-policy` skill for the schema and review checklist. The harness
never generates the policy automatically. A repository may also explicitly opt implementation workers into narrowly
scoped project-owned resources with `workerResources.extensions` (repository-
relative extension files that resolve inside the worktree) and
`workerResources.tools` (the corresponding registered tool names). Those values
are validated, merged only into a profile whose project policy is
`aloop-opt-in`, and never grant GitHub mutation or supervisor communication
capabilities implicitly. Workers use repository guidance for focused iteration
checks. For acceptance, the supervisor passes only the worker commit to
`aloop_supervisor_verify`; the tool uses the invocation's committed policy
snapshot and records command status independently from diagnostic prose. A
verification run must begin and end at the same clean HEAD. When the policy is
missing, malformed, or required infrastructure is unavailable, the supervisor
records the gap and stops rather than inventing a passing check.

## Resume and recovery

Pi conversation state is convenient but not authoritative. To resume after an
interruption, a deadline/attempt-budget stop, or a settled turn, enter the same
clean worktree, start Pi, and run `/aloop #<epic-number>` again. The supervisor
reconstructs progress from the current GitHub graph and comments plus Git
history; invocation budgets intentionally do not persist as hidden loop state.

On startup, aloop also scans local attempt results whose commits belong to the
current branch. If it finds an attempt artifact with no matching durable GitHub
handoff, it blocks another worker launch. Inspect the result and commit,
independently assess the attempt, then prepare and publish the missing handoff by its short ID.
Do not manufacture a successful handoff from a worker summary alone.

Common recovery cases:

- **Dirty worktree:** `/aloop` refuses to start. Inspect the changes and preserve
  or resolve the interrupted work deliberately until the tree is clean; do not
  discard it blindly.
- **Worker timeout, cancellation, invalid result, or process failure:** full
  artifacts remain available. Record the unsuccessful outcome, then choose a
  remediation or human stop.
- **Commit/worktree contract violation:** treat the attempt as unsuccessful.
  Inspect Git and the worktree, restore the clean one-commit boundary
  deliberately, and record what happened.
- **Missing local artifacts:** GitHub and Git remain authoritative. Use their
  evidence to decide whether a fresh remediation is justified or human input is
  required; never infer acceptance from absent logs.

## Attempt artifacts

Each attempt writes a private directory under:

```text
.pi/tmp/aloop/issue-<issue>-<timestamp>-<random>/
```

It contains:

- `prompt.md` — the complete worker prompt;
- `stdout.jsonl` — the complete Pi JSON event stream;
- `stderr.log` — worker diagnostics;
- `issue-context.json` — the immutable GitHub-backed startup snapshot;
- `submission.json` — the optional structured result written by the terminating
  submission tool;
- `worktree.patch`, `staged.patch`, `untracked-files.json`, and `untracked/` —
  reconstructable partial Git state, including timeout/cancellation work; and
- `result.json` — process status, submission, contract assessment, mechanical
  commit evidence, and artifact paths.

The supervisor returns only bounded summaries to the main conversation. These
local artifacts support diagnosis and interrupted-attempt recovery, but they do
not replace GitHub handoffs or committed Git history and should not be treated
as cross-machine durable storage.
