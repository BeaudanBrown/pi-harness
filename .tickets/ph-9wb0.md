---
id: ph-9wb0
status: closed
deps: [ph-cl8o]
links: []
created: 2026-05-24T02:45:35Z
type: task
priority: 2
assignee: Beaudan Brown
parent: ph-sel3
tags: [pi, nix, agentgraph]
---
# Support AgentGraph dev shadowing

Allow AgentGraph resources and commands to be overridden by environment variables for fast local iteration.

## Design

Add PI_HARNESS_AGENTGRAPH_ROOT-style resource root override and use AGENTGRAPH_CLI/POSTGRES defaults only when unset.

## Acceptance Criteria

normal wrapper uses Nix store AgentGraph resources; dev env can point resources at a checkout without rebuilding; verify covers override hooks.


## Notes

**2026-05-24T02:50:28Z**

Plan: add PI_HARNESS_AGENTGRAPH_ROOT plus per-resource-dir overrides to pi-harness/bin/pi, preserve AGENTGRAPH_* command overrides, and verify the generated wrapper contains the shadow hooks.

**2026-05-24T02:51:37Z**

HANDOFF: added PI_HARNESS_AGENTGRAPH_ROOT and per-directory shadow hooks to pi-harness/bin/pi, exporting AGENTGRAPH_PI_RESOURCES from the chosen root and fail-fast checking extension/skill/prompt paths; tests run: nix build .#pi-harness --no-link, nix run .#verify.
