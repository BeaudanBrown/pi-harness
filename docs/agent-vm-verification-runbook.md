# Agent VM Verification Runbook

This document turns the setup contract in
[`docs/agent-vm-verification-prerequisites.md`](/home/beau/host/projects/pi-harness/docs/agent-vm-verification-prerequisites.md)
and the command-sequence skeleton in
[`docs/workflow-alpha-command-transcript.md`](/home/beau/host/projects/pi-harness/docs/workflow-alpha-command-transcript.md)
into one concrete manual verification flow for the first end-to-end lane on the
always-on `agent` VM.

Use this runbook after the prerequisite checks pass.

## Scope

This runbook verifies the workflow-alpha lane for:

- zero-context workstream creation
- tmux session bootstrap and direct attach behavior
- popup switching between two workstreams
- isolated-by-default git-backed attachment
- plain-directory attachment
- runtime-state file creation and refresh
- reattach from inside and outside tmux

This is an operator runbook, not a recovery guide. If a prerequisite fails,
stop and fix setup first.

## Before You Start

Satisfy the setup gate in
[`docs/agent-vm-verification-prerequisites.md`](/home/beau/host/projects/pi-harness/docs/agent-vm-verification-prerequisites.md).

The expected starting environment is:

- the repo is at `/home/beau/host/projects/pi-harness`
- `ph`, `tmux`, `fzf`, `git`, and `nix` are available in the VM
- `nix run .#verify` already passed from the shared repo path
- `ssh agent` lands in the shared `default` tmux session

## Sample IDs Used Below

The commands below assume these free-form titles:

- `workflow-alpha`
- `workflow-alpha-peer`

Record the exact generated workstream ids from your run. The examples below use:

- `<alpha-id>` for the workstream created from `workflow-alpha`
- `<peer-id>` for the workstream created from `workflow-alpha-peer`

## Ordered Runbook

### 1. Enter the shared repo path in the normal tmux entry flow

Run:

```sh
ssh agent
cd /home/beau/host/projects/pi-harness
pwd
tmux display-message -p '#S'
```

Expected outcome:

- `pwd` prints `/home/beau/host/projects/pi-harness`
- `tmux display-message -p '#S'` prints `default`
- you are inside the normal shared tmux landing session before any workstream is created

### 2. Re-run the documented preflight from the shared repo path

Run:

```sh
command -v ph
command -v tmux
command -v fzf
test -f /home/beau/host/.pi-hub/shares.json
nix run .#verify
```

Expected outcome:

- all `command -v` checks print a path
- the share manifest exists at `/home/beau/host/.pi-hub/shares.json`
- `nix run .#verify` exits successfully before any manual operator checks begin

### 3. Capture the baseline workstream view

Run:

```sh
ph list
tmux list-sessions
```

Expected outcome:

- `ph list` completes without errors from the shared repo path
- `tmux list-sessions` includes `default`
- this output becomes the baseline used to confirm new `ph:<workstream-id>` sessions appear later

### 4. Create the first workstream from inside tmux

Run:

```sh
ph new workflow-alpha
```

Expected outcome:

- the command prints `created <alpha-id> (ph:<alpha-id>)`
- your tmux client switches immediately into session `ph:<alpha-id>`
- the workstream starts with no attached paths

### 5. Confirm tmux ownership and zero-context state for the new workstream

Run:

```sh
tmux display-message -p '#S'
ph list
ph status <alpha-id>
```

Expected outcome:

- `tmux display-message -p '#S'` prints `ph:<alpha-id>`
- `ph list` includes `<alpha-id>`
- the `<alpha-id>` row shows attachment summary `no paths`
- `ph status <alpha-id>` resolves by exact workstream id and reports the same session name

### 6. Confirm the durable and live state files exist for the first workstream

Run:

```sh
ls ~/.local/state/pi-harness/workstreams/<alpha-id>.json
ls ~/.local/state/pi-harness/runtime/<alpha-id>.json
cat ~/.local/state/pi-harness/workstreams/<alpha-id>.json
cat ~/.local/state/pi-harness/runtime/<alpha-id>.json
```

Expected outcome:

- both files exist under the documented XDG state roots
- the durable manifest includes `<alpha-id>` and `ph:<alpha-id>`
- the runtime file includes:
  - `workstreamId` = `<alpha-id>`
  - `tmuxSession` = `ph:<alpha-id>`
  - `state` set to `processing` or `idle`
  - `lastSeenAt`
- if `state` is `processing`, `lastProcessingAt` should also be present

Runtime-state check:

- the runtime file must describe the same workstream and tmux session you are attached to now
- `ph list` may render `idle` as `waiting`; that UI label is valid for this runbook

### 7. Add the shared repo as an isolated git-backed context

Run:

```sh
ph add-context <alpha-id> /home/beau/host/projects/pi-harness
ph list
ph status <alpha-id>
```

Expected outcome:

- `ph add-context` prints `attached <context-id> to <alpha-id> at <path> (...)`
- the attached path is `/home/beau/host/projects/pi-harness`
- the attachment is treated as git-backed and isolated by default
- `ph list` no longer shows `no paths` for `<alpha-id>`

