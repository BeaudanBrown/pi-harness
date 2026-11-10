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

### #161 contract

Committed `b8b00e3`: ADR/amendment links, terminology and public-seam scenario
fixture. Nine scenarios and relative documentation links validated; JSON/Markdown
LSP clean. `tests/fixtures/matrix-bridge/workflows.json` specifies inputs/expected
behavior, not an invented execution simulator.

### #162 native writer and local helper

The pinned harness uses Pi **0.84.4** (the operator conversation's installed Pi
0.85.0 is not the package under test). A small N-API `flock` primitive works in
both its Bun executable and Node SDK. Native SessionManager acquires ownership
before reading/repairing/migrating a resume target, changes ownership on native
new/fork, and releases through disposal/exit. Same-process transient native
handoff references share one kernel lock; unrelated exec children cannot retain
it. Scratch files survive harmlessly; they contain no durable launch admission.

The Python `list/open/status` helper uses the same lock identity and a transient
per-file open lock. It runs without the relay or Matrix. A busy real owner is
reported even without a usable tmux focus hint; never kill/adopt it or start a
duplicate. tmux failures include stage/exit/local stderr; lost open replies can
retry without an unobserved-launch repair. These are not deployed picker changes.

Evidence:
- Four kernel-process tests: cross-process exclusion, SIGKILL release, transient
  same-process handoff, exec child close-on-exec, path aliases/stale files.
- Four packaged native/local tests: Bun/Node exclusion; new/resume/reload;
  fork/tree/dispose; missing/empty/malformed history preserved; concurrent
  disposable tmux open, lost-response reuse, server loss and reopen. **8 passed,
  zero skips**, no credentials/models/Matrix/shared live server.
- `nix build .#checks.x86_64-linux.unit-tests --no-link`: passed, including the
  broader ordinary suite and new tests. Initially caught FORCE_COLOR formatting
  of a test child's numeric PID; JSON encoding corrected the fixture.
- Patched pinned Pi package built successfully. The configured NAS builder was
  unavailable; Nix built locally. No NixOS output was built or activated.
- LSP and staged diff checks clean. Paired issue Standards/Spec review reported
  no findings (`2026-11-10T01-32-19-524Z-worktree-92806ab321ba-765d07295dc7`).

Canonical full-epic verification and builds remain #171. The deployed tmux crash
in #158 has not been diagnosed/fixed by these isolated tests. Old processes do
not honor the new native locks; quiescing them remains a cutover requirement.

### #163 isolated text bridge and delivery ledger

The replacement now has an asynchronous native adapter, private user-owned Unix
socket, one host-local SQLite ledger, and per-room Matrix delivery. There is no
new daemon activation or room provisioning in this slice: #164 wires packaging/
launchers, #165 supplies rooms and Spaces, and #166 adds polls/images and richer
controls. The existing managed runtime is still present until #170.

Important implementation boundaries:
- The daemon holds a kernel lock before opening/recovering its ledger or removing
  a stale socket. Socket and state directories are owner-only. The adapter imports
  neither Matrix HTTP nor process launching. Local launch receives only a saved
  binding through the #162 seam; production environment sanitization belongs to
  the #164 launcher wiring.
- First successful registration cuts at the **current persisted native tail**;
  an old/copied native marker is not permission to backfill. Reconnect retains the
  original database boundary. Native new/fork keeps native identity semantics.
- Pi's native custom-entry persistence now flushes buffered entries and fsyncs.
  This makes an idle session real without a model turn and persists local-only
  enrollment changes before private work. Headless workers do not enroll; resuming
  a previously bridged file headlessly disables its projection before new work.
- Raw event identity/cursor/checkpoints commit together. Queued input can recover;
  `handed` becomes per-message `interrupted` after lost attachment/restart and is
  never automatically resent. One immutable notice per interrupted event replaces
  recurring recovery-attention announcements. Fresh instructions remain usable.
- Normal busy input uses native steering; `!follow-up TEXT` uses the native
  follow-up queue. `!abort` withdraws older pending input and requests native abort;
  `!stop` additionally requests native shutdown. Neither claims tool effects were
  undone or work completed. Later fresh intent can reopen the original session,
  but cannot be handed to an attachment already stopping. Native preflight and
  observed idle are not external-effect receipts.
- Remote origin is native **message metadata**, not guessed from text. A copied
  or locally restored Matrix-captioned prompt is fresh local input and projects
  normally. Thinking, tool results, internal entries and pre-binding history do
  not project. The history reader only accepts complete persisted JSONL records,
  fsyncs the observed file before freezing output, caches unchanged observations,
  and checkpoints only after immutable output materialization.
