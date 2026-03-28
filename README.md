# pi-harness

Minimal local project for your pi-based coding-workstream harness.

The goal is to provide:

- A place for pi customization (extensions, prompts, themes, skills)
- A thin executable entrypoint (`pi-harness`) for your launch workflow
- A Nix flake and NixOS module skeleton for integration into `nix-dotfiles`
- A PI-native hub model for merging tracked projects with the agent VM share set

No production behavior is implemented yet.

Current design notes live in `docs/pi-hub-data-model.md`.
