# Session Switcher V1 Context

## Workstream Identity

- Workstream ID: `pi-harness-session-switcher-v1`
- Planning lane: `session-switcher-v1`
- Base branch: `main`
- Current branch: `main`

## Objective

Turn `pi-harness` from a scaffold into a workstream-first tmux and Pi session
manager.

The first product slice is:

- one tmux session per workstream
- free-form workstream creation
- a popup switcher that lists and filters workstreams
- full-window attach into the selected session
- optional project or directory attachments for scope

## Settled Decisions

- The primary unit is the workstream, not the project.
- A workstream may exist without any attached project.
- A workstream may exist without any attached path at all.
- Projects and directories are incidental scope attachments.
- Git-backed project attachments should default to isolated worktrees.
- Shared contexts are allowed but must remain explicit.
- Runtime state should distinguish `processing`, `idle`, `dead`, and
  `unknown`.
- A workstream does not require a primary context; attached paths are just a
  set that may be empty.
- The first switcher UI should be tmux-backed rather than Pi-native.
- The core harness implementation should be Go, not a Node or TypeScript
  application.
- `fzf` is the required popup selector for v1.
- `ph` / `pi-harness` is the primary operator interface for agentic coding.
- Linux is the only target platform for v1.
- A thin project-local TypeScript Pi extension is still allowed for lifecycle
  hooks such as `agent_start` and `agent_end`.
- V1 command arguments that take `<workstream>` resolve exact `workstreamId`
  matches only.
- `ph new <title>` should immediately switch into the new workstream session.
- `ph menu` and `ph attach <workstream>` should start or join tmux when invoked
  outside tmux.
- If the tmux session still exists but the newest trusted runtime file is older
  than 12 hours, status should become `unknown`.
- The first meaningful test milestone is workflow alpha.
- The first post-v1 priority is repair and recovery commands.
- The first post-v1 recovery candidates are grouped into runtime inspection,
  dead-session repair, stale-runtime reconciliation, cleanup and reclamation,
  and deeper state repair.

## Primary Docs

Read these first:

- `docs/pi-hub-data-model.md`
- `docs/workstream-switcher-v1.md`
- `docs/workstream-switcher-implementation-plan.md`
- `docs/agent-vm-workflow.md`
- `docs/implementation-loop.md`
- `README.md`

## Current Implementation Order

1. Go CLI foundation, Nix packaging, and verification toolchain.
2. Durable workstream registry plus runtime status files.
3. tmux popup switcher and attach flow.
4. workstream context attachments with isolated and shared modes.
5. imported share-registry and repo-local project metadata for labels and
   attachment shortcuts.
6. end-to-end verification on the always-on agent VM.
