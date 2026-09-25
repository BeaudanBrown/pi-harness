# NAS chat implementation evidence (#97)

## Final verification

Post-review `nix run .#verify` passed all 12 checks; workspace/file live probes, all five production packages and all 15 downstream publisher tests passed. Log: `.pi/tmp/workers/2026-09-25T05-22-43-289Z-epic97-final-gate-8a3c9b88e39b/command.log`. Full GRILL toplevel dry evaluation also passed with chat, workspace and file capabilities all disabled there: `.pi/tmp/workers/2026-09-25T05-22-43-289Z-grill-chat-cli-dry-evaluation-042c121697e9/command.log`. Only documentation/evidence updates followed this gate; no runtime code changed. NAS full toplevel evaluation and disposable publisher evidence are recorded below.

## Final cumulative review disposition

Pinned review against pre-feature `359554af1ddfb1ec29212b68d23e05a841737d47`: `.pi/tmp/reviews/2026-09-25T05-18-39-891Z-worktree-f6b8875acc14-525e41e0c62c/`. Both axes inspected the same cumulative snapshot and immutable downstream publisher/config/guidance copies.

### Standards

One low-severity current-issue finding: stale executor protocol documentation. Accepted and corrected: private binary import/export, 25 MiB binary limit and 36 MiB frame are now documented. No code redesign requested.

### Spec

One low-severity current-issue finding: the same protocol documentation mismatch, corrected. One medium-severity deployment-only finding: final consuming revision/host handoff and live owner/Signal acceptance. The revision handoff is being completed; actual host activation and live acceptance remain explicitly operator-controlled. No reranking or extra subjective review after this documentation-only remediation.

## Downloads/attachments increment and cumulative local evidence

Implemented chat-only public downloads, private staging and owner-account attachment delivery. It reuses the artifact byte/type validator and Matrix HTTP boundary, adds no interactive stages/approvals, and extends the existing reply record with bounded file descriptors rather than introducing a new upload journal. NAS Note to Self configuration enables files for all currently enabled chats, with project access still independently room-bound. Ordinary CLI profiles remain unchanged.

| Acceptance | Implementation and evidence |
| --- | --- |
| Public-only, bounded downloads | `download.py` checks all DNS answers/redirects and pins the connection IP with original-host TLS; HTTPS/443 only, no credentials/proxies, 25 MiB/90-second bounds. Eight focused Python tests cover addresses, credentials, redirects/rebinding, TLS pinning, lengths and encoding. |
| Credential-free fetch/decoder | `chat-files-package.nix` mounts only a private output directory, selected immutable closures, DNS/CA data; image decoding has no network. Real W3C sample PDF fetch, loopback denial, fail-closed setup and actual PNG decoder/host-file denial pass. |
| Private files and room authority | `FileSession` accepts only current-request handles or explicitly granted workspace-relative exports. No tool accepts a room or host path. Spool limits, restrictive permissions, content hashes, expiry and cleanup are tested. Owner-account upload headers and original-room delivery are tested with fake Matrix. |
| Site additions vs chat sending | Optional download destination uses a bounded binary import into a new project file; import/export path, symlink, size, no-overwrite and rename/delete checks pass. Download/send never invokes publish. Project AGENTS documents inbox and separate publication. |
| Reply interruption safety | Existing SQLite queued/running/ready/sending/done states now carry descriptors; restart-ready delivery and uncertain-send no-retry are tested. No new per-file workflow or journal. |
| No CLI regression | Real SDK tests assert exact tools with no ambient resources; all 12 canonical checks and production `bridge-chat`, `chat-files`, `chat-workspace`, default and managed-session-relay packages pass. |
| Real publisher integration | Immutable named check/publish/status commands, actual Hugo 0.163.3, a temporary copy of the 65-page site, disposable queue and one-shot consumer produce a published receipt and atomic current release. Production source/queue/release untouched. |
| Host declaration | Full NAS toplevel derivation and all three service configs evaluate with `--no-write-lock-file --override-input pi-harness git+file:///home/beau/documents/projects/pi-harness`. No activation, consuming pin change or live owner/Signal round trip. |

Crash boundaries: temporary download before validation is private and removed in normal failure/cancellation, otherwise expires; validated but unselected blobs are removed on request completion; descriptors persist at ready before network delivery; sending is durable before the first upload; any upload/send uncertainty makes the entire batch terminal without automatic replay. Delivered files in a partial batch are not duplicated. An upload accepted before a lost acknowledgement can leave an orphan on the homeserver; no claim of automatic remote cleanup or Signal delivery. Final text is sent only after attachment acknowledgements. Successful/uncertain batches clear descriptors and local files; restart leftovers expire.

Latest logs:

- Focused tests/packages: `.pi/tmp/workers/2026-09-25T04-57-44-174Z-chat-files-focused-0ce8a8bf2bf6/command.log`.
- Real helper/workspace sandboxes: `.pi/tmp/workers/2026-09-25T05-00-40-871Z-chat-files-live-sandbox-ffb4723aa22b/command.log`.
- NAS dry evaluation: `.pi/tmp/workers/2026-09-25T05-07-07-031Z-nas-chat-dry-evaluation-1db7de4f76e8/command.log`.
- Canonical/packages: `.pi/tmp/workers/2026-09-25T05-12-10-621Z-chat-capabilities-canonical-corrected-fixtures-a7c842e3b1b9/command.log`.
- Disposable publisher integration: `.pi/tmp/workers/2026-09-25T05-12-10-621Z-dump-disposable-publisher-roundtrip-corrected-pa-b7a0c538cd71/command.log`; fixture `.pi/tmp/publisher-roundtrip.py`.

Two verification-fixture issues were corrected before those passes: lightweight module stubs needed the new tmpfiles option; the disposable integration initially assumed Nix returned build outputs in requested order. Neither was a live-host failure. Final cumulative review, consuming revision handoff and operator-controlled live acceptance remain pending. Nothing pushed or activated.

## Earlier increment: simple project tools (supersedes foundation workflow)

The operator rejected extra workflow/reliability scaffolding. This increment removes the executor's project/state locks, journal, operation IDs and mandatory digest arguments. It retains descriptor-rooted file operations, private namespaces, bounded IO and fixed host-owned commands. Ordinary GRILL editing is unchanged. `workspace` and `project_command` are registered only in dedicated chat sessions with an explicit room grant; CLI profiles are untouched.

Downstream nix-dotfiles adds sandbox-local `submit-local`/`status-local`, reusing existing validation/snapshots/receipts and preserving GRILL's NFS guard. Note to Self's NAS project binding and command mounts are prepared. Dump AGENTS/README document the simple tools and no routine publication approval. No host was activated and no production publication was submitted.

Verification before commit: all 12 canonical checks pass; actual packaged sandbox including an immutable host-command probe passes; downstream publisher suite has 15 passing tests; downstream Nix syntax and whitespace pass. Log: `.pi/tmp/workers/2026-09-25T04-29-24-767Z-pre-commit-project-tools-check-97f9433e11f6/command.log`. An earlier canonical run had one ECONNRESET in an unchanged managed real-Pi fixture (238/239 passed); the exact unchanged test derivation passed on one diagnostic re-run, followed by the successful canonical gate. It was not fixed or hidden by changing that test.

Still outstanding: #100 public downloads/attachments, #101 final downstream input pin/host checks/live acceptance, cumulative epic review. This is **not rebuild-ready**. The detailed journal/lease evidence below describes the earlier foundation only, not the current interface.

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
