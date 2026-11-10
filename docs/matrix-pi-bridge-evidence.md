# Matrix–Pi replacement: acceptance and release evidence

Authority: [epic #160](https://github.com/BeaudanBrown/pi-harness/issues/160),
[ADR 0003](architecture/decisions/0003-matrix-pi-bridge.md).
Baseline: harness `8a96e8c`; nix-dotfiles `09b2f884`, with unrelated staged and
unstaged changes preserved. This document records technical evidence, not a second
backlog. **Not rebuild-ready until the final gates and migration instructions below
are completed. No production migration/activation has been performed.**

## Acceptance-to-evidence matrix

Tests cross the approved public seams: native Pi SessionManager/packaged launcher,
local list/open/status, adapter socket, Matrix HTTP, typed workspace/archive actions
and offline migration. Test doubles substitute remote Matrix/model requests; real
Git/tmux/Pi test actual process, persistence and native-command semantics. Do not
mock internal methods or assert private database layouts as behavioral evidence.

| Issue / acceptance | Intended implementation | Focused evidence |
| --- | --- | --- |
| #161 terms/behavior/deletions | ADR 0003, amendment links, reusable scenario fixture | Documentation links, fixture validity; no shipped-behavior claim |
| #162 offline local launch, one writer | Native writer protection + local helper | Two actual processes, crash/reboot-equivalent release, native switch/fork, child inheritance |
| #163 durable text bridge | Small adapter, transactional store, Matrix transport | Duplicate intake, lost handoff/output ACK, persisted-only catch-up, isolated bad room |
| #164 native picker/Nix | Local list/open/status and downstream picker | Real disposable tmux focus/concurrency, offline picker, evaluated service lifetimes |
| #165 background organization | Idempotent room/Space setup, narrow invite acceptance | Lost create response, partial links, deliberate departure, NAS offline |
| #166 polls/media/controls | Native control adapter and interaction records | Joined votes/text race, duplicate/old polls, actual Pi expansion, original image bytes |
| #167 task workspaces | One approved Git/session/binding creation | Real Git, fixed base, retry after each effect, no child turn, collision preservation |
| #168 archive/restore | Stored dispatch policy + grouping | Busy final output, offline move, restore without old replay, original IDs preserved |
| #169 migration | Offline export/import/check | Original sessions/rooms and frozen output IDs, interrupted import, no live overlap |
| #170 removal | Delete old runtime/contracts/options/tests/docs | Package absence and net code/state/interface counts in both repos |
| #171 cumulative readiness | Full review and deterministic release checks | Both review axes, verify, production packages, downstream tests/evaluations |
| #172 deployment only | Approved maintenance/import/activation | Operator-approved actual Matrix/Pi/tmux/NAS canary, not attachment alone |

## Crash-boundary matrix

| Before / operation | Durable identity / side effect | Interruption policy and test |
| --- | --- | --- |
| Native file open/switch | Host-local kernel-held writer ownership | Only lock owner writes; dead process releases, unrelated child cannot retain; failed switch preserves usable old session |
| Background registration | Canonical file/header + native projection boundary | Offline Pi remains local; retry same binding, no old-history backfill |
| Matrix sync | Intake event IDs + next cursor in one transaction | Before commit replay safe; after commit no duplicate dispatch |
| Input handoff | Commit potentially-dispatched before socket send | Lost send/receipt is per-message interrupted; never blindly rerun; later fresh input works |
| Native output | Native persisted entry + frozen output/transaction IDs | In-memory event alone is not eligible; lost HTTP response reuses exact payload/ID |
| Poll start/answer/end | Stable publication identity and single resolved outcome | Duplicates/races cannot wake twice; archive suppresses future dispatch |
| Image download/transfer | Authenticated original bytes + digest/chunk index | No partial-image prompt; preserve text+image as one event; no arbitrary byte cap |
| Room create/link/invite | Durable setup key, stored room IDs/private aliases | Recover owned uncertain create; safe links retry independently; leave is not auto-rejoin authority |
| Task approval/create | Frozen source/base/key before branch/worktree/session | Retry own partial setup only; unrelated path unchanged; no automatic rollback or child execution |
| Archive/restore | Flag committed before dispatch + intended grouping | Active output can finish; offline links retry, pending old work never silently replayed |
| Offline migration | Frozen source/export + separate destination | Refuse live source, repeatable import, preserve history and uncertain identities |
| Activation/rollback | Approved scope + frozen versions/receipts | Never dual owners; after new execution no stale-queue restoration |

## Verification results

Implementation results will be appended per logical commit/issue. The contract
fixture is `tests/fixtures/matrix-bridge/workflows.json`; it specifies reusable
input/output scenarios rather than an invented execution simulator.

## Rebuild and migration readiness

Pending implementation and cumulative verification. Do not run a host switch merely
because this document exists. Host builds/activation and real account/room effects
remain operator actions. Existing old managed sessions are not compatible writers
for a replacement kernel-lock protocol until the approved cutover has quiesced them.
