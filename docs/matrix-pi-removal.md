# Legacy runtime removal (#170)

Status: source removal, pinned review/remediation and final deterministic/package
verification complete. This is source/package work, not permission to
stop, migrate, restart or activate anything.
Grill and NAS are **not rebuild-ready**. #171 owns cumulative release evidence
and the publication/pin handoff; #172 requires separately approved live cutover.

## Ownership and preservation

Harness baseline: `67ceb087805e3e24b6cf13adffc86e5e7f23c928`.
Consuming baseline: `c8d681d64b4a9086a9bbd19aa69f6e410f836e78`.
The harness owns the bridge, native adapter, offline converter and packaging.
Nix-dotfiles owns its picker, native window launcher and consuming configuration.
Do not move the removed manager into the latter repository.

Preserve unrelated research, staged/unstaged downstream changes and its index;
`.pi/tmp/bridge-baseline/` contains earlier preservation artifacts. Preserve all
real native histories, live stores, rooms, processes, worktrees, installed Nix
closures and backups. Do not inspect the private secrets repository. Secret
references retain `sopsFile = lib.custom.sopsFileForModule __curPos.file;`.

The diagnosed legacy launcher/tmux/admission failures remain historical evidence,
not repaired deployment receipts. Keep ADR 0002 as a superseded decision record
and retain diagnostic evidence, clearly distinguished from current instructions.
Delete obsolete feature runbooks because their operations no longer exist, not
to reduce a documentation count. Git history retains deleted implementation.

## Acceptance → change → evidence

| Acceptance | Owned change | Required evidence (pending unless recorded below) |
|---|---|---|
| One shipped conversation runtime | Delete `managed-sessions/`, coordinator/profile variants, host catalogue/policy/skill, launch/import/repair/retirement/generation/refresh wrappers and legacy flake exports | Resource/profile tests, source and built-package absence assertions; compile remaining imports; removed options rejected rather than silently selected |
| Preserve native workflows | Retain writer locks, native helper/adapter, narrow task approval, archive, polls, original inbound images, organization, renderer and checkpoint schema | `bridge-*.test.*`, actual packaged Pi and disposable tmux/Git tests; unchanged workflow fixture scenarios |
| Retain genuinely shared behavior | Isolate stateless file-byte validation/decoder from the legacy workspace exporter; preserve independent aloop behavior without its managed-runtime dependency | Stateless file/media tests, aloop supervisor tests, shared renderer/checkpoint/HTTP tests; no legacy dependency in compiled entrypoint graphs |
| Remove NAS account platform | Delete account scheduling/proof/to-device/notification machinery and option; retain exact trusted-bot first-invitation loop and independent `!pi` assistant | Stateless policy fingerprint/watermark, uncertain-send, files and invitation tests; explicit rejection of old account configuration; no old worker instantiated |
| Remove arbitrary bridge artifact export | Delete its native model tool, resolver, spool and delivery owner with the manager; retain opaque historical evidence only in offline migration | Advertised-tool/resource absence, inbound-image/native-question/task/archive suites, migration fixture preservation; separate stateless `!pi` file support remains |
| Simplify packaging and downstream | Delete managed Nix options/launchers/rollout services and downstream managed command/operation handlers; retain shared tmux, requester focus, native hint checks, direnv/PATH/trust and GC roots | Module/package contracts, isolated picker `go test -race`, picker build, runtime pin tests, six grill/NAS consuming evaluations; no system build or activation |
| No live legacy conversion/fallback | Keep only `pi-bridge-migrate inventory/export/import/check`; reject recognisable old stores before creating a new runtime ledger | Old-store refusal leaves bytes and directory entries unchanged; migration readonly/SIGKILL/no-replace tests; packaged converter and no packaged legacy relay |
| Measured reduction across both repos | Record fixed-scope physical line/file inventories, public operations, stores, workers and dependencies; disclose shared/moved code | Reproducible before/after reports plus final #171 cumulative budget review, not just `git diff --stat` |

### Behavioral coverage disposition

Remove tests whose sole subject is the deleted managed dispatcher, approvals,
coordinator, launch reservations, automatic refresh, generation transitions,
repair/retirement/cleanup or managed NAS scheduling. Do not rename those systems
and keep testing them as a fallback.

Retain/adapt the following coverage rather than deleting it with its former path:

- Shared Markdown rendering and checkpoint validation: test the canonical
  `matrix-shared` implementation directly, including hostile Markdown and bounds.
- Shared HTTP: native bridge retries and stateless chat's deliberately single
  uncertain-send attempt remain distinct; independent sync filters/cursors remain.
