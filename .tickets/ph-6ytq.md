---
id: ph-6ytq
status: closed
deps: []
links: []
created: 2026-05-22T05:05:52Z
type: task
priority: 1
assignee: Beaudan Brown
parent: ph-d146
tags: [lsp, test]
---
# Add LSP live test harness and fake server

Create fixture layout, fake LSP server, protocol test helpers, and a verify-lsp-live Nix app.

## Design

Use Node test with hermetic temp workspaces and JSONL protocol event logs; invoke patched extension modules directly rather than requiring an LLM session.

## Acceptance Criteria

verify-lsp-live runs fake-server tests and emits useful logs on failure without slowing the default verify gate.

