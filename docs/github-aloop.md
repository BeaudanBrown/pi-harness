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
   worker launches, followed by at most 20 additional minutes of acceptance
   settlement. Use `--settlement-minutes <1-60>` to adjust that allowance.
   Use `--max-minutes <1-240>` and `--max-worker-launches <1-20>` to choose explicit resource bounds for that
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
started it is settlement work governed by its own command timeout, hard-capped
server-side at 20 minutes even if the tool caller requests longer, and further
clipped to the remaining settlement window.

The whole supervisor turn is also bounded. The worker-launch cap stops new full workers; the implementation cutoff stops
both full-worker and targeted-patch launches. Review and verification
may continue only until the implementation cutoff plus the settlement allowance.
At that final deadline, active operations and the model turn are aborted; no
new supervisor operation starts. Human continuation commands reject a settled
or expired invocation rather than restarting an unbounded model turn.
Budget-skipped or interrupted checks are not
reported as failed checks and cannot authorize acceptance. Worker emergency
preservation retains its independent 30-second inspection allowance even after
cancellation. The invocation never silently starts unlimited workers. This launch cap is a resource guard and does
not represent retries or epic size. GitHub CLI subprocesses have their own
30-second timeout and honor turn cancellation, including during initial graph
retrieval. Their timeout cleanup terminates the complete POSIX process group;
GitHub issue tooling is therefore explicitly unsupported on Windows rather than
leaving descendant processes unbounded. Run `/aloop` again to reconstruct
durable state and continue. A
settled supervisor turn cannot launch another worker without that explicit
restart.

## Headless execution

The packaged `pi-aloop #<epic>` command runs the same native Pi supervisor through
RPC. It accepts the separate `--max-minutes`, `--settlement-minutes`, and
`--max-worker-launches` options (space-separated values). NixOS runtime-enabled
hosts route it through their normal engineering launcher, retaining configured
LSP and project environment behavior. No new model, environment wrapper, or
session manager is selected.

It checks that `/aloop` is an extension command before sending the request.
Each process has a fresh invocation identity. Only the matching structured
terminal outcome can authorize exit zero, and only after successful explicit
parent closure; `agent_settled`, worker prose, and completed children alone do
not imply success. Human approval/checkpoint, budget exhaustion, cancellation,
startup failure, mismatched or missing outcomes exit nonzero (currently 2).
Headless operation does not grant epic approval: complete the human boundary
through the normal interactive workflow. Native attempt files and GitHub remain
recovery evidence; the driver starts with `--no-session` and is not a resume UI.

Output is one bounded JSON status with no prompts, tool output, credential
values, or private paths. RPC has a 1 MiB buffered-frame bound and 64 MiB total
stdout bound. A watchdog covers startup and the configured budget, sends native
abort, allows up to 40 seconds for shutdown/preservation, then force-terminates
the supervisor process group if necessary. Forced termination cannot prove the
absence of an independently detached or unresponsive process; inspect before
recovery. The driver does not infer old-worker liveness or delete artifacts.

## Explicit recovery inspection

`/aloop-recovery [#issue]` is a read-only bounded local-attempt inspection, also
available when ordinary startup refuses a dirty checkout. It reports retained
statuses and unknown evidence without starting a model, adopting dirty work,
mutating Git/GitHub, or determining whether a previous worker still exists.
Detailed records remain in private native session history. No retained record
is a claim that the current worktree has no changes. Inspect `git status` and
the attempt files, preserve valuable partial work, and intentionally settle it
before rerunning `/aloop`; no automatic WIP commit or cleanup is offered.

## Durable handoffs and issue closure

`aloop_review_attempt` resolves the cumulative issue base and current `HEAD`,
then runs fresh Standards and Spec agents. Review prose informs supervisor
judgment; it is not machine-parsed. If review is unavailable or stale,
`aloop_finish_attempt` refuses automatic acceptance. The supervisor must create
an explicitly `review`-kind `aloop_checkpoint`; only its GitHub-authenticated,
resolved decision bound to the current `HEAD` can replace independent review.
Generic decision checkpoints never authorize review bypass.

