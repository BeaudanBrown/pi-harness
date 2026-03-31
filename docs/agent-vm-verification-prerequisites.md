# Agent VM Verification Prerequisites

This document locks the environment assumptions for the later workflow-alpha
manual verification run inside the always-on `agent` VM.

Keep this setup-focused:

- host share exposure into the VM
- expected guest-visible paths
- tmux entry assumptions
- required operator tooling before any workflow-alpha commands run

The step-by-step runbook now lives in
[`docs/agent-vm-verification-runbook.md`](/home/beau/host/projects/pi-harness/docs/agent-vm-verification-runbook.md).

## Required Share Exposure

The repo must be exposed through the host share boundary, not copied into the
guest manually.

On the NAS host, expose the repo with:

```sh
sudo agent-share add ~/documents/projects/pi-harness projects/pi-harness
```

The harness treats `/home/beau/host/.pi-hub/shares.json` as the authoritative
exposure gate. If the repo is not present there, workflow-alpha verification is
out of contract because the VM is no longer testing the shared-path model.

## Expected Guest Path Layout

After the share is configured, the agent VM should see the repo at:

- `/home/beau/host/projects/pi-harness`

Verification should use that shared path as the working tree. Do not run the
manual check from a guest-local copy such as `/home/beau/projects/pi-harness`.

The workflow-alpha setup also assumes the broader host share root is present:

- `/home/beau/host/.pi-hub/shares.json` for the share registry
- `/home/beau/host/projects/` for shared project paths

If the repo is git-backed, the later isolated-context flow is expected to
create harness-owned worktrees under:

- `~/.local/share/pi-harness/worktrees/<workstream-id>/<context-id>/`

The durable workstream and runtime state roots are expected at:

- `~/.local/state/pi-harness/workstreams/`
- `~/.local/state/pi-harness/runtime/`

## tmux Entry Assumptions

Workflow alpha is defined around the normal `ssh agent` plus tmux operator
path.

Before starting the manual verification:

- `ssh agent` should land in the VM normally
- the normal interactive path should attach to the shared `default` tmux
  session
- the operator should be able to open splits or panes from that shared tmux
  environment

The verification setup assumes one tmux session per workstream and a shared
`default` tmux session as the outside-workstream landing point.

That means the later runbook may legitimately test both of these flows:

- `ph menu` from inside tmux
- `ph menu` or `ph attach <workstream-id>` from a shell outside tmux, where
  the harness first joins tmux before continuing

## Required Tool Availability

Before starting workflow-alpha verification, confirm these tools are available
inside the VM:

- `ph` or `pi-harness` in `PATH`
- `tmux`
- `fzf`
- `git` for git-backed attachment checks
- `nix` for the repo-managed verification gate

`fzf` is a required runtime dependency for the popup selector. If `fzf` is not
installed, the popup-switcher path is not meaningfully testable.

`ph` should come from the flake-managed install on the agent host. The setup is
not complete if the operator still depends on an ad hoc `./bin/pi-harness`
wrapper from inside the repo checkout.

## Recommended Preflight Checks

Run these checks inside the VM before attempting the manual workflow-alpha
steps:

```sh
cd /home/beau/host/projects/pi-harness
command -v ph
command -v tmux
command -v fzf
test -f /home/beau/host/.pi-hub/shares.json
nix run .#verify
```

Successful preflight means:

- the repo is reachable at the shared guest path
- the share manifest is present
- the popup dependency `fzf` is installed
- the repo's current verify gate passes before the manual operator test begins

## Scope Boundary

This prerequisite document does not define the operator command transcript.

The workflow-alpha runbook builds on this setup and captures:

- exact commands
- expected operator-visible outcomes
- runtime-status checks inside the managed tmux flow
