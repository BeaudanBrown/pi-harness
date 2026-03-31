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

## Next Recommended Slice

Start with Phase 0 and Phase 1 from
`docs/workstream-switcher-implementation-plan.md`:

- scaffold the Go CLI foundation and Nix packaging
- implement durable workstream manifests
- implement runtime status files
- add a thin Pi lifecycle extension for `processing` vs `idle`
- keep tmux inspection as a verification aid, not the source of identity

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
