---
id: ph-0es9
status: open
deps: [ph-3w1e]
links: []
created: 2026-05-22T02:18:13Z
type: feature
priority: 2
assignee: Beaudan Brown
parent: ph-at8u
tags: [lsp, protocol]
---
# Patch LSP document-open reliability

Add generic ensure-target-file-opened/synced behavior before text-document LSP requests.

## Design

Patch pi-lsp-extension file synchronization so hover, definition, references, document symbols, diagnostics, rename, code actions, and completions receive a didOpen/didChange state when a server is running. Keep this language-agnostic.

## Acceptance Criteria

File-scoped LSP tools no longer fail merely because Pi read the file before the server started or because the server has not received didOpen.

