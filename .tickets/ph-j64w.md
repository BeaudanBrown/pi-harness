---
id: ph-j64w
status: open
deps: [ph-6ytq]
links: []
created: 2026-05-22T05:05:53Z
type: task
priority: 2
assignee: Beaudan Brown
parent: ph-d146
tags: [lsp, test]
---
# Test status and setup guidance behavior

Cover startup failure guidance, status details, capability reporting, and error clearing.

## Design

Use fake missing commands and fake server capabilities to assert generic setup hints and status output.

## Acceptance Criteria

Tests show last errors appear, hints stay generic/project-owned, and errors clear after successful start.

