# Agent VM Workflow

## Goal

This repo is iterated on primarily inside the always-on `agent` VM.

## Required Path

This repo should be exposed into the `agent` VM through the host share
boundary, not copied into the guest over SSH.

Expose it on the NAS host with:

```sh
sudo agent-share add ~/documents/projects/pi-harness projects/pi-harness
```

After that, the canonical guest-visible path is:

- `/home/beau/host/projects/pi-harness`

and the harness should treat the shared manifest under
`/home/beau/host/.pi-hub/` as the authoritative exposure gate.

At that point the hub merges:

- tracked projects
- shared projects
- guest-local runtime session state

## Existing SSH/Tmux Interface

The normal entrypoint remains:

- `ssh agent`
- or the existing `super+a` launcher on work machines

That path should continue to attach to the shared `default` tmux session inside
the VM.

Start pi manually from shell:

- `cd /home/beau/host/projects/pi-harness`
- `pi-harness` (or `pi`)

You can keep using tmux splits/panes for execution tasks around the UI:

- open a split/pane in `default`, `cd /home/beau/host/projects/pi-harness`, and run `pi-harness`

In this setup, `pi-harness` is installed from the flake input on the agent and should be available in PATH after you rebuild/deploy the host, so you do not need `./bin/pi-harness` anymore.

## Non-Goal

Do not maintain a separate guest-local copy of `pi-harness` under
`/home/beau/projects/pi-harness`.
