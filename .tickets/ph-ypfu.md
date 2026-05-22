---
id: ph-ypfu
status: closed
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


## Notes

**2026-05-22T02:55:24Z**

HANDOFF: Added pi-lsp-extension workspace-symbol patch to query every initialized running server, merge/dedupe symbol results, preserve tree-sitter fallback, and include per-server result/failure summaries; verification: nix build .#pi-lsp-extension --no-link and nix run .#verify passed; remaining risk: no live interactive multi-LSP session was exercised.
