---
id: ph-inh3
status: open
deps: [ph-6ytq]
links: []
created: 2026-05-22T05:05:52Z
type: bug
priority: 0
assignee: Beaudan Brown
parent: ph-d146
tags: [lsp, bug]
---
# Fix document sync protocol semantics

Prevent duplicate didOpen and refresh stale content before file-scoped requests.

## Design

Track documents by stable LSP server identity and content hash; send didOpen only once per server identity and didChange when content changes.

## Acceptance Criteria

Tests prove first request opens, repeat request does not duplicate didOpen, file changes send didChange, and new server identities get one fresh didOpen.

