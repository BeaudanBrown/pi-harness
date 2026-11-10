# Native Matrix–Pi replacement release verification (#171)

Status: focused/affected checks, cumulative accounting and full-epic paired
review complete; final canonical/package/consuming gates pending. #161–#170 are locally committed and closed. #171 owns cumulative
verification/review, deletion accounting and the publication/pin handoff, not live
effects. #172 and epic #160 remain open. **Grill/NAS are not rebuild-ready.**

## Scope and sources

Read #171, parent #160, completed blocker #170 and dependent #172; use
`docs/agents/implementation-workflow.md`, ADR 0003, the nine approved workflow
fixtures, `matrix-pi-bridge-evidence.md`, `matrix-pi-removal.md` and
`matrix-pi-migration.md`. Source implementation candidate starts at harness
`7d56191596038cb05d4dbe915918cdf46e1689e7` and downstream
`0315a85f75ebc6a05de3a981098a1f6d053c8646`. The full epic fixed points are harness
`8a96e8cfb0141ef71ffd5cc5bfd9d6e6db55495b` and downstream
`09b2f8843d6868c52cd62c4fe217ec6a97df82b9`, not #170's dual-source baseline.

Preserve unrelated research and downstream staged/unstaged/index state, real
histories/stores/rooms/processes/worktrees, installed closures and backups. Never
access the private secrets repository. Do not push, advance the published pin,
build/switch a host system, restart a live process or perform Matrix/account or
migration effects. Isolated packages and NixOS evaluation remain authorized.

## Acceptance → evidence plan

| Required scenario | Existing public-seam evidence to revalidate | Limit / owner |
|---|---|---|
| 1. Offline launch/resume; native new/fork/tree; asynchronous enrollment | Actual packaged Pi and native helper tests; adapter new/resume/tree/private startup cases | No live host reboot or visual acceptance claim |
| 2. One writer across terminal/picker/remote open; independent lifetimes; lost replies | C kernel exclusion/SIGKILL/exec inheritance, Bun/Node SessionManager, concurrent disposable tmux helper, picker requester guards, relay reconnect and runtime roots | Old writers do not honor new locks: approved quiescence is #172 |
| 3. Input/output uncertainty, deduplication and room isolation | Store/relay HTTP failures, atomic cursor, interrupted/no-replay, frozen output lost ACK, gaps/rate limits/bad room | Arbitrary external tool exactly-once is not promised |
| 4. Collaborators and privacy | Joined/outsider/ignored-bot cases, post-expansion provenance, persisted-only projection, credential-free launch | Access to the room grants access to existing agent tools |
| 5. Poll races, native controls and original images | Actual packaged adapter + injected Matrix HTTP, original PNG/caption/digests, control authentication and queue fencing | No real Matrix/model/NAS acceptance |
| 6. Independent organization/invitations | Lost creation/join replies, immutable ownership, partial links, deliberate departure and trust revocation | Matrix has no cross-client membership/state CAS |
| 7. Approved idle task handoff | Actual Git/Pi/SDK, frozen approval, every publication/hook SIGKILL boundary, duplicate retry/foreign collision, visible summary/no child turn | Lost caller/ACK is not rollback; finite approved creator can outlive daemon |
| 8. Busy/offline archive/restore | Current final projection, atomic holds/revision, fresh committed dispatch fence and sync catch-up, original grouping | Archive is not stop/delete/leave; All Rooms may retain it |
| 9. Offline identity-preserving migration | Real kernel-read-only synthetic sources, no-replace staging, SIGKILL export/import, frozen sends, held inputs and negative historical policy | Independent coherent capture/exit evidence and live receipt review remain #172 |
| Deletion and budget | Immutable before/after fixed scopes across both repos; all moved/shared code and mixed integration deltas disclosed | No test deletion or code compression to meet a number |
| Release confidence | Focused/affected checks, one paired full-epic review, batched fixes, canonical gate, actual packages and downstream checks | #170 review is not the mandatory cumulative review |
| Publication/cutover handoff | Exact source/package IDs, unchanged published input/lock, ordered separately approved canary and rollback boundary | No publication/pin/activation by #171 |

## Effect and crash boundary ownership

No new live effect executor is planned. The detailed per-boundary matrices in
`matrix-pi-bridge-evidence.md`, `matrix-pi-removal.md` and `matrix-pi-migration.md`
remain binding. Cumulative verification must cover, not replace, them:

| Boundary | Evidence and continuation rule |
|---|---|
| Lock acquisition/switch/exit and child exec | Actual kernel/SessionManager process tests; absence of attachment is not exit |
| Intake/cursor and handed-before-send | Atomic durable admission; uncertainty held, never replayed to improve liveness |
| Native persistence/output send/receipt | Only persisted eligible entries; exact frozen bytes/transaction on retry |
| Poll/approval/archive revision across awaits | Recheck current identity/ancestry/operator and committed policy; stale actions cannot revive |
| Task branch/worktree/native publication | Positive ownership and create-only operations; retain uncertain partial resources and closures |
| Room create/link/join ACK lost | Observe original frozen identity; no replacement room, blind rejoin or notification repair |
| Snapshot/export/import/publish | Read-only coherent source and private distinct staging; crash leftovers never become active |
| First runtime writer or new native evidence | Pre-start rollback eligibility ends; reconcile receipts/local-only, never restore stale queues |
| Publication/pin/activation | Source checks cause none; freeze exact approval scope before any #172 effect |

## Cumulative measurement

Use the same seven path scopes as #170, but compare the **committed full-epic
baselines and candidates** above. This excludes unrelated downstream staged work
from both sides. The read-only measurement script now supports explicit Git trees:

```sh
python3 scripts/verification/bridge-footprint.py --dotfiles /home/beau/documents/nix-dotfiles \
  --harness-ref 8a96e8cfb0141ef71ffd5cc5bfd9d6e6db55495b \
  --dotfiles-ref 09b2f8843d6868c52cd62c4fe217ec6a97df82b9
python3 scripts/verification/bridge-footprint.py --dotfiles /home/beau/documents/nix-dotfiles \
  --harness-ref 7d56191596038cb05d4dbe915918cdf46e1689e7 \
  --dotfiles-ref 0315a85f75ebc6a05de3a981098a1f6d053c8646
```

| Fixed scope | Before files / physical lines | After files / physical lines |
|---|---:|---:|
| Old managed runtime | 124 / 21,344 | 0 / 0 |
| Native bridge, helper, lock, task/archive and offline migration | 0 / 0 | 27 / 3,463 |
| Shared Matrix primitives | 5 / 196 | 8 / 626 |
| Stateless chat/account/invitations | 18 / 2,019 | 16 / 1,448 |
| Mixed packaging/retention/policy | 15 / 2,312 | 10 / 1,065 |
| Complete downstream production Go picker | 19 / 4,563 | 8 / 2,190 |
| Downstream tmux/Pi configuration/shared shell | 15 / 804 | 14 / 776 |
| **Total** | **196 / 31,238** | **83 / 9,568** |

Include the new 74-line shared Aloop helper outside these fixed scopes: net
**21,596 fewer lines (69.1%)**, not a claimed ≥70% release requirement. #170's
72.3% used a different, explicitly dual-source baseline. The original planning
2,501/2,601-line downstream estimates covered selected related code; the new
4,563 baseline counts the entire Go picker, including ordinary preexisting tmux
behavior. Current-worktree mode still reproduces #170's inventory byte-for-byte;
its three extra downstream configuration lines are preserved unrelated staged
work, not bridge growth. Full reports: `.pi/tmp/release-171/{before,after,worktree}.json`.

### Replacement budget, including integration and moved code

The ≤8,000-line review budget is met without compacting code or dropping behavior.
This conservative charge includes whole ordinary picker files and complete patch
files (including diff context), not just minimal new runtime statements:

| Charge | Lines |
|---|---:|
| Entire native bridge/runtime/migration directory | 3,463 |
| Entire surviving Go picker/launcher | 2,190 |
| Trusted invitations / extracted Aloop hooks | 155 / 74 |
| Native Nix package/service/lock and complete runtime-pin script | 257 |
| All five native Pi patches, including context | 1,098 |
| Added lines in mixed harness integration | 123 |
| Added lines in mixed downstream configuration | 52 |
| All added shared Matrix lines, including extracted renderer/checkpoint | 430 |
| Extracted stateless byte/decode validation | 105 |
| Added stateless transport/file/package/module integration | 43 |
| **Conservative total** | **7,990** |

Mixed-file charges use `git diff --no-renames --numstat BASE CANDIDATE -- PATHS`
and count **additions**, not net deletions. Harness paths: `flake.nix`,
`nix/{module,package,pi-harness-resources}.nix`, `config/agent/{profiles,settings}.json`,
`extensions/agent-profiles/core.ts` and `extensions/aloop/index.ts` under that
config directory. Downstream: `flake.nix`, `modules/cli/pi-harness/*.nix`,
`modules/cli/tmux/*.nix`, `modules/cli/tmux/shared-*.sh`,
`modules/services/matrix/nas.nix`. Stateless integration: `nix/bridge-chat{,-package}.nix`
and `bridge-chat/{main,transport,file-store}.ts` under extensions. The remaining
charges are whole-file physical counts, including comments/blanks. Native-specific
Nix/retention is `matrix-bridge.nix`, `matrix-bridge-service.nix`,
`pi-session-lock.nix`, `scripts/pin-runtime.py`. Full charge detail and exact
revisions: `.pi/tmp/release-171/budget.json`.

