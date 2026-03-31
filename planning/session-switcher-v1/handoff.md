# Session Switcher V1 Handoff

## Current State

- Planning for this workstream now lives in repo docs plus
  `planning/session-switcher-v1/`.
- The old project-first hub note has been rewritten as a workstream-first data
  model.
- The first product spec now lives in `docs/workstream-switcher-v1.md`.
- The implementation stack is now locked in
  `docs/workstream-switcher-implementation-plan.md`.
- The repo now also has a Beads tracker plus a repo-local Codex loop scaffold
  documented in `docs/implementation-loop.md`.
- No implementation code exists yet for the registry, popup switcher, or
  context attachment flow beyond the placeholder wrapper and extension
  scaffold.
- Attached paths are now documented as an optional set with no primary-context
  requirement.
- `ph list` and `ph menu` now share one attachment-summary rule: `no paths`
  for zero contexts, the context label for one context, and `<count> paths`
  for multiple contexts.
- Runtime state older than 12 hours is now part of the `unknown` contract when
  tmux still exists.
- The first test target is workflow alpha in the normal agent ssh plus tmux
  flow.
- `docs/workflow-alpha-command-transcript.md` now includes a compact
  workflow-alpha scenario matrix covering zero-context creation, outside-tmux
  menu entry, isolated-by-default git attachment, plain-directory attachment,
  and reattach behavior.
- `docs/agent-vm-verification-prerequisites.md` now locks the setup contract
  for the later manual workflow-alpha run inside the agent VM, including share
  exposure, guest path expectations, tmux assumptions, required tools, and a
  `nix run .#verify` preflight.
- The first post-v1 priority is repair and recovery commands.
- The first post-v1 recovery-command outline now names concrete candidate
  groups: `ph doctor` inspection, dead-session repair, stale-runtime
  reconciliation, cleanup and reclamation, and deeper state repair.

## Next Recommended Slice

Start with Phase 0 and Phase 1 from
`docs/workstream-switcher-implementation-plan.md`:

- scaffold the Go CLI foundation and Nix packaging
- implement durable workstream manifests
- implement runtime status files
- add a thin Pi lifecycle extension for `processing` vs `idle`
- keep tmux inspection as a verification aid, not the source of identity
- keep outside-tmux invocation behavior explicit for `ph menu` and `ph attach`
- do not reintroduce primary-context assumptions in CLI or data model docs
- use the recovery-command outline in `docs/workstream-switcher-v1.md` as the
  starting point for later roadmap or issue decomposition work rather than
  reopening recovery scope from scratch

## Constraints

- Keep tmux as the underlying session transport.
- Do not make projects the primary row model again.
- Keep isolated git worktrees as the default for git-backed project attachment.
- Treat shared read-write contexts as an explicit advanced mode.
- Do not edit repo-local project metadata from inside the harness in v1.
- Keep the product core in Go.
- Keep TypeScript limited to the smallest Pi integration boundary that gives
  reliable lifecycle status.
- Keep the popup selector tmux plus `fzf`, not a separate UI framework.
- Keep the local Codex loop and Beads tracker treated as implementation
  scaffolding, not product shape.
- Keep worktree cleanup manual or detach-only in v1; do not add automatic
  deletion behavior.
