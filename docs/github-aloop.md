# GitHub-native aloop

`/aloop #<epic>` supervises a GitHub epic from one clean worktree. GitHub
Issues are the sole durable task source: the parent/sub-issue graph, native
blockers, assignments, issue state, and structured handoff comments describe
what remains. Git history describes what was implemented. There is no separate
loop database, queue file, or session state to restore.

## Prepare and start

1. Grill the proposed outcome with the repository's planning workflow until its
   scope and acceptance criteria are explicit.
2. Create an open GitHub epic, then create fully specified child issues with
   native sub-issue and blocker relationships. Mark only unassigned, unblocked
   work as `ready-for-agent`.
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

   Each invocation defaults to a 30-minute hard deadline and at most three
   fresh workers. Use `--max-minutes <1-240>` and `--max-attempts <1-20>` to
   choose smaller or larger explicit bounds for that invocation, for example
   `/aloop #123 --max-minutes 15 --max-attempts 1`.

The command retrieves the complete descendant graph, recent structured
handoffs, and recent Git history. An executable issue is an open, unblocked
descendant leaf. The `ready-for-agent` label helps the human queue, but the live
GitHub graph determines aloop selection.

## Supervisor and worker responsibilities

The current Pi session is the **supervisor**. It:

- selects one executable leaf at a time;
- claims an unassigned issue for the authenticated GitHub user and removes its
  `ready-for-agent` lifecycle label;
- launches fresh implementation or remediation workers sequentially;
- independently checks worker evidence against every selected-issue acceptance
  criterion;
- owns all GitHub assignments, comments, relationships, state changes, and any
  narrowly necessary corrective issues; and
- decides whether to accept, remediate, or stop for a human decision.

A **worker** is a fresh, bounded Pi JSON-mode process with repository editing
and shell tools but no harness extensions or skills. It must not mutate GitHub,
push, or fetch. Every attempt starts from a clean worktree and must finish with
a clean worktree and exactly one new local commit without rewriting earlier
history. The worker returns structured verification, acceptance-criteria,
discovered-work, and next-action evidence. Outcomes are explicitly
`implemented-and-verified`, `partial`, `verification-failed`, `blocked`, or
`no-change`. An `implemented-and-verified` result must name the exact final
commit, report verification evidence, and provide passing evidence for every
acceptance criterion; it remains a claim, not acceptance. The supervisor must
independently verify and review the repository change.

Workers never run in parallel in one supervisor session. The supervisor must
publish the current attempt's handoff before launching another worker. While a
worker is active, the tool emits elapsed-time heartbeats and caps the worker at
the smaller of its requested timeout and the invocation's remaining time.

The whole supervisor turn is also bounded. Reaching either the hard deadline or
the worker-attempt cap stops that invocation; it never waits indefinitely or
silently starts unlimited workers. GitHub CLI subprocesses have their own
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
- supervisor acceptance result and approach;
- whether the approach was materially new;
- verification and acceptance-criteria assessment;
- discovered work and the next action; and
- the local attempt artifact directory.

Only a correctly encoded handoff on its matching issue counts. An accepted
handoff must reference the receipt ID returned by `aloop_supervisor_verify`;
preparation rechecks that the receipt passed at the returned commit and that
HEAD and the complete worktree (including untracked files) are still identical.
Commit all intended sources before verification: Git-backed Nix flakes omit
untracked files, so a check run while eventual source files are untracked is
invalid even if its command exits successfully. The supervisor closes a child
only after that handoff is durable and its acceptance criteria pass independent
review.

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

## Project verification discovery

Aloop does not assume one verification command for every repository. The
supervisor and workers first read repository guidance such as `AGENTS.md`,
domain documentation, dependency manifests, task runners, and CI configuration.
They run focused checks while iterating and the applicable project-defined gate
before acceptance, then record the exact commands and outcomes in the handoff.
When guidance is ambiguous or required infrastructure is unavailable, the
supervisor records the gap and stops rather than inventing a passing check.

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
- **Issue assigned to another user:** do not launch a worker. Coordinate through
  GitHub rather than taking over the assignment.
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
- `result.json` — process status, structured result, contract assessment, commit
  evidence, and artifact paths.

The supervisor returns only bounded summaries to the main conversation. These
local artifacts support diagnosis and interrupted-attempt recovery, but they do
not replace GitHub handoffs or committed Git history and should not be treated
as cross-machine durable storage.
