# Next Additions

The first useful addition should be a tiny session-naming extension.

## Why

Pi already stores sessions, supports `/name`, resumes sessions, branches, and
compacts context. The missing cross-machine convenience is not session
orchestration; it is consistently naming sessions when each workstream is
managed in a separate tmux session.

## Proposed Shape

Add one project-local or global extension under `config/agent/extensions/` that:

- reads the current tmux session name from `TMUX` / `tmux display-message`
- reads the current git repo name and branch when available
- on `session_start`, suggests or applies a Pi session name such as
  `<tmux-session> :: <repo>@<branch>`
- exposes a slash command like `/workstream-name` to rename the Pi session
  from the current tmux/git context on demand

Keep it observational and reversible. It should not create tmux sessions,
switch panes, mutate git worktrees, or manage multiple Pi sessions.
