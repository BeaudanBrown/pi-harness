---
id: ph-3w1e
status: closed
deps: []
links: []
created: 2026-05-22T02:18:13Z
type: task
priority: 2
assignee: Beaudan Brown
parent: ph-at8u
tags: [lsp, docs]
---
# Document current LSP behavior and failure modes

Capture observed LSP problems and intended non-goals: unopened document failures, TypeScript No Project, missing TypeScript deps, first-running-server workspace symbol issue, and project-local shadowing requirements.

## Design

Ground the work with a short docs/test note before patching behavior. Distinguish generic protocol plumbing from project-owned dependency configuration.

## Acceptance Criteria

A maintainer or agent can read the notes and understand what is intentionally fixed versus left to project environments.


## Notes

**2026-05-22T02:23:50Z**

HANDOFF: Added docs/lsp-current-behavior.md and README link documenting current pi-lsp-extension behavior, failure modes, fix boundaries, and project-owned non-goals; verification run: nix run .#verify passed; remaining risk: future LSP patch tickets should keep behavior changes aligned with this documented boundary.
