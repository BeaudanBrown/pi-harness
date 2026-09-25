# NAS chat implementation evidence (#97)

## Scope / preflight

Approved behavior: docs/dump-workspace-assistant-proposal.md. GitHub #97 is the epic; #98 executor, #99 publisher/local-source adapter, #100 downloads/attachments, #101 integration/rollout. Selected initial frontier: #98. No production enablement, pushes or host activation. Preserve the unrelated untracked Signal proposal and existing dotfiles changes.

## Acceptance-to-evidence matrix

| Ownership | Requirement | Implementation / intended evidence | Status |
|---|---|---|---|
| #98 | Exact file tool protocol, bounded inputs/outputs | Python executor and 17 protocol tests | passed |
| #98 | Kernel filesystem/process/network isolation, fail closed | Nix-packaged Bubblewrap launcher; real namespace/mount/environment and outside-canary checks | passed on GRILL; NAS service check remains deployment-only |
| #98 | Path, symlink, hardlink, special-file safety | Descriptor-rooted operations; adversarial file tests | passed for confined agent operations; external-writer races are not covered |
| #98 | Durable mutation identity, conservative recovery | SQLite operation journal; process-restart fault tests | passed |
| #98 | Packaged opt-in service, no ambient credentials | module evaluation/packaged launcher; disabled by default | passed |
| #99 | NAS-local fixed publisher + no repeat on uncertain submit | Publisher protocol/crash tests | dependent issue |
| #100 | Public-only download and owner-account file delivery | SSRF/media/send-recovery tests | dependent issue |
| #101 | Note to Self routing, exact SDK tools, final rollout | Integration tests, canonical verify, packages and cumulative review | dependent issue |
| deployment | NAS permissions/namespaces and Signal delivery | Operator-approved live checks after rollout | pending |

## Crash-boundary matrix (#98)

| Before | Effect | Durable identity/write | Recovery policy | Intended evidence |
|---|---|---|---|---|
| No operation | Admit mutation | Persist ID and parameter digest before filesystem change | Same ID with different parameters rejected | journal tests |
| Running | Atomic file replacement or rename/delete/mkdir | Running state remains until result commit | Restart makes operation uncertain; never repeat automatically | injected interrupted operation |
| Done | Return bounded result | Commit result before response | Same ID returns same result | replay/restart test |
| Missing sandbox | None | No admission | Fail closed, no host fallback | actual packaged-launcher failure |

Read-only operations need no durable result retention. Mutation journal stores parameter digests and bounded result metadata, not file text. Interrupted operations require explicit reconciliation before new work; no success is inferred from a lost response.

## #98 verification and review disposition

- Focused tests: 17 Python cases covering operations, malformed paths/protocol, link/special-file denial, mutation replay/conflict, crash uncertainty, journal privacy, project/state locks, bounded streaming traversal/encoded results and source-replacement rejection.
- Nix-specific traversal failure found during development: duplicating a long-lived directory descriptor retained enumeration state. Replaced it with a fresh `openat` description; focused Nix tests passed afterward.
- Affected chat/module checks passed before review. Review snapshot: `.pi/tmp/reviews/2026-09-25T03-29-38-951Z-worktree-d8e1a044fe94-834b691b1d96/`.
- Standards medium (unbounded listdir allocation) and low (oversized listing response) accepted/fixed: streaming enumeration counts hidden/rejected entries, bounded encoding and explicit truncation; added regression tests.
- Spec medium (final pathname compare/commit race with external writers): added project-wide lifetime lease, separate-state executor exclusion and cooperating-writer lock tests. Digest checks are NOT atomic CAS against external writers. Subsequent operator decision explicitly rejects exclusive deployment access: GRILL must remain writable and normal editing must not require the agent lease. The lease therefore serializes cooperating agents only. Residual races with ordinary simultaneous edits are a documented limitation, not a sandbox escape fix or pending permission to restrict GRILL. #99 must publish frozen validated snapshots; #101 must preserve normal host access. Do not claim transactional multi-writer safety.
- Final `nix run .#verify`: all 12 deterministic checks passed. `nix run .#verify-chat-workspace-live`: real packaged sandbox passed. Production `chat-workspace`, `default`, `bridge-chat`, `managed-session-relay` builds passed. LSP and whitespace clean.
- Final log: `.pi/tmp/workers/2026-09-25T03-33-58-502Z-workspace-final-verification-194ddbd6255c/command.log`. Builders were explicitly disabled for local checks after the configured remote builder was unavailable; no host rebuild was performed.
- No chat routing or downstream configuration was enabled. #99/#100/#101 and epic cumulative review remain outstanding. This is not a rebuild-ready handoff.
