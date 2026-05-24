---
id: ph-m95p
status: closed
deps: [ph-cuyr]
links: []
created: 2026-05-24T02:53:23Z
type: task
priority: 2
assignee: Beaudan Brown
parent: ph-sel3
tags: [pi, nix, docs]
---
# Document Nix resource wrapper workflow

Update README to reflect store-path resource loading and AgentGraph shadow hooks.

## Design

Replace stale settings-link/dev wrapper language with explicit wrapper flags, pi-harness-resources, and PI_HARNESS_AGENTGRAPH_* env overrides.

## Acceptance Criteria

README describes nix-first resource loading, NixOS usage, local workflow, and t2/pi-ag shadowing accurately.


## Notes

**2026-05-24T02:54:58Z**

HANDOFF: README now documents pi-harness-resources, explicit store-path wrapper loading, mutable user config boundaries, and AgentGraph PI_HARNESS_AGENTGRAPH_* shadow variables; tests run: nix run .#verify.
