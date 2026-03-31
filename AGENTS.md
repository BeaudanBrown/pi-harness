# AGENTS for pi-harness

This repository builds the local `pi-harness` control plane described in the
repo docs.

## Read Order

1. This file
2. `README.md`
3. `docs/pi-hub-data-model.md`
4. `docs/workstream-switcher-v1.md`
5. `docs/workstream-switcher-implementation-plan.md`
6. `docs/agent-vm-workflow.md`
7. `docs/implementation-loop.md` when working on the local Codex loop
8. `planning/session-switcher-v1/context.md`
9. `planning/session-switcher-v1/handoff.md`

## Repository Shape

- `docs/pi-hub-data-model.md` locks the workstream-first data model.
- `docs/workstream-switcher-v1.md` is the first product slice spec.
- `docs/workstream-switcher-implementation-plan.md` converts that slice into
  delivery phases.
- `docs/agent-vm-workflow.md` describes the target agent VM operator flow.
- `docs/implementation-loop.md` documents the temporary local Beads + Codex loop
  used to build this project; it is not product architecture.
- `planning/session-switcher-v1/` holds repo-managed execution context and
  handoff notes for the current workstream.
- `prompts/implementation/` holds locked implementation prompts for local loop
  runs.
- `scripts/` holds the canonical loop and quality-gate entrypoints.
- `.pi/` holds project-local Pi configuration and the thin integration surface.

## Working Rules

- Keep this repository focused on orchestration configuration, extensions, and
  launch helpers.
- Keep implementation notes in repo docs and commit durable decisions when
  behavior stabilizes.
- Implement the harness core in Go; do not turn this repo into a Node or
  TypeScript application.
- Prefer the Go standard library for CLI parsing, JSON, subprocess execution,
  path handling, and file writes before adding external dependencies.
- Use project-local TypeScript only for narrow Pi integration boundaries where
  Pi lifecycle hooks are the cleanest option, and keep those extensions tiny and
  dependency-free.
- Keep the design workstream-first. Projects and directories are scope
  attachments, not the identity of the session.
- Keep one tmux session per workstream.
- Keep isolated git worktrees as the default attachment mode for git-backed
  contexts.
- Keep shared read-write contexts explicit and visibly distinct.
- Target Linux only for the session-switcher v1 lane.
- Keep Nix integration backward-compatible so it can be optionally imported by
  `nix-dotfiles`.
- Treat the local Codex loop and Beads tracker as temporary implementation
  scaffolding, not product dependencies.
- Do not push unless the user explicitly asks in the current session.

## Verification

- Canonical done gate: `nix run .#verify`
- Lint-only gate: `nix run .#lint`
- Test-only gate: `nix run .#test`
- Run `nix flake check` after changing `flake.nix` or dev-shell assumptions.

## Beads Tracker

This project uses `bd` for repo-local work tracking.

- Run `bd prime` for workflow context.
- Use `bd ready --label session-switcher-v1 --label leaf --exclude-type epic`
  to find the current claimable work for the locked implementation lane.
- Keep at most one non-epic issue in progress per actor unless a human is
  deliberately coordinating multiple slices.
- If a slice is abandoned with a clean worktree, move the issue back to `open`
  instead of leaving it stranded in `in_progress`.
- When you discover new follow-up work, create Beads issues in this repository
  and link blockers explicitly with `bd dep`.
