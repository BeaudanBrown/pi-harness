# Workstream Switcher V1

## Objective

Provide a fast tmux-backed switcher for multiple parallel Pi workstreams.

The first version is not a project browser. It is a workstream menu that lets
the operator:

- see all sessions
- identify which ones are processing or idle
- create a new free-form workstream
- switch one selected workstream into the full terminal window

## Locked Implementation Direction

- The target platform is Linux only.
- `ph` / `pi-harness` is the primary operator interface; raw `pi` remains an
  implementation dependency rather than the user-facing workflow.
- The core harness should be implemented in Go.
- The popup switcher should use tmux plus `fzf`, not a separate in-process TUI.
- TypeScript remains allowed only for a narrow project-local Pi lifecycle
  extension so the harness can observe `agent_start` and `agent_end` without
  rebuilding Pi's own interactive UI.

The detailed technical plan lives in
`docs/workstream-switcher-implementation-plan.md`.

## Primary Interaction Model

The main entrypoint is:

- `ph menu`

Behavior:

1. Open a small menu window from the current tmux session.
2. Show all known workstreams with status, title, and attached-path summary.
3. Allow fuzzy filtering plus Vim-style movement.
4. Press `Enter` on a workstream to switch the client into that tmux session.
5. Close the menu after switching.
6. Allow reopening the same menu from any workstream session.

Attachment summary rules for both `ph list` and `ph menu`:

- zero attached paths renders as `no paths`
- one attached path renders as that context's display label
- multiple attached paths render as `<count> paths`
- the same summary rules apply in both surfaces
- multi-path summaries must not imply that one context is primary

The menu should be a tmux popup first. That keeps the current ssh and tmux
workflow intact and avoids requiring Pi to own window management.

If `ph menu` is invoked outside tmux, the harness should first start or join
tmux and then open the popup from there.

## Session Model

- one tmux session per workstream
- workstream creation is free-form and does not require a project up front
- a workstream may exist with zero contexts
- one workstream may later attach multiple projects or directories
- multiple workstreams may attach the same project in isolated or shared modes

## Context Model

Each workstream keeps zero or more contexts.

Each context has:

- a path
- an optional `projectId` from repo-local metadata
- a mode (`isolated`, `shared-readonly`, or `shared-readwrite`)

Defaults:

- for git-backed project attachments, prefer an isolated worktree
- for plain directories, attach the directory directly
- shared modes are explicit opt-in

For v1, a workstream does not require any primary context. Attached paths are
treated as a set and may be empty.

## Sync Model

### Isolated Contexts

The normal sync boundary is commits and branches.

If workstream A needs work from workstream B, the harness should later support
explicit sync operations such as:

- merge another workstream branch
- cherry-pick selected commits
- rebase onto another workstream branch

### Shared Contexts

If two workstreams intentionally point at the same path, they remain in live
sync because they are looking at the same files.

This is powerful but risky. Shared read-write mode should be treated as an
advanced workflow and surfaced clearly in the switcher.

## Runtime Contract

The harness wrapper should emit a small runtime state file for each workstream.

The first status model is:

- `processing`
- `idle`
- `dead`
- `unknown`

For v1, "waiting" in the UI simply means `idle`.

If the tmux session still exists but the newest trusted runtime state is older
than 12 hours, the harness should render the workstream as `unknown`.

## Proposed Local Layout

- `~/.local/state/pi-harness/workstreams/<workstream-id>.json`
- `~/.local/state/pi-harness/runtime/<workstream-id>.json`
- `~/.local/share/pi-harness/worktrees/<workstream-id>/<context-id>/`

The worktree root is only for isolated git-backed contexts. Shared contexts
keep their original paths.

## Initial Commands

- `ph menu`
- `ph new`
- `ph list --json`
- `ph attach`
- `ph add-context`
- `ph status`

`ph new <title>` should create the workstream and immediately switch the
operator into the new managed tmux session.

If `ph attach <workstream>` is invoked outside tmux, the harness should first
start or join tmux and then attach to the target session.

