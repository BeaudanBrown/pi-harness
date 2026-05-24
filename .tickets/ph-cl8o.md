---
id: ph-cl8o
status: open
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

