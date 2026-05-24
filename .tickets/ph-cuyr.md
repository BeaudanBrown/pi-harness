---
id: ph-cuyr
status: open
deps: [ph-9wb0]
links: []
created: 2026-05-24T02:45:35Z
type: task
priority: 2
assignee: Beaudan Brown
parent: ph-sel3
tags: [pi, nix, agentgraph, t2]
---
# Update t2 pi-ag shadow launcher

Simplify t2's pi-ag launcher to use the nix-first wrapper shadow hooks instead of manually rediscovering Pi extensions.

## Design

Set AgentGraph dev env/resource root and exec the harness pi wrapper; avoid duplicating settings.json and extension discovery logic.

## Acceptance Criteria

pi-ag still runs local AgentGraph extension/prompts/skill and dev ag/postgres commands; it no longer needs --no-extensions/manual rediscovery except as a fallback if necessary.

