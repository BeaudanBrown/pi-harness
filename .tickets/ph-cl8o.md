---
id: ph-cl8o
status: closed
deps: [ph-km1c]
links: []
created: 2026-05-24T02:45:35Z
type: task
priority: 2
assignee: Beaudan Brown
parent: ph-sel3
tags: [pi, nix, wrapper]
---
# Load Pi resources through the Nix wrapper

Update the main pi wrapper and NixOS module to pass explicit local store paths for extensions, skills, prompts, themes, and LSP.

## Design

Collect resource paths in Nix and emit wrapper flags, while keeping package/update commands delegated to upstream Pi.

## Acceptance Criteria

pi wrapper invokes upstream Pi with --extension/--skill/--prompt-template/--theme store paths; LSP extension remains optional in the module; verify covers the wrapper.


## Notes

**2026-05-24T02:48:41Z**

Plan: update pi-harness/bin/pi to inject explicit Nix-store extension/skill/prompt/theme flags from piResources and AgentGraph resources, while delegating mutable package management subcommands directly to upstream Pi.

**2026-05-24T02:50:20Z**

HANDOFF: pi-harness/bin/pi now injects explicit Nix-store extension/skill/prompt/theme flags for harness and AgentGraph resources, while package-management subcommands still go straight to upstream Pi; tests run: nix build .#pi-harness --no-link, nix run .#verify.