`aloop_finish_attempt` hides verification receipts, local spool IDs, exact
publication bytes, and closure ordering. For accepted work it requires a clean
unchanged reviewed `HEAD`, runs the startup policy's canonical and applicable
production commands, publishes one concise v3 current-state handoff, closes the
child, updates the cached graph, and returns the next frontier. Canonical or
production failure cannot be overridden autonomously and leaves the attempt
unsettled with durable logs and diagnosis. Unsuccessful finalization publishes
one complete bounded current-state snapshot for the next fresh worker. The tool
schema requires semantic consolidation when state exceeds 6 findings (80
characters each), 4 decisions (80 each), 3 advisory verification entries (100
each, with 3 additional slots reserved for generated receipts), or 200-character
summary/next-action fields; every accepted input item is preserved
rather than silently truncated. V3 comments show those complete bounded fields; an
HTML marker carries hidden idempotent recovery state. Readers retain minimal
v1/v2 compatibility, but writers emit only v3.

There is no semantic retry-count gate. The
supervisor chooses a narrow patch, trivial direct edit, fresh full remediation,
or human checkpoint according to the evidence. Accepted closure recovery is
reconstructed only from the authenticated GitHub handoff and its matching
GitHub-recorded human authorization, plus the clean bound Git `HEAD`; recovery
authorization is GitHub-recorded, not local. Local queues or approval files
never authorize closure after restart. `aloop_context`
serves the startup-cached GitHub graph and accepts an explicit refresh;
successful publication and closure update that snapshot in memory.

`aloop_epic_completion` is two phase. `prepare` refreshes the graph, requires no
open descendants or unsettled attempts, runs canonical verification plus any
epic-frequency integration, and validates only accepted child handoffs authored by the GitHub-authenticated
supervisor that bind durable review and canonical verification, plus supplied
evidence for every epic acceptance criterion before terminating at a
human approval boundary. Child-level independent reviews remain the semantic
review evidence; there is no mandatory separate epic review or machine-parsed
prose gate. The durable preparation record retains that final
evidence snapshot. The operator records approval with
`/aloop-approve-epic <prepared-head>`; `apply` closes the parent only when that
durable command attestation matches the unchanged prepared `HEAD`. Human
checkpoint answers are similarly recorded with `/aloop-decision <issue>
<decision>` rather than a model-supplied boolean or resolution string.

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
checks. For acceptance, `aloop_finish_attempt` uses the invocation's committed
policy snapshot and records command status independently from diagnostic prose.
A verification run must begin and end at the same clean HEAD. When the policy is
missing, malformed, or required infrastructure is unavailable, the supervisor
records the gap and stops rather than inventing a passing check.

## Worker environment preflight

Normal and managed-project engineering launchers append the same Nix-owned
baseline after the project PATH: Bash, coreutils, findutils, grep/sed, Git,
GitHub CLI, jq, ripgrep, flock, which, and Nix. Worker launches retain the inherited
project environment and append missing LSP/runtime fallback entries. The local
and coordinator launchers do not explicitly inject this engineering baseline;
this is capability configuration, not an operating-system sandbox.

Before charging a full-worker launch, the supervisor checks the launcher, Bash,
Git, and the committed canonical command's executable. Canonical availability is
checked against the supervisor's actual inherited PATH, not synthetic worker
fallbacks that verification would not receive. Missing requirements
return `environment-blocked`, without a worker spawn, launch charge or GitHub
mutation. Direct worker calls check their effective launcher/Bash/Git too;
missing tools fail before creating an attempt. Executable presence is not a
promise that a script's interpreter, nested commands, or project build will work.
A present launcher that fails at execution still produces the existing durable
launch-failure result.

Private native Pi session entries (`aloop-environment-preflight`) and successful
worker `runtime.json` record bounded role-to-executable resolutions, never the whole
environment or credential values. Public failure text contains role labels only.
Preflight does not install tools, start Nix builds, or alter project configuration.
Python and project compilers remain project-owned: launch from the repository's
existing Nix environment and use its documented verification entrypoint. No
project environment wrapper or automatic model change is introduced.

## Preservation evidence

New worker results retain execution status independently of `submission`
(`valid`, `missing`, or `invalid`) and versioned `preservation` evidence. This
records HEAD, commit count, staged/unstaged/untracked path counts, capture
completeness, and bounded operation-failure labels. Failed inspection yields
`null` (unknown), never a zero-change claim. Both timeout and cancellation
results include these facts in their deterministic summaries.

Postflight Git commands share a separate 30-second inspection deadline. Git
output and each patch are capped at 10 MiB; untracked content is capped at
1,000 files and 10 MiB total. Unsupported untracked entries, including symlinks,
are retained in the source workspace and make preservation incomplete. Failed
patch commands do not create misleading empty successful patch artifacts.
Captured patches preserve their trailing bytes. Preservation is diagnostic
recovery material, not a disk-loss backup or a security sandbox.