- Stateless attachments: byte/type/filename/decoder validation, staging confinement,
  uncertainty and model sandbox limits remain. These limits do **not** migrate to
  native inbound images, whose original bytes remain uncapped/untransformed.
- Aloop/GitHub supervisor lifecycle, native-human boundaries and cancellation:
  preserve the independent supervisor, not the managed host-control platform.
- Native writer/navigation/expansion/provenance/queues: actual Pi suites supersede
  legacy adapter integration. No weakening of concurrency, timeout or assertions.
- Delivery recovery/isolation, collaborator questions/controls/images, background
  setup/invitations, approved idle task handoff, archive/restore and frozen offline
  migration: the replacement suites remain canonical.
- Picker/native window focus and shell argument safety: retain behavior used by
  `native-window` and normal tmux even if a helper currently has a managed name.
  Remove exact-window ownership/managed host protocol code only when unused.

## Effect/crash boundaries

Deletion adds no service migration or cleanup executor. Existing runtime effect
matrices in `matrix-pi-bridge-evidence.md` and `matrix-pi-migration.md` remain in
force. These are the additional boundaries to prove for the removal:

| Boundary / state before | Possible effect / durable identity | Interruption and retry rule | Evidence |
|---|---|---|---|
| New runtime pointed at an old dedicated state directory | No database creation, schema conversion or erasure is permitted | Detect legacy presence before opening a writer; fail with offline-migration guidance; retry cannot adopt old authority | Synthetic old directory snapshot before/after constructor and packaged startup refusal |
| Unsupported old NAS configuration before store open | No account worker, sync or account effect | Reject explicit legacy field; do not translate to a new trust grant | Config rejection and module option absence tests |
| Ordinary `!pi` config loses removed account option | Existing assistant watermark/queued questions must retain identity | Account-policy removal must not reset assistant policy or replay old timeline | Compare historical assistant fingerprint and retained queue behavior |
| Stateless upload/send during validation extraction | Existing request phases and frozen transaction identities, no new delivery protocol | Preserve original uncertain-send semantics; extraction is byte policy only, never authorizes a native outbound tool | Existing file/transport tests, malformed decode and uncertainty cases |
| Native/helper launch while bridge absent or old markers exist | Kernel writer lock and original native file/header; optional ledger presentation only | No managed admission or copied replacement history; real lock/corruption errors remain explicit | Actual native startup/resume/new/fork and local-helper process tests |
| Approved task creator outlives daemon/caller | Existing frozen intent, branch/worktree/native ownership and finite inherited Git lease | Disconnect is not cancellation or rollback proof; retain partial resources and runtime roots | Existing task SIGKILL/hook tests and runtime-retention tests |
| Package/source update with live old installation | No live action in this issue; old/new processes must not overlap at cutover | Do not activate merely because evaluation/build passed; separately approved quiescence/capture/exit observation precedes new service | Six evaluation-only consuming checks; explicit #171/#172 handoff |

No socket attachment, control ACK, window creation or lock observation is claimed
as execution completion, process exit or an external-effect receipt.

## Fixed-scope production inventory

Preflight `git ls-files` over fixed scoped production paths, physical lines
including blanks/comments, excluding tests/fixtures/generated files:

| Identical scope | Before files / lines | After files / lines |
|---|---:|---:|
| Harness legacy managed runtime | 124 / 20,967 | 0 / 0 |
| Native bridge, including one-shot migration | 27 / 3,444 | 27 / 3,463 |
| Shared Matrix primitives | 8 / 626 | 8 / 626 |
| Stateless chat, including old account machinery | 19 / 2,191 | 16 / 1,448 |
| Scoped packaging/retention/policy (mixed shared ownership) | 18 / 2,558 | 10 / 1,065 |
| Downstream complete production Go picker/launcher | 19 / 4,222 | 8 / 2,190 |
| Downstream top-level tmux/Pi configuration and shared shell | 15 / 796 | 14 / 779 |
| **Fixed-scope total** | **230 / 34,804** | **83 / 9,571** |

The initial epic's 21,344 managed lines preceded shared renderer/checkpoint
extraction. Do not compare the 20,967 removal baseline as if it were that original
baseline. The complete picker and shared packaging are reported conservatively;
not every line is attributable to the bridge. Before/after inventories must keep
the same scope and disclose new shared files. Preflight detail is in
`.pi/tmp/removal-170/before.json`; reference inventories are in that directory.
The fixed scopes lose 25,233 lines (72.5%); this is **#170's dual-source baseline**,
not the original epic estimate. New `aloop/lifecycle.ts` is outside those scopes:
74 retained shared lines replace the removed 106-line managed lifecycle module.
Including that addition gives 9,645 lines / 72.3% net removal. Stateless byte/decode
helpers are inside the chat scope, not hidden downstream. They retain outbound
chat policy, not arbitrary native export. The serialized historical Aloop entry
label is data compatibility, not a runtime channel.

