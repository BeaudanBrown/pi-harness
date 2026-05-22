---
id: ph-ypfu
status: open
deps: [ph-3w1e]
links: []
created: 2026-05-22T02:18:13Z
type: feature
priority: 2
assignee: Beaudan Brown
parent: ph-at8u
tags: [lsp, symbols]
---
# Query all running servers for workspace symbols

Avoid workspace symbol failures caused by selecting the wrong first running language server.

## Design

Change workspace symbol search to query all initialized running LSP servers, merge and dedupe results where practical, and report per-server failures without failing the whole request.

## Acceptance Criteria

If TypeScript returns No Project but OCaml is healthy, workspace symbol search still returns OCaml or tree-sitter results or a mixed-status summary.

