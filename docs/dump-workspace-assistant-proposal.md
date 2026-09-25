# Proposal: NAS-only workspace and attachment capabilities for !pi

Status: operator-approved scope; implementation and deployment pending. GitHub Issues remain the implementation task source of truth. This document records research and design, not a separate executable backlog. This is a capability upgrade beyond #90's stateless assistant acceptance.

## Agreed scope

- Start with the existing **Note to Self** chat. Do not enable additional rooms now.
- Keep chat intake, model calls, isolated project operations and publication on **NAS**. GRILL is not required for this workflow, but its existing writable project mount and normal editing workflow MUST remain available. The operator explicitly rejected reserving project writes exclusively for the agent.
- A verified owner's `!pi` request authorises the requested changes through validation and publication. **No separate publication confirmation.** Ask only when the requested change is genuinely ambiguous.
- Allow edits needed throughout the approved `dump` project, including content, templates, CSS/JavaScript and project support files. Do not restrict the feature to content-only edits.
- Existing uncommitted dump changes are part of the baseline; the operator explicitly requested committing them. Recorded as dump commit `b1a9954` (`feat(site): preserve updated syllabus navigation and styling`). The dump working tree was clean afterward. No push or publication was performed.
- File search/download/delivery should be available in **every enabled !pi chat**. Initial live testing remains Note to Self only. Enabling a chat does not automatically grant it dump or another project's filesystem authority: project bindings remain explicit.
- Sending a downloaded or approved workspace file to chat is independent of publishing it on the website. Only add it to the site when requested.
- Scope approval does not authorise host activation/restarts, secret inspection, Git pushes or arbitrary test publications. Those remain operator-controlled rollout actions.

## Baseline and research evidence (2026-09-25)

Inspected from GRILL:

- `/home/beau/documents/projects/dump` is an active NFSv4 mount of NAS's `/var/lib/dump-site/project`, not a local fallback.
- Two existing publication receipts report `published`, and an HTTPS GET to `https://dump.bepis.lol/` returned 200. This does not prove every current source file matches production or that the proposed assistant works.
- Installed `dump-publish check` passes using Hugo 0.163.3: 65 pages, three static files. Content checks pass: 50 works and ten assignment pages. JavaScript syntax and whitespace checks also passed before the baseline commit.
- Latest check log: `.pi/tmp/workers/2026-09-25T03-09-10-773Z-dump-baseline-before-commit-cc41840d915a/command.log`.
- Inspected source bases: pi-harness `359554af1ddfb1ec29212b68d23e05a841737d47`; nix-dotfiles `053f8804d234c3a33142b628d08f42f911a89a0e` with staged/modified dump modules. Preserve unrelated pending changes in both repositories.
- The existing assistant declaration is on NAS. Its worker receives question text only over a Unix socket and exposes only web search. Project tools and attachment delivery are not enabled there yet.
- Dump's current instructions require editing on GRILL, and the submission helper insists on an NFS mount. These must be deliberately revised for a NAS-local editor; do not disable mount checks globally or remove GRILL's local-fallback protection.

No NAS shell, host evaluation/build/restart, secret inspection, chat test messages or new publication requests were used for research. The baseline commit is the sole dump mutation in this planning work.

## Reuse the existing publishing module

Host-owned `dump-publish` already copies only `content/`, `layouts/`, `assets/`, `static/`, validates source, renders with pinned Hugo/fixed configuration, writes a hashed request snapshot and lets a separate NAS publisher activate a completed release atomically. Failure leaves the previous site live. A timeout means pending; a `published` receipt is required before claiming success, followed by a GET checking the affected public page.

Production configuration is host-owned; changing project `hugo.toml` does not alter production routing/security. Other project files remain outside publication. Everything in the four publishable directories may become public, including unlinked page-bundle files.

The publisher already has a dedicated Unix identity and systemd restrictions. That protects publication; it does not sandbox the editor. Existing managed project Pi sessions run with operator authority, not enforced project isolation.

## Pi sandboxing findings

Inspected installed Pi 0.85.0 README, SDK docs and example implementations:

- `cwd`, tool allowlists and project trust are not filesystem confinement. Extensions are executable code; project trust permits loading that code.
- The SDK supports explicit custom tools and a custom empty resource loader. Retain this pattern in the credential-owning model runtime.
- `examples/extensions/sandbox/index.ts` wraps **bash/user bash only**, not file tools. Project configuration overrides global configuration, its default read policy is a denylist, and disabled/unsupported/failed initialization falls back to local bash. Do not deploy it unchanged as an enforced sandbox.
- `examples/extensions/gondolin/index.ts` routes all seven built-in tools into a micro-VM with a workspace mount. Useful as an operations-routing example, but it does not sandbox arbitrary harness extensions and adds QEMU/guest packaging. No runtime evaluation was performed.
- Bubblewrap supplies selective mounts and namespaces, not a complete policy. Recommend a small Nix-packaged executor using these primitives plus systemd limits. This shares the host kernel; it is not VM-strength isolation.

## Proposed NAS modules and interfaces

### Trusted policy and isolated executor

Host policy maps a project key to a canonical path, authorised rooms/verified owner IDs, tools and publication authority. Bind only Note to Self to dump initially. Check identity and room policy before model invocation; GRILL or additional bridges are not prerequisites. Keep ordinary unbound chats free of project tools.

The credential-owning model runtime must have no local built-in filesystem or shell tools. All file operations, including read/search/list, cross the isolated executor interface. No ambient project extensions, direnv, package hooks or resource discovery execute in that runtime. Matrix and model credentials stay outside the executor.

Expose a synthetic workspace backed by approved dump files. Broad project editing does not grant write authority to security controls: hide Git administrative internals, agent control resources and publication queue/status internals from generic tools. Permit project support-file edits without executing them as trusted policy. Explicit trusted Git operations can be added separately if routine future commits are wanted; the existing-baseline commit instruction does not grant Git push authority.

Use only required read-only runtime closures, minimal devices/private proc and temporary storage, a credential-free environment, private process visibility, bounded CPU/memory/output/time and descendant cancellation. No host home, sibling projects, secrets, general host `/run`, SSH-agent/systemd/Docker/Nix-daemon sockets or inherited file descriptors. No executor network by default. Fail closed if isolation cannot start; never retry locally.

Initial tools: read/list/search/edit/write, controlled rename/delete if needed, and typed check/prepare/publish/status. No general shell, sudo, package installation or infrastructure deployment. Enforce path/symlink/hard-link/special-file/race safety; do not rely on string-prefix path checks or a shared Unix UID. Ensure writable parents cannot replace protected control mounts.

### Automatic publication

Use a host-owned publishing adapter with fixed project, executable and Hugo paths. Do not expose arbitrary CLI overrides (`--project`, `--state`, `--hugo`), `consume`, `rollback` or shell command input. Generic tools cannot write ready requests/status or live releases.

For each authorised edit-and-publish task: finish edits, freeze a validated snapshot, bind its digest and request identity to that task, enqueue once, observe the receipt, verify the live result and reply. **This is an internal integrity step, not a human approval gate.** Source changes after preparation cannot silently change what is published.

The current submit command creates a fresh request ID each time; add an idempotent prepare/submit/status seam. Persist operation identity before dispatch and reconcile the same identity after restart/timeout. Never blindly repeat edits or publication after an uncertain result. Serialize agent operations using the executor's project lease; it coordinates cooperating agents only, not normal GRILL editors. Preserve GRILL's writable mount and do not require human editors to acquire this lease or stop before activation. Detect changed source digests and reject detected conflicts; freeze and validate publication inputs rather than rendering a changing live tree. A final digest check is NOT atomic compare-and-swap against an external editor: simultaneous edits can still race. Do not claim strict multi-writer transaction safety or change host permissions to obtain it. Publication integrity and agent retry safety remain required; arbitrary host-owner actions are outside the sandbox threat model.

Add an explicit trusted NAS-local source mode proving the configured canonical backing directory and expected storage/ownership. Preserve the existing GRILL NFS guard. Run checks/Hugo with filesystem and network restrictions too: writable templates must not gain general host access. Keep the separate NAS publisher and operator-only rollback.

