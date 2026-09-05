# Aloop worktree compatibility trial

Issue #82; Linux trial on the clean `e351384` baseline, before the remaining
reliability changes. This is compatibility evidence, not acceptance verification
of the later implementation.

## Observations

A disposable detached linked checkout was created under the repository's ignored
temporary root. Git recognized its `.git` file and clean source state. Nix
Git-backed source-contract and TypeScript-build checks passed there.

Ignored `.pi-types` state was absent initially: a linked checkout does **not**
inherit the source checkout's generated environment. Entering this repository's
existing declared Nix dev shell recreated its documented Node/typebox/Pi type
symlinks. With a minimal host PATH, TypeScript and its language server resolved
from that shell, `tsc --project tsconfig.json --noEmit` passed, and source/index
state remained clean. No new environment wrapper was introduced. The trial
checkout was removed after checking cleanliness; the original checkout's files,
index, branch and partial implementation were untouched.

An initial probe erroneously expected a local `typescript/package.json` link;
that is not part of this shellHook. The corrected strict probe checked the
actually declared type symlinks and ran the compiler. The earlier non-strict
probe is not acceptance evidence.

## Decision

Do not enable automatic worktree isolation in this change. This repository is
compatible after explicitly re-entering its declared environment, but that does
not prove compatibility for repositories with sibling paths, generated assets,
project service sockets, direnv approvals, or other ignored state. The concrete
failure modes addressed here are preservation/publication, environment
availability, deadlines and terminal outcomes; they do not require changing
workspace topology.

If later evidence justifies isolation, use one issue-owned execution checkout
across implementation, correction and verification—not one checkout per
subprocess—and trial each relevant project environment first. Same-issue partial
work must continue to block duplicate execution. Linked worktrees share Git
metadata and host access: they are not security sandboxes or durable backups.