### 8. Confirm the harness-owned isolated worktree path exists

Run:

```sh
find ~/.local/share/pi-harness/worktrees/<alpha-id> -maxdepth 2 -type d
```

Expected outcome:

- the output includes `~/.local/share/pi-harness/worktrees/<alpha-id>/`
- at least one context directory exists under that root
- the isolated worktree was created under the harness-owned path rather than by mutating the shared repo in place

Operator note:

- this harness-owned path is the only cleanup candidate if the isolated context is retired later
- in v1, removing the context does not remove the worktree automatically
- do not treat `/home/beau/host/projects/pi-harness` as disposable cleanup state for detach
- if you later clean up the isolated worktree manually, prefer `git worktree remove` from the source checkout over `rm -rf`

### 9. Add a plain directory context to the same workstream

Run:

```sh
mkdir -p /tmp/workflow-alpha-notes
ph add-context <alpha-id> /tmp/workflow-alpha-notes
ph list
ph status <alpha-id>
```

Expected outcome:

- the directory attach succeeds without requiring git metadata
- `<alpha-id>` now has multiple attached contexts
- `ph list` renders the shared attachment summary as `<count> paths`
- the summary does not imply that either context is primary

### 10. Create a second workstream for menu switching

Run:

```sh
ph new workflow-alpha-peer
```

Expected outcome:

- the command prints `created <peer-id> (ph:<peer-id>)`
- your tmux client switches into `ph:<peer-id>`
- `ph list` now shows at least two workflow-alpha workstreams

### 11. Open the popup menu from inside tmux and switch back

Run:

```sh
ph menu
```

Expected outcome:

- a tmux popup opens over the current client
- the selector shows both `<alpha-id>` and `<peer-id>`
- each row uses the same attachment-summary rules as `ph list`
- selecting `<alpha-id>` closes the popup and switches the client into `ph:<alpha-id>`

Menu check:

- this step is successful only if the switch happens from the popup, not by manually typing `tmux switch-client`

### 12. Reattach directly by exact workstream id from inside tmux

Run:

```sh
ph attach <peer-id>
ph attach <alpha-id>
```

Expected outcome:

- each command switches the current tmux client directly into `ph:<workstream-id>`
- resolution is by exact workstream id
- the command acts as the direct reentry path after menu-based switching

Reattach check:

- both workstreams remain reachable without going back through the shared `default` session first

### 13. Verify the outside-tmux `ph menu` bootstrap path

From a shell outside tmux in the same VM, run:

```sh
cd /home/beau/host/projects/pi-harness
ph menu
```

Expected outcome:

- the command prints `Outside tmux: joining the shared default tmux session, then opening the workstream menu.`
- the harness joins tmux first
- you land in the shared `default` tmux session with the popup open there

Bootstrap check:

- this path is correct only if it normalizes outside-tmux menu entry to `default`

### 14. Verify the outside-tmux direct attach path

From a shell outside tmux in the same VM, run:

```sh
cd /home/beau/host/projects/pi-harness
ph attach <alpha-id>
```

Expected outcome:

- the command prints `Outside tmux: joining tmux and attaching <alpha-id> (ph:<alpha-id>).`
- the harness joins tmux and lands directly in `ph:<alpha-id>`
- it does not stop in `default` first

Bootstrap check:

- this path is correct only if outside-tmux attach remains a direct workstream attach

### 15. Re-check runtime state after switching and reattaching

Run:

```sh
ph list
ph status <alpha-id>
cat ~/.local/state/pi-harness/runtime/<alpha-id>.json
cat ~/.local/state/pi-harness/runtime/<peer-id>.json
```

Expected outcome:

- both workstreams still appear in `ph list`
- each runtime file still points at its matching `ph:<workstream-id>` session
- `lastSeenAt` is present for each workstream with a plausible recent value for the current run
- each row renders as a live status such as `processing` or `waiting`, not as a missing-workstream error

Runtime-state check:

- if the UI shows `waiting`, the corresponding runtime file may still say `idle`
- a stale, missing, or unreadable runtime file while the tmux session still exists would surface as `unknown`; that is not a successful workflow-alpha result for this first end-to-end lane

## Completion Criteria For This Run

Treat the run as successful only if all of the following are true:

- the prerequisite gate in
  [`docs/agent-vm-verification-prerequisites.md`](/home/beau/host/projects/pi-harness/docs/agent-vm-verification-prerequisites.md)
  was satisfied first
- the command flow above completed in order without falling back to ad hoc tmux commands
- `ph new`, `ph menu`, `ph attach`, and `ph add-context` all behaved according to the v1 operator contract
- runtime files existed for the exercised workstreams and matched the active tmux session names
- reattach worked from both inside and outside tmux

## Related Docs

- [`docs/agent-vm-verification-prerequisites.md`](/home/beau/host/projects/pi-harness/docs/agent-vm-verification-prerequisites.md)
- [`docs/workflow-alpha-command-transcript.md`](/home/beau/host/projects/pi-harness/docs/workflow-alpha-command-transcript.md)
- [`docs/agent-vm-workflow.md`](/home/beau/host/projects/pi-harness/docs/agent-vm-workflow.md)
