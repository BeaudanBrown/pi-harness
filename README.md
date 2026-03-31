# pi-harness

Minimal local project for your pi-based coding-workstream harness.

The goal is to provide:

- A place for Pi customization, extensions, prompts, and launch helpers
- A primary Linux-only operator CLI (`pi-harness`, with `ph` alias) for agentic coding
- A Go-based local control plane for workstream state, tmux orchestration, and attachment management
- A thin Pi lifecycle extension only where the Pi hook system is the cleanest integration boundary
- A Nix flake and NixOS module for integration into `nix-dotfiles`
- A workstream-first session switcher that sits on top of tmux and Pi
- A local workstream registry with optional project and directory attachments

No production behavior is implemented yet.

Current design notes live in `docs/pi-hub-data-model.md`.
Agent VM workflow notes live in `docs/agent-vm-workflow.md`.
The first concrete product spec lives in `docs/workstream-switcher-v1.md`.
The locked implementation plan lives in `docs/workstream-switcher-implementation-plan.md`.
Current workstream planning context lives in `planning/session-switcher-v1/`.
The temporary local implementation loop is documented in
`docs/implementation-loop.md` and driven by
`scripts/session-switcher-local-loop.sh`.
