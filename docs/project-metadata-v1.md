# Repo-Local Project Metadata V1

This document defines the v1 contract for repo-local `.pi/project.yaml`
metadata consumed by `pi-harness`.

The goal is narrow: lock the meaning of each manifest field so metadata import,
context labeling, and later attachment-shortcut work do not need to infer field
semantics from parser code or scattered planning notes.

## File Shape

- manifest path: `<repo>/.pi/project.yaml`
- format: YAML mapping with known fields only
- unknown fields: invalid for v1 and treated as an invalid metadata import
- missing manifest: clean fallback to "no repo metadata"
- invalid manifest: import degrades to "invalid repo metadata" without blocking
  the enclosing workstream or path attachment

## Field Catalog

### `id`

- required: optional
- purpose: stable project identifier used for correlation across imported
  metadata and attached workstream contexts
- constraints:
  - when present, it must be a lowercase slug matching
    `^[a-z0-9]+(?:-[a-z0-9]+)*$`
  - it should remain stable across repo renames or display-name changes
  - it is not the operator-facing label by itself
- fallback behavior:
  - if omitted, the repo can still import successfully
  - later harness features that need a stable `projectId` must treat the repo as
    unlabeled for correlation rather than inventing an ID

### `name`

- required: optional
- purpose: operator-visible project label used ahead of share-key or basename
  fallbacks when the harness needs one display name for the repo
- constraints:
  - free-form string after trimming surrounding whitespace
  - should be concise and human-readable
- fallback behavior:
  - if omitted, labeling falls through to share-registry `agentPath` and then
    to the attached path basename

### `defaultBaseBranch`

- required: optional
- purpose: repo-local default branch hint for later worktree, sync, or compare
  flows
- constraints:
  - non-empty string after trimming surrounding whitespace
  - stored as metadata only; v1 import does not verify that the branch exists
- fallback behavior:
  - if omitted, the harness must not assume a repo-specific default beyond its
    normal git behavior

### `toolingFile`

- required: optional
- purpose: companion `.pi/` document path for repo-local tooling or workflow
  notes that the harness may surface later as a shortcut
- constraints:
  - path string relative to the repo-local `.pi/` directory
  - must resolve to a regular file inside `.pi/`
  - absolute paths and `..` escapes outside `.pi/` are invalid references
- fallback behavior:
  - if the field is absent, no tooling shortcut is imported
  - if the referenced file is missing, unreadable, or invalid, base metadata
    still imports and only this shortcut is dropped with a warning

### `notesFile`

- required: optional
- purpose: companion `.pi/` document path for repo-local notes that the harness
  may surface later as a shortcut
- constraints:
  - path string relative to the repo-local `.pi/` directory
  - must resolve to a regular file inside `.pi/`
  - absolute paths and `..` escapes outside `.pi/` are invalid references
- fallback behavior:
  - if the field is absent, no notes shortcut is imported
  - if the referenced file is missing, unreadable, or invalid, base metadata
    still imports and only this shortcut is dropped with a warning

### `active`

- required: optional
- purpose: explicit repo-metadata availability toggle for harness features that
  offer project-based shortcuts or labels
- constraints:
  - boolean value
  - defaults to `true` when omitted
- fallback behavior:
  - `false` keeps the manifest readable but marks the metadata as intentionally
    inactive for harness consumers
  - v1 import still loads the metadata record so callers can decide how to hide
    or suppress inactive repos

## Example

```yaml
id: pi-harness
name: Pi Harness
defaultBaseBranch: main
toolingFile: tooling.md
notesFile: notes.md
active: true
```

## Imported Result

When import succeeds, the harness records:

- manifest-backed fields: `id`, `name`, `defaultBaseBranch`, `active`
- resolved absolute paths: `metadataFile`, `repoPath`, `toolingFile`,
  `notesFile`
- import status: `loaded`, `loaded-with-warnings`, `missing`, or `invalid`

This keeps the manifest contract small while letting the harness keep absolute
paths and warning state in its own imported representation.
