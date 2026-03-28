# Agent VM Workflow

## Goal

This repo is iterated on primarily inside the always-on `agent` VM.

## Current Bootstrap Path

Until the project is exposed through `agent-share`, sync the repo into the VM
as a normal working copy:

```sh
bin/agent-vm-sync
```

This copies the local repo to:

- `/home/beau/projects/pi-harness` inside the `agent` VM

## Future Preferred Path

Once the NAS host exposes this repo through:

```sh
sudo agent-share add ~/documents/projects/pi-harness projects/pi-harness
```

the harness should treat the shared manifest under `/home/beau/host/.pi-hub/`
as the authoritative exposure gate.

At that point the hub can merge:

- tracked projects
- shared projects
- guest-local runtime session state

## Notes

- Syncing into the VM now is a bootstrap convenience, not the final share model.
- The VM copy preserves git history because the sync includes `.git/`.
