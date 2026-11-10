# Domain Documentation

Before engineering work, read the repository `AGENTS.md`, `README.md`, and relevant files under `docs/`. This repository is a thin Nix-distributed configuration layer for Pi; preserve that boundary when proposing new extensions or workflows.

Durable architecture decisions and their domain terminology live under `docs/architecture/decisions/`. Read the relevant ADR before changing the associated workflow. Create a new ADR only when active domain modeling resolves a durable term or design decision; do not create speculative glossaries.

For the Matrix–Pi bridge replacement, the approved vocabulary, native ownership,
delivery and archive contracts are defined in
`docs/architecture/decisions/0003-matrix-pi-bridge.md`. ADR 0002 is the historical
managed-session implementation record, not the replacement target. Deployment
readiness and the exact verified candidate/publication/cutover handoff are recorded
in `docs/matrix-pi-release.md`; per-issue technical evidence remains in
`docs/matrix-pi-bridge-evidence.md`.
