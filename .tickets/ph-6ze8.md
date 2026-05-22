---
id: ph-6ze8
status: closed
deps: [ph-0es9, ph-o6be, ph-ypfu, ph-wn6h, ph-omy2]
links: []
created: 2026-05-22T02:18:13Z
type: task
priority: 2
assignee: Beaudan Brown
parent: ph-at8u
tags: [lsp, docs]
---
# Document agent-facing LSP operating model

Document how agents should use the Pi LSP tools and what the harness intentionally does not solve.

## Design

Update pi-harness docs with the model: project environment owns dependencies, language server owns semantics, Pi extension owns protocol plumbing. Include recommended tool order, shadowing guarantee, and when to fall back to rg/tree-sitter.

## Acceptance Criteria

README or docs explain how agents should use LSP tools, how project-local language servers shadow fallbacks, and which dependency problems remain project-owned.


## Notes

**2026-05-22T02:58:34Z**

HANDOFF: Added docs/lsp-agent-operating-model.md and linked README LSP notes documenting agent LSP workflow, PATH shadowing of harness fallbacks, project-owned dependency/config boundaries, and rg/tree-sitter fallback cases; tests run: nix run .#verify passed; remaining risk: no live interactive LSP session exercised.
