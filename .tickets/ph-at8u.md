---
id: ph-at8u
status: open
deps: []
links: []
created: 2026-05-22T02:18:13Z
type: epic
priority: 2
assignee: Beaudan Brown
tags: [lsp, agents, pi-harness]
---
# Make Pi LSP tools reliable and transparent for agents

Improve the Pi LSP integration as a generic protocol bridge so agents get dependable diagnostics and navigation when project environments are correctly configured, without building language-specific dependency resolvers.

## Design

Use small local patches to the packaged pi-lsp-extension only for generic behavior: document sync, status/capability visibility, multi-server workspace queries, server mappings for already-installed LSPs, and clearer failure messages. Do not fork initially. Preserve project-local language server shadowing by keeping harness servers as fallbacks and avoiding early command resolution outside the project environment.

## Acceptance Criteria

Agents can use file-scoped LSP tools without document-not-found failures caused by unopened files. Workspace symbol search does not fail globally because the first running server has no project. LSP status output gives agents useful server/root/capability/diagnostic context. Harness-installed language servers have matching low-risk mappings. TypeScript missing-project/dependency failures are reported honestly without custom dependency magic. Project-local language servers continue to shadow harness fallback servers. nix run .#verify passes.


## Notes

**2026-05-22T02:23:50Z**

HANDOFF from ph-3w1e: Current LSP behavior and failure-mode boundary documented in docs/lsp-current-behavior.md; sibling LSP implementation tickets should use it as the shared scope reference.

**2026-05-22T02:28:58Z**

HANDOFF from ph-0es9: File-scoped LSP tools now route getClientForFile through FileSync.ensureFileOpen, covering files read before server startup and restarted clients without language-specific dependency logic.