- Output retries use the same persisted payload/transaction ID. A partial sync
  gap checkpoints each recovered page without advancing the global cursor;
  other rooms still intake independently. Invalid/missing history is an explicit
  error, not authority to create a replacement session.

Evidence so far:
- **10 focused bridge scenarios passed, zero skips**, including real packaged Pi
  and an ordinary TUI in a disposable tmux server: asynchronous/offline startup,
  persisted-only projection (`message_end` was observed before persistence),
  provenance, reconnect without replay, native new, worker exclusion, busy
  follow-up withdrawal, abort, stop, private-history boundaries, lost output ACK,
  duplicate/membership filtering, restart-safe sync gaps and daemon exclusion.
- Two additional packaged native cases prove idle custom-entry persistence and
  post-expansion attribution/preflight. The native writer/local helper regressions
  remain covered.
- Canonical affected checks: **155 unit tests and 856 managed-session regression
  tests passed, zero skips**, with the patched Pi package built. The real RPC probe
  exposed that its idle shutdown flag is observed at the next RPC checkpoint;
  the separate ordinary TUI test proves immediate native idle shutdown.
- Source TypeScript LSP and compiler checks passed. Isolated copied upstream
  declaration scratch files under `.pi/tmp/` lack their surrounding SDK and are
  not project compilation inputs.
- Paired pinned Standards/Spec issue review found no material findings
  (`2026-11-10T03-08-44-498Z-worktree-6219d38916af-ee4fa9c90f56`). The final
  cumulative review/gate remains #171; these fixtures are not live delivery
  receipts.

### #164 local picker, launchers and Nix wiring

Current boundary: native local integration, not a completed remote product or a
cutover. Rooms/Spaces remain #165, richer interactions #166, approved workspace/
archive actions #167/#168, migration #169, legacy deletion #170 and cumulative
release verification #171. No service was activated, no production process was
stopped, and no Matrix membership was changed. The unrelated downstream staged
patch remains byte-identical with an explicit eight-character diff abbreviation
(SHA-256 `2326317cd5691bd6b1a38eb9dc84588577e884a1425c7fec6c4bfcf08bc731be`).

Downstream implementation is committed locally as nix-dotfiles
`9f23c1bcfd607f21fc640dfa0b19d5435057893a` (parent `09b2f884`), followed by review
remediation `0e0bd07355d8064145e255aeb7fad095b8ce3b40`. No push occurred.
A temporary index excluded all pre-existing staged changes and the operator's
unstaged harness URL/lock edits. Only removal of the host's `nix-ai-tools` override
was committed in that shared flake file: substituting its newer Pi would bypass
the harness's tested **0.84.4** native patches. The final published input/lock
advance is still a release handoff, not implicit permission to publish or rebuild.

| Acceptance | Implementation and evidence |
| --- | --- |
| Native saved/live picker and shared remote wake | Version-1 `pi-session list/open/status`, selected file/ID fencing; daemon wake executes the same helper under an allowlisted environment. Actual Pi opens, same-writer reuse, outside-tmux reporting and requester-only focus tested. |
| No relay/platform admission | Five old picker host/schema/socket files deleted downstream. Real fzf fixtures use only the local CLI, with no bridge/host socket. Ordinary workspace rows remain available; native windows do not require Git. |
| Ordinary nonblocking startup | Native module wrapper bypasses managed launch/main.mjs; central engineering profile/default settings include the adapter. Text TUI is eligible, headless/workers/experiments are excluded, and explicit local-only remains available. |
| Tools, trust and PATH | Seventeen packaged engineering probes preserve tools/LSP, project executable precedence and lean experimental separation. Real direnv refusal/retry and allowed environment propagation tested; no trust bypass added. |
| Independent lifetimes and retention | One optional user daemon with LoadCredential, no EnvironmentFile/stop hooks/PartOf/BindsTo/Requires coupling; independent shared server retains stop/restart suppression. Three runtime-pin tests plus native module assertions cover closure retention; no idle replacement controller. |
| Optional archive presentation | Helper reads the real BridgeStore read-only, matches native identity, includes historical bound files and falls back on missing/corrupt/non-regular state. Archive cannot deny a direct native open. Picker reads no database. |

Focused crash/race evidence:
- Lost local-open reply/concurrent opens reuse the actual writer. Kernel locks
  remain the only writer authority; pane options never authorize killing.
