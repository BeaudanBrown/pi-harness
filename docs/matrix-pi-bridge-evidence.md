# Matrix–Pi replacement: acceptance and release evidence

Authority: [epic #160](https://github.com/BeaudanBrown/pi-harness/issues/160),
[ADR 0003](architecture/decisions/0003-matrix-pi-bridge.md).
Baseline: harness `8a96e8c`; nix-dotfiles `09b2f884`, with unrelated staged and
unstaged changes preserved. This document records technical evidence, not a second
backlog. Per-issue entries preserve evidence and outstanding work **at that issue's
boundary**; current cumulative results and the exact verified candidate are in
[release verification](matrix-pi-release.md). **Deterministic verification and
full-epic review are complete, but grill/NAS are not rebuild-ready: publication/pin
advance and approved migration/activation remain outstanding. No production
migration/activation has been performed.**

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

No accepted current-scope findings remain. The subsequent canonical gate exposed
an additional packaging regression: the preserved stateless `!pi` package's
wildcard TypeScript roots compiled the newly shared renderer despite not using
it. Its package now compiles the two real entrypoints and their transitive imports,
without adding an unused Markdown dependency. The focused `bridge-chat` gate
passes all **115 tests**, zero skips. This isolated compile-root correction does
not change the reviewed runtime design.

**`nix run .#verify` passes at the #164 boundary**, including all 12 constituent
gates, 166 unit tests and 856 legacy regression tests (zero skips), plus the
previously recorded chat/package/module checks. Final log:
`2026-11-10T07-11-41-840Z-native-164-canonical-recheck-55c485c0fb5f`.
Only this evidence text was changed afterward. The cumulative epic review and a
fresh canonical gate remain #171 release requirements; none of these fixtures
prove live Matrix delivery, NAS operation or safety around existing legacy writers.

### #165 preflight: background organization and trusted invitations

Current issue: native room/Space provisioning and a narrow account-side invitation
consumer. No model controls, process inspection, lifecycle registry, archive
closure, notification-policy writes or general account-action protocol. #166
owns richer interactions; #167/#168 own approved workspace/archive mutations;
#169 owns legacy identity/departure import; #170 removes old account machinery.
NAS source changes are authorized, not deployment or live membership effects.

| Acceptance | Planned seam | Required focused evidence |
| --- | --- | --- |
| One native room despite lost creation response | Frozen setup node/alias in existing bridge progress; immutable create provenance; saved room IDs win over aliases/names | Drop create ACK before/after server commit, restart, alias collision/removal, foreign creator and unsupported version; never create a second room after uncertainty |
| Host → project → checkout → conversation | Background organizer, bounded fixed-argv read-only Git grouping; shared node work coalesced | Two sessions share project/checkout Spaces; linked worktree has distinct checkout; no-Git workspace works; Git failure produces setup-pending only |
| Bound delivery survives grouping/account failures | Separate setup and delivery work/backoff, bounded status warning | Healthy text continues during blocked Space link, Git error and operator invitation outage; local startup never waits |
| Narrow exact-host invitation acceptance | Optional consumer in existing owner transport, independent sync cursor/work, separate private account-local invitation journal (not the assistant/legacy account database) | Trusted sender plus immutable room proof; reject arbitrary invite/encryption/foreign creator; restart/lost join ACK; observed departure and current membership recheck suppress retry |
| Preserve user policy and isolation | No push-rule writes, leave/forget/unban or operator token on host | Endpoint allowlist assertions; account-policy changes do not reset assistant requests/watermarks; helper failure does not occupy model work |
| Nix/downstream handoff | Public grouping config; exact host/bot map on NAS replacing managed account policy in consuming source | Package/module checks and both-host evaluation only; preserve unrelated staged NAS changes and stateless `!pi` |

Crash boundaries to implement/test:
1. Persist node identity/creation payload before external work. On uncertain create,
   resolve and verify the same private alias only; an absent alias is pending, not
   permission for a second create. Definitively rejected requests may retry safely.
2. Persist returned room ID before hierarchy work; verify immutable provenance and
   creator before adopting a recovered room. Grouping failure cannot unset routing.
3. Links are read/compare/PUT state with the same endpoints/content. Interrupted
   link work resumes independently; no process or account acknowledgement gates it.
4. Record invitation attempt before POST. Unknown outcome is observed, never
   blindly reinvited; leave/ban is negative authority, not a repair invitation.
5. Account intake and its cursor commit together. Recheck a current scoped account
   snapshot before first join, then persist attempted before POST. Lost join ACK
   is observed, not replayed; departures remain suppressed across restart.
   Matrix offers no conditional membership CAS: do not claim a client-side check
   can serialize a simultaneous human action on another client.
6. Shutdown cancels/awaits only bridge/account HTTP work; no Pi/tmux/room teardown.

Protocol references: Matrix Client-Server API `/createRoom` copies custom
`creation_content` into immutable `m.room.create`; `/sync` invitations include
stripped create state (required since spec 1.16). Room v12 may have additional
creators, which the existing shared single-creator verifier rejects. Sources:
<https://spec.matrix.org/v1.19/client-server-api/> and
<https://spec.matrix.org/v1.19/server-server-api/>. No live API probe was used.
Implemented seams: `matrix-bridge/organization.ts`, the shared immutable room
verifier, and `bridge-chat/trusted-invites.ts`. Setup uses the existing host
ledger's progress rows; it adds no runtime registry or daemon. The account
consumer deliberately uses a separate private `bridge-invites.sqlite` database:
this isolates its cursor/attempts from assistant requests and leaves the historical
account database untouched for #169. The preflight's proposed shared connection
was not adopted. This is one optional owner-account consumer in the existing
transport, not a second host database or a general mutation platform.

Acceptance evidence before review:
- **9 organization tests** use real SQLite reopen, HTTP-boundary fixtures and
  disposable Git repositories. They cover concurrent shared nodes/links, lost
  create/link/invite acknowledgements, definitive rejection, alias absence and
  collisions, immutable provenance, no-Git workspaces and linked worktrees.
- **12 invitation tests** cover exact trust/proof, transactional offer/cursor
  rollback, independent policy, lost ACK observation without replay, server retry
  delay, filtered join/leave sections, persistent departures, trust revocation,
  exclusive ownership and orderly shutdown. An endpoint allowlist rules out
  notification, to-device, leave/forget and unban effects.
- A public IPC/delivery test blocks setup HTTP while already-bound input and
  persisted output continue. Credential identity tests reject a mismatched/guest
  bot before any database or setup creation. The unchanged actual-Pi offline
  helper tests still pass; optional organization is not a local launch gate.
- Affected Nix gates pass: **177 unit tests**, **127 chat tests**, source, module,
  package and TypeScript checks; behavioral tests have **zero skips**. Includes
  existing 17 engineering and 17 headless probes. Log:
  `2026-11-10T08-35-39-634Z-native-165-pre-review-affected-476f98e93a83`.
- Both-host **evaluation only** plus source checks pass (**6 tests**); NAS has the
  exact grill/NAS native-bot map and both hosts have empty legacy account policy.
  Log: `2026-11-10T08-11-53-040Z-native-165-consuming-evaluation-ced850f610c3`.
- Downstream commit `c8d681d64b4a9086a9bbd19aa69f6e410f836e78` changes only
  native invitation configuration, its checks and guidance. Normal hooks pass.
  A temporary index excluded the pre-existing Signal fix in the same NAS file.
  The restored real index equals the expected preserved tree exactly:
  `ec5ea41a6c1c24505bc546f414779511f8a9f697`; all six pre-existing staged files
  remain staged. The #164 patch hash is not reused across changed base commits.

Legacy room provenance/departure conversion remains #169; this slice never
rewrites immutable create events or opens the old account journal. Unknown room
creation with an unavailable alias remains setup-pending rather than duplicating
rooms. Matrix membership has no CAS; the scoped pre-join recheck cannot serialize
another client's simultaneous action. These are protocol/fixture results, not
live homeserver receipts.

Paired pinned Standards/Spec review completed at
`.pi/tmp/reviews/2026-11-10T08-39-24-059Z-worktree-f3cf8015908d-07d0d815c5cc/`,
including the exact downstream committed diff/source export (SHA-256
`c847ee7b8d40eb2f5b060ebd8c5e8f1f0e43d6af997686dc00594b38eb8c655d`).
Neither axis found a current-issue defect. The Spec low/deployment-only note is
accepted: live acceptance remains #172, not evidence supplied by these fixtures.
**`nix run .#verify` then passed all 12 gates**, including 177 unit, 127 chat and
856 legacy tests, zero skips. Final log:
`2026-11-10T08-41-40-416Z-native-165-canonical-boundary-9ce56855a24f`.
Only this evidence text changed after the gate. Cumulative review/fresh
verification remain #171 requirements; no push, deployment or migration occurred.

### #166 preflight: polls, native controls and inbound images

Current scope is rich interaction only. #167/#168 own independently approved
workspace/archive effects; #169 migration; #170 legacy removal. Do not restore
an execution supervisor, general host controls, export spool or notification
repair. Production Matrix actions remain forbidden.

| Acceptance | Implementation seam | Required evidence |
| --- | --- | --- |
| Durable native questions/choice polls | Persist a native custom question before aborting; project it into frozen outputs plus a small interaction row | Real Pi question/idle, restart/lost publish/end ACK, obsolete question after local input/tree/switch, native history identity |
| One answer, joined-member collaboration | Atomically claim interaction and authorize its input; capture active-question association at intake; explicit stale replies/votes ignored | Concurrent votes/text, duplicate IDs, departed/ignored sender, restart before/after handoff, no automatic retry of uncertain execution |
| Native help/status/start/stop/abort/model/thinking/compact | Direct native APIs, durable result entries, selection polls for native available choices | Actual Pi preference/history changes, busy rejection/abort, no shell/TUI command synthesis or silent model switching |
| Original JPEG/PNG/WebP and captions | Authenticated same-homeserver media fetch; indexed private SQLite chunks; bounded digest-checked handoff to Pi | Original bytes persisted by actual Pi; captionless/default caption, repeat event IDs, malformed/encrypted/unsupported media and model-local explanation; no new size/pixel caps |
| Independent bounded failures | Existing per-room work/output identity, no additional daemon or process authority | Bad poll/media/control in one room cannot block another, interrupted transfer/abort, definitive rejection versus uncertain receipt |
| Native command/skill/template semantics | Existing patched preflight and post-expansion attribution remain the dispatch seam | Real extension command consumption and template/skill expansion with provenance; do not delete patches based on assumed SDK behavior |

Crash boundaries: intake/association/cursor together; interaction claim/input
queue together; freeze poll bodies/transaction IDs before send; publish/end retries
reuse them. Persist original image and its authorization together before handoff;
chunks never become execution receipts. Persist handed before native dispatch;
unknown receipt remains interrupted. Native question/result markers are fsynced
before projection, not inferred from tool events. Use branch/session identity and
abort epochs at the adapter, without gating ordinary local Pi on bridge state.
The additive delivery schema upgrade must preserve existing bindings, inputs,
outputs and cursors and reject an older daemon against the upgraded ledger.

Implementation now uses native `matrix-bridge.question`, `matrix-bridge.answer`
and `matrix-bridge.control` entries. Poll starts/ends retain frozen IDs and bodies;
first authorized input wins in the same transaction as its interaction claim.
Plain-text fallback follows recovered room order, not sender clocks. The adapter
also checks the original native question on the current branch before dispatch.
History projection checkpoints every processed entry so replay cannot cancel a
later question. No room/input identity is inferred from visible attribution.

Controls use only authenticated, session-scoped native choices. `!start` requests
an idle local open; its acknowledgement is not a startup receipt. Compaction has
separate requested/completed/failed results. A newly tested native API gap required
`pi-bridge-control-preflight.patch`: the loader forwards optional guards, model
selection checks again after authentication, and compaction checks across awaited
boundaries and before native history mutation. Each manual compaction retains its
own abort controller so a late callback cannot clear a replacement. The adapter
fences file/session, abort epoch, native branch and busy state as appropriate.
Existing expansion/provenance/persistence patches remain necessary and retained.
The SDK's ESM-only thinking helper is imported lazily, not eagerly through the
CommonJS headless enrollment-policy path.

Images use the authenticated v1 media-download endpoint with redirects rejected.
Untrusted MIME/size/pixel hints do not replace the original bytes. SQLite schema 2
atomically adds interaction association and indexed 24-KiB image chunks, advances
the version fence, and preserves existing delivery facts. There is no secondary
export spool or new payload/pixel cap. Full/chunk digests and live native scope are
checked before an image becomes a native user message. Unsupported media/model
requests never silently become caption-only prompts or select another model.

Focused and affected evidence:

- Ten HTTP-boundary/real-SQLite/private-IPC interaction cases cover competing
  votes/text, chronological fallback, stale/foreign/ignored senders, lost poll
  start/end receipts across reopen, per-entry projection replay, original image
  formats/captions/deduplication, unsupported input, corrupt chunks, room isolation
  and detached controls.
- Five store cases include the prior intake/output/restart contracts, schema-one
  upgrade preserving cursor/binding/queued input/frozen output, and a synthetic
  PNG-signature payload over 25 MiB exercising durable storage and bounded frames
  (not a codec-validity claim). Indexed chunk reads avoid repeatedly scanning a
  whole large blob.
- Four actual packaged-Pi cases include persisted text/daemon outage/new-session
  isolation, native extension/template/skill behavior, choice tool abort/idle,
  first-answer wins, local-tree obsolete-question rejection, real model/thinking
  and completed compaction, original JPEG/PNG/WebP bytes in native history,
  unsupported-model/busy rejection, and abort during an interrupted image read.
  Native API guard tests revoke scope while authentication awaits and inside a
  compaction hook; neither withdrawn mutation commits. RPC worker exclusion
  remains enforced. These use disposable homes and fake model/HTTP transports,
  not live Matrix/model receipts.
- Actual native compaction first failed in the tiny fixture under the native
  20,000-token keep-recent default. The fixture alone now has a one-token recent
  window and requires the completed callback/history entry. No production check
  was weakened. The model-scope test then deliberately failed against the old
  API (`false !== true`) and passed with the new native guard patch.
- Logs: `2026-11-10T10-11-38-725Z-native-166-boundary-regressions-60ad2524eae0`
  (19 passing, zero skips),
  `2026-11-10T10-35-43-629Z-native-166-control-scope-red-6994150f905a`, and
  `2026-11-10T10-41-37-102Z-native-166-control-scope-green-de99d8b4213a`
  (four actual-Pi cases passing, zero skips). The first broader gate exposed the
  eager CommonJS/ESM import mismatch. Its corrected recheck,
  `2026-11-10T10-54-32-517Z-native-166-affected-recheck-dffa25cdf823`, passed
  production Pi/bridge compilation, TypeScript, source/module/package contracts,
  **191 unit and 127 chat tests**, zero skips. Cached LSP resolution against the
  earlier SDK still reports stale types in the worktree; fresh local `tsc` and
  the isolated Nix compiler both pass against the patched declarations.

Pinned paired review:
`2026-11-10T10-58-23-599Z-worktree-026d7b96bc68-1d0d6a83540f`.

- **Standards:** one high/current-issue finding, accepted and fixed. Controls had
  received a session-only predicate rather than the captured live abort epoch.
  Both native preflight and result publication now use that captured scope;
  pending control/compaction flags carry their epoch so a revoked callback cannot
  clear or indefinitely hold a replacement. Disconnect/checkpoint/abort revokes
  only ephemeral preflight ownership, not local process authority.
- **Spec:** one medium/current-issue finding, accepted and fixed. A nonempty image
  body without optional `filename` was lost. It is now retained; blank bodies and
  known filename-equal bodies retain the captionless default.
- Both regressions failed first in
  `2026-11-10T11-03-45-191Z-native-166-review-regressions-red-1d7ba1b7a2bd`.
  The batched correction passed all 19 focused/native/store cases, zero skips,
  in `2026-11-10T11-08-01-877Z-native-166-review-regressions-green-acf1770d633e`.
  Actual Pi rejects a deliberately delayed control after abort, emits no late
  success and accepts a fresh control. Original caption bytes without `filename`
  also reach actual native history. No accepted current-scope finding remains;
  this remediation preserves the reviewed design and does not need a routine
  second subjective review.

Final **`nix run -L .#verify` passed all 12 gates** at
`2026-11-10T11-15-33-682Z-native-166-canonical-recheck-3ca7cce64edf`, including
191 unit, 127 chat and 856 legacy tests, zero skips. The initial canonical attempt
(`2026-11-10T11-09-19-146Z-native-166-canonical-boundary-997777a0b4ba`) passed the
new/affected suites but failed two existing legacy timing-boundary cases: reconnect
projection and abort-during-wake notice delivery. Both passed three focused repeats
using the exact failed derivation's immutable source, compiled tests, Node 24 and
Pi/resource artifacts (`2026-11-10T11-14-47-251Z-native-166-legacy-failure-isolation-3a2c26d4c45f`),
then the unchanged canonical recheck passed. No test assertions, timeouts,
concurrency or production code were weakened. The initial failure's root cause
is not proven; cumulative #171 verification must still run afresh. Only evidence
text changed after the passing gate. Final isolated production packages (`pi`,
`matrix-bridge`, `bridge-chat`, `pi-harness`) also passed:
`2026-11-10T11-19-29-050Z-native-166-final-packages-9d04f61b0f99`.

No production mutation, migration, restart, push or rollout evidence is implied.

### #167 preflight: approved task workspace and idle handoff

Current scope is one typed `create_task_workspace(branch, base_ref, title,
handoff_summary)` operation, inferred from its calling native binding. There is
no coordinator, general host dispatcher, launch admission record, worktree
removal, branch deletion, merge, fetch, push or production creation. #168 owns
archive effects; #169 migration; #170 deletion; #171 cumulative release.

| Acceptance | Intended seam | Required evidence |
| --- | --- | --- |
| Independent per-call approval | Freeze source/intent/base commit before approval; native local confirmation or an explicit original approval poll accepted only from the configured current operator, never a model argument or arbitrary collaborator answer | Actual native tool/UI boundary and Matrix approval fixtures; rejection, stale/changed intent, duplicate/cross-binding vote, expired approval and missing source |
| Safe linked worktree/new branch | Fixed-argv, project-environment-aware local helper; serialize by Git common directory; positively identified owned partial resources only | Real disposable Git, dirty source unchanged, same/different concurrent intent, occupied branch/path, symlinks, project direnv and no force/reset/delete/fetch |
| Native idle visible handoff | New file/header identity and explicit visible summary only; no native agent turn or automatic child launch | Actual SDK/native Pi open plus idle evidence; no copied source dirt/history/hidden output/credentials/approvals; later human prompt is separate intent |
| Small durable creation record | Frozen key/source/base/branch/path/native identity and approval receipt; idempotent reconciliation of owned effects | Crash after every effect and before its receipt, lost response/reopen, unchanged intent reuses resources, altered intent cannot reuse approval |
| Background remote organization | Register child binding and enqueue existing room/Space/invitation setup; local ready is independent of Matrix/NAS delivery | Matrix outage after approval returns local ready/remote pending; recovery exposes the same room link without recreating Git/session resources |

Crash analysis: creation intent/base/identity precede mutation; independent
approval is durable before Git effects; branch and directory/worktree ownership
must be provable after lost acknowledgement (existence or matching HEAD alone is
not ownership). Source/common-directory/target validation is repeated before
mutation. Native child content is durable before registration; registration is
idempotent by native identity. Unknown filesystem/Git outcomes are reconciled
from owned evidence, never by force, reset, deletion or adoption of foreign work.
The source remains the same conversation/worktree. Matrix publication is outside
the local creation critical section. Approval/creation state is distinct from
native process ownership; local Pi remains usable without the optional bridge.

Implementation now provides one finite task helper and one small SQLite creation
record, not a process registry. Exact intent reuses its frozen commit and native
identity. Different intent requires new approval. Preparation does not publish
an approval poll: the native caller first rechecks its call/abort/branch scope,
then requests publication. Originating persisted history is projected before
that poll. Approval is durable before any creation; current configured-operator
membership/identity is distinct from ordinary joined-member conversation access.

| Implemented boundary | Evidence before final review |
| --- | --- |
| Native local UI / Matrix authority | Actual packaged Pi calls the real tool using a deterministic provider. Aborted UI and a late response cannot grant; a fresh call with the same model tool-call ID gets a new request. Matrix-origin metadata selects the original operator poll; participant votes never create or become model prompts. |
| Idle child / discovery | Real SDK-generated history contains only explicit visible handoff/context markers. Offline packaged `pi-session list` finds it without a ledger. Actual Pi opens it with zero provider calls; a separate child human prompt produces the first call and never enters the source session. |
| Git ownership / concurrency | Real Git rejects occupied and dangling-symbolic refs, foreign directories/symlinks, changed plans and missing sources. Source dirt/history stay unchanged. Same-process duplicates and different intents serialize by common directory; completed retries preserve later human commits. |
| Crash boundaries | SIGKILL before container/native publication and after container/branch/worktree/session; owned resources recover without replacement. A real blocked Git hook survives creator death: the inherited Git lease blocks reconciliation, does not reach hooks, and ignored diagnostics avoid parent-loss SIGPIPE. |
| Approval / recovery / outage | Eight service cases use packaged helper, SQLite reopen and mock HTTP: current operator, expiry, supersession, cancellation, unpublished drafts, binding affinity, independent local UI, fixed base, lost result and room acknowledgement, local-ready/remote-pending and eventual same room/link. Missing completed resources are reported, not recreated. |
| Environment / framing / retention | Trusted real direnv allow-journal/PATH reaches Git/hooks only. Host interpreter/SDK/locks/native root cannot be redirected by project exports; daemon credentials are absent. Bounded malformed helper replies do not expose stderr or kill possible effects. Native JSON decoding retains split UTF-8. Failed approved creator wrappers conservatively retain their runtime root for possible orphan Git work; no PID inspection/cleanup service. |
| Additive ledger upgrade | Both schema-one and schema-two reopen preserve cursor, binding, queued input, frozen transaction/receipt, question, media chunks and setup identity while adding task state. |

Red/green findings included the missing atomic no-replace primitive, dangling
symbolic-ref mutation, rejection of completed retries after human commits, native
metadata read at the wrong level, and originating-history cancellation of a fresh
approval. The real-native test exposed both approval integration defects. A
trusted project fixture also exposed the missing `XDG_DATA_HOME` allow-journal
path; sanitation now preserves that noncredential configuration location.
`renameat2(RENAME_NOREPLACE)` fails closed without an unsafe rename fallback.
A separate non-refcounted setup lock and a pre-acquired FD transferred atomically
to the finite Git waiter close the same-process and pre-child-lock gaps. The
waiter starts with the host environment, receives bounded project Git data, and
does not cancel an approved Git effect merely because its caller disappeared.

Focused evidence: 18 task-worker cases, 8 approval/service, 5 actual-Pi cases,
6 store cases, 5 launch/protocol cases and 5 runtime-pin policy cases have passed
in their recorded runs (overlapping suites are not additive new coverage).
All five native filesystem cases passed in the affected gate. Broader affected
checks passed **220 unit + 127 chat**, source/module/package contracts and fresh
TypeScript compilation, with zero skips; six source/both-host evaluations passed.
The final cross-process conflicting-intent regression also passed before review.
Editor-only C `node_api.h` and stale TypeScript module-resolution diagnostics do
not reproduce in actual Nix compilation.

Key worker artifacts under `.pi/tmp/workers/`:
- `2026-11-10T15-08-41-319Z-native-167-task-ownership-red-e86f31cd17e4`
- `2026-11-10T15-26-47-729Z-native-167-task-ownership-green-2ed33c54acdc`
- `2026-11-10T15-53-22-093Z-native-167-actual-ui-and-origin-red-63ade05171fc`
- `2026-11-10T15-57-01-525Z-native-167-actual-approval-order-red-5dd3728da2e4`
- `2026-11-10T16-01-15-862Z-native-167-actual-approval-green-aab883767bf7`
- `2026-11-10T16-21-21-383Z-native-167-process-death-boundaries-85c5854c5ff6`
- `2026-11-10T16-28-34-316Z-native-167-project-environment-red-4c21bc1a7881`
- `2026-11-10T16-31-48-737Z-native-167-environment-crash-protocol-green-bf3c2eb58557`
- `2026-11-10T16-29-24-830Z-native-167-runtime-pin-policy-19e637667925`
- `2026-11-10T16-32-24-820Z-native-167-affected-gates-fc31986d4ae3`
- `2026-11-10T16-32-24-820Z-native-167-consuming-host-evaluation-4dbef4ffb6ef`

These are disposable-process/Git/SQLite/native SDK and authenticated-HTTP-boundary
fixtures, not live Matrix/NAS delivery, actual power-loss testing, or production
creation. Conservative failed-creator GC pins can require explicit maintenance;
they never reserve launch or require a bridge repair. Paired pinned review (`2026-11-10T16-36-50-040Z-worktree-c432773fb309-5e6d879af293`,
fixed point `6a483af`) reported no Standards findings and one low current-issue
Spec finding: the evidence's pre-final test count was 17 instead of 18. Corrected;
no current-scope finding remains.

Final `nix run -L .#verify` passed all twelve gates: **221 unit, 127 chat and
856 legacy tests**, zero skips. Its first attempt passed the native/other gates
but hit one unchanged legacy coordinator test's cleanup `ENOTEMPTY`; three
exact-artifact focused repetitions and the unchanged canonical rerun passed.
The initial cause remains unproven; no assertions, timeouts, concurrency or
legacy production code were weakened. This is separate from the retained #166
timing caveat. Final isolated Pi/bridge/chat/harness packages also passed.
Only this evidence text changed after the final code gate.
Artifacts: `2026-11-10T16-38-56-504Z-native-167-canonical-boundary-1c7a007f9fe2`,
`2026-11-10T16-43-10-922Z-native-167-legacy-cleanup-isolation-ac9b42158051`,
`2026-11-10T16-43-17-877Z-native-167-canonical-recheck-87f8a3935d59`, and
`2026-11-10T16-45-34-808Z-native-167-final-packages-5164a8069414`.
No production creation is authorized.

### #168 preflight: reversible archive, never process closure

Scope: one stored archive policy shared by explicit human Matrix commands and
native local UI confirmation. No model archive tool is retained in this slice
(the issue makes agent requests optional); agents can ask the operator to use
`!archive`/`!restore` or the native commands. Thus no model assertion or ordinary
question vote can grant this mutation, and no general approval catalogue returns.
#169 owns import; #170 deletion; #171 cumulative readiness; live operations remain
separately approved #172 work.

| Acceptance | Implementation/evidence seam | Actual focused evidence |
| --- | --- | --- |
| Immediate remote/picker policy without kill | Atomic archive bit/revision and input hold; native consumption reads committed policy, not notification cache | Actual-Pi busy/queued/delayed-notification cases; original final output and local follow-up retained; helper default/all discovery; passed in the 32-case command below |
| Restore only future input | Preserve queued/uncertain inputs, retire polls, freeze intake holds and fresh sync before dispatch; no replay/repair | Archive atomic-hold, original-poll, command-revision, backlog/restart and in-flight sync cases; schema 1/2/3 preservation; same 32-case pass |
| Independent local/human authority | Current operator commands, native UI confirmation and revision/session checks; no model mutation tool | Native cancel/accept/ABA/session-switch and current/departed collaborator cases; same pass |
| Reversible presentation | One host Archive Space; destination before source; retained original grouping/room IDs; last-live checkout visibility only | Archive hierarchy/last-live checkout, invitation/departure, lost-ACK and original bytes/identity assertions; 43-case presentation command passed |
| Offline/partial/racing operations | Durable desired policy before effects, same-checkout serialization, scoped status/retry | Prompt/vote/wake, stale-command, in-flight-sync, blocked hierarchy and unrelated-output cases; delayed-notification native race reproduced red then passed with committed-policy read |

Crash matrix: policy + held inputs + cancelled polls commit together before any
organization side effect. Lost human/UI replies reuse current state; stale revision
is rejected. Matrix updates observe the desired policy after restart, link the
destination before removing the source, and retain original node receipts/grouping.

| Crash boundary | Before / side effect | Durable record or identity | Interruption / retry | Evidence |
| --- | --- | --- | --- | --- |
| Archive/restore commit | Prior revision, raw/queued/handed inputs and active polls; no Matrix/process effect | One SQLite transaction updates revision/bit/holds, cancels polls and materializes `archive:REVISION` notice | Before commit: old policy. After commit: new policy, held input and notice together. Stale UI/command revisions reject, duplicates are no-ops | Atomic hold, stale-command/restart, schema upgrades, native ABA/session-switch cases |
| Native consumption | Remote input is queued or entering native preflight; policy RPC may be withheld | Fresh read-only query of the same committed binding, matching file/native ID/revision/enabled/archive/resume flags | Read before concurrent commit authorizes already in-flight work; read after commit rejects even without notification. Unknown/unsafe/read failure rejects remote input only; local queue and active run continue | Exact reviewed adapter red; delayed-policy transport-proxy green; readonly identity/missing/corrupt/symlink checks; both queue modes |
| Fresh-sync release | New revision has `resumePending`; Matrix catch-up may contain old prompts/commands/votes | Intake/cursor and permanent per-message holds/revisions commit before clearing only the matching revision's fence | Crash before release leaves fence pending for a later successful sync; an older in-flight snapshot cannot release a newer revision. No held item regains authority | Restart-before-sync, in-flight snapshot, offline backlog including old command/vote, normal repeated-cursor cases; limited-gap regression retained |
| Destination link | Original room and live grouping receipts exist; Archive/live destination two-way state writes may partially succeed | Original node/alias receipts; desired archive revision and saved grouping in `setup:KEY`; exact link contents observed by GET | Destination precedes source unlink; unknown PUT outcome is re-read, not inferred failed. Restart retries desired policy with same IDs | Link ordering and lost-ACK restart; concurrent policy change during held write |
| Source unlink / completion | Destination linked; old checkout/archive edges may remain; final live sibling can change | Current archive bits plus saved original checkout/project; same-checkout serialized jobs; status records completed revision | Unlink only presentation with empty state content; no deletion/membership effect. Changed revision stays visibly pending and reconciles; unrelated output continues | Last-live checkout/restore, rapid transitions, blocked hierarchy/unrelated output; first-invitation/departure cases |

No room/session/worktree deletion, leave/forget, membership repair, process scan,
shutdown or prerequisite queue cleanup. An already handed-off action may have
acted; archive cannot undo it. Future dispatch is fenced independently of Matrix
or NAS health. Each policy transition requires a fresh successful sync before
remote commands can resume (and before ordinary input resumes after restore).
Per-message intake revisions reject old commands after restart; catch-up messages
have no mutation authority even once that fence clears. Held inputs remain
visible, never replayed. Matrix has no conditional state-write CAS, so tests do
not claim serialization against another human client.

Implemented schema-four archive/revision/held-input transactions, exact
current-operator commands, native UI confirmation, and same-checkout serialized
background presentation. Destination links precede source unlinks; original
room/grouping receipts remain. Empty live checkout edges are removed without
removing rooms or membership. The new Archive kind shares existing immutable
room provenance and first-invitation/departure policy. No downstream change is
needed: the native helper/picker already consumes the stored archive flag.

The stronger actual-Pi fixture found a real gap: already handed-off native
steering/follow-up queues ran after archive, despite the ledger hold and adapter
preflight. `pi-bridge-queued-preflight.patch` adds an optional per-message guard
at native queue consumption. Withdrawal updates native queue presentation and
its existing removal callback, never aborts the current run, and does not remove
local queued messages. Both native queue modes retain later valid/unguarded
messages when earlier ones are withdrawn or throw. Unguarded behavior remains
unchanged. This patch is required by tested SDK behavior, not an invented hook.

Focused evidence: 12 archive cases exercise atomic holds, current operator and
stale-command authority, prompt/vote/wake membership races, in-flight sync,
offline backlog/restart, last-live checkout, lost hierarchy ACK, and desired-policy
changes during a blocked write with unrelated output still flowing. Seven store
cases include schema 1/2/3 preservation. Seven actual-Pi cases include native UI
cancel/accept, stale ABA and session-switch responses, an active run finishing
with final output, withdrawn real remote queues, retained local follow-up,
offline default/all discovery, and only fresh remote intent after restore. Six
native SDK cases additionally check the public queue API in both modes. The
shared trusted-invitation suite now includes Archive first-join/departure.

Evidence under `.pi/tmp/workers/`:
- `2026-11-10T17-05-33-699Z-native-168-archive-first-fc2aabf7f102`: initial 35 focused checks passed.
- `2026-11-10T17-07-39-115Z-native-168-actual-ui-busy-archive-a6cb2c519e06`: 15 native/task/intake checks passed.
- `2026-11-10T17-10-48-318Z-native-168-races-and-native-switch-c855b11107d2`: 23 checks passed.
- `2026-11-10T17-31-57-091Z-native-168-queued-handoff-regression-13f9a2d150ed`: real queued steering/follow-up regression failed as expected; 23 other cases passed.
- `2026-11-10T17-37-21-067Z-native-168-guarded-queue-package-c132f3190e50`: guarded pinned Pi package built.
- `2026-11-10T17-38-34-803Z-native-168-queued-guard-green-3ed2d1cce8b4`: all 30 native/archive/store/SDK cases passed.

- `2026-11-10T17-41-45-506Z-native-168-presentation-invites-final-focused-caa4bc907ca3`: all 43 archive/invitation/organization/interaction cases passed, including unrelated output during blocked presentation.
- `2026-11-10T17-41-45-506Z-native-168-broader-affected-d78d4cc84a54`: TypeScript, package/source/module contracts, 235 unit and 128 chat cases passed, zero skips.

Review `2026-11-10T17-44-38-027Z-worktree-cfa590dbe0e1-8a3ad7601974`
found one low Standards evidence-record finding and one high Spec queue-authority
race, both current issue. This table/commands repair the documentation finding.
The Spec finding was reproduced against the reviewed adapter while a public IPC
proxy withheld `archive-policy` and kept activity policy stale, then released the
real native queue after commit. `dispatch-fence.ts` now reads just the native
binding's policy using a fresh read-only, zero-wait SQLite connection at native
preflight/queue consumption. Unsafe/missing/corrupt/unknown policy fails closed
for remote input only. The pinned Bun lacks `node:sqlite`: actual-runtime testing
caught the import failure; Bun now uses built-in `bun:sqlite`, Node uses built-in
`node:sqlite`, lazily without adding a dependency. This is a new narrow reader
of the existing ledger, not a second store, scheduler, writer or local launch gate.
Because remediation adds this cross-runtime authority seam, a targeted paired
re-review was warranted rather than claiming the earlier snapshot reviewed it.
Re-review `2026-11-10T18-02-18-387Z-worktree-95d22e3a925d-b6aef0fecc39`
found a medium Spec queue-presentation defect for identical remote/local text,
and a medium Standards reminder that canonical verification must still follow
remediation before closure. The display defect reproduced red: withdrawing the
remote duplicate reordered remaining local queue text. Native queue presentation
now tracks the actual message identity, including consumption, not `indexOf(text)`.
The same real-Pi fixture passes with a local duplicate and intervening local
message in all mode; metadata proves the remote identity was never consumed.
This refines existing queue bookkeeping, not the reviewed authority design.
No accepted current-issue finding remains; the final canonical gate below also
satisfies the review's closure prerequisite.

Review remediation evidence:
- `2026-11-10T17-54-25-547Z-native-168-review-delayed-policy-red-8198c1f72de2`: expected real native replay with the reviewed adapter, no fixture failure.
- `2026-11-10T17-54-46-486Z-native-168-review-fence-green-17954d5fedef`: caught unsupported `node:sqlite` in the packaged Bun; 25 other cases passed, seven native cases could not load.
- `2026-11-10T17-56-00-848Z-native-168-review-fence-runtime-green-013e8583d8ee`: all 32 actual-native/archive/store/SDK cases passed, zero skips.
- `2026-11-10T17-59-44-854Z-native-168-review-remediation-affected-dfdc5e00e6ae`: the same broader command below passed after remediation: 237 unit, 128 chat, zero skips and fresh package/source/module/type contracts.
- `2026-11-10T18-06-47-850Z-native-168-review-queue-identity-red-ce413c96b725`: expected identical-text native queue presentation failure.
- `2026-11-10T18-08-17-272Z-native-168-review-identity-green-138e89437ad0`: identity-corrected pinned Pi build and all 32 focused cases passed.
- `2026-11-10T17-59-44-855Z-native-168-consuming-evaluation-4432d052a909`: `python3 /home/beau/documents/nix-dotfiles/modules/cli/pi-harness/check-native-integration.py --harness-source "$PWD" --evaluate` passed all six source/grill/NAS evaluation checks, no activation.

Exact commands and outcomes (scratch driver compiles `tsc --project
tsconfig.test.json --outDir .pi/tmp/bridge-build`, copies current native CJS,
sets isolated HOME/XDG/locks and mandatory packaged helpers, then `node --test`):

```sh
# Passed: 32 cases, including delayed policy, real queues, and both SQLite runtimes.
export PI_BRIDGE_TEST_PI="$PWD/.pi/tmp/archive-168/pi/bin/pi"
export PI_BRIDGE_TEST_SDK="$PWD/.pi/tmp/archive-168/pi/lib/node_modules/@earendil-works/pi-coding-agent/dist"
bash .pi/tmp/task-167/check.sh \
  .pi/tmp/bridge-build/tests/bridge-adapter-real-pi.test.js \
  .pi/tmp/bridge-build/tests/bridge-archive.test.js \
  .pi/tmp/bridge-build/tests/bridge-store.test.js tests/bridge-native-pi.test.mjs

# Passed: 43 cases before the two additional review regressions.
bash .pi/tmp/task-167/check.sh \
  .pi/tmp/bridge-build/tests/bridge-archive.test.js \
  .pi/tmp/bridge-build/tests/bridge-chat-trusted-invites.test.js \
  .pi/tmp/bridge-build/tests/bridge-organization.test.js \
  .pi/tmp/bridge-build/tests/bridge-interaction.test.js

# Passed before review remediation: 235 unit, 128 chat, zero skips, all contracts.
nix build .#checks.x86_64-linux.unit-tests .#checks.x86_64-linux.bridge-chat \
  .#checks.x86_64-linux.source-contracts .#checks.x86_64-linux.module-contracts \
  .#checks.x86_64-linux.package-contracts --no-link --keep-going -L
```

Final verification:
- `nix run -L .#verify` passed all 12 gates: **237 unit / 128 chat / 856 legacy**, zero skips (`2026-11-10T18-10-00-597Z-native-168-canonical-final-0521b7e1cfaf`). No assertions, timeouts or concurrency were weakened. Earlier #166/#167 legacy timing/cleanup caveats remain historical, not reproduced here.
- `nix build .#pi .#matrix-bridge .#bridge-chat .#pi-harness --no-link -L` passed (`2026-11-10T18-13-16-461Z-native-168-final-packages-e9d97f6ac804`).
- The consuming evaluation command above passed all six checks again with the final Pi correction (`2026-11-10T18-13-16-461Z-native-168-final-consuming-evaluation-1379b3a37312`).
- Only this final evidence text changed after the gate; no production/test change required a rerun. No downstream files changed for #168.

Evidence uses real disposable Pi/RPC, SQLite and local discovery with
fake model/Matrix HTTP, not a visual picker exercise, live Matrix/NAS receipt,
operator-account repair, deployment or safe coexistence with legacy writers.

### #169 offline migration

The [operator runbook](matrix-pi-migration.md) records the acceptance mapping,
source descriptor, exact CLI sequence, scope ownership and boundary-by-boundary
crash matrix. Four one-shot modules decode frozen raw evidence, export a private
byte inventory and import a distinct schema-four ledger. There is no old loader,
startup migration, credential/Git/network use or terminal/account executor.
Original native bytes/paths/IDs, room IDs, grouping, generations, archive/private
choices, frozen sends, held input/media and inactive polls survive. Unknown,
unfrozen or inaccessible evidence is reported rather than guessed or replaced.

The imported ledger has negative native identity/path enrollment policy and
original-room receipts. A matching historical native marker cannot enroll into
an empty/wrong ledger. An imported unstamped room requires current immutable
sole-creator/policy verification before remote effects; its grouping can fail
independently. Bot/operator identities are fixed to the migration. Old departed
and disabled rooms are not sync consumers. No old invitation, cleanup, artifact,
control or task approval is revived. The first runtime ledger writer permanently
fences the automatic pre-start rollback shortcut, without claiming execution or
an external receipt.

Format checks were compared with the legacy contracts, raw registry/generation,
archive/retirement, inbox/outbox, media, live/archive hierarchy, native marker,
text-projection, transcript/event projector and Matrix sender implementations.
The converter never calls their live loaders (which create directories and filter
retired rows). Frozen wire tests cover the legacy text-versus-notice distinction,
default/first-chunk notification semantics, HTML bytes, the actual transaction
character set and unknown/unfrozen records. Synthetic fixtures are not a
validation receipt for the deployed stores; full source inventory/accessibility
and independently approved coherent capture remain #172 work.

Development evidence (logs under `.pi/tmp/workers/`):
- `2026-11-10T19-03-18-102Z-migration-169-first-fixtures-e0169b8e5e06` passed the
  first 13 migration cases plus existing store/organization checks; later source
  descriptor/cursor/ownership hardening supersedes that early result.
- `2026-11-10T19-06-45-716Z-migration-169-imported-private-start-red-c55feae6602f`
  reproduced actual packaged Pi missing its private enrollment marker when a
  persisted headless session had no new boundary. Expected false, got undefined.
  The adapter now records private choice before work regardless of a new marker.
  The unchanged assertion passed in both the subsequent actual-Pi suite and the
  final affected unit gate below.
- `2026-11-10T19-23-28-444Z-migration-169-focused-native-and-crashes-f31f8dbba211`
  passed 59/60 cases, including all real Pi and SIGKILL cases. Repeated post-runtime
  check exposed ordinary SQLite readOnly creating WAL sidecars. The fix rejects
  existing journal evidence, uses an immutable URI and rechecks concurrent change;
  it does not checkpoint, modify or restore the destination.
- `2026-11-10T20-07-43-742Z-migration-169-focused-green-11b1d2690304` passed all
  **65** then-current focused migration/process/actual-Pi/store/organization/
  archive/relay/sync cases, zero skips, and the isolated bridge package build.
- The first Nix affected run refused the fixture because sandbox input binds had
  writable kernel flags despite Nix ownership. A test-only private read-only bind
  fixed that without changing production checks. Its first wrapper omitted
  device-preserving mounts: `/dev/null` permission failures caused Git errors and
  Bun crashes. Preserving `/dev` corrected the harness; no assertion, timeout or
  concurrency change was made. Failure logs are `20-07-43...broader-affected-
  56b255e243e4` and `20-13-32...broader-readonly-mount-0388e08c4b59`.
- `2026-11-10T20-22-32-750Z-migration-169-affected-device-preserving-namespa-
  bb2a1eaf44a6` passed the latest **35 focused** cases (27 migration/process,
  seven store, one sync), then **264 unit / 128 chat**, zero skips, and all source,
  module and package contracts. This includes the positive pre-start rollback
  case, new/changed native-root detection, foreign account refusal/resource
  release, and actual packaged Pi/native helpers. The pristine fixture creates
  its declared `/tmp` directory exclusively and never adopts/removes an existing
  path. All other roots/homes/sockets/processes are disposable as before.

Executed command sequences:

```sh
# Synthetic fixtures only: fresh compile/seal, then an immutable local test input.
tsc --project tsconfig.test.json --outDir .pi/tmp/bridge-build
node .pi/tmp/migration-169/seal.cjs tests/fixtures/matrix-migration/pristine
node .pi/tmp/migration-169/seal.cjs
nix store add-path "$PWD/tests/fixtures/matrix-migration" --name migration-169-fixture \
  > .pi/tmp/migration-169/fixture-path.txt
nix build .#matrix-bridge --out-link .pi/tmp/migration-169/package -L

export PI_BRIDGE_MIGRATION_FIXTURE="$(< .pi/tmp/migration-169/fixture-path.txt)"
export PI_BRIDGE_MIGRATION_MAIN="$PWD/.pi/tmp/migration-169/package/lib/matrix-bridge/migration-main.js"
export PI_BRIDGE_MIGRATION_BWRAP="$(command -v bwrap)"
export PI_BRIDGE_TEST_PI="$PWD/.pi/tmp/archive-168/pi/bin/pi"
export PI_BRIDGE_TEST_SDK="$PWD/.pi/tmp/archive-168/pi/lib/node_modules/@earendil-works/pi-coding-agent/dist"
# The existing focused driver recompiles, isolates HOME/XDG/locks, and runs node --test.
bash .pi/tmp/task-167/check.sh \
  .pi/tmp/bridge-build/tests/bridge-migration.test.js \
  .pi/tmp/bridge-build/tests/bridge-migration-process.test.js \
  .pi/tmp/bridge-build/tests/bridge-store.test.js \
  .pi/tmp/bridge-build/tests/bridge-matrix.test.js
# The earlier 65-case command additionally selected adapter-real-pi, organization,
# archive and relay suites; it is retained verbatim in the worker command log.
nix build .#checks.x86_64-linux.unit-tests .#checks.x86_64-linux.bridge-chat \
  .#checks.x86_64-linux.source-contracts .#checks.x86_64-linux.module-contracts \
  .#checks.x86_64-linux.package-contracts --no-link --keep-going -L
```

Pinned paired review `.pi/tmp/reviews/2026-11-10T20-26-31-090Z-worktree-60d217fda86f-e872049d0b8a/`
against `12fe80a7d009232df780f8e27cf6ba685ff612f9`:
- **Standards:** no findings.
- **Spec:** two high/current-issue findings: unknown/malformed room cursor states
  could lose a cutoff, and transaction uniqueness excluded historical sent chunks.
  Both were reproduced as missing-exception failures (0 pass / 2 fail / 0 skip)
  by `2026-11-10T20-29-17-630Z-migration-169-review-regressions-red-d403822225f3`,
  using the focused driver with `--test-name-pattern='malformed or future legacy
  room cursor|sent or cancelled projection'` and `bridge-migration.test.js`.
- Remediation validates the exact legacy cursor union/2,048-character bound before
  conversion, rejects established room cutoffs without a global inbox cutoff,
  and reserves every projection transaction, including sent/cancelled/unresolved
  chunks in disabled or unavailable records. No new authority or runtime recovery
  mechanism was added. Additional actual packaged-CLI tests use independently
  sealed malformed copies under private read-only mounts and prove that neither
  destination nor partial state is created.
- `2026-11-10T20-38-17-177Z-migration-169-review-remediation-green-45310322669a`
  passed the package build and the command sequence above: **38 focused cases**
  (30 migration/process + seven store + one sync), then **267 unit / 128 chat**
  and all affected source/module/package contracts, zero skips. Both findings
  are resolved. No assertion, timeout or concurrency was weakened; remediation
  does not materially change the reviewed design, so no routine re-review.

Final verification:
- `nix run -L .#verify` passed all **12 gates / 267 unit / 128 chat / 856 legacy**,
  zero skips (`2026-11-10T20-44-05-298Z-migration-169-canonical-final-14458e3ec70a`).
  No old timing/cleanup intermittency reproduced in this final run.
- `nix build .#pi .#matrix-bridge .#bridge-chat .#pi-harness --no-link -L` passed
  (`2026-11-10T20-47-13-282Z-migration-169-final-packages-2c03d8e4807c`). Nix used
  local builds when the configured NAS builder was unavailable.
- `python3 /home/beau/documents/nix-dotfiles/modules/cli/pi-harness/check-native-integration.py
  --harness-source /home/beau/documents/projects/pi-harness-managed-live-workspaces
  --evaluate` passed all six checks: grill/NAS Pi 0.84.4, native-only configuration,
  independent lifetimes and assertions (`2026-11-10T20-44-05-298Z-migration-169-consuming-evaluation-769bfb4c991c`).
  This is evaluation, not a system build, switch, service restart or live proof.
- The actual final `bin/pi-bridge-migrate` wrapper also passed all four verbs
  under `env -i HOME="$root" TMPDIR="$root"`, using the synthetic read-only fixture
  and an exclusively created `mktemp -d -t pi-migration-executable-XXXXXX` root:
  `inventory "$fixture"`, `export "$fixture" "$root/backup"`,
  `import "$fixture" "$root/state"`, `check "$fixture" "$root/state"`.
  Package selection was `nix build .#matrix-bridge --no-link --print-out-paths`;
  only that owned temporary root was removed afterward
  (`2026-11-10T20-48-49-045Z-migration-169-final-executable-ca82e36a859f`).
  The synthetic main fixture correctly reports original native files unavailable;
  that does not become a rollback/readiness claim. The separate pristine fixture
  tests genuine pre-start eligibility and its withdrawal after added/changed work.
- Only final evidence text changed after these gates; no production/test change
  required a repeated canonical run. LSP/scoped diagnostics and diff checks passed.

No downstream changes, push, activation, production capture/migration,
Matrix/account effects or live canary have occurred. #170 removal, #171 cumulative
review/reduction/publication-pin handoff and separately approved #172 cutover
remain open. Grill/NAS are **not rebuild-ready**.

### #170 legacy platform removal

The native bridge is now the only shipped conversation runtime. See
[removal evidence](matrix-pi-removal.md) for full acceptance/effect matrices,
retained-test disposition, before/after scopes, operation/store/worker/dependency
counts, exact commands, review and Git preservation evidence.

The old 124-file runtime, coordinator/profile/45-action catalogue, repair,
retirement/generation/auto-refresh/admission wrappers, account scheduler and
arbitrary native exporter are removed, not moved into nix-dotfiles. Shared
renderer/checkpoint/HTTP, independent Aloop, stateless attachment validation,
native images/polls/tasks/archive/invitations and runtime retention remain.
Old-state startup fails before credentials/HTTP and leaves old bytes untouched;
unsupported old account configuration is rejected without changing stateless
request identity. Only the offline one-shot converter remains for transition.

Fixed #170 scopes across both repositories: **230 files / 34,804 lines → 83 /
9,571**; an additional 74-line shared Aloop helper outside those scopes is disclosed.
This is the pre-removal dual-source baseline, not a retroactive epic reduction
claim. The 27 native files include migration/lock shims; cumulative budget and
mixed integration accounting remain #171's explicit responsibility.

Pinned paired review at `67ceb087805e3e24b6cf13adffc86e5e7f23c928`: Standards no
findings; Spec one low/current-issue historical-doc framing finding, fixed.
Final `nix run -L .#verify`: **all 11 gates, 287 unit / 85 chat, zero skips**.
Four actual packages, actual empty-environment old-store refusal, **18 downstream
Go race tests**, isolated picker build and six final consuming evaluations pass.
No system build, live Matrix/NAS/visual acceptance or incident closure is inferred.

Downstream commit `0315a85f75ebc6a05de3a981098a1f6d053c8646` contains only the 26
owned paths; unrelated staged/unstaged/index state was preserved and verified.
Harness changes are in the enclosing #170 commit. No push, pin advance,
activation, restart or production migration occurred. Historical evidence remains
[in the diagnostic index](legacy-managed-history.md), not current commands.

### #171 cumulative verification

[Release verification and handoff](matrix-pi-release.md) records all nine scenario
families, the full-epic baseline comparison, **7,990 conservative production lines**
including mixed integration/shared moves/full patch context, immutable downstream
capture, and mandatory full-epic Standards/Spec review: **no findings**. Final
candidate `d4159edecddd645a11d9fb5bb1b103a51f3c1fe7` passed all 11 canonical gates
(**287 unit / 85 chat**, zero skips), actual packages/executables, **18 Go race
tests**, isolated picker and six consuming evaluations. The publication/pin and
separately approved live canary/rollback sequence is documented, not executed.

## Rebuild and migration readiness

#171 deterministic verification/review and handoff are complete. Publication/pin
advance and separately approved #172 cutover remain outstanding. Do not run a host
switch merely because this document exists. Host builds/activation and real account/room effects
remain operator actions. Existing old managed sessions are not compatible writers
for a replacement kernel-lock protocol until the approved cutover has quiesced them.
