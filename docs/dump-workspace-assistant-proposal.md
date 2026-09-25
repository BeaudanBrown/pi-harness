# NAS !pi project and file capabilities (#97)

Status: implementation and cumulative review complete; consuming revision handoff and operator-controlled activation remain. GitHub Issues are the task source of truth. This document records the latest operator-approved scope and supersedes the earlier staged/transactional proposal.

## Approved behavior

- Start in existing Note to Self only; the operator can add other chats later.
- NAS handles chat, model requests, sandboxed project operations and publishing. GRILL is not required, but its writable project mount and normal editing remain unchanged.
- Give the agent ordinary file operations throughout the approved dump project (except protected control/credential paths), and simple `check`, `publish`, `status` commands. It chooses how to complete the request, not a prescribed sequence.
- A clear site-change request authorises publication without another confirmation. The existing publisher validates before activation. Ask only for genuinely ambiguous requests.
- Assume one editor at a time. Do not add project locks, mandatory digests, mutation journals, prepare/commit stages, snapshot approval or transaction orchestration.
- Keep filesystem confinement, credential separation, safe downloads, bounded tools and the publisher's existing snapshot/receipt handling. Interrupted publication needs status inspection, not a blind repeat.
- File download/delivery should work in every enabled chat. Project filesystem access remains explicitly bound to rooms and is not automatically granted to other chats.
- A file requested just for chat is staged privately on NAS and cleaned after delivery or bounded retention. Adding it to dump uses its inbox/appropriate content location and publishes only when requested.
- Reuse existing managed-session artifact validation/media upload concepts where applicable; don't copy the engineering relay's lifecycle or retry machinery wholesale.
- No changes to the tools, prompts, restrictions or background services of ordinary Pi CLI sessions. These capabilities belong only to the dedicated chat worker and opt-in host services.

## Responsibility split

**Harness:** reusable isolated file operations, named-command interface, room capability checks, download/send-file support. No hard-coded dump workflow.

**Project:** AGENTS/README explain structure, content conventions and available commands. Project instructions can guide work but cannot grant paths/tools or replace host security policy.

**Host configuration:** grants the project path to Note to Self and defines immutable command argv and permitted command data mounts. Dump's existing publisher remains separately owned in nix-dotfiles.

## Implemented so far

- Dump baseline changes committed as `b1a9954`; no push or test publication.
- Initial isolated executor foundation was committed as `a8d43a8`, then normal GRILL access clarified in `69d5dd9`.
- Current increment removes the foundation's locks/journal and adds a small ordinary file API plus named commands. See [executor contract](chat-workspace-executor.md).
- Dedicated chat SDK registers project tools only for an explicit verified room capability. Empty bindings preserve no-project access; separately enabled file tools do not grant a project. No CLI profile changes.
- Downstream publisher adds sandbox-local submit/status while preserving GRILL's existing NFS guard. It uses the existing validated source snapshot, queue, separate publisher and receipt—not a new orchestration system.
- NAS declaration prepares Note to Self's dump binding and fixed check/publish/status argv, with queue/status mounted outside generic file access.

- Public HTTPS downloads now run in a credential-free, DNS-pinned sandbox, with private bounded staging and shared artifact validation. Chat-only `download_file` and `send_file` queue validated attachments through the owner transport to the original room. The existing reply state covers interruptions without new per-file workflow/journal scaffolding.

Code, cumulative review and final verification are complete. Not yet complete: final downstream pin/activation handoff and live acceptance. Do not rebuild merely because these intermediate declarations exist.

## Verification baseline

Research confirmed the GRILL NFS mount backed by `/var/lib/dump-site/project`, prior successful receipts and HTTP 200 from the live site. Current dump content rendered 65 pages with Hugo 0.163.3; 50 works and ten assignment pages passed content checks. This is not a new assistant round trip or proof that all current sources match production.

Current checks and review dispositions live in [implementation evidence](dump-workspace-implementation-evidence.md). No secrets were inspected, no host activated/restarted, and no new production request submitted during this work. Preserve unrelated dotfiles changes and the untracked Signal proposal.

## Remaining delivery work

1. Completed: downloads/staging/owner-account attachment implementation, regression suite and actual packaged public-PDF/image sandbox probes (#100).
2. Completed: immutable host argv/data mounts and actual Hugo check/publish/status -> published receipt with disposable source/queue/release fixtures. No live publication performed.
3. Completed: full NAS and GRILL configuration dry evaluation, canonical/package gates and both cumulative review axes. Finish the consuming revision pin/availability and exact operator rebuild handoff (#101).
4. After operator activation, prove Note to Self site edits through receipt and changed-page GET, rejected builds preserving the site, public PDF delivery, owner filtering and conservative interrupted-send behavior. Additional bridges need their own live tests.

## Sources

- `config/agent/extensions/bridge-chat/`, `nix/bridge-chat.nix`, `nix/chat-workspace*.nix`, existing managed-session artifact exporter and Matrix transport.
- `/home/beau/documents/nix-dotfiles/modules/hosted-services/dump/{nas.nix,grill.nix,publish.py,test_publish.py}` and `specs/dump-publishing.md`.
- `/home/beau/documents/projects/dump/{AGENTS.md,README.md}`.
- Installed Pi 0.85.0 README/SDK docs and sandbox/Gondolin examples. Pi's bash-only sandbox example is not used unchanged: it leaves file tools outside isolation and allows local fallback.
- https://github.com/containers/bubblewrap/blob/main/README.md and `network.c` (private loopback setup uses route netlink).