- A slow bootstrap has a live PID/server/birth-fenced hint with a bounded lifetime.
  Replaced/dead/expired hints cannot reserve a file. A discovered regression after
  native `/new` was reproduced red and fixed: a prior matching native owner record
  invalidates bootstrap presentation without claiming current ownership.
- Listing/focusing tolerates live partial JSONL appends; actual launch still
  validates saved history. A kernel lock observation is not completed startup:
  the fixture now waits for actual `session_start` before injecting partial data.
- tmux interprets trailing semicolons even in argv. Red/green real-process tests
  prove literal cwd/session/argument handling; the downstream primitive refuses
  tmux's one-string shell form. Read/focus/annotation probes use `-N` and cannot
  start a replacement shared server.
- RPC shutdown can close stdin before its exit event. The test transport now
  rejects pending writes rather than emitting an unhandled EPIPE. Fixture cleanup
  waits for actual pane-process exit rather than treating kill-server's response
  as an exit receipt. These changes strengthen evidence, not delivery claims.

Final verification, including review remediation:
- **166 unit tests**, zero skips; full TypeScript build and source contracts pass.
- Package contracts: **17 engineering probes + 17 headless cases**, zero skips.
  Module contracts and all **3 runtime-pin tests** pass. Standalone bridge and
  harness packages build as part of these isolated gates.
- **9 actual-Pi helper scenarios in each of two suites** (direct tmux and the
  production packaged downstream launcher), zero skips. Archive fixtures use the
  real public BridgeStore API, not an invented database simulator.
- **67 downstream Go tests** pass with `-race`, zero skips; the isolated production
  picker package also builds and passes all 67 tests. Tests use disposable sockets.
  Measured popup latency is fixture/environment evidence, not a live-host promise.
- **5 downstream source/evaluation tests**, including GRILL and NAS, pass. Both
  evaluate to native bridge enabled, legacy disabled, Pi 0.84.4, independent
  lifetimes and no failed assertions. Privilege evaluation also passes on both.
  Evaluations use a local `git+file:` override and `--no-write-lock-file`; no NixOS
  system output was built. The unavailable NAS builder fell back to local builds.
- Downstream commit hooks pass. Go LSP cannot establish a build for this external
  folder; actual Go builds/tests provide evidence. The existing settings JSON
  schema URL returns 404; local JSON/resource/TypeScript checks pass.

Key local artifacts:
- `2026-11-10T07-02-26-504Z-native-post-review-harness-703038280217`
- `2026-11-10T07-04-18-980Z-native-post-review-packaged-helper-suite-9d58f377f0d1`
- `2026-11-10T07-02-26-504Z-native-post-review-picker-race-ae934d114e0f`
- `2026-11-10T07-02-26-504Z-native-post-review-picker-package-d48baeeb86b6`
- `2026-11-10T07-04-18-980Z-native-post-review-host-evaluations-c186bb0dbe65`

Paired review disposition:
- Harness review `2026-11-10T06-51-12-535Z-worktree-38482d4d9c55-b24e3ee5dafa`
  found no verified harness defects, but was explicitly incomplete for downstream:
  the file-only review interface could not execute the requested Git reads.
- The missing downstream/cross-repository portion was completed in
  `2026-11-10T06-54-25-519Z-worktree-0a7dcf163fbd-8adcbfc44aea`, using read-only
  ordinary files extracted from the exact downstream commit, not its dirty tree.
  The frozen diff SHA-256 is
  `d292256ef73e968737a001ff49714d1ef224d9566298b7f71f7cd648a2b2425c`.
- **Standards: one medium, current-issue finding, accepted/fixed.** The picker now
  rejects relative `PI_NATIVE_SESSION_HELPER` overrides before invocation. The
  documented absolute override contract and regression test agree.
- **Spec: one high, current-issue finding, rejected with source and executable
  evidence.** The claim that daemon wake lacked tmux on PATH omitted the existing
  `tmux_project.nix` wrapper, which prefixes its private tmux/runtime PATH. The
  added actual-production `localOpen` test removes tmux from inherited PATH,
  checks credential stripping, executes the public helper with the configured
  packaged launcher, and waits for actual native `session_start`. Both direct and
  packaged cases pass. No redundant service PATH dependency was added.

No accepted current-scope findings remain. The cumulative review and canonical
`nix run .#verify` remain release requirements; none of these fixtures prove
live Matrix delivery, NAS operation or safety around existing legacy writers.

## Rebuild and migration readiness

Pending implementation and cumulative verification. Do not run a host switch merely
because this document exists. Host builds/activation and real account/room effects
remain operator actions. Existing old managed sessions are not compatible writers
for a replacement kernel-lock protocol until the approved cutover has quiesced them.
