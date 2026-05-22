---
id: ph-ybme
status: open
deps: [ph-6ytq]
links: []
created: 2026-05-22T05:05:52Z
type: bug
priority: 1
assignee: Beaudan Brown
parent: ph-d146
tags: [lsp, bug]
---
# Harden workspace symbol fan-out

Make workspace symbol queries capability-aware, concurrent, and timeout-bounded.

## Design

Skip unsupported servers, query supported/unknown servers in parallel, return partial results with warnings, and preserve tree-sitter fallback.

## Acceptance Criteria

Tests cover multi-server success, failure, timeout, capability skip, and fallback behavior.

