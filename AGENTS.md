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

## Agent skills

### Issue tracker

GitHub Issues are the sole task source of truth. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the configured GitHub lifecycle labels. See `docs/agents/triage-labels.md`.

### Domain docs

Read project guidance and relevant documentation before work. See `docs/agents/domain.md`.

### Issue implementation

Use the preflight, acceptance-evidence, scope-ownership, one-pass review, and final verification ladder in `docs/agents/implementation-workflow.md`. Crash-boundary analysis is conditional on persistent state, retries, concurrency, or external side effects.

### Browser automation

Use the `playwright-browser` skill and `pi-playwright` interface for stateful browser exploration. Prefer project adapters for application work and the harness fallback only for disposable exploration when no project Playwright setup exists.

## Verification

- Canonical deterministic gate: `nix run .#verify` (also exported through `nix flake check`).
- LSP changes additionally require `nix run .#verify-lsp-live`.
- See `docs/verification.md` for focused checks and test classification.
