---
id: ph-omy2
status: closed
deps: [ph-3w1e]
links: []
created: 2026-05-22T02:18:13Z
type: task
priority: 2
assignee: Beaudan Brown
parent: ph-at8u
tags: [lsp, typescript]
---
# Improve dependency and config failure messages without dependency glue

Make common language-server setup failures clearer and actionable without hiding them behind automatic dependency management.

## Design

Improve messages for TypeScript No Project, missing Node types, unresolved peer deps, and similar setup failures. Recommend launching from the project dev shell/direnv or adding project-owned config. Do not auto-generate configs, install deps, or symlink arbitrary dependencies.

## Acceptance Criteria

Agents see concise guidance to fix project environment/config issues instead of assuming the LSP bridge is broken.


## Notes

**2026-05-22T02:42:33Z**

HANDOFF: Added Nix-time pi-lsp-extension setup guidance patch for TypeScript config/dependency diagnostics and startup failures; /lsp status now includes last error/setup hint; nix run .#verify passed; remaining risk is no live interactive TypeScript LSP session was exercised.
