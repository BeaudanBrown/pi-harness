# Workstream Switcher V1 Implementation Plan

## Goal

Lock the implementation architecture for the `session-switcher-v1` workstream so the
repo can move from planning docs into an executable build sequence without
reopening the stack discussion on every slice.

## Locked Decisions

### Platform And Operator Model

- Target platform: Linux only.
- Primary operator interface: `ph` / `pi-harness`.
- Raw `pi` remains a dependency started inside managed tmux sessions; it is not
  the primary interface for this product.
- tmux remains the session transport.
- `fzf` is a required runtime dependency for the popup switcher.

### Core Implementation Stack

- Core language: Go.
- Core architecture: one Go CLI binary for manifests, tmux control, runtime
  merging, context attachment, and imported metadata.
- Keep runtime dependencies minimal and prefer the Go standard library for
  state storage, path handling, subprocess execution, timestamps, JSON, and
  atomic file writes.
- CLI parsing should be implemented in-tree with a small subcommand dispatcher
  rather than a framework-heavy CLI package in v1.
- Use Nix as the packaging and installation surface.
- Do not build a Node or TypeScript application layer for the harness itself.

### Pi Integration Boundary

- Keep one small project-local TypeScript extension for Pi lifecycle hooks.
- The extension should remain dependency-free and should not grow into the main
  application.
- Its v1 job is narrow:
  - observe `session_start`
  - observe `agent_start`
  - observe `agent_end`
  - observe `session_shutdown`
  - write runtime status records for the current workstream
- All orchestration logic stays in Go.

### Quality And Tooling

- Test runner: `go test`
- Formatting: `gofmt`
- Static checks: `go vet` and `staticcheck`
- Canonical repo gate: `nix run .#verify`
- Package and install: Nix flake outputs and NixOS module

## Repo Layout

The intended repo shape for v1 is:

- `cmd/pi-harness/main.go`
- `internal/cli/`
- `internal/paths/`
- `internal/models/`
- `internal/store/`
- `internal/runtime/`
- `internal/tmux/`
- `internal/contexts/`
- `.pi/extensions/pi-harness-runtime/index.ts`
- `docs/`

The existing `.pi/extensions/pi-harness/` scaffold should either be replaced by
the runtime-focused extension above or reduced to a thin compatibility layer.

## Filesystem Contract

### Durable Manifests

- Root: `~/.local/state/pi-harness/workstreams/`
- One file per workstream: `<workstream-id>.json`
- Write atomically via temp-file-plus-rename

Required manifest fields for v1:

- `schemaVersion`
- `workstreamId`
- `title`
- `tmuxSession`
- `createdAt`
- `updatedAt`
- `contexts`
- `notes`

### Runtime State

- Root: `~/.local/state/pi-harness/runtime/`
- One file per workstream: `<workstream-id>.json`
- Written by the Pi lifecycle extension
- Read and merged by the Go harness

Required runtime fields for v1:

- `schemaVersion`
- `workstreamId`
- `tmuxSession`
- `state` (`processing` or `idle`)
- `cwd`
- `lastSeenAt`
- `lastProcessingAt` optional
- `activeModel` optional

`dead` and `unknown` are not written by the extension. They are derived by the
Go reader:

- `dead` when the manifest exists but tmux session lookup fails
- `unknown` when runtime state is missing, unreadable, or schema-incompatible
  while the tmux session still exists
- `unknown` when the tmux session still exists but the newest trusted runtime
  record is older than 12 hours based on `lastSeenAt`

### Worktrees

- Root: `~/.local/share/pi-harness/worktrees/`
- Isolated git-backed contexts live under
  `~/.local/share/pi-harness/worktrees/<workstream-id>/<context-id>/`

## Session Contract

- One tmux session per workstream
- Session naming convention: `ph:<workstreamId>`
- The manifest stores the session name explicitly
- The harness, not the operator, owns session bootstrap

Initial managed launch flow:

1. `ph new <title>` creates the workstream manifest.
2. The harness allocates the tmux session name.
3. The harness launches a shell in that tmux session.
4. The harness starts `pi` inside the session with the project-local runtime
   extension enabled.
5. The harness injects environment variables needed by the runtime extension.
6. The harness switches the operator into the new tmux session immediately.

Required environment variables:

- `PI_HARNESS_WORKSTREAM_ID`
- `PI_HARNESS_RUNTIME_DIR`
- `PI_HARNESS_TMUX_SESSION`

## Command Surface

### Foundation Commands

These are the first commands that should exist with real behavior:

- `ph new <title>`
- `ph list`
- `ph list --json`
- `ph status <workstream>`

For v1, `<workstream>` resolves by exact `workstreamId` only.

### Session Control Commands

- `ph attach <workstream>`
- `ph menu`

If either command is invoked outside tmux, the harness should first start or
join tmux and then continue with the requested attach or popup behavior.

### Context Commands

- `ph add-context <workstream> <path-or-project>`

For v1, attached paths are modeled as a set. No primary-context command is
required.

## UI Contract

- `ph menu` should open a tmux popup with `display-popup`
- Candidate selection and filtering should use `fzf`
- The popup is a selector, not a second full TUI application
- Selecting an entry switches the client into the full workstream session
- Creating a new workstream from the menu should route through the same Go
  creation path as `ph new`

## Detailed Implementation Sequence

### Phase 0: Foundation

Deliverables:

- Go module scaffold
- Nix packaging updated for the compiled Go CLI
- test, lint, and typecheck commands available in the dev environment
- placeholder extension/model scaffolding marked for replacement

### Phase 1: Durable Registry And Runtime Contract

Deliverables:

- path helpers for XDG state roots
- manifest and runtime models with validation
- atomic JSON store helpers
- stable workstream id generation
- Go implementations for `ph new`, `ph list`, and `ph status`
- thin Pi lifecycle extension writing `processing` / `idle`

### Phase 2: tmux Control Plane And Popup Switcher

Deliverables:

- tmux primitives for create, existence check, and attach
- harness-owned session bootstrap
- popup selector built from tmux plus `fzf`
- attach flow from popup and direct CLI

### Phase 3: Context Attachments

Deliverables:

- context mutation commands
- isolated git worktree creation path
- direct directory attachment path
- explicit shared-readonly and shared-readwrite manifest modes

### Phase 4: Imported Metadata

Deliverables:

- parser for `/home/beau/host/.pi-hub/shares.json`
- parser for repo-local `.pi/project.yaml` metadata
- merged labels and attachment candidates
- share-aware filtering for attachable contexts

Metadata import fallback contract for v1:

- missing `.pi/project.yaml` is a clean fallback, not a fatal error
- unreadable or invalid `.pi/project.yaml` is surfaced as invalid metadata
  while attachment and workstream listing continue
- missing companion files referenced by `.pi/project.yaml` downgrade only the
  affected shortcut or note path; base metadata remains available

### Phase 5: End-To-End Verification

Deliverables:

- workflow-alpha command transcript skeleton for the normal ssh-plus-tmux path
- agent-VM verification runbook
- proof that `ph menu`, `ph new`, `ph attach`, and runtime status changes work
  in the real ssh/tmux workflow
- workflow-alpha acceptance criteria covering zero-context workstreams,
  outside-tmux entry, and stale runtime handling

## Non-Goals

- macOS support
- a web UI
- a separate Node application shell around the product
- replacing tmux as the transport
- rebuilding Pi's interactive UI in JSON or RPC mode for v1
- editing repo-local project metadata from inside the harness UI
- automatic deletion of worktrees in v1
