# AGENTS for pi-harness

This repository is a thin Nix-distributed configuration layer for the Pi coding
agent.

## Read Order

1. This file
2. `README.md`
3. `config/agent/settings.json`
4. `nix/module.nix`
5. `nix/package.nix`

## Working Rules

- Keep this repo focused on Pi configuration and small Pi extensions.
- Do not rebuild a workstream/session manager here; use external tmux for
  multiple sessions.
- Prefer Pi's native session features: `/name`, `/resume`, `/tree`, `/fork`,
  `/compact`, `pi -c`, and `pi -r`.
- Add extensions only when they provide a concrete cross-machine workflow.
- Keep extensions small, local, and dependency-light.
- Use Nix to distribute shared config across machines.
- Do not push unless the user explicitly asks in the current session.

## Verification

- Canonical gate: `nix run .#verify`
