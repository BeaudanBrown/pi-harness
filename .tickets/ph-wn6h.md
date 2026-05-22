---
id: ph-wn6h
status: closed
deps: [ph-3w1e]
links: []
created: 2026-05-22T02:18:13Z
type: feature
priority: 2
assignee: Beaudan Brown
parent: ph-at8u
tags: [lsp, nix]
---
# Expand low-risk language and server mappings

Align extension language/server defaults with LSP packages already installed by pi-harness.

## Design

Add mappings only where the harness already provides stable language server commands, such as Nix, JSON, HTML, CSS, Bash, YAML, Dockerfile, Lua, and C/C++ as appropriate. Preserve project-local PATH shadowing.

## Acceptance Criteria

Mapped languages start the expected harness fallback server when no project-local server shadows it, and existing project-local language server precedence remains documented and intact.


## Notes

**2026-05-22T02:48:27Z**

HANDOFF: Added low-risk pi-lsp-extension mappings for installed fallback servers (Nix/nil, OCaml/ocamllsp, C/C++/clangd, Lua, Bash, JSON/HTML/CSS, YAML, Dockerfile, TOML, Markdown, Terraform) and Dockerfile filename detection; documented PATH precedence and added verify greps; tests run: nix build .#pi-lsp-extension --no-link, nix run .#verify; remaining risk: no live interactive LSP sessions exercised.
