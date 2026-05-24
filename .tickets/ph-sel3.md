---
id: ph-sel3
status: closed
deps: []
links: []
created: 2026-05-24T02:45:25Z
type: epic
priority: 2
assignee: Beaudan Brown
tags: [pi, nix, extensions]
---
# Nixify Pi extension resources

Make pi-harness load harness and external Pi resources as explicit Nix-packaged local extension/resource paths, with dev shadow hooks for AgentGraph.

## Design

Use passthru.piResources/resource package conventions; wrapper injects store-path resources and allows environment overrides for AgentGraph dev shadowing; update t2 pi-ag to call the robust wrapper path.

## Acceptance Criteria

pi-harness package exposes Nix-packaged resource metadata; wrapper loads harness/AgentGraph/LSP resources from store paths; verification covers wrapper args/resources; t2 pi-ag shadows AgentGraph via env override without reimplementing Pi resource discovery.


## Notes

**2026-05-24T02:55:31Z**

CLOSEOUT: pi-harness now packages harness resources separately with piResources metadata, injects Nix-store resource paths from the wrapper, supports AgentGraph resource shadow env vars, documents the workflow, and t2 pi-ag uses the new shadow hook. Verification: nix run .#verify; nix build /home/beau/documents/projects/t2#pi-ag --no-link.
