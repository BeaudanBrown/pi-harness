---
id: ph-6umx
status: open
deps: [ph-inh3, ph-ybme, ph-ag39]
links: []
created: 2026-05-22T05:05:53Z
type: task
priority: 2
assignee: Beaudan Brown
parent: ph-d146
tags: [lsp, test]
---
# Add real LSP server smoke tests

Run small real-server smoke tests for TypeScript and Nix through the patched extension.

## Design

Use tiny fixtures and assert stable shapes/status rather than fragile semantic wording.

## Acceptance Criteria

verify-lsp-live starts nil and typescript-language-server in fixtures and exercises diagnostics/status/symbol paths.

