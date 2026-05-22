---
id: ph-o6be
status: open
deps: [ph-3w1e]
links: []
created: 2026-05-22T02:18:13Z
type: feature
priority: 2
assignee: Beaudan Brown
parent: ph-at8u
tags: [lsp, agents]
---
# Improve LSP status and capability reporting

Make LSP status useful to agents before they rely on navigation/refactor tools.

## Design

Improve /lsp or equivalent status output to report server command, running/starting state, workspace root, diagnostics count, and useful advertised capabilities such as definition, references, rename, code actions, completion, and workspace symbols.

## Acceptance Criteria

Agents can decide whether diagnostics, definition, references, rename, and code actions are likely available before relying on them.

