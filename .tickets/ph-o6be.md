---
id: ph-o6be
status: closed
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


## Notes

**2026-05-22T02:34:02Z**

HANDOFF: Added Nix-time pi-lsp-extension status patch reporting command args, state, root, diagnostic totals/files, and advertised definition/references/rename/code-action/completion/workspace-symbol capabilities; shared daemon now exposes cached server capabilities to clients; tests run: nix build .#pi-lsp-extension --no-link and nix run .#verify; remaining risk: no live interactive /lsp UI session exercised.
