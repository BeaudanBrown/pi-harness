---
id: ph-at8u
status: closed
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

**2026-05-22T02:34:02Z**

HANDOFF from ph-o6be: /lsp status now reports server state/root/command/diagnostic counts and key advertised capabilities; daemon-backed clients fetch capabilities through a small local pi/serverCapabilities bridge for future agent-facing docs.

**2026-05-22T02:42:33Z**

HANDOFF from ph-omy2: LSP diagnostics and status now surface project-owned setup guidance for TypeScript No Project, missing Node types, unresolved modules, and missing server commands without installing deps or generating config.

**2026-05-22T02:48:27Z**

HANDOFF from ph-wn6h: Harness fallback LSP mappings now cover installed servers including nil, ocamllsp, clangd, lua-language-server, bash-language-server, vscode JSON/HTML/CSS, yaml-language-server, docker-langserver, taplo, marksman, and terraform-ls; project-local PATH shadowing remains documented.

**2026-05-22T02:55:24Z**

HANDOFF from ph-ypfu: Workspace symbol search now queries all running LSP servers and reports per-server result/failure summaries before falling back to tree-sitter.

**2026-05-22T02:58:34Z**

HANDOFF from ph-6ze8: Agent-facing LSP operating model is now documented in docs/lsp-agent-operating-model.md and linked from README; this should unblock patch-size/fork-threshold evaluation with the intended user-facing model captured.

**2026-05-22T03:00:27Z**

HANDOFF from ph-n5fl: Patch-size review recommends keeping pi-lsp-extension as local Nix-applied patches for now: current footprint is 5 patch files / 658 patch-file lines / 355 changed source lines (+321/-34), below the 500-800 changed-LOC fork threshold and still generic/localized.

**2026-05-22T03:00:36Z**

CLOSEOUT CHECK: All child tickets are closed. Epic acceptance criteria are represented by completed handoffs for document sync, all-server workspace symbols, status/capabilities, fallback mappings, setup guidance, operating docs, and fork-threshold evaluation; nix run .#verify passed on 2026-05-22. Remaining validation risk across the epic: no live interactive LSP session was exercised in these iterations.

**2026-05-22T03:00:57Z**

All descendant tickets are closed; closing epic after ph-n5fl.
