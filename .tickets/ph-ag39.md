---
id: ph-ag39
status: open
deps: [ph-6ytq]
links: []
created: 2026-05-22T05:05:53Z
type: bug
priority: 1
assignee: Beaudan Brown
parent: ph-d146
tags: [lsp, mapping]
---
# Correct fallback language mappings and command checks

Fix SCSS/LESS language IDs and validate fallback server command availability.

## Design

Map .scss/.less to scss/less with vscode-css-language-server configs; add Nix verify checks for configured fallback commands.

## Acceptance Criteria

Mappings are correct and verify-lsp-live fails if a default fallback command is missing.

