---
id: ph-n5fl
status: open
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