### Download and file delivery

Reuse managed-session artifact validation, Matrix media upload and attachment formatting where compatible. Current `remote_artifact_export` supports approved files, PDFs, images/audio and a 25 MiB cap. Inspect its retry/lifecycle dependencies before extraction; owner-account bridge delivery must retain its conservative uncertain-send policy rather than inheriting engineering-relay retries blindly.

Download only legitimate publicly accessible sources into private temporary staging. Enforce public-network egress policy including redirects/DNS changes, no private/internal/metadata addresses, bounded size/time, signature/type checks and safe filenames. Search results and documents are untrusted data, not instructions. Do not load auth from the browser or fetch authenticated/private sources by default. Download workers must not see workspace or provider/Matrix credentials.

Transfer only approved workspace files or validated staged downloads. Do not accept arbitrary host paths or model-selected destination rooms. The credential-owning transport uploads bytes and replies in the authorised originating room. Record durable upload/send identities, bound retention, reconcile ambiguous sends and clean temporary data safely. File delivery does not implicitly submit website content.

Reuse the existing conservative media cap initially, subject to actual homeserver/bridge limits. Test PDF delivery through Note to Self on Signal; Matrix acceptance alone is not downstream delivery proof. Additional enabled chats gain attachment capability without automatically gaining project access.

## Implementation sequencing and verification

Before implementation, publish scoped GitHub issues for harness work and explicitly record dependent dotfiles/publisher and dump-documentation ownership. Keep #90's original live transport acceptance separate.

1. Define host-owned project/tool policy and package the NAS executor; prove confinement using disposable fixtures without model calls or publication.
2. Connect exact SDK tools with no ambient resources. Test positive edits and negative out-of-root reads/writes, secrets/sockets/process access, symlink/race attacks, malicious project resources and failed startup.
3. Adapt publisher local-source verification and retry-safe task-bound automatic submission. Test invalid builds, simultaneous edits, crashes before/after enqueue/activation/receipt and recovery without duplicate work.
4. Extract reusable attachment mechanics; implement restricted download staging, export paths and durable owner-account delivery. Test malformed/oversized files, SSRF/redirect/DNS cases, forged senders/rooms, duplicate events and interrupted uploads/sends.
5. Update dump instructions for the approved NAS-only path and automatic publication; retain correct GRILL manual workflow and fixed publication inputs.
6. After operator-approved deployment, test one reversible requested edit from Note to Self through publication, an invalid edit preserving the live site, a requested public PDF attachment, unauthorized events and restarts. Existing dirty baseline is now committed; no other chats need enabling.

Focused sandbox/protocol checks precede affected chat/managed regressions and canonical harness verification. Run packaged checks in the intended NAS isolation environment; do not equate local tests with deployed enforcement. Review Standards and Spec together at the epic boundary. No publication confirmation flow should be introduced during implementation.

## Primary sources

- `/home/beau/documents/projects/dump/{AGENTS.md,README.md,flake.nix}` and executed `tests/check_content.py`.
- `/home/beau/documents/nix-dotfiles/specs/dump-publishing.md` and `modules/hosted-services/dump/{grill.nix,nas.nix,package.nix,publish.py}`.
- `nix/bridge-chat.nix`, `config/agent/extensions/bridge-chat/model.mts`, [chat contract](bridge-chat-assistant.md), `nix/module.nix`.
- `config/agent/extensions/managed-sessions/relay/artifact-export.ts`, managed-session contracts/adapter and [managed-session runbook](managed-matrix-sessions.md).
- Installed Pi root `/nix/store/nd3v325g2l07x9l7s4wrrn7b3v9hqqrg-pi-0.85.0/libexec/pi/`: `README.md`, `docs/sdk.md`, `examples/extensions/sandbox/index.ts`, `examples/extensions/gondolin/index.ts`.
- External primary design references (not evidence of installed enforcement): https://github.com/containers/bubblewrap/blob/main/README.md and https://github.com/anthropics/sandbox-runtime/blob/main/README.md.