Other mixed files, reported separately rather than changing baseline scopes:
`flake.nix` 705→352; `nix/verification.nix` 687→609 (verification, not runtime);
Aloop `index.ts` 1,182→1,179; profile JSON 134→114; profile core 167→166.
The five retained native Pi patches total 1,098 physical diff lines (including
context/headers), unchanged by #170: control preflight 194, persistence 205, queue
preflight 276, writer lock 229, queued-message removal 194. They belong in #171's
cumulative accounting; they are not deleted to make a budget pass.

Reproduce the current fixed-scope report, with new source files tracked:

```sh
python3 scripts/verification/bridge-footprint.py \
  --dotfiles /home/beau/documents/nix-dotfiles
```

The script is read-only verification tooling, not shipped runtime. It lists its
exact Git pathspecs and per-file physical counts; it never visits secrets or live
state. Before/after full reports are `.pi/tmp/removal-170/{before,after}.json`.
Downstream before includes unrelated staged configuration and after preserves it.

A conservative runtime subtotal is 7,237 lines: complete native runtime/migration
3,463 + **all** surviving Go picker code 2,190 + invitations 155 + shared Aloop
hooks 74 + native-specific Nix/retention 257 + all five patch files 1,098. This
includes ordinary picker functionality and patch context, but excludes unchanged
shared Matrix/stateless/engineering code. Mixed flake/module/profile/host-config
integration is separately disclosed above; #171 must reconcile its cumulative
integration changes and the ≤8,000 replacement-production budget. The practical
15–25-file target is exceeded by 27 native files, including four offline migration
modules and platform lock/type shims; merging unrelated seams to hit a file count
would not simplify behavior.

## Operations, durable authorities, workers and dependencies

Counts below describe **shipped source owners**, not the still-installed fleet.
Pre-removal source contained both old and new runtimes; that never authorized
running them over overlapping history/rooms.

| Surface | Before → after | Retained boundary |
|---|---|---|
| Generic host-control catalogue | 45 → **0** operations | No coordinator, repair, retirement, branch/worktree removal or generic preview/apply API |
| Native public room interface | 12 → 12 commands | help/status/start/abort/stop/model/thinking/compact/steer/follow-up/archive/restore |
| Native model tools | 2 → 2 | checkpoint and separately approved four-field task creation; no model archive or artifact export |
| Local helper / native UI / offline migration | 3 / 2 / 4 → unchanged | list/open/status; confirmed archive/restore; inventory/export/import/check |
| Downstream managed subcommand | Entire catalogue → absent | Only fixed-argv `native-window` plus ordinary picker/tmux commands remain |
| Legacy host persisted families | ≥14 → **0 active writers** | Registry, manifests, archive, retirements, inbox, notices, media spool, recovery, titles, live/archive hierarchy, account, approvals, host-command intake; preserve old real data |
| Native host ledger | 1 → 1 SQLite database | Binding, input/output/media, interactions, tasks, archive, setup/migration receipts share it |
| NAS legacy account journal/worker | 1 / 1 → 0 / 0 shipped owners | Old journal retained as inert offline evidence, never opened on new startup |
| Independent NAS chat/invitation stores | requests SQLite + optional file spool + invitations SQLite → unchanged | Separate request identity/cursor and exact trusted first-invitation policy |
| Host bridge daemons | 2 source implementations → **1** | Native Pi/tmux remain independent; no extra process manager |
| Legacy background feature owners | 9 started owners + runtime-refresh timer → 0 | Titles, recovery monitor, runtime observer, retirement, projection resumption, artifact export, coordinator routing, host account, local enrollment removed |
| Native background owners | Sync + delivery/task pump + organization pump → unchanged | One daemon; bounded per-room work; finite approved task creators may outlive callers |
| NAS workers | Stateless model/transport + trusted invitations retained | Only the legacy account scheduler is removed |

A native JSONL file and task branch/Git-admin/worktree ownership markers are
retained resources, not additional host databases. Kernel locks/bootstrap hints
are not persistent launch reservations. Offline bundles/receipts are not a second
live writer or rollback authorization.

