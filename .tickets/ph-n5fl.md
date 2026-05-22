---
id: ph-n5fl
status: closed
deps: [ph-0es9, ph-o6be, ph-ypfu, ph-wn6h, ph-omy2, ph-6ze8]
links: []
created: 2026-05-22T02:18:13Z
type: chore
priority: 2
assignee: Beaudan Brown
parent: ph-at8u
tags: [lsp, maintenance]
---
# Evaluate pi-lsp-extension patch size and fork threshold

Decide whether local pi-harness patches remain maintainable or whether pi-lsp-extension-src should become a fork/input branch.

## Design

After implementation, inspect patch LOC and complexity against the agreed threshold. Prefer staying local under roughly 500-800 LOC; recommend fork/upstream if patches become large or architectural.

## Acceptance Criteria

A ticket note documents patch size/complexity and recommends either staying with local patches or moving to a fork/upstream branch.


## Notes

**2026-05-22T03:00:27Z**

HANDOFF: Evaluated pi-lsp-extension local patch footprint: 5 patch files, 658 total patch-file lines, 355 changed source lines (+321/-34) plus two small Nix postPatch substitutions for OCaml mappings. Complexity remains localized to generic bridge behavior (file sync, status/capabilities, setup guidance, language mappings, all-server workspace symbols) with no architectural fork point; recommend staying with local Nix-applied patches for now and reconsidering fork/upstream once patches exceed roughly 500-800 changed source lines, require coordinated upstream refactors, or add cross-file state/lifecycle abstractions. Tests run: nix run .#verify passed. Remaining risk: no live interactive LSP session was exercised.
