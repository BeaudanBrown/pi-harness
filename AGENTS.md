# AGENTS for pi-harness

Project-plane instructions for the pi-harness workstream orchestrator configuration.

- Keep this repository focused on orchestration configuration, extensions, and launch helpers.
- Keep implementation notes in repo docs and commit durable decisions when behavior stabilises.
- Implement the harness core in Go; do not turn this repo into a Node or TypeScript application.
- Prefer the Go standard library for CLI parsing, JSON, subprocess execution, path handling, and file writes before adding external dependencies.
- Use project-local TypeScript only for narrow Pi integration boundaries where Pi lifecycle hooks are the cleanest option, and keep those extensions tiny and dependency-free.
- Target Linux only for the session-switcher v1 lane.
- Keep Nix integration backward-compatible so it can be optionally imported by `nix-dotfiles`.
