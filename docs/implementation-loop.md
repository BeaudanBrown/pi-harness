# Implementation Loop

This document defines the temporary automation used to build `pi-harness`
before `pi-harness` can manage its own implementation workflow.

It is intentionally not product architecture.

## Purpose

Use one repo-local Codex loop, backed by this repository's Beads graph, to
drive bounded implementation slices against `pi-harness`.

## Temporary Dependencies

- repository-local Beads database for task selection
- local `codex exec` for implementation
- repo-local prompt and planning files
- repo-local Nix verification commands

These are scaffolding for implementation only.

## Safety Model

- one active non-epic Beads issue at a time
- claim before work
- use blocker-aware ready checks (`bd ready`) instead of status-only filters
- no push from the loop
- no automatic merge of final history
- human remains the final reviewer for shared Git history
- stop on missing ready work or Beads errors
- keep iterating through the requested count even when a Codex pass or
  verification step fails, then report a non-zero result at the end if any
  iteration failed
- each completed slice should end in a local commit once code or docs are
  actually complete

## Loop Contract

1. Query repo-local Beads for truly ready, claimable non-epic issues labeled
   both `session-switcher-v1` and `leaf`.
2. If none are ready, check for one already-claimed in-progress non-epic issue
   assigned to the current actor and resume it.
3. If multiple non-epic issues are still in progress for the current actor,
   stop and force tracker cleanup instead of silently picking one.
4. Select one issue, claim it if needed, and inject the issue JSON into the
   prompt.
5. Build an execution prompt from:
   - `AGENTS.md`
   - `docs/pi-hub-data-model.md`
   - `docs/workstream-switcher-v1.md`
   - `docs/workstream-switcher-implementation-plan.md`
   - `docs/agent-vm-workflow.md`
   - `planning/session-switcher-v1/context.md`
   - `planning/session-switcher-v1/handoff.md`
   - the current Beads issue JSON
6. Run a bounded local `codex exec` against this repo.
7. Require the execution to run `nix run .#verify`.
8. Repeat until there are no claimable leaf issues for the loop window, or the
   max iteration count is reached.

Command-environment note:

- The loop exports `PI_HARNESS_LOOP_ACTIVE=1` to the Codex process.
- Inside that loop, prefer direct `bd`, `git`, `go`, `nix`, and repo script
  commands.

Dependency note:

- Use task-level blockers for ordering and select with `bd ready`.
- Treat epics as planning shells, not direct execution work.

Quick loop checks:

```bash
bd list --all --tree --no-pager
bd ready --label session-switcher-v1 --label leaf --exclude-type epic
bd dep <blocker-id> --blocks <blocked-id>
bd dep cycles
```

## Invocation

From the `pi-harness` repo:

```bash
CODEX_MODEL=gpt-5.4 \
CODEX_REASONING=medium \
LOOP_PROMPT=prompts/implementation/session-switcher-v1-iteration.md \
MAX_ITERATIONS=3 \
./scripts/session-switcher-local-loop.sh
```

For a non-mutating preview:

```bash
DRY_RUN=1 \
MAX_ITERATIONS=1 \
./scripts/session-switcher-local-loop.sh
```

The loop defaults to:

- model `gpt-5.4`
- reasoning effort `medium`
- `danger-full-access` sandbox for generated shell commands (override with `CODEX_SANDBOX` if needed)
- bounded iterations from `MAX_ITERATIONS` / `LOCAL_MAX_ITERATIONS` /
  `ITERATIONS`
- Beads issue selection from the current repository
- automatic resumption of one claimed in-progress non-epic issue for the
  current actor when no open ready leaf exists
- automatic reopening of multiple stranded in-progress non-epic issues for the
  current actor when the worktree is clean, followed by a fresh ready check
- dirty worktree states are tolerated during a run unless `--clean` or
  `PI_HARNESS_LOOP_REQUIRE_CLEAN=1` is set

There are `Justfile` targets for quick local launch:

```bash
just loop 10
just loop 20
just loop 20 gpt-5.4 medium
```

```bash
just loop-dry-run 1
```

The loop is fail-open across iterations: a failed Codex run, failed
`nix run .#verify`, or failed clean-worktree check marks that iteration as
failed but does not abort the remaining scheduled iterations. The script exits
non-zero after the last iteration if any pass failed.

If loop tooling itself breaks repeatedly, patch the scaffold files in the repo
and record the fix in `planning/session-switcher-v1/handoff.md`:

- `scripts/session-switcher-local-loop.sh`
- `Justfile`
- `prompts/implementation/session-switcher-v1-iteration.md`
- `docs/implementation-loop.md`

Tracker hygiene rule:

- Keep at most one non-epic issue in progress per actor unless a human is
  deliberately coordinating multiple slices.
- If a slice is abandoned and the worktree is clean, move the issue back to
  `open` rather than leaving it stranded in `in_progress`.
- If a newly claimed loop iteration fails before changing `HEAD` or leaving
  worktree state behind, the loop should reopen that issue automatically.
- If multiple stranded non-epic issues remain in progress and the worktree is
  clean, the loop may reopen them automatically before retrying the ready
  selection path.

## Product Boundary Reminder

The product remains a Go-based tmux and Pi harness. Codex and the temporary loop
are only bootstrap implementation tools here.