In v1, commands that take `<workstream>` should resolve only exact
`workstreamId` matches. Prefix, fuzzy, or title-based resolution can land after
the durable registry and popup selector are stable.

## Implementation Order

1. Durable workstream registry and runtime status files.
2. tmux session discovery and attach/switch primitives.
3. tmux popup switcher with fuzzy filtering.
4. context attachment model with isolated and shared modes.
5. import of repo-local project metadata and shared project registry for
   attachment shortcuts and labels.

## Non-Goals For V1

- editing repo-local project metadata from inside the switcher
- automatic project worktree provisioning outside explicit attach actions
- multi-project orchestration in one ambient prompt
- Pi-native deep UI integration before the tmux-backed control plane is stable
- automatic cleanup or deletion of detached worktrees

## Alpha Target

The first meaningful test milestone is workflow alpha.

Workflow alpha means the operator can use the normal `ssh agent` plus tmux flow
to:

- run `ph new <title>` and land in the new workstream session
- run `ph menu` and switch between at least two workstreams
- run `ph attach <workstream>` from inside or outside tmux
- attach a git-backed path with isolated-by-default behavior
- attach a plain directory
- see usable labels and status in `ph list` and the popup menu
- recover normal operation by reattaching to existing tmux sessions

## Post-V1 Direction

The first priority after v1 should be repair and recovery commands for dead
sessions, stale runtime state, and abandoned harness-owned worktrees.

The first command groups to evaluate after v1 are:

### Runtime Inspection

- `ph doctor`
- `ph doctor <workstream>`

Intent:

- inspect one workstream or the whole registry for mismatches between durable
  manifests, runtime files, tmux sessions, and attached paths
- explain whether a workstream is healthy, dead, stale, unknown, or missing
  expected artifacts
- surface operator-visible repair suggestions before any mutation happens

This should be the main read-only entrypoint before repair commands grow.

### Session Repair

- `ph repair session <workstream>`
- `ph revive <workstream>`

Intent:

- repair a dead-session state where the manifest still exists but the tmux
  session is gone
- recreate or relaunch the managed tmux session without changing the
  workstream identity
- preserve the existing manifest, contexts, and runtime history where possible

This group covers the common case where the operator or host lost the tmux
session but the workstream itself should continue.

### Runtime Reconciliation

- `ph repair runtime <workstream>`
- `ph refresh-runtime <workstream>`

Intent:

- recover from stale or missing runtime files when the tmux session still
  exists
- recompute the merged harness view so an `unknown` status caused by stale
  runtime can return to a trustworthy state
- restore runtime tracking after crashes, extension failures, or operator
  mistakes without forcing session recreation

This group should treat stale runtime repair separately from dead-session
repair because the tmux session may still be healthy.

### Cleanup And Reclamation

- `ph cleanup worktrees`
- `ph cleanup runtime`
- `ph prune <workstream>`

Intent:

- identify and optionally remove abandoned harness-owned worktrees
- remove obsolete runtime files for deleted or superseded workstreams
- reclaim leftover state after a workstream has been intentionally retired

These commands should stay explicit and operator-confirmed. V1 should not gain
automatic deletion behavior.

### State Repair

- `ph repair manifest <workstream>`
- `ph rebind <workstream>`

Intent:

- repair broken references between manifests, session names, runtime files, and
  attached context metadata
- fix state after partial manual edits, interrupted commands, or crashes in the
  harness control flow
- prefer targeted repairs over broad reset-style commands

This group is for structural consistency problems rather than simple stale
status recovery.

### Roadmap Shape

For roadmap and issue-decomposition purposes, the likely post-v1 order is:

1. read-only inspection with `ph doctor`
2. dead-session recovery
3. stale-runtime reconciliation
4. cleanup and reclamation for harness-owned leftovers
5. deeper manifest or reference repair for partial corruption

Naming can still change later. The important shape is that post-v1 recovery
should cover inspection first, then targeted repair paths for dead sessions,
stale runtime state, and cleanup-oriented maintenance.