Dependency deletion removes the old peer-UID/relay-lock executables, managed
protocol schemas, model policy/skill, dispatcher and account proof/to-device
modules. No replacement npm service/framework was introduced. Native code keeps
pinned Pi/Bun and Node builtin SQLite, the C native writer-lock addon, Python for
fixed-argv local/Git helpers, Git/tmux/direnv and shared Markdown/TypeBox already
used by the harness. Optional ImageMagick decoding remains **stateless chat only**
under `PI_CHAT_IMAGE_DECODER`; it does not cap or transform native inbound media.
Downstream remains the existing Go picker/shared tmux packages, not a relocated
manager. Package/compiler graphs prove no managed runtime dependency remains.

48 obsolete feature documents and managed-only suites were removed. Eight
[historical diagnostic records](legacy-managed-history.md), ADR 0002 and Git
baseline preserve incident evidence. Shared renderer/checkpoint tests moved to
canonical `matrix-*` owners; native/Aloop/stateless tests remain. The downstream
orphaned pidfd termination implementation/test was removed after the first Go
compile exposed its remaining references; that deleted feature has no native
caller. No retained assertion, timeout or concurrency bound was relaxed.

## Verification log

Preflight only: read #170, parent #160, completed blocker #169 and dependent #171;
read ADR 0003, implementation workflow, scoped source/package/picker references.
`git status --short` confirmed no harness production modifications at baseline
(two unrelated research files remain untracked). The scoped inventory command
recorded the before table. Logs below are under `.pi/tmp/workers/` and record
actual commands/outcomes, not live Matrix/NAS or visual operator acceptance.

- Direct refusal red: `bash .pi/tmp/task-167/check.sh .pi/tmp/bridge-build/tests/bridge-legacy-removal.test.js`.
  Corrected fixture: 2 pass / 2 expected missing-refusal failures. Green plus
  `bridge-store.test.js`: **11 pass**, zero skips. The earlier 1/3 run also exposed
  a fixture missing its established room cutoff, fixed without changing policy.
  Logs: `2026-11-10T21-15-54-677Z-removal-170-refusal-red-corrected-fixture-58d4cff9eed8`
  and `2026-11-10T21-20-40-750Z-removal-170-refusal-green-992933046075`.
- `nix build .#checks.x86_64-linux.bridge-chat --no-link -L`: **85 pass**, zero
  skips, actual image decoder and legacy-graph absence checks. The removed 45
  account tests and two added stateless cases explain 128→85, not weakened checks.
  Log: `2026-11-10T21-20-40-750Z-removal-170-stateless-decoupling-460a04a5dff2`.
- Actual-Pi/shared focus: set `PI_BRIDGE_TEST_PI=$PWD/.pi/tmp/archive-168/pi/bin/pi`,
  then `bash .pi/tmp/task-167/check.sh` with compiled `aloop-supervisor`,
  `agent-profiles`, `matrix-shared`, `matrix-transcript-renderer`,
  `matrix-android-renderer`, `matrix-checkpoint-validation`, `bridge-adapter-real-pi`
  test files: **50 pass**, zero skips. Native Aloop questions/abort persist and
  stale delegates are removed after native new, without a model call.
  Log: `2026-11-10T21-37-15-526Z-removal-170-shared-native-focused-271433e4a5ee`.
- Packaged startup red: new case found credential access preceded old-store
  diagnosis (4 pass / 1 fail, expected migration guidance but got missing credential).
  Added read-only preflight, repeated before writer open. With
  `PI_BRIDGE_TEST_MAIN=$(nix build .#matrix-bridge --no-link --print-out-paths)/lib/matrix-bridge/main.js`,
  run the refusal/store files through the same helper: **12 pass**, zero skips.
  Missing credential and synthetic invalid HTTP origin prove rejection precedes
  credential/network access and leaves old bytes/directory entries unchanged.
  Logs: `2026-11-10T21-43-21-213Z-removal-170-packaged-startup-refusal-red-f07245f889c5`
  and `2026-11-10T21-53-48-661Z-removal-170-packaged-startup-refusal-green-eef0a82ddc70`.
- `go test -race -count=1 -v ./...` in downstream `modules/cli/tmux/tmux-project-go`:
  initial compile found orphaned old process-termination code; after removing its
  sole deleted feature, **18 pass**, zero skips/races. Includes real disposable
  tmux/fzf/native focus/semicolon tests and old-dispatch refusal.
  Log: `2026-11-10T21-42-42-338Z-removal-170-downstream-picker-race-retained-102fd45fa0c1`.
