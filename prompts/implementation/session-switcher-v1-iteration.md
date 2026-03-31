Implement one bounded slice of the `session-switcher-v1` workstream for
`pi-harness`.

This prompt is for building `pi-harness` itself. It is not product
architecture.

Read, in order:

1. `AGENTS.md`
2. `docs/pi-hub-data-model.md`
3. `docs/workstream-switcher-v1.md`
4. `docs/workstream-switcher-implementation-plan.md`
5. `docs/agent-vm-workflow.md`
6. `docs/implementation-loop.md`
7. `planning/session-switcher-v1/context.md`
8. `planning/session-switcher-v1/handoff.md`

This loop injects the current Beads issue JSON, but you still need to keep the
tracker up to date explicitly:

1. Confirm the selected work item in Beads (`bd ready --label session-switcher-v1 --label leaf --exclude-type epic` or an equivalent filtered view).
2. Keep the claimed slice current in Beads (`bd update <id> --claim` if needed).
3. If you discover new work, file it immediately (`bd create "<title>" --type task ...`) and link it if ordering matters (`bd dep <current-id> --blocks <new-id>`).
4. Add inline progress notes (`bd comment <id> "..."`) when you change approach or hit blockers.
5. If the slice is implemented, verified (`nix run .#verify`), committed, and clean, close it (`bd close <id>`).
6. If the slice is not complete but you are actively continuing it, keep that
   single issue in progress and continue; do not leave multiple leaf issues in
   progress at once.
7. If you abandon a slice and leave the repo clean, move the issue back to
   `open` (`bd update <id> --status open --assignee ""`) instead of leaving it
   stranded in progress.

Constraints:

- Keep the product workstream-first.
- Keep one tmux session per workstream.
- Keep the core harness implementation in Go.
- Keep TypeScript limited to a thin Pi integration layer.
- Keep tmux plus `fzf` as the popup UI path.
- Do not reintroduce coordinator-era assumptions or external planning
  dependencies.
- Add or update tests for every implemented behavior.
- Run `nix run .#verify` before considering the slice complete.
- Treat a failing test, lint error, or verify step as unfinished work rather
  than a report-only outcome.
- Before ending your turn, explicitly check whether the repo's verify gate
  passes, and continue working if it does not.
- Finish with a local commit if you changed code or docs.
- Dirty worktree state is acceptable while implementing, formatting, or
  verifying, but do not leave the repository dirty when you declare the slice
  complete.
- Do not leave multiple non-epic Beads issues in progress for the same actor.
- If repeatable failures come from loop tooling, include fixes to the relevant
  repo artifacts in the same slice before continuing.
- Keep changes small, coherent, and reviewable.
- Prefer the Nix-managed quality commands over ad hoc host tooling.
- Inside the local implementation loop, prefer direct `bd`, `git`, `go`, `nix`,
  and repo script commands first.
- Do not push.

When useful, create follow-up Beads issues in this repository for newly
discovered work. Use Beads only for implementing `pi-harness`, not for the
product ontology.
