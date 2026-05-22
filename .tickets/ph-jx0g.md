---
id: ph-jx0g
status: closed
deps: []
links: []
created: 2026-05-22T05:28:12Z
type: bug
priority: 0
assignee: Beaudan Brown
tags: [lsp, hardening]
---
# Fix pi-lsp-extension Typebox runtime import

The packaged extension imports @sinclair/typebox but the Nix package only provides typebox, so live tests should verify tool modules can load.

## Design

Rewrite imports to typebox during postPatch, add typebox to the generated package manifest/lock, and add a live import test for symbols tool.

## Acceptance Criteria

verify-lsp-live imports a tool module that uses Typebox and passes; pi-lsp-extension builds with the updated dependency closure.

