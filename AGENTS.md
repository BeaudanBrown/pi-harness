# AGENTS for pi-harness

Project-plane instructions for the pi-harness workstream orchestrator configuration.

- Keep this repository focused on orchestration configuration, extensions, and launch helpers.
- Keep implementation notes in repo docs and commit durable decisions when behavior stabilises.
- Prefer small, composable TypeScript extension files for pi customization.
- Keep Nix integration backward-compatible so it can be optionally imported by `nix-dotfiles`.