- `python3 /home/beau/documents/nix-dotfiles/modules/cli/pi-harness/check-native-integration.py --harness-source "$PWD" --evaluate`:
  **six pass**, grill/NAS Pi 0.84.4, absent legacy options/units/account policy,
  native-only and independent lifetimes. Evaluation only.
  Log: `2026-11-10T21-41-40-480Z-removal-170-consuming-evaluation-first-352d8d3f6023`.
- `nix build /home/beau/documents/nix-dotfiles#nixosConfigurations.grill.config.services.pi-harness.matrixBridge.windowLauncher --override-input pi-harness "git+file://$PWD" --no-write-lock-file --out-link .pi/tmp/removal-170/tmux-project -L`:
  isolated picker package and all 18 tests passed, **not a system build**.
  Log: `2026-11-10T21-59-01-241Z-removal-170-downstream-picker-package-dce5dc269130`.
- Broader affected: `nix build .#checks.x86_64-linux.unit-tests .#checks.x86_64-linux.bridge-chat .#checks.x86_64-linux.source-contracts .#checks.x86_64-linux.module-contracts .#checks.x86_64-linux.package-contracts --no-link --keep-going -L`:
  **287 unit / 85 chat**, zero skips, all five gates passed. Includes actual
  Pi/SDK, readonly/SIGKILL migration, tasks/archive/invitations/runtime retention
  and new absence/refusal coverage. Remote builder unavailable; local builds passed.
  Log: `2026-11-10T21-59-01-240Z-removal-170-broader-affected-84ea6892ccd1`.

## Pinned review and final verification

Review: `.pi/tmp/reviews/2026-11-10T22-12-42-085Z-worktree-56b9036bc6b5-972151379713/`,
fixed point `67ceb087805e3e24b6cf13adffc86e5e7f23c928`. Both axes inspected the same
harness snapshot and captured downstream evidence in
`.pi/tmp/removal-170/dotfiles-review/` (owned patch SHA256
`0f11d2a8b1bc0c0da2a50f7872ed4c32c895451d3300a919d8045bc11177a577`).
Unrelated downstream staged files are reference-only, excluded from that patch.

### Standards

No findings.

### Spec

One **low/current-issue** finding: retained Android renderer and NAS chat evidence
still described the removed relay as a current package. Accepted and fixed with
explicit historical framing and current shared-renderer/stateless ownership.
No runtime changes or design changes arose from review; no repeated review needed.

Changed-file LSP checks passed. The final cached workspace query still reports
deleted sources, stale SDK preflight diagnostics, the settings-schema 404 and
external Go workspace gaps; on-disk patched SDK signatures and fresh Nix
TypeScript/Go builds verify the actual sources. No type assertions or compiler
checks were weakened to hide editor-cache errors. `git diff --check` is clean.

Final verification after the documentation-only remediation:

- `nix run -L .#verify`: **all 11 deterministic gates passed**, **287 unit / 85
  chat**, zero failures/skips. The obsolete managed gate is gone, not disabled.
  Log: `2026-11-10T22-16-26-795Z-removal-170-canonical-final-18c7154a9503`.
- `nix build .#pi .#matrix-bridge .#bridge-chat .#pi-harness --no-link -L`:
  all four actual packages passed; no system build.
  Log: `2026-11-10T22-18-15-438Z-removal-170-final-packages-e5779bd8d0af`.
- The same six consuming evaluation checks passed again on final source.
  Log: `2026-11-10T22-16-26-795Z-removal-170-final-consuming-evaluation-0fac8628e1c2`.
- `python3 .pi/tmp/removal-170/final-executable.py`: actual final
  `bin/pi-matrix-bridge` under empty HOME/PATH environment rejects a synthetic
  old store before reading an absent credential; all entries/bytes unchanged.
  Offline converter present, compiled managed runtime absent.
  Log: `2026-11-10T22-19-16-771Z-removal-170-final-executable-b4d1fe525d65`.

Downstream owned commit: `0315a85f75ebc6a05de3a981098a1f6d053c8646`, 26 paths,
74 insertions / 4,209 deletions. Normal hooks passed using a private commit index.
The original six unrelated staged blob/mode entries and worktree bytes were
verified against the preserved index/hook patch and captured reference hashes;
its 163 insertions / 16 deletions remain staged, unchanged. The new staged
cleanup fixture was verified separately because the private index treats it as
untracked. Other unrelated unstaged work and published input/lock remain intact.

Only these final evidence updates followed the gate; no runtime/test change
requires a repeated canonical run. Harness changes are recorded in the enclosing
#170 commit. Nothing was pushed, activated, restarted or migrated; no live Matrix
or account effect occurred. #171 owns cumulative evidence and the publication/pin
handoff, and #172 requires separately approved cutover.
