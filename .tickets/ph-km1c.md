---
id: ph-km1c
status: closed
deps: []
links: []
created: 2026-05-24T02:45:35Z
type: task
priority: 2
assignee: Beaudan Brown
parent: ph-sel3
tags: [pi, nix, extensions]
---
# Package pi-harness resources with piResources metadata

Move harness-owned Pi resources into a first-class Nix resource derivation and expose paths through passthru metadata.

## Design

Add a pi-harness-resources derivation that copies config/agent, provides piResources metadata, and keeps Node peer dependency resolution deterministic.

## Acceptance Criteria

flake exposes pi-harness-resources; pi-harness package consumes resource metadata instead of project-relative paths; verify checks store-path extension/skill/prompt/theme resources.


## Notes

**2026-05-24T02:46:26Z**

Plan: add a first-class pi-harness-resources derivation with passthru.piResources; keep package wrapper separate and update flake/verify to reference the resource package.

**2026-05-24T02:48:19Z**

HANDOFF: added nix/pi-harness-resources.nix with passthru.piResources and moved harness resource packaging/typebox closure there; pi-harness now references the resource derivation; tests run: nix build .#pi-harness-resources .#pi-harness --no-link, nix run .#verify.
