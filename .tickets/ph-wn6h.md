---
id: ph-wn6h
status: open
deps: [ph-3w1e]
links: []
created: 2026-05-22T02:18:13Z
type: feature
priority: 2
assignee: Beaudan Brown
parent: ph-at8u
tags: [lsp, nix]
---
# Expand low-risk language and server mappings

Align extension language/server defaults with LSP packages already installed by pi-harness.

## Design

Add mappings only where the harness already provides stable language server commands, such as Nix, JSON, HTML, CSS, Bash, YAML, Dockerfile, Lua, and C/C++ as appropriate. Preserve project-local PATH shadowing.

## Acceptance Criteria

Mapped languages start the expected harness fallback server when no project-local server shadows it, and existing project-local language server precedence remains documented and intact.