Of the shared additions, renderer/checkpoint 381 lines and stateless validation
105 lines are retained existing byte/rendering behavior, not relocated lifecycle
authority. Excluding only those unchanged shared primitives as ADR 0003 permits
gives **7,504 lines**; the conservative figure discloses them anyway. No removed
manager moved downstream. Verification code, docs, tests and synthetic fixtures
are outside production, not deleted to manipulate that number. The 27 native
files exceed the practical 15–25 target: four offline migration modules and
platform lock/type shims have distinct responsibilities. Keep those seams rather
than merging files solely to hit a count.

The [removal inventory](matrix-pi-removal.md#operations-durable-authorities-workers-and-dependencies)
records 45→0 host operations, ≥14 old persisted families with no remaining writer,
one native host ledger/daemon, no process manager/repair API, removed account and
legacy background workers, retained finite task helpers and independent stateless
services. No new runtime framework or npm service was introduced. Historical data,
old installed closures and backups are retained, not active compatibility stores.

## Pre-review verification

Preflight issue bodies/test-name inventory: `.pi/tmp/release-171/`. Actual proof
families are `bridge-native-pi`, `bridge-session-lock`, `bridge-local`,
`bridge-adapter-real-pi`, `bridge-relay/store/matrix/interaction/organization`,
`bridge-task-approval/workspace`, `bridge-archive`, `bridge-migration/process` and
`bridge-chat-trusted-invites`, plus retained picker/UI/runtime-retention suites.
Their assertions test the required seams; scenario names alone are not receipts.

- Measurement worktree output exactly matches the preserved #170 report. Committed
  baseline resolves 124 / 21,344 old runtime lines, agreeing with the initial audit.
  Both explicit-revision inventories and the separate mixed-file addition charges
  completed without live-state access or worktree/index writes.
- Cross-repository native launch: actual patched Pi + actual final Go
  `tmux_project native-window` package + packaged `localOpen`/BridgeStore, under
  disposable HOME/socket/roots. Command: set `PI_BRIDGE_TEST_PI` to the built Pi,
  `PI_BRIDGE_TEST_MAIN` and `PI_BRIDGE_TEST_STORE` to the built bridge entrypoints,
  `PI_BRIDGE_TEST_WINDOW_LAUNCHER=$PWD/.pi/tmp/removal-170/tmux-project/bin/tmux_project`,
  then `bash .pi/tmp/task-167/check.sh tests/bridge-local.test.mjs`.
  **9 pass**, zero skips. Initial 8/9 missed the required STORE fixture variable;
  supplying it made the unchanged suite pass. No assertion/timeout changed.
  Logs: `2026-11-10T22-33-16-931Z-release-171-actual-consuming-native-launch-3c79b15d8d4c`
  and `2026-11-10T22-34-59-991Z-release-171-actual-consuming-native-launch-compl-e8c37c2e21c4`
  under `.pi/tmp/workers/`.
- Broader affected command: `nix build .#checks.x86_64-linux.unit-tests .#checks.x86_64-linux.bridge-chat .#checks.x86_64-linux.source-contracts .#checks.x86_64-linux.module-contracts .#checks.x86_64-linux.package-contracts --no-link --keep-going -L`.
  **287 unit / 85 chat**, zero skips; all five gates passed, including actual
  Pi/SDK, original media/controls, task SIGKILL/hook boundaries, committed archive
  fencing, readonly migration and exact trusted invitations. Log:
  `2026-11-10T22-33-16-931Z-release-171-pre-review-affected-c303056bbf0c`.
- #170's 18 race-tested Go cases, isolated picker package and six consuming
  evaluation checks remain applicable: downstream source has not changed since
  that commit. Final consuming/package checks will follow cumulative review.

## Publication and separately approved #172 sequence

This is a handoff plan, **not execution authorization**. No system build or
activation is authorized by passing package checks. The published input/lock has
not advanced; local `--override-input pi-harness git+file://...` evaluation is not
proof that a normal rebuild will consume this candidate. In particular, preserve
the user's separate uncommitted old-pin change rather than overwriting it.

1. Operator approves exact harness/downstream revisions, remote refs and
   publication/pin scope. Publish only approved owned commits, never force-push
   or sweep unrelated staged work into a release. Update the consuming input/lock
   to the approved harness revision in a separate owned change. Preserve the
   harness's Pi 0.84.4 pin instead of restoring a follows override to the host's
   independently updated tools. Re-evaluate exact final consuming config and
   obtain separate authorization for any system build/switch.
2. Agree exact grill/NAS canary targets, native files/IDs/rooms and maintenance
   timing. Inspect actual running revisions and all old writers/consumers,
   in-flight work and shared tmux ownership under the approved scope. Include
   this maintenance conversation if it is an old writer; continue from an
   independent human terminal before quiescing it. No process scan/closure is
   inferred from a socket, lock, window, attachment or control ACK.
3. Quiesce the old bot consumers, affected native writers and approved creators;
   prevent restart and observe real exits/creator completion. Stop the old NAS
   account consumer under approval, preserving in-flight stateless `!pi` request
   phases, token identity and journals too. A per-room canary does not permit
   simultaneous old/new `/sync` consumers for the same bot or overlapping writers.
4. Follow [offline migration](matrix-pi-migration.md) with independently coherent
   captures and kernel-read-only mounts, never a readonly alias of writable live
   data. Inventory all declared state/manifests/native/account roots; preserve
   originals and complete backup bytes. Do not put real histories/journals/backups
   in the world-readable Nix store. Export/import/check into a distinct private
   no-replace destination; retain partial siblings and inspect every unresolved
   identity/media/input/poll/output/account finding. Do not convert in place.
5. Freeze original bot/operator IDs, room receipts, output transactions and sync
   cutoffs. Review the check's pre-start rollback eligibility. Starting a runtime
   writer closes that window even if startup later fails; changed/new native
   evidence also revokes it. No attachment or window ACK proves an external task
   completed. Missing originals or unresolved ownership are blockers, not waiver.
6. Under the exact approved activation scope, install matching native wrappers,
   helper/picker and bridge configuration and the NAS trusted-invitation consumer.
   Keep shared tmux independently owned; do not replace its running generation or
   mass-refresh Pi. Confirm old consumers stay stopped before starting the new
   same-account bridge. NAS convenience may remain offline during a local canary.
   Existing identities are imported, not recreated or reinvited as repair.
7. Exercise approved canaries and record **actual** evidence: offline local
   launch/resume/new/fork/tree and requester-only picker focus; one writer and
   daemon reconnect without Pi/tmux replacement; text/reply, original image with
   caption, joined collaborator and poll/text races; native preferences/abort;
   delayed setup/Spaces/first invitation with deliberate departure respected;
   individually approved task worktree/session/room with visible summary and no
   child execution until a fresh instruction; busy/offline archive with current
   final output, original history/membership retained, and restore after fresh
   sync without stale replay. These are real Matrix/model/client checks, not the
   deterministic HTTP fixtures or visual inference from attachment.
8. After any new work/first runtime writer, reconcile frozen delivery receipts or
   continue locally; never restore old queues/cursors or use the old installation
   concurrently. Preserve backups/old closures for the agreed window. Cleanup of
   data, rooms, memberships, worktrees or branches is a separate approval, not a
   finalization step here.
9. Record exact revisions/packages, approvals, hosts, original identities,
   capture coherence, migration reports, canary outcomes and residual faults in
   #172. Do not expose credentials/private history. Close epic #160 only after
   agreed live acceptance, or an explicit operator-approved deferral. Do not
   bulk-close old overlapping epics or declare #158/#159 repaired.

## Cumulative review and final evidence

The mandatory full-epic paired review used fixed point
`8a96e8cfb0141ef71ffd5cc5bfd9d6e6db55495b` and one pinned worktree snapshot:
`.pi/tmp/reviews/2026-11-10T22-41-13-641Z-worktree-01ef83438b8f-ec3c98bc5e5f/`.

### Standards

No findings. Cumulative changes conform to repository/workflow/domain guidance
and ADR 0003, including the staged release/deployment boundary.

### Spec

No findings. The cumulative implementation/deletion, retained native workflows,
offline migration boundaries and disclosed conservative budget satisfy the
reviewed contract. No remediation or repeated review is required.

Final canonical/package/consuming gates remain pending. Captured immutable
committed downstream source/diff is at `.pi/tmp/release-171/dotfiles-cumulative/`,
from `09b2f884` to `0315a85`; patch SHA256
`06c0d7bf726b44ea187b054a2248a27477b7a6b27e7b755bd5082a5b34f1a6aa`.
It excludes all unrelated staged/unstaged downstream content. Historical
#158/#159 and other deployed failures are not declared repaired by replacement
tests. This issue must not close the deployment-only gate or the epic.