Incomplete preservation blocks automatic acceptance, including after reloading
a new-format result. Non-accepted handoffs use a deterministic Git/preservation
summary rather than model-authored claims about whether changes exist. Original
files are never deleted, staged, or committed by preservation. Inspect and
explicitly settle retained work before another attempt. Historical results
without this evidence retain their existing recovery behavior.

Before spawning, the harness writes and syncs a bounded `attempt.json` identity.
Final results are size-bounded, written to a private same-directory temporary
file, synced, atomically renamed over the reserved result, and directory-synced.
Replaced result/directory identities are rejected. Writes, rename, and cleanup
are anchored to an open directory descriptor so pathname replacement cannot
redirect them. Descriptor-path support is checked before worker launch (Linux
uses procfs; other hosts require working directory traversal through their
file-descriptor filesystem and fail closed if unavailable). Linux is covered by
the deterministic race tests; Darwin has not been live-verified. Temporary files
left by a crash are not treated as final results.

Missing, truncated, malformed, oversized, or invalid final results with valid
startup identity are recovered as `interrupted`: commit and preservation counts
remain unknown, and acceptance stays blocked. Legacy startup contexts can also
establish identity. Discovery is read-only; it does not determine whether an
old process is alive, stop processes, or modify the workspace. Operators must
ensure the previous worker has stopped before settling its work. Patch startup
identity names its parent so an interruption before parent-ledger publication
does not detach the patch's evidence. Invalid bookkeeping marks preservation
incomplete rather than suppressing evidence.

Automatic dirty-worktree adoption remains intentionally unsupported. Automatic
worktree isolation remains disabled after the
[compatibility trial](aloop-worktree-trial.md); headless execution is supported
through the driver described above.

## Resume and recovery

Pi conversation state is convenient but not authoritative. To resume after an
interruption, a deadline/attempt-budget stop, or a settled turn, enter the same
clean worktree, start Pi, and run `/aloop #<epic-number>` again. The supervisor
reconstructs progress from the current GitHub graph and comments plus Git
history; invocation budgets intentionally do not persist as hidden loop state.

On startup, aloop also scans the latest 200 local attempt directories. Results
are filtered by their commit, or validated starting commit when the result is
interrupted, to the current branch. A matching directory name alone cannot
establish interrupted identity; a validated startup record is required. If it finds an attempt artifact with no matching durable GitHub
handoff, it blocks another worker launch. Inspect the result and commit, run
`aloop_review_attempt`, remediate if needed, then use `aloop_finish_attempt` to
verify and publish the v3 handoff. If an accepted v3 handoff is already published
but its child remains open after an interrupted closure, aloop excludes that
child from the worker frontier and requires `aloop_finish_attempt` to recover the
closure before any new worker starts. Automatic recovery requires the exact
current-process publication body or the GitHub-authenticated supervisor as the
v3 comment author, and requires that reviewed HEAD to remain clean in Git. Local
finalization records aid diagnosis but are not closure authority. When that
evidence cannot apply, `/aloop-authorize-recovery <issue> <attempt-key>` writes
an auditable GitHub-recorded authorization bound to the same issue, attempt, reviewed
HEAD, exact comment digest, and current clean closure HEAD. Any later HEAD change
invalidates the authorization. Arbitrary
parseable accepted comments and unrelated decisions never become closure
authority. Do not manufacture acceptance from a worker summary alone.

Common recovery cases:

- **Dirty worktree:** `/aloop` refuses to start and reports when interrupted
  attempt evidence is retained. Inspect the changes and preserve or resolve the
  interrupted work deliberately until the tree is clean; do not discard it blindly.
- **Interrupted result publication:** inspect `attempt.json`, startup context,
  any patches, and current Git state. Settle with an unsuccessful handoff rather
  than accepting unknown preservation; explicit remediation can then establish
  fresh verified evidence. The scanner never invents a successful result.
- **Worker timeout, cancellation, invalid result, or process failure:** full
  artifacts remain available. Record the unsuccessful outcome, then choose a
  remediation or human stop.
- **Commit/worktree contract violation:** treat the attempt as unsuccessful.
  Inspect Git and the worktree, preserve or deliberately settle partial state,
  and require a clean tree only before accepting a successful candidate.
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
- `attempt.json` — bounded, synced pre-spawn issue/base identity and optional
  patch-parent association;
- `runtime.json` — bounded private executable-resolution evidence (no environment
  dump or credential values);
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
